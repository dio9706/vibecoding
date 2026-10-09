/**
 * 上下文压缩纯函数层（T7，spec `docs/superpowers/specs/2026-10-08-context-compaction-design.md`）。
 *
 * 解决的问题：`conv-messages` 原先在追加时硬截 200 条，切点不看角色——tool 序列被拦腰切开时
 * 保留段头部会留「没有对应 tool-call 的 tool 结果」，可能直接 400；且旧消息被物理丢弃。
 * 本层提供边界安全的切点选择 + 摘要输入/输出的格式化；运行时编排（LLM 调用、落盘）在 run-openai.js。
 *
 * 口径（拍板）：模型可见长度 > COMPACT_TRIGGER 触发；保留最近 ≥ COMPACT_KEEP_RECENT（沿 user
 * 边界取整轮）；新丢 ≥ COMPACT_MIN_DROP 才动手。零 IO。
 */

/** 触发阈值：模型可见消息条数超过它才考虑压缩（与旧 200 上限同量级） */
export const COMPACT_TRIGGER = 200;
/** 压缩后至少保留的近期消息条数（实际取 ≥ 它的最近 user 边界） */
export const COMPACT_KEEP_RECENT = 100;
/** 新增可丢条数下限：太少就攒着，避免每轮都调一次摘要 */
export const COMPACT_MIN_DROP = 20;
/** 摘要文本上限（防止摘要自身撑爆 system） */
export const MAX_SUMMARY_CHARS = 2000;
/** 送进摘要调用的转录总预算（头尾截断） */
export const SUMMARY_INPUT_BUDGET_CHARS = 60_000;
/** 转录里单条消息的展示上限 */
const PER_MESSAGE_CHARS = 1500;

function clipMiddle(s, max) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return str.slice(0, head) + `\n…（略 ${str.length - max} 字符）…\n` + str.slice(-tail);
}

/**
 * 剔除头部孤儿 tool 结果（v1 遗留脏数据自愈）。
 * 「结果缺调用」的头部序列发给兼容端点可能 400；assistant 带 tool-call 在前是合法的（结果在后）。
 */
export function dropLeadingOrphans(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let i = 0;
  while (i < list.length && list[i]?.role === 'tool') i++;
  return i === 0 ? list : list.slice(i);
}

/**
 * 是否要压缩：模型可见长度（总条数 − 摘要已覆盖条数）超过阈值。
 * @param {{total:number, covered?:number}} p
 */
export function shouldCompact({ total, covered = 0 } = {}) {
  const t = Number(total) || 0;
  const c = Math.max(0, Number(covered) || 0);
  return t - c > COMPACT_TRIGGER;
}

/**
 * 选压缩切点：保留段从该索引开始（旧段被摘要替代）。
 * 约束：`cut ≤ len - keepRecent`；且 `messages[cut].role === 'user'`（整轮边界，天然不切 tool 序列）；
 * 且新丢条数（cut − covered）≥ minDrop。
 * @returns {number} 切点索引；无法安全压缩时返回 -1
 */
export function pickCompactCut(messages, { keepRecent = COMPACT_KEEP_RECENT, minDrop = COMPACT_MIN_DROP, covered = 0 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const maxCut = list.length - Math.max(1, Number(keepRecent) || 0);
  if (maxCut <= 0) return -1;
  let i = maxCut;
  while (i > 0 && list[i]?.role !== 'user') i--;
  if (i <= 0) return -1; // 找不到整轮边界（或会切到第 0 条）→ 本轮不压
  const c = Math.max(0, Number(covered) || 0);
  if (i < c + Math.max(1, Number(minDrop) || 0)) return -1; // 新增可丢太少 → 攒着
  return i;
}

/** 单条消息 → 摘要输入用的可读文本（text/tool-call/tool-result/reasoning 全形态） */
function messageToText(m) {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  const out = [];
  for (const p of c) {
    if (!p) continue;
    if (p.type === 'text' && p.text) out.push(String(p.text));
    else if (p.type === 'reasoning' && p.text) out.push(`[推理] ${p.text}`);
    else if (p.type === 'tool-call') out.push(`[调用 ${p.toolName || '?'}] ${safeJson(p.input)}`);
    else if (p.type === 'tool-result') out.push(`[结果] ${toolOutputText(p.output)}`);
  }
  return out.join(' ').trim();
}

function safeJson(v) {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return '(无法序列化)';
  }
}

/** tool result 的 output 形状不定（{type:'text',value} / {type:'error-text',value} / 字符串 / 对象） */
function toolOutputText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && 'value' in output) return typeof output.value === 'string' ? output.value : safeJson(output.value);
  return safeJson(output);
}

const ROLE_LABEL = { user: '用户', assistant: '助手', tool: '工具结果', system: '系统' };

/**
 * 被丢段 → 紧凑转录（送进摘要调用的输入）。
 * 单条先截断再拼，整体再做头尾截断——摘要调用花的也是会话自己的额度。
 */
export function formatMessagesForSummary(messages, { budgetChars = SUMMARY_INPUT_BUDGET_CHARS, perMessageChars = PER_MESSAGE_CHARS } = {}) {
  const parts = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const text = messageToText(m);
    if (!text) continue;
    parts.push(`【${ROLE_LABEL[m?.role] || m?.role || '?'}】${clipMiddle(text, perMessageChars)}`);
  }
  return clipMiddle(parts.join('\n'), budgetChars);
}

/** 摘要系统提示：固定保留项（目标/约束/决策/文件/未完成/关键 id），不编造 */
export const SUMMARY_SYSTEM_PROMPT =
  '你是会话压缩器。把给定的对话历史压缩成一份供同一位助手继续工作用的要点备忘。' +
  '必须保留：用户的目标与约束、已达成的决定、改动过的文件路径、未完成事项、关键事实（命令/路径/ID/报错原文要点）。' +
  '丢弃：寒暄、重复、已被后续修正的中间方案。绝不编造未出现的信息。只输出要点文本，不要寒暄。';

/**
 * 滚动摘要 prompt：旧摘要 + 新增被丢段 → 输出更新后的单一摘要。
 * @param {{previousSummary?:string, droppedText?:string}} p
 */
export function buildSummaryPrompt({ previousSummary = '', droppedText = '' } = {}) {
  const prev = String(previousSummary || '').trim();
  const dropped = String(droppedText || '').trim();
  return [
    prev ? `【已有摘要（覆盖更早的对话）】\n${clipMiddle(prev, MAX_SUMMARY_CHARS)}` : '',
    dropped ? `【新增需要并入摘要的对话】\n${dropped}` : '',
    '请输出更新后的单一摘要（纯文本要点，控制在 800 字以内）。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** 摘要文本归一：trim + 截断 */
export function normalizeSummaryText(text, max = MAX_SUMMARY_CHARS) {
  return clipMiddle(String(text ?? '').trim(), max);
}

/** 视图 system：主提示词 + 摘要段（不造假的 user/assistant 轮） */
export function composeSystemWithSummary(systemPrompt, summaryText) {
  const s = normalizeSummaryText(summaryText);
  if (!s) return systemPrompt;
  return `${systemPrompt}\n\n## 历史摘要（较早对话的自动摘要；原文已保留在系统中，需要细节时可要求核对原文）\n${s}`;
}

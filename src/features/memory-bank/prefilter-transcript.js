/**
 * 会话转录（~/.claude/projects/**\/*.jsonl）预筛器 —— **非默认路径**。
 *
 * 为什么独立成文件而不是留在 prefilter.js 里：默认提炼链路已改用 store/user-log.js
 * （后端埋点采集的用户真实输入，源头纯净）。这里的一整套函数是为「JSONL 事件流」写的，
 * 输入契约与新链路完全不同 —— 混在同一个文件里，读的人得先分辨哪一半是活的。
 * 文件名直接点出数据源，与 store/transcript.js 一一对应。
 *
 * 为什么不删：还有两个场景只有 JSONL 有记录 ——
 * 1. 历史回填：埋点上线前的存量会话（本机 236 个）只能从转录里挖；
 * 2. 终端场景：用户在终端直接敲 `claude` 时不经过本项目后端，埋点拿不到。
 *
 * 头号陷阱：工具结果在转录里顶层也是 type==='user'，
 * 不先排除就会把工具输出当成用户发言去提炼偏好。
 *
 * 已知局限（正是切数据源的原因，回填时要一并考虑）：正则「猜哪句话有信号」的模型被真实数据证伪 ——
 * 用户的高价值偏好大量以决断式表达出现（「B. 人工确认 + C」），一条纠正措辞都不带，正则一句都捞不到。
 */
import { EXPLICIT_RE } from './prefilter.js';

/** 纠正措辞：紧邻上下文就是被纠正的行为 */
const CORRECTION_RE = /不对|不是这样|别这样|不要这样|应该|改成|重来|错了|回退|我说过|说了多少次|又忘了/;

/** kind 优先级（越小越先保留），超预算截断时用 */
const KIND_PRIORITY = { explicit: 0, correction: 1, denial: 2, rework: 3 };

/** 取事件文本：content 可能是字符串，也可能是块数组（只收 text 块） */
export function messageText(ev) {
  const c = ev?.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b?.type === 'text')
    .map((b) => b.text || '')
    .join('\n');
}

/** 是否工具结果（顶层 type==='user'，但 content 块是 tool_result） */
export function isToolResult(ev) {
  const c = ev?.message?.content;
  return Array.isArray(c) && c.some((b) => b?.type === 'tool_result');
}

/** 是否「真」用户发言 */
export function isRealUserMessage(ev) {
  if (ev?.type !== 'user') return false;
  if (isToolResult(ev)) return false;
  return messageText(ev).trim().length > 0;
}

/** 文本 → 信号类型；无信号返回 null。explicit 先判，优先级高于 correction */
export function classifySignal(text) {
  const s = String(text || '');
  if (EXPLICIT_RE.test(s)) return 'explicit';
  if (CORRECTION_RE.test(s)) return 'correction';
  return null;
}

/**
 * @param {Array} events 一次会话的事件数组（已 JSON.parse）
 * @param {{maxSegments?:number, contextRadius?:number}} [opts]
 * @returns {{segments:Array<{kind,quote,at,sessionId,context:string[]}>, dropped:number}}
 */
export function extractSignals(events, { maxSegments = 30, contextRadius = 2 } = {}) {
  const list = Array.isArray(events) ? events : [];
  const norm = list.map((ev) => ({
    role: ev?.type === 'assistant' ? 'assistant' : 'user',
    text: messageText(ev),
    isUser: isRealUserMessage(ev),
    at: ev?.timestamp || '',
    sessionId: ev?.sessionId || '',
  }));

  const hits = [];
  for (let i = 0; i < norm.length; i++) {
    if (!norm[i].isUser) continue;
    const kind = classifySignal(norm[i].text);
    if (!kind) continue;
    // 从命中位置 i 向两侧游走，各收集最多 contextRadius 条「非空文本」的消息 ——
    // 不能按原始事件索引直接开窗：真实转录里 tool_use/tool_result 的 messageText 是 ''，
    // 密度又极高，按索引开窗会被它们把名额占满，导致被纠正的那句助手原话被挤到窗口外。
    const before = [];
    for (let j = i - 1; j >= 0 && before.length < contextRadius; j--) {
      const t = norm[j].text.trim();
      // 单条上下文截断到 300 字，防长工具输出/长回答撑爆 prompt
      if (t) before.push(`${norm[j].role}: ${t.slice(0, 300)}`);
    }
    before.reverse();
    const after = [];
    for (let j = i + 1; j < norm.length && after.length < contextRadius; j++) {
      const t = norm[j].text.trim();
      if (t) after.push(`${norm[j].role}: ${t.slice(0, 300)}`);
    }
    const context = [...before, ...after];
    hits.push({
      kind,
      quote: norm[i].text.trim(),
      at: norm[i].at,
      sessionId: norm[i].sessionId,
      context,
    });
  }

  hits.sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
  const dropped = Math.max(0, hits.length - maxSegments);
  return { segments: hits.slice(0, maxSegments), dropped };
}

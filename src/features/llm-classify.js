/**
 * LLM 单轮分类调用骨架 —— 三个分类点（intent action/feedback、task-triage action）共用。
 * 封装事故驱动的防卡死细节：额度耗尽 fail-fast、abort+race 双保险、预挂 catch 防 unhandled、
 * 单轮禁全部工具（曾发生分类模型把消息当真任务起子代理）、首个 JSON 块提取。
 * 返回解析出的 JSON 对象；失败/超时/解析不出 → null（语义校验留给调用方）。
 */
import { runClaude } from '../integrations/claude.js';
import { claudeAuthOpts, getTokens, isPoolExhausted } from './token-rotation.js';
import { logger } from '../shared/logger.js';

// 分类调用超时：超过即 abort，落兜底。曾发生额度耗尽（五小时限流）时 SDK 流永不结束 → dispatch 卡死。
export const CLASSIFY_TIMEOUT_MS = 30_000;

/**
 * 从模型回复里截出第一个完整的 JSON 对象（含嵌套），截不出返回 null。
 *
 * 为什么不能用正则：旧实现是 `out.match(/\{[\s\S]*?\}/)`，非贪婪匹配从第一个 `{` 停在
 * **第一个** `}`。JSON 天生可嵌套，而正则没有配对计数能力 —— 贪婪 `/\{[\s\S]*\}/` 又会
 * 一路吃到最后一个 `}`（把后面的说明文字或第二个对象也裹进来），两头都不对。
 *
 * 实测线索（2026-08-19 埋点统计端到端冒烟）：理解阶段的模型回复形如
 * `{"range": {"start": "...", "end": "..."}, "target": "page", "keywords": [...]}`，
 * 旧正则只截到 `{"range": {"start": "...", "end": "..."}`，JSON.parse 必抛 →
 * runClassifierOnce 返回 null，日志里表现为「LLM 调用成功但阶段 A 无输出」。
 * 同样形状的还有精选阶段的 `{"events":[{...}],"pages":[]}` 与 memory-bank 的 `{"items":[{...}]}`。
 *
 * 实现：找到第一个 `{`，逐字符扫描并对大括号计数，深度归零处即该对象结尾。
 * 字符串字面量内的 `{`/`}` 必须跳过（`{"tip":"用 {} 包起来"}`），
 * 且要认转义（`{"a":"he said \"hi\""}` 里的 `\"` 不能被当成字符串结束）。
 *
 * @param {unknown} text 模型原始输出
 * @returns {string|null} 第一个完整 JSON 对象的原文；找不到 `{` 或扫到结尾仍未配平 → null
 */
export function extractFirstJsonObject(text) {
  const s = typeof text === 'string' ? text : '';
  const start = s.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      // 转义只影响紧随其后的一个字符，处理完立刻复位（否则 `\\"` 这种「转义反斜杠 + 真引号」会判错）
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  // 扫到结尾还没配平 = 回复被截断，宁可返回 null 也不交一段残缺 JSON 给下游
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.prompt        用户侧 prompt
 * @param {object} [opts.systemPrompt] 可选 system prompt（runClaude 透传格式）
 * @param {string} opts.model         分类模型
 * @param {string} opts.logTag        日志标识（如 'intent/feedback'）
 * @param {number} [opts.timeoutMs]   超时预算（默认 CLASSIFY_TIMEOUT_MS=30s；意图分类点传 10s）
 * @returns {Promise<object|null>}    首个 JSON 对象或 null
 */
export async function runClassifierOnce({ prompt, systemPrompt, model, logTag, timeoutMs }) {
  // 额度耗尽 fail-fast：曾发生五小时限流窗口内 SDK 流永不结束 → 不发起注定失败 / 会 stall 的分类调用
  if (isPoolExhausted(getTokens())) {
    logger.warn('llm-classify', 'token 池全部耗尽，跳过分类（fail-fast）', { logTag });
    return null;
  }
  // 意图分类点传 10s（用户在等第一条回复）；其余调用点不传，沿用 30s
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : CLASSIFY_TIMEOUT_MS;
  let out = '';
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), budget);
  try {
    // abort 走 SDK 优雅关闭（stdin EOF），限流卡死时流可能迟迟不结束（实测拖 10 分钟+）
    // → 再用 race 兜底：到点不管流死活直接返回，调用方绝不被拖死。
    const call = runClaude(prompt, {
      ...claudeAuthOpts(), // 跟随备用账号轮换，别烧主账号额度
      ...(systemPrompt ? { systemPrompt } : {}),
      persistSession: false, // 内部一次性调用，不落盘 session
      model,
      maxTurns: 1, // 分类只需一轮文本输出；即使模型试图调工具也就此收束
      disallowedTools: ['Agent', 'Task', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      abortController: abort,
      onText: (t) => (out += t),
      onResult: (info) => {
        if (!out && info.result) out = info.result;
      },
    });
    // race 放弃后该 promise 仍可能 reject，预挂 catch 防 unhandled；留日志便于排查
    call.catch((e) => logger.warn('llm-classify', '分类调用异常（已落兜底）', { logTag, err: e?.message || String(e) }));
    await Promise.race([call, new Promise((resolve) => setTimeout(resolve, budget + 2_000))]);
  } catch {
    /* 超时 abort 或调用异常 → 落兜底 */
  } finally {
    clearTimeout(timer);
  }
  const block = extractFirstJsonObject(out);
  if (!block) return null;
  try {
    return JSON.parse(block);
  } catch {
    return null;
  }
}

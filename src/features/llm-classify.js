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
  const m = out.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

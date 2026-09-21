/**
 * 前后端归属判定 —— 独立于 reviewTask 的第二次只读 Claude 调用。
 *
 * 为什么不并进 reviewTask：那个文件已两轮过审保持稳定，且它的判决矩阵是
 * feedback / task-triage 共用的资源，为巡检一条支线改它不划算（用户拍板）。
 *
 * 只在「评审判 fix + 关联了测试期需求 + 前后端目录齐备」时才调用，
 * 所以不会给纯 \10001 链路增加额度开销。
 */
import { runClaude } from '../../../integrations/claude.js';
import { claudeAuthOpts } from '../../../capabilities/token-rotation.js';
import { logger } from '../../../shared/logger.js';
import { buildSidePrompt, buildAssetOnlyPrompt, parseSideJson } from './side-review.logic.js';

/** 单条判定超时（对齐 entrypoints/web/req-inspect.js 的 REVIEW_TIMEOUT_MS） */
export const SIDE_TIMEOUT_MS = 5 * 60_000;

/**
 * 真实调用。只读闸与 reviewTask 同款：
 * dontAsk + allowedTools 才构成限制，缺一不可——allowedTools 本身只是「免确认」，
 * 未列出的工具仍会 fall through 到 permissionMode（详见 review/index.js 的注释）。
 */
async function callSideReview(record, { frontendDir, backendDir, assetOnly } = {}) {
  let out = '';
  await runClaude(
    assetOnly ? buildAssetOnlyPrompt(record, { frontendDir }) : buildSidePrompt(record, { frontendDir, backendDir }),
    {
      ...claudeAuthOpts(),
      cwd: frontendDir,
      // 注意参数名是 additionalDirectories（不是 addDirs），见 integrations/claude.js:91
      // 精简路径不判前后端，挂后端目录只会白白扩大可读范围
      additionalDirectories: !assetOnly && backendDir ? [backendDir] : undefined,
      permissionMode: 'dontAsk',
      allowedTools: ['Read', 'Grep', 'Glob'], // 只读查证
      persistSession: false, // 内部一次性调用不落盘 session
      onText: (t) => (out += t),
      onResult: (i) => {
        if (i.result) out = i.result;
      },
    },
  );
  return parseSideJson(out);
}

/**
 * 带超时与异常兜底的归属判定。两种失败都落 unknown：
 * unknown 会按前端自动修（改在任务分支上，人工 review 前进不了主干），
 * 比中断整轮或误判成 backend 打扰同事都更可接受。
 *
 * 超时不真正中断底层调用（runClaude 这里没接 abortController），只是不再等它——
 * 与 llm-classify / req-inspect 的 race 兜底同性质。
 *
 * @param {{review?:Function, timeoutMs?:number, assetOnly?:boolean}} opts
 *   assetOnly=true 走「只判缺图、不判前后端」的精简 prompt（无需求关联时用）；review/timeoutMs 供测试注入
 */
export async function reviewSideWithTimeout(record, dirs, opts = {}) {
  const { review = callSideReview, timeoutMs = SIDE_TIMEOUT_MS, assetOnly = false } = opts;
  const TIMEOUT = Symbol('timeout');
  let timer;
  try {
    const r = await Promise.race([
      review(record, { ...dirs, assetOnly }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      }),
    ]);
    if (r === TIMEOUT) {
      logger.warn('bug-patrol', '归属判定超时，按 unknown 处理', { title: record?.title });
      return { side: 'unknown', evidence: '归属判定超时', advice: '', blocked: '', blockReason: '' };
    }
    return r;
  } catch (e) {
    const msg = (e?.message || String(e)).slice(0, 200);
    logger.warn('bug-patrol', '归属判定失败，按 unknown 处理', { err: msg });
    return { side: 'unknown', evidence: `归属判定失败：${msg}`, advice: '', blocked: '', blockReason: '' };
  } finally {
    // 调用先赢时计时器仍会挂到 timeoutMs 后才触发，不清会拖住进程退出
    // （对齐 req-inspect.js#reviewWithTimeout 的同款纪律）
    clearTimeout(timer);
  }
}

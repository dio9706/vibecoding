/**
 * 进程级最后兜底 —— 防止单个畸形请求打死整个进程。
 *
 * 为什么必须有：全仓此前 grep uncaughtException|unhandledRejection **零命中**，
 * 而 Node ≥15 默认把未处理的 rejection 也视为致命错误。已实机复现的两条崩溃路径：
 *   - `POST /api/run/abort` body 传 {"runId":123} → `(123).trim is not a function`
 *   - `PUT /api/bots/%` → `URIError: URI malformed`
 * 两者都抛在 http 监听器里，没有任何 try/catch 接住。
 * 而 store/runs.js 是纯内存的（自陈「扛不了 node 进程重启」），
 * 所以一次崩溃 = 所有在跑的 Claude 任务全灭 + SDK 子进程被带走。
 *
 * 取舍说明：这里选择**记日志后继续存活**，而不是教科书式的「记录后退出」。
 * 理由是本进程持有大量不可恢复的内存态（运行中的 run、SSE 订阅、审批 pending），
 * 退出的代价确定且很大，而带病继续跑的风险相对可控。
 * 这一层是安全网，不是免死金牌 —— 具体的输入校验仍在 input.js / body.js 里各自把关。
 */
import { logger } from './logger.js';

let installed = false;

/** 幂等安装。web 与 feishu 两个入口都会调，重复调用不叠加监听器。 */
export function installProcessGuards() {
  if (installed) return;
  installed = true;

  process.on('uncaughtException', (err) => {
    logger.error('process', '未捕获异常（已兜底，进程继续运行）', {
      err: err?.message || String(err),
      stack: typeof err?.stack === 'string' ? err.stack.slice(0, 800) : undefined,
    });
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('process', '未处理的 Promise rejection（已兜底，进程继续运行）', {
      err: reason?.message || String(reason),
      stack: typeof reason?.stack === 'string' ? reason.stack.slice(0, 800) : undefined,
    });
  });
}

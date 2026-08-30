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
 *
 * ## 为什么要节流（2026-08-28 补）
 *
 * 「继续存活」这个取舍有个副作用：错误源不会自行消失。若 rejection 来自某个
 * 5s 一轮的轮询或自我续期的定时器，它就会**每轮抛一次、永不停止**。
 * 而 logger 是**同步** appendFileSync —— 于是记日志本身变成两个问题：
 * 拖慢事件循环，且几小时就能把日志文件撑到几百 MB（logger 无切割，只按天分文件）。
 * 所以同一错误按指纹在 60s 窗口内只记一条，但把被压制的条数带在下一条里 ——
 * 丢掉次数会让「偶发一次」和「每秒十次」在日志里长得一模一样，而这两种处置完全不同。
 */
import { logger } from './logger.js';

/** 同一错误的日志节流窗口 */
const THROTTLE_MS = 60_000;
/** 节流表 key 上限 —— 错误消息里常带变动的路径/ID，不封顶这张表本身就是内存泄漏 */
const MAX_KEYS = 200;

/**
 * 节流判定（纯函数，不碰 process 与时钟，便于单测）。
 *
 * @param {Map<string,{at:number,count:number}>} state 调用方持有的节流表
 * @param {string} key 错误指纹
 * @param {number} now 当前时间戳（注入而非内部取 Date.now，否则无法测窗口边界）
 * @param {number} [windowMs]
 * @returns {{log:boolean, count?:number, suppressed?:number}}
 *   log=true 时 suppressed 为上一窗口被压掉的条数（0 表示没压过）
 */
export function throttleDecide(state, key, now, windowMs = THROTTLE_MS) {
  const prev = state.get(key);
  if (prev && now - prev.at < windowMs) {
    prev.count++;
    return { log: false, count: prev.count };
  }
  if (state.size >= MAX_KEYS) state.clear();
  const suppressed = prev ? prev.count - 1 : 0; // 减 1：上个窗口的首条当时已记过
  state.set(key, { at: now, count: 1 });
  return { log: true, suppressed: suppressed > 0 ? suppressed : 0 };
}

/**
 * 从任意抛出/reject 的值里提取可读信息。
 *
 * 为什么不能只写 `reason?.message || String(reason)`：reject 的值不保证是 Error。
 * `Promise.reject({ code: 'ECONNRESET' })` 会被 String() 变成 `[object Object]`,
 * 信息全部丢失 —— 而这恰恰是网络类 rejection 的常见形状。
 *
 * @returns {{msg:string, stack:string|null, fingerprint:string}}
 */
export function describeReason(reason) {
  if (reason instanceof Error) {
    const msg = reason.message || reason.name || 'Error';
    const stack = typeof reason.stack === 'string' ? reason.stack : null;
    // 指纹取「消息 + 栈首帧」：同一处代码反复抛出应归为一类，不同位置的同名错误分开
    const frame = stack ? (stack.split('\n')[1] || '').trim() : '';
    return { msg, stack, fingerprint: `${reason.name}:${msg}:${frame}` };
  }
  let msg;
  if (typeof reason === 'string') msg = reason;
  else {
    try {
      msg = JSON.stringify(reason);
    } catch {
      msg = null; // 循环引用等
    }
    if (msg === undefined || msg === null) msg = String(reason);
  }
  msg = String(msg).slice(0, 500);
  return { msg, stack: null, fingerprint: 'nonerror:' + msg.slice(0, 200) };
}

let installed = false;

/** 幂等安装。web 与 feishu 两个入口都会调，重复调用不叠加监听器。 */
export function installProcessGuards() {
  if (installed) return;
  installed = true;

  // 两类事件各持一张节流表：同一条错误消息在两个通道里出现应分别计数，
  // 合用一张表会让 rejection 把同文案的 exception 压掉（那是两种不同的故障）。
  const exceptionState = new Map();
  const rejectionState = new Map();

  /** 记一条兜底日志（带节流）。两个 handler 的唯一差异只有文案。 */
  const report = (state, label, value) => {
    const { msg, stack, fingerprint } = describeReason(value);
    const d = throttleDecide(state, fingerprint, Date.now());
    if (!d.log) return;
    logger.error('process', label, {
      err: msg,
      stack: stack ? stack.slice(0, 800) : undefined,
      // 只在真被压制过时出现，避免每条日志都挂个 0
      ...(d.suppressed ? { 同类被压制条数: d.suppressed, 压制窗口秒: THROTTLE_MS / 1000 } : {}),
    });
  };

  process.on('uncaughtException', (err) => {
    report(exceptionState, '未捕获异常（已兜底，进程继续运行）', err);
  });

  process.on('unhandledRejection', (reason) => {
    report(rejectionState, '未处理的 Promise rejection（已兜底，进程继续运行）', reason);
  });
}

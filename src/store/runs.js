/**
 * 运行中的 Claude 生成任务（Run）—— 内存注册表，让「关掉网页」后生成仍继续。
 * 一次 /api/run 生成 = 一个 run；SSE 连接只是可随时断开/重连的观察窗口，二者解耦：
 *   断开只退订、绝不中断；完成后留存一段时间供重连读取。
 * 健壮性：每个 run 挂 AbortController + 看门狗（静默过久/总时长超顶自动中断并报错）。
 * 仅内存（不落盘）—— 能扛「关/刷新网页」，扛不了「node 进程重启」（SDK 子进程随之死）；
 * 重启中断的任务由 store/active-runs 落盘镜像 + web 入口启动恢复逻辑自动续跑（发「继续」）。
 */

import { logger } from '../shared/logger.js';

const runs = new Map(); // runId -> run

const KEEP_MS = 30 * 60 * 1000; // 完成的 run 保留时长，供重连读取
const MAX_DONE = 100; // 完成 run 上限，超出按时间淘汰
// 看门狗静默阈值：工具执行期间 SDK 流上没有任何消息属正常——Bash 工具上限 600s、
// 子代理内跑长工具可静默更久、临近限流首 token 延迟 3 分钟+（均实测）。300s 曾误杀
// 「调用 Agent」静默 303s 的活任务，放宽到 15min（真卡死多等几分钟 << 误杀长任务的代价）
const SILENCE_MS = 15 * 60 * 1000;
// 硬超时仅作无人值守兜底：abort 是优雅关闭、砍不停底层 CLI（额度照烧），只会让 UI 假报失败。
// 30min 曾误杀流上消息正常的活任务（静默仅 27s），放宽到 2h；更长任务由用户手动停止/续接
const HARD_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const WATCHDOG_TICK_MS = 5 * 1000; // 看门狗巡检间隔
const WAIT_MAX_MS = 15 * 60 * 1000; // 有人观看时，等待用户决策的最长时长，超过则应用默认

/**
 * 无人值守（关了网页、无订阅者）时等待审批的**远端上界**。
 * 原逻辑对 waiting 的兜底附加了「必须有订阅者」条件，于是关掉网页的挂起审批永远不会 resolve：
 * run 永远 running → gc 跳过 → CLI 子进程常驻 → active-runs.json 条目永不清除
 * → 重启后还被当孤儿自动续跑并累加 resumeAttempt。
 * 「不因无人应答就自动拒绝后台任务」这个设计意图要保留，所以这里取一个足够长、
 * 覆盖整个工作日离开场景的值，而不是把它降到 15 分钟。
 */
export const UNATTENDED_WAIT_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * 是否该对当前挂起的审批应用默认值（纯函数，便于单测时间相关逻辑）。
 * 有人观看 → 15 分钟；无人值守 → 6 小时。两者都必须是有限值。
 */
export function shouldResolveWaiting({ hasSubscribers, waitedMs }) {
  return waitedMs > (hasSubscribers ? WAIT_MAX_MS : UNATTENDED_WAIT_MAX_MS);
}

function newId() {
  return 'run_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function touch(run) {
  const t = Date.now();
  run.lastProgressAt = t;
  run.updatedAt = t;
}

function stopWatchdog(run) {
  if (run._watchdog) {
    clearInterval(run._watchdog);
    run._watchdog = null;
  }
}

/** 创建并登记一个 run（初始 running），启动看门狗 */
export function createRun() {
  gc();
  const now = Date.now();
  const run = {
    id: newId(),
    status: 'running', // running | done | error
    text: '',
    result: '',
    session_id: null,
    lastActivity: '',
    activities: [], // 工具活动流水（转录用，capped）
    todos: [], // TodoWrite 任务清单最新快照
    heldMsgs: [], // 插话持有缓冲：[{id,text}]，未进任务可撤回；本轮 result 时 flush 进 SDK
    modelInfo: null, // { model, effort } —— auto 判档结果（判档异步，经 model 事件/重放告知前端）
    pending: null, // 当前展示给用户的 ask：{ reqId, kind, title, body, options, defaultChoice, resolve }
    pendingQueue: [], // 排队中的 ask：SDK 对同轮并行 tool_use 会并发调 canUseTool，只能逐个呈现，覆盖会丢 resolve
    waiting: false, // 是否正阻塞等待用户输入（此期间暂停看门狗）
    waitingSince: 0,
    waitedMs: 0, // 累计等待用户的时长——硬超时按「实际运行时长」计，等审批不吃运行额度
    askSeq: 0,
    mode: null, // 权限模式（运行时可变，setRunMode 可中途放宽）；由 web 入口起跑时设置
    startMode: null, // 起跑时的权限模式：非「询问」起跑无 ask 钩子，中途无法拦截
    is_error: false,
    subtype: '',
    subscribers: new Set(), // Set<res>
    abortController: new AbortController(),
    startedAt: now,
    lastProgressAt: now,
    createdAt: now,
    updatedAt: now,
    _watchdog: null,
  };
  runs.set(run.id, run);
  run._watchdog = setInterval(() => {
    if (run.status !== 'running') return;
    const t = Date.now();
    if (run.waiting) {
      // 等待用户决策：不按静默/超时中断。有人观看 15min 兜底；无人值守（关网页）放宽到 6h
      // —— 后台任务不因无人应答就被自动拒绝，但也不能无限等（否则 run/CLI 子进程永久泄漏）。
      if (run.pending && shouldResolveWaiting({
        hasSubscribers: run.subscribers.size > 0,
        waitedMs: t - run.waitingSince,
      })) {
        const p = run.pending;
        if (!run.subscribers.size) {
          logger.warn('runs', '无人值守的审批等待超过上界，按默认值收敛', {
            runId: run.id,
            reqId: p.reqId,
            defaultChoice: p.defaultChoice,
            waitedMs: t - run.waitingSince,
          });
        }
        advanceAsk(run); // 放行队列中的下一个 ask（各自享有独立的等待窗口）
        p.resolve(p.defaultChoice); // 应用安全默认（拒绝/取消）
      }
      return;
    }
    // 提示"可能仍在运行"：SDK abort 是优雅关闭，CLI 卡在限流重试上时会继续跑到自然结束
    if (t - run.lastProgressAt > SILENCE_MS) {
      abortRun(
        run,
        `无响应超过 ${Math.round(SILENCE_MS / 1000)} 秒，已自动中断（看门狗）。底层任务可能仍在收尾，稍后可续接本会话确认进度`,
      );
    } else if (t - run.startedAt - run.waitedMs > HARD_TIMEOUT_MS) {
      abortRun(
        run,
        `运行超过 ${Math.round(HARD_TIMEOUT_MS / 60000)} 分钟，已自动中断（超时）。底层任务可能仍在收尾，稍后可续接本会话确认进度`,
      );
    }
  }, WATCHDOG_TICK_MS);
  return run;
}

export function getRun(id) {
  return runs.get(id) || null;
}

/** 该 conv 是否有进行中的 run（需求串行闸用：系统任务须等用户对话空闲） */
export function hasActiveRunForConv(convId) {
  if (!convId) return false;
  for (const r of runs.values()) if (r.convId === convId && r.status === 'running') return true;
  return false;
}

/**
 * 取该会话当前运行中的 run 对象（不只是「有没有」）。
 * 飞书补充内容注入需要拿到 run 本体才能判断走插话（holdMsg 进持有区）还是新起一轮，
 * hasActiveRunForConv 只给布尔值不够用。
 */
export function findRunningRunByConv(convId) {
  if (!convId) return null;
  for (const r of runs.values()) if (r.convId === convId && r.status === 'running') return r;
  return null;
}

/** 订阅 / 退订某 run 的增量推送（断开只退订，不中断 run） */
export function subscribe(run, res) {
  run.subscribers.add(res);
}
export function unsubscribe(run, res) {
  run.subscribers.delete(res);
}

/** 向单个连接发送一个 SSE 事件；失败返回 false（视为连接已死） */
export function sendTo(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/** 向 run 的全部订阅者广播；写失败的连接自动退订 */
function fanout(run, event, data) {
  run.updatedAt = Date.now();
  for (const res of [...run.subscribers]) {
    if (!sendTo(res, event, data)) run.subscribers.delete(res);
  }
}

// ---- 以下由 runClaude 回调驱动状态推进（每次都 touch 刷新看门狗计时）----
/** SDK 流上任一消息到达即视为存活（含子代理流事件/工具结果），仅刷新看门狗计时 */
export function runPulse(run) {
  touch(run);
}
export function runSession(run, sessionId) {
  run.session_id = sessionId;
  touch(run);
  fanout(run, 'session', { session_id: sessionId });
}
export function runText(run, text) {
  run.text += text;
  run.lastActivity = ''; // 文本恢复流动 → 清工具状态
  touch(run);
  fanout(run, 'chunk', { text });
}
export function runActivity(run, summary) {
  run.lastActivity = summary || '';
  if (summary) {
    run.activities.push(summary); // 累积转录，供 UI 逐条展示 + 重连重放
    if (run.activities.length > 50) run.activities.shift();
  }
  touch(run);
  fanout(run, 'activity', { summary: run.lastActivity });
}
/** TodoWrite 任务清单快照（覆盖式）→ 广播给前端渲染任务面板 */
export function runTodos(run, todos) {
  run.todos = Array.isArray(todos) ? todos : [];
  touch(run);
  fanout(run, 'todos', { todos: run.todos });
}

/** 生成下一个 ask 请求 id */
export function nextReqId(run) {
  run.askSeq += 1;
  return run.id + ':' + run.askSeq;
}

/**
 * 向用户发起一次决策请求（工具审批 / 交互提问），阻塞 SDK 直到用户选择。
 * 返回 Promise，用户提交后 resolve 为所选 option id（超时兜底 resolve 为 defaultChoice）。
 * 并发安全：已有展示中的 ask 时排队，决策后自动放行下一个——严禁覆盖 run.pending，
 * 否则被覆盖者的 resolve 永久丢失，CLI 会等权限响应挂死（2026-07-18 看门狗误杀事故根因）。
 */
export function askUser(run, ask) {
  return new Promise((resolve) => {
    // run 已终结 → 立即按默认值兜底，绝不进队列。
    // drainAsks 只在 finish/fail/block/stop 里各跑一次且都带 `status !== 'running'` 早退，
    // 所以终结**之后**新建的 pending 没有任何人会去 resolve —— 那是个永久悬空的 Promise，
    // 会让上层 await 永不返回（进而 mcp.close() 等 finally 清理全部落空）。
    // 触发窗口真实存在：SDK abort 是优雅关闭，CLI 在被杀掉前仍可能再发一次权限请求。
    if (run.status !== 'running') return resolve(ask.defaultChoice);
    const p = {
      reqId: ask.reqId,
      kind: ask.kind,
      title: ask.title,
      body: ask.body,
      options: ask.options,
      defaultChoice: ask.defaultChoice,
      resolve,
    };
    if (run.pending) run.pendingQueue.push(p);
    else presentAsk(run, p);
  });
}

/** 把一个 ask 放上展示位并广播给前端 */
function presentAsk(run, p) {
  run.pending = p;
  run.waiting = true;
  run.waitingSince = Date.now();
  touch(run);
  fanout(run, 'ask', {
    reqId: p.reqId,
    kind: p.kind,
    title: p.title,
    body: p.body,
    options: p.options,
  });
}

/** 当前 ask 已消费：队列有下一个则上位展示，否则退出等待态 */
function advanceAsk(run) {
  if (run.waiting) run.waitedMs += Date.now() - run.waitingSince; // 累计本段等待
  run.pending = null;
  const next = run.pendingQueue.shift();
  if (next) {
    presentAsk(run, next);
  } else {
    run.waiting = false;
    touch(run); // 刷新计时，避免刚续跑就被静默看门狗误判
  }
}

/** run 终结：未决 ask（含队列）全部按默认值兜底 resolve，避免 SDK 侧悬空等待 */
function drainAsks(run) {
  if (run.waiting) run.waitedMs += Date.now() - run.waitingSince;
  const all = [run.pending, ...run.pendingQueue].filter(Boolean);
  run.pending = null;
  run.pendingQueue.length = 0;
  run.waiting = false;
  for (const p of all) p.resolve(p.defaultChoice);
}

/** 用户提交决策：resolve 对应 pending 并续跑；成功返回 true */
export function resolveDecision(runId, reqId, choice) {
  const run = runs.get(runId);
  if (!run || !run.pending || run.pending.reqId !== reqId) return false;
  const p = run.pending;
  advanceAsk(run);
  p.resolve(choice);
  return true;
}

/**
 * 运行中切换权限模式（仅放宽）：只有「询问」起跑的 run 可即时生效——
 * 起跑时装了 PreToolUse ask 钩子，所有工具都会经 canUseTool，改 run.mode 即可放行。
 * 放宽同时自动放行挂起/排队的 permission 询问；dialog（交互提问）保序保留。
 * 非询问起跑的 run 没装钩子，工具不经回调，中途无从拦截 → 返回 false（下一条消息生效）。
 */
export function setRunMode(runId, mode) {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return false;
  // 判档窗口内（startMode 尚未赋值，最长 8s）：先缓冲，待 startClaudeRun 补发
  if (run.startMode === null) {
    run._pendingMode = mode;
    return true; // 乐观返回 true，避免前端误报「切换失败」
  }
  if (run.startMode !== 'default') return false;
  if (mode !== 'acceptEdits' && mode !== 'bypassPermissions') return false;
  run.mode = mode;
  // 排队中的 permission 直接放行；dialog 保序留下
  const keep = [];
  for (const p of run.pendingQueue) {
    if (p.kind === 'permission') p.resolve('allow');
    else keep.push(p);
  }
  run.pendingQueue = keep;
  // 展示位是 permission → 放行；advanceAsk 会让队列下一个（若有）上位并广播
  if (run.pending && run.pending.kind === 'permission') {
    const p = run.pending;
    advanceAsk(run);
    p.resolve('allow');
  }
  if (!run.pending) fanout(run, 'ask', null); // 通知前端撤下已展示的审批弹窗
  touch(run);
  return true;
}
/** auto 判档结果确定（判档异步于 /start 返回）→ 记录并广播，前端据此显示实际所用模型 */
export function runModel(run, info) {
  run.modelInfo = info;
  touch(run);
  fanout(run, 'model', info);
}
export function runRateLimit(run, info) {
  touch(run);
  fanout(run, 'ratelimit', info);
}
export function runResult(run, info) {
  run.is_error = !!info.is_error;
  run.subtype = info.subtype || '';
  run.result = info.result || '';
  touch(run);
}

// ---- 插话持有缓冲：消息先存服务端，当前轮 result 时统一 flush 进 SDK ----
let heldSeq = 0;
/** 持有一条插话消息（未进任务，可撤回/立即生效），广播最新排队列表；返回 msgId */
export function holdMsg(run, text) {
  const id = 'hm_' + Date.now().toString(36) + '_' + ++heldSeq;
  run.heldMsgs.push({ id, text });
  touch(run);
  fanout(run, 'queue', { held: run.heldMsgs.map((m) => m.id) });
  return id;
}
/** 撤回一条持有中的消息；已 flush（不存在）返回 false */
export function withdrawHeldMsg(run, msgId) {
  const i = run.heldMsgs.findIndex((m) => m.id === msgId);
  if (i < 0) return false;
  run.heldMsgs.splice(i, 1);
  touch(run);
  fanout(run, 'queue', { held: run.heldMsgs.map((m) => m.id) });
  return true;
}
/** 全部持有消息按序推进 SDK 输入流（进入任务），广播 consumed；返回已消费 id。
 *  须在 result 处理链内同步调用（autoClose 之前），输入流非空则同一 run 续下一轮 */
export function flushHeldMsgs(run) {
  if (!run.heldMsgs.length || !run._input || typeof run._input.push !== 'function') return [];
  const ids = [];
  for (const m of run.heldMsgs) if (run._input.push(m.text)) ids.push(m.id);
  run.heldMsgs = run.heldMsgs.filter((m) => !ids.includes(m.id));
  if (ids.length) {
    touch(run);
    fanout(run, 'consumed', { msgIds: ids });
  }
  return ids;
}
/** 额度用尽路径：取出持有消息并按「已进入任务」广播（文本将并入待续跑 prompt） */
export function consumeHeldMsgs(run) {
  const msgs = run.heldMsgs.splice(0);
  if (msgs.length) fanout(run, 'consumed', { msgIds: msgs.map((m) => m.id) });
  return msgs;
}
/** 立即生效打断当前轮后：作废该轮挂起的 ask（按默认值兜底），并通知前端撤下弹窗 */
export function cancelPendingAsks(run) {
  if (!run.pending && !run.pendingQueue.length) return;
  drainAsks(run);
  fanout(run, 'ask', null);
}
/** done 广播公共字段：附带未消费的持有消息 id（前端标「未发送」）并清空持有区。
 *  ids 同时留存到 run.unsentIds：关页期间终结的 run，重连 attach 补发 done 时据此恢复标记 */
function unsentField(run) {
  if (!run.heldMsgs || !run.heldMsgs.length) return {};
  run.unsentIds = run.heldMsgs.splice(0).map((m) => m.id);
  return { unsent: run.unsentIds };
}

/**
 * run 终结广播 —— 通知等旁路关注方的唯一接缝。
 *
 * 为什么在 store 层而不是 run-claude 的 settleRun：settleRun 只覆盖 Claude provider，
 * 且额度撞墙分支会提前 return；而下面四个终结函数是**全 provider（含 openai-compat）、
 * 全路径（正常/异常/看门狗/手动停止/额度阻塞）**的唯一收口，且都先判 status!=='running' 早退
 * → 每个 run 只广播一次，天然无重复。
 *
 * 层级纪律：store 不 import 业务模块（lark/settings），监听器由上层注册。
 * 监听器异常必须吞掉：绝不能让一个通知失败影响 run 的收尾与 SSE 广播。
 */
const settleListeners = [];

export function registerRunSettleListener(fn) {
  if (typeof fn === 'function') settleListeners.push(fn);
}

function warnListenerErr(run, e) {
  logger.warn('runs', 'run 终结监听器异常（已忽略）', { runId: run.id, err: e?.message || String(e) });
}

function emitSettled(run) {
  for (const fn of settleListeners) {
    try {
      // 监听器多半是 async（飞书推送要走 HTTP）：同步 try/catch 只能抓到首个 await 之前的
      // 抛错，之后的失败会变成 unhandled rejection —— Node 默认把它当致命错误，
      // 一次推送失败就能打挂整个 web 服务。所以返回值是 thenable 时必须再挂一道 catch。
      const ret = fn(run);
      if (ret && typeof ret.then === 'function') ret.then(undefined, (e) => warnListenerErr(run, e));
    } catch (e) {
      warnListenerErr(run, e);
    }
  }
}

/** 正常结束：广播 done、结束并清空订阅者连接 */
export function finishRun(run) {
  if (run.status !== 'running') return;
  if (!run.text && run.result) run.text = run.result; // 兜底
  run.status = run.is_error ? 'error' : 'done';
  run.updatedAt = Date.now();
  stopWatchdog(run);
  drainAsks(run);
  fanout(run, 'done', { result: run.result || run.text, is_error: run.is_error, subtype: run.subtype, ...unsentField(run) });
  closeAll(run);
  emitSettled(run);
}

/** 失败（SDK 抛错 / 看门狗 / 超时）：把原因并入文本，统一按 done(is_error) 广播 */
export function failRun(run, message) {
  if (run.status !== 'running') return;
  logger.error('runs', 'run 异常终结', { runId: run.id, message });
  run.is_error = true;
  run.subtype = run.subtype || 'exception';
  run.status = 'error';
  run.text = run.text ? run.text + '\n\n⚠️ ' + message : '⚠️ ' + message;
  run.updatedAt = Date.now();
  stopWatchdog(run);
  drainAsks(run);
  fanout(run, 'done', { result: run.text, is_error: true, subtype: run.subtype, ...unsentField(run) });
  closeAll(run);
  emitSettled(run);
}

/** 中断底层 SDK 查询并标记异常（看门狗/超时用）。
 *  注：SDK 的 abort 走优雅关闭（stdin EOF），CLI 若正卡在限流重试上可能继续跑到自然结束
 *  ——所以必须留日志，便于对照「UI 已中断但底层还在跑」的现象。 */
function abortRun(run, reason) {
  logger.warn('runs', '看门狗中断', {
    runId: run.id,
    reason,
    silentMs: Date.now() - run.lastProgressAt,
    totalMs: Date.now() - run.startedAt,
    lastActivity: run.lastActivity || '(无)',
  });
  try {
    run.abortController.abort();
  } catch {
    /* ignore */
  }
  failRun(run, reason);
}

/** 额度用尽阻塞：中性终结并附提示（不标红），任务将于 token 重置后自动续跑 */
export function blockRun(run, note) {
  if (run.status !== 'running') return;
  run.status = 'done';
  run.subtype = 'quota_blocked';
  run.text = run.text ? run.text + '\n\n' + note : note;
  run.updatedAt = Date.now();
  stopWatchdog(run);
  drainAsks(run);
  fanout(run, 'done', { result: run.text, is_error: false, subtype: 'quota_blocked', ...unsentField(run) });
  closeAll(run);
  emitSettled(run);
}

/** 手动停止：中断 SDK 并按「已停止」中性终结（不标红，区别于异常） */
export function stopRun(run, reason = '已手动停止') {
  if (run.status !== 'running') return;
  try {
    run.abortController.abort();
  } catch {
    /* ignore */
  }
  run.status = 'done';
  run.subtype = 'stopped';
  run.text = run.text ? run.text + '\n\n⏹ ' + reason : '⏹ ' + reason;
  run.updatedAt = Date.now();
  stopWatchdog(run);
  drainAsks(run);
  fanout(run, 'done', { result: run.text, is_error: false, subtype: 'stopped', ...unsentField(run) });
  closeAll(run);
  emitSettled(run);
}

/** 按 id 手动停止（供 /api/run/abort 调用）；成功返回 true */
export function abortRunById(id, reason) {
  const run = runs.get(id);
  if (!run || run.status !== 'running') return false;
  stopRun(run, reason);
  return true;
}

function closeAll(run) {
  for (const res of [...run.subscribers]) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  run.subscribers.clear();
}

/** 淘汰过期/超量的已完成 run，避免内存无限增长 */
function gc() {
  const now = Date.now();
  const done = [];
  for (const run of runs.values()) {
    if (run.status === 'running') continue;
    if (now - run.updatedAt > KEEP_MS) runs.delete(run.id);
    else done.push(run);
  }
  if (done.length > MAX_DONE) {
    done.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const run of done.slice(0, done.length - MAX_DONE)) runs.delete(run.id);
  }
}

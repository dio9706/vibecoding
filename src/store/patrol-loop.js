/**
 * BUG 巡检循环状态（patrol-loop.json）—— 单例，同时只允许一个循环在跑。
 *
 * 为什么是单例：auto-dev 只有一个常驻工作区（auto worktree），两个循环会抢同一个
 * 任务分支。与其做并发控制，不如直接拒绝第二个触发并告知启动人。
 *
 * 为什么落盘而不是内存：循环最长跑 12 小时，期间 pm2 重启（崩溃自重启 / 代码更新）
 * 是常态。内存态会让循环在无人察觉时静默消失——而这功能正是为无人值守设计的。
 *
 * 消费方：`plugins/team-tools/bug-patrol/loop.js`（泵，web 进程）与
 * `entrypoints/web/routes-patrol.js`（飞书进程的跨进程指令入口）。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'patrol-loop.json';

/** 默认态。active=false 时泵直接 return，不做任何事 */
export const DEFAULT_LOOP = {
  active: false,
  stopping: false, // \10004 已收到：不再新扫，等已入队任务跑完后发终报
  openId: '',
  chatId: '',
  chatType: '',
  appToken: '',
  tableId: null,
  url: '',
  reqId: null, // 只存 id 不存 title 快照（对齐 colleagues.js 的 assignees 纪律）
  startedAt: 0,
  phase: 'scanning', // 'scanning' | 'standby'
  nextRunAt: 0,
  roundNo: 0,
  seen: {}, // { [recordId]: { verdict, side, at } }
  cycleTaskIds: [],
  retried: {}, // { [taskId]: true }
  report: { fixed: [], handoff: [], failed: [], unknown: [], needHuman: [] },
};

/**
 * 形状归一（纯函数）。每个字段独立兜底：读坏一个字段不该让整份状态回退，
 * 否则一次手改 JSON 出错就会把正在跑的循环整个抹掉。
 *
 * 返回值恒为新对象（含 seen/report 等嵌套），调用方改它不会污染 DEFAULT_LOOP。
 */
export function normalizeLoop(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {});
  const arr = (v) => (Array.isArray(v) ? [...v] : []);
  const rep = obj(o.report);
  return {
    active: o.active === true,
    stopping: o.stopping === true,
    openId: typeof o.openId === 'string' ? o.openId : '',
    chatId: typeof o.chatId === 'string' ? o.chatId : '',
    chatType: typeof o.chatType === 'string' ? o.chatType : '',
    appToken: typeof o.appToken === 'string' ? o.appToken : '',
    tableId: typeof o.tableId === 'string' ? o.tableId : null,
    url: typeof o.url === 'string' ? o.url : '',
    reqId: typeof o.reqId === 'string' ? o.reqId : null,
    startedAt: Number.isFinite(o.startedAt) ? o.startedAt : 0,
    phase: o.phase === 'standby' ? 'standby' : 'scanning',
    nextRunAt: Number.isFinite(o.nextRunAt) ? o.nextRunAt : 0,
    roundNo: Number.isFinite(o.roundNo) ? o.roundNo : 0,
    seen: obj(o.seen),
    cycleTaskIds: arr(o.cycleTaskIds),
    retried: obj(o.retried),
    report: {
      fixed: arr(rep.fixed),
      handoff: arr(rep.handoff),
      failed: arr(rep.failed),
      unknown: arr(rep.unknown),
      // pushReport 靠「cur.report[kind] 已是数组」做隐式白名单 —— 这里不透传就等于永远不是数组，
      // 写进去的每一条都会被下一次 normalizeLoop 静默抹掉
      needHuman: arr(rep.needHuman),
    },
  };
}

/** 读当前循环状态（永远返回合法形状） */
export function readLoop() {
  return normalizeLoop(readJson(FILE, null));
}

/**
 * 锁内浅合并补丁。
 * ⚠️ seen / retried / report 是**整体替换**，增量请用下面四个专用函数——
 * 在锁外读改写会被另一进程覆盖（同 action-configs.js#appendAutoKeyword 的教训）。
 */
export function updateLoop(patch = {}) {
  let out = null;
  updateJson(FILE, null, (raw) => {
    out = normalizeLoop({ ...normalizeLoop(raw), ...patch });
    return out;
  });
  return out;
}

/** 锁内增量记 seen —— 逐条评审是串行的，但泵 tick 可能并发进来，必须锁内读改写 */
export function markSeen(recordId, info = {}) {
  if (!recordId) return null;
  let out = null;
  updateJson(FILE, null, (raw) => {
    const cur = normalizeLoop(raw);
    cur.seen = { ...cur.seen, [recordId]: { ...info, at: Date.now() } };
    out = cur;
    return cur;
  });
  return out;
}

/** 锁内追加本轮任务 id（幂等） */
export function pushCycleTask(taskId) {
  if (!taskId) return null;
  let out = null;
  updateJson(FILE, null, (raw) => {
    const cur = normalizeLoop(raw);
    if (cur.cycleTaskIds.includes(taskId)) {
      out = cur;
      return undefined; // 已存在：不写盘
    }
    cur.cycleTaskIds = [...cur.cycleTaskIds, taskId];
    out = cur;
    return cur;
  });
  return out;
}

/** 锁内往 report 的某一类追加一条 */
export function pushReport(kind, item) {
  let out = null;
  updateJson(FILE, null, (raw) => {
    const cur = normalizeLoop(raw);
    if (!Array.isArray(cur.report[kind])) return undefined; // 非法 kind：不写盘
    cur.report = { ...cur.report, [kind]: [...cur.report[kind], item] };
    out = cur;
    return cur;
  });
  return out;
}

/** 锁内标记某任务已重试过一次（拍板：失败只重试一次） */
export function markRetried(taskId) {
  if (!taskId) return;
  updateJson(FILE, null, (raw) => {
    const cur = normalizeLoop(raw);
    cur.retried = { ...cur.retried, [taskId]: true };
    return cur;
  });
}

/** 结束循环：整份回默认态（下次触发是全新一轮，不该继承上次的 seen） */
export function clearLoop() {
  updateJson(FILE, null, () => ({ ...DEFAULT_LOOP }));
}

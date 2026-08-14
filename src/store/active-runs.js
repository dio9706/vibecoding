/**
 * 进行中 run 的落盘镜像 —— runs.js 注册表是纯内存（进程重启即丢，SDK 子进程随之死），
 * 这里持久化最小续跑锚点：启动时据此把孤儿 run 转「待续跑」，自动发「继续」resume session。
 * 生命周期：startClaudeRun 登记 → onInit 补 session_id → settleRun 移除；
 * 进程崩溃/重启时残留的条目即孤儿，由 web 入口启动逻辑消费。
 * 条目字段含 resumeAttempt（续跑代次，普通首跑为 0）：进程重启时孤儿恢复据此 +1 计次熔断。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'active-runs.json';

export function listActiveRuns() {
  return readJson(FILE, []);
}

export function addActiveRun(entry) {
  updateJson(FILE, [], (list) => {
    const next = list.filter((e) => e.runId !== entry.runId);
    next.push(entry);
    return next;
  });
}

/** 补写字段（如 onInit 到达后回填 session_id） */
export function patchActiveRun(runId, patch) {
  updateJson(FILE, [], (list) => {
    const i = list.findIndex((e) => e.runId === runId);
    if (i < 0) return undefined;
    list[i] = { ...list[i], ...patch };
    return list;
  });
}

export function removeActiveRun(runId) {
  updateJson(FILE, [], (list) => list.filter((e) => e.runId !== runId));
}

export function clearActiveRuns() {
  updateJson(FILE, [], () => []);
}

/** 只移除指定 runId 的条目——多实例共用 APP_DATA_DIR 时不能整表清空 */
export function removeActiveRuns(runIds) {
  const drop = new Set(runIds || []);
  if (!drop.size) return;
  updateJson(FILE, [], (list) => list.filter((e) => !drop.has(e.runId)));
}

/** pid 是否存活：signal 0 只做存在性探测。EPERM = 存在但无权限，同样算活着。 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/**
 * 把落盘条目分成「可回收的孤儿」与「他人所有」两组（纯函数，依赖注入便于单测）。
 *
 * 为什么需要：recoverPendingAndOrphans 原本无条件 clearActiveRuns() 并把每条都当孤儿续跑。
 * 而 ecosystem.config.cjs 让 PM2 web 与 Tauri 桌面版共用同一个 APP_DATA_DIR 且设计上可同时运行
 * → 桌面版启动会抢走 PM2 正在跑的 run，对同一 session_id 自动发「继续」，
 * 造成同一会话被两个进程并发跑（重复烧额度 + 并发写同一工作目录）。
 *
 * 判定：属主 pid 存活即「有主」，但 pid 会在重启后被复用，
 * 因此还要求条目的 startedAt 不早于本次开机时间。缺 pid 的旧数据按孤儿处理（向后兼容）。
 */
export function partitionActiveRuns(entries, { selfPid, isPidAlive: alive, bootTimeMs }) {
  const orphans = [];
  const foreign = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const pid = e?.pid;
    const ownedByOther =
      Number.isInteger(pid) &&
      pid !== selfPid &&
      alive(pid) &&
      Number.isFinite(e?.startedAt) &&
      e.startedAt >= bootTimeMs;
    (ownedByOther ? foreign : orphans).push(e);
  }
  return { orphans, foreign };
}

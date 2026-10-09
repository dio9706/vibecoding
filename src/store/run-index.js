/**
 * 运行中 run 的可查询索引（run-index.json）—— **P5 起崩溃恢复的唯一来源**（active-runs 已退役）。
 *
 * 字段是原 active-runs 条目的超集：provider / requestId / prompt（截断）/ status / lastSeq 等，
 * 供 journal 对账（classifyInterrupted）与 openai 检查点续跑（P3）使用。
 * 写入口：Claude 路径经 run-durability.js 的 mirror* 接线；openai 路径在 run-openai.js 直写。
 *
 * 多实例守卫的 partition 判定**原样迁移**自 active-runs.js（连同事故背景注释，勿简化）。
 * 升级迁移：`migrateLegacyActiveRuns()` 把 P5 前只写 active-runs.json 的存量条目并入本索引后
 * 清空旧表（reconcileRuns 启动时调用一次，幂等）。
 */
import { readJson, updateJson } from './index.js';
import { logger } from '../shared/logger.js';

const FILE = 'run-index.json';
/** P5 已退役的旧表：仅迁移时读一次，随后清空，不再有任何写入方 */
const LEGACY_ACTIVE_RUNS_FILE = 'active-runs.json';

export function listRunIndex() {
  return readJson(FILE, []);
}

/** 登记/覆盖一条 run（同一 runId 去重） */
export function upsertRun(entry) {
  updateJson(FILE, [], (list) => {
    const next = (Array.isArray(list) ? list : []).filter((e) => e.runId !== entry.runId);
    next.push(entry);
    return next;
  });
}

/** 补写字段（如 onInit 后回填 session_id） */
export function patchRun(runId, patch) {
  updateJson(FILE, [], (list) => {
    const i = list.findIndex((e) => e.runId === runId);
    if (i < 0) return undefined;
    list[i] = { ...list[i], ...patch };
    return list;
  });
}

export function removeRun(runId) {
  updateJson(FILE, [], (list) => list.filter((e) => e.runId !== runId));
}

/** 只移除指定 runId 的条目——多实例共用 APP_DATA_DIR 时不能整表清空 */
export function removeRuns(runIds) {
  const drop = new Set(runIds || []);
  if (!drop.size) return;
  updateJson(FILE, [], (list) => list.filter((e) => !drop.has(e.runId)));
}

export function clearRunIndex() {
  updateJson(FILE, [], () => []);
}

/**
 * 一次性升级迁移（P5）：把旧 active-runs.json 的存量条目并入 run-index，然后清空旧表。
 *
 * 为什么需要：P5 前的版本只写 active-runs；直接升级到 P5 的实例在重启瞬间，旧表里躺着
 * 的正是本次重启制造的孤儿——不并进来，这些任务就静默丢失自动续跑。合并**不覆盖**索引
 * 中已存在的同 runId 条目（双写期的索引版本为准）。旧表损坏时保留原文件、跳过迁移（不抛，
 * 不阻塞启动），只记日志。
 *
 * @returns {number} 实际并入的条目数（0 = 无需迁移/已迁移过）
 */
export function migrateLegacyActiveRuns() {
  let legacy;
  try {
    legacy = readJson(LEGACY_ACTIVE_RUNS_FILE, []);
  } catch (e) {
    logger.warn('store', 'active-runs.json 读取失败，跳过迁移（保留原文件待人工处理）', {
      err: e?.message || String(e),
    });
    return 0;
  }
  if (!Array.isArray(legacy) || legacy.length === 0) return 0;
  let added = 0;
  // 合并失败会抛给调用方兜底——此时不清旧表，数据仍在
  updateJson(FILE, [], (list) => {
    const known = new Set(list.map((e) => e?.runId));
    for (const e of legacy) {
      if (e && e.runId && !known.has(e.runId)) {
        list.push(e);
        added++;
      }
    }
    return list;
  });
  try {
    updateJson(LEGACY_ACTIVE_RUNS_FILE, [], () => []);
  } catch (e) {
    logger.warn('store', '清空 active-runs.json 失败（已忽略；下次启动会重试迁移）', {
      err: e?.message || String(e),
    });
  }
  return added;
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
 * 把索引条目分成「可回收的孤儿」与「他人所有」两组（纯函数，依赖注入便于单测）。
 *
 * 为什么需要：早期 recoverPendingAndOrphans 无条件整表清空并把每条都当孤儿续跑。
 * 而 ecosystem.config.cjs 让 PM2 web 与 Tauri 桌面版共用同一个 APP_DATA_DIR 且设计上可同时运行
 * → 桌面版启动会抢走 PM2 正在跑的 run，对同一 session_id 自动发「继续」，
 * 造成同一会话被两个进程并发跑（重复烧额度 + 并发写同一工作目录）。
 *
 * 判定：属主 pid 存活即「有主」，但 pid 会在重启后被复用，
 * 因此还要求条目的 startedAt 不早于本次开机时间。缺 pid 的旧数据按孤儿处理（向后兼容）。
 */
export function partitionRunIndex(entries, { selfPid, isPidAlive: alive, bootTimeMs }) {
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

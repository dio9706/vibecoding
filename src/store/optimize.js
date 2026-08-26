/**
 * optimize.json 的读写。沿用本项目 store 层的 readJson/updateJson 范式。
 * 用项目绝对路径作为 key——同一台机器上路径唯一，不需要额外生成 id。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'optimize.json';
const EMPTY = () => ({ projects: {} });
const HISTORY_LIMIT = 20;
const FIX_HISTORY_LIMIT = 20;

/**
 * 串行闸的陈旧阈值：超过这么久的占用视为「上次跑到一半进程没了」，允许抢占。
 *
 * 必须有这个兜底，否则一次崩溃就把该项目永久锁死。取 60 分钟是按最坏情况估的：
 * 一次优化 = 每个文件一次 description 生成（实测最长 82s）+ 结束后重跑体检，
 * 而体检的提示词维度单批预算就是 300s、可能跑好几批。宁可锁久一点，
 * 也不要在真的还在跑的时候被第二个请求抢进来——那会让两批操作交错写同一批文件。
 *
 * 陈旧不会静默发生：API 会把 `at` 一并返回，UI 显示「自 X 时起正在优化」，
 * 时间明显过老时用户自己就能看出来是残留。
 */
export const BUSY_STALE_MS = 60 * 60 * 1000;

const blankRecord = () => ({ history: [], busy: null, backups: [] });

export function readOptimizeStore() {
  const data = readJson(FILE, EMPTY());
  if (!data.projects || typeof data.projects !== 'object') data.projects = {};
  return data;
}

export function getProjectRecord(dir) {
  const data = readOptimizeStore();
  return data.projects[dir] || null;
}

/**
 * 存一次体检结果，并把分数追加到历史（用于画趋势线）。
 *
 * 同一次体检会被存**多次**：LLM 维度是异步回填的，每落一个维度就重存一次，
 * 好让中途刷新页面的用户看到已出的结果。所以历史按 `at` 去重覆盖而不是无脑追加——
 * 否则一次体检会在趋势线上留下三个点（静态分 → 单维回填 → 最终分），把曲线画成锯齿。
 */
export function saveCheckup(dir, report) {
  return updateJson(FILE, EMPTY(), (data) => {
    if (!data.projects) data.projects = {};
    const rec = data.projects[dir] || blankRecord();
    rec.lastCheckup = report;
    if (typeof report.score === 'number') {
      const kept = (rec.history || []).filter((h) => h.at !== report.at);
      rec.history = [...kept, { at: report.at, score: report.score }].slice(-HISTORY_LIMIT);
    }
    data.projects[dir] = rec;
    return data;
  });
}

/**
 * 取某项目的 LLM 维度指纹缓存：`{ prompts: {fingerprint, result}, comments: {...} }`。
 * 按维度分开存——两个维度的指纹覆盖面完全不同（提示词看 .claude 下的 md，注释看抽样源码），
 * 合成一个指纹会让任一侧的改动作废另一侧的缓存，白烧一次额度。
 */
export function getLlmCache(dir) {
  return getProjectRecord(dir)?.llmCache || {};
}

/** 写回单个维度的缓存条目；entry 为 null（分析未成功）时不覆盖已有缓存 */
export function saveLlmCache(dir, key, entry) {
  if (!entry) return;
  return updateJson(FILE, EMPTY(), (data) => {
    if (!data.projects) data.projects = {};
    const rec = data.projects[dir] || blankRecord();
    rec.llmCache = { ...(rec.llmCache || {}), [key]: entry };
    data.projects[dir] = rec;
    return data;
  });
}

// ==================== 串行闸 ====================
//
// 为什么要有：体检和优化都是「同一个项目、跑一次要好几分钟、还要烧额度」的操作。
// 用户开两个标签页各点一次，体检会白烧一倍额度，优化更糟——两批降级交错写同一批文件，
// 第二批的备份快照会把第一批改到一半的状态当成「原始状态」记下来，还原就还不回去了。
//
// 为什么落盘而不是进程内变量：本项目 PM2 同时跑 claude-web 和 claude-feishu 两个进程
// （见 store/index.js 的并发模型说明），进程内的锁拦不住另一个进程。
// updateJson 是同步的、且带跨进程文件锁，所以「检查 + 占位」写在同一个回调里
// 天然就是一次原子的比较并交换，不会出现两边都读到空闲的窗口。

function isStale(busy) {
  const t = Date.parse(busy?.at);
  return !Number.isFinite(t) || Date.now() - t > BUSY_STALE_MS;
}

/** 当前占用；已过陈旧阈值的视为无人占用 */
export function getBusy(dir) {
  const busy = getProjectRecord(dir)?.busy;
  return busy && !isStale(busy) ? busy : null;
}

/**
 * 尝试占用某项目。**同步且原子**，调用方拿到 ok:true 之后才可以开始跑。
 *
 * @param {string} dir
 * @param {'checkup'|'fix'} kind
 * @param {string|null} [jobId] 关联的 job id，供前端断线后重连回同一个任务
 * @returns {{ok:true, busy:object} | {ok:false, busy:object}} ok:false 时 busy 是**别人**的占用记录
 */
export function acquireBusy(dir, kind, jobId = null) {
  let out;
  updateJson(FILE, EMPTY(), (data) => {
    if (!data.projects) data.projects = {};
    const rec = data.projects[dir] || blankRecord();
    if (rec.busy && !isStale(rec.busy)) {
      out = { ok: false, busy: rec.busy };
      return undefined; // 没抢到就别写盘，免得把别人的占用时间刷新了
    }
    rec.busy = { kind, at: new Date().toISOString(), jobId };
    data.projects[dir] = rec;
    out = { ok: true, busy: rec.busy };
    return data;
  });
  return out;
}

/** 释放占用。必须放在 finally 里——中途抛错不释放的话，这个项目要等一小时才解锁 */
export function releaseBusy(dir) {
  return updateJson(FILE, EMPTY(), (data) => {
    if (!data.projects?.[dir]?.busy) return undefined;
    data.projects[dir].busy = null;
    return data;
  });
}

/**
 * 追加一次优化记录（最新的在前）。
 *
 * 只动 `fixes` 这一个字段：优化结束时要「先落结果、再释放闸」，两步写的是同一份 JSON，
 * 整份覆盖会让后写的那步把前一步抹掉。
 */
export function saveFixResult(dir, fix) {
  return updateJson(FILE, EMPTY(), (data) => {
    if (!data.projects) data.projects = {};
    const rec = data.projects[dir] || blankRecord();
    rec.fixes = [fix, ...(rec.fixes || [])].slice(0, FIX_HISTORY_LIMIT);
    data.projects[dir] = rec;
    return data;
  });
}

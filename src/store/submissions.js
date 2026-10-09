/**
 * 提交幂等认领表（submissions.json）—— requestId → ref 的跨进程持久去重。
 *
 * 要解决的问题：同一件提交到达两次时副作用（起 run / 持有一条插话 / 处理一条飞书消息）
 * 至多做一次。来源：web 端网络重试与降级重启（/api/run/start、/api/run/send）、
 * 飞书失败重投（messageId 维度）。纯内存去重（channels/feishu.js 的旧 seen 表）扛不住
 * 「进程重启窗口内的重投」，所以认领要落盘。
 *
 * 协议：claim(key) 先写一条「受理中」认领（ref=null），副作用完成后 bind(key, ref)。
 *   - 命中已 bind 的认领 → 真重复。调用方回放既有结果（runId / msgId），不再执行副作用；
 *   - 命中未 bind 且很新的认领 → 原处理可能仍在途（claim 与 bind 之间只有同步代码，
 *     正常永不落下；只有进程在两者之间死亡才会残留）→ 按重复拒绝，避免双跑；
 *   - 命中未 bind 且已陈旧（≥ RECLAIM_MS）→ 视为死认领，原地复占（崩溃后迟到的重投能自愈）；
 *   - 超过 TTL 的认领一律视为不存在，顺手清理（懒 GC，无需定时器）。
 *
 * 语义取舍（feishu:msg:<messageId> 这类只 claim 不 bind 的键）：快速重投拦掉、
 * 慢速重投（≥ RECLAIM_MS）重放——比纯内存 seen 表多了跨重启保护，又不至于把
 * 「崩溃后迟迟才到的重投」永久吞掉（那种情况重放比丢消息可接受）。
 *
 * 层级：store 层，只依赖 index.js 的跨进程文件锁与原子写。损坏拒绝写入的语义继承自 updateJson。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'submissions.json';
/** 未 bind 认领的复占阈值（见文件头协议）：claim 与 bind 之间只有同步代码，60s 足够保守 */
export const RECLAIM_MS = 60 * 1000;
/** 常规提交（web 起跑/插话）的认领保留时长：覆盖当日的重试/重放足够 */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** 条目总量上限：GC 按最旧淘汰（防异常调用把文件刷爆；正常运行远低于此） */
const MAX_ENTRIES = 5000;

function plainStore(cur) {
  return cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
}

/** key 合法性：非法 key 视为「没有 requestId」，退化为不幂等（不报错、不落盘） */
export function isValidSubmissionKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 256 && !/[\u0000-\u001f\u007f]/.test(key);
}

/** 过期清理 + 超量淘汰（就地修改） */
function prune(store, now) {
  for (const k of Object.keys(store)) {
    const e = store[k];
    if (!e || typeof e !== 'object' || !(Number(e.exp) > now)) delete store[k];
  }
  const keys = Object.keys(store);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => Number(store[a]?.at || 0) - Number(store[b]?.at || 0));
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete store[k];
  }
}

/**
 * 认领一个提交 key。
 * @param {string} key 命名空间化 key（如 `start:<requestId>`、`steer:<requestId>`、`feishu:msg:<messageId>`）
 * @param {{ttlMs?: number, now?: number}} [opts] now 可注入便于测试时间语义
 * @returns {{duplicate: boolean, entry: {at:number, exp:number, ref:?string}|null}}
 *   duplicate=true 时 entry 为命中的认领（ref 为 null = 受理中/死认领窗口）；
 *   duplicate=false 时 entry 为刚写入的认领。
 */
export function claimSubmission(key, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!isValidSubmissionKey(key)) return { duplicate: false, entry: null };
  let result = { duplicate: false, entry: null };
  updateJson(FILE, {}, (cur) => {
    const store = plainStore(cur);
    prune(store, now);
    const hit = store[key];
    if (hit && Number(hit.exp) > now) {
      if (hit.ref || now - Number(hit.at || 0) < RECLAIM_MS) {
        // 命中即不写盘（prune 产生的清理留待下次写入时一并落，避免读路径白白写文件）
        result = { duplicate: true, entry: hit };
        return undefined;
      }
      // 死认领：掉到下面原地复占
    }
    const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS;
    const entry = { at: now, exp: now + ttl, ref: null };
    store[key] = entry;
    result = { duplicate: false, entry };
    return store;
  });
  return result;
}

/**
 * 把副作用结果钉到认领上（runId / msgId）。
 * 认领不存在或已过期时返回 false 且**不补写**——宁缺勿假：补写会让「过期后重试」误判为重复。
 * 已绑定同值时返回 true（幂等），已绑定异值时不覆盖并返回 false。
 */
export function bindSubmission(key, ref, { now = Date.now() } = {}) {
  if (!isValidSubmissionKey(key) || ref === undefined || ref === null || ref === '') return false;
  const value = String(ref);
  let ok = false;
  updateJson(FILE, {}, (cur) => {
    const store = plainStore(cur);
    const hit = store[key];
    if (!hit || Number(hit.exp) <= now) return undefined;
    if (hit.ref) {
      ok = hit.ref === value;
      return undefined;
    }
    hit.ref = value;
    ok = true;
    return store;
  });
  return ok;
}

/** 读全量（测试/诊断用；正常业务路径不需要） */
export function listSubmissions() {
  return plainStore(readJson(FILE, {}));
}

/**
 * 只读查看一条认领（不创建、不写盘）。
 * 用途：P4 busy inbox 的 /start 撞上「同会话运行中」时，先看该 requestId 是否已有既有提交——
 * 已绑定则回放（纯网络重试不该被二次入队），未绑定则按「受理中/死认领」拒绝重跑；
 * 都没有才路由进 inbox。返回过期条目视同不存在（与 claim 的 TTL 语义一致）。
 */
export function peekSubmission(key, { now = Date.now() } = {}) {
  if (!isValidSubmissionKey(key)) return null;
  const hit = plainStore(readJson(FILE, {}))[key];
  if (!hit || Number(hit.exp) <= now) return null;
  return hit;
}

/**
 * 埋点统计的速率与并发保护 —— 纯判定函数。
 *
 * 为什么需要：这个功能对全员开放，没有身份门禁，而单次统计要跑 2 次 LLM
 * 外加至少 2 条扫描**生产库**的聚合查询。一个群里几个人同时问、或者有人连点几次，
 * 就能把共享的生产库拖住 —— 那是别的业务也在用的库。
 *
 * 为什么判定逻辑放在这里而不是写在 feature 里：定时器与 Map 难测，纯函数好测。
 * 状态容器（Map / 计数器）留在 feature.js，本文件只接标量、只回结论。
 *
 * 这是**防滥用的软保护，不是安全边界**：全部内存态，进程重启即清空，不做持久化。
 */

/** 单用户冷却窗口 */
export const COOLDOWN_MS = 60_000;
/** 全局并发上限 —— 生产库同时最多被两条统计链路占用 */
export const MAX_CONCURRENT = 2;

/**
 * 能否放行本次请求。
 *
 * @param {{ lastAtMs?: number|null, running?: number, now: number }} state
 *   lastAtMs=该用户上次**发起**的时刻（从未发起则给 null）；running=当前在跑的统计数
 * @param {{ cooldownMs?: number, maxConcurrent?: number }} [opts]
 * @returns {{ ok: boolean, reason: 'cooldown'|'busy'|null, waitMs: number }}
 */
export function checkThrottle({ lastAtMs, running = 0, now }, { cooldownMs = COOLDOWN_MS, maxConcurrent = MAX_CONCURRENT } = {}) {
  // 冷却先判、并发后判：连点是最常见的情形，先给出「还要等 N 秒」这种可行动的答复；
  // 反过来先判并发的话，连点的人会拿到一句「别人正在跑」，与他自己的行为对不上。
  const last = Number(lastAtMs);
  if (Number.isFinite(last)) {
    const elapsed = now - last;
    if (elapsed < cooldownMs) {
      // elapsed 可能为负（系统时钟回拨），此时若直接用 cooldownMs - elapsed，
      // 用户会被锁上远超一分钟的时间且毫无解释。封顶到一个完整冷却窗口。
      return { ok: false, reason: 'cooldown', waitMs: Math.min(cooldownMs, cooldownMs - elapsed) };
    }
  }
  if (Number(running) >= maxConcurrent) {
    return { ok: false, reason: 'busy', waitMs: 0 };
  }
  return { ok: true, reason: null, waitMs: 0 };
}

/**
 * 被拒时的回话文案。
 *
 * 必须回话、不能静默丢弃：用户发了指令却什么都没收到，第一反应是「机器人死了」，
 * 接着就是再发几遍 —— 恰好把我们想挡的压力又放大一轮。
 * @param {{ reason: string|null, waitMs: number }} d checkThrottle 的返回值
 * @param {number} [maxConcurrent] 用于文案里说明上限
 */
export function buildThrottleReply(d, maxConcurrent = MAX_CONCURRENT) {
  if (d?.reason === 'cooldown') {
    const s = Math.max(1, Math.ceil((d.waitMs || 0) / 1000));
    return `⏳ 埋点统计每人每分钟最多发起一次（单次要跑两轮推理 + 查生产库）。请 ${s} 秒后再试～`;
  }
  return `⏳ 当前已有 ${maxConcurrent} 个埋点统计在跑，生产库是共享资源，先排一会儿～请稍后重发这条指令。`;
}

/**
 * 挑出已过冷却期、可以从状态表里删掉的用户键。
 *
 * 冷却记录本身没有过期机制，Map 会随「历史上问过的人数」单调增长。量级虽小，
 * 但一个常驻进程里的无界 Map 迟早会被人当成泄漏来查 —— 顺手扫掉更省事。
 * @param {Iterable<[string, number]>} entries userId → lastAtMs
 * @returns {string[]}
 */
export function collectExpired(entries, now, cooldownMs = COOLDOWN_MS) {
  const out = [];
  for (const [k, v] of entries || []) {
    if (!Number.isFinite(Number(v)) || now - Number(v) >= cooldownMs) out.push(k);
  }
  return out;
}

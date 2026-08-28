/**
 * 后端可达性判定：把「某个 fetch 挂了」升级成「后端整体不可达」的判断，并驱动掉线罩。
 *
 * 为什么被动触发而不常态心跳：项目已有 /api/req/list(30s)、conv-notify(5s) 等多路轮询，
 * 它们本身就是天然心跳——掉线时必然有一路先失败并上报，用户不操作也能发现。
 * 再加一路专用心跳属于职责重叠。
 *
 * 为什么失败后还要 ping 确认：单个接口 500 / 偶发超时不等于后端死了，直接升罩会把
 * 好端端的后端说成异常。ping /api/ping 是最轻的整体存活判据。
 *
 * 展示层由 armNetworkGuard 注入，本模块不认识 DOM —— 判定规则因此可纯逻辑单测。
 */

const PING_TIMEOUT_MS = 1500; // 与 boot-gate.js 同值：冷启动时端口可能已 accept 但迟迟不响应
const DEFAULT_RETRY_MS = 2000;

let onDown = null;
let onUp = null;
let retryMs = DEFAULT_RETRY_MS;
let state = 'idle'; // idle | confirming | down
let retryTimer = null;
// arm/disarm 的世代号。用来作废「在飞的确认 ping」——否则重置之后旧 ping 落地
// 仍会推进状态机、并调用新注入的 onDown，doc 里承诺的「重复调用会重置」就是假的。
let epoch = 0;

/**
 * 装上判定逻辑并注入展示层。幂等——重复调用会重置状态机（测试依赖这个性质）。
 * @param {{onDown?:()=>void, onUp?:()=>void, retryMs?:number}} deps
 */
export function armNetworkGuard(deps) {
  epoch++; // 作废任何在飞的确认 ping
  onDown = deps?.onDown ?? null;
  onUp = deps?.onUp ?? null;
  retryMs = deps?.retryMs ?? DEFAULT_RETRY_MS;
  state = 'idle';
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/**
 * 显式拆卸：清掉重连定时器并回到未 arm 态。
 *
 * 测试**必须**在 after 钩子里调它。本模块的重连链会自我续期，只要留下一个 pending
 * 定时器就足以让 `node --test` 迟迟不退出乃至永久挂起；而这是顺序依赖的坑
 * （当前恰好靠最后一条用例的 beforeEach 顺手清掉了），连跑多少次都不会暴露。
 */
export function disarmNetworkGuard() {
  armNetworkGuard({});
}

/** 探一次后端存活。__skipGuard 让这次请求本身不再触发上报，否则无限自激。 */
async function pingOnce() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PING_TIMEOUT_MS);
  try {
    const r = await fetch('/api/ping', {
      signal: ac.signal,
      cache: 'no-store',
      __skipGuard: true,
    });
    return !!r?.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 与超时赛跑，保证每次调用必定收敛。
 *
 * AbortController 管不到 bootstrap 包装内部的 `await baseReady`（打包态要等端口就绪）。
 * 那层万一永不 settle，abort 信号也救不了这个 Promise —— state 会永久卡在 confirming，
 * 此后所有上报都被 `state !== 'idle'` 丢弃，守卫**静默死掉且无任何痕迹**。
 * boot-gate.js 对同一层包装留了同款保护（见其 _run 里的 Promise.race），这里必须跟上。
 */
async function ping() {
  return Promise.race([
    pingOnce(),
    new Promise((r) => setTimeout(() => r(false), PING_TIMEOUT_MS + 200)),
  ]);
}

/** 升罩后持续重连，通了就撤罩。 */
function scheduleRetry() {
  const my = epoch;
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    if (my !== epoch || state !== 'down') return; // 已被 arm/disarm 重置
    if (await ping()) {
      if (my !== epoch) return;
      state = 'idle';
      onUp?.();
      return;
    }
    if (my === epoch && state === 'down') scheduleRetry();
  }, retryMs);
}

/**
 * 上报一次网络层失败。由 bootstrap.js 的 fetch 包装调用。
 * confirming / down 期间重复上报直接丢弃：多路轮询会在同一时刻集中失败。
 */
export function reportNetworkFailure() {
  if (!onDown) return; // 尚未 arm：还在启动阶段，由 boot-gate 的启动罩负责
  if (state !== 'idle') return;
  state = 'confirming';
  const my = epoch;
  ping().then((alive) => {
    if (my !== epoch) return; // 期间被 arm/disarm 重置，这次确认作废
    if (alive) {
      state = 'idle'; // 单接口偶发，后端整体是活的
      return;
    }
    state = 'down';
    // 展示层抛异常不能连带掐死重连链：finally 保证 scheduleRetry 一定跑。
    // 否则 state 永久停在 down、后续上报全被丢弃，守卫自我禁用。
    try {
      onDown();
    } finally {
      scheduleRetry();
    }
  });
}

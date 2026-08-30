/**
 * 路由表的匹配与自检 —— 纯逻辑，不碰 req/res，也不引用任何 handler。
 *
 * 为什么单独一个模块：`server.js` 在**模块求值时**就 `server.listen()`
 * （`export const ready` 那个 Promise），测试只要 import 它就会真起一个服务、
 * 占住端口并挂上一堆定时器，`node --test` 都不退出。分发逻辑放在这里，
 * 才能在不起服务的前提下把契约钉住。
 */

/**
 * 从 `startIdx` 起找第一个命中的路由，返回它和它的下标。
 *
 * 三条契约靠这个函数的测试保证，它们回归后的症状都是**静默**的
 * （端点 404 或被错误的 handler 接走），而各 routes-*.test.js 直接调 handler，
 * 压根测不到分发层：
 *   1. 精确匹配必须先于能覆盖它的前缀；
 *   2. `method` 约束必须生效；
 *   3. 某条 handler 回 `false` 后，要能从**它之后**继续匹配（不是从头，否则死循环）。
 *
 * @param {Array<{path?:string, prefix?:string, method?:string}>} routes
 * @param {string} method HTTP 方法
 * @param {string} pathname
 * @param {number} [startIdx]
 * @returns {{route:object, index:number}|null}
 */
export function matchRouteFrom(routes, method, pathname, startIdx = 0) {
  for (let i = startIdx; i < routes.length; i++) {
    const route = routes[i];
    if (route.method && method !== route.method) continue;
    const hit =
      route.path !== undefined ? pathname === route.path : pathname.startsWith(route.prefix);
    if (hit) return { route, index: i };
  }
  return null;
}

/** 前缀路由在方法维度上是否会遮蔽某条精确路由 */
function methodShadows(prefixRoute, exactRoute) {
  if (!prefixRoute.method) return true; // 前缀不限方法 → 遮蔽所有方法
  if (!exactRoute.method) return true; // 精确不限方法 → 至少在该方法上被遮蔽
  return prefixRoute.method === exactRoute.method;
}

/**
 * 找出被前面的前缀路由遮蔽的精确路由。
 *
 * 用途是**启动时自检**：把「新加的端点顺序放错了」从线上静默 404
 * 变成启动即报错。这类错误极难现场排查 —— 端点看着在表里，
 * 请求却被上面某条 `prefix` 抢先接走并按它的语义处理了。
 *
 * @returns {Array<{shadowed:string, by:string}>} 空数组 = 顺序健康
 */
export function findShadowedRoutes(routes) {
  const out = [];
  for (let i = 0; i < routes.length; i++) {
    const exact = routes[i];
    if (exact.path === undefined) continue;
    for (let j = 0; j < i; j++) {
      const before = routes[j];
      if (before.prefix === undefined) continue;
      if (!exact.path.startsWith(before.prefix)) continue;
      if (!methodShadows(before, exact)) continue;
      out.push({
        shadowed: `${exact.method || 'ANY'} ${exact.path}`,
        by: `${before.method || 'ANY'} ${before.prefix}*`,
      });
    }
  }
  return out;
}

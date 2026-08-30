/**
 * 后端 API 调用的样板收敛层。
 *
 * ## 这一层**不做**什么（重要）
 *
 * 不处理网络错误分类、不上报掉线、不改写 Tauri 打包态的相对路径 ——
 * 那些已经由 `bootstrap.js` 里的**全局 fetch 包装**统一负责（分类规则在 net-error.js）。
 * 本模块之上再包一层错误处理只会造成两套语义打架。
 *
 * 也**不统一错误策略**。各调用点的处置是刻意不同的：UI 偏好保存用
 * `.catch(() => {})` 静默失败（localStorage 已有副本），任务操作要弹 toast，
 * 有些拿不到结果就退化成 `{ ok: false }`。把这些强行统一会破坏既有取舍。
 *
 * ## 那它做什么
 *
 * 只消除三样重复了几十次的样板：
 *   1. `headers: { 'Content-Type': 'application/json' }`（全前端 71 处）
 *   2. `body: JSON.stringify(...)`
 *   3. `await r.json()` 以及它在非 JSON 响应上抛错的问题（85 处 `.json()`）
 *
 * 返回 `{ ok, status, data }` 三元组而不是裸 data：57 处调用点判过 `r.ok`，
 * 只返回 body 会把这个信息丢掉，逼调用方退回裸 fetch。
 *
 * ## JSON 解析失败为什么不抛
 *
 * 后端出 500 时可能回 HTML（`serveStatic` 的 404 分支就是纯文本），
 * 此时 `r.json()` 抛的是 SyntaxError —— 调用方的 catch 会把它当成网络故障，
 * 显示成「后端未连接」，而后端明明活着。所以解析失败时 `data` 为 null，
 * 由调用方按 `ok`/`status` 判断，语义不串台。
 */

/**
 * 解析响应体，非 JSON 不抛错。
 * @returns {Promise<any|null>}
 */
async function parseBody(r) {
  // 204 / 空体：.json() 会抛，但这是正常响应，不该被当成解析失败
  if (r.status === 204) return null;
  try {
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * GET 一个 JSON 接口。
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<{ok:boolean, status:number, data:any}>}
 * @throws fetch 的 reject（后端不可达 / 主动 abort）——由调用方决定怎么处置
 */
export async function getJson(url, init) {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status, data: await parseBody(r) };
}

/**
 * 带请求体的方法的公共实现。
 *
 * `init.headers` 会与默认的 Content-Type 合并（调用方的同名键优先），
 * 其余 init 字段原样透传 —— 包括 `__skipGuard`（启动期探测用的旁路标记，
 * 见 net-error.js）与 `signal`。
 *
 * body 为 undefined 时既不带请求体、也不带 Content-Type ——
 * 无体请求（典型是 DELETE）声明一个 JSON 体的类型是误导。
 */
async function sendJson(method, url, body, init = {}) {
  const { headers, ...rest } = init;
  const hasBody = body !== undefined;
  const r = await fetch(url, {
    method,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(headers || {}),
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
    ...rest,
  });
  return { ok: r.ok, status: r.status, data: await parseBody(r) };
}

/**
 * POST 一个 JSON 接口。
 * @param {string} url
 * @param {any} body 会被 JSON.stringify；传 undefined 则不带请求体
 * @param {RequestInit} [init]
 * @returns {Promise<{ok:boolean, status:number, data:any}>}
 */
export function postJson(url, body, init) {
  return sendJson('POST', url, body, init);
}

/** PUT 一个 JSON 接口（bots / credentials / mcp-servers / actions 的更新都走 PUT）。 */
export function putJson(url, body, init) {
  return sendJson('PUT', url, body, init);
}

/** DELETE 一个接口。默认无请求体，故不带 Content-Type。 */
export function delJson(url, init) {
  return sendJson('DELETE', url, undefined, init);
}

/**
 * 「发出去就不管」的 POST —— 网络失败与非 2xx 一律静默。
 *
 * 独立成函数而不是让调用方写 `.catch(() => {})`：全前端有十几处这种调用
 * （UI 偏好保存、乐观清除的确认、埋点式上报），它们的共同点是
 * **失败不影响用户正在做的事**，且本地已有副本或可下次重试。
 * 有了具名函数，「这里的静默是刻意的」就不需要每处都写一遍注释。
 *
 * @returns {Promise<boolean>} 是否成功（需要时可判，忽略也无妨）
 */
export async function postJsonQuiet(url, body, init) {
  try {
    const { ok } = await postJson(url, body, init);
    return ok;
  } catch {
    return false;
  }
}

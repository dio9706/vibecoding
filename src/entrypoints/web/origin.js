/**
 * 跨源来源裁决 —— 把 CORS 从 `Access-Control-Allow-Origin: *` 收窄为白名单。
 *
 * 为什么必须收窄：`*` 的风险不是「外网能不能访问」（host 恒为 127.0.0.1，外网本来就进不来），
 * 而是**用户浏览器里任意一个标签页**都能 `fetch('http://127.0.0.1:<port>/api/settings/export')`
 * 并读到响应体 —— 明文 token 与飞书 appSecret 直接外泄。绑回环挡不住浏览器内的跨源读取。
 *
 * 放行面必须覆盖三种真实来源，改窄任何一条都会把桌面版锁死：
 *   1. 打包 release：webview 源为 tauri.localhost，跨源打 http://127.0.0.1:<动态端口>
 *   2. tauri dev（devUrl=127.0.0.1:9701）/ PM2 web（:3000）：同源，但同源 POST 仍会带 Origin
 *   3. 浏览器直访 localhost
 * 端口不固定（sidecar 端口冲突时 9701 自增，PM2 走 3000），故按「回环主机 + 任意端口」放行，
 * 而不是钉死 config.web.port。
 */

/** 回环主机名全集（IPv6 经 WHATWG URL 解析后 hostname 带方括号） */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Tauri webview 的源：Windows 走 http(s)://tauri.localhost，macOS/Linux 走自定义协议 */
const TAURI_ORIGINS = new Set([
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
]);

/**
 * 该 Origin 是否属于白名单。
 * 必须用 URL 解析后比对 hostname 全等，不能用 includes/startsWith ——
 * 否则 `http://127.0.0.1.evil.com`、`http://tauri.localhost.evil.com` 这类后缀混淆域名可绕过。
 */
export function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  if (TAURI_ORIGINS.has(origin)) return true;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false; // 'null'（sandbox iframe / file://）与畸形值都落这里
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return LOOPBACK_HOSTS.has(u.hostname);
}

/**
 * 请求级裁决。
 * - 无 Origin 头 → 放行且不回 ACAO：非浏览器发起（curl / server-to-server 的 /internal/notify）
 *   或同源导航，本就不受 CORS 约束，回 ACAO 无意义。
 * - 白名单源 → 放行并**回显该源**（绝不能回 `*`，否则等于没收窄）。
 * - 其余 → 判负，调用方直接 403。注意：不能只靠「不回 ACAO 让浏览器读不到」，
 *   因为简单请求（text/plain 的 POST）不触发预检，服务端副作用已经发生 → CSRF。
 */
export function checkOrigin(origin) {
  if (!origin) return { ok: true, allowOrigin: null };
  if (isAllowedOrigin(origin)) return { ok: true, allowOrigin: origin };
  return { ok: false, allowOrigin: null };
}

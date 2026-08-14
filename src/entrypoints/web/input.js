/**
 * 请求输入卫生 —— HTTP 边界层的类型归一与白名单。
 * 原则：**fail-closed**，任何非法/意外输入都降级到最严格的安全值，而不是抛错或透传。
 */

/**
 * 权限档白名单。
 * 这个值会原样落到 Claude Agent SDK 的 permissionMode（run-claude.js），
 * 其中 'bypassPermissions' = 免审批执行任意工具。因此绝不能透传请求体里的字符串：
 * 攻击者（或前端 bug）传任意值时，必须降级到最严格的 'default'（逐次询问）。
 */
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);

/** 归一权限档：白名单内原样保留，其余一律降级 'default'。非字符串不抛异常。 */
export function normalizeMode(raw) {
  if (typeof raw !== 'string') return 'default';
  const v = raw.trim();
  return PERMISSION_MODES.has(v) ? v : 'default';
}

/**
 * 请求体字段归一为 trim 后的字符串；非字符串一律归空串。
 *
 * 替代散落各处的 `(data.X || '').trim()` —— 那个写法在 body 传 `{"runId":123}` 时
 * 抛 `(123).trim is not a function`，且异常发生在 req 的 'end' 监听器里，
 * 没有任何 try/catch 接住 → uncaughtException → **进程退出**（已实机复现）。
 * runs 是纯内存的，一次崩溃 = 所有在跑的 Claude 任务全灭，所以这条必须无死角。
 *
 * 用 `typeof === 'string'` 而不是鸭子类型判 `.trim`：后者会被
 * `Object.create(String.prototype)` 这类对象骗过。
 */
export function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 解码 URL 路径段中的资源 id，畸形输入返回 null 而不是抛异常。
 *
 * 替代 routes-settings.js 里 7 处裸 `decodeURIComponent(url.pathname.slice(...))` ——
 * `PUT /api/bots/%` 会抛 URIError: URI malformed，抛在 http request 监听器主体里
 * → uncaughtException → **进程退出**（已实机复现）。
 * 注意 `new URL('http://x/api/bots/%').pathname` 确实保留字面 `%`，所以这条路径真实可达。
 */
export function safeDecodeId(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

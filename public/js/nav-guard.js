/** 外链归属判定：区分「应用内部资源」与「该丢给系统浏览器的外链」。 */

/**
 * hostname 是否属于应用内部 / 本机。
 *
 * `.localhost` 子域必须整体放行：Windows 与 Android 上 Tauri v2 把内部协议
 * 映射成 http://<scheme>.localhost（tauri.localhost = 应用页面本身，
 * asset.localhost / ipc.localhost = 资源与 IPC 通道），scheme 已经是 http，
 * 光比对 'localhost' 会把应用首页误判成外链。macOS 那边是 tauri://localhost，
 * 不走这条判断，所以这个坑只在 Windows 打包版暴露。
 *
 * 放行整个 `.localhost` 后缀不扩大攻击面：该 TLD 由 RFC 6761 保留，
 * 无法在公网注册，解析结果恒为回环地址。
 */
export function isInternalHost(hostname) {
  return hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname.endsWith('.localhost');
}

/**
 * 该 URL 是否应交给系统浏览器打开（而非在 WebView 内导航）。
 * 仅接管 http/https：mailto / blob / data 等交还浏览器默认行为。
 *
 * Rust 侧 src-tauri/src/main.rs 的 is_internal_host 是同一套规则的第二道防线，
 * 两边改动需保持一致。
 */
export function shouldOpenExternally(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return !isInternalHost(url.hostname);
}

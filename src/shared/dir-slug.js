/**
 * 工程目录 → 稳定 slug。存储层用它给「按工程归属」的数据算文件名。
 *
 * 为什么住在 shared 而不是某个 entrypoint：
 * 这原本长在 `entrypoints/web/req-uispec.logic.js` 里，而 `store/ui-specs.js` 要用它算路径 ——
 * 于是形成 `store → entrypoints` 的**分层倒挂**（最底层依赖最上层）。
 * 它本身只是个零依赖纯函数，跟 web 入口没有任何关系，放这里才对。
 * 那个文件保留的是真正属于它的东西：还原/草稿的 prompt 构造。
 */

/** 目录路径规范化：反斜杠转正斜杠、去末尾分隔符。Windows 下同一目录有多种写法。 */
function normDir(dir) {
  return String(dir ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .trim();
}

/** FNV-1a 32 位哈希 → 6 位 base36。够短、够稳、无依赖。 */
function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(6, '0').slice(-6);
}

/**
 * 工程目录 → 存储文件名 slug：`<清洗过的目录尾段>-<路径短哈希>`。
 * 带哈希是因为前后端仓库都叫 web 是常态，只取尾段会让两个项目共用一份数据。
 */
export function dirSlug(dir) {
  const norm = normDir(dir);
  const tail = norm.split('/').filter(Boolean).pop() || '';
  const clean = tail
    .replace(/[^A-Za-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${clean || 'root'}-${shortHash(norm)}`;
}

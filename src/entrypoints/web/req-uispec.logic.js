/**
 * UI 规范纯逻辑 —— 工程目录 → 存储 slug / 还原 prompt / 规范草稿 prompt（单测目标，零 IO）。
 *
 * 规范是**项目级**的（按工程目录归属），但不写进用户工程目录——那是别人的仓库，
 * 落 APP_DATA_DIR/ui-specs/<dirSlug>.md，还原时把全文注入 prompt（见 spec §3.2）。
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
 * 带哈希是因为前后端仓库都叫 web 是常态，只取尾段会让两个项目共用一份规范。
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

/**
 * 按 UI 规范还原某个页面的 prompt。规范为空时不能假装有规范——
 * 改口径为「对齐现有代码风格」并显式说明未配置，否则模型会凭空编一套 token 出来。
 */
export function buildRestorePrompt({ page, specText }) {
  const url = page?.figma?.url;
  if (!url) throw new Error('该页面尚未挂载设计稿，无法还原');
  const node = page?.figma?.node ? `（节点 ${page.figma.node}）` : '';
  const spec = String(specText ?? '').trim();

  const specPart = spec
    ? `本项目 UI 规范全文（**优先级高于设计稿**，下称「规范」）：\n---\n${spec}\n---\n`
    : `本项目**尚未配置 UI 规范**。请对齐工程内现有同类组件的写法，不要自创一套样式体系。\n`;

  return (
    `请按设计稿还原页面「${page.name}」的视觉实现。\n\n` +
    `设计稿：${url}${node}\n` +
    `目标文件：${page.file || '（按页面名在工程内定位）'}\n\n` +
    specPart +
    `\n还原要求：\n` +
    `1. 组件一律用规范指定的那个，不要自己写裸标签或自造弹框。\n` +
    `2. 圆角、间距、字号、颜色一律回落到规范的档位，不要从设计稿里量像素直接抄。\n` +
    `3. 只改视觉，**不要动已经实现的业务逻辑**。\n` +
    `4. 设计稿与规范**冲突**时按规范落地，并在回复末尾用「⚠ 冲突」列出每一处：\n` +
    `   设计稿是什么、规范是什么、你按哪个落的。这些要由人来裁决，不要自行决定后就不提。`
  );
}

/** 从工程现有代码 + 设计稿抽一份 UI 规范草稿，供用户确认后落盘。 */
export function buildSpecDraftPrompt({ dir }) {
  return (
    `请通读工程 ${dir} 的现有页面与公共组件，抽出这个项目**实际在用**的 UI 规范，产出一份草稿供人确认。\n\n` +
    `要覆盖：字体（正文/辅助/标题/数字的字号行高字重）、圆角与间距档位、\n` +
    `组件约定（弹框/输入框/下拉/按钮/表格/空态各自该用哪个组件、什么尺寸）、禁止项。\n\n` +
    `只统计**重复出现**的写法，一次性的特例不要写进规范。每条都要能直接指导实现，不要写「保持一致」这种空话。\n\n` +
    `输出契约：只输出 markdown 正文，不要开场白，不要代码围栏包裹整篇。用二级标题分组。`
  );
}

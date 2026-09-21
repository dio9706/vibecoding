/**
 * UI 规范纯逻辑 —— 还原 prompt / 规范草稿 prompt（单测目标，零 IO）。
 *
 * 规范是**项目级**的（按工程目录归属），但不写进用户工程目录——那是别人的仓库，
 * 落 APP_DATA_DIR/ui-specs/<dirSlug>.md，还原时把全文注入 prompt（见 spec §3.2）。
 *
 * `dirSlug` 已移到 `shared/dir-slug.js`：它是存储层算文件名要用的纯函数，
 * 留在这里会让 `store/ui-specs.js` 反向依赖 web 入口（分层倒挂）。
 */

/**
 * 按 UI 规范还原某个页面**某一张设计稿**的 prompt。规范为空时不能假装有规范——
 * 改口径为「对齐现有代码风格」并显式说明未配置，否则模型会凭空编一套 token 出来。
 *
 * 同页多张稿是逐条还原的，固有风险是后一轮把前一轮覆盖掉，所以要把同页其他状态名带进来做护栏。
 * **只给名字不给链接**：给了链接模型会一次把所有状态都做掉，逐条还原就失去意义了。
 *
 * @param {object} opts.page - 页面节点（用 name / file / figmas）
 * @param {object} opts.figma - 本轮要还原的那一条 `{ id, url, label }`
 * @param {string} opts.specText - 项目 UI 规范全文，可空
 */
export function buildRestorePrompt({ page, figma, specText }) {
  const url = String(figma?.url ?? '').trim();
  if (!url) throw new Error('该页面尚未挂载设计稿，无法还原');
  const label = String(figma?.label ?? '').trim();
  const scope = label ? `的【${label}】` : '的';
  const spec = String(specText ?? '').trim();

  const others = (Array.isArray(page?.figmas) ? page.figmas : [])
    .filter((f) => f && f.id !== figma?.id)
    .map((f) => String(f?.label ?? '').trim() || '未命名状态');
  const guard = others.length
    ? `⚠ 本页还有其他状态的设计稿：${others.join('、')}。这些状态共用同一个组件实现，因此：\n` +
      `  不要把组件写死成只有当前这一个状态；不要改动其他状态已有的实现。\n\n`
    : '';

  const specPart = spec
    ? `本项目 UI 规范全文（**优先级高于设计稿**，下称「规范」）：\n---\n${spec}\n---\n`
    : `本项目**尚未配置 UI 规范**。请对齐工程内现有同类组件的写法，不要自创一套样式体系。\n`;

  return (
    `请按设计稿还原页面「${page.name}」${scope}视觉实现。\n\n` +
    `设计稿：${url}\n` +
    `目标文件：${page.file || '（按页面名在工程内定位）'}\n\n` +
    guard +
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

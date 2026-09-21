/**
 * 设计稿精确还原开关的纯逻辑 —— 零 DOM，供 chat.js 调用、node --test 直测。
 *
 * 链路：输入框左侧 ICON → chat.js 会话级状态 chatFigmaRestore →
 * send() 新建 run 时经 decorateFigmaRestore 给 prompt 追加还原指令段 →
 * 模型依次走 figma-precise-restore skill / download_assets / 上传 CLI。
 * 气泡、记忆库、会话记录都存用户原文，指令段只进 prompt；插话路径不装饰。
 *
 * 设计依据：docs/superpowers/specs/2026-09-16-composer-figma-restore-design.md
 */

const CLAUDE_PROVIDER = 'claude-agent';

/** Figma 链接四种路径形态。fileKey 取 22~128 位字母数字，与 figma MCP 工具的
 *  fileKey pattern 一致；协议后紧跟 figma.com，故 evil-figma.com 之类不会误判。 */
export const FIGMA_URL_RE =
  /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|board|slides)\/[A-Za-z0-9]{22,128}/i;

/** 上传 CLI 所在项目。单机单工具，改路径改这里（spec 决策 5：不做设置项）。 */
export const OSS_TOOL_PATH = 'C:/Users/DELL/Desktop/web-image-oss-manage';

export function hasFigmaUrl(text) {
  return FIGMA_URL_RE.test(String(text || ''));
}

/** 追加在用户原文之后的执行说明。
 *  放在原文之后而非之前（与 ultracode 的前缀相反）：这段是给模型的执行说明，
 *  排在用户诉求之后更符合阅读顺序。整个功能的成败全在这段措辞。 */
export function buildRestoreDirective() {
  return [
    '---',
    '【设计稿精确还原 · 自动资源管线】',
    '1. 使用 figma-precise-restore skill 提取节点原始属性，不要靠截图猜样式。',
    '2. 资源导出只用 download_assets 的 rawImages 与 svgAssets。',
    '   禁止使用 export —— 它渲染整个节点，会把页面背景一起烤进图里，',
    '   产出的带背景切图在生产中不可用（与周围元素差 1px 就露出接缝）。',
    '   若某资源只能从 export 取到，说明选错了节点：用 get_metadata 往下',
    '   找到纯图形的叶子节点，而不是包含背景的容器。',
    '3. 按设计稿标注尺寸的 2x 导出，不要直传原始素材（常有 2000px+）。',
    '4. 给每个资源起符合语义的英文 kebab-case 名（如 hero-banner、icon-expert-badge），',
    '   不要沿用 Figma 图层名或哈希名。',
    '5. 执行 `git rev-parse --abbrev-ref HEAD` 取当前分支，作为 OSS 目录。',
    `6. 上传：node "${OSS_TOOL_PATH}/bin/upload.mjs" --prefix="<分支名>" <文件...>`,
    '7. 上传后必须逐条检查返回的 JSON，这一步不可省略：',
    '   - ok 为 false，或任何条目 status 为 rejected / failed → 停下来，按该条的',
    '     reasons 重新导出这个资源再传。不要跳过、不要用占位色块顶替，',
    '     更不可声称「资源全部上传完成」。',
    '   - 不要用 --allow-opaque 绕过 rejected —— 那是给整块不透明 banner 的例外，',
    '     不是用来让带背景的切图蒙混过关的。',
    '   - status 为 skipped 表示同名已存在，改名重传。',
    '   - 输出不是 JSON（例如异常堆栈）→ 原样报告给用户，不要继续写代码。',
    '8. 代码里引用上传后返回的 OSS URL，不要引用本地路径。',
  ].join('\n');
}

/**
 * 开着 + 走 Claude provider + 文本含 Figma 链接，三者同时成立才装饰。
 * provider 守卫同 decorateUltracode：openai-compat 那边没有 figma MCP 也没有 skill 机制，
 * 拼了只会让别家模型困惑。
 */
export function decorateFigmaRestore(text, { on, provider }) {
  if (!on || provider !== CLAUDE_PROVIDER) return text;
  if (!hasFigmaUrl(text)) return text;
  return `${text}\n\n${buildRestoreDirective()}`;
}

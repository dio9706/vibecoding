# 输入框「设计稿精确还原」开关设计

**日期:** 2026-09-16
**作者:** AI + User
**版本:** 1.0

---

## 需求概述

**痛点：** 按 Figma 设计稿还原 UI 时，稿里的位图 / 图标资源目前靠人工处理——用户自己在 Figma 里切图、自己想文件名、自己传 OSS、再把 URL 贴回代码。`figma-precise-restore` skill 的流程图里那一步 `Has image/SVG assets? → yes → Ask user to provide image files` 就是这个断点：样式能自动精确还原，资源却必须人工接力。

**目标：** 在输入框左侧加一个可激活的 ICON。激活状态下发送含 Figma 链接的消息时，自动给 prompt 拼上一段还原指令，让模型一口气跑完「取原始属性 → 导出资源 → 语义命名 → 传 OSS → 写代码引用」，人不再中途接力。

**范围（一期）：** 只做「输入框 ICON + 会话级开关 + prompt 装饰 + OSS 上传 CLI」。不做截图比对闭环，不动需求地图那条既有还原链路。

---

## 关键决策（已拍板）

### 决策 1：流水线由模型自己跑，不做后端管线

前端只负责「意图声明 + prompt 装饰」，导出 / 命名 / 上传全部由模型在会话里依次执行。

**理由：** figma MCP 是 Claude Code 侧的工具，Principal 后端进程访问不到它——做成后端管线就得自己配 Figma REST token 再把取图逻辑重写一遍，凭空多一套要维护的东西。而且「看图起语义名」这一步，模型本身就是那个 LLM，交给它是零成本的。

**连带后果：** 本功能在服务端**零新增路由、零新增 store 字段**，与 `ultracode` 同构。

### 决策 2：激活 + 含 Figma 链接才装饰，不上 LLM 意图识别

判定是纯正则：文本里匹配到 `figma.com/(design|file|board|slides)/...` 就装饰。

**理由：** ICON 亮着本身已经是一层明确的意图声明，链接是第二层确定性信号，双重信号下误判率极低。再叠一次 LLM 分类是过度设计（YAGNI），而且慢、烧额度、结果不确定。

激活但没贴链接时**原样发送** + toast 提示「未检测到设计稿链接」——不静默吞掉，也不拦截发送。

### 决策 3：OSS 目录 = 当前分支名原样保留，斜杠做多级目录

`req/mu3hacnn8y0l-6-1-专家升级` → key 前缀 `images/resource/webp/req/mu3hacnn8y0l-6-1-专家升级/`。

**理由：** 无损、可逆、目录结构与分支结构天然对应，`req/` 下一眼看尽所有需求。中文 key 在 OSS 合法，访问时 `encodeURIComponent` 即可——`compass-agent` 的 `public-recipe` 按菜名存图（`oss_service.py:build_public_recipe_thumb_url`）已是同样做法，不是新发明。

### 决策 4：上传 CLI 落在 `web-image-oss-manage`，不落 Principal

新增 `web-image-oss-manage/bin/upload.mjs`，复用该项目已有的 `server/oss.js` 与 `server/convert.js`。

**理由：**

- 这两个模块**都不依赖 express**（`oss.js` 只 import `ali-oss` + `config.js`，`convert.js` 只 import `sharp`），CLI 直接 import 即可，是纯增量，不改现有任何一行（OCP）。
- OSS AK/SK 已在该项目 `.env` 里。落 Principal 就得把凭证复制到第二处——Principal 是通用平台，不该被 kxmall 的 OSS 凭证污染（SRP）。
- png→webp 转换、文件名净化、同名检测全都现成，重写一遍是纯重复（DRY）。

### 决策 5：工具路径写死常量，不做设置项

`figma-restore.logic.js` 顶部一个 `OSS_TOOL_PATH` 常量。

**理由：** 单机单工具，为它加一套设置项 UI + store 字段 + 前端表单是过度设计（YAGNI）。改路径改常量即可，成本一行。

### 否决的替代方案

| 方案 | 否决理由 |
|---|---|
| 后端 `src/plugins/figma-assets/` 插件 + API 路由 | Principal 后端拿不到 figma MCP，得自己配 Figma REST token 重写取图逻辑；换来的可重试 / 可审计在单机单用户场景下价值不足以抵消这份成本 |
| 激活即无条件装饰 prompt | 忘关开关时随口问一句别的也会被拼上一大段还原指令，污染对话 |
| 分支名转纯 ASCII slug | 丢掉中文后「这个目录是哪个需求」要靠猜；两个只差中文的分支还会撞名 |
| 上传脚本放 Principal `scripts/` | OSS 凭证要复制进 Principal `.env`，且 webp 转换逻辑要重写一份 |

---

## 组件清单

| # | 文件 | 动作 | 职责 |
|---|---|---|---|
| 1 | `public/js/figma-restore.logic.js` | 新建 | 纯逻辑零 DOM：链接判定 + prompt 装饰 |
| 2 | `public/js/figma-restore.logic.test.js` | 新建 | `node --test` 直测 |
| 3 | `public/js/icons.js` | 定点 Edit | 新增 `FIGMA_RESTORE_ICON_SVG` |
| 4 | `public/index.html` | 定点 Edit | `footer.composer` 内 `#prompt` 前插按钮 |
| 5 | `public/app.css` | 定点 Edit | `.composer-icon-btn` 亮 / 灭态 |
| 6 | `public/js/chat.js` | 定点 Edit | 会话级状态 + 快照 + 切会话还原 + `send()` 接装饰 |
| 7 | `web-image-oss-manage/bin/upload.mjs` | 新建 | 上传 CLI，输出 JSON URL 清单 |
| 8 | `web-image-oss-manage/package.json` | 定点 Edit | 加 `"upload"` script |

1–6 全部对标 `ultracode.logic.js` + `chat.js` 的既有会话级开关模式，不发明第二套机制。

---

## 前端纯逻辑（`public/js/figma-restore.logic.js`）

对标 `ultracode.logic.js`：零 DOM、可被 `node --test` 直接 import。

```js
/** Figma 链接：design / file / board / slides 四种路径形态 */
export const FIGMA_URL_RE =
  /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|board|slides)\/[A-Za-z0-9]{22,128}/i;

export const OSS_TOOL_PATH = 'C:/Users/DELL/Desktop/web-image-oss-manage';

export function hasFigmaUrl(text) { ... }

/** 开着 + 走 Claude provider + 文本含 Figma 链接，三者同时成立才装饰 */
export function decorateFigmaRestore(text, { on, provider }) { ... }

export function buildRestoreDirective() { ... }  // 供测试断言指令段内容
```

**provider 守卫的理由与 `decorateUltracode` 一致**：`openai-compat` 那边没有 figma MCP 也没有 skill 机制，拼了只会让别家模型困惑。

### 装饰后的 prompt 形态

用户原文在前，指令段追加在后（与 ultracode 的前缀相反——这段是给模型的执行说明，放在用户诉求之后更符合阅读顺序）：

```
<用户原文，含 Figma 链接>

---
【设计稿精确还原 · 自动资源管线】
1. 使用 figma-precise-restore skill 提取节点原始属性，不要靠截图猜样式。
2. 设计稿中的位图 / 图标资源，用 download_assets 导出（rawImages + svgAssets）。
3. 给每个资源起符合语义的英文 kebab-case 名（如 hero-banner、icon-expert-badge），
   不要沿用 Figma 图层名或哈希名。
4. 执行 `git rev-parse --abbrev-ref HEAD` 取当前分支，作为 OSS 目录。
5. 上传：node "<OSS_TOOL_PATH>/bin/upload.mjs" --prefix="<分支名>" <文件...>
   命令输出 JSON URL 清单；标记 skipped 的说明同名已存在，请改名重传。
6. 代码里引用上传后返回的 OSS URL，不要引用本地路径。
```

> 这段措辞是整个功能的成败所在——模型的行为完全由它决定。一期先按此版本落地，跑几次真实还原后按实际表现再调。

---

## 前端接线（`chat.js`）

与 `chatUltracode` 完全同款，逐条对应：

| ultracode 的做法 | 本功能对应 |
|---|---|
| `chatUltracode` 会话级变量，刻意不落 localStorage（`chat.js:141`） | `chatFigmaRestore`，同样不落 localStorage：新会话永远从关开始 |
| 每条消息快照 `c.ultracode`（`chat.js:797` / `839`） | 快照 `c.figmaRestore` |
| 切会话时从 `prefs` 还原（`chat.js:3183`） | 同址还原，缺字段视为关 |
| `send()` 里经 `decorateUltracode` 装饰（`chat.js:2163`） | 同址经 `decorateFigmaRestore` 装饰 |
| 前缀只进 prompt，气泡 / 记忆库存原文 | 同左——指令段绝不进气泡与记忆库，否则污染语料 |

**新增一条 ultracode 没有的分支：** 开关亮着但文本无 Figma 链接时，`decorateFigmaRestore` 原样返回，且 `send()` 弹一次 toast「未检测到设计稿链接，本条按普通消息发送」。不拦截发送。

**插话路径不装饰**，与 ultracode 同理由。

---

## ICON 与样式

素材：`C:\Users\DELL\Downloads\scc 超级计算集群.svg`（iconfont 导出，1024 viewBox，单 path）。

按 `icons.js` 文件头已写死的约定处理：剥掉 XML 声明 / DOCTYPE / `t` / `class` / `p-id`，**去掉 path 上写死的 `fill="#2B85FB"`**，改 `fill="currentColor"`，尺寸 `1em`。

```js
/** 设计稿精确还原（超算集群）。 */
export const FIGMA_RESTORE_ICON_SVG =
  '<svg viewBox="0 0 1024 1024" width="1em" height="1em" fill="currentColor" aria-hidden="true">' +
  '<path d="M637.952 256l-108.544-64..."/>' +
  '</svg>';
```

HTML —— 插在 `#prompt` 之前（`.composer` 是 `display:flex; align-items:flex-end`，按钮自然落在左侧、与发送按钮同底基线）：

```html
<footer class="composer">
  <button class="composer-icon-btn" id="figmaRestoreBtn"
          title="设计稿精确还原：贴 Figma 链接自动导出资源、命名、传 OSS"
          aria-pressed="false"></button>
  <div id="prompt" class="composer-input" ...></div>
  ...
</footer>
```

CSS（加在 `app.css` `.composer-input.dragover` 之后，与输入栏样式同区）：

- 尺寸 40×40，`border-radius: 12px`，与 `.composer-input` 的圆角一致
- 灭态：`color: var(--faint)`，无背景
- 亮态（`.on`）：`color: #2B85FB`，`background: rgba(43,133,251,.12)`
- `:hover` 提亮，`aria-pressed` 随状态同步（键盘 / 读屏可感知）

---

## 上传 CLI（`web-image-oss-manage/bin/upload.mjs`）

### 用法

```bash
node bin/upload.mjs --prefix="req/mu3hacnn8y0l-6-1-专家升级" a.png b.svg c.webp
```

`--prefix` 必填；缺失或为空直接报错退出（宁可失败，也不要把资源散落到 bucket 根目录）。

### 输出（stdout 单个 JSON）

```jsonc
{
  "ok": true,
  "prefix": "images/resource/webp/req/mu3hacnn8y0l-6-1-专家升级/",
  "results": [
    { "src": "a.png", "key": "...a.webp", "url": "https://...", "converted": true,  "status": "uploaded" },
    { "src": "b.svg", "key": "...b.webp", "url": "https://...", "converted": true,  "status": "uploaded" },
    { "src": "c.webp","key": "...c.webp", "url": "https://...", "converted": false, "status": "skipped", "reason": "同名已存在" }
  ]
}
```

模型解析这个 JSON 拿 URL 写进代码；`skipped` 的自行改名重传。

### 实现要点

- **前缀拼接**：`CATEGORIES['webp-image'].prefix` + `--prefix` + `/`，复用配置而非写死字符串。
- **中文目录必须保住**：`convert.js:toWebpName` 会把非 `[A-Za-z0-9._-]` 的字符打成 `-`，但它**只作用于 `basename`**。目录前缀由 `--prefix` 原样拼接、不经该函数——这条边界一旦破坏，中文分支目录就会变成一串连字符。
- **`.svg` 按 2x 密度转 webp**：`download_assets` 的 `svgAssets` 是图标类矢量图，统一转 webp 后与位图落同一目录，跟团队「逐步迁移到 webp」的方向一致（`CATEGORIES.svg` 的 `upload: false` 就是这个迁移的痕迹）。

  实现落在 `upload.mjs` **自己的** `svgToWebp()` 里，**不去扩展 `convert.js` 的 `CONVERTIBLE_EXTS`**——那会让 web UI 拖入 svg 的行为从「报 `UNSUPPORTED_TYPE`」变成「静默转换」，是对共享模块的行为变更，越出了决策 4「纯增量」的承诺。CLI 自己的需求自己满足（OCP）。

  sharp 渲染 svg 走 librsvg，`density` 单位 DPI、默认 72，取 `{ density: 144 }` 即 2x。超过 2x 的展示场景会糊，图标尺寸下碰不到。
- **同名不覆盖**：复用现成的 `exists(key)`，命中则 `status: "skipped"`。避免误覆盖同分支下已有资源。
- **「没有则新建」无需代码**：OSS 是扁平 key 空间，`put('a/b/c.webp', ...)` 自动就有了 `a/b/`。不写目录存在性检查。
- **错误处理**：单个文件失败不中断整批，该条记 `status: "failed"` + `reason`，最后 `ok` 取决于是否**全部**失败。

---

## 测试

| 文件 | 用例 |
|---|---|
| `public/js/figma-restore.logic.test.js` | 开 + Claude provider + 含链接 → 追加指令段；开但无链接 → 原样返回；关 → 原样返回；`openai-compat` provider → 原样返回；`figma.com/design`、`/file`、`/board` 三种形态都能识别；非 figma 域名的相似串不误判；指令段含 `OSS_TOOL_PATH` 与 `--prefix` |

验证命令：`npm test`（Principal 侧）。

`upload.mjs` 不写自动化测试——它的行为依赖真实 OSS 凭证与网络，mock 掉 `oss.js` 后剩下的只有参数拼接，价值低于维护成本。改为一次性人工验证，逐条确认：

1. 一张 png + 一个 svg，`--prefix="req/测试-中文分支"` 跑一次
2. OSS 控制台里目录层级为 `images/resource/webp/req/测试-中文分支/`，**中文没被打成连字符、没变乱码**
3. svg 产物是 webp 且在图标尺寸下清晰（2x 生效）
4. 重跑同一条命令，两个文件都返回 `status: "skipped"`
5. 返回的 URL 直接粘进浏览器能打开

> **第 2 条是本功能最可能出问题的地方。** Windows + Git Bash 传中文命令行参数给 node 存在编码退化的先例（本机已有 `U+0085`/`U+2028` 经工具链静默变成空格的记录）。若实测中文目录变乱码，兜底是让模型改传 base64 编码的 prefix，CLI 侧解码——但**先实测，不要预先加这层复杂度**。

---

## 非目标（YAGNI）

- **不做**小程序自动测试截图比对闭环——用户已明确划到二期。
- **不做** LLM 意图识别——ICON + 链接双重信号已足够。
- **不做**上传记录落 store / 审计面板——CLI 的 JSON 输出即回执。
- **不做**设置项配置工具路径——常量足够。
- **不动**需求地图的 `buildRestorePrompt` 链路——两条入口并行，互不干扰。
- **不做**分支合并后的资源迁移 / 清理——分支目录即最终位置，不是暂存区。

---

## 二期预留（本次不实现）

还原完成后调用小程序自动测试能力截图，与 Figma 稿比对，不一致则继续修正，直到视觉一致。届时需要确认的问题：截图从哪来（小程序开发者工具 CLI / 真机）、比对用像素 diff 还是模型看图判断、修正循环的终止条件。

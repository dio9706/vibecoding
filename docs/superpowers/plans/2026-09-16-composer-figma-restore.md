# 输入框「设计稿精确还原」开关 实现计划

> **给执行代理：** 必需子技能——用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。

**目标：** 在输入框左侧加一个可激活的 ICON，激活状态下发送含 Figma 链接的消息时自动追加还原指令，让模型一口气跑完「取原始属性 → 导出资源 → 语义命名 → 传 OSS → 写代码引用」。

**架构：** 前端只做「意图声明 + prompt 装饰」，完全对标既有的 `ultracode` 会话级开关（纯逻辑抽到 `*.logic.js` 零 DOM、`node --test` 直测）。服务端零改动。资源上传复用 `web-image-oss-manage` 已有的 `oss.js` / `convert.js`，新增一个 CLI 入口，OSS 凭证不出原项目。

**技术栈：** 原生 ES Module 前端（无构建）、`node --test`、`ali-oss`、`sharp`。

**设计依据：** `docs/superpowers/specs/2026-09-16-composer-figma-restore-design.md`

---

## ⚠️ 两条全局约束

**1. 不做 git 提交。** 本项目 `CLAUDE.md` 明确「不自动 git 提交，改动留工作区，提交时机由维护者掌控」。本计划因此**移除了所有 commit 步骤**——这是用户指令，优先级高于 TDD 工作流的默认约定。每个任务结束时改动留在工作区即可。

**2. 行号会漂。** 本仓库工作区常有未提交的 WIP，`chat.js` 等文件的行号随时变动。**计划中给出的行号只是定位线索，每次 Edit 前必须先 Read 确认上下文**，用文中给出的「锚点代码」去匹配，而不是认行号。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `public/js/figma-restore.logic.js` | 新建 | 纯逻辑：链接判定 + 指令段构造 + prompt 装饰。零 DOM |
| `public/js/figma-restore.logic.test.js` | 新建 | 上述逻辑的单测 |
| `public/js/icons.js` | 追加 | `FIGMA_RESTORE_ICON_SVG` 常量 |
| `public/index.html` | 插入 1 处 | `footer.composer` 内 `#prompt` 前的按钮 |
| `public/app.css` | 插入 1 处 | `.composer-icon-btn` 亮/灭态 |
| `public/js/chat.js` | 改 5 处 | import、会话级状态、两处快照、还原、send 装饰、按钮绑定 |
| `web-image-oss-manage/bin/upload.mjs` | 新建 | 上传 CLI，输出 JSON URL 清单 |
| `web-image-oss-manage/package.json` | 改 1 处 | 加 `"upload"` script |

前 6 个文件在 Principal 仓库，后 2 个在 `C:\Users\DELL\Desktop\web-image-oss-manage`——**两个独立仓库，注意别搞混工作目录**。

---

## Task 1: 纯逻辑与单测

**文件：**
- 新建：`public/js/figma-restore.logic.js`
- 测试：`public/js/figma-restore.logic.test.js`

- [ ] **Step 1: 写失败的测试**

创建 `public/js/figma-restore.logic.test.js`：

```js
/**
 * 设计稿精确还原开关纯逻辑。
 * 单跑：node --test public/js/figma-restore.logic.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict'; // 仓库约定：188 个测试文件用 strict，别引入第二套断言语义
import {
  hasFigmaUrl,
  decorateFigmaRestore,
  buildRestoreDirective,
  OSS_TOOL_PATH,
} from './figma-restore.logic.js';

const CLAUDE = { on: true, provider: 'claude-agent' };
const LINK = 'https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/MyFile?node-id=1-2';

test('开 + Claude provider + 含链接 → 追加指令段', () => {
  const out = decorateFigmaRestore(`还原这个页面 ${LINK}`, CLAUDE);
  assert.ok(out.startsWith(`还原这个页面 ${LINK}`), '用户原文必须原样保留在开头');
  assert.ok(out.includes('【设计稿精确还原 · 自动资源管线】'));
  assert.ok(out.includes('figma-precise-restore'));
});

test('开但文本无 Figma 链接 → 原样返回', () => {
  assert.equal(decorateFigmaRestore('帮我看看这段代码', CLAUDE), '帮我看看这段代码');
});

test('关 → 原样返回', () => {
  const text = `还原这个页面 ${LINK}`;
  assert.equal(decorateFigmaRestore(text, { on: false, provider: 'claude-agent' }), text);
});

test('openai-compat provider → 原样返回（那边没有 figma MCP 与 skill 机制）', () => {
  const text = `还原这个页面 ${LINK}`;
  assert.equal(decorateFigmaRestore(text, { on: true, provider: 'openai-compat' }), text);
});

test('design / file / board / slides 四种路径形态都识别', () => {
  const key = 'AbCdEfGhIjKlMnOpQrStUv';
  for (const seg of ['design', 'file', 'board', 'slides']) {
    assert.ok(hasFigmaUrl(`https://www.figma.com/${seg}/${key}/X`), seg + ' 应识别');
  }
});

test('省略 www 也识别', () => {
  assert.ok(hasFigmaUrl('https://figma.com/design/AbCdEfGhIjKlMnOpQrStUv/X'));
});

test('相似域名不误判', () => {
  assert.equal(hasFigmaUrl('https://evil-figma.com/design/AbCdEfGhIjKlMnOpQrStUv/X'), false);
  assert.equal(hasFigmaUrl('https://figma.com.evil.com/design/AbCdEfGhIjKlMnOpQrStUv/X'), false);
});

test('空值不炸', () => {
  assert.equal(hasFigmaUrl(''), false);
  assert.equal(hasFigmaUrl(null), false);
  assert.equal(hasFigmaUrl(undefined), false);
});

test('指令段带上传命令的关键组成', () => {
  const d = buildRestoreDirective();
  assert.ok(d.includes(OSS_TOOL_PATH), '必须含工具路径');
  assert.ok(d.includes('bin/upload.mjs'));
  assert.ok(d.includes('--prefix='));
  assert.ok(d.includes('git rev-parse --abbrev-ref HEAD'), '分支由模型自己取');
  assert.ok(d.includes('kebab-case'));
  assert.ok(d.includes('download_assets'));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd "C:/Users/DELL/Desktop/claude-p-web-demo"
node --test public/js/figma-restore.logic.test.js
```

预期：FAIL —— `Cannot find module './figma-restore.logic.js'`

- [ ] **Step 3: 写实现**

创建 `public/js/figma-restore.logic.js`：

```js
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
    '2. 设计稿中的位图 / 图标资源，用 download_assets 导出（rawImages + svgAssets）。',
    '3. 给每个资源起符合语义的英文 kebab-case 名（如 hero-banner、icon-expert-badge），',
    '   不要沿用 Figma 图层名或哈希名。',
    '4. 执行 `git rev-parse --abbrev-ref HEAD` 取当前分支，作为 OSS 目录。',
    `5. 上传：node "${OSS_TOOL_PATH}/bin/upload.mjs" --prefix="<分支名>" <文件...>`,
    '   命令输出 JSON URL 清单；标记 skipped 的说明同名已存在，请改名重传。',
    '6. 代码里引用上传后返回的 OSS URL，不要引用本地路径。',
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test public/js/figma-restore.logic.test.js
```

预期：PASS，9 个测试全绿。

- [ ] **Step 5: 跑全量测试确认没破坏别的**

```bash
npm test
```

预期：原有测试全部维持通过。

---

## Task 2: ICON 常量

**文件：**
- 修改：`public/js/icons.js`（追加到文件末尾）

素材来源 `C:\Users\DELL\Downloads\scc 超级计算集群.svg`（iconfont 导出）。按 `icons.js` 文件头已写死的约定处理：剥掉 XML 声明 / DOCTYPE / `t` / `class` / `p-id`，**去掉 path 上写死的 `fill="#2B85FB"`** 改用 `currentColor`，尺寸 `1em`。

- [ ] **Step 1: 追加常量**

在 `public/js/icons.js` 末尾追加：

```js
/** 设计稿精确还原（超算集群）。输入框左侧开关用。 */
export const FIGMA_RESTORE_ICON_SVG =
  '<svg viewBox="0 0 1024 1024" width="1em" height="1em" fill="currentColor" aria-hidden="true">' +
  '<path d="M637.952 256l-108.544-64-8.704-4.096-8.704 2.048-108.544 64-130.56-70.656L104.448 281.6v192l168.448 98.304 4.096 2.048 61.952-34.304V452.096L291.84 428.544l-78.848 47.104-53.248-31.744V311.296l119.296-66.048 72.704 40.448-68.096 42.496 91.648 59.904-27.648 12.8v202.752l170.496 98.304 2.048 2.048h2.048l175.104-98.304V403.456l-27.648-12.8 91.648-59.904-68.096-42.496 72.704-40.448 119.296 66.048v132.096l-53.248 31.744-78.848-47.104-49.152 23.552v87.552l61.952 34.304 170.496-100.352V283.648L768 185.344 637.952 256zM386.048 330.752l134.144-85.504 134.144 85.504-134.144 82.944c0.512 0-134.144-82.944-134.144-82.944z m226.304 87.552l29.696 16.896v134.144L520.704 640l-119.296-68.096V437.248l29.696-16.896 91.648 55.296 89.6-57.344z m123.904 78.848l14.848-8.704 27.648 16.896-12.8 8.704-29.696-16.896z m-474.112 8.704l27.648-16.896 14.848 8.704-29.696 16.896-12.8-8.704z m258.56-439.808l8.704 4.096 4.096 2.048 159.744 87.552v53.248L640 243.2v-49.152l-119.296-70.144-119.808 70.144v51.2l-53.248-31.744V159.744l173.056-93.696z m324.096 475.648l38.4 25.6V716.8l-132.096 78.848-42.496-21.504v-111.104l-51.2-29.696-96.256 55.296v61.952l96.256 53.248v40.448l-134.144 78.848L388.096 844.8v-40.448l96.256-53.248v-61.952L384 631.296l-51.2 29.696v111.104l-42.496 21.504-132.096-78.848v-149.504l38.4-25.6-55.296-31.744-36.352 29.696v211.456l183.296 106.496 45.056-23.552v36.352l179.2 104.448 8.704 4.096 8.704-4.096 175.104-102.4 2.048-2.048v-36.352l45.056 23.552 183.296-106.496V537.6l-36.352-29.696-54.272 33.792z m-230.4 177.152v-55.296l42.496 25.6V742.4l-42.496-23.552z m-228.352-29.696l42.496-25.6v55.296l-42.496 21.504v-51.2z"/>' +
  '</svg>';
```

- [ ] **Step 2: 确认无语法错误**

```bash
node -e "import('./public/js/icons.js').then(m => console.log(m.FIGMA_RESTORE_ICON_SVG.length))"
```

预期：打印一个大于 1000 的数字，无报错。

---

## Task 3: 按钮 DOM 与样式

**文件：**
- 修改：`public/index.html`（`footer.composer` 区块，约 836-847 行）
- 修改：`public/app.css`（`.composer-input.dragover` 规则之后，约 1233 行）

- [ ] **Step 1: 插入按钮**

先 Read `public/index.html` 定位这段锚点代码：

```html
      <footer class="composer">
        <div
          id="prompt"
```

改为（在 `<div id="prompt"` 之前插入按钮）：

```html
      <footer class="composer">
        <button
          class="composer-icon-btn"
          id="figmaRestoreBtn"
          type="button"
          aria-pressed="false"
          title="设计稿精确还原：贴 Figma 链接自动导出资源、语义命名、传 OSS"
        ></button>
        <div
          id="prompt"
```

按钮内容留空——图标由 `chat.js` 在绑定时注入 `FIGMA_RESTORE_ICON_SVG`，与项目其它图标的用法一致。

- [ ] **Step 2: 加样式**

先 Read `public/app.css` 定位这段锚点代码：

```css
      .composer-input.dragover {
        border-color: var(--accent);
        background: var(--accent-soft);
      }
```

在其**之后**插入：

```css
      /* 设计稿精确还原开关：.composer 是 flex + align-items:flex-end，
         按钮插在 #prompt 之前自然落左侧、与发送按钮同底基线 */
      .composer-icon-btn {
        flex: 0 0 auto;
        width: 40px;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 3px; /* 对齐 .composer-input 46px 高度的视觉中线 */
        padding: 0;
        border: 1px solid var(--border);
        border-radius: 12px; /* 同 .composer-input，避免两种圆角并排 */
        background: var(--panel);
        color: var(--faint);
        font-size: 19px;
        cursor: pointer;
        transition: color 0.15s, background 0.15s, border-color 0.15s;
      }
      .composer-icon-btn:hover {
        color: var(--text);
      }
      .composer-icon-btn.on {
        color: #2b85fb;
        border-color: rgba(43, 133, 251, 0.45);
        background: rgba(43, 133, 251, 0.12);
      }
```

- [ ] **Step 3: 目视确认**

```bash
npm start
```

浏览器开 `http://127.0.0.1:3000`，确认输入框左侧出现灰色图标按钮，与输入框圆角一致、底部对齐。此时点击还无反应（Task 4 才接线）。确认后停掉服务。

---

## Task 4: chat.js 接线

**文件：**
- 修改：`public/js/chat.js`（5 处）

**每处 Edit 前先 Read 确认锚点**——本文件行号会漂。

- [ ] **Step 1: 加 import**

锚点（文件顶部附近，约第 4 行）：

```js
import { decorateUltracode, canEnableUltracode } from './ultracode.logic.js';
```

在其后加一行：

```js
import { decorateFigmaRestore, hasFigmaUrl } from './figma-restore.logic.js';
```

然后把图标常量加进**已存在**的 icons 解构（约第 20 行）。锚点：

```js
import { setIconText, PIN_ICON_SVG, REFRESH_ICON_SVG, WAITING_ICON_SVG } from './icons.js';
```

改为：

```js
import { setIconText, PIN_ICON_SVG, REFRESH_ICON_SVG, WAITING_ICON_SVG, FIGMA_RESTORE_ICON_SVG } from './icons.js';
```

**不要新增一条 import 语句**——`setIconText` 正好也在这条里，Step 6 要用它注入图标。

- [ ] **Step 2: 加会话级状态**

锚点（约 141-144 行）：

```js
      let chatUltracode = false;
```

在其后加：

```js
      // 设计稿精确还原：会话级开关，与 chatUltracode 同策略（不落 localStorage，新会话从关开始）。
      // 理由相同：在 A 会话开着还原设计稿，切到 B 问别的问题不该被拼上还原指令。
      let chatFigmaRestore = false;
```

- [ ] **Step 3: 两处快照写入**

锚点一（`recordMessage` 内，约 797 行）：

```js
        c.ultracode = chatUltracode; // 每条消息都快照（与 model/mode 同款）；首条消息建会话记录时也会写入，解决「会话还没建就先开了开关」的时序
```

在其后加：

```js
        c.figmaRestore = chatFigmaRestore;
```

锚点二（`persistPrefsToConv` 内，约 839 行）：

```js
        c.ultracode = chatUltracode;
        saveConvs(list); // 不动 updatedAt：纯偏好变更不改变左栏排序
```

改为：

```js
        c.ultracode = chatUltracode;
        c.figmaRestore = chatFigmaRestore;
        saveConvs(list); // 不动 updatedAt：纯偏好变更不改变左栏排序
```

- [ ] **Step 4: send() 装饰**

锚点（约 2163-2164 行）：

```js
        // ultracode 前缀只进 prompt：气泡（上面 addMessage）与记忆库（launchRun 的 typedText）都是原文
        finalText = decorateUltracode(finalText, { on: chatUltracode, provider: chatProvider });
```

在其后加：

```js
        // 同上：还原指令段只进 prompt，气泡与记忆库存原文
        finalText = decorateFigmaRestore(finalText, { on: chatFigmaRestore, provider: chatProvider });
```

- [ ] **Step 5: 会话切换时还原状态**

锚点（`applySessionPrefs` 内，约 3183-3188 行）：

```js
        // ultracode 是会话级开关：缺字段视为关（老会话、CLI 历史会话天然为关），不参与 changed 的 toast
        const nextUltracode = !!prefs.ultracode && canEnableUltracode(chatDisabledTools); // 工具已全局禁用时不还原亮灯，与点击时的守卫对称
        if (nextUltracode !== chatUltracode) {
          chatUltracode = nextUltracode;
          syncUltracodeRow();
        }
```

在其后加：

```js
        // 同款会话级开关，缺字段视为关；不参与 changed 的 toast
        const nextFigmaRestore = !!prefs.figmaRestore;
        if (nextFigmaRestore !== chatFigmaRestore) {
          chatFigmaRestore = nextFigmaRestore;
          syncFigmaRestoreBtn();
        }
```

- [ ] **Step 6: 按钮绑定与同步函数**

锚点（约 3208 行，`ultracodeToggle?.addEventListener` 那一整块）：

```js
      ultracodeToggle?.addEventListener('change', () => {
```

在这一块**之前**插入：

> **注意顺序：** Step 5 改的 `applySessionPrefs` 里调用了 `syncFigmaRestoreBtn()`，而它定义在这里（位置更靠后）。这是安全的——`applySessionPrefs` 只在用户切会话时被调用，那时模块顶层早已执行完毕，`const figmaRestoreBtn` 已完成初始化。但**这段必须放在模块顶层**（与 `ultracodeToggle` 的绑定同级），不能塞进任何函数体内，否则 `syncFigmaRestoreBtn` 在 `applySessionPrefs` 的作用域里不可见。

```js
      const figmaRestoreBtn = $('#figmaRestoreBtn');
      // 用 setIconText 而非 innerHTML：项目统一的图标注入方式（会裹一层 .inline-ic 做对齐）
      if (figmaRestoreBtn) setIconText(figmaRestoreBtn, FIGMA_RESTORE_ICON_SVG);
      /** 设计稿精确还原按钮：亮/灭态跟会话级状态；aria-pressed 同步，键盘与读屏可感知 */
      function syncFigmaRestoreBtn() {
        if (!figmaRestoreBtn) return;
        figmaRestoreBtn.classList.toggle('on', chatFigmaRestore);
        figmaRestoreBtn.setAttribute('aria-pressed', String(chatFigmaRestore));
      }
      syncFigmaRestoreBtn();
      figmaRestoreBtn?.addEventListener('click', () => {
        chatFigmaRestore = !chatFigmaRestore;
        persistPrefsToConv(); // 无会话时 no-op，首条消息由 recordMessage 快照带入
        syncFigmaRestoreBtn();
        // 不调 saveUiPrefs：会话级偏好，不进服务端全局默认（同 ultracode）
        if (chatFigmaRestore) toast('设计稿还原已开启：发送含 Figma 链接的消息即自动触发');
      });
```

- [ ] **Step 6b: 新建会话时重置（易漏，补于实施期审查）**

`applySessionPrefs` 覆盖不到「新建空会话」这条路径——它只在切换到**已存在**的会话（`openConv` / `resumeHistorySession`）时触发。`newConversation()` 是手工重置，必须同步补上，否则开关会从上一个会话带进新会话，用户在新对话里贴 Figma 链接会被静默装饰。

锚点（约 978 行）：

```js
        chatUltracode = false; // 新会话从关开始（见变量声明处）
        syncUltracodeRow();
```

在其后加：

```js
        chatFigmaRestore = false; // 新会话从关开始（同 chatUltracode，见变量声明处）
        syncFigmaRestoreBtn();
```

> **明确不做的对应：** `chatUltracode` 在 `refreshToolsSection()`（约 2989 行）还有第五个赋值点——关掉 Workflow 工具时同步熄灭开关。那是 ultracode 特有的，因为它绑定 Workflow 这一个内置工具，两者并排在同一弹层，不允许「开关亮着但工具已禁」的矛盾。设计稿还原不绑定任何可在该弹层禁用的内置工具，**不加这个守卫**（YAGNI）。

- [ ] **Step 7: 无链接时的提示**

回到 Step 4 那处，把新加的那行扩展为带提示的形态：

```js
        // 同上：还原指令段只进 prompt，气泡与记忆库存原文
        if (chatFigmaRestore && chatProvider === 'claude-agent' && !hasFigmaUrl(finalText)) {
          // 开着却没贴链接：不拦截发送，只提示一次，避免用户以为已经触发了还原
          toast('未检测到设计稿链接，本条按普通消息发送');
        }
        finalText = decorateFigmaRestore(finalText, { on: chatFigmaRestore, provider: chatProvider });
```

- [ ] **Step 8: 跑测试**

```bash
npm test
```

预期：全绿。

- [ ] **Step 9: 手动验证前端**

```bash
npm start
```

浏览器开 `http://127.0.0.1:3000`，逐条确认：

1. 点击图标 → 变蓝、有背景色，弹 toast「设计稿还原已开启…」
2. 再点 → 恢复灰色
3. 开着状态下发一条不含链接的消息 → 弹「未检测到设计稿链接…」，消息正常发出
4. 新建会话 → 图标是灭的（会话级，不继承）
5. 在 A 会话开启、发一条消息，切到 B 再切回 A → 图标仍是亮的
6. 开着状态下发一条含 Figma 链接的消息 → 聊天气泡里显示的**仍是你的原话**（指令段不进气泡）

第 6 条是关键：指令段泄漏进气泡意味着它也会进记忆库，污染语料。

---

## Task 5: 上传 CLI

**文件：**
- 新建：`C:\Users\DELL\Desktop\web-image-oss-manage\bin\upload.mjs`

⚠️ **切换仓库** —— 这个任务在 `web-image-oss-manage`，不是 Principal。

- [ ] **Step 1: 确认依赖就位**

```bash
cd "C:/Users/DELL/Desktop/web-image-oss-manage"
ls node_modules/ali-oss node_modules/sharp >/dev/null && echo OK
cat .env | grep -c OSS_ACCESS_KEY_ID
```

预期：打印 `OK`，且第二条输出 `1`（凭证已配）。若 `.env` 缺失，先 `cp .env.example .env` 并填入凭证——没有凭证这个任务无法验证。

- [ ] **Step 2: 写 CLI**

创建 `bin/upload.mjs`：

```js
#!/usr/bin/env node
/**
 * Figma 资源上传 CLI —— 供 Claude 在还原设计稿时调用。
 *
 * 用法：node bin/upload.mjs --prefix="req/xxx-需求名" a.png b.svg c.webp
 * 输出：stdout 单个 JSON（URL 清单），调用方解析后把 url 写进代码。
 *
 * 复用 server/oss.js 与 server/convert.js，不改动它们——web 服务与本 CLI 是同一套
 * OSS 能力的两个入口。设计依据见 Principal 仓库
 * docs/superpowers/specs/2026-09-16-composer-figma-restore-design.md 决策 4。
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import sharp from 'sharp';
import { put, exists } from '../server/oss.js';
import { toWebpIfNeeded } from '../server/convert.js';
import { CATEGORIES, BUCKET_HOST } from '../server/config.js';

const BASE_PREFIX = CATEGORIES['webp-image'].prefix; // images/resource/webp/

/**
 * svg → webp，2x 密度（librsvg 默认 72 DPI，取 144）。
 *
 * 刻意不去扩 convert.js 的 CONVERTIBLE_EXTS：那会让 web UI 拖入 svg 的行为从
 * 「报 UNSUPPORTED_TYPE」变成「静默转换」，是对共享模块的行为变更。CLI 自己的
 * 需求自己满足。
 */
async function svgToWebp(buffer) {
  return sharp(buffer, { density: 144 })
    .webp({ quality: 80, nearLossless: true })
    .toBuffer();
}

function parseArgs(argv) {
  let prefix = '';
  const files = [];
  for (const a of argv) {
    if (a.startsWith('--prefix=')) prefix = a.slice('--prefix='.length);
    else files.push(a);
  }
  return { prefix, files };
}

/**
 * 文件名净化：与 convert.js:toWebpName 同规则，扩展名由调用方给定。
 * 只作用于 basename —— 目录前缀绝不能过这一关，否则中文分支名会被打成连字符。
 */
function safeName(originalName, ext) {
  const stem = basename(originalName, extname(originalName));
  return `${stem.replace(/[^A-Za-z0-9._-]/g, '-')}${ext}`;
}

async function uploadOne(file, dirPrefix) {
  const raw = await readFile(file);
  const ext = extname(file).toLowerCase();

  let buffer, targetName, converted;
  if (ext === '.svg') {
    buffer = await svgToWebp(raw);
    targetName = safeName(file, '.webp');
    converted = true;
  } else {
    const r = await toWebpIfNeeded(raw, basename(file));
    buffer = r.buffer;
    targetName = r.targetName;
    converted = r.converted;
  }

  const key = `${dirPrefix}${targetName}`;
  // 逐段编码保留斜杠：中文目录直链可用，斜杠不能被编成 %2F
  const url = `${BUCKET_HOST}/${key.split('/').map(encodeURIComponent).join('/')}`;

  if (await exists(key)) {
    return { src: file, key, url, converted, status: 'skipped', reason: '同名已存在' };
  }
  await put(key, buffer, 'image/webp');
  return { src: file, key, url, converted, status: 'uploaded' };
}

async function main() {
  const { prefix, files } = parseArgs(process.argv.slice(2));

  if (!prefix) {
    console.error('缺少 --prefix。用法：node bin/upload.mjs --prefix="<分支名>" <文件...>');
    process.exit(1);
  }
  if (!files.length) {
    console.error('没有待上传文件。');
    process.exit(1);
  }

  // 分支名原样进 key（OSS 支持中文）；只补齐首尾斜杠，不做任何字符替换
  const dirPrefix = `${BASE_PREFIX}${prefix.replace(/^\/+|\/+$/g, '')}/`;

  const results = [];
  for (const f of files) {
    try {
      results.push(await uploadOne(f, dirPrefix));
    } catch (err) {
      // 单个失败不中断整批：模型拿到 failed 条目可以单独重试，不必从头重跑导出
      results.push({ src: f, status: 'failed', reason: err.message });
    }
  }

  // 全部失败才算整体失败；有一个成功就让调用方拿到那部分 URL
  const ok = results.some((r) => r.status !== 'failed');
  console.log(JSON.stringify({ ok, prefix: dirPrefix, results }, null, 2));
  process.exit(ok ? 0 : 1);
}

main();
```

- [ ] **Step 3: 参数校验冒烟（不碰网络）**

```bash
cd "C:/Users/DELL/Desktop/web-image-oss-manage"
node bin/upload.mjs
```

预期：stderr 打印「缺少 --prefix。用法：…」，退出码 1。

```bash
node bin/upload.mjs --prefix="req/测试"
```

预期：stderr 打印「没有待上传文件。」，退出码 1。

- [ ] **Step 4: 加 npm script**

修改 `package.json` 的 `scripts`，锚点：

```json
  "scripts": {
    "start": "node server/index.js"
  },
```

改为：

```json
  "scripts": {
    "start": "node server/index.js",
    "upload": "node bin/upload.mjs"
  },
```

---

## Task 6: 真实上传验证

⚠️ 这一步**会真的往 OSS 写对象**，且是本方案最可能翻车的地方（中文目录编码）。

- [ ] **Step 1: 准备测试素材**

```bash
cd "C:/Users/DELL/Desktop/web-image-oss-manage"
mkdir -p /tmp/figma-test
node --input-type=commonjs -e "const sharp=require('sharp');sharp({create:{width:64,height:64,channels:4,background:{r:255,g:0,b:0,alpha:1}}}).png().toFile('/tmp/figma-test/test-banner.png').then(()=>console.log('png ok'))"
printf '%s' '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="20" fill="#2B85FB"/></svg>' > /tmp/figma-test/test-icon.svg
ls -la /tmp/figma-test
```

预期：打印 `png ok`，两个文件都存在且非空。

> `--input-type=commonjs` 是必需的：本项目 `package.json` 声明了 `"type": "module"`，而 `sharp` 是 CommonJS 包，不显式指定会撞模块系统。

- [ ] **Step 2: 跑真实上传**

```bash
node bin/upload.mjs --prefix="req/测试-中文分支" /tmp/figma-test/test-banner.png /tmp/figma-test/test-icon.svg
```

预期输出形如：

```json
{
  "ok": true,
  "prefix": "images/resource/webp/req/测试-中文分支/",
  "results": [
    { "src": "...test-banner.png", "key": "images/resource/webp/req/测试-中文分支/test-banner.webp",
      "url": "https://dongying-uniapp.oss-cn-beijing.aliyuncs.com/images/resource/webp/req/%E6%B5%8B%E8%AF%95-%E4%B8%AD%E6%96%87%E5%88%86%E6%94%AF/test-banner.webp",
      "converted": true, "status": "uploaded" },
    { "src": "...test-icon.svg", "key": "images/resource/webp/req/测试-中文分支/test-icon.webp",
      "url": "https://...", "converted": true, "status": "uploaded" }
  ]
}
```

**逐条核对：**

1. `key` 里的中文是**中文**，不是连字符、不是乱码 ← 最关键
2. svg 的 `key` 后缀是 `.webp`（转换生效）
3. `url` 里中文被编码成 `%E6%B5%8B...`，但斜杠仍是 `/`

- [ ] **Step 3: 浏览器验证**

把输出里任一 `url` 粘进浏览器。

预期：图片正常显示。svg 转出的那张应在 48px 显示尺寸下清晰（2x 渲染生效）。

- [ ] **Step 4: 幂等验证**

重跑 Step 2 的**同一条命令**。

预期：两条结果的 `status` 都变成 `"skipped"`，`reason` 为 `"同名已存在"`，`ok` 仍为 `true`。

- [ ] **Step 5: 中文编码翻车时的兜底（仅在 Step 2 第 1 条核对失败时执行）**

若 `key` 里中文变成乱码或问号，说明 Windows + Git Bash 传中文参数给 node 存在编码退化。此时改为 base64 传递：

在 `upload.mjs` 的 `parseArgs` 里增加 `--prefix-b64=` 分支：

```js
    if (a.startsWith('--prefix-b64=')) {
      prefix = Buffer.from(a.slice('--prefix-b64='.length), 'base64').toString('utf8');
    } else if (a.startsWith('--prefix=')) {
      prefix = a.slice('--prefix='.length);
    } else files.push(a);
```

并同步修改 `figma-restore.logic.js` 的 `buildRestoreDirective()` 第 5 条，改为指示模型传 `--prefix-b64=$(echo -n "<分支名>" | base64 -w0)`，同时更新 `figma-restore.logic.test.js` 里断言 `--prefix=` 的那条用例。

**Step 2 通过就不要做这一步**——不预先加这层复杂度。

- [ ] **Step 6: 清理**

在 OSS 控制台删掉 `images/resource/webp/req/测试-中文分支/` 整个目录，避免测试垃圾留在生产 bucket。

本地临时素材一并清掉：

```bash
rm -rf /tmp/figma-test
```

---

## Task 7: 端到端串跑

- [ ] **Step 1: 起服务**

```bash
cd "C:/Users/DELL/Desktop/claude-p-web-demo"
npm start
```

- [ ] **Step 2: 真实跑一次还原**

在浏览器里：

1. 把工作目录切到一个真实前端仓库（如 `kxmall-app-ui`），确认它当前在一个有意义的分支上
2. 点亮输入框左侧的还原图标
3. 发送：`还原这个页面 <一个带 node-id 的真实 Figma 链接>`

- [ ] **Step 3: 核对模型行为**

观察转录，逐条确认：

1. 模型加载了 `figma-precise-restore` skill，而不是只调 `get_design_context` 看截图
2. 模型调了 `download_assets` 取资源
3. 模型跑了 `git rev-parse --abbrev-ref HEAD`，拿到的是那个仓库的当前分支
4. 模型调了 `upload.mjs`，且 `--prefix` 是上一步拿到的分支名
5. 模型写进代码的是 OSS URL，不是本地路径
6. 资源文件名是语义化英文 kebab-case，不是 Figma 图层名或哈希

- [ ] **Step 4: 按实际表现回调指令段**

哪一条没做到，就改 `figma-restore.logic.js` 的 `buildRestoreDirective()` 里对应那一行的措辞，重跑验证。这段措辞是整个功能的成败所在，预期需要几轮迭代。

改动后记得同步 `figma-restore.logic.test.js` 里相关的断言。

---

## 完成标准

- [ ] `npm test`（Principal）全绿
- [ ] 输入框左侧图标能亮灭，会话级隔离正确（Task 4 Step 9 六条）
- [ ] 指令段不进气泡、不进记忆库
- [ ] `upload.mjs` 能把中文分支目录正确写进 OSS，幂等重跑返回 skipped
- [ ] 端到端跑通一次真实还原（Task 7 Step 3 六条）
- [ ] 所有改动留在工作区，**未提交 git**

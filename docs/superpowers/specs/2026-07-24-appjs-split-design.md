# app.js 拆分设计（前端上帝文件 → 原生 ES modules）

## 背景与约束
- `public/app.js` 4342 行、141 个顶层函数、69 个共享状态变量，单文件经典脚本（缩进 6 空格，历史上从 index.html 内联抽出）。
- **无构建**：静态托管，浏览器原生 ES modules 是唯一不引入工具链的拆分手段。
- 依赖两个经典全局库：`/vendor/marked.min.js`、CDN `anime.iife.min.js`（module 默认 defer，仍在其后执行，顺序安全）。

## 核验过的事实（2026-07-24）
- index.html **零内联 `<script>`、零 `onclick=` 属性** → module 作用域化不破 HTML 引用。
- 对外 window 接口仅 4 个（均显式赋值，module 下不变）：`window.tauriApi` / `window.notifyUser` / `window._pendingNotifyConvId` / `window._setSidebarToolsMode`。
- `API_BASE`（`let`，Tauri 打包模式异步回填）在段外仅 2 处引用 → `export let` live binding 覆盖。
- 动画段 `const AnimeAnimations = IIFE()` 对外部符号**零引用**（仅用 `anime` 全局）。
- `tests/e2e-steer-bubble.mjs` 走真实页面 `goto` 加载，module 化透明。

## 风险与安全网
- **严格模式**：module 强制 strict，经典脚本中的隐式全局赋值（如未声明变量）会变成运行时 ReferenceError。防线=`tests/e2e-panels-smoke.mjs`（新增）：遍历全部视图/设置 tab/模型弹层/侧栏/输入框，**全程断言零 pageerror**；加上既有 steer-bubble（聊天流式核心）与 mcp-tab（设置 CRUD）共三道 e2e 门禁。
- 残余风险：低频路径（目录弹层深层浏览、上传、动作表单编辑）未被 e2e 覆盖，靠后续阶段逐步补。

## 分阶段
- **P1（本轮）**：`<script type="module">` + 抽 4 个叶子模块到 `public/js/`：
  - `bootstrap.js` — API_BASE 探测 + 打包模式 fetch/EventSource 补丁（副作用模块，必须最先 import；`export let API_BASE`）
  - `tauri-init.js` — Tauri API 异步初始化（副作用模块，产出 window.tauriApi/notifyUser）
  - `ui.js` — `toast` / `confirmDialog`（自封闭 UI 原语）
  - `anim.js` — `AnimeAnimations`（自封闭动画集）
  - 规则：纯移动零改写，只在边界加 import/export；每步过三道 e2e。
- **P2**：域面板模块（json-tool → logs → tasks → actions → settings 系）：每个面板一个模块，依赖显式化（$、escapeHtml、toast、fetch 端点），先易后难。
- **P3**：聊天核心（convs 存储 / 气泡 `_bubbleMap` 三方同序不变量 / 打字机 / send / attachStream）——状态最密，最后动，需先把「存储=DOM=_bubbleMap」不变量的守护函数集中成一个模块再拆。

## 进度（2026-07-24）
- ✅ P1：`type="module"` + bootstrap / tauri-init / ui / anim 四叶子。三道 e2e 门禁（panels-smoke + steer-bubble + mcp-tab）一次全绿。
- ✅ P2a：util.js（$ / escapeHtml / debounce）+ json-tool.js（170 行）。panels-smoke 已扩展 JSON 工具真实交互（贴 JSON→防抖 250ms→格式化→出树）。
- ✅ P2b：fmtTime → util.js（logs/tasks 共用）；logs-panel.js（149 行，导出 loadLogs）。
- ✅ P2c：settings-panel.js（480 行，导出 loadSettings/bindConfigTransfer；settingsBtn 入口绑定留壳）。
- ✅ P2d：actions-panel.js（221 行，零反向依赖，副作用模块自带入口绑定）。
- ✅ P2e：tasks-panel.js（278 行）；renderMarkdown → util.js（chat 气泡共用）。反向依赖 `showView('tasks')`/`activeView` 经 **bindTasksNav(openFn, isActiveFn) 视图桥注入**解耦。
- ✅ P2f：sidebar.js（90 行，零依赖副作用模块）。侧栏「会话/工具」切换段（23 行）**有意留壳**——本质是 showView 导航接线。
- ✅ P3a：autostart.js（33 行，副作用模块，import API_BASE）。
- ✅ P3b：dir-popover.js（200 行）。**`selectDir`（cwd 变更编排者）有意留壳**——它联动 saveUiPrefs/历史缓存失效/目录标签四个壳态；弹层经 `bindDirPopover({getCwd, selectDir})` 注入，`closeDirModal` 导出供 selectDir 回调（保持 app.js→module 单向）。panels-smoke 已扩目录弹层开关步骤。
- ✅ P3c：composer.js（127 行）。模块自持 `promptEl` 引用（同一 DOM 节点，无状态分裂）；导出 getPromptText/clearPrompt/handleDrop。
- ✅ P3d：**conv-store.js（101 行）——三方同序不变量收敛点**。convs localStorage（防抖+flush）+ 消息模型五函数 + `_bubbleMap` 守护 API（bubbleReset/bubblePush/bubbleGet）；`moveMessageToEnd` 把「存储 splice + _bubbleMap splice」合并为单守护函数（2026-07-21 失步 bug 的根治），app.js 不再直接触碰 Map。steer-bubble 回归 e2e（该不变量的专属测试）通过。
- **P1-P3d 累计：app.js 4342 → 1752 行（-60%）；`public/js/` 15 模块**。
- ✅ **P3 终局已交付（2026-07-24）**：app.js **4342 → 108 行壳** + `js/chat.js`（1742 行聊天体，接缝=initChat/chatOnShow/bindChatNav 注入）；四道 e2e 门禁 + 145 后端测试全绿；泄漏 grep 双向零命中（含 id 隐式全局地雷排查）；顺带清掉 3 个死 import（API_BASE/escapeHtml/confirmDialog 在体内已无引用）。**上帝文件正式终结：16 个前端模块，最大单模块即聊天体本体。** 原方案记录：壳/聊天体反转切分。census 实锤：`currentConvId` 全部 5 个写点都在聊天体内、反向依赖仅 `showView('chat')`×5 → 唯一合理刀位不是拆聊天体内部，而是**把聊天体整体迁出**：
  - `public/js/chat.js`（~1600 行）：状态区(cwd/_urlCwd/_urlConv/chat* prefs/runningJobs/currentConvId/historyRange 等) + UI偏好持久化 + 工作目录标签 + 对话历史视图(含项目分组) + 消息模型剩余 + 消息渲染 + 打字机 + 额度状态 + 发送 + 停止遮罩/attachStream + 事件绑定 + 系统文件夹选择/项目目录按钮 + selectDir/openProjectWindow + dir-popover bind 调用 + 待续跑轮询 + AnimeAnimations 补救 rAF + beforeunload。导出：`initChat()`（原启动初始化里聊天相关行）、`chatOnShow()`（回聊天视图时吸底）、`bindChatNav(goChat)`（注入 `showView('chat')`，替换体内 5 处直调）。
  - `app.js`（壳，~150 行）：全部模块 import + 面板视图机 showView/toggleView（'chat' 分支调 `chatOnShow()`）+ bindTasksNav + bindChatNav + 入口绑定（taskBtn/logBtn/settingsBtn/panel-close/Esc）+ 侧栏工具切换 + 启动编排（initChat() + refreshTaskBadge 轮询）。
  - 门禁照旧四道（panels-smoke / sidebar-groups / steer-bubble / mcp-tab）+ 检查清单（读取型引用/id 隐式全局 grep）。

## ⚠️ 抽离检查清单（每步必做，实战教训）
1. 段内标识符全量普查（`grep -oE '\b[\w$]+\('`+频次排序），逐个判内部/外部——**别只抽查几个名字**（debounce 曾漏扫）。**调用型普查抓不到读取型引用**（`activeView` 实锤：census 干净但运行时 ReferenceError，靠 panels-smoke 零 pageerror 断言当场逮住）→ 抽完后再对模块 grep 一轮 app.js 的模块级状态名（convs/currentConvId/cwd/activeView/panelView/appEl/chatModel/runningJobs…）。
2. 移动后 grep 全文残余引用被移走的顶层 const——**浏览器 id 隐式全局（window.<elementId>）会静默兜住同名引用**，行为恰好相同但纯属踩运气（settingsTabs 实锤：挪走 const 后 actions 段的引用落到 id 全局上，三道 e2e 全绿毫无征兆）。
3. 入口绑定行（`$('#xxxBtn').addEventListener(... toggleView ...)`）留壳，保持依赖单向：app.js(showView) → 面板模块，绝不反向。
4. 切分脚本用内容标记定位 + `trimEnd()` 比较（CRLF 的 `\r` 会让精确相等失败）。
5. 门禁三连：panels-smoke（零 pageerror 断言）→ steer-bubble → mcp-tab；改动测试本身须先在未切分代码上跑绿（基线）。

## P1 切分边界（行号为 2026-07-24 版 app.js）
| 段 | 行 | 处理 |
|---|---|---|
| bootstrap | 1–111 | `let API_BASE` → `export let` |
| tauri-init | 112–368 | 头部加 `import { API_BASE } from './bootstrap.js'` |
| ui | 469–528（confirmDialog 注释起 → toast 收笔) | 两函数加 `export` |
| anim | 3983–4339（==== 头注释起 → `})();`) | `const AnimeAnimations` → `export const` |
| app.js 余下 | 其余全部 | 顶部加 4 行 import |

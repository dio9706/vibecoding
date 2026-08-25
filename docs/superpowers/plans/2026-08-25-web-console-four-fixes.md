# web 执行台四项修复 — 实现计划

> 设计依据：`docs/superpowers/specs/2026-08-25-web-console-four-fixes-design.md`（根因均已逐行核验真实代码）
> **本仓规则：全程不 git 提交，改动留工作区，提交时机由用户掌控。**

**目标：** 修复用户反馈的四项 web 台问题（侧栏不能滚 / 草稿不隔离 / 自动切会话 / 优化汇总空对话）

**架构约束：**
- 只碰 `public/`（app.css、js/*）；`src-tauri/` 下的前端镜像不碰（build 时重生）；本轮预期零后端改动
- 遵循既有范式：视图桥注入（`bindChatNav`/`bindTasksNav`）、禁止反向 import、conv-store 守护 API、「存储=DOM=`_bubbleMap` 三方同序」不变量
- 门禁：`npm test`（595+）全绿 + 四道 e2e（steer-bubble / ask-chip / one-window / sidebar-groups）不回归

**批次划分（每批交付后用户走查，通过再进下一批）：**
| 批次 | 内容 | 文件数 |
|---|---|---|
| 1 | ① 侧栏滚动 + ② 草稿隔离 + ⑤ 移除打开历史 | 7 改 1 新 |
| 2 | ③ 自动切会话（三条根因） | 3 改 |
| 3 | ④ 优化汇总（字段 bug + 可见 + 进度 + 入口） | 2 改 |

**批次 1 内部顺序固定：① → ② → ⑤**。⑤ 会删掉 `.md-history`，而它正是 ① 抄的 CSS 范式参照物 —— 先做 ① 才有东西可比对（spec 已把完整写法内联，此顺序只为降低比对成本）。

---

# 批次 1 — ① 侧栏滚动 + ② 草稿隔离

## Task 1.1: `.req-list` 加限高滚动

**文件：** 修改 `public/app.css:2778-2785`

- [ ] **Step 1** 在 `.req-list` 规则末尾（`margin-bottom: 4px;` 之后）追加四行：
```css
  flex: 0 1 auto;
  min-height: 0;   /* 不加则 flex 子项按内容撑高，overflow 失效（同 app.css:1844 的坑） */
  max-height: 55%; /* 需求区最多占侧栏 55%，不把下方 .conv-list 顶掉 */
  overflow-y: auto;
```
- [ ] **Step 2** 紧随其后补细滚动条样式，逐字对齐 `public/css/markdown-tool.css:434-439` 的 `.md-history-list` 写法（6px / transparent track / `var(--border)` thumb / border-radius 3px），选择器换成 `.req-list`
- [ ] **Step 3** 验证：起服务后侧栏塞满需求（或临时把 `max-height` 调到 `120px` 观察），断言需求区出现滚动条且下方 `#convList` 仍可见可滚
- [ ] **Step 4** 回归：`node tests/e2e-sidebar-groups.mjs`（侧栏分组门禁）

## Task 1.2: composer.js 新增草稿快照 API

**文件：** 修改 `public/js/composer.js`（`clearPrompt` 之后，约 `:42`）

- [ ] **Step 1** 新增 `export function stashPrompt()`：取 `promptEl.innerHTML`，`promptEl.innerHTML = ''`，返回该 HTML。
  **注释写清为什么不复用 `clearPrompt`**：`clearPrompt` 会 `URL.revokeObjectURL` 掉 chip 缩略图的 blob，切回来就是裂图；草稿场景要保住 blob 存活。
- [ ] **Step 2** 新增 `export function restorePrompt(html)`：`promptEl.innerHTML = html || ''`，随后遍历 `promptEl.querySelectorAll('.att-chip img')` 补挂 `onerror` → 替换为 `makeFileIcon()`（`makeChip` 的既有 onerror 只作用于新建节点；页面刷新后 blob 必失效，回填节点必须重新挂，否则裂图。`dataset.path` 不受影响，发送语义不变）
- [ ] **Step 3** 新增 `export function bindComposerDraft(onDraftChange)`：注册 `promptEl` 的 `input` 监听，debounce 300ms 后调 `onDraftChange(promptEl.innerHTML)`。debounce 复用 `util.js` 的既有 `debounce`
- [ ] **Step 4** 验证：`node -c public/js/composer.js`

## Task 1.3: conv-store.js 新增 convSetDraft

**文件：** 修改 `public/js/conv-store.js`（`convSetSession` 之后，约 `:62`）

- [ ] **Step 1** 照 `convSetSession`（`:56-62`）模板新增 `export function convSetDraft(convId, html)`：`loadConvs` → `find` → `c.draft = html || ''` → `saveConvs(list)`
- [ ] **Step 2** 注释注明**不动 `updatedAt`**（理由同 `chat.js:705`：纯 UI 状态不该改左栏排序）。无需 schema 迁移（`loadConvs` 无版本约束，老记录读出 `undefined` 天然兼容）
- [ ] **Step 3** 验证：`node -c public/js/conv-store.js`

## Task 1.4: chat.js 三处切换点接线

**文件：** 修改 `public/js/chat.js`

- [ ] **Step 1** import 补 `stashPrompt, restorePrompt, bindComposerDraft`（composer.js）与 `convSetDraft`（conv-store.js）
- [ ] **Step 2** 新增 `persistDraftToConv(html)`，镜像 `persistPrefsToConv`（`:693`）：`if (!currentConvId) return; convSetDraft(currentConvId, html);`
- [ ] **Step 3** 在 `initChat` 内调 `bindComposerDraft(persistDraftToConv)`
- [ ] **Step 4** `openConv`（`:707`）：在 `currentConvId = id`（`:713`）**之前**插入
  `if (currentConvId) convSetDraft(currentConvId, stashPrompt()); else stashPrompt();`
  （幂等早返 `:709` 之后才执行，同会话不动草稿）；在 `applySessionPrefs(c)`（`:722`）附近插入 `restorePrompt(c.draft)`
- [ ] **Step 5** `newConversation`（`:767`）：在 `currentConvId = null`（`:771`）之前存旧草稿，之后 `restorePrompt('')`
- [ ] **Step 6** `resumeHistorySession`（`:238`，改 `currentConvId` 在 `:261`）：同 Step 4 处理（这条路径**不走 openConv**，是历史遗漏高发区，见 `:257-259`/`:278` 注释）
- [ ] **Step 7** `send()` 的 `clearPrompt()`（`:1961`）与 `steer()` 的（`:2108`）之后各补 `convSetDraft(convId, '')`——否则重开会话会把已发出内容灌回输入框
- [ ] **Step 8** 验证：`node -c public/js/chat.js` + `npm test`

## Task 1.5: 新增草稿 e2e

**文件：** 新增 `tests/e2e-composer-draft.mjs`（范式抄 `tests/e2e-steer-bubble.mjs`：Playwright headless + 自起服务/stub，无需 token）

- [ ] **Step 1** 场景：会话 A 输入未发送文字 → `openConv(B)` → 断言 `#prompt` 文本为空
- [ ] **Step 2** → `openConv(A)` → 断言草稿原样回来
- [ ] **Step 3** → 在 A 发送 → 切走切回 → 断言输入框为空（已发内容不复灌）
- [ ] **Step 4** 断言零 pageerror（同 panels-smoke 范式）
- [ ] **Step 5** 验证：改前 FAIL、改后 PASS（先跑一次确认它真能逮住 bug）

## Task 1.6: 移除工具态「打开历史」区域（⑤）

**决策（已定，可改）：** `#mdOpenFileBtn2`「📄 打开…」**保留并上提**（它是工具态唯一的直接选文件入口，与历史功能无关）；其余连逻辑一起删净。

**文件：** 修改 `public/index.html`、`public/css/markdown-tool.css`、`public/js/markdown-tool.js`、`public/app.js`

- [ ] **Step 1** `index.html:77-81`：删 `.md-history` 容器与 `.md-history-head`、`#mdHistoryList`；把 `#mdOpenFileBtn2` 移出，放到 `#toolsList` 之后的新容器（如 `<div class="tools-footer" id="toolsFooter" hidden>`）内
- [ ] **Step 2** `markdown-tool.css:405-492`：删 `.md-history` / `-head` / `-list`（含 3 条 `::-webkit-scrollbar`）/ `-item`（含 `:hover`/`.active`）/ `-name` / `-time`；`.md-history .btn`（`:488`）的视觉迁到新类 `.tools-footer .btn`
- [ ] **Step 3** `markdown-tool.js` 删常量 `MD_HISTORY_KEY`/`MD_HISTORY_MAX`/`MD_CACHE_MAX_ONE`/`MD_CACHE_MAX_TOTAL`（`:6-12`）、DOM 引用 `openHistoryPanel`/`historyList`（`:20/:22`）、方法 `loadHistory`/`saveHistory`/`updateHistory`/`renderHistory`/`handleHistoryClick`（`:527-660+`）
- [ ] **Step 4** 删接线：`:57` `this.history=`、`:71` 冷启动 `renderHistory()`、`:101` historyList click、`:297` `this.updateHistory()`。**保留** `:21` `openFileBtn2` 与 `:84` 的点击绑定
- [ ] **Step 5** `syncHistoryPanel`（`:209-215`）改为 `syncToolsFooter`：判定从「工具态 **且** 有历史」简化为「仅工具态」，目标元素换成 `#toolsFooter`；`:74` 的 `window._syncMdHistoryPanel` 与 `app.js:98` 的调用方同步更名（**桥本身保留** —— 工具态切换仍需同步该按钮显隐）；`:204` `showTool()` 内的调用同步改名
- [ ] **Step 6** 一次性清理老数据：模块初始化处加 `localStorage.removeItem('md-tool-history')`，注释写明**为什么**（该 key 按原 `MD_CACHE_MAX_TOTAL` 最多占 2MB 正文，与 `claude_convs`（含 Task 1.3 新增的 `draft`）共享 localStorage 配额，不清会永久挤压会话存储）+ 标注为一次性迁移清理、若干版本后可删
- [ ] **Step 7** 残留普查：`grep -rn "mdHistory\|md-history\|MD_HISTORY\|_syncMdHistoryPanel\|handleHistoryClick\|updateHistory\|renderHistory" public/ tests/` 应只剩预期结果。**注意本仓既有坑**：浏览器 id 隐式全局 `window.mdHistory` 会静默兜住引用了已删元素的代码（`settingsTabs`/`panelView` 已实锤两次），必须靠 grep + 零 pageerror 断言双保险
- [ ] **Step 8** 验证：`node -c public/js/markdown-tool.js` + `node tests/e2e-panels-smoke.mjs`（`:56`/`:65` 遍历工具态 + 零 pageerror）；手动切工具态断言无历史区域、打开按钮仍可用、打开 md 文件正常渲染；DevTools 确认 `md-tool-history` 已消失

**批次 1 交付物：** 用户走查侧栏滚动手感（55% 是否合适）+ 草稿隔离（含附件 chip 场景）+ 工具态无打开历史且打开按钮可用

---

# 批次 2 — ③ 自动切会话

## Task 2.1: 删除 focus 劫持（根因 A，主因）

**文件：** 修改 `public/js/tauri-init.js:177-187`

- [ ] **Step 1** 删除整个 `window.addEventListener('focus', …)` 块
- [ ] **Step 2** 在原处留注释说明**为何不能修回去**：`focus ≠ 点了通知`；`_pendingNotifyConvId` 由 `notifyUser`（`:190`）在**任务完成时无条件写入**（`chat.js:852-858`），而 focus 会被 alt-tab / 系统对话框 / 点任务栏触发 → 用户正在看的会话被拽走。任务完成提示改由桌面通知 + 侧栏红点 + 顶栏徽标承担（三者均已存在）
- [ ] **Step 3** `:190` 的写入点保留（备将来真拿到通知点击事件时消费），注释注明当前无消费方
- [ ] **Step 4** 验证：`node -c public/js/tauri-init.js`；手动跑一个任务至完成 → 切别的会话 → alt-tab 离开再回来 → 断言不跳

## Task 2.2: openConv 的 `_goChat()` 移到幂等早返之后（根因 C）

**文件：** 修改 `public/js/chat.js:708-709`

- [ ] **Step 1** 先普查依赖「同会话也要跳视图」的调用方：`chat.js:1856-1859`（askChip）与 `req-chat.js:274` 附近均已自行调 `_goChat()`，确认换序安全后再动（若发现新的依赖方，在该调用方补 `_goChat()`）
- [ ] **Step 2** 换序为 `if (id === currentConvId) return; _goChat();`，注释说明：幂等 openConv 被 3s 轮询/通知反复调用时，不得把用户从 tasks/settings/logs/req/optimize/markdown 面板拽回聊天
- [ ] **Step 3** 验证：手动在设置面板停留 → 让后台 run 完成 → 断言视图不被拽回；`node tests/e2e-panels-smoke.mjs`

## Task 2.3: req-view 轮询与 applyFetchedReq 补守卫（根因 B）

**文件：** 修改 `public/js/req-view.js`

- [ ] **Step 1** 新增 `isReqContextActive(data)`：`isReqViewActive() || getCurrentConvId() === data.convId`（需从 chat.js import `getCurrentConvId`，`chat.js:3193` 已导出，方向 req-view → chat.js 与既有 import 同向）
- [ ] **Step 2** `startBusyPolling`（`:763-776`）：在 `:772` 的 `if (epoch !== reqEpoch) return;` 旁补 `|| !isReqViewActive()`。注释写明**为什么 fetch 前的判定不够**：`reqEpoch` 只由 `openRequirement`（`:642`）递增，用户点侧栏会话行切走不改 epoch
- [ ] **Step 3** `applyFetchedReq` 的 dev/test 分支（`:702-716`）：调 `openRequirementChat` 前加 `if (!isReqContextActive(data)) { patchListEntry(data); return; }`（只更新侧栏，不导航）
- [ ] **Step 4** 同函数的 `_showView('req')`（`:717`）：加同样守卫（await 之后用户可能已离开）
- [ ] **Step 5** 复查另 5 个直调 `applyFetchedReq` 的推进回调（`:967/1924/1961/2110/2277`）在新守卫下行为是否仍正确——**这些是用户手势触发的，应当允许导航**；若守卫误伤，给 `applyFetchedReq` 加 `{ allowNav = false }` 选项，用户手势路径显式传 true
- [ ] **Step 6** 验证：手动打开 busy 中的需求文档页 → 立刻点侧栏别的会话 → 等 ≥3s → 断言不被拽回；再验证「定稿成功」仍能正常跳进开发会话

## Task 2.4: req-chat 自动发 develop 提示词补目标校验（同族真 bug）

**文件：** 修改 `public/js/req-chat.js:125-127`

- [ ] **Step 1** 在 epoch/reqId 双查之外补 `getCurrentConvId() === data.convId`，否则 return（不发）
- [ ] **Step 2** 注释写明风险：`sendMessageProgrammatically`（`chat.js:2538-2545`）以 `currentConvId` 为目标，用户在 mount 与发送之间切走会把开发提示词发进**错误的会话**
- [ ] **Step 3** 验证：`node -c public/js/req-chat.js` + `npm test`

**批次 2 交付物：** 用户走查三个自动跳场景（任务完成后 alt-tab / 需求 busy 中切走 / 面板停留时 run 完成）

---

# 批次 3 — ④ 优化汇总

## Task 3.1: 修字段 bug（缺口 B/C —— 汇总当前必然失败的根因）

**文件：** 修改 `public/js/req-view.js`

- [ ] **Step 1** `:1232` `resolve(conv.messages[i].content)` → `.text`（conv-store 存的字段是 `text`，见 `conv-store.js:43`）
- [ ] **Step 2** 局部 `addMessage(convId, msg)`（`:1256-1267`）：改为复用 `conv-store` 的 `convPushMessage(convId, role, text)` 守护 API（顺带解决 `:1266` 「不 saveConvs」导致消息从未落盘的问题）。若保留本地函数，则必须写 `text` 字段 + 显式 `saveConvs`
- [ ] **Step 3** 给 `extractPitfallsBlock`（`:1344`）加空值防御（现状 `text.match` 对 `undefined` 直接抛 TypeError）
- [ ] **Step 4** 验证：归档期点「优化汇总」→ 断言能走到 reduce 完成 + 避坑清单预览弹层（**改前必然失败，改后应通过**）

## Task 3.2: sendMessageBackground 支持可见气泡（缺口 A）

**文件：** 修改 `public/js/chat.js:3203-3270`

- [ ] **Step 1** 签名扩为 `sendMessageBackground(convId, text, opts = {})`，新增 `opts.displayText`
- [ ] **Step 2** 在推助手占位（`:3225`）**之前**先落库用户消息：`convPushMessage(convId, 'user', opts.displayText || text)`（现状用户 prompt 完全没落库，"汇总了哪些内容"从根上无处可查）
- [ ] **Step 3** 若 `convId === currentConvId`：按 `sendMessageProgrammatically`（`:2549-2575`）已验证的序列补上屏——`addMessage('user', …)` + `addMessage('assistant','')` + `updateComposerRunning()` + `renderConvListDebounced()` + `paintJob(job)` + `ensureTyping()`
- [ ] **Step 4** **严格保证用户消息与助手占位的落库/上屏成对**，维护「存储=DOM=`_bubbleMap` 三方同序」不变量；非当前会话仍只落库（DOM 不属于它，`openConv` 会整体重建并经本地 job 分支 `paintJob`）
- [ ] **Step 5** 核查其他 `sendMessageBackground` 调用方（`req-view.js:1149/1171` 之外若有）在新增用户消息后行为是否受影响
- [ ] **Step 6** `req-view.js` 的 map/reduce 调用处传 `displayText`：map 传 `[汇总 i/n] 会话《title》`，reduce 传 `[汇总] 聚合 n 份小结` —— **不要把 30KB 转录塞进气泡**
- [ ] **Step 7** 验证：归档期点汇总 → 断言对话区实时出现气泡与流式输出（改前一个字都不画）

## Task 3.3: 归档期进度可视化

**文件：** 修改 `public/js/req-view.js` + `public/app.css`

- [ ] **Step 1** 模块级 `retroProgress = { total, current, title, failed, phase:'idle'|'map'|'reduce'|'done' }`（模块级持久化，遵循 `req-view.js:31` 草稿范式，重建时原样回填）
- [ ] **Step 2** `renderArchivingPage`（`:893`）在按钮行上方插进度块（阶段 + `[i/n]` + 当前会话标题 + 失败计数）；`phase==='idle'` 时不渲染
- [ ] **Step 3** map 循环（`:1105`）/ reduce（`:1169`）每步更新 `retroProgress` 并局部重渲进度块（不整页重渲，避免抹掉 `archiveNoteDraft` 焦点）
- [ ] **Step 4** app.css 加 `.req-retro-progress` 样式（对齐既有 `.req-archive-*` 视觉）
- [ ] **Step 5** 验证：跑一次真实汇总，断言进度条从 `[1/n]` 推进到 done、失败会话计入 failed

## Task 3.4: retro 会话入口（缺口 D）

**文件：** 修改 `public/js/req-view.js`

- [ ] **Step 1** 归档页按钮行加「🔍 查看汇总会话」，`retroConvId` 取自 `req.sessions` 中 `kind==='retro'` 的最新一条；无 retro 会话时按钮不渲染
- [ ] **Step 2** 点击 → `openConv(retroConvId)`；随后若该 conv 无内容且该 session 有 `sessionId`，调既有 `loadReqTranscript(convId, sessionId, cwd)`（`chat.js:2586`，自带「有实时流/已有内容」护栏 + `_reqTranscriptTried` 去重）从磁盘转录回放
- [ ] **Step 3** import 补 `loadReqTranscript`（`req-view.js:6` 当前只 import 了 `openConv, createReqConv, isConvRunning`）
- [ ] **Step 4** `:1136` 的截断 toast 文案改为准确指向（缺口 B 修好后「详见 retro 会话消息」才名副其实）
- [ ] **Step 5** 验证：汇总跑一半刷新页面 → 点「查看汇总会话」→ 断言磁盘转录被回放出来（`GET /api/history/:sid?cwd=` 已验证可用：retro 的 sessionId 确实落在 `requirements.json` 的 `sessions[kind==='retro']`）

## Task 3.5: 收口验证

- [ ] **Step 1** `npm test` 全绿
- [ ] **Step 2** 四道 e2e 门禁 + 新增的 `e2e-composer-draft.mjs` 全过
- [ ] **Step 3** 走查清单交付用户

**批次 3 不做（列 P2，需单独拍板）：** retro 报告落盘（缺口 E，要新增 `POST /api/req/retro`，与 `2026-08-11` spec 的「刻意不放 `req.archive.retro`」决策相悖）；retro 编排搬后端（换取关页续跑，等于重写这条流程）

---

---

## 实施结果（2026-08-25 三批次全部完成，未提交）

**改动文件**：`public/app.css`、`public/app.js`、`public/index.html`、`public/css/markdown-tool.css`、
`public/js/{chat,composer,conv-store,req-view,req-chat,tauri-init,markdown-tool}.js`
**新增测试**：`tests/e2e-composer-draft.mjs`、`tests/e2e-no-auto-switch.mjs`、`tests/e2e-retro-summary.mjs`
（三个都做过「回退到 HEAD 必 FAIL」验证，确认不是永远通过的空测试）

### 与 plan 的偏差（都有理由）

1. **Task 2.2 没按「换序」做，改为给 `openConv` 加 `nav` 选项**。普查发现裸换序会打坏两个用户手势：
   `chat.js` 侧栏会话行、`req-view.js` 需求子会话行 —— 用户在设置面板点侧栏上「当前那个」会话，
   换序后同会话早返、视图不跳，表现为「点了没反应」。`nav` 方案让所有现存调用方行为零变化。
2. **Task 3.1 的截断提示没有「改成写 text 字段并 saveConvs」**，而是并进 map 步骤的 `displayText`。
   因为单独插一条只落库不上屏的消息会破坏「存储索引 = DOM 索引」不变量（本仓既有铁律），
   顺带把有 bug 的局部 `addMessage` 整个删掉。
3. **额外做了 plan 未列的加固**：未落地会话的草稿另存 `claude_draft_new`（否则「新对话」里
   打的字一点侧栏就蒸发）；composer 自管 debounce timer 以支持 cancel（修「输入后 300ms 内切会话，
   挂起的写回落到新会话」的竞态）；`restorePrompt` 给回填的 chip 补挂 `onerror`。
4. **`req-view.js` 的进度块判据加了 `reqId` 校验**，防止把上一个需求的进度画到另一个需求的归档页上。

### 两个被自己的测试逮住的实现错误（记录以免复发）

- **守卫过严**：`applyFetchedReq` 第一版传 `nav: allowNav`，导致用户明明盯着文档页、phase 推进到
  dev 后「会话切了但视图没切」，人停在 dev 期已不再渲染的 `#reqPage` 上。判据改为
  `mayTakeOverView = allowNav || onDocPage`（能看到文档页的人就该被带走）。
- **测试自己有 bug**：① `addInitScript` 每次 reload 都重跑，里面无条件 `localStorage.clear()`
  把「跨刷新存活」用例要验的数据抹了，看起来像产品 bug；② retro 测试用「最后一条 SSE」驱动，
  而 `done` 发出后下一步 run 立刻起流，导致 emit 打到下一条流上 —— 改按绝对索引驱动第 k 条。

### 根因 B 的实际影响面（比 spec 初判窄）

第一版 `e2e-no-auto-switch` 没能逮住 bug（HEAD 版也全绿）：旧代码轮询 tick 头部的
`!isReqViewActive()` 自杀检查在「用户切到别的视图」时确实生效。真正的盲区只有**一次 fetch 往返**
（用户恰在 `await fetchRequirement()` 飞行中切走）。测试改用 `page.route` 挂住 `/api/req/get`、
在挂住期间切视图再放行响应，才复现成确定性场景。

### ⚠️ 根因 A 只在桌面版生效

`tauri-init.js` 整块通知代码在 `if (isTauri)` 分支内，**浏览器不注册**。故：桌面版用户的
「任务完成后自动切会话」由 focus 劫持解释（已删）；纯浏览器用户则只可能是根因 B 的窄窗口。
待用户确认使用环境。

### 三件既存债（本轮未引入、逐一回退验证过）

| 债 | 表现 | 判定依据 |
|---|---|---|
| `chat.path.test.js` 2 例 | 期望 `.md` → 📄，实际已是 📝 | HEAD 版同样失败（2026-08-24 markdown-chip-click 漏改测试） |
| `e2e-panels-smoke` | 卡在 `#settingsTabs button[data-tab="lark"]` 30s 超时 | lark tab 已删，备忘早有记录 |
| `e2e-conv-notify` | `/claim` 后服务端收件箱未清空 | HEAD 版同样失败 |
| `e2e-req-review` | 「右栏缺设计准则输入框」 | 跑两次稳定失败；疑与未提交的 `req-uispec.js` 等右栏改造有关 |

### 环境备忘

- **9701 端口上的实例是打包版 sidecar**，服务 `src-tauri/resources/sidecar/public` 镜像目录（旧代码），
  拿它验证会看到「改了没生效」。要验真实 `public/` 得 `PORT=3000 node server.js`。
- **`localhost` 被本机 HTTP 代理截**（curl 实测 502），e2e 一律用 `127.0.0.1`。

---

## 已知不修项（记录备查）

- `#askChip` 目标不确定：`chat.js:1857` 取 `runningJobs` 键序第一个待确认会话，可能把用户送到没在看的会话
- `claude_last_conv` 跨窗共享：`chat.js:3155-3157` 启动恢复只校验 cwd，同 cwd 双窗时 B 窗会打开 A 窗最后开的会话
- `src/entrypoints/web/req-logic.js:375/402` 的服务端 retro prompt builder 是死代码（只被 `req-logic.test.js` 引用），当前用的是 `req-view.js:1277/1295` 的客户端版本

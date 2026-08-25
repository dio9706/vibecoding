# web 执行台四项修复设计（2026-08-25）

用户反馈四条，全部已完成根因定位（Phase 1 证据见每节「根因」，均逐行核验过真实代码，非推测）。

| # | 现象 | 层级 | 风险 |
|---|---|---|---|
| ① | 左侧栏「需求」中会话太多，无法滚动 | 纯 CSS | 低 |
| ② | 切会话时输入框草稿被带走，未按会话隔离 | 前端三层接线 | 中 |
| ③ | 任务完成或其他场景下经常自动切会话 | 前端导航守卫 | 中 |
| ④ | 归档期「优化汇总」进空对话、无进度、retro 会话无入口 | 前端编排 + 字段 bug | 中高 |
| ⑤ | 移除工具态侧栏的「打开历史」区域功能（用户追加要求） | 前端删除 | 低 |

---

## ① 侧栏需求区不能滚动

### 根因

`public/app.css:2778` 的 `.req-list` 规则只有 `padding / display:flex / flex-direction / gap / border-bottom / margin-bottom`：

```css
.req-list {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-bottom: 1px solid var(--border-soft);
  margin-bottom: 4px;
}
```

它是 `.sidebar`（`app.css:48`，`display:flex; flex-direction:column; height:100vh`）的列向 flex 子项，取默认 `flex: 0 1 auto`，而 flex 子项的 `min-height` 默认 `auto`（automatic minimum size）**把最小高度锁死在内容高度上，收缩算法收不动它**。于是：

- 需求条目一多 → `.req-list` 按内容无限撑高；
- 兄弟 `.conv-list`（`app.css:67`，`flex:1` 即 `flex-basis:0`）被优先榨干到 0；
- 溢出部分冒到 `.sidebar`，而 `.sidebar` **自身没有 overflow**（`overflow:hidden` 只出现在 `.sidebar.collapsed`，`app.css:150`）；
- 最终被 `body { overflow: hidden }`（`app.css:39`）静默裁掉 → **任何层都不产生滚动条**。

条目增长速度是关键放大器：`req-view.js:341` 的 `isExpanded = expandedReqs.get(r.id) ?? isExpandable` 让 dev/test 阶段需求**默认展开**，条目数 = 需求数 + 全部子会话数 + 每需求一个「＋新会话」行，都平铺在同一个 `#reqList` 里（`req-view.js:229-236` / `:366-373`）。

### 方案（选定：需求区限高独立滚动）

抄同一侧栏里对**同一个 bug** 已有的正解 —— `public/css/markdown-tool.css:405-432` 的 `.md-history` / `.md-history-list`（「外层限高 + 内层 `overflow-y:auto; min-height:0`」）。因 `.req-list` 自身既是限高层又是滚动层，两个属性合并到一条规则。

> ⚠️ 该参照物**将随本文 ⑤ 一并删除**，故下面把完整写法内联给出，不留「去看 md-history」的悬空引用；实施顺序也定为先 ①（还有参照物可比对）再 ⑤。

```css
.req-list {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-bottom: 1px solid var(--border-soft);
  margin-bottom: 4px;
  flex: 0 1 auto;
  min-height: 0;      /* 不加则按内容撑高，overflow 失效（同 app.css:1844 既有注释的坑） */
  max-height: 55%;    /* 需求区最多占侧栏 55%，不把下方普通会话区顶掉 */
  overflow-y: auto;
}
```

外加细滚动条样式（与被删的 `.md-history-list` 同规格，内联于此以免依赖将删代码）：

```css
.req-list::-webkit-scrollbar { width: 6px; }
.req-list::-webkit-scrollbar-track { background: transparent; }
.req-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
```

**`min-height:0` 与 `overflow-y:auto` 必须同时加**——只加前者会让它被压扁并静默裁内容（仍不能滚）。

不选的方案及理由：
- 「整个侧栏一条滚动区」需改 `index.html` 结构并重排 `.conv-list` 的 `flex:1`，牵动工具态 `#toolsList` / `#mdHistory` 的既有 flex 关系，风险与收益不匹配；
- 「可拖拽分割条」工作量最大且要处理折叠态/边界持久化，本轮不做。

若 55% 实际手感不对，只需改这一个数值，无副作用。

---

## ② 输入框草稿未按会话隔离

### 根因（三层各缺一环）

1. **存储层无字段**：conv 记录的形状定义在 `chat.js:647`（`{id,title,session,cwd,messages,updatedAt}`）+ `:657-663`（模型偏好快照）+ `:676-687`（`meta`），**没有 `draft`**；`conv-store.js` 也没有对应 setter（现有 setter 范式见 `conv-store.js:56/63/81/91`）。`loadConvs` 的 catch 退化成 `[]` 且无 schema 版本，新增字段天然向后兼容，**不需要迁移**。
2. **模块层无写入通道**：`composer.js` 全文 195 行没有 `input` 监听、没有 `localStorage`、没有 `convId` 概念；`promptEl`（`composer.js:3`）是页面级 contenteditable 单例。导出只有 `getPromptText`（`:14`，**有损**：把 `.att-chip` 拍平成裸路径，丢名字与缩略图）、`clearPrompt`（`:37`）、以及 chip 级插入 API —— **没有「整体写入」能力**，即使存了草稿也回填不了。
3. **切会话时既不存也不清（直接根因）**：`openConv`（`chat.js:707-766`）在 `:713` 切 `currentConvId`、`:722` `applySessionPrefs(c)` 还原了模型/模式、`:726-729` 重建了消息 DOM，**全程没有一行触碰 `#prompt` 的内容**。`#prompt` 是页面级单例 → 旧会话的未发送内容原样留在新会话。同缺口还有 `newConversation()`（`chat.js:767`，只清 `messagesEl`）与磁盘历史续接 `resumeHistorySession`（`chat.js:238-284`，该路径**不走 openConv**，`:257-259`/`:278` 已有「唯独这条路径漏了」的历史注释）。

`clearPrompt()` 在 chat.js 只被调 2 次（`:1961` send 后、`:2108` steer 后），均为「发送后清空」语义。

### 方案

照抄同文件已有的写穿范式 `persistPrefsToConv()`（`chat.js:693`，注释即写「杜绝切走再切回被还原」）。

**存储格式选 HTML 快照而非 `getPromptText()` 的纯文本**：纯文本会把附件 chip 拍平成裸路径，切回来后 chip 消失、只剩一串路径，是可感知的功能退化。

1. `composer.js` 新增两个导出：
   - `stashPrompt()` → 返回 `promptEl.innerHTML` 并清空，**但不 revoke blob URL**（`clearPrompt` 会 revoke，用它会让切回来的缩略图变裂图）；
   - `restorePrompt(html)` → `promptEl.innerHTML = html || ''`，并对 `.att-chip img` 补 `onerror` 兜底（页面刷新后 blob URL 必然失效，`makeChip` 的既有 `onerror` 只作用于新建节点，回填的节点要重新挂）→ 降级成文件图标，路径 `dataset.path` 仍在，发送语义不受影响。
   - 新增 debounced `input` 监听（300ms）调注入的写穿回调。
2. `conv-store.js` 新增 `convSetDraft(convId, html)`，照 `convSetSession`（`:56`）模板 —— **不动 `updatedAt`**，理由同 `chat.js:705` 注释（纯 UI 状态变更不该改左栏排序）。
3. `chat.js`：
   - 新增 `persistDraftToConv()`（镜像 `:693`），供 composer 的 input 监听调用（经 `bindComposerDraft()` 注入，遵循既有「禁止反向 import」的视图桥范式）；
   - `openConv`：在 `:713` 赋值 `currentConvId` **之前**用旧 id 存草稿（`stashPrompt()` 的返回值 → `convSetDraft(oldId, html)`），赋值后 `restorePrompt(c.draft)`；
   - `newConversation`（`:767`）：存旧会话草稿 + 清空输入框；
   - `resumeHistorySession`（`:238` 附近，`:261` 改 `currentConvId` 处）：同上；
   - `send()`（`:1961`）与 `steer()`（`:2108`）清输入框处同步 `convSetDraft(convId, '')` —— 否则重开会话会把已发出的内容又灌回去。

### 验证

新增 e2e `tests/e2e-composer-draft.mjs`（Playwright，范式同 `tests/e2e-steer-bubble.mjs`）：会话 A 输入未发送 → `openConv(B)` → 断言 `#prompt` 为空 → `openConv(A)` → 断言草稿原样回来 → 发送后重开 → 断言不复现。**当前草稿行为零测试覆盖**（`tests/e2e-panels-smoke.mjs:94-112` 等 4 个文件碰过 `#prompt`，但都不测草稿）。

---

## ③ 任务完成后自动切会话

三条独立原因，按严重度排列。当前会话状态是 `chat.js:289` 的模块级 `currentConvId`（只读出口 `getCurrentConvId()`，`chat.js:3193`）；视图状态是 `app.js:32` 的 `activeView`。

### 根因 A（主因）：桌面通知的 focus 劫持

`public/js/tauri-init.js:177-187`：

```js
window.addEventListener('focus', () => {
  const cid = window._pendingNotifyConvId;
  if (!cid) return;
  window._pendingNotifyConvId = null;
  setTimeout(() => { if (_nav.openConv) _nav.openConv(cid); }, 150);
});
```

写入点 `tauri-init.js:190`（`notifyUser` 一被调用就写，**与通知是否真弹出、是否被点击无关**），而 `notifyUser` 的调用方正是**任务成功完成**：`chat.js:852-858`。

失败链路（与「任务完成或其他场景下经常自动切会话」逐字吻合）：
1. 会话 A 的 run 跑完 → `_pendingNotifyConvId = A`；
2. 用户**没点通知**，继续在界面里打开会话 B 干活；
3. 用户 alt-tab 去 IDE / 点了系统文件对话框 / 点任务栏图标回来 → **窗口 focus** → `openConv(A)` → 界面被拽回 A。

`focus ≠ 点了通知`。这是一个永不过期、无来源校验、被 run 完成事件持续写入的待跳转槽位。retro map-reduce（`req-view.js:1149/1171` 反复发消息，每段完成都触发 `endJob`）会让它高频命中。

### 根因 B：req 文档页 3s 轮询在 await 之后无视图守卫

`req-view.js:763-776` `startBusyPolling`：自杀判定 `!isReqViewActive()` 在 **fetch 之前**（`:766`），渲染发生在 **fetch 之后**（`:774 applyFetchedReq`），中间只补查 `epoch`（`:772`）—— 而 `reqEpoch` 只由 `openRequirement`（`:642`）递增，**用户点侧栏会话行切走并不会改 epoch**。于是：

- phase 是 review/archiving → `req-view.js:717 _showView('req')` → 视图被拽回需求文档页；
- phase 是 dev/test → `:713 openRequirementChat` → `:755 openConv(需求 conv)` → 被切到别的会话。

同一条 `applyFetchedReq` 还被 5 个「流程推进完成」回调直调（`req-view.js:967/1924/1961/2110/2277`），其中 `:1961`（定稿成功）就是典型的「任务完成后自动跳到需求开发会话」。

### 根因 C：`openConv` 的 `_goChat()` 放在幂等早返之前

```js
export async function openConv(id) {
  _goChat();                          // chat.js:708
  if (id === currentConvId) return;   // chat.js:709
```

任何「幂等 openConv」（`req-view.js:755` 在 3s 轮询里反复调、根因 A 的 focus 跳转、`req-chat.js:274` 注释明确说的「conv 未变时早返」）**仍会强制把视图从 tasks/settings/logs/req/optimize/markdown 面板拽回聊天视图**。这是用户感知的「莫名跳走」的另一半（视图跳，非会话跳）。

### 方案（选定：彻底不自动跳 + 补守卫）

1. **删除 focus 劫持**（`tauri-init.js:177-187`）。任务完成的提示保留三条现有非侵入通道：桌面通知、侧栏红点、顶栏徽标。`_pendingNotifyConvId` 仅保留给「未来真能拿到通知点击事件」时用，当前不消费（写入点保留但加注释说明为何不再由 focus 消费，防后人「修回去」）。
2. **`openConv` 的 `_goChat()` 移到幂等早返之后**（`chat.js:708` ↔ `:709` 换序）。需核查依赖「同会话也要跳视图」的调用方——`chat.js:1856-1859`（askChip）与 `req-chat.js:274` 附近均已自行调 `_goChat()`，换序安全。
3. **req-view 轮询补 await 后守卫**：`startBusyPolling` 在 `:772` 的 epoch 复查旁加 `!isReqViewActive()` 复查；`applyFetchedReq` 的 dev/test 分支（`:702-716`）在调 `openRequirementChat` 前加「用户仍在该需求上下文」判定 —— 新增 `isReqContextActive(id)`：`activeView === 'req'` 或 `getCurrentConvId() === data.convId`。不满足则只 `patchListEntry` 更新侧栏，不导航。
4. **`req-chat.js:127` 自动发 develop 提示词补目标校验**：加 `getCurrentConvId() === data.convId`（现状只查 epoch/reqId，会把开发提示词发进**错误的会话**，因为 `sendMessageProgrammatically`（`chat.js:2538-2545`）以 `currentConvId` 为目标）。这是同族的真 bug，一并修。
5. 顺带记录不修的两项（本轮不动，写进 spec 备查）：`#askChip` 目标不确定（`chat.js:1857` 取 `runningJobs` 键序第一个待确认会话）、`claude_last_conv` 跨窗共享导致启动恢复错会话（`chat.js:3155-3157`）。

### 验证

- 手动：跑一个任务至完成 → 切到别的会话 → alt-tab 离开再回来 → 断言不跳；
- 手动：打开 busy 中的需求文档页 → 立刻点侧栏别的会话 → 等 ≥3s → 断言不被拽回；
- 手动：在设置/任务面板停留时让后台 run 完成 → 断言视图不被拽回聊天；
- e2e：`tests/e2e-panels-smoke.mjs` 的零 pageerror 断言兜底回归。

---

## ④ 归档期「优化汇总」空对话 / 无进度 / retro 无入口

### 调用链（全前端编排，无服务端参与）

```
req-view.js:923  「✨ 优化汇总」按钮（renderArchivingPage）
  └─ :980 startRetroSummary(reqId)
       ├─ :992  GET /api/req/pitfalls/get?dir=…   拉现有避坑清单
       ├─ :998  createReqConv({kind:'retro', title:'优化汇总'})  → chat.js:674 建本地 conv
       ├─ :1009 POST /api/req/session             → routes-requirements.js:414 登记 sessions[]
       ├─ :1021 openConv(retroConvId)             → 此刻 messages=[] → 用户看到空对话
       └─ :1027 runRetroMapReduce(...)            （无 await，前端全程编排）
              MAP 循环 :1105
                ├─ :1107 progress = `[${i+1}/${validSessions.length}]`   ← 用户看到的 [10/21]
                ├─ :1111 GET /api/history/<sessionId>?cwd=…
                ├─ :1130-1143 >30000 字符 → 截断 + toast + addMessage(截断提示)
                ├─ :1149 sendMessageToConv → chat.js:3203 sendMessageBackground
                └─ :1152 waitForRunCompletion(retroConvId)
              REDUCE :1169-1189 → 同上 → extractPitfallsBlock → 预览弹层 → POST /api/req/pitfalls
```

因为 run 由**前端** `/api/run/start` 发起（不是服务端 `startClaudeRun`/`dispatchSystemTask`），`req.busy` **永远不会被写**（busy 只在 `requirement-ops.js:284`/`:356` 落盘）—— 这决定了既有的 busy 驱动补救通道对 retro 结构性不适用。

### 根因（五个缺口，其中 C 是致命 bug）

**缺口 A —— 后台 run 只写存储不上屏（"空对话"的直接成因）**
`chat.js:3203 sendMessageBackground`：
- `:3225-3227` 只 `convPushMessage` 助手占位（写 localStorage），**从不建 DOM 气泡**；
- **用户 prompt 完全没落库**（只 push 了 assistant），所以「汇总了哪些内容」从根上无处可查；
- `:3256` `attachStream(convId, job.asstIndex, d.runId, job)` —— 因为**传了 `job`**，正好绕过 `attachStream` 内唯一会补气泡/起画的分支 `chat.js:2261-2282`（`if (!job) { … paintJob(job); ensureTyping(); }`）；
- 也从不调 `updateComposerRunning()` / `renderConvList()`；
- 于是流事件里的 `paintJob`（`chat.js:1730`）首行 `bubbleAt(job.asstIndex)` 在空会话里取不到气泡 → 直接 return。**整个 map-reduce 期间对话区一个字都不画**（无 spinner、无工具行、无 Todo 面板），用户只看到 toast。

**缺口 B —— 截断提示那条消息压根没写进会话（"没有入口"的直接原因）**
`req-view.js:1256-1267` 的局部 `addMessage(convId, msg)`：
- `:1262` 推入 `{role, content}`，而 conv-store 的消息字段是 **`text`**（`conv-store.js:43` `c.messages.push({role, text})`，渲染侧 `chat.js:729 addMessage(m.role, m.text, m)`）；
- `:1266` 注释「不调 saveConvs，由上层决定」，而调用方 `:1139` **从没保存**。
→ tips 说的「详见 retro 会话消息」所指的那条消息**从来不存在**。

**缺口 C（致命）—— `waitForRunCompletion` 读错字段，汇总必然失败**
`req-view.js:1232` `resolve(conv.messages[i].content)` —— 同样应为 `.text`。后果链：
`mapMessages.push({content: undefined})`（`:1153`）→ `buildClientRetroReducePrompt` 拼出 `1. undefined`（`:1298`）→ `reduceResult === undefined` → `extractPitfallsBlock(undefined)` 在 `:1344 text.match(...)` 抛 TypeError → `:1191` toast「reduce 阶段失败」。
**即当前每一次优化汇总都在最后一步必然失败，且 `currentReq.retro` 永不赋值。**

**缺口 D —— 既有两条补救通道都不覆盖 retro**
`req-chat.js:134-135` 只认**主会话**的 `data.convId` / `data.devSession`；retro 的 `convId`/`sessionId` 在 `data.sessions[]` 里，且 retro 的 `req.busy` 恒为 null。`req-view.js` 全文**没有任何** `ensureConvRunAttached` / `loadReqTranscript` 调用（`:6` 只 import 了 `openConv, createReqConv, isConvRunning`）。所以「跑完 → 关页 → 重开」也无法回放。

**缺口 E —— 报告不落盘**
`req-view.js:1176-1179` `currentReq.retro = report` 只改内存；`routes-requirements.js:617-642` 路由表无任何 retro 持久化端点（`docs/superpowers/specs/2026-08-11-requirement-session-group-design.md:184` 还明确写了「刻意不放 `req.archive.retro`」）。归档一刷新报告即丢。

**好消息（决定了方案不必碰后端）**：retro 的 `sessionId` 回填链路是通的 —— `chat.js:2305-2335` 的 SSE `session` 事件只要 `conv.meta.reqId` 存在就 `POST /api/req/session`，服务端 `routes-requirements.js:443` 首次补齐 `existing.sessionId`（`kind!=='main'` 故不会误写 `devSession`，`:459-462`）。所以 `requirements.json` 的 `sessions[kind==='retro'].sessionId` 与磁盘 `~/.claude/projects/<enc(cwd)>/<sid>.jsonl` 都是真实存在的，`GET /api/history/:sid?cwd=`（`routes-ops.js:135`）就能读出来。

### 方案（选定：前端最小可用修复，不动后端）

1. **修字段 bug（缺口 B/C）**：`req-view.js:1232` `.content` → `.text`；局部 `addMessage`（`:1256`）改为写 `{role, text}` 并**显式 `saveConvs`**（或直接复用 `conv-store` 的 `convPushMessage`，更符合单一守护 API 原则）。这一条单独就能让汇总流程真正跑完。
2. **让 map/reduce 可见（缺口 A）**：`sendMessageBackground(convId, text, opts)` 加 `opts.displayText`：
   - 落库用户消息（存 `displayText || text`，retro 传简短的 `[汇总 3/21] 会话《xxx》` 而非 30KB 转录，避免气泡爆炸）；
   - 若 `convId === getCurrentConvId()`：`addMessage` 建用户 + 助手两个 DOM 气泡、`paintJob(job)`、`ensureTyping()`、`updateComposerRunning()`、`renderConvList()` —— 走 `sendMessageProgrammatically`（`chat.js:2549-2575`）已验证的可见路径序列；
   - 若不是当前会话：仍只落库（DOM 不属于它，用户切回时 `openConv` 会整体重建并经本地 job 分支 `paintJob`，存储索引=DOM 索引不变量成立）。
   - **必须保证用户消息与助手占位的落库/上屏成对**，维护「存储=DOM=`_bubbleMap` 三方同序」不变量（`conv-store.js` 的守护 API）。
3. **归档期加进度可视化**：模块级 `retroProgress = { total, current, title, failed, phase:'map'|'reduce'|'done' }`，`renderArchivingPage`（`req-view.js:893`）在按钮行上方渲染进度条（阶段 `[i/n]` + 当前会话标题 + 失败计数），编排循环每步更新并局部重渲。当前归档页**没有任何进度/入口元素**（只有 chips 条、提示、归档预览、备注 textarea、两个按钮）。
4. **加 retro 会话入口（缺口 D）**：
   - 归档页按钮行加「🔍 查看汇总会话」→ `openConv(retroConvId)`（retroConvId 从 `req.sessions` 里找 `kind==='retro'` 的最新一条）；
   - retro 会话内容为空且有 `sessionId` 时调既有 `loadReqTranscript(convId, sessionId, cwd)`（`chat.js:2586`，自带「有实时流/已有内容」护栏）从磁盘转录回放；
   - 侧栏树的 retro 行（`req-view.js:382/399/459`，🔍 图标）点进去同样受益。
5. **修 tips 文案**：`req-view.js:1136` 的「详见 retro 会话消息」在缺口 B 修好后才名副其实；文案改为指向明确的「已截断，完整转录见会话《x》」。
6. **缺口 E（报告落盘）本轮不做**，列为 P2：需新增 `POST /api/req/retro` 端点，且与 `2026-08-11` spec 的「刻意不放」决策相悖，需单独拍板。当前替代手段是入口 4 的磁盘转录回放（永久可查）。

不选「搬到后端编排」的理由：那等于重写这条流程（走 busy+runId 系统任务通道换取关页续跑），改动量与本轮四项修复不成比例，宜在 retro 功能真正稳定后另起一轮。

### 验证

- 手动：归档期点「优化汇总」→ 断言对话区实时出现 `[1/n]`…气泡与流式输出、进度条随之推进、reduce 阶段能走到避坑清单预览弹层（**当前必然失败，修后应能通过**）；
- 手动：汇总跑到一半刷新页面 → 点「查看汇总会话」→ 断言磁盘转录被回放出来；
- 单测：`extractPitfallsBlock` 对 `undefined`/空串的防御（现状直接抛 TypeError）加纯函数测试。

---

## ⑤ 移除工具态侧栏的「打开历史」区域

用户追加要求：移除「工具中打开历史的区域功能」。指的是侧栏工具态下方的 Markdown 工具打开历史面板。

### 现状牵连面（已全量 grep 核验）

| 层 | 位置 | 内容 |
|---|---|---|
| HTML | `public/index.html:77-81` | `<div class="md-history" id="mdHistory" hidden>` = 标题「打开历史」+ `#mdHistoryList` + **`#mdOpenFileBtn2`「📄 打开…」** |
| CSS | `public/css/markdown-tool.css:405-492` | `.md-history` / `-head` / `-list`（含 `::-webkit-scrollbar` 三条）/ `-item`（含 `:hover`/`.active`）/ `-name` / `-time` / `.md-history .btn`，约 90 行 |
| JS 常量 | `markdown-tool.js:6-12` | `MD_HISTORY_KEY='md-tool-history'`、`MD_HISTORY_MAX=10`、`MD_CACHE_MAX_ONE=512KB`、`MD_CACHE_MAX_TOTAL=2MB` |
| JS DOM 引用 | `markdown-tool.js:20/21/22` | `openHistoryPanel` / `openFileBtn2` / `historyList` |
| JS 逻辑 | `markdown-tool.js:527-561`(load/saveHistory) `:567-592`(updateHistory) `:595-626`(renderHistory) `:628-660+`(handleHistoryClick) `:209-215`(syncHistoryPanel) | 约 120 行，含 localStorage 配额降级策略 |
| JS 接线 | `:57`(`this.history=`) `:71`(冷启动 renderHistory) `:74`(`window._syncMdHistoryPanel`) `:84`(openFileBtn2 绑定) `:101`(historyList click) `:204`(showTool 内 sync) `:297`(openFile 后 updateHistory) | — |
| 跨模块桥 | `public/app.js:98` `window._syncMdHistoryPanel?.()` | 侧栏「会话/工具」态切换时回调 |
| 持久化数据 | localStorage key `md-tool-history` | **最多 2MB 正文缓存** |

### 两个决策（默认已定，可改）

**决策 1：`#mdOpenFileBtn2`「📄 打开…」保留并上提。** 它是待删容器的子元素，但功能上与历史无关 —— 是工具态侧栏里唯一的「直接选文件」入口（另两个入口：`#toolMarkdown` 工具项进面板、面板空态的 `#mdOpenFileBtn`）。删掉它会让打开文件从一步变两步，属于无谓的功能退化。方案：把它移出待删容器，放到 `#toolsList` 下方独立容器（沿用 `.md-history .btn` 的既有视觉，样式改挂新类名）。

配套逻辑反转：`syncHistoryPanel`（`:209-215`）的判定「侧栏处于工具态 **且** 有历史才露出」中的历史条件失去意义，改为「仅工具态露出」，函数更名 `syncToolsFooter`；`window._syncMdHistoryPanel`（`:74`）与 `app.js:98` 的调用同步更名（保留桥本身，因为工具态切换仍需同步该按钮的显隐）。

**决策 2：连逻辑一起删净**（而非只藏 UI）。留 200 行死码只会让后人误以为功能仍在；`?.` 护栏虽能兜住空元素，但 `updateHistory`（`:297` 每次打开文件都调）仍会持续往 localStorage 写 2MB 缓存。

### 附带收益：清理 localStorage 老数据

`md-tool-history` 按 `MD_CACHE_MAX_TOTAL` 最多占 **2MB**，而 localStorage 总配额通常 5MB，且与 `claude_convs`（会话记录 —— 本文 ② 还要往里加 `draft` 字段）**共享同一配额**。因此移除时必须做一次性清理 `localStorage.removeItem('md-tool-history')`（放在 `markdown-tool.js` 模块初始化处，带注释说明为一次性迁移清理、可在若干版本后删除），否则老用户浏览器里这 2MB 垃圾永久占着，反过来挤压草稿与会话存储。

### 验证

- `node tests/e2e-panels-smoke.mjs`（`:56`/`:65` 会切换 `_setSidebarToolsMode(true/false)` 遍历工具态，零 pageerror 断言可逮住残留引用）；
- 手动：切工具态 → 断言无「打开历史」区域、「📄 打开…」按钮仍在且可用 → 打开一个 md 文件 → 断言正常渲染、无控制台报错；
- 手动：DevTools 确认 `localStorage` 中 `md-tool-history` 已消失。

---

## 交付与验证策略

分三批，每批交付后由用户走查，通过再进下一批（低风险优先，便于隔离回归）：

- **批次 1（①②）**：CSS 一处 + 草稿三层接线 + 新 e2e。
- **批次 2（③）**：删 focus 劫持 + `_goChat` 换序 + req-view/req-chat 守卫。
- **批次 3（④）**：字段 bug + 可见气泡 + 进度条 + retro 入口。

全程遵循：`npm test`（现 595+ 测试）必须全绿；四道 e2e 门禁（steer-bubble / ask-chip / one-window / sidebar-groups）不得回归；**不 git 提交**，改动留工作区。

只碰 `public/`（app.css、index.html、js/*）与 `src/entrypoints/web/`（本轮预期为零）；`src-tauri` 下的前端镜像不碰（build 时重生）。

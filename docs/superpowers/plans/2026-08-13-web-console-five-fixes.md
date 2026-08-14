# Web 执行台五项问题：根因与实施计划

日期：2026-08-13
状态：**待拍板**（P0 方案已确定，P1 有两处语义待定）

---

## 摘要

用户反馈 5 项问题，经系统化调查后分为两类：

| # | 问题 | 性质 | 根因是否锁定 |
|---|---|---|---|
| 5 | API 文档上传报错、没生效 | **纯 bug** | ✅ 已锁定并验证 |
| 4 | 会话标题全是「新会话」 | **纯 bug** | ✅ 已锁定并验证 |
| 3 | 需求下拉自动收起、箭头不变 | **纯 bug** | ✅ 已锁定并验证 |
| 2 | 飞书通知没触发 | **配置死锁 + 产品语义待定** | ✅ 已锁定（非"没实现"） |
| 1 | BUG 面板补充信息 | **新功能** | — 待定语义 |

P0（3/4/5）三处改动互相独立、面积小，建议先修先验。
P1（1/2）需要用户先定语义再动手。

---

## P0-1｜问题 5：API 文档上传完成后报错

### 根因（已验证）

`public/js/req-chat.js` 的 `renderDevRail`（:368）内部两处引用了**未声明的变量 `epoch`**：

- `:414` 删除路径
- `:464` 上传路径

`renderDevRail` 签名为 `(data, { draft, hadFocus } = {})`，无 `epoch` 形参；模块级变量只有
`bannerEl / railEl / currentReqId / chromeEpoch / busyTimer / expandedBugIds`（:38-43），也没有 `epoch`。
其余 7 处 `const epoch = chromeEpoch`（:92/:263/:554/:585/:723 等）全在**别的函数**里。

该文件经 `public/app.js:15` 以 `<script type="module">` 加载 → 模块天然严格模式 → 读未声明绑定**抛 `ReferenceError`**，
不会隐式建全局。

**为什么表现为"上传失败"**：异常发生在 `:461` 登记成功**之后**，被 `:474` 的 catch 抓住，
弹出误导性的 `API 文档上传失败：epoch is not defined`。
**文件其实已写盘、`apiDocs[]` 也已落库**，服务端两次请求都是 200/202，所以服务端日志里查不到任何错误。

**为什么表现为"没生效"**：异常抛在 `sendMessageProgrammatically(apiFixText)`（:472）**之前**。
自 2026-08-05「开发期会话化」重构后，服务端已不再 `enqueueSystemTask('api-fix')`
（`req-logic.js:119` 的 `buildApiFixPrompt`、`requirement-ops.js:224` 的 `api-fix` 分支均已成死代码），
前端这条消息是新上传文档的**唯一消费入口**。消息没发出去 = 文档没有任何人读。

删除路径（:399-422）同病且更隐蔽：**没有 try/catch** → 未捕获 rejection → 连 toast 都不弹，
且 `refreshRail`（:421）被跳过 → 服务端已删除但右栏那行不消失。

### 修复方案

1. **`renderDevRail` 函数体开头加 `const epoch = chromeEpoch;`**
   语义正确性已核实：`chromeEpoch` 仅在 `unmountReqChrome`(:56) 与 `mountReqChrome`(:91) 自增，
   `renderChrome / renderRail / refreshRail → renderDevRail` 全程不改它。
   因此"渲染时刻的世代号"就是正确的过期判据——只要没换需求/没卸载，闭包里的 `epoch` 一直有效。
2. **删除路径（:399-422）补 try/catch**，与上传路径对齐，失败弹 toast 而非静默。
3. **发消息前检查会话就绪**：`sendMessageProgrammatically`（`chat.js:1927-1928`）在 `!currentConvId` 时
   **静默 return**。照抄 `req-chat.js:521` guidelines 确认按钮的写法先校验 `data.convId`，
   否则修好 `epoch` 后仍会在会话未就绪时无声吞消息，复现"没生效"。

### 测试

新增 jsdom 单测，直接驱动 `renderDevRail` 的 file-input change：
mock fetch 依次返回 `{path}` / `{ok, action, doc}`，断言 `sendMessageProgrammatically` 被调用一次。

> 现状：`routes-requirements.test.js:247-271` 服务端全绿（所以这个 bug 测不出来）；
> `handleUpload` 无测试；`req-chat.js` 无前端单测；e2e 只断言右栏文本含「API 文档」，从不点上传。
> 这两行正好落在测试真空区。

---

## P0-2｜问题 4：会话标题全是「新会话」

### 根因（已验证）

写入是通的，**断在每次跑 run 时被覆盖**。

`public/js/chat.js:1711-1724`，SSE `session` 事件回填 sessionId 时**不传 `title`、也不传 `kind`**：

```js
body: JSON.stringify({ id: conv.meta.reqId, convId: conv.id, sessionId: data.session_id })
```

后端 `src/entrypoints/web/routes-requirements.js:410` 把缺失 title 兜底成 `'新会话'`：

```js
const title = data.title ? str(data.title) : '新会话';
```

再于 `:431` **无条件覆盖**：

```js
if (title && title !== existing.title) { existing.title = title; updated = true; }
// '新会话' !== '登录页修复' → 覆盖
```

→ `:452` 持久化。**任何跑过一次 run 的会话，标题都会被重置成「新会话」**，
包括 `normalizeSessions`（`store/requirements.js:68-80`）为老数据合成的、本该显示需求标题的 main 会话。
用户重命名后只要再发一句话就被打回。历史记录里还会留下 `会话登记 新会话`。

**连带 bug**：因为也没传 `kind`，`:411` 默认成 `'sub'`，导致 `:442` 的 `if (kind === 'main' && sessionId)`
永不成立 → main 会话的 `devSession` 从这条路径**回填不了**。

**次级断链**（让"重命名当场就不生效"）：
`req-view.js:502` 重命名成功后只调 `renderReqList()`，既不 patch 本地 `lastList` 也不重拉 `/api/req/get`，
从陈旧的 `lastList` 重渲 → 标题当场不变。`addNewSession`(:595) / `deleteSession`(:529) 同病。

### 修复方案

1. **后端 `routes-requirements.js:410`** 改为 `const title = data.title ? str(data.title) : null;`
   - `:431` 保持 `if (title && ...)`，title 为 null 时天然不覆盖（**只有显式传 title 才改标题**）
   - `:437` 新增分支里再用 `title || '新会话'` 兜底
   - `:452` 的历史文案同步处理 null
2. **前端 `chat.js:1715`** 补 `title: conv.title` 与 `kind: conv.meta.kind`（顺带修好 devSession 回填）
3. **`req-view.js:502/529/595`** 成功后就地 patch `lastList[].sessions` 或重拉 `/api/req/get`

### 测试

`routes-requirements.test.js` 现有 session 用例（:485-553, :634-667）**每个都显式传了 title**，
恰好绕开缺陷路径。新增用例：**不传 title 的 sessionId 回填，不得覆盖已有标题**。

---

## P0-3｜问题 3：需求下拉自动收起 + 箭头不随状态变化

### 根因（已验证）

**不是"收起"，是数据被抹掉。**

折叠内容的可见性不由 `expandedReqs` 决定，而由 `sessions.length` 决定（`req-view.js:361`）：

```js
if (isExpandable && isExpanded && sessions.length > 0) { /* push 子行 */ }
```

而 30s 轮询（`req-view.js:172-173` → `:188`）用 `/api/req/list` 的返回**整体替换** `lastList`：

```js
lastList = requirements || [];
```

该接口**不返回 `sessions`**（`routes-requirements.js:27-37`，对比 `handleGet:63` 是有的）
→ 子会话行全部消失，视觉上就是"自动收起"。

唯一会把 sessions 补回来的是 `patchListEntry`（:197-211，仅在打开单个需求时），
而开发期恰好把详情轮询关掉了（`:691-704` dev/test 分支 `clearInterval` 后 `return`）
→ **打开需求后最长 30s 树就消失，且此后无人补回**。首屏更明显：`app.js:110` 首次 `refreshReqList()` 本就没有 sessions。

**箭头不变的根因是同一个数据源打架**：
箭头字符看 `expandedReqs`（:311-321 `textContent = isExpanded ? '▾' : '▸'`），
内容看 `sessions.length`（:361）。sessions 被抹掉后箭头停在 ▾ 而下面空无一物；
点箭头只翻字符、没有子行可显隐 → 用户感知"箭头和状态无关、点了没反应"。

次因：DOM 上**没有任何展开态标记**（不是 class、不是 display、不是 open 属性，
而是"子行在不在 DOM 里"），CSS 无从写 rotate。
`public/app.css:2755-2767` 的 `.req-expand-arrow` 只有 `transition: color`，无 transform 规则。
且 `:307` 只看 phase 就渲染箭头 → 无会话时出现"永远点不动的箭头"。

### 修复方案

1. **根治数据源**：`routes-requirements.js:28-35` 的 `handleList` 补
   `sessions: normalizeSessions(r)`（函数已存在，`handleGet` 已在用）
2. **防御**：`req-view.js:188` 改为按 id merge，保留旧 `sessions`，不整体替换
3. **状态同源**：`:361` 的显示条件与箭头取同一状态源；无会话时不渲染箭头
   （照抄 `app.css:1779` `.jt-toggle.empty::before { content: '' }` 的做法）
4. **箭头落 DOM**：`arrow.dataset.expanded` / `row.classList.toggle('expanded')`，
   箭头改用 `.req-expand-arrow::before` + `[data-expanded="true"] { transform: rotate(90deg) }` + transition

### 参考范式（同仓库内已有正确实现）

- **JSON 折叠树**（最佳）：`public/js/json-tool.js:164` `classList.toggle('collapsed')` +
  `app.css:1777-1783` 箭头与内容由**同一个 class** 派生，结构上不可能不同步
- **测试期 BUG 卡**：`req-chat.js:43` 模块级 `expandedBugIds` Set，注释已写明
  "轮询每 3s 整栏重画，不这样做正在看的 detail 会被反复收起"

### 附带发现（可选修）

`.req-discarded-toggle`（`req-view.js:278`）在 `app.css` 中**没有任何选择器**
（只有 `.req-archived-toggle`），缺 `cursor:pointer` 与 hover 反馈。

---

## P1-1｜问题 2：飞书通知没触发

### 关键纠正：功能是完整实现且已接线的

5 个触发点全部在位，**没有任何 TODO / 未实现的桩**：

| 业务点 | 调用位置 |
|---|---|
| 任务完成（轻度托管） | `task-ops.js:143` `notifyTaskDone` |
| 任务完成（自动开发） | `auto-dev/index.js:161` |
| 会话 run 终结 | `conv-notify.js:37` `onRunSettled`（注册于 `server.js:214`） |
| 需求开发文档生成完成 | `requirement-ops.js:449` `sendDocgenNotify` |
| BUG 巡检完成 | 无独立通知，设计上并入自动开发回告路径 |

### 真正根因：配置缺失 + 先有鸡先有蛋的死锁

| 条件 | 当前值 |
|---|---|
| `uiPrefs.taskNotifyFeishu`（总开关） | **settings.json 无此键 → 默认 false** |
| `myFeishuOpenId`（收件人） | **settings.json 无此键 → 默认 ''** |
| 启用中机器人凭证（发件人） | ✅ 已配置齐全 |

死锁在 `routes-settings.js:83-88`：没填 open_id → `taskNotifyPrereqError` 返回错误
→ `:146-151` 回 `200 {ok:false}` → `tasks-panel.js:203-207` 拒绝点亮 chip 且不写盘
→ `taskNotifyFeishu` 永远是 false → `task-notify.js:42` 第一道守卫直接 return。
**这条链一次都没跑起来过。**

另一个易被忽略的点：**🔔 开关不在设置面板里**（任务级在任务面板筛选栏 `tasks-panel.js:176-215`，
会话级在聊天页浮动按钮 `index.html:457-461`），用户可能根本没找到。

### 「选机器人代替 open_id」只能满足一半

- **机器人 = 发件人**：这部分**已经全自动**（`task-notify.js:27-30` 直接取 `getActiveBot()`），用户本来就不用选
- **open_id = 收件人**：飞书 `im.v1.message.create` 必须有 `receive_id`（`lark.js:472-478`），
  选机器人**无法推导出"你是谁"**

### 待拍板：四选一

1. **自动捕获 open_id（推荐）**：机器人收消息时已能拿到 sender open_id
   （`channels/feishu.js:98` `data?.sender?.sender_id?.open_id`）。
   做成「给机器人发任意一条消息，自动登记为我的 open_id」，用户零输入。改动最小、最贴合诉求。
2. **选默认机器人 + 目标群**：`receive_id_type` 换 `chat_id`。
   现成模板是 `req.notifyBotId` 那套（`req-view.js:1633-1700` + `routes-requirements.js:154-156` +
   `requirement-ops.js:473-481`）。仍要选一个 ID，只是 open_id → chat_id。
3. **webhook 自定义机器人**：贴 URL 即可发群，无需 open_id / app 凭证。
   但全仓**零 webhook 支持**，属新增一整套集成，改动最大。
4. **只解死锁**：保留 open_id 输入框，允许先开开关后填 ID，并把通知开关收进设置页统一管理。

> ⚠️ 若做「默认机器人」下拉需先定语义：`bots` 目前是**单启用互斥**
> （`settings.js:137,150` 在 enabled=true 时强制禁用其他），
> 「默认机器人」与「启用中机器人」两个概念会打架。

> 📌 附带缺口：通知链路**没有 open_id 回退**。对比 `req-inspect.js:41-52` 的 `resolveInspectIdentity`
> （空则回退可信名单第一个），三条通知路径都硬要求 `myFeishuOpenId`。
> 且本机 `.env` 的 `OWNER_OPEN_IDS` 为空、bot 无 `trustedOpenIds` → 即使加回退也无处可退。

---

## P1-2｜问题 1：BUG 面板补充信息 + 重新识别改动逻辑

### 现状链路

⚠️ 项目有**两条独立的 BUG 巡检链路**，本需求落在链路 B：

| | 链路 A：飞书 `\10001` | 链路 B：Web 测试期 BUG 面板 ← 目标 |
|---|---|---|
| 编排 | `bug-patrol/index.js:82` | `req-inspect.js:166` `inspectBitable` |
| 产出落点 | **不落盘**（回飞书文案） | **落盘 `requirements.json` 的 `req.bugs[]`** |

**bug 记录结构**（`req-logic.js:139` `verdictToBug`）：
```js
{ id, recordId, title, detail, verdict: 'sure'|'doubt', reason,
  status: 'pending'|'fixing'|'fixed'|'ignored'|'failed', at }
```

- 前端面板：`req-chat.js:685` `renderTestRail` / `:612` `renderBugCard`
- 已有交互：确认修复 / 忽略 / 重试，统一走 `runBugAction`（:584），
  后端 `handleBugAction` 工厂（`routes-requirements.js:537`）
- **无任何编辑/补充入口**
- ⚠️ **既有缺口**：`reviewTask` 返回的 `scores`（含 `locatedAt` 定位结论、`evidence` 代码依据）
  在 `verdictToBug` 里**被丢弃了**，只留 `verdict` + `reason`。要展示"改动逻辑"必须先扩这个结构。
- ⚠️ `mergeBugs`（`req-logic.js:157`）按 `recordId` 去重且**已存在的原样保留不覆盖**
  → 重跑整体巡检不会更新已有条目，所以必须做单条重跑。

### 可复用的能力

- **重新识别**：`reviewRecordAsBug(record, {title, detail}, opts)`（`req-inspect.js:104`）
  + `reviewWithTimeout`（:82，5min 超时兜底）。
  底层 `reviewTask`（`review/index.js:18`）prompt 明确要求「定位到具体文件/函数/逻辑链」，
  输出 JSON 含 `located` / `locatedAt` / `evidence` —— **正是"改动逻辑"的形态**。
  该函数只吃 `{record_id}` + `{title, detail}`，与巡检上下文解耦，可直接单条调用。
- **写入原语**：`patchBug(reqId, bugId, patch)`（`req-inspect.js:221`，锁内读-改-写单条，需导出）

### 现成范式：任务面板「补充方案 → 提交并重新分析」

- 前端 `tasks-panel.js:368` `openFix()`：卡片内联展开 textarea，
  `ta.value = t.fixNote || ''` 回填已有补充，按钮「提交并重新分析」
- 后端 `routes-ops.js:72`：
  ```js
  const t = updateTask(task.id, { fixNote: data.fixNote || '', status: 'analyzing' }, '补充修正方案，重新分析');
  analyze(t).catch(...);   // fire-and-forget 重跑，不阻塞响应
  ```

### 待拍板：重新识别的语义（三选一）

1. **重跑评审并原地更新该条（推荐）**：补充信息并入 detail → 重跑 `reviewRecordAsBug`
   → 原地更新 verdict/reason/定位字段。存疑变确定后由用户再点确认修复。
2. **重跑评审 + 确定后自动入队修复**：省一次点击，但会自动起 Claude 改代码。
3. **只并入修复 prompt，不重跑评审**：改动最小（只改 `req-logic.js:128` `buildBugFixPrompt`），
   但用户看不到"重新识别"的结果反馈。

### 落地要点（无论选哪个都适用）

1. 扩 `req.bugs[]` 结构，契约注释在 `store/requirements.js:44`；
   建议一并把丢弃的 `scores.locatedAt/evidence` 保留下来
2. 路由照 `handleBugAction`（`routes-requirements.js:537`）形状加 `POST /api/req/bug/supplement`，
   多带 `note` 入参
3. **串行闸**：任何会起 Claude 的重跑必须走 `req.busy` 或 `enqueueSystemTask`，不能绕过。
   `busy.kind` 需在 `req-chat.js:244` `BUSY_KIND_LABELS` 加中文标签，否则芯片显示裸 key。
   `inspectBitable:183` 的「同步写 busy 在第一个 await 之前」是本仓库反复强调的纪律。
4. **前端草稿必须模块级持久化**：面板每 3s 整栏重画，
   参考 `expandedBugIds`（`req-chat.js:43`）与 `req-view.js:31` 的草稿方案，否则用户打字会被轮询清空
5. 按钮加在 `renderBugCard`（:612）actions 区，注意 `e.stopPropagation()`（卡片本身绑了展开点击）
6. **e2e 红线**：`tests/e2e-req-review.mjs:254` 明确「绝不点确认修复/重试/开始巡检」（会真起 Claude 调用），
   新增的重跑按钮在 e2e 里同样规避

---

## 建议实施顺序

1. **本轮**：P0-1 / P0-2 / P0-3 三处 bug（互相独立，可并行改，各配单测）
2. **下轮**：用户定完语义后做 P1-1（飞书）与 P1-2（BUG 补充信息），各自单独出 spec

> 按协作约定：改动只留工作区，不自动 git 提交。

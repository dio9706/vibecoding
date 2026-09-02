# Workflow 多智能体编排接入：设计文档

日期：2026-09-02  
状态：待维护者拍板（v2：两个开关并入模型选择器弹层）  
关键决策：客户端文本前缀触发（方案 A）、ultracode 为会话级偏好、询问模式下 Workflow 需人工放行、任务事件按 task_id 记类型

---

## 1. 背景与目标

### 现状

Claude Agent SDK 0.3.210 与本机 claude 2.1.258 均已内置 `Workflow` 工具（多智能体编排：脚本里调 `agent()/parallel()/pipeline()/phase()`）。本项目的 `allowedTools` 只是「免确认」不是白名单，默认模式又是 bypassPermissions，因此 Workflow **现在就能被模型调起**，但没有任何一层把它接出来：

| 位置 | 现状 | 问题 |
|---|---|---|
| `web/tool-summary.js` `summarizeTool` | 落到 default 分支，显示「调用 Workflow」 | 看不到工作流名字，审批弹窗也只有这一句 |
| `integrations/claude.js` task_* 事件 | 无 `subagent_type` → 标「后台任务」；进度/完成硬编码「子代理」 | 工作流被误标为子代理 |
| `public/js/chat.js` `BUILTIN_TOOLS` | 无 Workflow 条目 | 用户关不掉这个最烧额度的工具 |
| 触发入口 | 无 | 只能靠知道 `ultracode` 暗号 |

另外，右下角 `.fab-row` 里现在并排两颗悬浮按钮（🔔 飞书、模型选择器）。维护者要求：**飞书通知开关与 ultracode 开关都收进模型选择器弹层**，右下角只留一颗按钮。

### 目标

1. 模型选择器弹层新增「会话」区，放飞书通知与 ultracode 两个开关；右下角 🔔 悬浮按钮移除。
2. ultracode 开着时发送的新消息带关键字，交给 CLI 原生触发机制。
3. 工作流的启动、进度、完成在活动转录里被正确标识。
4. 用户能像其它内置工具一样关掉 Workflow。
5. 「询问」模式下，启动工作流要经用户点头。

### 不做的事（YAGNI）

- 并发/预算上限（`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`、`maxBudgetUsd`）：先观察真实用量再定。
- 工作流专属进度面板、`.claude/workflows/` 预定义工作流选择 UI、remote 工作流。
- 飞书 / 控制台渠道的触发：本期只做 web。
- 插话（steering）路径的前缀：见 3.3 的理由。
- 飞书通知的业务逻辑（登记 / 轮询 / 认领）一行不动，只换 DOM 绑定。

---

## 2. 方案对比（触发方式）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 客户端文本前缀（推荐）** | 开关亮着时，`send()` 在 prompt 前拼 `ultracode `，交给 CLI 原生的关键字触发机制 | 零服务端改动；不改模型行为；沿用 CLI 官方语义 | 服务端不知道这轮开了编排（日志里只能看到关键字） |
| B. 服务端标志位 | `/api/run/start` 带 `ultracode:true`，服务端拼 prompt 或改 systemPrompt | 服务端可观测、将来可挂预算上限 | 要穿 routes-run → startClaudeRun → pending-resume 一整条链，本期用不到这些能力 |
| C. 系统提示常开 | 在自定义 systemPrompt 里告诉模型可自行决定用 Workflow | 无需用户操作 | 违背工具自身「用户显式授权」约束，额度不可控。否决 |

选 A。若日后要做预算上限，再升级到 B，前端开关不用改。

---

## 3. 设计

### 3.1 弹层结构：新增「会话」区

`index.html` 的 `#modelPop` 在权限模式 pills 与工具区之间插入：

```html
<div class="pop-divider"></div>
<div class="tools-section" id="convPrefsSection">
  <div class="tools-section-hdr">会话</div>
  <div class="tool-row" id="notifyRow">
    <span class="tool-row-name" title="任务结束/失败后发飞书私聊卡片">🔔 飞书通知</span>
    <label class="tool-toggle"><input type="checkbox" id="notifyToggle" /><span class="toggle-slider"></span></label>
  </div>
  <div class="tool-row" id="ultracodeRow">
    <span class="tool-row-name" title="多智能体编排：开着时本会话发送的新消息带 ultracode 关键字（插话不带）">⚡ ultracode</span>
    <label class="tool-toggle"><input type="checkbox" id="ultracodeToggle" /><span class="toggle-slider"></span></label>
  </div>
</div>
```

- 两行是静态 DOM，不走 `makeToolRow`（那是给动态工具列表用的）；样式全部复用已有的 `.tool-row` / `.tool-toggle` / `.toggle-slider`。
- `.fab-row` 里的 `#notifyFab` 整块删除，右下角只剩 `#modelFab`。`app.css` 的 `.notify-fab` 规则随之删除；`.model-fab-btn.on` 暂无使用方，一并删除，避免留死样式。
- 新增一条 `.tool-row.disabled { opacity: .5; pointer-events: none; }`，供 openai-compat 时灰掉 ultracode 行（飞书通知与 provider 无关，不灰）。

为什么放在「会话」而不是「工具」区：两者都是**本会话**的行为偏好（飞书通知本来就是 `conv.meta.notifyFeishu`），与「哪些工具可用」是不同维度，混在工具列表里会让用户以为 ultracode 是一个可禁用的工具。

### 3.2 飞书通知开关迁移（`public/js/conv-notify.js`）

只换 DOM 绑定，业务逻辑不动：

- `btn = getElementById('notifyFabBtn')` → `input = getElementById('notifyToggle')`。
- `refreshBtn(conv)`：原来切 `.on` class 与 title，改为 `input.checked = on`，并给同行的 `.tool-row-name` 切 `.off`（与工具列表行的视觉一致）。函数名保留 `refreshBtn`，因为 `chat.js` 有三处通过 `window.__convNotify.refreshBtn` 调用，不值得为改名扫一遍。
- 事件：`click → toggle()` 改为 `change → toggle().finally(() => refreshBtn(findConv(getConvId())))`。`toggle()` 有多条拒绝路径（无会话、网络失败、服务端配置缺失），原来按钮态由 `toggle` 内部按需刷新；换成 checkbox 后浏览器会先把勾打上，所以**无论成败都要在收尾按真值回写一次**，否则拒绝路径会留下「勾着但没开」的假象。
- `conv-notify.test.js` 的 JSDOM 夹具改为完整的 `.tool-row` 行标记（含 `#notifyToggle`），让 `.off` 分支在单测里真的执行过。现有两条用例只断言 `/claim` 行为，不需要改断言。
- `change` 监听加在途保护（`busy` + `input.disabled`）：`/on` 往返期间再点一次会让第二个 `toggle()` 读到未写入的 meta、重复登记；在途期间点击直接回弹。
- **`tests/e2e-conv-notify.mjs` 一并迁移**（v2，代码审查发现）：它有 6 处引用旧 `#notifyFabBtn`，`npm run test:e2e` 会自动收它。要点：先点 `#modelFabBtn` 打开弹层；点 `#notifyRow .tool-toggle`（checkbox 本体 0×0，Playwright 拒点）；`isOn` 读 `#notifyToggle.checked`；原「按钮在输入框上方、排在 #modelFab 之前」的几何断言替换为「`#notifyRow` 在 `#modelPop` 的 `#convPrefsSection` 内」；「ok:false 时不得点亮」这条门禁必须恢复为真实断言。

### 3.3 ultracode 开关（`public/js/chat.js` + 新纯逻辑文件）

**状态归属：会话级**，与同区的飞书通知、以及模型 / 强度 / 模式一致。理由是额度：若是浏览器级全局开关，用户在会话 A 开了编排做大重构，切到会话 B 问个小问题，B 的每条消息也会去拉工作流。会话级把爆炸半径限制在用户明确开过的那个会话里。

实现完全照 `chatMode` 的既有流程，但**不落 localStorage 全局默认**，新会话永远从关开始：

| 位置 | 改动 |
|---|---|
| 模块变量 | `let chatUltracode = false;`（内存态，随会话切换被覆盖） |
| `recordMessage` | 快照 `c.ultracode = chatUltracode`（首条消息建会话记录时一并写入，解决「会话还没建就先开了开关」的时序） |
| `persistPrefsToConv` | 写穿 `c.ultracode = chatUltracode` |
| `applySessionPrefs(prefs)` | `chatUltracode = !!prefs.ultracode && canEnableUltracode(chatDisabledTools)`，**缺字段视为关**（与 customCredId 同款语义，老会话与 CLI 历史会话天然为关）；Workflow 工具已被全局禁用时不还原亮灯，与点击时的守卫对称；变化时刷新行 |
| `newConversation` | `chatUltracode = false` + 刷新行；同时 `window.__convNotify.onConvOpened(null)` 复位 🔔 行并停掉旧会话的收件箱轮询（两行并排在同一区，只复位一个是肉眼可见的矛盾，且会留下「勾着但没登记」） |
| `syncModelUI` → `syncUltracodeRow` | openai-compat → `#ultracodeRow` 加 `.disabled` **且** `ultracodeToggle.disabled = true`（`pointer-events:none` 挡不住键盘）；Claude → 移除 |
| `send()` | 种子前置之后：`finalText = decorateUltracode(finalText, { on: chatUltracode, provider: chatProvider })` |
| `#ultracodeToggle` change | 开：若 `chatDisabledTools.includes('Workflow')` → `toast('工作流工具已关闭，请先在下方工具列表开启')`，回写 `checked=false`，不改状态。否则置真、`persistPrefsToConv()`、刷新行。关：置假、写穿、刷新 |

`launchRun(..., { userTyped: true, typedText: text })` 现有机制保证记忆库拿到的仍是用户原文，气泡显示的也是原文；`recordMessage('user', text)` 记的也是原文。

**插话路径不加前缀**：`steer()` 把 `text` 原样当 userTyped 入库，加前缀会污染记忆库语料；且 run 已在跑，中途注入编排关键字语义不明。开关对插话无效，写进行的 title。

新增纯逻辑文件 `public/js/ultracode.logic.js`（零 DOM，`node --test` 直测）：

```js
/** 开着且走 Claude provider 才拼关键字；openai-compat 没有 Workflow 工具，拼了只会让别家模型困惑 */
export function decorateUltracode(text, { on, provider }) → string
/** Workflow 工具被用户禁用时不允许点亮，两处开关不得互相矛盾 */
export function canEnableUltracode(disabledTools) → boolean
```

### 3.4 工具开关列表

`BUILTIN_TOOLS` 追加：

```js
{ id: 'Workflow', label: '工作流', desc: '多智能体编排（ultracode 触发，可拉起多个子代理）' },
```

后端 `TOOL_DISABLE_ALIASES` 无需改：id 与 SDK 工具名一致，`canUseTool` 现有逻辑直接命中拒绝。

两处开关的一致性（v2，按代码审查修订）：⚡ 开着时把「工作流」关掉，前端在工具行的 onChange 里同步熄掉 ⚡（清标志 + 写穿 + 刷新行）；会话还原时若 Workflow 已被全局禁用则不亮灯（见 3.3 表）。服务端 `canUseTool` 仍是最后一道兜底：任何漏网的调用都会被拒并回「工具已被用户关闭」，模型自行降级，无静默失败。

### 3.5 后端：`web/tool-summary.js`

`summarizeTool` 新增 `case 'Workflow'`：

- 名字来源优先级：`input.script` 里 `export const meta = { name: '...' }` 的 `name` → `input.name`（预定义工作流）→ `input.scriptPath` 的文件名 → `未命名`。名字 clip 24（模型自拟，长度无约束）。
- 描述来源：`meta.description`，有则拼上，clip 40；反转义 `\'`、折叠空白成一行。
- 输出形如：`工作流(review-changes)：Review changed files across dimensions…`，与转录行「工作流(名)启动：…」同形。
- 解析用正则，不 eval 脚本；**必须先锚到 `export const meta = {` 再在其后 2000 字窗口内取字段**（v2，按代码审查修订）。不锚定的话，脚本漏写 meta 时正文里 `const DIMENSIONS = [{ name, description }]` 这类对象字面量会被抓成工作流身份，用户对着假名字点「允许」。契约保证 meta 是首条语句，窗口足够。
- 测试里加一条 `READONLY_TOOLS` 不含 Workflow 的回归保护，这个额度安全决策不能只靠注释承载。

`READONLY_TOOLS` **不加** Workflow。询问模式下 `canUseTool` 会走 `askUser`，弹「Claude 请求执行：Workflow」+ 上面的摘要，用户点「允许」才起跑。`Agent` 在放行集里是因为其内部改动类工具仍会逐个审批；Workflow 的风险不在改动而在额度，属于该拦的点。bypassPermissions / acceptEdits 模式不受影响，直接跑。

### 3.6 后端：`integrations/claude.js` 任务事件标识

新增纯逻辑文件 `src/integrations/claude.logic.js`：

```js
/** task_* 系统事件 → onActivity 载荷；kinds 是 task_id → 类型标签 的 Map，由调用方持有一次 runClaude 的生命周期 */
export function describeTaskEvent(message, kinds) → { name, text } | null
```

规则（v2，按代码审查修订）：
- `task_started`：类型 = `workflow_name` 存在 → `{ name:'Workflow', label:'工作流(名)' }`；否则 `subagent_type` 存在 → `{ name:'Agent', label:'子代理(类型)' }`；否则 `{ name:'Agent', label:'后台任务' }`。连同 `skip: !!skip_transcript` 一起写入 `kinds.set(task_id, 记录)`。`skip` 为真返回 null。
- `task_progress`：查表；未命中时若消息自带 `subagent_type` 则用 `子代理(类型)`，否则回落 `子代理`（与改前文案一致，不退到「后台任务」）。记录 `skip` 为真返回 null —— SDK 只在 started/notification 上带 `skip_transcript`，progress 不带，常驻任务的中间进度只能靠这条记录压掉（改前这是个漏洞，会把 ambient 任务的进度当正常转录）。秒数为 0 或缺失时省略，且不留孤立空格。
- `task_notification`：同样查表；`kinds.delete(task_id)`；自身 `skip_transcript` 或记录 `skip` 为真返回 null。
- 另导出 `isTaskEvent(message)`（`type==='system' && subtype.startsWith('task_')`）供 `claude.js` 判断分派，避免两处各持一份 subtype 清单；`task_updated` 等进来后由 `describeTaskEvent` 返回 null。
- `kinds` 的生命周期是 `runClaude` 的一次 attempt（建在重试循环内）：重试 = 新 query 新流，旧 task_id 不该跨越。

`runClaude` 内部：每个 attempt 建一个 `new Map()`，三个 task_* 分支合并成一处 `if (isTaskEvent(message))` 调用 `describeTaskEvent`，其余流程不变。

### 3.7 模型选择器加 Fable 5.1

**SDK 支持判定**：`sdk.d.ts` 的 `Options.model` 是自由字符串，注释举例含 `'claude-fable-5'`；子代理 `model` 别名列表含 `'fable'`；effort 文档标注 `xhigh` / `max` 对 Fable 5 可用；`sdk.mjs` 内含 `claude-fable-5` 字面量 10 处。SDK 只是把 model 透传给 CLI，本机 claude 2.1.258 本身就能跑 Fable 5.1。结论：支持，模型 ID 用 `claude-fable-5-1`（Fable 5 的同价位继任者，`claude-fable-5` 仍在服务但不必再列）。

改动点（全部是枚举表加一项，无逻辑）：

| 位置 | 改动 |
|---|---|
| `index.html` `#modelPills` | 加 `<button data-m="claude-fable-5-1">Fable 5.1</button>`，放 Auto 之后、Opus 5 之前（按能力降序） |
| `chat.js` `MODEL_LABELS` | 加 `'claude-fable-5-1': 'Fable 5.1'`。`initUiPrefs` / `applySessionPrefs` 的白名单都查这张表，加了就能还原 |
| `chat.js` `shortModel` | 正则链头部加 `/fable/ → 'Fable'`，否则运行态标签会把 Fable 显示成 Sonnet |
| `index.html` `#basicDefaultModel`（设置页「新会话默认值」） | 加 `<option value="claude-fable-5-1">Fable 5.1</option>` |

不动的：`tier.js` 的 auto 判档仍落 Opus 4.8（Fable 单价更高、有独立限流桶，自动档不该替用户选它）；效果滑条仍 4 档到 xhigh（Fable 支持 `max`，但滑条加档要改 EFFORTS 与后端校验，本期不做）。

**使用提示**（写进 pill 的 title）：Fable 有独立的限流桶（`rate_limit_event.model_scoped.display_name = 'Fable'`），撞墙不影响 Opus / Sonnet 额度；反过来 token-rotation 的 exhausted 判定目前不分桶，Fable 撞墙会把整个号标成耗尽——这是已知偏差，出现再修。

### 3.8 文档

- `src/integrations/CLAUDE.md` 文件清单补 `claude.logic.js`。
- `conv-notify.js` 文件头注释里「输入框上方的 🔔 按钮」改为「模型选择器弹层里的开关」。
- `ultracode.logic.js` 文件头注释说明链路。

---

## 4. 数据流

```
用户在模型选择器弹层点亮 ⚡ ultracode ──► chatUltracode = true ──► persistPrefsToConv（有会话）
        │                                                             recordMessage 快照（首条消息建会话时）
用户发送「重构支付模块」
        │
chat.js send() ──► decorateUltracode() ──► prompt = 'ultracode 重构支付模块'
        │                                  气泡 / 记忆库 / 会话记录仍是「重构支付模块」
        ▼
POST /api/run/start ──► startClaudeRun ──► SDK query()
        │
CLI 关键字触发 ──► 模型调用 Workflow 工具
        │
询问模式：canUseTool ──► askUser「Claude 请求执行：Workflow / 工作流 xxx：…」
自动模式：直接执行
        │
SDK 流：task_started{workflow_name} ──► describeTaskEvent ──► 「工作流(xxx)启动：…」
        task_progress ──────────────────────────────────► 「工作流(xxx)正在 Agent · 已 N 次工具 …」
        task_notification ─────────────────────────────► 「工作流(xxx)完成：…」

切到会话 B ──► openConv ──► applySessionPrefs(B) ──► chatUltracode = !!B.ultracode（缺 → 关）
```

---

## 5. 错误处理

- 开关开着但 Workflow 工具被禁用：前端拒绝点亮并提示（3.3）。反向顺序由 `canUseTool` 兜底（3.4）。
- 飞书通知 toggle 的拒绝路径：`change` 收尾统一按真值回写 checkbox（3.2），不会出现勾着但未登记。
- `input.script` 缺 meta 或格式异常：摘要回落到 `工作流(未命名)`，不抛。
- task_progress 早于 task_started 到达：标签回落「子代理」，不丢事件。
- openai-compat provider：`decorateUltracode` 原样返回，行灰显，不会把 Claude 专属关键字发给别家模型。

---

## 6. 测试

| 文件 | 覆盖 |
|---|---|
| `public/js/ultracode.logic.test.js` | `decorateUltracode` 开/关/非 Claude provider 三态；`canEnableUltracode` 含与不含 Workflow |
| `public/js/conv-notify.test.js` | 夹具改为 checkbox；现有三条用例不改断言 |
| `src/entrypoints/web/tool-summary.test.js` | Workflow 摘要：script 含 meta / 仅 name / 仅 scriptPath / 三者皆无；description clip |
| `src/integrations/claude.logic.test.js` | started 三种标签；progress/notification 沿用 started 的标签；未知 task_id 回落；notification 后清理；skip_transcript 返回 null |

`chat.js` 内的会话级还原（recordMessage / persistPrefsToConv / applySessionPrefs / newConversation）无单测基建，靠人工核对：开会话 A 点亮 → 切到 B 应为关 → 切回 A 应为亮 → 新对话应为关。

**人工冒烟**（烧额度，由维护者执行）：bypassPermissions 模式点亮开关，发「用两个代理分别检查 src/store 和 src/plugins 的未处理 Promise，汇总给我」，预期活动转录出现「工作流(…)启动」。

---

## 7. 风险

**工作区已有未提交的并行改动**。`public/js/chat.js`（+87 行，集中在 83-320 与 841-900 两段，属项目地图 / 吉祥物 / 启动屏工作）、`public/index.html`、`public/app.css` 都是 `M` 状态。本设计触碰的区域（`recordMessage` / `persistPrefsToConv` / `send()` / `BUILTIN_TOOLS` / `MODEL_LABELS` / `applySessionPrefs` / `#modelPop` / `#fabRow`）与那些 hunk 不重叠，实施时只做定点 Edit，不整文件重写，不动别人的 hunk。

**关键字触发是否在自定义 systemPrompt 下生效**。本项目 `systemPrompt: { type: 'custom' }` 替换了 Claude Code 预设系统提示。`ultracode` 触发由 CLI 在 prompt 层注入（`workflowKeywordTriggerEnabled` 设置项），理论上与系统提示无关，但没有实测。冒烟不过的兜底：在自定义 systemPrompt 末尾追加一句「用户消息含 ultracode 关键字时，使用 Workflow 工具做多智能体编排」，一行改动，不影响本设计其余部分。

---

## 8. 改动清单

| 文件 | 动作 |
|---|---|
| `public/index.html` | 删 `#notifyFab`；`#modelPop` 加「会话」区两行；`#modelPills` 与 `#basicDefaultModel` 加 Fable 5.1 |
| `public/app.css` | 删 `.notify-fab`、`.model-fab-btn.on`；加 `.tool-row.disabled` |
| `public/js/conv-notify.js` | 绑定改 checkbox；`refreshBtn` 写 checked；change 收尾回写 |
| `public/js/conv-notify.test.js` | 夹具改 checkbox |
| `public/js/ultracode.logic.js` | 新建 |
| `public/js/ultracode.logic.test.js` | 新建 |
| `public/js/chat.js` | `chatUltracode` 六处接线（3.3 表）；`send()` 调 decorate；`BUILTIN_TOOLS` 加 Workflow；toggle 绑定；`MODEL_LABELS` / `shortModel` 加 Fable |
| `src/entrypoints/web/tool-summary.js` | `case 'Workflow'` |
| `src/entrypoints/web/tool-summary.test.js` | 加用例 |
| `src/integrations/claude.logic.js` | 新建 |
| `src/integrations/claude.logic.test.js` | 新建 |
| `src/integrations/claude.js` | task_* 三分支改调 `describeTaskEvent` |
| `src/integrations/CLAUDE.md` | 文件清单补一行 |

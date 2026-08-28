# Claude 提问 → 结构化选择 UI — 设计文档

**日期**：2026-08-28
**目标**：Claude 遇到不确定、需要用户拍板时，把它的问题渲染成可点选的卡片，而不是让它退化成在正文里列「1. 2. 3.」等用户手打回答。

## 1. 现状

### 1.1 Claude 表达不确定的结构化通道确实存在

`AskUserQuestion` 是 Claude Code 的内置工具，输入有严格 schema（`node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:800`）：

```
questions: [1-4 个] {
  question: string          // 完整问句
  header: string            // ≤12 字符的 chip 标签
  options: [2-4 个] {
    label: string           // 1-5 词的选项名
    description: string     // 该选项意味着什么 / 取舍
    preview?: string        // 可选，供对比的预览内容
  }
  multiSelect?: boolean
}
```

答案回传通道也真实存在。`sdk.mjs` 里：

```js
else if (e.request.subtype === "request_user_dialog") {
  if (this.onUserDialog) return await this.onUserDialog(
    { dialogKind: e.request.dialog_kind, payload: e.request.payload, toolUseID: e.request.tool_use_id },
    { signal: t }
  );
  // 无 handler → 保持沉默，让有能力的客户端或 worker 的 park deadline 去收场
}
```

答案经 `UserDialogResult = {behavior:'completed', result: unknown}` 的 `result` 字段回传。

其它佐证：

- `toolConfig.askUserQuestion.previewFormat` **是生效配置** —— `sdk.mjs` 把它转成环境变量 `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT` 传给 CLI，说明 CLI 确实会按宿主声明的格式产出 preview
- CLI 二进制里有完整的提问交互闭环遥测：`tengu_ask_user_question_accepted` / `_rejected` / `_skipped` / `_respond_to_claude` / `_timeout_changed`，以及 `ask_user_question_answer`、`user_skipped_questions`
- CLI 有设置项 `askUserQuestionTimeout`（`60s`/`5m`/`10m`/`never`），描述为「Claude 的问题在空闲多久后带着已选答案自动继续」

### 1.2 为什么我们只看到纯文案

`parseDialog`（`src/entrypoints/web/tool-summary.js:54`）的字段猜测清单里没有 `questions`：

```js
const rawOpts = p.options || p.choices || p.answers || null;
if (Array.isArray(rawOpts) && rawOpts.length) { /* 渲染 */ }
return null;  // ← AskUserQuestion 的 payload 嵌套一层，落在这里
```

`onUserDialog`（`run-claude.js:162`）拿到 `null` 就回 `{behavior:'cancelled'}`。而 `sdk.d.ts:3369` 明确：宿主答不了的 dialog，CLI「fail closed，dialog-gated 流程退化成它的 no-dialog 行为」。于是 Claude 只能在正文里把问题列出来。

事故现场即此形态：截图那条长消息在正文列了 6 条待确认项，用户随后手打「1. 没有让如意记住…, 2. 不保留, 3. 不需要…」逐条回答。

### 1.3 死配置

`run-claude.js:111` 声明的 `supportedDialogKinds` 有 5 个，实际对得上的没那么多：

| kind | SDK bundle | CLI 二进制 | 判断 |
|---|---|---|---|
| `refusal_fallback_prompt` | 3 处 | 14 处 | 真实，SDK 类型注释里明确举例 |
| `ask_user_question` | 0 | 13 处（均为遥测名） | 作为 `dialog_kind` 未获确证，但是唯一有 CLI 侧痕迹的候选 |
| `user_question` | 0 | 0（仅作 `ask_user_question` 子串命中） | 查无此物 |
| `question` | 0 | — | 查无此物 |
| `multiple_choice` | 0 | 0 | 查无此物 |

后三个当前唯一的作用是误导下一个读这段代码的人。

### 1.4 为什么「待观测项」一直没观测到

`onUserDialog` 已经在记 `appendEvent({type:'dialog', dialogKind})`，但 `event-log` 只保留 3 天且封顶 1000 条（`store/event-log.js`），而每个 API 请求都记一条 `access`。真实数据目录里 1497 行日志**全是 `access`**，`type=dialog` 一条不剩。

### 1.5 前端已就绪

`renderAskCard`（`chat.js:1834`）已完整支持 `title` / `body` / N 个选项（`label` + `desc`）：

```js
for (const o of ask.options || []) { /* opt-label + opt-desc 两行按钮 */ }
b.onclick = () => submitDecision(job, ask.reqId, o.id);
```

权限审批用的就是这套，只是目前只喂给它「允许 / 拒绝」两项。**本设计前端零改动。**

## 2. 拍板结论

| 决策点 | 结论 | 理由 |
|---|---|---|
| 呈现形态 | 一次一问，串行 | 复用现有 ask 卡片，改动最小；`multiSelect` 降级单选、`preview` 忽略 |
| payload 字段路径无法静态确定 | 一次做完 + 观测兜底 | `parseDialog` 本就是「尽力解析、认不出返回 null」的设计，加分支是纯增量。押对直接通；押错下限等于现状（继续 `cancelled`），且日志样本到手可校准 |

`UserDialogRequest.payload` 的类型是 `Record<string, unknown>`，协议注释明说 per-dialogKind 不透明。**唯一确定它的办法是实测**，而实测要真跑一次并诱导 Claude 提问。故本设计同时落观测日志。

## 3. 改动

### 3.1 `src/entrypoints/web/run-claude.js` — 收敛 kind + 落观测日志

```js
supportedDialogKinds: [
  'refusal_fallback_prompt', // SDK/CLI 两侧均有明确对应
  'ask_user_question',       // CLI 侧有完整提问闭环遥测，是 AskUserQuestion 的候选 kind
],
```

删掉 `user_question` / `question` / `multiple_choice`：SDK bundle 与 CLI 二进制里都查不到，声明它们不会让任何 dialog 多发出来，只会让人误以为已经适配过。

`onUserDialog` 里增加一条完整日志：

```js
// 走 logger（app-*.log）而不是 event-log：后者只留 3 天、封顶 1000 条，
// 而每个 API 请求都记一条 access —— dialog 记录会被洪流挤干净（实测 1497 行全是 access）。
// payload 是 per-kind 不透明结构，这条日志是唯一能拿到真实形状的途径。
logger.info('claude', 'onUserDialog', { dialogKind: request.dialogKind, payload: request.payload });
```

原 `appendEvent({type:'dialog', dialogKind})` 保留（面板可见性），不动。

### 3.2 `src/entrypoints/web/tool-summary.js` — `parseDialog` 加 `questions[]` 分支

插在现有 `options/choices/answers` 分支**之前**（更具体的结构优先匹配）：

```js
const q = Array.isArray(p.questions) ? p.questions[0] : null;
if (q && Array.isArray(q.options) && q.options.length) {
  const options = q.options.map((o, i) => ({
    id: String(i),
    label: o.label || String(i),
    desc: o.description || '',
    _raw: o,
  }));
  return {
    title: '❓ ' + String(q.question || '请选择'),
    body: '',
    options,
    toResult: (choice) => { /* 见 §3.3 */ },
  };
}
```

**只取第一问。** 不自己攒多问队列：攒了就要处理「用户答到第二问关页」的中间态——多一套跨重启状态机，而 CLI 侧本就有 `askUserQuestionTimeout` 与逐轮追问机制，剩余问题下一轮会再发。YAGNI。

`body` 留空而不是塞 `q.header`：`header` 是 ≤12 字符的 chip 标签（如「Auth method」），当正文读起来是噪音；`question` 已在 title。

`multiSelect` 不处理 —— 渲染成单选，用户选一个即回传。语义上是「多选题只答了一项」，Claude 能继续；比不呈现好。

### 3.3 答案回传形状

按 `AskUserQuestionOutput`（`sdk-tools.d.ts:3175`）构造，即输入结构原样 + `answers`：

```js
toResult: (choice) => {
  const opt = options.find((x) => x.id === choice);
  return { questions: [{ ...q, answers: [opt ? opt.label : choice] }] };
}
```

**这是整份设计里唯一的押注。** 押错的表现：CLI 认不出 result → 按 dialog 默认行为处理（等同现在的 `cancelled`），Claude 退回正文列 1.2.3.，**不会比现状更坏**。§3.1 的日志会同时给出真实 payload 形状，据此校准一次即可。

## 4. 边界与风险

| 项 | 判断 |
|---|---|
| `ask_user_question` 不是真实 kind | 则 dialog 压根不发，一切照现状，无副作用。日志也不会有记录——这本身就是有效的观测结论 |
| payload 形状猜错 | `parseDialog` 回落到旧分支或返回 `null` → `cancelled` → 等于现状 |
| 回传形状猜错 | 同上，CLI 按默认行为收场 |
| `preview` 含 HTML | 本轮忽略该字段，不渲染，无 XSS 面。将来要做必须过 `dompurify`（已是项目依赖） |
| 与权限审批 ask 抢占 | 不会。两者共用 `askUser` 的 `pendingQueue`（`runs.js` 已处理并发 ask 逐个呈现） |
| 用户想「都不选 / 自由回答」 | 现有卡片无「其他」按钮，但输入框始终可用；`defaultChoice: '__cancel__'` 的既有语义保留（`run-claude.js:172`），用户不点就等超时 |

## 5. 测试

`parseDialog` 是纯函数，全部落 `src/entrypoints/web/tool-summary.test.js`（**新建文件**——该模块目前无测试，`summarizeTool` / `READONLY_TOOLS` 也一并有了落脚处）：

| 用例 | 期望 |
|---|---|
| 标准 `{questions:[{question, header, options:[{label, description}]}]}` | title 带 `❓` + 问句；options 数量与 label/desc 一一对应；body 为空 |
| `toResult('1')` | `{questions:[{...q, answers:['第二个选项的 label']}]}` |
| `toResult` 收到未知 id | `answers` 回落为该 id 原值，不抛 |
| 多问 payload（`questions` 长度 3） | 只呈现第一问 |
| `questions` 存在但 `options` 为空/缺失 | 回落到旧 `options/choices/answers` 分支；都没有 → `null` |
| 旧结构 `{options:[...]}` | 行为不变（回归保护） |
| `questions` 非数组 / payload 为空 | `null`，不抛 |

前端零改动，无新增前端测试。

## 6. 验收

1. 起服务，在会话里给 Claude 一个明确需要拍板的任务（例：「这个组件的状态放 Context 还是 Zustand？先问我再动手」）
2. 观察聊天区是否出现 ask 卡片、选项是否带说明文字
3. 点一个选项 → Claude 应按所选继续，且不再在正文里重复列选项
4. 无论成功与否，查 `logs/app-<date>.log` 里的 `onUserDialog` 行，记录真实 `dialogKind` 与 `payload` 形状
5. 若第 2 步没有卡片：以第 4 步日志为准判断是「kind 不对」（无日志）还是「payload 形状不对」（有日志但 `parseDialog` 没认出），据此校准

**注意**：验收要真实消耗额度。2026-08-28 当天账号处于 `out_of_credits` / `five_hour` 限流状态，需等额度恢复后再做。

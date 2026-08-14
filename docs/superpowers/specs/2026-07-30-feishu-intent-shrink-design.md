# 飞书意图识别收缩 + 即时应答 + 放弃改动 + 群聊 @ —— 设计

日期：2026-07-30
状态：已确认（用户 2026-07-30 批准）

## 1. 背景与问题

上一轮改造「放开对话限制」后体验反而下降，实测症状是**慢**与**误判**。定位到四个根因：

1. **project-qa 挂在 `intents:['other']` 兜底**（`src/plugins/team-tools/project-qa/index.js`）：
   完全托管档位下，任何没命中动作/需求/故障的消息都会触发一次「读代码查证再回答」，
   Claude 冷启动 + 探索工具调用轻则十几秒重则一分钟——闲聊也走这条路。
2. **意图关键词过宽**（`src/app/intent.js`）：
   `FEATURE_RE` 含 `希望|建议|优化|调整|支持|能不能|想要|加上`，`BUG_RE` 含 `无法|错误|异常|失效`，
   日常表达几乎必然命中，导致「随口一说」被立案成需求/故障。
3. **未命中时最坏两次 LLM 串联**：`claudeClassifyFeedback`（30s 超时）→ `classifyAction`（30s 超时），
   再加 project-qa 的读码问答，用户可能等 1 分钟以上才见第一条回复。
4. **群聊消息正文被 `@_user_1` 占位符污染**：`parseTextContent` 直接返回飞书原文，
   占位符进了意图识别与任务 title/detail。

## 2. 目标

1. 意图识别收缩为**四类显式意图**：需求 / 故障 / 项目问询 / 自定义动作；都不是则回固定引导文案，不再瞎归类。
2. 识别到意图后**立刻**回一条对应的「稍等」文案，让用户第一秒就有反馈。
3. 自动完成、待合并到主分支的任务，支持**放弃改动**（删除任务分支）。
4. 群聊里被 @ 时才响应，且回复**@ 回提问人**。

非目标（明确不做，YAGNI）：飞书卡片按钮、问询多轮追问、放弃后的飞书通知、材料池链路改动。

## 3. 意图识别（核心）

### 3.1 分层结构

`classify(text, { hasMaterials })` 新流程，逐层短路：

| 层 | 判定 | LLM 成本 |
|---|---|---|
| L0 | 寒暄快路 `isChitchat`（保留现状）→ `other` | 0 |
| L1 | **强意图前缀**（新）→ `bug` / `feature` / `question` | 0 |
| L2 | action 关键词**单命中**（沿用现状）→ `action` | 0 |
| L3 | **快速语义识别**：一次 Haiku 合并分类（含 action 消歧），超时 10s | 1 次 |
| L4 | 兜底 → `other`（dispatch 回固定引导文案） | 0 |

删除：`BUG_RE` / `FEATURE_RE` / `feedbackKeyword` / `feedbackRoute` / `FAST_PATH_MAX_LEN`
及「Haiku 失败后退回全文关键词匹配」的兜底分支——那正是误判来源，宁可落引导文案让用户显式重说。

`isChitchat` 命中与 L4 的结果都是 `other`，因此寒暄同样收到引导文案（引导文案本身即答复，不再单设寒暄文案）。

### 3.2 强意图前缀（新文件 `src/app/intent-keywords.js`）

纯函数 + 词表，独立单测。**只匹配消息开头**（允许行首空白/表情/标点），避免长文中间命中：

- 需求：`提交需求` `提个需求` `提一个需求` `有个需求` `有一个需求` `提需求` `需求：`
- 故障：`提交故障` `提个故障` `有个故障` `提交BUG` `提个bug` `有个bug` `报个bug` `提交问题` `故障：` `bug：`
- 问询：`问个问题` `问一个问题` `想问一下` `问一下` `请问` `有个疑问` `咨询一下` `咨询`

大小写不敏感；`bug` 允许 `BUG/Bug`。分隔符：前缀后可跟 `:：,，。空格换行` 或直接接正文。

```js
matchStrongIntent(text) // → { type: 'bug'|'feature'|'question', body: string } | null
```

`body` = 剥掉前缀与分隔符后的正文。歧义表达（如「有个问题」「不能用了」）**不入词表**，交给 L3 语义判。

### 3.3 合并分类器

原 `claudeClassifyFeedback` 与 `claudeClassifyAction` 合并为**一次调用** `quickClassify(text, { hasMaterials, actions })`：

- 输入：消息首 500 字、`hasMaterials` 提示、动作候选清单
  （候选筛选沿用现 `classifyAction` 逻辑：关键词命中 ≥2 条 → 只传命中子集；0 条命中 → 传全部 enabled 动作；
  上限 20 条，超出截断并告警。无启用机器人 → 动作清单为空，分类器只判前四类）
- 输出：`{"type":"bug|feature|question|material|action|other","action_id":null|"..."}`
- `type=action` 且 `action_id` 能在候选里找到才算命中，否则降级 `other`
- 超时 **10s**：`runClassifierOnce` 增加可选 `timeoutMs`（默认仍 30s，不影响 task-triage 的分类点）
- 失败/超时/解析不出 → `other`（不做关键词兜底）

最坏延迟从「2 × 30s」降到「1 × 10s」；常见路径（强前缀或 action 关键词）零 LLM 调用。

### 3.4 返回契约

`classify` 返回值增加 `body`（仅 L1 命中时非空）：
`{ intent, body?, actionId?, actionName?, env: null, keyword: null }`。

消费方：
- `feedback`：`title` 取 `body || ctx.text`（前 40 字），`detail` 仍用原文全文（保留上下文）。
- `project-qa`：提问正文取 `body || ctx.text`。
- **空正文保护**：`intent` 为 bug/feature/question 且 `body` 为空串（用户只发了「提交需求」）→
  回「好的，请把需求内容发我～」（按类替换措辞）并 return，不建任务、不起 Claude。

## 4. 即时应答

### 4.1 文案注册表（`src/shared/messages.js`）

新增三条，并加入 `BOT_MESSAGE_KEYS`（per-bot 可改口吻，设置页表单由 `listBotMessages` 自动渲染，前端无需改）：

| key | 默认文案 |
|---|---|
| `ackBug` | 请稍等，我先思考此故障是否由我的项目引发！ |
| `ackFeature` | 请稍等，我先思考此需求的复杂度与收益是否值得做！ |
| `ackQuestion` | 请稍等，我先去翻阅代码再回来回答你的问题！ |

- `welcome` 默认文案改为固定引导文案（key 名不变，避免动 dispatch）：
  `没有识别到你的意图，你可以跟我说：\n· 提交需求：XXXX\n· 提交故障：XXXX\n· 问个问题：XXXX\n或其他已配置的功能。识别到我会及时回复你～`
  label 改为「未识别意图兜底提示」。
- `feedbackAck`（「问题/需求已收集，感谢反馈～」）**删除**：即时应答取代它。
  已存在于 `settings.json bots[].messages.feedbackAck` 的覆盖值成为孤儿数据（`resolveMessage` 不再读、
  `sanitizeMessages` 下次保存时丢弃），无需迁移。
- `BOT_MESSAGE_KEYS` 变为 `['ackBug','ackFeature','ackQuestion','execProcessing']`。

### 4.2 发送位置

即时应答由各 feature 在 `handle` **首步**发送（内聚在功能里，dispatch 不碰文案）：

- `feedback`：`bug`/`feature` 分支开头 `await ctx.reply(msg(type==='bug'?'ackBug':'ackFeature'))`，
  然后建任务、吸附材料、按托管档位继续。**`material` 分支与 challenged 应答分支不发**。
  - 建任务成功后不再发「已收集」；中度/完全托管的后续结论回复保持不变。
  - **轻度托管补闭环**：`analyze` 完成后回一句固定文案
    `📋「{title}」已记录并初步分析完成，等管理员确认后处理。`（不可配，避免引入占位符机制）。
    analyze 失败仍只记日志，不打扰用户。
- `project-qa`：`handle` 开头 `await ctx.reply(msg('ackQuestion'))`。
- `action`（action-runner）：按原脚本规则，不加即时应答。

## 5. 项目问询（改造 `project-qa`，不新建插件）

- `intents: ['other']` → **`['question']`**；`order` 保持 90（不再是兜底，但排序无害）。
- **删除 `autonomy === 'full'` 门槛**（行为变更，已确认）：只要识别到问询意图，任何托管档位都查代码回答。
  理由：用户显式提问时回引导文案与需求矛盾。
- 首步发 `ackQuestion`；随后 `runClaude` 只读（`allowedTools: ['Read','Grep','Glob']`，`cwd = bot.projectDir`，
  `botSystemAppend` 注入人设与工程边界）——这部分沿用现有实现。
- 新增三项保护：
  1. **同用户串行闸**：模块级 `Set<openId>`，在跑时回「我还在查上一个问题，稍等一下～」并 return；
     `finally` 里清除（异常也要清，否则永久卡死）。
  2. **超时**：`AbortController` + `QA_TIMEOUT_MS = 180_000`，超时回
     「这个问题我查得有点久，稍后再试或换个问法～」。参照 `llm-classify` 的 abort + race 双保险
     （SDK 流在限流时可能永不结束）。
  3. **答案截断**：超 1800 字截断并加省略提示（飞书文本上限 2000）。
- 无启用机器人或无 `projectDir` → 回「我还没被配置项目目录，暂时答不了～」。

## 6. 放弃改动（待合并任务）

### 6.1 git 层（`src/plugins/team-tools/auto-dev/git.js`）

```js
export function deleteBranchArgs(repo, branch) { return ['-C', repo, 'branch', '-D', branch]; }
export async function deleteBranch(repo, branch) // → { ok, error? }
```

- 分支不存在 → `{ ok: true }`（幂等：视为已放弃，避免脏数据卡死 UI）。
- 删除失败（如分支仍被某 worktree 检出）→ `{ ok: false, error }`，原样上抛错误文本。
  正常流程 auto-dev 完成后已 `checkout --detach`，故 `-D` 安全。

### 6.2 API（`src/entrypoints/web/routes-ops.js`）

`POST /api/tasks/action` 增加 `action: 'discard'`：

1. 校验 `task.auto && task.status === 'done' && !task.merged && task.branch`，否则 400。
2. `repo = task.repo || getActiveBot()?.projectDir || config.feedback.frontendDir`（与 merge 同一兜底链）。
3. `deleteBranch(repo, task.branch)` 失败 → 409 `{ error }`，**不改任务状态**（不留半放弃态）。
4. 成功 → `updateTask(id, { status:'rejected', discarded:true, discardedAt, mergeError:null }, '放弃改动，已删除分支 x')`。

### 6.3 前端（`public/js/tasks-panel.js`）

`isAwaitingMerge(t)` 分支的按钮从一个变两个：

```
[合并到主分支](primary)  [放弃改动](danger)
```

`放弃改动` 走 `confirmDialog`，文案明示不可恢复与分支名：
「确认放弃「{title}」的自动改动？将删除分支「{branch}」，改动不可恢复。」→ `taskAction(t.id, 'discard')`。
状态映射已有 `rejected: ['已放弃']`，无需新增。

## 7. 群聊 @

### 7.1 报文解析（`src/channels/feishu-normalize.js`，纯函数 + 单测）

```js
parseMentions(message)        // data.message.mentions → [{ key, openId, name }]
stripMentions(text, mentions) // 剥掉 @_user_N 占位符（及紧随的姓名残留），压缩多余空白
```

`toInbound`（`src/channels/feishu.js`）：
- `base` 增加 `chatType: data?.message?.chat_type`（`'p2p' | 'group'`）与 `mentions`。
- `text` / `post` 两种消息的正文经 `stripMentions` 清洗后再返回；清洗后为空则返回 null（纯 @ 消息不进业务）。

### 7.2 机器人自身 open_id（`src/integrations/lark.js`）

```js
export async function getBotOpenId() // GET /open-apis/bot/v3/info → bot.open_id
```
模块级缓存；`resetApiClient()` 时清空（换号即失效）。请求失败返回 `null` 并告警，**不抛错**。

### 7.3 入口层策略（`src/entrypoints/feishu/index.js`）

- **群聊过滤**：`chatType === 'group'` 且 `botOpenId` 可得 且 `mentions` 不含 `botOpenId`
  → `logger.info` 后静默 return。拿不到 `botOpenId` → 不拦（降级为原全响应行为，绝不因取 id 失败而失声）。
- **回复 @**：`ctx.reply` 闭包在群聊时给文本加前缀 `<at user_id="{发送者 openId}"></at> `。
  实现走新纯函数 `src/shared/mention.js: atPrefix(openId, chatType)`（p2p 或缺参 → `''`），单测覆盖。
  channel 层保持哑（不认识 chatType），前缀在入口层拼好再交给 `send`。
  图片直链分行发送逻辑不受影响（前缀落在文本首行）。

### 7.4 异步通知也 @ 提交人

- `feedback` 建任务时 `source` 增加 `chatType: ctx.meta.chatType`。
- `auto-dev/index.js: replySource` 与 `task-triage` 的 `sendText` 通知，前缀 `atPrefix(task.source.openId, task.source.chatType)`。
- 老任务无 `chatType` → 前缀为空，行为同现状（安全降级）。

## 8. 影响面与不变量

- **owner 链路不变**：`task-triage`(order 10) / `claude-exec`(order 20) 都走 `match`，在意图识别之前，收缩不影响 owner。
- **材料池链路不变**：图片 / 文件 / 云文档摄取与 `material` 意图保持现状（`material` 仍是 L3 的一个类别）。
- **console 入口**（`src/entrypoints/console/index.js`）共用 dispatch，同样被收缩——可接受（本就是调试入口）。
- **web 渠道不走 dispatch**，无影响。
- `feishu-status.json` / WS 热重载 / 去重 / 代次守卫等渠道逻辑一律不动。

## 9. 测试

新增/更新单测（`node --test`，与现有 `*.test.js` 同风格）：

| 文件 | 覆盖 |
|---|---|
| `src/app/intent-keywords.test.js`（新） | 三类强前缀命中、body 提取、冒号/空格分隔、大小写、**长文中间不命中**、歧义词不命中 |
| `src/app/intent.test.js`（改） | 移除 feedbackRoute 用例；补 L0/L1/L4 短路顺序（L3 需 mock，不在单测覆盖） |
| `src/channels/feishu-normalize.test.js`（改） | `parseMentions` / `stripMentions`：占位符剥离、无 mentions、纯 @ 消息、重名 |
| `src/shared/mention.test.js`（新） | `atPrefix`：group / p2p / 缺参 |
| `src/plugins/team-tools/auto-dev/git.test.js`（改） | `deleteBranchArgs` 参数拼装 |
| `src/shared/messages.test.js`（若无则新建） | 新 key 存在、`BOT_MESSAGE_KEYS` 变更、`sanitizeMessages` 丢弃 feedbackAck |

人工走查（用户执行）：
1. p2p 发「提交需求：登录页加记住密码」→ 秒回需求即时应答 → 后续流程正常。
2. p2p 发「提交故障：扫码页白屏」→ 秒回故障即时应答。
3. p2p 发「问个问题 订单状态是怎么流转的」→ 秒回问询应答 → 若干秒后给出基于代码的回答。
4. p2p 发「今天天气不错」→ 秒回引导文案，**不触发读码问答**。
5. p2p 只发「提交需求」→ 回「请把需求内容发我」，不建任务。
6. 群聊 @ 机器人提需求 → 回复带 @；群聊不 @ 发消息 → 机器人沉默。
7. 待合并任务点「放弃改动」→ 分支消失（`git branch -a` 核对），任务显示已放弃。
8. 轻度托管提需求 → 即时应答 + 分析完成后的闭环回复各一条。

## 10. 文档更新

`docs/ARCHITECTURE.md` 意图识别数据流那段（约 184 行）已过时（写的是「需求/故障 → feedback，待办 → triage，默认 → runClaude」），
改为新四类分层结构 + 群聊 @ 策略。其余章节不动。

## 11. 实施后的审查结论（2026-07-30）

两道审查（规格符合性 + 代码质量）发现并已修掉的问题，**都写进了代码注释防回退**：

1. **【进程级】`CHITCHAT_RE` 灾难性回溯**：选择支里 `byebye` 与 `bye` 并存又被外层 `+` 包住 → 指数回溯（实测 `'bye'.repeat(44)+'中'` 卡 87 秒）。`isChitchat` 是 `classify` 第一行、同步执行未截断原文，本轮又删了 `FAST_PATH_MAX_LEN` 护栏 → 一条构造消息即可占死事件循环，abort/timeout 全失效。已删 `byebye` 并加 60 字长度闸。
2. **裸词误立案**：实现把 spec §3.2 的 `需求：`/`故障：`/`bug：` 写成了裸词 + 可零长分隔符，导致「bug 我已经修好了」「需求文档我已经发你了」被立案。已拆成两组：完整说法用可零长分隔符，裸词组要求**至少一个标点**分隔（空白不算——「bug 我已经修好了」正是空格分隔）。
3. **`请问` 类前缀劫持动作**：`请问能帮我清一下 test 环境数据` 走了问询而非清理动作。已改为 L1 判 question 时先用剥好的正文过一遍 L2 动作关键词，单命中则判 action（bug/feature 不让路）。
4. **问询空正文保护失效**：`body || ctx.text` 让判空永不成立 → 只发「问个问题」会真起 Claude 查证字面量并占满 180s 串行闸。已改用 `classify` 新增的 `strong` 标记判定。
5. **即时应答 await 倒挂可靠性**：ack 在 `createTask` 之前 `await`，飞书限流抛错会让需求静默蒸发。已改为不阻塞（`.catch` 记日志），仍是首个发出的动作。
6. **群聊过滤吞材料**：飞书 image/file 报文不含 mentions，一律按「未 @」处理会让群聊的先图后文材料链路整条失效。已改为过滤只作用于 text 与 unsupported（后者静默，避免表情包被回「不支持该类型」的噪音）。
7. **@ 前缀破坏发图判定**：`sendReply` 逐行匹配图片直链，前缀拼在首行会让单行 URL 输出（二维码脚本）退化成裸链接。已改为前缀独占一行。
8. **triage 通知 @ 错会话**：用 `task.source.chatType` 给 owner 私聊拼 @，会在只有 owner 的会话里 @ 一个不在场的人。已去掉（auto-dev 的 `replySource` 发给来源会话，是正确的，保留）。
9. 其余小修：串行闸 `running.add` 移入 try（进闸必解闸）、feedback 双 catch 分离（回复失败不再误报成分析失败）、`getBotOpenId` 失败负缓存 60s、放弃改动后卡片显示「分支已删除」。

`classify` 返回契约最终为：`{ intent, body, strong, env: null, keyword: null, actionId?, actionName? }`。
测试：264 tests 全绿（改造前 253）。

## 12. 遗留 / 待观察

- `material` 类别只能由 L3 语义判定命中；若用户贴长文档但 LLM 判为 `other`，会落引导文案而非入池——
  先观察实际误伤率再决定是否补规则（如「无强前缀 + 超 300 字 + 有待归属材料」直接判 material）。
- 强前缀词表是硬编码；若后续要 per-bot 自定义前缀，再抽到 settings（当前 YAGNI）。
- 已知历史项（本次不处理）：owner 材料池 drain 不一致（I5）、provider 维度 fail-fast、docx fixture 测试（I3）。
- **裸词收紧的代价**：`bug 扫码页白屏`（真实故障、仅空格分隔）不再走零成本 L1，改由 L3 Haiku 判——多一次 10s 内的调用，属「宁可多花一次分类，也不误立案」的既定取舍。若走查发现这类说法很常见，可考虑把「空白分隔 + 后接短正文」也纳入裸词快路。
- **`请问` 仍用可零长分隔符**：`请问过他了吗` 会命中 question 并去读代码（body=`过他了吗`）。`请问` 在中文里几乎总是问询标记，风险低，先观察。
- **`@ 提问人 + 图片` 会拆成两条消息**（一条纯 @ 文本 + 一条图片），是 `sendReply` 现有拆分逻辑的固有结果；要合成一条需改 `channels/feishu.js` 的 send 契约（本轮未做）。
- **串行闸是进程级内存态**：pm2 cluster 多实例下不跨进程生效（当前 ecosystem 为单实例，够用）。
- **问询超时但已有部分输出**：会把半截答案发给用户（`timedOut && !out` 才回超时提示）。若半截答案有误导性，改为超时一律回提示。

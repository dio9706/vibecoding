# 同事消息中继（三期）· 设计

- 日期：2026-09-16
- 状态：已拍板，待实现
- 前置：`2026-09-16-colleagues-and-req-assignees-design.md`（同事名册 + 开发人员指派，一期/二期已实现）
- 涉及分层：`app`（dispatch 内核）/ `entrypoints/feishu` / `entrypoints/web` / `plugins` / `store` / `public`

## 一、背景与目标

二期已实现「定稿时主动通知开发人员」，是单向的。三期要把它变成**双向**：

1. 同事回复机器人的消息，进入该需求的对话流；
2. 开发期右栏「开发人员」弹窗里，姓名右侧显示未读气泡；
3. 点击展开对话面板，能看到往来消息（含同事发来的文档）；
4. 面板底部有输入框 + 发送按钮，可主动通过机器人向该同事发消息。

**四期方向（用户已提前告知，本期只为其留好数据形状）**：AI 主动托管，识别不同职位同事发来的内容并自动处理 —— 产品调整需求 → 走需求变动；后端提供/修改接口文档 → 走 API 文档更新。

## 二、已拍板决策

| 决策点 | 结论 |
|---|---|
| 入站优先级 | ①配置的动作 ②严格命中「帮我统计埋点」 ③在需求中→记录对话并回「已收到，信息会同步发送给主机！」 ④提交需求/故障/问个问题，全不中则弹「没有识别到你的意图」卡 |
| 多需求归属 | 同事同时参与多个开发期需求时，**发一组按钮让他自己选**，选完流转到指定需求。按钮渲染参考「没有识别到你的意图」卡底部的按钮 |
| 接入 dispatch 的方式 | **给 intents 段加 `PASS`**（与 hasPending 段对齐），新 feature `order=35` |
| 四期预留 | **只留数据形状，不建处理器抽象**（YAGNI：只有一个实现时的抽象必然猜错） |
| web 实时性 | 复用现有轮询，**10s 一次** |

## 三、探索发现的四条硬约束

这四条直接决定实现落点，任何一条漏掉都会产生「看起来能用、实际某条路径静默失效」的结果。

### 3.1 `dispatch` 的 intents 段不支持 `PASS`

```js
// src/app/dispatch.js 第 2 段
if (permOK && f.intents.includes(intent.intent)) {
  return await f.handle(ctx, intent);   // ← 命中即 return，无 PASS 回退
}
```

而第 ③ 段要接管的正是本该给 `feedback`(order=40) 的 `bug`/`feature`/`question`/`material` 意图，"不在需求中"时必须让回 feedback。**hasPending 段已经有 PASS 语义**（其注释记着「动作追问粘住，用户问别的也被吞」的事故），两段语义对齐是一致性修正而非新机制。

### 3.2 文件 / 图片消息走不到 dispatch

`entrypoints/feishu/index.js` 的 `onInbound` 在**调用 dispatch 之前**就处理了 `m.kind === 'image'` 与 `m.kind === 'file'` 两个分支，且各自 `return`。

因此「同事发来的文档」的接入点在**入口层**，不是 feature。只在 dispatch 侧做接入，会得到「文字消息收得到、发的接口文档永远收不到」这种半残状态 —— 而这恰恰是四期最重要的输入。

### 3.3 埋点（match）天然优先于动作（intent），与用户描述的①②顺序相反

`tracking-stats` 用 `match: (ctx) => parseTrackingCommand(ctx.text).hit`（严格前缀），走 dispatch **第 1 段**；`action-runner` 用 `intents: ['action']`，走**第 2 段**（LLM 分类后）。

**保持现状，不做调整**：严格前缀命中是 100% 确定的信号，把它排在 LLM 分类之后，等于让一个概率判断去抢一个确定判断。用户描述的「先动作后埋点」在效果上没有差别 —— 一条消息不可能既严格命中埋点前缀、又该被判为动作。

### 3.4 四期的下游能力已经存在

- **需求变动**：`PUT /api/req/change`（`routes-req-v2.js`）
- **API 文档**：`POST /api/req/apidoc`（`routes-requirements.js`，上传后自动触发「对照修正代码」）

三期只要把消息存成能直接喂给这两个接口的形状，四期就只是加一层分类器，**不用改数据结构**。这是本期数据模型的主要约束来源。

## 四、数据模型

### 4.1 新建 `src/store/colleague-messages.js` → `colleague-messages.json`

```js
{
  "<reqId>": {
    "<colleagueId>": {
      messages: [
        {
          id: 'cm_xxx',
          dir: 'in' | 'out',            // in = 同事发来，out = 我发出去
          text: '接口文档发你了',
          files: [{ name: 'api.md', path: 'D:/…/uploads/…', kind: 'file' | 'image' }],
          at: '2026-09-16T…',
          role: 'backend',              // 发信时该同事的职位快照 —— 四期分类器的主要输入
          status: 'unread' | 'read' | 'handled',
          handledBy: null | 'manual' | 'ai',
          handledNote: '',              // 四期：「已转成 v3 需求变动」「已作为 api.md 上传」
        }
      ],
      lastInboundAt: '2026-09-16T…',
    }
  }
}
```

**`status` 放在消息上而不是会话上**：四期要能逐条标记「这条已被 AI 处理成一次需求变动」，会话级的已读标记表达不了这件事。三期只用到 `unread`/`read`，`handled` 与 `handledBy`/`handledNote` 是给四期留的字段（写入侧归一即可，本期不产生 `handled`）。

**`role` 存快照而非查名册**：四期分类器要按「发信当时他是什么职位」判断，同事转职后历史消息的判定依据不该跟着变。与归档快照同一理由。

**`files[].path` 存落盘绝对路径**：四期把后端发来的接口文档直接喂给 `POST /api/req/apidoc`（它要的就是 `{name, path}`），不用再解析一次飞书资源。

### 4.2 导出接口

| 函数 | 说明 |
|---|---|
| `appendMessage(reqId, colleagueId, entry)` | 追加一条；`dir:'in'` 时同时更新 `lastInboundAt` |
| `getThread(reqId, colleagueId)` | 取一条会话的全部消息 |
| `getUnreadCounts(reqId)` | `{ [colleagueId]: number }`，供 `/api/req/get` 回填 |
| `markRead(reqId, colleagueId)` | 把该会话所有 `in` + `unread` 置 `read` |
| `normalizeThread(raw)` | 纯函数，形状归一 |
| `addPending(openId, entry)` | 待归属消息入缓冲（多需求未选时） |
| `getPending(openId)` | 读缓冲，供 `hasPending` 判定 |
| `flushPending(openId, reqId, colleagueId)` | 把缓冲全部消息归入目标需求并清空缓冲，返回归入条数 |

写操作一律经 `store/index.js` 的 `updateJson`（跨进程文件锁）—— 飞书进程写入站、web 进程写出站与已读，**两个进程并发写同一文件**，这里不能有裸读写。

### 4.3 待归属缓冲（多需求选择）—— 落盘，不用内存态

同事参与多个开发期需求时不能每条消息都弹一次卡片，需要一个"等他选"的缓冲区。

**缓冲落盘**，存在同一个 `colleague-messages.json` 的 `_pending` 节：

```js
_pending: {
  "<openId>": { messages: [entry], askedAt: '2026-09-16T…' }
}
```

**为什么不用内存 Map**：卡片按钮的回调有两套机制 ——
`registerCardActionHandler` 按 messageId 存内存 Map，进程一重启就失效；
`registerCardKindHandler`（`shared/card-actions.js`）走按钮 `value.kind` 路由，**无内存态，机器人重启后旧卡片按钮依然有效**，三个现有插件（action-runner / feishu-relay / team-tools）都用的后者。

同事点这个选择按钮可能隔几小时甚至隔天，期间机器人重启是常态。按钮用 kind 路由、缓冲落盘，才不会出现「同事点了按钮没反应，还得再发一遍消息」。

- 第一条待归属消息 → 写入 `_pending` + 发选择卡片（按钮 `value = { kind: 'colleague-pick', openId, reqId }`）
- 期间再来消息 → 追加到同一 `_pending` 条目，**不重复发卡**
- 同事点按钮 → `registerCardKindHandler('colleague-pick', …)` 回调，按 `openId` 取出缓冲全部消息、一次性归入 `reqId`、清空缓冲

`hasPending` 仍然要实现（读 `_pending` 判断），用于让后续消息直接进缓冲而不重新走意图识别。

## 五、入站链路

### 5.1 文本消息 —— 新插件 `src/plugins/colleague-relay/`

`order = 35`（在 `action-runner`=30 之后、`feedback`=40 之前）：

```js
export default {
  name: 'colleague-relay',
  permission: 'any',
  intents: ['bug', 'feature', 'question', 'material', 'other'],
  hasPending: (ctx) => pendingPicks.has(ctx.user.id),
  handle: async (ctx) => { … },   // 不在任何开发期需求中 → return PASS
};
```

判定流程：

1. 按 `ctx.user.id`（open_id）在名册里反查同事 → 找不到 → `PASS`
2. 查该同事被指派、且 `phase === 'dev'` 的需求列表
   - 0 个 → `PASS`（回落 feedback，行为与今天一致）
   - 1 个 → 直接 `appendMessage` + 回「已收到，信息会同步发送给主机！」
   - 多个 → 存入 `pendingPicks` + 发选择卡片
3. 卡片回调 → 归入所选需求 → 回同一句确认

### 5.2 文件 / 图片消息 —— 改 `entrypoints/feishu/index.js`

在现有 `m.kind === 'image'` / `m.kind === 'file'` 分支**开头**插入判定：发信人是「某个开发期需求的开发人员」→ 下载资源、`appendMessage`、回确认、`return`；否则走原有的材料池逻辑。

判定与归属逻辑与 5.1 共用同一个纯函数（`resolveColleagueContext(openId)`），避免两条链路各写一份"他属于哪个需求"。

### 5.3 dispatch 内核改动

```js
// 第 2 段：与 hasPending 段对齐，支持 PASS 回退
if (permOK && f.intents.includes(intent.intent)) {
  const r = await f.handle(ctx, intent);
  if (r !== PASS) return r;
  logger.info('dispatch', `← ${f.name} 放弃接管（PASS），继续匹配`);
}
```

现有所有 feature 都不返回 `PASS`（只有 hasPending 路径用），所以这是**行为兼容**的改动。需补一条 dispatch 单测钉住「intents 段 PASS 后继续匹配后续 feature」。

## 六、出站链路

`POST /api/req/colleague-messages/send { reqId, colleagueId, text }`

1. 校验需求存在、该同事在 `assignees` 内、有 `feishuOpenId`
2. 用 `getActiveBot()` 凭证调 `sendTextToUser`（**与二期同一硬约束**：open_id 是应用维度的，必须用取到这些 open_id 的那个应用发）
3. 成功后 `appendMessage(…, { dir: 'out', status: 'read' })`
4. 失败回 502 + 原因，**不落消息**（落了会让界面显示一条其实没发出去的消息）

## 七、HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/req/colleague-messages?reqId=&colleagueId=` | 取一条会话 |
| POST | `/api/req/colleague-messages/send` | 主动发消息 |
| POST | `/api/req/colleague-messages/read` | 标记已读 |

未读数不单独开接口：**回填进 `/api/req/get` 的 `assigneeList[].unreadCount`**，复用开发期右栏既有轮询（二期已把 `assigneeList` 做成服务端 join，这里只是多带一个字段）。轮询间隔从 3s 放宽到 10s 由前端控制。

路由挂在 `routes-requirements.js` 的 `/api/req/` 前缀下，分发登记在 `handleRequirementRoutes`。

## 八、前端

### 8.1 未读气泡

`req-chat.js` 的「开发人员」`rq-railbtn` 副标题已显示指派人姓名；在其右侧追加未读总数气泡（有未读时才出现）。

### 8.2 选人弹窗内的未读与入口

`req-assignee-dialog.js` 当前是「勾选指派」用途。**不复用它**，新建 `public/js/colleague-chat.js`：
- 开发期右栏「开发人员」按钮点击后，若已有指派人 → 打开**对话列表弹窗**（每人一行：姓名·职位 + 未读气泡 + 「修改指派」入口）
- 点某一行 → 进入该同事的对话面板

分成两个文件而非塞进 `req-assignee-dialog.js`：指派与对话是两件事，塞一起会重蹈 `set-select` 那种"一个文件管两种形态"的复杂度。

### 8.3 对话面板

- 消息气泡：`in` 左、`out` 右，显示时间
- 文件：显示文件名，`.md` 可点开 Markdown 查看器（复用 `openMarkdownFile`），其余显示名称 + 路径 tooltip
- 底部输入框 + 发送按钮（Enter 发送、Shift+Enter 换行，与主聊天一致）
- 打开面板即调 `read` 标记已读；面板开启期间 10s 轮询拉新消息
- **渲染安全**：同事发来的文本经 `renderMarkdown`（含消毒）或 `textContent`，不裸 `innerHTML`

## 九、四期对接点（本期不实现，仅验证数据够用）

| 四期场景 | 本期已存的字段 | 下游接口 |
|---|---|---|
| 产品调整需求 | `role='product'` + `text` + 归属 `reqId` | `PUT /api/req/change { id, text, scope }` |
| 后端提供/修改接口文档 | `role='backend'` + `files[].{name,path}` + 归属 `reqId` | `POST /api/req/apidoc { id, name, path }` |
| 处理留痕 | `status='handled'` + `handledBy='ai'` + `handledNote` | — |

## 十、测试

| 文件 | 覆盖 |
|---|---|
| `src/store/colleague-messages.test.js` | 形状归一、追加、未读计数、标记已读、未知 id 不写盘 |
| `src/app/dispatch.test.js`（追加） | intents 段返回 PASS 后继续匹配后续 feature；无人接管仍走帮助卡 |
| `src/plugins/colleague-relay/*.test.js` | 纯逻辑：非同事 → PASS；0 个 dev 需求 → PASS；1 个 → 直接归属；多个 → 待选；缓冲累积不重复发卡 |
| `src/entrypoints/web/routes-requirements.test.js`（追加） | 三个新端点的校验分支；`assigneeList[].unreadCount` 回填 |

## 十一、明确不做（YAGNI）

- 处理器注册表 / AI 自动分类（四期）
- SSE 实时推送（轮询够用）
- 群聊消息中继（只做私聊）
- 同事侧的历史查询、撤回、已读回执
- 非开发期（评审/测试/归档）需求的消息归属
- 对话搜索与分页（单需求单同事的消息量不足以需要）

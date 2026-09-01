# src/channels · 模块地图

渠道适配层：把各家 IM 的**原始报文**归一化成统一的 `InboundMessage`，并把业务层的回复**回发**出去。组装层（`entrypoints/feishu`、`entrypoints/console`）只跟归一化后的消息打交道，渠道协议细节（WS 生命周期、凭证热重载、去重、报文解析、资源下载、状态上报）全部封在本模块内。

## 文件清单

| 文件 | 职责 |
|---|---|
| `registry.js` | Channel 纯注册表工厂 `createRegistry()`。无内置 channel（便于隔离单测），只做契约形状校验（`id:string` + `start`/`send` 函数）与 `get/has/list`。导出：`createRegistry` |
| `index.js` | 默认注册表 —— 用 `createRegistry()` 建实例，`register` feishu + console，解构导出 `register/get/has/list` 与 `registry`。组装层统一从这里 `get(id)`。|
| `feishu.js` | 飞书 channel 适配器 `createFeishuChannel()` —— 渠道细节的唯一归属：WS 生命周期、凭证热重载（`wsGen` 代次守卫）、消息去重、`toInbound` 归一化、资源下载、出站发送、`feishu-status.json` 状态上报。导出：`createFeishuChannel` |
| `feishu-normalize.js` | 飞书入站报文解析（纯函数，无网络）：text/image/post/file 的 JSON 抽取、`@_user_N` 占位符剥离、云文档链接抽取。导出：`parseTextContent` `parseImageContent` `parsePostContent` `parseFileContent` `extractDocLinks` `stripDocLinks` `parseMentions` `stripMentions` |
| `console.js` | 控制台开发渠道 `createConsoleChannel()` —— Channel 契约的第二个实现（Phase 2 契约验证），兼本地调试：stdin 逐行 → `InboundMessage(kind=text)`，出站直接打印。无外部依赖。导出：`createConsoleChannel` |
| `registry.test.js` / `index.test.js` / `feishu-normalize.test.js` / `console.test.js` | 对应单测（`node --test`）；`feishu-normalize.test.js` 是解析纯函数的主要测试面。|

## 关键流程

### 1. 组装：注册表 → 拿 channel
- `index.js` 调 `registry.js` 的 `createRegistry()` 建默认注册表，`register(createFeishuChannel())` 与 `register(createConsoleChannel())`。`register` 会校验最小契约（缺 `id`/`start`/`send` 即抛）。
- `entrypoints/feishu/index.js` 经 `channels/index.js` 的 `get('feishu')` 取 channel；`entrypoints/console/index.js` 则**绕过注册表**直接 `createConsoleChannel({ userId })`（因为它要按 role 参数化实例，注册表里的 console 只为验证契约第二实现）。

### 2. 入站：原始事件 → InboundMessage（数据流的核心）
`feishu.js` 内部链路：
1. `start({ onInbound, onCardAction })` 存回调 → `fs.watch` 监听凭证 → `startWs()`。
2. `startWs()` 用当前凭证建 WS，`getDispatcher()` 懒建事件路由表，注册 `im.message.receive_v1` / `card.action.trigger`。
3. 收到 `im.message.receive_v1` → `toInbound(data)`：
   - `seenBefore(messageId)` 去重（TTL 清理）→ 命中即返回 `null` 静默丢弃；
   - `parseMentions(message)` 抽 @ 列表；
   - 按 `message_type` 分派到 `feishu-normalize.js`：`text`→`parseTextContent`、`image`→`parseImageContent`、`post`→`parsePostContent`、`file`→`parseFileContent`，文本统一过 `stripMentions` 剥掉 `@_user_N` 占位符；
   - 图片/文件 key 交给 `integrations/lark.js` 的 `downloadMessageResourceWithError` 下载到本地（下载失败挂 `downloadError` 字段，不吞消息）；
   - 归一化成 `InboundMessage`（`channelId/chatKey/messageId/userId/chatType/mentions/kind/text/images/...`）。
4. `_onInbound(inbound)` 把归一化消息交给组装层做业务路由。**channel 内不消费 `extractDocLinks`/`stripDocLinks`** —— 这两个纯函数是给组装层（`entrypoints/feishu/index.js` 直接 import）判断「云文档链接」用的。

console 渠道是同一契约的极简版：`readline` 逐行 → 直接构造 `InboundMessage(kind=text)` → `onInbound`。

### 3. 出站：send → lark SDK
组装层调 `channel.send(chatKey, { text })`：
- 飞书走 `sendReply` —— 把「独占一行的图片直链」发成图片消息（`sendImageByUrl`，失败回退发 URL 文本），其余仍发 `sendText`；`sendMarkdownText/sendCard/updateCard/addReaction/removeReaction` 直接转发到 `integrations/lark.js`。
- console 直接往 output 打印。

### 4. 凭证热重载（真实事故打磨，勿简化）
`start()` 里 `fs.watch(WATCH_DIR)` 只对 `settings.json` 变更做 300ms 防抖 → `reload()`：凭证变则拆旧 WS 建新，`wsGen` 递增使旧 client 回调失效（防抖动写状态）；`fs.watch` 不可用降级 5s 轮询。状态经 `store` 的 `writeJson` 落到 `feishu-status.json`。

## 常见改动入口

- **要新增一个渠道（QQ / 微信）** → 新建 `src/channels/<id>.js` 实现 `{ id, capabilities, start, send }` 契约，再在 `index.js` 里 `register` 一次即可；dispatch / features / 入口都不用动。
- **要改飞书报文解析、支持新消息类型** → 改 `feishu-normalize.js`（纯函数，配 `feishu-normalize.test.js`）+ `feishu.js` 里 `toInbound` 的 `msgType` 分派分支。
- **要改出站发送行为（图片直链拆分 / markdown / 卡片）** → `feishu.js` 的 `sendReply` 及末尾 `send*` 方法。
- **要改 WS 生命周期 / 凭证热重载 / 去重 / 状态上报** → `feishu.js` 的 `startWs` / `reload` / `getDispatcher` / `seenBefore` / `writeStatus`。
- **要改 @ 占位符剥离或云文档链接识别** → `feishu-normalize.js` 的 `stripMentions` / `parseMentions` / `extractDocLinks` / `stripDocLinks`。
- **要改注册契约校验或 `list` 输出（设置页/诊断）** → `registry.js`。
- **要改默认注册哪些渠道** → `index.js`。
- **要不接飞书、本地跑通 dispatch 全链调试 features** → 用 `console.js`（`entrypoints/console` 消费）。

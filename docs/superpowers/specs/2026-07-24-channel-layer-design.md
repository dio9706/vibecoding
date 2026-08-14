# Channel 层设计（多渠道契约，为 QQ / 微信铺路）

## 背景
转型目标之一是多渠道接入（feishu 之外加 QQ/微信）。现状：渠道约定是**隐性的**——feishu 入口手搓 `ctx` 对象喂 `app/dispatch`，收发/去重/热重载/状态上报全部内联在 `entrypoints/feishu/index.js`（244 行）。新渠道无从"照着实现"。

## 核验过的事实（2026-07-24）
- dispatch/features 消费的 ctx 契约面极小且稳定（全仓 grep）：`ctx.reply`(15) / `ctx.user.id`(10) / `ctx.text`(9) / `ctx.user.role`(3) / `ctx.source`(2) / `ctx.sessionKey`(1) / `ctx.meta`(1)。
- web 执行台不是 dispatch 渠道（聊天直连 SSE 不经 dispatch），Channel 层只面向**消息 bot 渠道**；web 的任务操作走 HTTP API，维持现状。
- providers 抽象（Phase 1 契约+注册表）已被三轮扩展验证是对的范式——Channel 层照抄家风。

## 契约（src/channels/）

```js
// Channel —— 一个消息渠道的适配器
{
  id: 'feishu',
  capabilities: { text: true, richText: true, image: true, reaction: true },
  start({ onInbound }),  // 建立收信（长连接/轮询），含该渠道自身的凭证热重载/重连/状态上报
  stop(),                // 拆连接
  send(chatKey, { text }),               // 出站文本（最小面）
  addReaction?(messageId, emoji),        // 可选能力（capabilities 声明）
  removeReaction?(messageId, reactionId),
}

// InboundMessage —— 入站归一化产物（channel 负责解析/下载，业务不碰渠道原始报文）
{
  channelId, chatKey, messageId, userId,
  kind: 'text' | 'image' | 'unsupported',
  text,              // kind=text：纯文本或富文本抽取结果（内嵌图片已下载并以「[附图] 路径」附文末）
  images: [path],    // 已下载的本地图片路径（kind=image 单图 / post 内嵌图）
  raw,               // 渠道原始事件（逃生舱，业务勿依赖）
}
```

**分层原则**：
- **channel 管**：连接生命周期（含凭证热重载）、消息去重、报文解析、资源下载、状态上报（feishu-status.json）。
- **entry（组装层）管**：角色判定（ownerOpenIds 是应用概念）、ctx 构建、业务特例路由（单图→attachImageToRecentTask）、处理中表情 UX、dispatch。
- **dispatch/features 不变**：ctx 契约字段一个不动。

## 实施阶段
- **Phase 1（本轮）**：`registry.js`（照 providers/registry 家风：register 校验 id/start/send、get 未知即抛、list 出能力位）+ `feishu-normalize.js`（**纯函数**：text/post 报文解析，产出 {text, imageKeys}，单测覆盖）+ `feishu.js`（createFeishuChannel：WS 生命周期/热重载/去重/下载归一迁入）+ `index.js`（默认注册表）+ entry 瘦身为组装层。**行为不变**；claude-feishu 进程不主动重启（文件变更不影响运行中进程，部署时机由用户定）。
- **Phase 2**：新渠道接入即验证契约（QQ 或 console 开发渠道）；届时如契约不够用（如卡片消息、流式编辑消息）按需扩 capabilities。
- **非目标**：web 执行台不塞进 Channel 契约（形态不同：SSE 流式 + HTTP API）。

## 风险
- feishu 热重载/代次守卫逻辑是真实事故打磨出来的（wsGen 防旧回调抖动、防并发 reload）——迁移必须逐字符保留。
- 入站解析改动会影响线上 bot：post 解析抽成纯函数后用真实报文样例钉单测。

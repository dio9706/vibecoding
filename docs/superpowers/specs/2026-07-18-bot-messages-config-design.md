# 机器人文案配置（设置页）设计

- 日期：2026-07-18
- 目标：把飞书机器人 6 条「门面文案」（欢迎语等）收进 web 设置页统一配置，架构上做成可扩展注册表——后续新增可配文案只需在后端注册表加一个 key，前端零改动。

## 背景与既有机制（复用而非重造）

- 欢迎语等文案目前硬编码在飞书侧代码中（`src/app/dispatch.js`、`src/features/*`）。
- `settings.json` 是设置唯一持久化入口（`src/store/settings.js`）：**web 写、feishu 读**。
- `store/index.js` 的 `readJson` 每次调用直接读盘、无缓存 → 只要调用点在**回复时**读取文案，设置保存后飞书侧下一条消息即生效，**无需热重载机制**。
- `POST /api/settings` 已是 `section` 分发模式（`lark` / `tokens`），新增 `messages` section 即可。
- 设置弹层（`settingsMask`）已有分区结构，沿用现有 `$` / `fetch` / `toast` 工具函数，不引框架。

## 范围界定

文案分两类：

- **A 类·门面文案**（本次收编，共 6 条）：无插值或插值可由代码拼接、改动无流程风险。
- **B 类·流程强耦合文案**（保持硬编码）：含 `${env}`、`${maskPhone(phone)}` 等插值，且文字必须与代码实际接受的指令一致（如「回复 dev 或 test」）。task-triage 全部应答、清理执行播报等均属此类。

## 一、模块边界与改动清单

| 模块 | 改动 | 职责 |
|---|---|---|
| `src/shared/messages.js` | 新增 | 文案注册表 `REGISTRY` + `msg(key)` + `listMessages()`，唯一文案出口 |
| `src/store/settings.js` | 改 | 加 `messages` 字段：`getMessages()` / `setMessages(values)`，只存非空覆盖值 |
| `src/app/dispatch.js` | 改 | 欢迎语改 `msg('welcome')` |
| `src/features/feedback/index.js` | 改 | 确认文案改 `msg('feedbackAck')`（`[故障]/[需求]` 前缀仍由代码拼接） |
| `src/features/claude-exec/index.js` | 改 | `msg('execNewChat')` / `msg('execProcessing')`（目录后缀仍由代码拼接） |
| `src/features/data-cleanup/index.js` | 改 | `msg('cleanupAskPhone')` / `msg('cleanupAskEnv')` |
| `src/entrypoints/web/server.js` | 改 | `GET /api/settings` 返回文案列表；`POST` 加 `section:'messages'` |
| `public/index.html` `app.css` `app.js` | 改 | 设置弹层新增「机器人文案」分区，动态渲染 |
| `src/shared/messages.test.js` | 新增 | `msg()` 回退逻辑单测 |

## 二、文案注册表（`src/shared/messages.js`）

```js
export const REGISTRY = {
  welcome:         { label: '欢迎语（无匹配时兜底回复）', defaultText: '你好，我可以帮你：\n· 清理数据 —— 例如「帮我清一下 dev 环境数据」\n· 二维码功能（待配置）' },
  feedbackAck:     { label: '需求/故障收集确认',          defaultText: '问题/需求已收集，感谢反馈～ 后续我确认后会进行处理。' },
  execNewChat:     { label: '新对话确认（owner）',        defaultText: '🆕 已开始新对话' },
  execProcessing:  { label: '处理中提示（owner）',        defaultText: '🤔 处理中…' },
  cleanupAskPhone: { label: '清理流程·索要手机号',        defaultText: '首次使用，请发送你的手机号（11 位），用于定位要清理的账号。' },
  cleanupAskEnv:   { label: '清理流程·询问环境',          defaultText: '要清理哪个环境的数据？回复 dev 或 test。' },
};

export function msg(key)        // getMessages()[key]（非空）?? REGISTRY[key].defaultText；未知 key 抛错（开发期即暴露）
export function listMessages()  // → [{ key, label, defaultText, value }]，供 GET /api/settings
```

- **调用点必须在回复时调用 `msg()`**，不得存成模块级常量——依赖 `readJson` 无缓存实现跨进程即时生效。
- `execProcessing` 调用处保留代码拼接：`msg('execProcessing') + `（完整能力${workDir ? ' @' + workDir : ''}）``。
- `feedbackAck` 调用处保留前缀：`` `${tag} ${msg('feedbackAck')}` ``。

## 三、数据模型（`settings.json` 增量）

```jsonc
{
  "lark": { ... },
  "tokens": [ ... ],
  "messages": { "welcome": "自定义欢迎语…" }   // 只存覆盖值；无覆盖 = 用默认
}
```

`setMessages(values)`：逐 key 校验存在于 `REGISTRY`，trim 后非空则存、为空则删（回退默认）；单条上限 2000 字符。

## 四、API 面

| 端点 | 增量 |
|---|---|
| `GET /api/settings` | 响应加 `messages: [{key, label, defaultText, value}]`（value 为覆盖值或 `''`） |
| `POST /api/settings` | 加 `section:'messages'`，body `{ section:'messages', values:{key:text} }`，整节一次保存；未知 key 忽略、超长 400 |

## 五、设置页 UI

「飞书凭证」分区下方新增「机器人文案」分区：

```
│  ─────────────────────────────────────────  │
│  机器人文案       留空则使用默认，保存后下一条消息生效 │
│    欢迎语（无匹配时兜底回复）                 │
│    [ 多行 textarea，placeholder=默认文案 ]   │
│    需求/故障收集确认                          │
│    [ textarea ]                              │
│    …（按 GET /api/settings 返回动态渲染）     │
│                              [ 保存文案 ]    │
```

- 每条 = 标签 + `textarea`（`placeholder` 显示默认文案；有覆盖值则填入）。
- **留空即恢复默认**（不做单独的「恢复默认」按钮，placeholder 本身就是预览）。
- 「保存文案」→ `POST section:'messages'` 全量提交本分区 → toast 成功/失败。
- 前端不硬编码任何文案 key/默认值，完全按 API 渲染（开闭原则：后端注册表加 key 前端即出现）。

## 六、错误处理

- `msg(未知 key)` 抛错——注册表与调用点不一致属开发错误，启动/首次调用即暴露，不静默回退。
- `POST` 校验：`values` 非对象 → 400；单条 > 2000 字符 → 400 并指明是哪条；未知 key 静默忽略（防旧前端残留）。
- `settings.json` 写失败 → 500 + toast（沿用现有模式）。
- feishu 进程读盘失败 → `readJson` 回 fallback → `getMessages()` 回 `{}` → 全部默认文案，机器人不因配置损坏而失声。

## 七、测试策略

- 单测 `src/shared/messages.test.js`（沿用现有 `*.test.js` 风格）：有覆盖值回覆盖、覆盖为空/仅空白回默认、未知 key 抛错、`listMessages()` 结构完整。
- 手动验证：设置页改欢迎语 → 保存 → 给飞书机器人发一条无匹配消息，确认新文案生效；清空 → 确认回默认。跨进程即时生效依赖真实飞书长连接，明确列为手动项。

## 八、非目标（YAGNI）

- 不做 B 类流程文案配置、不做 `{placeholder}` 模板引擎。
- 不做多语言、富文本/markdown 渲染（飞书回复即纯文本）。
- 不做文案版本历史/审计。
- 不改 web 端空状态文案（本次范围仅飞书机器人回复）。

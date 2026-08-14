# 飞书卡片交互实现总结

## 概述

完成了飞书交互卡片（interactive card）的完整实现，支持：

1. ✅ **发送卡片** — 发送确认/取消二选一的卡片
2. ✅ **处理回调** — 监听 `card.action.trigger` 事件
3. ✅ **更新卡片** — 用户点击后更新卡片为最终状态
4. ✅ **自定义数据** — 卡片和回调之间传递业务上下文

---

## 核心实现

### 1. 卡片生成助手 (`src/shared/card-confirm.js`)

```javascript
// 生成标准确认卡片
const { card, confirmed, cancelled } = createConfirmCard(
  '标题',
  '内容',
  { 自定义数据 }
);

// 生成纯信息卡片（无按钮）
const infoCard = createInfoCard('标题', '内容', 'success');

// 解析飞书回调
const action = parseCardAction(callbackData);
```

**特点：**
- 开箱即用的卡片生成
- 自动处理 Markdown 渲染
- 自动化状态转移（确认/取消/进行中）

---

### 2. 飞书 API 集成 (`src/integrations/lark.js`)

新增两个函数：

```javascript
// 发送卡片消息
export async function sendCard(chatId, cardContent)

// 更新已发送的卡片
export async function updateCard(messageId, cardContent)
```

使用飞书官方 SDK 的 `im.v1.message` API。

---

### 3. 事件回调处理 (`src/channels/feishu.js`)

在事件分发器中注册 `card.action.trigger` 事件：

```javascript
const dispatcher = new larkSdk.EventDispatcher({}).register({
  'im.message.receive_v1': ...,
  'card.action.trigger': async (data) => {
    if (_onCardAction) await _onCardAction(data);
  },
  ...
});
```

channel 的 `start()` 接受 `onCardAction` 回调参数。

---

### 4. 高层业务入口 (`src/entrypoints/feishu/index.js`)

导出回调注册函数：

```javascript
export function registerCardActionHandler(messageId, handler)
```

全局维护一个 `Map<messageId, handler>`，用户点击卡片按钮时分发。

---

## 使用示例

### 基础例子

```javascript
import { getChannel } from '../../channels/index.js';
import { createConfirmCard, parseCardAction } from '../../shared/card-confirm.js';
import { registerCardActionHandler } from '../../entrypoints/feishu/index.js';

const channel = getChannel('feishu');

// 1. 发送卡片
const { card, confirmed, cancelled } = createConfirmCard(
  '确认执行 git push？',
  'git push origin main',
  { operation: 'push', branch: 'main' }
);

const result = await channel.sendCard(ctx.sessionKey, card);
const messageId = result?.message_id;

// 2. 注册回调
registerCardActionHandler(messageId, async (callbackData) => {
  const action = parseCardAction(callbackData);
  
  if (action?.action === 'confirm') {
    // 用户确认
    await channel.updateCard(messageId, confirmed());
    await executeGitPush(action.value.branch);
    await ctx.reply('✅ git push 已完成');
  } else {
    // 用户取消
    await channel.updateCard(messageId, cancelled());
    await ctx.reply('❌ 已取消');
  }
});
```

---

## 文件清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/shared/card-confirm.js` | 卡片生成和解析工具 |
| `src/plugins/feishu-card-actions-example.js` | 4 个完整示例 |
| `docs/CARD-CONFIRM-GUIDE.md` | 详细使用指南 |
| `docs/CARD-QUICK-REFERENCE.md` | 快速参考 |
| `tests/card-confirm.test.js` | 单元测试 |
| `tests/card-integration.test.js` | 集成测试 |
| `docs/IMPLEMENTATION-SUMMARY.md` | 本文件 |

### 修改的文件

| 文件 | 修改 |
|------|------|
| `src/integrations/lark.js` | 添加 `sendCard()`, `updateCard()` |
| `src/channels/feishu.js` | 注册 `card.action.trigger` 事件，导出 `sendCard`, `updateCard` |
| `src/entrypoints/feishu/index.js` | 添加全局卡片回调处理，导出 `registerCardActionHandler()` |

---

## 架构图

```
用户消息
  ↓
feishu.js (channel) 
  ├─ 接收 im.message.receive_v1
  └─ 调用 onInbound 分发
    ↓
entrypoints/feishu/index.js
  ├─ 业务处理
  └─ 需要确认时发卡片
    ↓
  channel.sendCard()
    ├─ 调用 lark.js::sendCard()
    └─ 返回 message_id
    ↓
  registerCardActionHandler(messageId, handler)
    └─ 保存处理函数

用户点击卡片按钮
  ↓
飞书 → card.action.trigger 事件
  ↓
feishu.js 收到 → 调用 onCardAction
  ↓
entrypoints/feishu/index.js::onCardAction()
  ├─ 查找 cardActionHandlers[messageId]
  └─ 调用 handler(callbackData)
    ↓
  handler 中：
  ├─ 解析 parseCardAction(callbackData)
  ├─ 根据 action.action 执行业务逻辑
  └─ 更新卡片 channel.updateCard()
```

---

## 关键特性

### 1. 完全隔离的命名空间

卡片回调和消息处理完全独立，不影响现有逻辑：

```javascript
// 消息入站（现有）
const ctx = { ... };
await dispatch(ctx);

// 卡片点击（新增，完全独立）
registerCardActionHandler(messageId, handler);
```

### 2. 类型安全的自定义数据

```javascript
// 发送时传入任意对象
{ taskId: 'T123', env: 'prod', version: 'v1.2.3' }

// 回调时原样获得
action.value.taskId   // 'T123'
action.value.env      // 'prod'
action.value.version  // 'v1.2.3'
```

### 3. 自动错误处理

```javascript
const action = parseCardAction(callbackData);
if (!action) return;  // 安全退出，无 NPE 风险
```

### 4. 卡片状态管理

```javascript
card         // 初始：两个按钮
confirmed()  // ✅ 已确认（无按钮）
cancelled()  // ❌ 已取消（无按钮）
```

---

## 测试覆盖

### 单元测试 (`tests/card-confirm.test.js`)

- ✅ 卡片生成
- ✅ 状态转移
- ✅ 回调解析
- ✅ 错误处理

### 集成测试 (`tests/card-integration.test.js`)

- ✅ 完整的发送→点击→更新流程
- ✅ 多步骤依序确认
- ✅ 自定义数据往返
- ✅ JSON 序列化

运行测试：

```bash
npm test -- card-confirm.test.js
npm test -- card-integration.test.js
```

---

## 工作流检查

从 `--markdown` 开始的演进：

1. ✅ **阶段 1**: 用 `--markdown` 发送普通回复
   - 直接用 `lark-cli im +messages-send --markdown`
   - 或通过 `channel.send()` 间接调用

2. ✅ **阶段 2**: 需要确认时用卡片
   - 调用 `channel.sendCard()`
   - 注册回调处理

3. ⏳ **阶段 3** (未来): 复杂交互（待调研）
   - 表单卡片
   - 多选项卡片
   - 实时更新卡片

---

## 已知限制

### 1. 回调超时

用户在 5-10 分钟内未点击，回调不会触发。建议：

```javascript
setTimeout(() => cardActionHandlers.delete(messageId), 10 * 60 * 1000);
```

### 2. 一次一个确认

目前设计是一个消息 ID 对应一个回调处理。若同时发多个卡片，各自独立处理。

### 3. 飞书卡片限制

- 卡片最大 16KB
- Markdown 有语法限制
- 按钮最多 6 个（当前只用 2 个）

---

## 下一步可选方向

### 1. 交互卡片表单

支持输入框、单选、多选等，返回结构化数据。

### 2. 进度卡片

实时更新长操作的进度：

```javascript
for (const step of steps) {
  // 更新进度卡片
  await channel.updateCard(messageId, progressCard(step));
  await executeStep(step);
}
```

### 3. 卡片队列管理

管理多个待确认的卡片，防止用户混乱。

---

## 使用建议

1. **保持卡片简洁** — 标题 + 简要描述 + 确认/取消
2. **危险操作用红色按钮** — 用 `type: 'danger'`
3. **超时检测** — 注册后 10 分钟未响应自动清理
4. **权限校验** — 在回调中验证操作者身份
5. **错误处理** — 始终检查 `sendCard()` 和 `parseCardAction()` 的返回值

---

## 参考资源

- 完整指南: [docs/CARD-CONFIRM-GUIDE.md](./CARD-CONFIRM-GUIDE.md)
- 快速参考: [docs/CARD-QUICK-REFERENCE.md](./CARD-QUICK-REFERENCE.md)
- 示例代码: [src/plugins/feishu-card-actions-example.js](../src/plugins/feishu-card-actions-example.js)
- 飞书 API: https://open.larksuite.com/document/server-docs/im-v1/message/create

---

## 总结

整个实现遵循以下原则：

- **非侵入式** — 不改变现有消息处理流程
- **易使用** — 三行代码就能发卡片
- **可维护** — 单一职责，测试完整
- **可扩展** — 支持任意自定义数据和业务逻辑

现在可以在飞书中使用交互卡片进行确认流程了！ 🎉

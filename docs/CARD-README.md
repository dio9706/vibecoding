# 飞书卡片交互（Card Interactive）

完整的飞书交互卡片实现，支持确认/取消操作，让用户通过点击按钮而非回复文字进行交互。

## 🎯 功能特性

- 📱 **交互卡片** — 发送富文本卡片，支持确认/取消二选一
- ✅ **实时回调** — 用户点击按钮立即触发回调，无需等待
- 🔄 **状态更新** — 点击后自动更新卡片为最终状态（防重复点击）
- 📦 **自定义数据** — 卡片中传递业务上下文，回调时原样返回
- 🛡️ **错误处理** — 完整的异常捕获和超时管理
- 📚 **完整文档** — 详细指南 + 快速参考 + 代码示例

## 🚀 快速开始

### 最简单的例子

```javascript
import { createConfirmCard, parseCardAction } from '../shared/card-confirm.js';
import { registerCardActionHandler } from '../entrypoints/feishu/index.js';
import { getChannel } from '../channels/index.js';

const channel = getChannel('feishu');

// 1️⃣ 生成卡片
const { card, confirmed, cancelled } = createConfirmCard(
  '确认删除？',
  'file.txt'
);

// 2️⃣ 发送卡片
const result = await channel.sendCard(chatId, card);

// 3️⃣ 注册回调
registerCardActionHandler(result.message_id, async (data) => {
  const action = parseCardAction(data);
  if (action?.action === 'confirm') {
    await channel.updateCard(result.message_id, confirmed());
    await deleteFile('file.txt');  // ← 执行业务逻辑
  } else {
    await channel.updateCard(result.message_id, cancelled());
  }
});
```

## 📖 文档导航

| 文档 | 用途 | 阅读时间 |
|------|------|---------|
| [CARD-QUICK-REFERENCE.md](./CARD-QUICK-REFERENCE.md) | 快速参考，包含 API、示例、常见问题 | 10 分钟 |
| [CARD-CONFIRM-GUIDE.md](./CARD-CONFIRM-GUIDE.md) | 详细使用指南，包含模式、调试 | 20 分钟 |
| [IMPLEMENTATION-SUMMARY.md](./IMPLEMENTATION-SUMMARY.md) | 架构和实现细节 | 15 分钟 |
| [CARD-CHECKLIST.md](./CARD-CHECKLIST.md) | 集成清单和最佳实践 | 10 分钟 |

## 💻 代码文件

### 核心库

```
src/shared/card-confirm.js              ← 卡片生成和解析
  ├─ createConfirmCard()               ← 生成确认卡片
  ├─ createInfoCard()                  ← 生成信息卡片
  └─ parseCardAction()                 ← 解析回调事件
```

### 集成点

```
src/integrations/lark.js
  ├─ sendCard()                        ← 发送卡片到飞书
  └─ updateCard()                      ← 更新已发送的卡片

src/channels/feishu.js
  ├─ 注册 card.action.trigger 事件     ← 监听按钮点击
  └─ 导出 sendCard, updateCard         ← channel 方法

src/entrypoints/feishu/index.js
  ├─ registerCardActionHandler()       ← 注册回调处理
  └─ onCardAction()                    ← 全局分发器
```

### 示例和测试

```
src/plugins/feishu-card-actions-example.js  ← 4 个完整示例
tests/card-confirm.test.js                  ← 单元测试
tests/card-integration.test.js              ← 集成测试
```

## 📚 典型使用场景

### 场景 1: 确认危险操作

```javascript
const { card, confirmed } = createConfirmCard(
  '⚠️  删除生产数据库',
  'prod-backup-2024-07-30.sql'
);

const result = await channel.sendCard(chatId, card);
registerCardActionHandler(result.message_id, async (data) => {
  const action = parseCardAction(data);
  if (action?.action === 'confirm') {
    await channel.updateCard(result.message_id, confirmed());
    await deleteBackup('prod-backup-2024-07-30.sql');
  }
});
```

### 场景 2: 批准工作流

```javascript
const { card, confirmed } = createConfirmCard(
  '发布新版本',
  `版本: v1.2.3\n环境: production\n负责人: ${approver}`,
  { version: 'v1.2.3', env: 'prod', approver }
);

const result = await channel.sendCard(chatId, card);
registerCardActionHandler(result.message_id, async (data) => {
  const action = parseCardAction(data);
  if (action?.action === 'confirm') {
    await channel.updateCard(result.message_id, confirmed());
    await releaseVersion(action.value.version);
  }
});
```

### 场景 3: 多步骤确认

```javascript
const steps = ['构建', '测试', '部署'];
for (const step of steps) {
  const { card, confirmed } = createConfirmCard(`执行: ${step}`, '');
  const result = await channel.sendCard(chatId, card);
  
  await new Promise(resolve => {
    registerCardActionHandler(result.message_id, async (data) => {
      const action = parseCardAction(data);
      if (action?.action === 'confirm') {
        await channel.updateCard(result.message_id, confirmed());
        await executeStep(step);
      }
      resolve();
    });
  });
}
```

## 🔧 API 参考

### `createConfirmCard(title, detail, value)`

生成确认卡片。

**参数：**
- `title` (string) — 卡片标题
- `detail` (string) — 卡片内容，支持多行
- `value` (object, 可选) — 自定义数据，回调时原样返回

**返回：**
```javascript
{
  card: {...},           // 发送这个给飞书
  confirmed: () => {...}, // 点击确认后的卡片
  cancelled: () => {...}  // 点击取消后的卡片
}
```

### `channel.sendCard(chatId, card)`

发送卡片到会话。

**参数：**
- `chatId` (string) — 飞书会话 ID（`oc_` 开头）
- `card` (object) — 卡片 JSON

**返回：**
```javascript
{ message_id: "om_xxx" }  // 用于注册回调
```

### `registerCardActionHandler(messageId, handler)`

注册按钮点击回调。

**参数：**
- `messageId` (string) — 卡片消息 ID
- `handler` (async function) — 回调处理函数

**handler 参数：**
```javascript
{
  message_id: "om_xxx",
  conversation: { chat_id: "oc_xxx" },
  operator: { open_id: "ou_xxx" },
  action: {
    value: {
      action: "confirm" | "cancel",
      // ... 自定义数据
    }
  }
}
```

### `parseCardAction(callbackData)`

解析飞书回调。

**参数：**
- `callbackData` (object) — 飞书 `card.action.trigger` 事件数据

**返回：**
```javascript
{
  action: "confirm" | "cancel",
  value: { /* 自定义数据 */ },
  operator: { openId, userId },
  messageId: "om_xxx",
  chatId: "oc_xxx"
}
// 或 null（如果格式不对）
```

### `channel.updateCard(messageId, card)`

更新已发送的卡片。

**参数：**
- `messageId` (string) — 卡片消息 ID
- `card` (object) — 新卡片 JSON

## ✅ 测试

运行单元测试：
```bash
npm test -- card-confirm.test.js
```

运行集成测试：
```bash
npm test -- card-integration.test.js
```

测试覆盖：
- ✅ 卡片生成（15 个用例）
- ✅ 回调解析（8 个用例）
- ✅ 错误处理
- ✅ 完整流程

## 🎨 卡片样式

### 基础样式

```javascript
const { card } = createConfirmCard(
  '确认操作',
  'operation details'
);

// 卡片自动包含：
// - 标题（加粗）
// - 内容（代码块）
// - 确认按钮（蓝色，type: 'primary'）
// - 取消按钮（红色，type: 'danger'）
```

### 自定义样式（高级）

```javascript
// 危险操作
card.elements[1].actions[0].type = 'danger';
card.elements[1].actions[0].text.content = '🔥 强制执行';

// 多选项
card.elements[1].actions = [
  { tag: 'button', value: { action: 'dev' }, ... },
  { tag: 'button', value: { action: 'staging' }, ... },
  { tag: 'button', value: { action: 'prod' }, ... }
];
```

## 🔐 权限和安全

### 飞书应用权限

确保应用配置了以下权限（scopes）：
- `im:message` — 发送消息
- `im:message.reaction:write_only` — 表情回复（可选）

### 权限检查

在回调中验证操作者身份：
```javascript
registerCardActionHandler(messageId, async (data) => {
  const action = parseCardAction(data);
  const operatorId = action.operator.openId;
  
  if (!isAuthorized(operatorId)) {
    await ctx.reply('❌ 无权限');
    return;
  }
  
  // 继续处理
});
```

## 🐛 调试

### 检查卡片是否发送成功

```javascript
const result = await channel.sendCard(chatId, card);
console.log('message_id:', result?.message_id);  // ← 应该有值
```

### 检查回调是否收到

```javascript
registerCardActionHandler(messageId, async (data) => {
  console.log('Card action:', data);  // ← 应该能看到点击事件
});
```

### 常见问题

| 问题 | 解决方案 |
|------|---------|
| 卡片没发送 | 检查 `chatId` 和飞书凭证 |
| 回调没收到 | 检查 `messageId` 和飞书应用事件订阅 |
| 卡片显示异常 | 检查 Markdown 语法和卡片大小（<16KB） |

详见 [CARD-QUICK-REFERENCE.md](./CARD-QUICK-REFERENCE.md#常见问题)。

## 📋 集成检查单

- [ ] 飞书应用已配置 `im:message` scope
- [ ] 机器人已被添加到目标会话
- [ ] 单元测试和集成测试都通过
- [ ] 手工测试：发送卡片 ✅
- [ ] 手工测试：点击确认 ✅
- [ ] 手工测试：点击取消 ✅
- [ ] 实现了错误处理
- [ ] 实现了超时清理

## 📝 示例代码

完整的 4 个示例见 [src/plugins/feishu-card-actions-example.js](../src/plugins/feishu-card-actions-example.js)：

1. **Git 操作确认** — `confirmGitOperation()`
2. **任务状态变更** — `confirmTaskStatusChange()`
3. **环境选择** — `selectDeploymentEnvironment()`
4. **多步骤发布** — `multiStepReleaseApproval()`

## 🔄 流程图

```
用户请求操作
  ↓
机器人生成卡片 (createConfirmCard)
  ↓
发送卡片 (channel.sendCard)
  ↓
用户在飞书中点击按钮
  ↓
飞书发送 card.action.trigger 事件
  ↓
回调处理器执行 (registerCardActionHandler)
  ↓
  ├─ 解析事件 (parseCardAction)
  ├─ 验证权限
  ├─ 更新卡片 (channel.updateCard)
  └─ 执行业务逻辑
```

## 🚀 下一步

1. **阅读文档** — 从 [CARD-QUICK-REFERENCE.md](./CARD-QUICK-REFERENCE.md) 开始
2. **查看示例** — [src/plugins/feishu-card-actions-example.js](../src/plugins/feishu-card-actions-example.js)
3. **运行测试** — `npm test -- card-*.test.js`
4. **集成项目** — 按照快速开始部分添加卡片确认流程
5. **部署上线** — 按照 [CARD-CHECKLIST.md](./CARD-CHECKLIST.md) 验证

## 📞 支持

- 📖 详细指南：[CARD-CONFIRM-GUIDE.md](./CARD-CONFIRM-GUIDE.md)
- ⚡ 快速参考：[CARD-QUICK-REFERENCE.md](./CARD-QUICK-REFERENCE.md)
- 🏗️ 实现细节：[IMPLEMENTATION-SUMMARY.md](./IMPLEMENTATION-SUMMARY.md)
- ✅ 集成清单：[CARD-CHECKLIST.md](./CARD-CHECKLIST.md)

---

**现在可以在飞书中使用交互卡片进行确认流程了！** 🎉

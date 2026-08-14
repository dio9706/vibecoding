# 飞书卡片交互 — 集成清单

## ✅ 已完成的实现

### 核心代码

- [x] **卡片生成工具** (`src/shared/card-confirm.js`)
  - `createConfirmCard(title, detail, value)` — 生成确认卡片
  - `createInfoCard(title, detail, type)` — 生成信息卡片  
  - `parseCardAction(callbackData)` — 解析回调事件

- [x] **飞书 API 封装** (`src/integrations/lark.js`)
  - `sendCard(chatId, cardContent)` — 发送卡片
  - `updateCard(messageId, cardContent)` — 更新卡片

- [x] **事件回调处理** (`src/channels/feishu.js`)
  - 注册 `card.action.trigger` 事件监听
  - channel 支持 `sendCard()` 和 `updateCard()` 方法
  - `start()` 接受 `onCardAction` 参数

- [x] **业务入口** (`src/entrypoints/feishu/index.js`)
  - 全局卡片回调处理器 `cardActionHandlers`
  - 导出 `registerCardActionHandler(messageId, handler)`
  - 传递 `onCardAction` 到 channel

### 示例和文档

- [x] **完整示例** (`src/plugins/feishu-card-actions-example.js`)
  - 示例 1: Git 操作确认
  - 示例 2: 任务状态变更批准
  - 示例 3: 多选项环境选择
  - 示例 4: 多步骤发布流程

- [x] **使用指南** (`docs/CARD-CONFIRM-GUIDE.md`)
  - 详细的 API 说明
  - 5 个常见模式
  - 调试建议

- [x] **快速参考** (`docs/CARD-QUICK-REFERENCE.md`)
  - 最小可行代码
  - 三个常见场景
  - 常见问题解答

- [x] **实现总结** (`docs/IMPLEMENTATION-SUMMARY.md`)
  - 架构图
  - 文件清单
  - 测试覆盖说明

### 测试

- [x] **单元测试** (`tests/card-confirm.test.js`)
  - 卡片生成测试
  - 状态转移测试
  - 回调解析测试
  - 错误处理测试

- [x] **集成测试** (`tests/card-integration.test.js`)
  - 完整流程测试
  - 多步骤测试
  - 自定义数据往返测试
  - JSON 序列化测试

---

## 🚀 使用步骤

### 第一步：理解核心概念

阅读 [快速参考](./CARD-QUICK-REFERENCE.md)（5 分钟）。

### 第二步：在你的业务中集成

```javascript
// 1. 导入必要函数
import { createConfirmCard, parseCardAction } from '../shared/card-confirm.js';
import { registerCardActionHandler } from '../entrypoints/feishu/index.js';
import { getChannel } from '../channels/index.js';

const channel = getChannel('feishu');

// 2. 需要确认时，发卡片
async function handleUserRequest(ctx, operation) {
  const { card, confirmed, cancelled } = createConfirmCard(
    '确认操作',
    describeOperation(operation),
    { operationId: operation.id, userId: ctx.user.id }
  );

  const result = await channel.sendCard(ctx.sessionKey, card);
  if (!result?.message_id) {
    await ctx.reply('❌ 发送确认卡片失败');
    return;
  }

  // 3. 注册回调处理
  registerCardActionHandler(result.message_id, async (callbackData) => {
    const action = parseCardAction(callbackData);
    if (!action) return;

    if (action.action === 'confirm') {
      // 执行操作
      await channel.updateCard(result.message_id, confirmed());
      await executeOperation(operation);
    } else {
      await channel.updateCard(result.message_id, cancelled());
    }
  });
}
```

### 第三步：参考示例

完整示例见 [src/plugins/feishu-card-actions-example.js](../src/plugins/feishu-card-actions-example.js)。

### 第四步：运行测试验证

```bash
npm test -- card-confirm.test.js
npm test -- card-integration.test.js
```

---

## 📋 检查清单

在将卡片交互集成到正式流程前，确保：

### 设计检查

- [ ] 确认操作的标题清晰明了
- [ ] 确认操作的描述足够详细（关键参数）
- [ ] 危险操作使用红色按钮（`type: 'danger'`）
- [ ] 按钮文案是"确认/取消"还是自定义？
- [ ] 是否需要多选项（非二选一）？

### 代码检查

- [ ] 检查 `sendCard()` 的返回值
- [ ] 检查 `parseCardAction()` 的返回值
- [ ] 实现了超时清理逻辑？
- [ ] 实现了权限检查？
- [ ] 实现了错误处理？

### 测试检查

- [ ] 单元测试通过
- [ ] 集成测试通过
- [ ] 手工测试：点击确认
- [ ] 手工测试：点击取消
- [ ] 手工测试：点击后再点一次（幂等性）

### 部署检查

- [ ] 飞书应用已配置 `im:message` scope
- [ ] 机器人已被添加到测试会话
- [ ] 日志系统能正常记录卡片事件
- [ ] 监控系统已配置告警（可选）

---

## 🔍 常见问题排查

### 卡片没有发送

```javascript
const result = await channel.sendCard(chatId, card);
console.log('sendCard result:', result);  // ← 检查这里
```

检查：
- [ ] `chatId` 是否正确（`oc_` 开头）
- [ ] `card` 是否是有效的 JSON
- [ ] 飞书应用凭证是否正确
- [ ] 查看 `logger` 输出中的错误信息

### 回调没有收到

```javascript
registerCardActionHandler(messageId, async (data) => {
  console.log('Card action triggered:', data);  // ← 应该看到这个
});
```

检查：
- [ ] `messageId` 是否正确（来自 `sendCard` 返回值）
- [ ] 用户是否在 5 分钟内点击
- [ ] 飞书应用事件订阅是否包含 `card.action.trigger`
- [ ] 查看 `feishu.js` 的 EventDispatcher 日志

### 卡片显示异常

在飞书中查看卡片内容：
- [ ] Markdown 语法是否正确
- [ ] 标题是否过长（超过 100 字）
- [ ] 内容是否包含特殊字符需要转义
- [ ] 按钮数量是否超过 6 个

### 权限错误

如果收到"无权限"错误：
- [ ] 飞书应用权限配置：`im:message`, `im:message.reaction:write_only`
- [ ] 机器人是否被添加到目标会话
- [ ] 是否在内部网络隔离环境中

---

## 📚 文档导航

| 场景 | 文档 |
|------|------|
| 我想快速了解 | [快速参考](./CARD-QUICK-REFERENCE.md) |
| 我想深入学习 | [详细指南](./CARD-CONFIRM-GUIDE.md) |
| 我想看代码例子 | [src/plugins/feishu-card-actions-example.js](../src/plugins/feishu-card-actions-example.js) |
| 我想了解实现细节 | [实现总结](./IMPLEMENTATION-SUMMARY.md) |
| 我想修改卡片样式 | [飞书官方文档](https://open.larksuite.com/document/server-docs/im-v1/message-card) |

---

## 💡 最佳实践

### 1. 确认卡片应该简洁

✅ 好：
```
标题: 确认删除文件？
内容: path/to/file.txt
```

❌ 不好：
```
标题: 你确认要执行以下操作吗？
内容: 本系统将执行一个删除操作，该操作将移除一个位于 path/to/file.txt 的文件，此操作无法撤销…
```

### 2. 危险操作要明确标记

```javascript
const { card, confirmed } = createConfirmCard(
  '⚠️  删除生产数据库备份',
  'backup-prod-2024-07-30.sql'
);

// 确认按钮使用红色
card.elements[1].actions[0].type = 'danger';
```

### 3. 自定义数据要足够识别上下文

```javascript
// ❌ 不好：只传 id
{ operationId: '123' }

// ✅ 好：传足够的上下文
{ 
  operationId: '123',
  operationType: 'delete_backup',
  backupName: 'backup-prod-2024-07-30.sql',
  approver: ctx.user.id
}
```

### 4. 实现超时清理

```javascript
const TIMEOUT_MS = 10 * 60 * 1000;  // 10 分钟
setTimeout(() => {
  cardActionHandlers.delete(messageId);
}, TIMEOUT_MS);
```

### 5. 始终检查返回值

```javascript
const action = parseCardAction(callbackData);
if (!action) {
  logger.warn('Invalid card action');
  return;  // 安全退出
}

if (action.action === 'confirm') {
  // ...
}
```

---

## 🎯 下一步可选功能

### 短期（1-2 周）
- [ ] 添加进度卡片支持
- [ ] 添加表单卡片支持
- [ ] 卡片模板库

### 中期（1-2 月）
- [ ] 卡片队列管理（防止用户混乱）
- [ ] 卡片分析（哪些操作被批准/拒绝最多）
- [ ] 卡片权限管理（不同用户不同操作）

### 长期（3-6 月）
- [ ] 卡片与工作流引擎集成
- [ ] 卡片多语言支持
- [ ] 卡片与报表系统集成

---

## 📞 技术支持

遇到问题？

1. 查看 [常见问题](./CARD-QUICK-REFERENCE.md#常见问题) 部分
2. 阅读 [调试建议](./CARD-CONFIRM-GUIDE.md#调试)
3. 运行单元测试和集成测试
4. 检查飞书官方文档：https://open.larksuite.com/

---

## 版本历史

- **v1.0** (2026-07-30) — 初始实现
  - 基础卡片生成
  - 确认/取消二选一
  - 回调处理和卡片更新
  - 完整的文档和测试

---

## 许可

本实现遵循项目的 LICENSE。

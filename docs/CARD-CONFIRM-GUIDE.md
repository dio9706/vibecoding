# 飞书卡片确认交互指南

## 概述

支持通过交互卡片（interactive card）向用户发送确认请求，用户点击按钮后触发回调，机器人继续执行或取消操作。整个流程包括：

1. 生成卡片 JSON
2. 发送卡片到飞书
3. 用户点击按钮，飞书发回 `card.action.trigger` 回调
4. 机器人处理回调，更新卡片为最终状态

---

## 核心模块

### 1. `src/shared/card-confirm.js`
提供卡片生成和解析函数：

- **`createConfirmCard(title, detail, value)`** — 生成确认/取消双按钮卡片
- **`createInfoCard(title, detail, type)`** — 生成纯信息卡片（无按钮）
- **`parseCardAction(callbackData)`** — 从飞书回调事件提取操作和数据

### 2. `src/integrations/lark.js`
飞书 API 调用：

- **`sendCard(chatId, cardContent)`** — 发送卡片到会话
- **`updateCard(messageId, cardContent)`** — 更新已发送的卡片

### 3. `src/channels/feishu.js`
事件分发和回调处理：

- 注册 `card.action.trigger` 事件监听
- 回调通过 `onCardAction` 分发给入口处理

### 4. `src/entrypoints/feishu/index.js`
高层业务逻辑：

- **`registerCardActionHandler(messageId, handler)`** — 为卡片注册按钮回调处理函数
- `onCardAction` — 全局回调分发器

---

## 使用示例

### 基础流程：确认执行危险操作

```javascript
import { getChannel } from '../../channels/index.js';
import { createConfirmCard, parseCardAction } from '../../shared/card-confirm.js';
import { registerCardActionHandler } from '../../entrypoints/feishu/index.js';

const channel = getChannel('feishu');

async function triggerDangerousAction(ctx, command) {
  const { title, detail } = describeCommand(command);
  
  // 1. 生成卡片
  const { card, confirmed, cancelled } = createConfirmCard(
    title,
    detail,
    { command, userId: ctx.user.id, timestamp: Date.now() }
  );

  // 2. 发送卡片
  const result = await channel.sendCard(ctx.sessionKey, card);
  const messageId = result?.message_id;

  // 3. 注册回调处理
  registerCardActionHandler(messageId, async (callbackData) => {
    const action = parseCardAction(callbackData);
    if (!action) return;

    if (action.action === 'confirm') {
      // 用户确认：更新卡片为"已确认"并执行操作
      await channel.updateCard(messageId, confirmed());
      await executeCommand(command);
      await channel.send(ctx.sessionKey, {
        text: `✅ 已执行：${title}`,
      });
    } else {
      // 用户取消
      await channel.updateCard(messageId, cancelled());
      await channel.send(ctx.sessionKey, {
        text: `❌ 已取消：${title}`,
      });
    }
  });
}

function describeCommand(cmd) {
  return {
    title: '是否执行 git push？',
    detail: `git push ${cmd.branch || 'origin main'}`,
  };
}
```

### 带业务上下文的确认

```javascript
async function approveTaskChange(ctx, taskId, newStatus) {
  const task = await loadTask(taskId);
  const { card, confirmed } = createConfirmCard(
    '确认变更任务状态',
    `任务: ${task.title}\n当前: ${task.status}\n新状态: ${newStatus}`,
    { taskId, newStatus, operatorId: ctx.user.id }
  );

  const result = await channel.sendCard(ctx.sessionKey, card);

  registerCardActionHandler(result?.message_id, async (callbackData) => {
    const action = parseCardAction(callbackData);
    if (action?.action === 'confirm') {
      await channel.updateCard(result.message_id, confirmed());
      await updateTaskStatus(taskId, newStatus);
    }
  });
}
```

### 组合多个操作

```javascript
async function multiStepApproval(ctx, operations) {
  for (const op of operations) {
    const { card, confirmed, cancelled } = createConfirmCard(
      op.name,
      op.description,
      { opId: op.id }
    );

    const result = await channel.sendCard(ctx.sessionKey, card);

    await new Promise((resolve) => {
      registerCardActionHandler(result?.message_id, async (callbackData) => {
        const action = parseCardAction(callbackData);
        if (action?.action === 'confirm') {
          await channel.updateCard(result.message_id, confirmed());
          await executeOperation(op);
        } else {
          await channel.updateCard(result.message_id, cancelled());
        }
        resolve();
      });
    });
  }
}
```

---

## 回调事件结构

飞书发回的 `card.action.trigger` 事件：

```javascript
{
  message_id: "om_xxx",           // 卡片消息 ID
  conversation: {
    chat_id: "oc_xxx",            // 会话 ID
  },
  operator: {
    open_id: "ou_xxx",            // 点击用户的 open_id
    user_id: "xxxxx",             // 用户 ID
  },
  action: {
    value: {
      action: "confirm" | "cancel", // 用户点击的按钮
      // ... 自定义数据
    }
  }
}
```

---

## 注意事项

### 1. 消息 ID 获取

发送卡片后获取 `message_id`：

```javascript
const result = await channel.sendCard(chatId, card);
const messageId = result?.message_id;  // ← 用这个注册回调
```

### 2. 回调超时

如果用户长时间未点击，回调不会触发。可以在发卡片时附带超时检测：

```javascript
const TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟
const timeoutTimer = setTimeout(() => {
  cardActionHandlers.delete(messageId); // 清理未使用的回调
}, TIMEOUT_MS);

registerCardActionHandler(messageId, async (callbackData) => {
  clearTimeout(timeoutTimer);
  // ... 处理回调
});
```

### 3. 权限检查

回调中可以验证操作者身份：

```javascript
registerCardActionHandler(messageId, async (callbackData) => {
  const action = parseCardAction(callbackData);
  const operatorId = action.operator.openId;
  
  // 检查权限
  if (!isAuthorized(operatorId)) {
    await channel.send(chatId, { text: '❌ 无权限' });
    return;
  }
  
  // ... 继续处理
});
```

### 4. 错误处理

```javascript
registerCardActionHandler(messageId, async (callbackData) => {
  const action = parseCardAction(callbackData);
  if (!action) {
    logger.error('feishu', '卡片回调解析失败', { data: callbackData });
    return;
  }

  try {
    if (action.action === 'confirm') {
      await executeOperation();
    }
  } catch (e) {
    await channel.send(action.chatId, {
      text: `❌ 执行失败: ${e.message}`,
    });
  }
});
```

---

## 常见模式

### 进度报告卡片

```javascript
async function sendProgressCard(chatId, title, steps) {
  const progressText = steps
    .map((s, i) => `${s.done ? '✅' : '⏳'} ${s.name}`)
    .join('\n');
  
  const card = createInfoCard(title, progressText);
  const result = await channel.sendCard(chatId, card);
  
  // 后续更新进度
  for (const step of steps) {
    await executeStep(step);
    const updatedProgressText = steps
      .map((s, i) => `${s.done ? '✅' : '⏳'} ${s.name}`)
      .join('\n');
    await channel.updateCard(result.message_id, createInfoCard(title, updatedProgressText));
  }
}
```

### 选择分支的卡片

目前 `createConfirmCard` 只支持二择一（确认/取消）。如果需要多选项，手动构造卡片：

```javascript
const card = {
  elements: [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: '**请选择环境**' },
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Dev' },
          value: { action: 'select', env: 'dev' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Staging' },
          value: { action: 'select', env: 'staging' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Prod' },
          type: 'danger',
          value: { action: 'select', env: 'prod' },
        },
      ],
    },
  ],
};
```

---

## 调试

### 检查回调是否收到

在 `onCardAction` 中添加日志：

```javascript
// src/entrypoints/feishu/index.js
async function onCardAction(data) {
  logger.info('feishu', '收到卡片回调', { messageId: data?.message_id, value: data?.action?.value });
  // ... 继续处理
}
```

### 检查卡片发送是否成功

```javascript
try {
  const result = await channel.sendCard(chatId, card);
  logger.info('feishu', '卡片已发送', { messageId: result?.message_id });
} catch (e) {
  logger.error('feishu', '卡片发送失败', { err: e.message });
}
```

### 在飞书中查看卡片内容

交互卡片支持飞书内置的卡片渲染。如果显示异常，检查：
- `elements` 数组格式是否正确
- Markdown 内容是否有语法错误
- 按钮的 `value` 是否为有效 JSON

---

## 权限要求

确保飞书应用已配置以下权限（scopes）：

```
im:message
im:message.reaction:write_only
```

机器人需要已被添加到目标会话。

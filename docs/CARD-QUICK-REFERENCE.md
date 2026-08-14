# 飞书卡片交互 — 快速参考

## 最小可行代码

### 发送确认卡片

```javascript
import { getChannel } from '../channels/index.js';
import { createConfirmCard, parseCardAction } from '../shared/card-confirm.js';
import { registerCardActionHandler } from '../entrypoints/feishu/index.js';

const channel = getChannel('feishu');

async function confirmAction(chatId, title, detail) {
  const { card, confirmed, cancelled } = createConfirmCard(title, detail);
  
  const result = await channel.sendCard(chatId, card);
  const messageId = result?.message_id;
  
  registerCardActionHandler(messageId, async (callbackData) => {
    const action = parseCardAction(callbackData);
    if (!action) return;
    
    if (action.action === 'confirm') {
      await channel.updateCard(messageId, confirmed());
      // 执行操作
    } else {
      await channel.updateCard(messageId, cancelled());
    }
  });
}
```

---

## 三个核心函数

### 1. `createConfirmCard(title, detail, value)`

生成二择一的确认卡片。

```javascript
const { card, confirmed, cancelled } = createConfirmCard(
  '确认部署？',
  'git push -f origin main',
  { taskId: 'xxx', userId: 'yyy' }
);

// card: 原始卡片（带两个按钮）
// confirmed(): 用户确认后的卡片（显示✅已确认）
// cancelled(): 用户取消后的卡片（显示❌已取消）
```

**参数：**
- `title` (string) — 卡片标题
- `detail` (string) — 卡片内容（支持多行）
- `value` (object, 可选) — 自定义数据，用户点击时会回传

**返回：**
```javascript
{
  card: {...},           // 发送这个给飞书
  confirmed: () => {...},  // 点击确认后调用
  cancelled: () => {...}   // 点击取消后调用
}
```

---

### 2. `channel.sendCard(chatId, cardJson)`

发送卡片到会话。

```javascript
const result = await channel.sendCard('oc_xxx', card);
const messageId = result?.message_id;  // ← 用这个注册回调

// 返回: { message_id: "om_xxx" }
```

**参数：**
- `chatId` — 飞书会话 ID (`oc_`)
- `cardJson` — 卡片 JSON（来自 `createConfirmCard` 的 `card` 字段）

---

### 3. `registerCardActionHandler(messageId, handler)`

注册按钮点击回调。

```javascript
registerCardActionHandler(messageId, async (callbackData) => {
  const action = parseCardAction(callbackData);
  
  if (action.action === 'confirm') {
    // 用户点击了确认按钮
    await channel.updateCard(messageId, confirmed());
  } else if (action.action === 'cancel') {
    // 用户点击了取消按钮
    await channel.updateCard(messageId, cancelled());
  }
});
```

**handler 参数（callbackData）：**
```javascript
{
  message_id: "om_xxx",
  conversation: { chat_id: "oc_xxx" },
  operator: { open_id: "ou_xxx" },
  action: {
    value: {
      action: "confirm" | "cancel",
      // ... 你在 createConfirmCard 时传的自定义 value
    }
  }
}
```

---

### 4. `parseCardAction(callbackData)`

解析飞书回调事件。

```javascript
const action = parseCardAction(callbackData);

// 返回:
// {
//   action: "confirm" | "cancel",
//   value: { ... },  // 自定义数据
//   operator: { openId, userId },
//   messageId: "om_xxx",
//   chatId: "oc_xxx"
// }
//
// 或 null（如果格式不对）
```

---

### 5. `channel.updateCard(messageId, newCard)`

更新已发送的卡片（替换整个卡片内容）。

```javascript
await channel.updateCard(messageId, confirmed());
```

---

## 三个常见场景

### 场景 1: 简单的"你确认吗？"

```javascript
const { card, confirmed, cancelled } = createConfirmCard(
  '删除文件？',
  'path/to/file.txt'
);

const result = await channel.sendCard(chatId, card);

registerCardActionHandler(result.message_id, async (data) => {
  const action = parseCardAction(data);
  if (action?.action === 'confirm') {
    await deleteFile('path/to/file.txt');
  }
  await channel.updateCard(result.message_id, 
    action?.action === 'confirm' ? confirmed() : cancelled()
  );
});
```

### 场景 2: 带上下文的确认

```javascript
const { card, confirmed } = createConfirmCard(
  '发布版本',
  `版本: v1.2.3\n环境: production\n时间: ${new Date().toLocaleString()}`,
  { version: 'v1.2.3', env: 'prod' }  // ← 传自定义数据
);

const result = await channel.sendCard(chatId, card);

registerCardActionHandler(result.message_id, async (data) => {
  const action = parseCardAction(data);
  if (action?.action === 'confirm') {
    const version = action.value.version;  // ← 拿回来
    const env = action.value.env;
    await deploy(version, env);
  }
});
```

### 场景 3: 多选项（不用 createConfirmCard）

```javascript
const card = {
  elements: [
    { tag: 'div', text: { tag: 'lark_md', content: '**选择环境**' } },
    {
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: 'Dev' },
          value: { env: 'dev' } },
        { tag: 'button', text: { tag: 'plain_text', content: 'Prod' },
          value: { env: 'prod' }, type: 'danger' },
      ]
    }
  ]
};

const result = await channel.sendCard(chatId, card);

registerCardActionHandler(result.message_id, async (data) => {
  const action = parseCardAction(data);
  const env = action?.value?.env;
  // 根据 env 处理
});
```

---

## 完整流程检查单

```javascript
// ✅ 1. 导入必要函数
import { createConfirmCard, parseCardAction } from '../shared/card-confirm.js';
import { registerCardActionHandler } from '../entrypoints/feishu/index.js';

// ✅ 2. 生成卡片
const { card, confirmed, cancelled } = createConfirmCard(
  '标题',
  '内容',
  { /* 自定义数据 */ }
);

// ✅ 3. 发送卡片
const result = await channel.sendCard(chatId, card);

// ✅ 4. 检查是否成功
if (!result?.message_id) {
  // 发送失败，向用户报错
  return;
}

// ✅ 5. 注册回调
registerCardActionHandler(result.message_id, async (callbackData) => {
  // ✅ 6. 解析回调
  const action = parseCardAction(callbackData);
  if (!action) return;  // 解析失败，安全退出
  
  // ✅ 7. 根据用户选择行动
  if (action.action === 'confirm') {
    // 更新卡片状态
    await channel.updateCard(result.message_id, confirmed());
    // 执行操作
    await doSomething(action.value);
  } else {
    await channel.updateCard(result.message_id, cancelled());
  }
});
```

---

## 常见问题

**Q: 如何获取 `message_id`？**
A: `sendCard` 返回值中的 `message_id` 字段。

**Q: 用户没点按钮怎么办？**
A: 回调不会触发。可以设置超时清理处理器：
```javascript
setTimeout(() => cardActionHandlers.delete(messageId), 5 * 60 * 1000);
```

**Q: 如何传递复杂的自定义数据？**
A: 在 `createConfirmCard` 的第三个参数中传任意 object，会被保存在卡片中，用户点击时原样回传。

**Q: 卡片内容支持 Markdown 吗？**
A: 支持。卡片自动把内容包在 Markdown 标签里，支持标题、列表、代码块等。

**Q: 需要确认前验证权限吗？**
A: 是的，在回调处理器中验证：
```javascript
const operatorId = action.operator.openId;
if (!isAuthorized(operatorId)) {
  await ctx.reply('❌ 无权限');
  return;
}
```

---

## 文件位置速查

| 功能 | 文件 |
|------|------|
| 卡片生成 | `src/shared/card-confirm.js` |
| 飞书 API | `src/integrations/lark.js` (`sendCard`, `updateCard`) |
| 事件分发 | `src/channels/feishu.js` (注册 `card.action.trigger`) |
| 回调注册 | `src/entrypoints/feishu/index.js` (`registerCardActionHandler`) |
| 完整示例 | `src/plugins/feishu-card-actions-example.js` |
| 单元测试 | `tests/card-confirm.test.js` |
| 集成测试 | `tests/card-integration.test.js` |
| 完整指南 | `docs/CARD-CONFIRM-GUIDE.md` |

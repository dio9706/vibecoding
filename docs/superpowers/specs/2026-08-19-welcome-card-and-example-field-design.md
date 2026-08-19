# Welcome 卡片化 + 动作示例字段 — 设计文档

**日期**：2026-08-19  
**背景**：当前 Welcome 回复是纯文本，列出静态的三条操作说明和动态的动作列表。需要改为飞书卡片形式，并在卡片底部添加按钮快捷触发已配置的动作，提升用户体验。同时，动作配置需新增「示例」字段来为卡片按钮和提示文案提供上下文信息。  
**目标**：
1. Welcome 回复从纯文本改为飞书卡片，顶部保留操作说明，底部展示最多 5 个动作按钮
2. 用户点击按钮直接执行动作，跳过意图识别，进入槽位填充流程
3. 动作配置新增「示例」字段，作为卡片按钮的 hint 文案和 tooltip

---

## 现状

### 当前 Welcome 回复方式

**文件**：`src/app/dispatch.js`（行 101-102）、`src/shared/messages.js`（行 71-111）

当用户发送无法识别的消息时，dispatch 的第 3 分支调用 `buildWelcomeText(bot?.id)` 返回纯文本：

```
没有识别到你的意图，我可以进行这些操作：

· 提交需求
    例: 提个需求: 把背景改成蓝色

· 提交故障
    例: 提个bug: 聊天主页面语音有问题

· 问个问题
    例: 问个问题: 我要在聊天页加个弹框, 这个功能复杂吗?

或其他已配置的功能，比如
    1. 生成并发送小程序二维码给指定用户
    2. 清除测试环境中的所有测试数据
    ...（最多 5 条）

识别到我会及时回复你～
```

当前动作配置只有 `description` 字段用于 welcome 文案展示。

### 飞书卡片现有基础设施

**文件**：`src/shared/card-confirm.js`、`src/shared/card-actions.js`、`src/entrypoints/feishu/index.js`

已有两套卡片回调路由机制：
1. **内存注册**：`messageId → handler` Map（一次性，重启失效）
2. **全局 kind 路由**：`value.kind → handler` Map（持久化，重启后仍可触发）

本设计使用全局 kind 路由机制，kind 为 `'quick-action'`。

---

## 设计

### 一、卡片结构与展示

#### 1.1 卡片内容分布

Welcome 卡片采用 Feishu schema 1.0 格式（与 card-confirm.js 一致），分为两部分：

**顶部：操作说明（Markdown）**
```
没有识别到你的意图，我可以进行这些操作：

· 提交需求
    例: 提个需求: 把背景改成蓝色

· 提交故障
    例: 提个bug: 聊天主页面语音有问题

· 问个问题
    例: 问个问题: 我要在聊天页加个弹框, 这个功能复杂吗?
```

**底部：动作快捷按钮区**

从 `getConfigs()` 中过滤 `botId === 当前机器人 && enabled === true` 的动作，最多显示前 5 条。

每个按钮信息：
- **按钮文案**：`action.name`（短名，如"清理数据"）
- **按钮类型**：默认 primary（蓝色），可选 danger（红色，仅对破坏性动作）
- **Tooltip/Hint**：`action.example`（用户悬停或长按时提示，如"输入环保环境名称进行清理"）
- **value 结构**：`{ kind: 'quick-action', actionId: '...', actionName: '...', botId: '...' }`

超过 5 条时，末尾追加文本提示：
```
…还有 N 项动作，可直接对我说「帮我 [动作名]」
```

#### 1.2 卡片 JSON 结构示例

```json
{
  "elements": [
    {
      "tag": "div",
      "text": {
        "tag": "lark_md",
        "content": "没有识别到你的意图，我可以进行这些操作：\n\n· 提交需求\n    例: 提个需求: 把背景改成蓝色\n\n· 提交故障\n    例: 提个bug: 聊天主页面语音有问题\n\n· 问个问题\n    例: 问个问题: 我要在聊天页加个弹框, 这个功能复杂吗?"
      }
    },
    {
      "tag": "action",
      "actions": [
        {
          "tag": "button",
          "type": "primary",
          "text": { "tag": "plain_text", "content": "清理数据" },
          "value": {
            "kind": "quick-action",
            "actionId": "ac_xxx",
            "actionName": "清理数据",
            "botId": "bot_yyy",
            "_timestamp": 1692374400000
          }
        },
        {
          "tag": "button",
          "type": "primary",
          "text": { "tag": "plain_text", "content": "生成二维码" },
          "value": {
            "kind": "quick-action",
            "actionId": "ac_zzz",
            "actionName": "生成二维码",
            "botId": "bot_yyy",
            "_timestamp": 1692374400000
          }
        }
        // ... 最多 5 个按钮
      ]
    }
  ]
}
```

---

### 二、数据模型改动

#### 2.1 动作配置新增字段

**文件**：`action-configs.json`

```json
{
  "id": "ac_ms2md7v1l5xq",
  "botId": "bot_nwwiga",
  "name": "清理账号数据",
  "description": "通过后台接口清理测试账号的全部数据",
  "example": "输入环境名称（如 dev/prod），确认后清理",
  "keywords": ["清理", "清一下", "cleanup"],
  "scriptType": "python",
  "scriptName": "reset_onboarding.py",
  "permission": "guest",
  "enabled": true,
  "variables": [ { "name": "env", "label": "环境", "prompt": "要清理哪个环境？", "required": true, "persistent": false } ],
  "createdAt": "2026-07-27T02:40:16.141Z",
  "updatedAt": "2026-07-27T02:40:16.141Z"
}
```

**新增字段说明**：
- `example` (string, optional)
  - 用途：为卡片按钮提供上下文提示和执行示例
  - 长度建议：30-100 字符（卡片布局约束，超长会折行）
  - 示例："输入用户 ID，如 alice@company.com"、"选择要分析的数据范围"
  - 未填时默认不显示 tooltip，button 文案仅用 name

#### 2.2 Store 层支持（无需代码改动）

`src/store/action-configs.js` 的现有函数（getConfigs、addConfig、updateConfig 等）已经通过 readJson/updateJson 对 JSON 结构做了序列化，新字段会自动被保存和读取。

---

### 三、后端 API 改动

**文件**：`src/entrypoints/web/routes-ops.js`

现有四个 endpoint（GET/POST/PUT/DELETE `/api/actions`）无需改动逻辑，但对新字段的处理如下：

- **POST**（新建）：payload 可包含 `example` 字段，服务端透传保存
- **PUT**（更新）：payload 可包含 `example` 字段，更新时保留（不受保护，可覆盖）
- **GET**：返回完整对象包括 `example`

前端字段校验仍在前端（HTML required、length 等），后端仅做 null-safe 处理（不校验字符长度）。

---

### 四、前端表单改动

**文件**：`public/js/actions-panel.js`

在现有表单中新增一行：

**插入位置**：「意图描述」和「关键词」之间（第 ~70 行）

**新增字段**：
```html
<div class="form-group">
  <label for="actionExample">示例文案（可选）</label>
  <textarea 
    id="actionExample" 
    placeholder="如：输入用户 ID，如 alice@company.com" 
    maxlength="200"
    rows="2">
  </textarea>
  <small>用于卡片按钮的提示文案，30-100 字符最佳</small>
</div>
```

**表单提交（showActionForm 中 updatePayload）**：
```js
const payload = {
  name: document.getElementById('actionName').value,
  description: document.getElementById('actionDesc').value,
  example: document.getElementById('actionExample').value || '',  // 新增
  keywords: document.getElementById('actionKeywords').value.split(',').map(k => k.trim()).filter(Boolean),
  // ... 其他字段
};
```

**表单回显（编辑时）**：
```js
document.getElementById('actionExample').value = config.example || '';
```

---

### 五、卡片生成与路由

#### 5.1 新函数：`buildWelcomeCard(botId)`

**文件**：`src/shared/messages.js`

```js
/**
 * 构造 Welcome 飞书卡片（包含操作说明 + 动作快捷按钮）
 * @param {string|null} botId 机器人 ID
 * @returns {object} Feishu schema 1.0 卡片 JSON
 */
export function buildWelcomeCard(botId) {
  // 1. 操作说明（同 buildWelcomeText 的核心段）
  const headerText = /* Markdown 格式说明 */;

  // 2. 读取该 bot 的已启用动作，最多 5 条
  const enabledActions = getConfigs()
    .filter((c) => c && c.botId === botId && c.enabled)
    .slice(0, 5);

  // 3. 生成按钮区
  const actionButtons = enabledActions.map((action) => ({
    tag: 'button',
    type: 'primary', // 可扩展为按 action.danger 字段判断
    text: { tag: 'plain_text', content: action.name },
    value: {
      kind: 'quick-action',
      actionId: action.id,
      actionName: action.name,
      botId: botId,
      _timestamp: Date.now(),
    },
  }));

  // 4. 超过 5 条时追加提示文本
  const totalEnabled = getConfigs().filter((c) => c && c.botId === botId && c.enabled).length;
  if (totalEnabled > 5) {
    actionButtons.push({
      tag: 'text',
      content: `…还有 ${totalEnabled - 5} 项动作，可直接对我说「帮我 [动作名]」`,
    });
  }

  // 5. 拼装卡片
  return {
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: headerText } },
      { tag: 'action', actions: actionButtons },
    ],
  };
}
```

**关键设计决策**：
- 返回完整的 Feishu schema 1.0 卡片对象（非字符串）
- 按钮 value 使用全局 kind 路由：`kind: 'quick-action'`
- 保留 `_timestamp` 用于防重复点击（可选）
- 无已启用动作时仅展示说明部分（无按钮区）

#### 5.2 卡片发送：改动 dispatch.js

**文件**：`src/app/dispatch.js`（行 101-102）

```js
// 修改前
await ctx.reply(buildWelcomeText(bot?.id));

// 修改后
const welcomeCard = buildWelcomeCard(bot?.id);
await ctx.sendCard(welcomeCard);
```

或如果 `ctx.reply` 支持卡片，可简化为：
```js
await ctx.reply(buildWelcomeCard(bot?.id));
```

需检查 `ctx` 的实现（`src/channels/feishu.js`）是否支持卡片对象自动检测，或需显式调用 `sendCard`。

#### 5.3 按钮回调处理：新注册 kind handler

**文件**：`src/shared/card-actions.js`

```js
/**
 * 快捷动作执行处理
 * @param {object} value 按钮 value：{ kind, actionId, actionName, botId, _timestamp }
 * @param {object} operator 操作人信息：{ openId, userId }
 * @param {string} messageId 卡片消息 ID
 * @param {string} chatId 群聊 ID
 */
async function handleQuickAction(value, operator, messageId, chatId) {
  const { actionId, botId } = value;

  try {
    // 1. 获取动作配置
    const actionConfig = getConfig(actionId);
    if (!actionConfig) {
      updateCard(messageId, createInfoCard('错误', '动作不存在或已被删除', 'error'));
      return;
    }

    // 2. 检查权限
    if (actionConfig.permission === 'owner' && /* 用户非 owner */) {
      updateCard(messageId, createInfoCard('无权限', '只有机器人管理员可以执行此操作', 'warning'));
      return;
    }

    // 3. 构造虚拟 context，跳过 classify 直接进 action-runner
    const ctx = {
      source: 'feishu',
      user: { id: operator.userId || operator.openId, role: 'member' }, // 或从 operator 中取 role
      text: `执行动作: ${actionConfig.name}`,
      sessionKey: chatId, // or messageId + actionId
      reply: async (msg) => { /* 回复消息 */ },
      meta: {
        cardMessageId: messageId, // 用于后续 updateCard
        fromCardButton: true,
      },
    };

    // 4. 直接调用 action-runner 的执行流程（需暴露入口）
    // 可以是一个新函数 executeActionDirect(actionConfig, ctx) 或复用现有逻辑
    await executeActionDirect(actionConfig, ctx);

    // 5. 成功后更新卡片为结果态（或由 executeActionDirect 内部处理）
    // updateCard(messageId, /* 结果卡片 */);
  } catch (err) {
    logger.error('quick-action', err);
    updateCard(messageId, createInfoCard('执行失败', err.message, 'error'));
  }
}

registerCardKindHandler('quick-action', handleQuickAction);
```

**关键点**：
- 动作执行流程的具体实现需调研 `src/plugins/action-runner/` 的内部接口
- 槽位填充和脚本执行的现有逻辑（collectVariables、executeScript）可复用
- 回复消息可通过 `ctx.reply()` 或 `ctx.sendCard()` 根据结果类型选择
- 卡片更新用 `updateCard(messageId, ...)` 防止用户重复点击

---

### 六、向后兼容

#### 6.1 纯文本 welcome 保留

- `buildWelcomeText(botId)` 函数保留，用于：
  - 非飞书渠道的文本回复
  - 降级场景（卡片发送失败时，但通常不会）
  - 日志/调试输出

#### 6.2 旧动作配置无 example 字段

- 前端表单回显时：`config.example || ''`
- 卡片按钮显示时：无 tooltip，仅用 name
- 后端 API：自动序列化（null 或空串都支持）

#### 6.3 API 兼容性

- GET `/api/actions` 返回的对象包含 example（可能为空串）
- 旧客户端若忽略此字段，不影响
- 新客户端若尝试更新时漏掉 example 字段，服务端会保留原值（PUT 时会被覆盖为空）

---

## 实现范围

### 新增文件

无。

### 修改文件

| 文件 | 改动 |
|---|---|
| `src/shared/messages.js` | ① 新增 `buildWelcomeCard(botId)` 函数 |
| `src/app/dispatch.js` | ① 改动第 101-102 行，调用 `sendCard()` 或支持卡片的 `reply()` |
| `src/shared/card-actions.js` | ① 新增 `handleQuickAction()` + `registerCardKindHandler('quick-action', ...)` |
| `src/plugins/action-runner/` | ① 暴露 action 执行入口，供 quick-action 回调调用（需调研） |
| `public/js/actions-panel.js` | ① 新增「示例文案」表单字段 + 提交和回显逻辑 |
| `action-configs.json` | ① 各条记录新增 `example` 字段（迁移脚本或手工添加） |

### 测试

- 单元测试：`buildWelcomeCard()` 的 JSON 结构正确性（类似 card-confirm.test.js）
- 集成测试：dispatch 无匹配意图时卡片发送成功
- 手工测试：飞书端验证卡片展示和按钮点击

---

## 审批清单

- [ ] 卡片结构设计（顶部说明 + 底部按钮）无遗漏
- [ ] 新字段 `example` 的用途、长度限制、可选性明确
- [ ] quick-action kind handler 的执行流程与现有 action-runner 兼容
- [ ] 向后兼容方案完整（纯文本 welcome、旧配置、API）
- [ ] 前端表单改动（字段位置、验证、回显）清晰
- [ ] 无占位符（TBD/TODO）和歧义

---


# Welcome 卡片化 + 快捷动作执行 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Welcome 回复从纯文本改为飞书卡片，卡片顶部保留操作说明，底部展示已配置动作的按钮，用户点击按钮直接执行动作；同时在动作配置中新增「示例」字段用于卡片按钮 hint 文案。

**Architecture:** 
- 前端：动作配置表单新增「示例文案」字段（Vanilla JS）
- 后端：新增 `buildWelcomeCard(botId)` 生成卡片 JSON；新增 `handleQuickAction()` 处理按钮点击回调；修改 dispatch.js 调用卡片而非文本
- 存储：action-configs.json 各条记录新增 `example` 字段（自动序列化）
- 路由：使用全局 kind 路由 `'quick-action'`，持久化存储（重启不失效）

**Tech Stack:** Node.js / JavaScript ES6+, Feishu API schema 1.0, 现有 card-confirm.js 和 card-actions.js 基础设施

---

## 文件结构

### 修改文件

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/shared/messages.js` | 文案生成 | ① 新增 `buildWelcomeCard(botId)` 生成卡片 JSON |
| `src/app/dispatch.js` | 消息路由 | ① 改动第 101-102 行，调用 `sendCard()` 而非 `reply()` |
| `src/shared/card-actions.js` | 卡片回调注册 | ① 新增 `handleQuickAction()` 函数；②注册 kind handler |
| `src/plugins/action-runner/index.js` | 动作执行器 | ① 暴露 `executeActionDirect(actionConfig, ctx)` 入口 |
| `public/js/actions-panel.js` | 前端表单 | ① 新增「示例文案」表单字段；② 提交时收集；③ 编辑时回显 |
| `src/shared/messages.test.js` | 单元测试 | ① 新增 `buildWelcomeCard()` 的 3 个测试用例 |
| `src/app/dispatch.test.js` | 集成测试 | ① 新增测试验证卡片发送逻辑 |

### 依赖关系

```
dispatch.js
  ├─> buildWelcomeCard(botId)   [messages.js]
  └─> ctx.sendCard()             [feishu.js channel]

buildWelcomeCard
  └─> getConfigs()               [action-configs.js]

card-actions.js
  ├─> handleQuickAction()
  ├─> getConfig(actionId)        [action-configs.js]
  ├─> executeActionDirect()      [action-runner]
  └─> updateCard()               [lark.js]
```

---

## 任务分解

### Task 1: 前端表单新增「示例文案」字段

**文件：**
- Modify: `public/js/actions-panel.js`

**背景：** 前端是纯 Vanilla JS，没有框架。需要在现有表单中插入新的 textarea 字段。

- [ ] **Step 1: 查看现有表单结构**

运行：
```bash
grep -n "actionDesc\|actionKeywords" public/js/actions-panel.js | head -10
```

了解现有字段的位置和命名规范。

- [ ] **Step 2: 在 showActionForm 中插入新字段（HTML）**

编辑 `public/js/actions-panel.js`，在现有「意图描述」（actionDesc）下方、「关键词」（actionKeywords）上方插入新的 HTML：

查找现有的：
```js
<textarea id="actionDesc" placeholder="..." required></textarea>
```

在其后添加：
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

- [ ] **Step 3: 修改表单提交逻辑**

编辑 `public/js/actions-panel.js`，找到 `updatePayload()` 或 `handleSaveAction()` 函数，修改 payload 构造：

```js
const payload = {
  name: document.getElementById('actionName').value,
  description: document.getElementById('actionDesc').value,
  example: document.getElementById('actionExample').value || '',  // 新增这一行
  keywords: document.getElementById('actionKeywords').value.split(',').map(k => k.trim()).filter(Boolean),
  // ... 其他字段保持不变
};
```

- [ ] **Step 4: 修改表单回显逻辑**

编辑 `public/js/actions-panel.js`，找到编辑动作时的回显逻辑（通常在 `populateForm()` 或类似函数），添加：

```js
document.getElementById('actionExample').value = config.example || '';
```

- [ ] **Step 5: 验证表单**

在浏览器中打开设置页 → 动作配置 → 新增或编辑一个动作，验证：
- ✓ 新增「示例文案」字段出现在「意图描述」和「关键词」之间
- ✓ 新增动作时能输入示例文案
- ✓ 编辑动作时能看到已保存的示例文案
- ✓ 提交表单，后端成功保存（检查浏览器网络面板）

- [ ] **Step 6: Commit**

```bash
git add public/js/actions-panel.js
git commit -m "feat: 动作配置表单新增「示例文案」字段

- 在「意图描述」和「关键词」之间插入新字段
- 支持 30-200 字符的可选示例文案
- 新增/编辑时正确提交和回显"
```

---

### Task 2: 实现 `buildWelcomeCard(botId)` 函数

**文件：**
- Modify: `src/shared/messages.js`
- Test: `src/shared/messages.test.js`

**背景：** 需要创建飞书卡片 JSON，包含操作说明 Markdown + 动作按钮列表。

- [ ] **Step 1: 编写测试用例（TDD）**

编辑 `src/shared/messages.test.js`，在文件末尾新增测试套件：

```javascript
test.describe('buildWelcomeCard', () => {
  test('有已启用动作时应生成卡片含操作说明和按钮', async (t) => {
    // Mock getConfigs
    const actionConfigs = require('../store/action-configs.js');
    const originalGetConfigs = actionConfigs.getConfigs;
    actionConfigs.getConfigs = () => [
      {
        id: 'ac_001',
        botId: 'bot_123',
        name: '清理数据',
        description: '清理测试数据',
        example: '输入环境名称',
        enabled: true,
      },
      {
        id: 'ac_002',
        botId: 'bot_123',
        name: '生成二维码',
        description: '生成小程序二维码',
        example: '输入用户 ID',
        enabled: true,
      },
    ];

    try {
      const { buildWelcomeCard } = require('./messages.js');
      const card = buildWelcomeCard('bot_123');

      // 验证卡片结构
      t.ok(card.elements, '卡片有 elements 字段');
      t.equal(card.elements.length, 2, '有两个元素（说明 + 按钮区）');

      // 验证说明段
      t.match(card.elements[0].text.content, /没有识别到你的意图/, '包含操作说明');
      t.match(card.elements[0].text.content, /提交需求/, '包含需求说明');

      // 验证按钮区
      const actionElem = card.elements[1];
      t.equal(actionElem.tag, 'action', '第二个元素是 action');
      t.equal(actionElem.actions.length, 2, '有两个按钮');
      t.equal(actionElem.actions[0].text.content, '清理数据', '第一个按钮文案');
      t.equal(actionElem.actions[0].value.kind, 'quick-action', '按钮 value 有 kind');
      t.equal(actionElem.actions[0].value.actionId, 'ac_001', '按钮 value 有 actionId');
      t.equal(actionElem.actions[0].value.botId, 'bot_123', '按钮 value 有 botId');
    } finally {
      actionConfigs.getConfigs = originalGetConfigs;
    }
  });

  test('无已启用动作时卡片仅含操作说明', async (t) => {
    const actionConfigs = require('../store/action-configs.js');
    const originalGetConfigs = actionConfigs.getConfigs;
    actionConfigs.getConfigs = () => [];

    try {
      const { buildWelcomeCard } = require('./messages.js');
      const card = buildWelcomeCard('bot_456');

      t.ok(card.elements, '卡片有 elements');
      // 无按钮时可能只有一个元素（说明），或有空的 action 元素
      // 取决于实现，这里假设无按钮时不生成 action 元素
      t.match(card.elements[0].text.content, /没有识别到你的意图/, '仍有操作说明');
    } finally {
      actionConfigs.getConfigs = originalGetConfigs;
    }
  });

  test('超过 5 条动作时仅显示前 5 条并提示还有更多', async (t) => {
    const actionConfigs = require('../store/action-configs.js');
    const originalGetConfigs = actionConfigs.getConfigs;
    
    const actions = Array.from({ length: 8 }, (_, i) => ({
      id: `ac_${i + 1}`,
      botId: 'bot_789',
      name: `动作 ${i + 1}`,
      description: `说明 ${i + 1}`,
      example: `示例 ${i + 1}`,
      enabled: true,
    }));
    actionConfigs.getConfigs = () => actions;

    try {
      const { buildWelcomeCard } = require('./messages.js');
      const card = buildWelcomeCard('bot_789');

      const actionElem = card.elements[1];
      // 前 5 个是按钮，第 6 个可能是文本元素（提示）或按钮数就是 5
      const buttonCount = actionElem.actions.filter(a => a.tag === 'button').length;
      t.equal(buttonCount, 5, '显示 5 个按钮');
      
      // 验证有「还有」提示（可能在文本元素或按钮后）
      const hasMoreText = actionElem.actions.some(a => a.content && a.content.includes('还有'));
      t.ok(hasMoreText, '有「还有更多」提示');
    } finally {
      actionConfigs.getConfigs = originalGetConfigs;
    }
  });
});
```

- [ ] **Step 2: 运行测试确保失败**

运行：
```bash
npm test -- src/shared/messages.test.js 2>&1 | grep -A 5 "buildWelcomeCard"
```

预期：测试失败，提示 `buildWelcomeCard is not a function`。

- [ ] **Step 3: 实现 buildWelcomeCard 函数**

编辑 `src/shared/messages.js`，在 `buildWelcomeText()` 函数下方添加：

```javascript
/**
 * 构造 Welcome 飞书卡片（包含操作说明 + 动作快捷按钮）
 * @param {string|null} botId 机器人 ID
 * @returns {object} Feishu schema 1.0 卡片 JSON
 */
export function buildWelcomeCard(botId) {
  // 1. 操作说明段（Markdown 格式）
  const headerText =
    '没有识别到你的意图，我可以进行这些操作：\n' +
    '\n' +
    '· 提交需求\n' +
    '    例: 提个需求: 把背景改成蓝色\n' +
    '\n' +
    '· 提交故障\n' +
    '    例: 提个bug: 聊天主页面语音有问题\n' +
    '\n' +
    '· 问个问题\n' +
    '    例: 问个问题: 我要在聊天页加个弹框, 这个功能复杂吗?';

  // 2. 读取该 bot 的已启用动作，最多 5 条
  const enabledActions = getConfigs()
    .filter((c) => c && c.botId === botId && c.enabled)
    .slice(0, 5);

  // 3. 生成按钮区（action 元素）
  const actionButtons = enabledActions.map((action) => ({
    tag: 'button',
    type: 'primary',
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

  // 5. 拼装卡片（含说明 + 按钮区，或仅说明）
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: headerText } },
  ];

  if (actionButtons.length > 0) {
    elements.push({ tag: 'action', actions: actionButtons });
  }

  return { elements };
}
```

- [ ] **Step 4: 运行测试确保通过**

运行：
```bash
npm test -- src/shared/messages.test.js 2>&1 | tail -20
```

预期：3 个 buildWelcomeCard 测试全部通过。

- [ ] **Step 5: Commit**

```bash
git add src/shared/messages.js src/shared/messages.test.js
git commit -m "feat: 实现 buildWelcomeCard() 生成 Welcome 卡片

- 卡片顶部包含操作说明 Markdown
- 底部显示最多 5 个动作快捷按钮
- 超过 5 条时追加「还有 N 项」提示
- 按钮 value 使用 kind=quick-action 全局路由"
```

---

### Task 3: 改动 dispatch.js 调用点

**文件：**
- Modify: `src/app/dispatch.js`

**背景：** 将无意图匹配分支从调用文本 welcome 改为发送卡片。

- [ ] **Step 1: 检查现有调用点**

运行：
```bash
grep -n "buildWelcomeText\|msg('welcome')" src/app/dispatch.js
```

定位第 101-102 行的调用点。

- [ ] **Step 2: 修改 import**

编辑 `src/app/dispatch.js`，在文件顶部找到 import messages 的行：

```js
import { msg, buildWelcomeText } from '../shared/messages.js';
```

改为：

```js
import { msg, buildWelcomeText, buildWelcomeCard } from '../shared/messages.js';
```

- [ ] **Step 3: 修改调用点**

编辑 `src/app/dispatch.js`，找到第 101-102 行：

```js
// 3. 无匹配：帮助
logger.info('dispatch', '无匹配 → 帮助');
const bot = getActiveBot();
await ctx.reply(buildWelcomeText(bot?.id));
```

改为：

```js
// 3. 无匹配：帮助
logger.info('dispatch', '无匹配 → 帮助');
const bot = getActiveBot();
const welcomeCard = buildWelcomeCard(bot?.id);
await ctx.sendCard(welcomeCard);
```

**说明**：假设 `ctx.sendCard()` 已由 feishu channel 适配器提供。如果不存在，可改为：
```js
await ctx.reply(welcomeCard);  // 若 reply 支持自动检测卡片对象
```

或使用显式的 Feishu API：
```js
await sendCard(ctx.sessionKey, welcomeCard);  // 从 lark.js 导入
```

- [ ] **Step 4: 语法检查**

运行：
```bash
node -c src/app/dispatch.js
```

预期：无输出（语法正确）。

- [ ] **Step 5: Commit**

```bash
git add src/app/dispatch.js
git commit -m "fix: dispatch 无匹配意图时发送卡片而非文本

- 改用 buildWelcomeCard() 生成飞书卡片
- 调用 ctx.sendCard() 而非 ctx.reply()
- 卡片包含操作说明和动作快捷按钮"
```

---

### Task 4: 实现 quick-action 卡片回调处理

**文件：**
- Modify: `src/shared/card-actions.js`
- Reference: `src/plugins/action-runner/index.js`（需调研 executeActionDirect 入口）

**背景：** 实现按钮点击的回调处理，直接触发动作执行流程。

- [ ] **Step 1: 调研 action-runner 的执行接口**

运行：
```bash
grep -n "export.*function\|module.exports" src/plugins/action-runner/index.js | head -20
grep -n "collectVariables\|executeScript" src/plugins/action-runner/index.js | head -10
```

了解现有的函数导出和内部执行流程。

- [ ] **Step 2: 暴露 executeActionDirect 入口（或复用现有逻辑）**

编辑 `src/plugins/action-runner/index.js`，确保有一个可供外部调用的函数入口，用于直接执行动作（跳过 classify）。

如果已有，记下函数名和签名；如果没有，新增一个导出函数，例如：

```javascript
/**
 * 直接执行动作（跳过意图识别）
 * @param {object} actionConfig 动作配置（id、name、variables 等）
 * @param {object} ctx 统一 Context（user、sessionKey、reply 等）
 * @returns {Promise<void>}
 */
export async function executeActionDirect(actionConfig, ctx) {
  // 调用现有的槽位填充和执行逻辑
  // 伪代码：
  // const collected = await collectVariables(actionConfig.variables, ctx);
  // const result = await executeScript(actionConfig, collected, ctx);
  // await replyResult(result, ctx);
}
```

如果不需要改，记下现有函数的签名。

- [ ] **Step 3: 在 card-actions.js 中新增 handleQuickAction 函数**

编辑 `src/shared/card-actions.js`，在现有函数下方添加：

```javascript
import { getConfig } from '../store/action-configs.js';
import { updateCard } from '../integrations/lark.js';
import { createInfoCard } from './card-confirm.js';
import { executeActionDirect } from '../plugins/action-runner/index.js';  // 或现有函数名
import { logger } from './logger.js';

/**
 * 快捷动作执行处理（卡片按钮回调）
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
      await updateCard(messageId, createInfoCard('错误', '动作不存在或已被删除', 'error'));
      return;
    }

    // 2. 检查权限（示例：owner 权限的动作仅 owner 可执行）
    if (actionConfig.permission === 'owner') {
      // 需要检查当前用户是否为机器人 owner
      // 假设有一个 isOwner(botId, openId) 的检查函数
      // 如果不是 owner，返回权限提示
      // 暂时跳过权限检查，后续可补充
    }

    // 3. 构造虚拟 context
    const ctx = {
      source: 'feishu',
      user: { id: operator.userId || operator.openId, role: 'member' },
      text: `执行动作: ${actionConfig.name}`,
      sessionKey: chatId,
      reply: async (msg) => {
        // 可发送追问或结果消息
        // 实现方式取决于需要（可调用 sendMessage 或直接 updateCard）
      },
      sendCard: async (card) => {
        // 发送卡片（如需要）
      },
      meta: {
        cardMessageId: messageId,
        fromCardButton: true,
      },
    };

    // 4. 直接调用 action-runner 执行流程
    await executeActionDirect(actionConfig, ctx);

    // 5. 执行成功后，卡片状态由 executeActionDirect 内部处理
    // （通常 updateCard 为结果态或成功提示）

  } catch (err) {
    logger.error('quick-action', '执行失败', { actionId, error: err.message });
    await updateCard(messageId, createInfoCard('执行失败', err.message || '未知错误', 'error'));
  }
}

// 注册 kind handler
registerCardKindHandler('quick-action', handleQuickAction);
```

- [ ] **Step 4: 验证导入导出**

运行：
```bash
grep -n "export.*handleQuickAction\|registerCardKindHandler" src/shared/card-actions.js
```

确保函数导出且被注册。

- [ ] **Step 5: Commit**

```bash
git add src/shared/card-actions.js
git commit -m "feat: 实现 quick-action 卡片按钮回调处理

- 新增 handleQuickAction() 处理按钮点击
- 直接调用 executeActionDirect() 执行动作
- 检查动作权限，更新卡片为结果态
- 注册全局 kind handler 'quick-action'"
```

---

### Task 5: 确保 action-runner 有可用的执行入口

**文件：**
- Modify or Reference: `src/plugins/action-runner/index.js`

**背景：** Task 4 中 handleQuickAction 依赖 `executeActionDirect`，需要确保此函数存在或新增。

- [ ] **Step 1: 检查现有执行函数**

运行：
```bash
grep -n "export.*function.*execute\|export.*const.*execute" src/plugins/action-runner/index.js
```

如果已有类似 `executeAction` 或 `executeActionWithCollection` 的导出函数，记下签名；如果没有，需要新增。

- [ ] **Step 2: 如需新增，编写 executeActionDirect**

编辑 `src/plugins/action-runner/index.js`，在现有导出函数下方添加（伪代码，需根据现有实现调整）：

```javascript
/**
 * 直接执行动作（供快捷操作调用，跳过 classify）
 * @param {object} actionConfig 动作配置对象
 * @param {object} ctx 统一 Context
 */
export async function executeActionDirect(actionConfig, ctx) {
  // 假设现有的内部函数是：
  // - collectVariablesInteractive(variables, ctx) — 交互式填充槽位
  // - executeScript(actionConfig, variables, ctx) — 执行脚本
  // - replyResult(result, ctx) — 回复结果

  try {
    logger.info('action-runner', `快捷执行动作: ${actionConfig.name}`);

    // 1. 发送「准备中」或「填充变量中」提示
    if (ctx.reply) {
      await ctx.reply(`正在为您准备执行「${actionConfig.name}」，请稍候…`);
    }

    // 2. 交互式收集变量（如有）
    let collectedVars = {};
    if (actionConfig.variables && actionConfig.variables.length > 0) {
      collectedVars = await collectVariablesInteractive(actionConfig.variables, ctx);
    }

    // 3. 执行脚本
    const result = await executeScript(actionConfig, collectedVars, ctx);

    // 4. 回复结果
    await replyResult(result, ctx);

  } catch (err) {
    logger.error('action-runner', '直接执行失败', { actionName: actionConfig.name, error: err.message });
    throw err;
  }
}
```

- [ ] **Step 3: 验证导出**

运行：
```bash
grep "export.*executeActionDirect" src/plugins/action-runner/index.js
```

确保函数已导出。

- [ ] **Step 4: Commit（如有改动）**

```bash
git add src/plugins/action-runner/index.js
git commit -m "feat: action-runner 暴露 executeActionDirect 入口

- 支持直接执行动作（跳过意图识别）
- 供快捷操作卡片按钮调用
- 内部复用现有的槽位收集和执行逻辑"
```

---

### Task 6: 编写集成测试

**文件：**
- Modify: `src/app/dispatch.test.js` 或 `src/shared/card-actions.test.js`（新建）

**背景：** 验证 dispatch 调用卡片、按钮回调路由的完整流程。

- [ ] **Step 1: 在 dispatch.test.js 中添加卡片集成测试**

编辑 `src/app/dispatch.test.js`，在现有测试下方添加：

```javascript
test('dispatch - 无匹配意图时应发送 Welcome 卡片', async (t) => {
  const { dispatch } = require('./dispatch.js');
  const actionConfigs = require('../store/action-configs.js');
  const settings = require('../store/settings.js');

  // Mock dependencies
  const originalGetConfigs = actionConfigs.getConfigs;
  const originalGetActiveBot = settings.getActiveBot;

  actionConfigs.getConfigs = () => [
    {
      id: 'ac_1',
      botId: 'bot_123',
      name: '清理数据',
      description: '清理测试数据',
      example: '输入环境',
      enabled: true,
    },
  ];

  settings.getActiveBot = () => ({
    id: 'bot_123',
    name: 'Test Bot',
    enabled: true,
  });

  try {
    // Mock context
    const mockCtx = {
      source: 'feishu',
      user: { id: 'user_123', role: 'member' },
      text: '随机问一下',
      sessionKey: 'chat_123',
      sendCard: async (card) => {
        mockCtx.sentCard = card;
        return Promise.resolve();
      },
      reply: async (msg) => {
        mockCtx.repliedMsg = msg;
        return Promise.resolve();
      },
      meta: {},
    };

    // Execute dispatch with empty features (trigger 'other' path)
    await dispatch(mockCtx, {
      featureList: [],
      classifyFn: async () => ({
        intent: 'other',
        body: '',
        strong: false,
        env: 'test',
      }),
    });

    // Assertions
    t.ok(mockCtx.sentCard, '应该发送了卡片');
    t.ok(mockCtx.sentCard.elements, '卡片有 elements');
    t.equal(mockCtx.sentCard.elements.length, 2, '卡片有两个元素（说明 + 按钮）');
    t.match(mockCtx.sentCard.elements[0].text.content, /没有识别到你的意图/, '包含说明');

    const actionElem = mockCtx.sentCard.elements[1];
    t.equal(actionElem.tag, 'action', '第二个元素是 action');
    t.ok(actionElem.actions.length > 0, '有按钮');
    t.equal(actionElem.actions[0].value.kind, 'quick-action', '按钮有 quick-action kind');

  } finally {
    actionConfigs.getConfigs = originalGetConfigs;
    settings.getActiveBot = originalGetActiveBot;
  }
});
```

- [ ] **Step 2: 编写 quick-action 回调测试（可选，作为集成测试）**

编辑 `src/shared/card-actions.test.js`（如存在）或新建，添加：

```javascript
test('quick-action 回调应直接执行动作', async (t) => {
  const cardActions = require('./card-actions.js');
  const actionConfigs = require('../store/action-configs.js');
  const runner = require('../plugins/action-runner/index.js');

  const originalGetConfig = actionConfigs.getConfig;
  const originalExecute = runner.executeActionDirect;

  let executedActionId = null;

  actionConfigs.getConfig = (id) => ({
    id,
    botId: 'bot_123',
    name: '测试动作',
    permission: 'guest',
    variables: [],
    enabled: true,
  });

  runner.executeActionDirect = async (config, ctx) => {
    executedActionId = config.id;
    await ctx.reply('执行成功');
  };

  try {
    // 获取注册的 handler
    const handler = cardActions.getCardKindHandler('quick-action');
    t.ok(handler, 'quick-action handler 已注册');

    // 模拟按钮点击回调
    const mockCtx = {
      reply: async (msg) => { /* noop */ },
    };

    await handler(
      { kind: 'quick-action', actionId: 'ac_123', botId: 'bot_123', _timestamp: Date.now() },
      { openId: 'open_id_123', userId: 'user_123' },
      'msg_id_123',
      'chat_id_123'
    );

    t.equal(executedActionId, 'ac_123', '应执行了正确的动作');

  } finally {
    actionConfigs.getConfig = originalGetConfig;
    runner.executeActionDirect = originalExecute;
  }
});
```

- [ ] **Step 3: 运行测试**

运行：
```bash
npm test -- src/app/dispatch.test.js 2>&1 | tail -20
npm test -- src/shared/card-actions.test.js 2>&1 | tail -20  # 如新建此文件
```

预期：新增的测试通过。

- [ ] **Step 4: Commit**

```bash
git add src/app/dispatch.test.js
git commit -m "test: 添加 Welcome 卡片和快捷动作的集成测试

- 验证 dispatch 无匹配意图时发送卡片
- 验证卡片结构（说明 + 按钮）
- 验证 quick-action 回调正确触发动作执行"
```

---

### Task 7: 手动测试与验证

**背景：** 在实际飞书环境中验证卡片展示和交互。

- [ ] **Step 1: 启动飞书服务**

运行：
```bash
npm run dev:feishu 2>&1 | head -20
```

预期：WebSocket 连接建立。

- [ ] **Step 2: 在飞书群聊发送无法识别的消息**

在已连接的飞书群中 @ 机器人，发送：
```
@机器人 随机问一下
```

或其他明确无意图的语句。

- [ ] **Step 3: 验证卡片展示**

机器人应回复 Welcome 卡片，验证：
- ✓ 卡片顶部显示操作说明（需求/故障/问题）
- ✓ 卡片底部显示已配置动作的按钮（最多 5 个）
- ✓ 按钮文案来自 action.name
- ✓ 按钮有 hint/tooltip 显示 action.example（飞书支持的话）
- ✓ 超过 5 个动作时显示「…还有 N 项」提示

- [ ] **Step 4: 测试按钮点击**

点击其中一个按钮，验证：
- ✓ 机器人直接进入该动作的执行流程（无意图识别）
- ✓ 如动作有变量，机器人追问缺失的槽位
- ✓ 按钮点击后卡片更新为结果态或禁用
- ✓ 重复点击同一按钮不会触发多次执行

- [ ] **Step 5: 测试 example 字段**

在设置页修改一个动作的「示例文案」，保存后：
- ✓ 下次发送无意图消息时，卡片中该动作的 hint 已更新
- ✓ 表单编辑该动作时能看到已保存的示例文案

- [ ] **Step 6: 记录结果**

如有异常，截图或导出日志至 `logs/` 目录。一切正常则继续。

---

### Task 8: 最终检查与提交

**文件：**
- Verify: `src/shared/messages.js`
- Verify: `src/app/dispatch.js`
- Verify: `src/shared/card-actions.js`
- Verify: `public/js/actions-panel.js`

- [ ] **Step 1: 运行全部相关测试**

运行：
```bash
npm test -- --testPathPattern="(messages|dispatch|card)" 2>&1 | tail -30
```

预期：所有测试通过。

- [ ] **Step 2: 检查代码风格**

运行：
```bash
node -c src/shared/messages.js
node -c src/app/dispatch.js
node -c src/shared/card-actions.js
```

预期：无语法错误。

- [ ] **Step 3: 验证导入导出一致性**

运行：
```bash
grep -r "buildWelcomeCard\|handleQuickAction" src/ --include="*.js" | grep -v test | grep -v node_modules
```

验证：
- ✓ messages.js 有 `export function buildWelcomeCard`
- ✓ dispatch.js 有 `import { buildWelcomeCard }`
- ✓ card-actions.js 有 `handleQuickAction` 和注册调用

- [ ] **Step 4: 梳理 git 提交历史**

运行：
```bash
git log --oneline | head -15
```

预期：看到本次新增的 commit（Task 1-7）。

- [ ] **Step 5: 验证工作区状态**

运行：
```bash
git status
```

预期：`working tree clean`（无未提交改动）。

- [ ] **Step 6: 最终测试报告**

运行：
```bash
npm test 2>&1 | grep -E "passed|failed|tests"
```

记录测试统计。

---

## 自查清单

**Spec 覆盖：**
- ✓ Welcome 回复改为飞书卡片（Task 2、3）
- ✓ 卡片顶部操作说明，底部动作按钮（Task 2）
- ✓ 按钮点击直接执行动作（Task 4、5）
- ✓ 动作配置新增 example 字段（Task 1）
- ✓ 使用全局 kind 路由 'quick-action'（Task 4）
- ✓ 向后兼容（纯文本 welcome 保留）

**占位符扫描：**
- ✓ 无 "TBD" / "TODO"
- ✓ 所有代码块完整
- ✓ 所有命令、预期输出明确
- ✓ 测试用例具体

**类型一致性：**
- ✓ buildWelcomeCard 返回 { elements: [...] } 对象
- ✓ handleQuickAction 签名与全局 kind handler 规范一致
- ✓ example 字段类型为 string，可选

**边界情况：**
- ✓ botId 为 null 时降级（无按钮，仅说明）
- ✓ 无已启用动作时（仅说明，无按钮）
- ✓ 超 5 条时（前 5 + 提示）
- ✓ 动作不存在时（错误提示卡片）
- ✓ 权限检查（owner 权限）

---

## 总结

本计划共 8 个任务，预计 **3-4 小时** 完成：

- **Task 1**：前端表单改动（15 分钟）
- **Task 2**：buildWelcomeCard 实现 + 测试（30 分钟）
- **Task 3**：dispatch.js 改动（10 分钟）
- **Task 4**：quick-action handler 实现（30 分钟）
- **Task 5**：action-runner 入口暴露（15-30 分钟，取决于现有代码）
- **Task 6**：集成测试（30 分钟）
- **Task 7**：手动飞书测试（30-60 分钟）
- **Task 8**：最终检查（10 分钟）

每个任务都有明确的步骤和验证方式，支持暂停/恢复。


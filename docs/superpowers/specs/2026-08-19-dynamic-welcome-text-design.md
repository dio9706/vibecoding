# 动态 Welcome 文案生成 — 设计文档

**日期**：2026-08-19  
**背景**：当机器人未识别用户意图时，展示「没有识别到你的意图」兜底提示。当前文案中「或其他已配置的功能，比如」段落是**硬编码示例**（小程序二维码、清环保境、退款），与实际配置的动作（actions）脱节。  
**目标**：文案动态从当前机器人的已启用动作（`action-configs.json`）中读取，提示用户该机器人真实可用的功能；若无动作则提示「暂未配置」。

---

## 现状

### 硬编码文案位置

**文件**：`src/shared/messages.js`（行 15-36）

```js
welcome: {
  label: '未识别意图兜底提示',
  defaultText:
    '没有识别到你的意图，我可以进行这些操作：\n' +
    '· 提交需求\n' +
    '    例: 提个需求: 把背景改成蓝色\n' +
    '· 提交故障\n' +
    '    例: 提个bug: 聊天主页面语音有问题\n' +
    '· 问个问题\n' +
    '    例: 问个问题: 我要在聊天页加个弹框, 这个功能复杂吗?\n' +
    '\n' +
    '或其他已配置的功能，比如\n' +
    '    1. 给我小程序的二维码\n' +
    '    2. 帮我清一下环境数据\n' +
    '    3. 帮我退下款\n' +
    '\n' +
    '识别到我会及时回复你～',
}
```

### 消息回复调用点

**文件**：`src/app/dispatch.js`（行 100）

```js
// 3. 无匹配：帮助
logger.info('dispatch', '无匹配 → 帮助');
await ctx.reply(msg('welcome'));
```

### 动作配置存储

**文件**：`src/store/action-configs.js`

- `getConfigs()` 返回全部配置 `[{ id, botId, name, description, keywords, enabled, ... }]`
- 每条动作含 `botId`（所属机器人）、`enabled`（是否启用）、`name`（短名）、`description`（较长说明）

### 机器人管理

**文件**：`src/store/settings.js`

- `getActiveBot()` 返回当前启用的机器人对象（含 `id`）
- 每个机器人独享一套动作配置（`botId` 关联）

---

## 设计

### 核心逻辑：`buildWelcomeText(botId)`

新增函数在 `src/shared/messages.js`，接收机器人 ID，返回完整文案字符串：

```js
/**
 * 动态构造"未识别意图"兜底文案
 * @param {string|null} botId 机器人 ID；为空/未知 bot 时返回基础文案
 * @returns {string} 完整文案（包含动态获取的动作列表）
 */
export function buildWelcomeText(botId) {
  // 1. 静态核心段
  const core = 
    '没有识别到你的意图，我可以进行这些操作：\n' +
    '· 提交需求\n' +
    '    例: 提个需求: 把背景改成蓝色\n' +
    '· 提交故障\n' +
    '    例: 提个bug: 聊天主页面语音有问题\n' +
    '· 问个问题\n' +
    '    例: 问个问题: 我要在聊天页加个弹框, 这个功能复杂吗?\n'
  
  // 2. 读取该 bot 的已启用动作
  const actions = getConfigs()
    .filter(c => c.botId === botId && c.enabled)
    .slice(0, 5)  // 最多 5 条
  
  // 3. 拼装动作段（或提示段）
  let actionSection = ''
  if (actions.length > 0) {
    actionSection = '\n或其他已配置的功能，比如\n'
    actions.forEach((action, i) => {
      // 优先用 description，否则降级用 name
      const label = action.description?.trim() || action.name
      actionSection += `    ${i + 1}. ${label}\n`
    })
    
    // 超出 5 条时追加「…等」提示
    const total = getConfigs().filter(c => c.botId === botId && c.enabled).length
    if (total > 5) {
      actionSection += `    …等 ${total - 5} 项\n`
    }
  } else {
    // 无已启用动作：显示提示语
    actionSection = '\n或其他已配置的功能（暂未配置）\n'
  }
  
  // 4. 拼装完整文案
  return core + actionSection + '\n识别到我会及时回复你～'
}
```

### 调用点修改

**文件**：`src/app/dispatch.js`（行 100）

```js
// 修改前
await ctx.reply(msg('welcome'));

// 修改后
import { buildWelcomeText } from '../shared/messages.js';
// ...
const bot = getActiveBot();
await ctx.reply(buildWelcomeText(bot?.id));
```

### 显示效果

#### 场景 1：有已启用动作

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
    3. 执行退款流程并通知相关人员
    4. 查询用户订单历史和支付记录
    5. …等 3 项

识别到我会及时回复你～
```

#### 场景 2：无已启用动作

```
没有识别到你的意图，我可以进行这些操作：
· 提交需求
    例: 提个需求: 把背景改成蓝色
· 提交故障
    例: 提个bug: 聊天主页面语音有问题
· 问个问题
    例: 问个问题: 我要在聊天页加个弹框, 这个功能复杂吗?

或其他已配置的功能（暂未配置）

识别到我会及时回复你～
```

---

## 实现细节

### 导入依赖

在 `dispatch.js` 的 imports 中加：

```js
import { buildWelcomeText } from '../shared/messages.js';
import { getActiveBot } from '../store/settings.js';
```

`buildWelcomeText` 内部已依赖 `action-configs.js` 的 `getConfigs()`，在 `messages.js` 导入即可。

### 边界情况

1. **`botId` 为 null/undefined**  
   → `filter(c => c.botId === null)` 匹配不到任何动作，走场景 2（提示暂未配置）  
   → 降级安全，用户仍能看到三条核心操作提示

2. **某个动作的 `description` 为空或纯空白**  
   → 降级用 `name` 字段代替（`action.description?.trim() || action.name`）

3. **动作总数超过 5 条**  
   → 显示前 5 条，末尾加「…等 N 项」  
   → 避免消息过长

4. **动作被删除或禁用后**  
   → `enabled` 字段变化 → 下一条消息即生效（无缓存）  
   → 因为 `buildWelcomeText` 每次调用都读盘

### 文案格式一致性

- 用**空格**缩进（不用 Tab），与现有注释规范保持一致（见 `messages.js` 行 20 的注释）
- 行尾不带多余空格
- 每项动作独占一行

---

## 测试方案

### 单元测试

**文件**：`src/shared/messages.test.js`（新增或扩展）

```js
describe('buildWelcomeText', () => {
  it('应包含三条核心操作提示', () => {
    const text = buildWelcomeText('bot_123')
    assert(text.includes('提交需求'))
    assert(text.includes('提交故障'))
    assert(text.includes('问个问题'))
  })

  it('有动作时应列出已启用的动作', () => {
    // mock getConfigs 返回 [{botId: 'bot_123', enabled: true, name: '...', description: '...'}]
    const text = buildWelcomeText('bot_123')
    assert(text.includes('或其他已配置的功能，比如'))
    assert(text.includes('生成并发送小程序二维码')) // 实际 mock 的动作描述
  })

  it('无动作时应显示「暂未配置」提示', () => {
    // mock getConfigs 返回空数组
    const text = buildWelcomeText('bot_456')
    assert(text.includes('或其他已配置的功能（暂未配置）'))
  })

  it('超过 5 条动作时应显示「…等 N 项」', () => {
    // mock getConfigs 返回 8 条 enabled=true 的动作
    const text = buildWelcomeText('bot_789')
    assert(text.includes('…等 3 项'))
  })

  it('botId 为 null 时应降级到暂未配置', () => {
    const text = buildWelcomeText(null)
    assert(text.includes('或其他已配置的功能（暂未配置）'))
  })
})
```

### 集成测试

在 `dispatch.test.js` 中验证：

- 意图为 `other` 时，`dispatch` 调用 `ctx.reply`，参数包含动态生成的动作列表
- 不同 `botId` 回复不同的动作列表

### 手动测试

1. 在飞书机器人管理后台配置 2-3 个动作，标记部分为已启用、部分为禁用
2. 在群聊中发送无法识别的消息（如"随机问一下")
3. 验证 welcome 消息中：
   - 仅列出 `enabled=true` 的动作
   - 用 `description` 展示（若非空）
   - 若无动作则显示「暂未配置」

---

## 风险与缓解

| 风险 | 缓解方案 |
|---|---|
| `botId` 为 null 导致动作列表异常 | 边界 case 已处理；降级显示「暂未配置」提示 |
| 性能：每次无意图消息都读 `action-configs.json` | 读盘无缓存，但 dispatch 本身就是同步操作，额外开销可忽略 |
| 消息太长（尤其是动作 description 很长）时 | 限制最多 5 条；若 description 超长可在 UI 编辑时验证 |
| 飞书消息字符数限制 | 三条核心操作 + 最多 5 条动作 + 提示语，总长度在 1000 字以内，远低于飞书限制 |

---

## 后续迭代

1. **动作按优先级排序**  
   → 在 `action-configs` 中新增 `priority` 字段，`buildWelcomeText` 按优先级展示
2. **可配置显示上限**  
   → 在 bot 配置中新增 `maxWelcomeActions` 字段，替代硬编码的 5
3. **Welcome 文案本身也可 per-bot 配置**  
   → 当前 `welcome` 不在 `BOT_MESSAGE_KEYS`，可考虑加入

---

## 审批清单

- [ ] 核心逻辑 `buildWelcomeText(botId)` 实现无误
- [ ] `dispatch.js` 调用点正确修改
- [ ] 单元测试覆盖 4 个场景（有动作、无动作、超过 5 条、botId 为 null）
- [ ] 集成测试验证 dispatch 路由正确
- [ ] 手动测试验证飞书消息格式正确
- [ ] 边界 case 都有处理，无硬崩


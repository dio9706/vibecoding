# 动态 Welcome 文案实现计划

> **对于 agentic workers**：REQUIRED SUB-SKILL：推荐使用 superpowers:subagent-driven-development（或 superpowers:executing-plans）来逐任务实现此计划。所有步骤使用复选框（`- [ ]`）追踪进度。

**目标：** 将机器人未识别意图时的兜底提示文案从硬编码示例改为动态从已配置的动作（actions）列表生成，提示用户该机器人真实可用的功能。

**架构：** 在 `messages.js` 新增 `buildWelcomeText(botId)` 函数，读取当前机器人的已启用动作配置，动态拼装完整文案；同时修改 `dispatch.js` 中无意图匹配时的调用，从静态 `msg('welcome')` 改为调用此动态函数。

**技术栈：** Node.js / JavaScript ES6+，无额外依赖；复用已有的 `action-configs.js` 和 `settings.js`。

---

## 文件结构

### 修改文件

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/shared/messages.js` | 机器人文案注册与构造 | ① 新增 `buildWelcomeText(botId)` 函数 |
| `src/app/dispatch.js` | 消息路由与分发 | ① 修改 `msg('welcome')` 调用为 `buildWelcomeText()` |
| `src/shared/messages.test.js` | 单元测试 | ① 新增 4 个测试用例验证动态文案生成 |
| `src/app/dispatch.test.js` | 集成测试 | ① 新增/修改测试验证 dispatch 与动态文案集成 |

### 依赖关系

```
dispatch.js
  └─> messages.js (buildWelcomeText)
      └─> action-configs.js (getConfigs)
          └─> store/index.js (readJson)
      └─> settings.js (getActiveBot) [仅 dispatch.js 用]
```

---

## 任务分解

### Task 1: 编写 `buildWelcomeText()` 单元测试框架

**文件：**
- Modify: `src/shared/messages.test.js`
- Reference: `src/shared/messages.js` (REGISTRY 结构)
- Reference: `src/store/action-configs.js` (getConfigs 签名)

**背景：** 使用 TDD 先写测试，明确 `buildWelcomeText()` 的行为约束。

- [ ] **Step 1: 检查现有测试文件结构**

运行：
```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
type src/shared/messages.test.js | head -30
```

预期：输出现有测试框架（jest/describe/it 结构）。

- [ ] **Step 2: 在测试文件末尾添加测试套件框架**

编辑 `src/shared/messages.test.js`，在文件末尾加入：

```javascript
describe('buildWelcomeText', () => {
  // 4 个测试用例将在后续步骤添加
});
```

- [ ] **Step 3: 运行现有测试确保基线通过**

运行：
```bash
npm test -- src/shared/messages.test.js 2>&1 | tail -10
```

预期：现有测试通过，新的 `describe` 块可被识别但暂无 it()。

- [ ] **Step 4: Commit**

```bash
git add src/shared/messages.test.js
git commit -m "test: 添加 buildWelcomeText 测试套件框架"
```

---

### Task 2: 编写「有已启用动作」场景的测试

**文件：**
- Modify: `src/shared/messages.test.js`

**场景：** 机器人 ID 为 `bot_123`，已配置 3 条已启用的动作。验证文案包含动作列表。

- [ ] **Step 1: 在测试中 mock `getConfigs`**

编辑 `src/shared/messages.test.js`，在 `describe('buildWelcomeText')` 块中加入第一个测试：

```javascript
import { buildWelcomeText } from './messages.js';
import * as actionConfigs from '../store/action-configs.js';

// 在 describe 块内
describe('buildWelcomeText', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('有已启用动作时应列出动作列表', () => {
    // Mock getConfigs 返回 3 条已启用的动作
    jest.spyOn(actionConfigs, 'getConfigs').mockReturnValue([
      {
        id: 'ac_001',
        botId: 'bot_123',
        name: '小程序二维码',
        description: '生成并发送小程序二维码给指定用户',
        enabled: true,
      },
      {
        id: 'ac_002',
        botId: 'bot_123',
        name: '清理环境',
        description: '清除测试环境中的所有测试数据',
        enabled: true,
      },
      {
        id: 'ac_003',
        botId: 'bot_123',
        name: '退款流程',
        description: '执行退款流程并通知相关人员',
        enabled: true,
      },
    ]);

    const text = buildWelcomeText('bot_123');

    // 断言：应包含核心操作提示
    expect(text).toContain('没有识别到你的意图');
    expect(text).toContain('· 提交需求');
    expect(text).toContain('· 提交故障');
    expect(text).toContain('· 问个问题');

    // 断言：应包含动作列表
    expect(text).toContain('或其他已配置的功能，比如');
    expect(text).toContain('生成并发送小程序二维码给指定用户');
    expect(text).toContain('清除测试环境中的所有测试数据');
    expect(text).toContain('执行退款流程并通知相关人员');

    // 断言：应包含结尾提示语
    expect(text).toContain('识别到我会及时回复你～');
  });
});
```

- [ ] **Step 2: 运行测试确保失败**

运行：
```bash
npm test -- src/shared/messages.test.js -t "有已启用动作时应列出动作列表" 2>&1
```

预期：FAIL，提示 `buildWelcomeText is not a function` 或类似错误（因为函数还未实现）。

- [ ] **Step 3: Commit**

```bash
git add src/shared/messages.test.js
git commit -m "test: 添加「有动作」场景的测试用例"
```

---

### Task 3: 编写「无已启用动作」场景的测试

**文件：**
- Modify: `src/shared/messages.test.js`

**场景：** 机器人 ID 为 `bot_456`，无已启用的动作。验证文案显示「暂未配置」提示。

- [ ] **Step 1: 在测试套件中添加第二个测试**

编辑 `src/shared/messages.test.js`，在现有测试下方加入：

```javascript
it('无已启用动作时应显示「暂未配置」提示', () => {
  // Mock getConfigs 返回空数组（该 botId 无动作）
  jest.spyOn(actionConfigs, 'getConfigs').mockReturnValue([]);

  const text = buildWelcomeText('bot_456');

  // 断言：应包含核心操作提示
  expect(text).toContain('没有识别到你的意图');
  expect(text).toContain('· 提交需求');

  // 断言：应包含「暂未配置」提示，而非「比如」列表
  expect(text).toContain('或其他已配置的功能（暂未配置）');
  expect(text).not.toContain('或其他已配置的功能，比如');

  // 断言：应包含结尾提示语
  expect(text).toContain('识别到我会及时回复你～');
});
```

- [ ] **Step 2: 运行测试确保失败**

运行：
```bash
npm test -- src/shared/messages.test.js -t "无已启用动作时应显示" 2>&1
```

预期：FAIL，同样是 `buildWelcomeText is not a function`。

- [ ] **Step 3: Commit**

```bash
git add src/shared/messages.test.js
git commit -m "test: 添加「无动作」场景的测试用例"
```

---

### Task 4: 编写「超过 5 条动作」场景的测试

**文件：**
- Modify: `src/shared/messages.test.js`

**场景：** 机器人有 8 条已启用动作。验证仅显示前 5 条，末尾加「…等 3 项」。

- [ ] **Step 1: 添加第三个测试**

编辑 `src/shared/messages.test.js`，在现有测试下方加入：

```javascript
it('超过 5 条动作时应显示前 5 条并提示还有其他项', () => {
  // Mock getConfigs 返回 8 条已启用的动作
  const actions = Array.from({ length: 8 }, (_, i) => ({
    id: `ac_${i + 1}`,
    botId: 'bot_789',
    name: `动作 ${i + 1}`,
    description: `这是第 ${i + 1} 个动作`,
    enabled: true,
  }));

  jest.spyOn(actionConfigs, 'getConfigs').mockReturnValue(actions);

  const text = buildWelcomeText('bot_789');

  // 断言：前 5 条动作应在文本中
  expect(text).toContain('这是第 1 个动作');
  expect(text).toContain('这是第 2 个动作');
  expect(text).toContain('这是第 3 个动作');
  expect(text).toContain('这是第 4 个动作');
  expect(text).toContain('这是第 5 个动作');

  // 断言：第 6、7、8 条应在「…等」提示中
  expect(text).toContain('…等 3 项');
  // 确保第 6 条不单独列出（在 …等 中计数，而非详细列出）
  expect(text).not.toContain('这是第 6 个动作');
});
```

- [ ] **Step 2: 运行测试确保失败**

运行：
```bash
npm test -- src/shared/messages.test.js -t "超过 5 条动作时应显示前 5 条" 2>&1
```

预期：FAIL，`buildWelcomeText is not a function`。

- [ ] **Step 3: Commit**

```bash
git add src/shared/messages.test.js
git commit -m "test: 添加「超过 5 条」场景的测试用例"
```

---

### Task 5: 编写「botId 为 null」边界情况的测试

**文件：**
- Modify: `src/shared/messages.test.js`

**场景：** `botId` 为 null（未知机器人）。验证降级到「暂未配置」。

- [ ] **Step 1: 添加第四个测试**

编辑 `src/shared/messages.test.js`，在现有测试下方加入：

```javascript
it('botId 为 null 时应降级到「暂未配置」', () => {
  // Mock getConfigs 返回某个数据库中的全部动作（包含其他 bot 的）
  jest.spyOn(actionConfigs, 'getConfigs').mockReturnValue([
    {
      id: 'ac_x',
      botId: 'bot_other',
      name: '其他机器人的动作',
      description: '这是另一个机器人的动作',
      enabled: true,
    },
  ]);

  const text = buildWelcomeText(null);

  // 断言：应包含基础操作提示
  expect(text).toContain('没有识别到你的意图');
  expect(text).toContain('· 提交需求');

  // 断言：因为 botId 不匹配，无法找到 null 的动作，应显示「暂未配置」
  expect(text).toContain('或其他已配置的功能（暂未配置）');

  // 断言：不应包含其他 bot 的动作描述
  expect(text).not.toContain('这是另一个机器人的动作');
});
```

- [ ] **Step 2: 运行测试确保失败**

运行：
```bash
npm test -- src/shared/messages.test.js -t "botId 为 null" 2>&1
```

预期：FAIL，`buildWelcomeText is not a function`。

- [ ] **Step 3: Commit**

```bash
git add src/shared/messages.test.js
git commit -m "test: 添加「botId 为 null」边界情况的测试"
```

---

### Task 6: 实现 `buildWelcomeText()` 函数

**文件：**
- Modify: `src/shared/messages.js`

**前提：** 4 个测试已写入，现在实现函数使其全部通过。

- [ ] **Step 1: 在 `messages.js` 顶部添加导入**

编辑 `src/shared/messages.js`，在现有 imports 下方加入（如果已有则无需重复）：

```javascript
import { getConfigs } from '../store/action-configs.js';
```

- [ ] **Step 2: 在 REGISTRY 定义后添加 `buildWelcomeText()` 函数**

编辑 `src/shared/messages.js`，在 `REGISTRY` 对象定义的后面（约行 62）加入：

```javascript
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
    '    例: 问个问题: 我要在聊天页加个弹框, 这个功能复杂吗?\n';

  // 2. 读取该 bot 的已启用动作
  const enabledActions = getConfigs()
    .filter((c) => c && c.botId === botId && c.enabled)
    .slice(0, 5); // 最多 5 条

  // 3. 拼装动作段（或提示段）
  let actionSection = '';
  if (enabledActions.length > 0) {
    actionSection = '\n或其他已配置的功能，比如\n';
    enabledActions.forEach((action, i) => {
      // 优先用 description，否则降级用 name
      const label = (action.description && action.description.trim()) || action.name || '';
      actionSection += `    ${i + 1}. ${label}\n`;
    });

    // 超出 5 条时追加「…等」提示
    const totalEnabled = getConfigs().filter((c) => c && c.botId === botId && c.enabled).length;
    if (totalEnabled > 5) {
      actionSection += `    …等 ${totalEnabled - 5} 项\n`;
    }
  } else {
    // 无已启用动作：显示提示语
    actionSection = '\n或其他已配置的功能（暂未配置）\n';
  }

  // 4. 拼装完整文案
  return core + actionSection + '\n识别到我会及时回复你～';
}
```

- [ ] **Step 3: 运行测试验证全部通过**

运行：
```bash
npm test -- src/shared/messages.test.js -t "buildWelcomeText" 2>&1
```

预期：4 个测试全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/shared/messages.js
git commit -m "feat: 实现 buildWelcomeText() 动态文案生成函数

- 读取指定 bot 的已启用动作配置
- 最多展示 5 条，超过部分显示「…等 N 项」
- 无动作时显示「暂未配置」提示
- 优先用 description 展示，否则降级用 name"
```

---

### Task 7: 修改 `dispatch.js` 的调用点

**文件：**
- Modify: `src/app/dispatch.js`

**变更：** 将 `msg('welcome')` 替换为 `buildWelcomeText(getActiveBot()?.id)`。

- [ ] **Step 1: 在 `dispatch.js` 添加必要的 imports**

编辑 `src/app/dispatch.js`，找到现有的 imports 块（文件顶部，约行 1-10），确保有以下两行（如已有则无需重复）：

```javascript
import { buildWelcomeText } from '../shared/messages.js';
import { getActiveBot } from '../store/settings.js';
```

参考现有 imports：
```javascript
import { classify } from './intent.js';
import { features } from '../features/index.js';
import { logger, preview } from '../shared/logger.js';
import { msg } from '../shared/messages.js';
import { PASS } from './signals.js';
```

如果 `buildWelcomeText` 和 `getActiveBot` 导入已存在，跳过此步；否则添加：

```javascript
import { buildWelcomeText, msg } from '../shared/messages.js';
import { getActiveBot } from '../store/settings.js';
```

- [ ] **Step 2: 找到 `msg('welcome')` 调用点**

在 `src/app/dispatch.js` 中定位（约行 98-100）：

```javascript
// 3. 无匹配：帮助
logger.info('dispatch', '无匹配 → 帮助');
await ctx.reply(msg('welcome'));
```

- [ ] **Step 3: 替换调用**

编辑该行，将：
```javascript
await ctx.reply(msg('welcome'));
```

改为：
```javascript
const bot = getActiveBot();
await ctx.reply(buildWelcomeText(bot?.id));
```

完整上下文应为：
```javascript
// 3. 无匹配：帮助
logger.info('dispatch', '无匹配 → 帮助');
const bot = getActiveBot();
await ctx.reply(buildWelcomeText(bot?.id));
```

- [ ] **Step 4: 验证文件语法**

运行：
```bash
node -c src/app/dispatch.js
```

预期：无输出（语法正确）。

- [ ] **Step 5: Commit**

```bash
git add src/app/dispatch.js
git commit -m "fix: dispatch 改用动态 welcome 文案

- 替换 msg('welcome') 为 buildWelcomeText(bot?.id)
- 支持根据实际配置的动作动态生成兜底提示
- 无动作时显示「暂未配置」而非硬编码示例"
```

---

### Task 8: 编写 dispatch 集成测试

**文件：**
- Modify: `src/app/dispatch.test.js`

**目标：** 验证 dispatch 调用 `buildWelcomeText()`，且随着 bot 切换，回复文案也随之改变。

- [ ] **Step 1: 查看现有测试结构**

运行：
```bash
grep -n "describe\|it(" src/app/dispatch.test.js | head -20
```

预期：输出现有的 describe 块和测试用例列表。

- [ ] **Step 2: 在测试文件中添加新的测试用例**

编辑 `src/app/dispatch.test.js`，在文件末尾加入新的 describe 块：

```javascript
describe('dispatch with dynamic welcome text', () => {
  it('意图为 other 时应使用 buildWelcomeText 回复', async () => {
    // Mock dependencies
    const mockClassify = jest.fn().mockResolvedValue({
      intent: 'other',
      body: '',
      strong: false,
      env: 'test',
    });

    const mockGetActiveBot = jest.fn().mockReturnValue({
      id: 'bot_123',
      name: 'Test Bot',
      enabled: true,
    });

    // Mock getConfigs 返回 2 条已启用的动作
    jest.spyOn(require('../store/action-configs.js'), 'getConfigs').mockReturnValue([
      {
        id: 'ac_1',
        botId: 'bot_123',
        name: '动作1',
        description: '这是动作 1',
        enabled: true,
      },
      {
        id: 'ac_2',
        botId: 'bot_123',
        name: '动作2',
        description: '这是动作 2',
        enabled: true,
      },
    ]);

    // Mock context
    const mockCtx = {
      source: 'feishu',
      user: { id: 'user_123', role: 'member' },
      text: '随机问一下',
      reply: jest.fn().mockResolvedValue(undefined),
      meta: {},
    };

    // 获取一个 feature 列表（可从现有测试抄）
    const features = []; // 空列表 → 无 feature 匹配

    // 执行 dispatch
    await dispatch(mockCtx, {
      featureList: features,
      classifyFn: mockClassify,
    });

    // 断言：ctx.reply 被调用，参数包含动作描述
    expect(mockCtx.reply).toHaveBeenCalledTimes(1);
    const replyText = mockCtx.reply.mock.calls[0][0];
    expect(replyText).toContain('没有识别到你的意图');
    expect(replyText).toContain('这是动作 1');
    expect(replyText).toContain('这是动作 2');
    expect(replyText).toContain('识别到我会及时回复你～');
  });
});
```

注意：这是一个基础集成测试框架。如果项目的 dispatch 测试方式不同（例如已有特定的 mock 工具函数），请参考现有模式调整。

- [ ] **Step 3: 运行测试确保通过**

运行：
```bash
npm test -- src/app/dispatch.test.js -t "意图为 other 时应使用 buildWelcomeText" 2>&1
```

预期：PASS（如果现有的 feature 列表 mock 方式有所不同，可能需要调整；这一步的目的是验证集成正常）。

- [ ] **Step 4: Commit**

```bash
git add src/app/dispatch.test.js
git commit -m "test: 添加 dispatch 集成测试，验证动态 welcome 文案

- 验证无意图匹配时调用 buildWelcomeText
- 确保回复包含实际配置的动作"
```

---

### Task 9: 手动测试（飞书消息格式验证）

**背景：** 单元/集成测试通过后，需在实际飞书环境验证消息格式和缩进。

- [ ] **Step 1: 启动本地 feishu 服务**

运行：
```bash
npm run dev:feishu 2>&1 | head -20
```

预期：启动日志，WebSocket 连接状态。

- [ ] **Step 2: 在飞书群聊发送无法识别的消息**

在已连接的飞书群中 @ 机器人，发送：
```
@机器人 随机问一下
```

或其他明确无意图的语句。

- [ ] **Step 3: 检查回复消息**

机器人应回复 welcome 文案，验证：
- ✓ 三条核心操作（提交需求/故障/问题）正确显示
- ✓ 若有配置的动作，「或其他已配置的功能，比如」段落正确列出
- ✓ 缩进正确（用空格，不是 Tab）
- ✓ 行尾无多余空格
- ✓ 动作描述（若有）正确显示

- [ ] **Step 4: 测试无动作情况（可选）**

如果当前 bot 无动作配置，验证：
- ✓ 显示「或其他已配置的功能（暂未配置）」
- ✓ 不出现「比如」和数字列表

- [ ] **Step 5: 记录截图或日志（可选）**

如有异常，截图或导出日志至 `logs/` 目录供 debug。

- [ ] **Step 6: 确认无误后关闭服务**

按 Ctrl+C 停止 feishu 服务。

---

### Task 10: 最终检查与提交

**文件：**
- Verify: `src/shared/messages.js`
- Verify: `src/app/dispatch.js`
- Verify: `src/shared/messages.test.js`
- Verify: `src/app/dispatch.test.js`

- [ ] **Step 1: 运行全部相关测试**

运行：
```bash
npm test -- --testPathPattern="(messages|dispatch)" 2>&1 | tail -20
```

预期：所有测试通过，覆盖率 > 80%。

- [ ] **Step 2: 检查代码风格**

运行（如项目配置了 eslint）：
```bash
npx eslint src/shared/messages.js src/app/dispatch.js 2>&1
```

预期：无 error（warning 可容许）。

- [ ] **Step 3: 检查类型（如项目使用 TypeScript 或 JSDoc）**

如有 JSDoc，确保 `buildWelcomeText()` 的 param 和 return 注释完整（见 Task 6 Step 2）。

- [ ] **Step 4: 验证导入导出一致**

运行：
```bash
grep -r "buildWelcomeText" src/ --include="*.js" | grep -v test | grep -v node_modules
```

预期：
- ✓ `messages.js` 有 `export function buildWelcomeText`
- ✓ `dispatch.js` 有 `import { buildWelcomeText }`
- ✓ 无其他地方错误导入

- [ ] **Step 5: 梳理 git log**

运行：
```bash
git log --oneline | head -10
```

预期：7 条新 commit（Task 2-4 的 3 条测试 + Task 6 的实现 + Task 7 的 dispatch 修改 + Task 8 的集成测试 + Task 9 无 commit）。

- [ ] **Step 6: 最终验收 commit**

运行：
```bash
git status
```

预期：working tree clean（无未提交的改动）。

---

## 自查清单

**Spec 覆盖：**
- ✓ 核心逻辑 `buildWelcomeText(botId)` 实现（Task 6）
- ✓ `dispatch.js` 调用点修改（Task 7）
- ✓ 最多 5 条动作显示 + 「…等 N 项」提示（Task 6 Step 2，行约 25-30）
- ✓ 无动作时显示「暂未配置」（Task 6 Step 2，行约 33-35）
- ✓ 优先用 `description`，否则降级用 `name`（Task 6 Step 2，行约 22）
- ✓ 空格缩进，不用 Tab（Task 6 Step 2，整个字符串定义）

**占位符扫描：**
- ✓ 无 "TBD" / "TODO"
- ✓ 所有代码块完整，无 "implement here"
- ✓ 所有命令、预期输出明确
- ✓ 测试用例具体，无 "similar to Task N"

**类型一致性：**
- ✓ `getConfigs()` 返回数组，每条含 `botId`、`enabled`、`name`、`description` 字段（来自 `action-configs.js`）
- ✓ `getActiveBot()` 返回对象含 `id` 字段（来自 `settings.js`）
- ✓ `buildWelcomeText(botId)` 接收 string|null，返回 string

**边界情况：**
- ✓ `botId` 为 null 时的处理（Task 5）
- ✓ 动作 `description` 为空时的降级（Task 6 Step 2，行 22）
- ✓ 动作总数 > 5 时的「…等」提示（Task 6 Step 2，行 29-31）
- ✓ 无已启用动作时的「暂未配置」提示（Task 6 Step 2，行 33-35）

**测试覆盖：**
- ✓ 有动作场景（Task 2）
- ✓ 无动作场景（Task 3）
- ✓ 超过 5 条场景（Task 4）
- ✓ botId 为 null 场景（Task 5）
- ✓ dispatch 集成测试（Task 8）

---

## 总结

本计划共 10 个任务，预计 **1.5-2 小时** 完成（包括手动测试）：

- **Task 1-5**：测试驱动开发（TDD）—— 4 个单元测试框架搭建（约 15 分钟）
- **Task 6**：实现核心函数（约 15 分钟）
- **Task 7**：修改调用点（约 5 分钟）
- **Task 8**：集成测试（约 15 分钟）
- **Task 9**：手动测试（约 20-30 分钟，可选但推荐）
- **Task 10**：最终检查（约 10 分钟）

每个任务都可独立追踪（checkbox），支持暂停/恢复。


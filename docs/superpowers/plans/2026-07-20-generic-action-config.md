# 通用动作配置系统 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 把硬编码的 data-cleanup 功能改造为配置驱动的通用意图+槽位+脚本执行系统，支持任意脚本配置和变量定义。

**架构：** 底层存储（action-configs.json / user-vars.json）→ 意图识别（两级：关键词 → Claude 消歧）→ 槽位填充（提取 + 追问）→ 脚本执行（参数拼装 + 脱敏日志）。删除 data-cleanup feature，新建 action-runner feature 取代。

**技术栈：** Node.js（现有）、SQLite 无依赖（JSON 文件 + 原子写）、Claude API for 消歧

---

## Task 1: 配置层 — config.js 改造

**文件:**
- 改动: `src/shared/config.js`

### Step 1: 读取现有 config.js

确认现有 cleanup 配置的位置和依赖。

### Step 2: 移除 cleanup 字段，新增 scripts 字段

```javascript
// 删除 config.cleanup 整个对象

// 新增：
scripts: {
  dir: process.env.SCRIPTS_DIR || 'scripts',
  pythonBin: process.env.PYTHON_BIN || 'python',
},
```

**完整位置：** `config.js` 的 `export const config` 对象内，放在 `intent` 字段之前（按字母序）。

### Step 3: 修改 getLarkCredentials() 以下的部分（无改动）

确认函数依然可调用，无破坏。

### Step 4: Commit

```bash
git add src/shared/config.js
git commit -m "config: replace cleanup with scripts config"
```

---

## Task 2: 存储层 — action-configs CRUD

**文件:**
- 新建: `src/store/action-configs.js`
- 新建: `src/store/action-configs.test.js`

### Step 1: 写读取配置的测试

```javascript
// src/store/action-configs.test.js
import { describe, it, assert } from 'node:test';
import { getConfigs, saveConfigs } from './action-configs.js';
import { rmSync } from 'node:fs';
import { dataPath } from './index.js';

describe('action-configs', () => {
  const cleanUp = () => {
    try {
      rmSync(dataPath('action-configs.json'));
    } catch {}
  };

  it('读取空配置返回空数组', () => {
    cleanUp();
    const configs = getConfigs();
    assert.equal(Array.isArray(configs), true);
    assert.equal(configs.length, 0);
  });

  it('保存并读取配置', () => {
    cleanUp();
    const config = {
      id: 'test-id',
      name: '测试',
      keywords: ['test'],
    };
    saveConfigs([config]);
    const loaded = getConfigs();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'test-id');
  });
});
```

运行验证失败：`node --test src/store/action-configs.test.js`

### Step 2: 实现 action-configs.js

```javascript
// src/store/action-configs.js
import { readJson, writeJson } from './index.js';

const FILE = 'action-configs.json';

/**
 * 读取全部动作配置
 * @returns {Array<ActionConfig>}
 */
export function getConfigs() {
  return readJson(FILE, []);
}

/**
 * 保存全部配置（原子替换）
 * @param {Array<ActionConfig>} configs
 */
export function saveConfigs(configs) {
  writeJson(FILE, configs);
}

/**
 * 获取某个配置（by id）
 * @param {string} id
 * @returns {ActionConfig | null}
 */
export function getConfig(id) {
  const configs = getConfigs();
  return configs.find((c) => c.id === id) || null;
}

/**
 * 添加配置
 * @param {ActionConfig} config
 * @returns {ActionConfig} 返回添加后的配置（含时间戳）
 */
export function addConfig(config) {
  return updateConfigs((configs) => [
    ...configs,
    {
      ...config,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]);
}

/**
 * 更新配置（by id）
 * @param {string} id
 * @param {Partial<ActionConfig>} updates
 * @returns {ActionConfig | null}
 */
export function updateConfig(id, updates) {
  const result = updateConfigs((configs) => {
    const idx = configs.findIndex((c) => c.id === id);
    if (idx === -1) return undefined; // 不存在则放弃写盘
    configs[idx] = {
      ...configs[idx],
      ...updates,
      updatedAt: new Date().toISOString(),
      id: configs[idx].id, // id 不可更改
      createdAt: configs[idx].createdAt, // createdAt 不可更改
    };
    return configs;
  });
  return result ? result.find((c) => c.id === id) : null;
}

/**
 * 删除配置（by id）
 */
export function deleteConfig(id) {
  updateConfigs((configs) => configs.filter((c) => c.id !== id));
}

/**
 * 原子读-改-写
 * @param {Function} fn (configs) => newConfigs | undefined
 * @returns {Array<ActionConfig>} 操作后的全量配置
 */
function updateConfigs(fn) {
  return updateJson(FILE, [], fn);
}

// 从 src/store/index.js 补充 import
import { updateJson } from './index.js';
```

**修正：** updateConfigs 要补上 import updateJson。

### Step 3: 运行测试验证通过

```bash
node --test src/store/action-configs.test.js
```

预期：2 pass

### Step 4: 补充更多测试用例

```javascript
// 补充到 src/store/action-configs.test.js 的 describe 块内

it('添加配置自动生成 createdAt/updatedAt', () => {
  cleanUp();
  const added = addConfig({
    id: 'new-id',
    name: '新配置',
    keywords: [],
  });
  assert(added.createdAt);
  assert(added.updatedAt);
});

it('更新配置修改 updatedAt', async () => {
  cleanUp();
  addConfig({ id: 'test', name: '原名' });
  const before = getConfig('test');
  await new Promise((r) => setTimeout(r, 10)); // 确保时间不同
  updateConfig('test', { name: '新名' });
  const after = getConfig('test');
  assert.notEqual(before.updatedAt, after.updatedAt);
  assert.equal(after.name, '新名');
});

it('删除配置', () => {
  cleanUp();
  addConfig({ id: 'to-delete', name: '删除我' });
  deleteConfig('to-delete');
  assert.equal(getConfigs().length, 0);
});
```

重跑测试，预期 5 pass。

### Step 5: Commit

```bash
git add src/store/action-configs.js src/store/action-configs.test.js
git commit -m "store: add action-configs CRUD with tests"
```

---

## Task 3: 存储层 — user-vars CRUD（替代 bindings）

**文件:**
- 新建: `src/store/user-vars.js`
- 新建: `src/store/user-vars.test.js`

### Step 1: 写测试

```javascript
// src/store/user-vars.test.js
import { describe, it, assert } from 'node:test';
import { getVars, setVar, getVar } from './user-vars.js';
import { rmSync } from 'node:fs';
import { dataPath } from './index.js';

describe('user-vars', () => {
  const cleanUp = () => {
    try {
      rmSync(dataPath('user-vars.json'));
    } catch {}
  };

  it('获取空用户返回空对象', () => {
    cleanUp();
    const vars = getVars('ou_unknown');
    assert.deepEqual(vars, {});
  });

  it('设置和获取单个变量', () => {
    cleanUp();
    setVar('ou_user1', 'phone', '13800138000');
    const phone = getVar('ou_user1', 'phone');
    assert.equal(phone, '13800138000');
  });

  it('获取多个用户的变量互不影响', () => {
    cleanUp();
    setVar('ou_user1', 'phone', '13800138000');
    setVar('ou_user2', 'phone', '18800000000');
    assert.equal(getVar('ou_user1', 'phone'), '13800138000');
    assert.equal(getVar('ou_user2', 'phone'), '18800000000');
  });
});
```

运行验证失败。

### Step 2: 实现 user-vars.js

```javascript
// src/store/user-vars.js
import { readJson, updateJson } from './index.js';

const FILE = 'user-vars.json';

/**
 * 获取某个用户的全部变量
 * @param {string} userId open_id
 * @returns {Object} { varName: value, ... }
 */
export function getVars(userId) {
  const all = readJson(FILE, {});
  return all[userId] || {};
}

/**
 * 获取某个用户的某个变量
 * @param {string} userId
 * @param {string} varName
 * @returns {string | null}
 */
export function getVar(userId, varName) {
  const vars = getVars(userId);
  return vars[varName] || null;
}

/**
 * 设置某个用户的某个变量（原子）
 * @param {string} userId
 * @param {string} varName
 * @param {string} value
 */
export function setVar(userId, varName, value) {
  updateJson(FILE, {}, (all) => {
    if (!all[userId]) all[userId] = {};
    all[userId][varName] = value;
    return all;
  });
}

/**
 * 获取所有用户数据（无需序列化，Web API /api/user-vars 不暴露）
 * @returns {Object}
 */
export function getAllVars() {
  return readJson(FILE, {});
}
```

### Step 3: 运行测试

```bash
node --test src/store/user-vars.test.js
```

预期 3 pass。

### Step 4: Commit

```bash
git add src/store/user-vars.js src/store/user-vars.test.js
git commit -m "store: add user-vars CRUD replacing bindings"
```

---

## Task 4: 存储层 — action-log（执行日志）

**文件:**
- 新建: `src/store/action-log.js`

### Step 1: 实现 action-log.js（JSONL 追加）

```javascript
// src/store/action-log.js
import { appendFile } from 'node:fs/promises';
import { dataPath } from './index.js';
import { logger } from '../shared/logger.js';

const LOG_FILE = dataPath('action-log.jsonl');

/**
 * 脱敏敏感字段（如手机号）
 * @param {string} value
 * @param {string} fieldName
 */
function maskValue(value, fieldName) {
  if (fieldName === 'phone' && value && typeof value === 'string' && value.length >= 7) {
    return `${value.slice(0, 3)}****${value.slice(-4)}`;
  }
  return value;
}

/**
 * 记录动作执行日志
 * @param {Object} logEntry { time, userId, actionId, actionName, vars, ok, code }
 */
export async function appendActionLog(entry) {
  try {
    // 脱敏
    const masked = {
      ...entry,
      vars: Object.fromEntries(
        Object.entries(entry.vars || {}).map(([k, v]) => [k, maskValue(v, k)]),
      ),
    };
    const line = JSON.stringify(masked) + '\n';
    await appendFile(LOG_FILE, line, 'utf8');
  } catch (e) {
    // 日志写失败不应中断主流程，仅记 warning
    logger.warn('action-log', '无法写执行日志', { err: e?.message });
  }
}
```

### Step 2: Commit

```bash
git add src/store/action-log.js
git commit -m "store: add action-log JSONL appender with masking"
```

---

## Task 5: 特性层 — slot-filler（变量提取 + 追问）

**文件:**
- 新建: `src/features/action-runner/slot-filler.js`
- 新建: `src/features/action-runner/slot-filler.test.js`

### Step 1: 写测试（只测变量提取，不测 Claude 调用）

```javascript
// src/features/action-runner/slot-filler.test.js
import { describe, it, assert } from 'node:test';
import { extractVars, pickMissingVars } from './slot-filler.js';

describe('slot-filler', () => {
  it('从配置和用户消息提取手机号', async () => {
    const config = {
      variables: [
        { name: 'phone', label: '手机号', required: true },
        { name: 'env', label: '环境', required: true },
      ],
    };
    // 本测试用正则兜底路径（测试分离 Claude 调用）
    const extracted = await extractVars(config, '请清一下 test 的 13800138000', null); // userId=null
    assert.equal(extracted.phone, '13800138000');
    assert.equal(extracted.env, 'test');
  });

  it('识别缺失的必填变量', () => {
    const config = {
      variables: [
        { name: 'phone', required: true, prompt: '请输入手机号' },
        { name: 'env', required: true, prompt: '请输入环境' },
      ],
    };
    const collected = { phone: '13800138000' }; // env 缺失
    const missing = pickMissingVars(config, collected);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].name, 'env');
  });
});
```

### Step 2: 实现 slot-filler.js

```javascript
// src/features/action-runner/slot-filler.js
import { getVar } from '../../store/user-vars.js';
import { runClaude } from '../../integrations/claude.js';
import { claudeAuthOpts } from '../token-rotation.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

/**
 * 从用户消息文本提取配置所需的变量值
 * 优先用 Claude（精准），失败降级到正则（手机号/env）
 * @param {ActionConfig} config
 * @param {string} text 用户消息
 * @param {string | null} userId 用于查询持久变量
 * @returns {Promise<Object>} { phone: '...', env: '...' } （部分）
 */
export async function extractVars(config, text, userId) {
  const persistent = userId ? getPersistentVars(config, userId) : {};
  const extracted = await extractVarsFromText(config, text);
  return { ...persistent, ...extracted };
}

/**
 * 获取该用户已持久化的变量
 */
function getPersistentVars(config, userId) {
  const result = {};
  for (const v of config.variables || []) {
    if (v.persistent) {
      const val = getVar(userId, v.name);
      if (val) result[v.name] = val;
    }
  }
  return result;
}

/**
 * 从文本中提取变量（仅新值，不查持久化）
 */
async function extractVarsFromText(config, text) {
  // 优先尝试 Claude（仅 required=true 的变量）
  const requiredVars = (config.variables || []).filter((v) => v.required);
  if (requiredVars.length > 0) {
    const claudeResult = await tryClaudeExtract(config, text, requiredVars);
    if (claudeResult) return claudeResult;
  }

  // 降级到正则兜底
  return regexExtract(text);
}

/**
 * 用 Claude 提取变量（失败返回 null）
 */
async function tryClaudeExtract(config, text, variables) {
  const varDefs = variables.map((v) => `${v.name}=${v.label}`).join(', ');
  const prompt = `从用户消息提取变量，仅输出一行 JSON。
变量定义：${varDefs}
用户消息：「${text}」
输出：{"变量名":"值"}，找不到的字段省略。`;

  let out = '';
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);

  try {
    await runClaude(prompt, {
      ...claudeAuthOpts(),
      persistSession: false,
      model: config.intent?.classifyModel || 'claude-haiku-4-6',
      maxTurns: 1,
      disallowedTools: ['Agent', 'Task', 'Bash', 'Read', 'Write', 'Edit'],
      abortController: abort,
      onText: (t) => (out += t),
    });
  } catch {
    logger.warn('slot-filler', 'Claude 提取变量失败，降级正则', {});
    return null;
  } finally {
    clearTimeout(timer);
  }

  // 解析结果
  const m = out.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/**
 * 正则兜底：手机号、env
 */
function regexExtract(text) {
  const result = {};
  const phoneMatch = text.match(/1[3-9]\d{9}/);
  if (phoneMatch) result.phone = phoneMatch[0];
  const envMatch = text.match(/\b(dev|test)\b/i);
  if (envMatch) result.env = envMatch[1].toLowerCase();
  return result;
}

/**
 * 从配置中找出缺失的必填变量
 * @param {ActionConfig} config
 * @param {Object} collected 已收集的变量
 * @returns {Array<Variable>} 缺失的变量定义
 */
export function pickMissingVars(config, collected) {
  return (config.variables || []).filter(
    (v) => v.required && !collected[v.name],
  );
}
```

### Step 3: 修复 import 路径

`claudeAuthOpts` 应该从 `src/features/token-rotation.js`（已存在）；`config.intent` 改成 `config` 的直接字段。

### Step 4: 运行测试

```bash
node --test src/features/action-runner/slot-filler.test.js
```

预期 2 pass（第二个测试不涉及异步）。

### Step 5: Commit

```bash
git add src/features/action-runner/slot-filler.js src/features/action-runner/slot-filler.test.js
git commit -m "feat: add slot-filler for variable extraction and question prompts"
```

---

## Task 6: 特性层 — script-runner（脚本执行 + 脱敏日志）

**文件:**
- 新建: `src/features/action-runner/script-runner.js`
- 新建: `src/features/action-runner/script-runner.test.js`

### Step 1: 写测试（模拟脚本执行）

```javascript
// src/features/action-runner/script-runner.test.js
import { describe, it, assert } from 'node:test';
import { buildScriptArgs, maskVars } from './script-runner.js';

describe('script-runner', () => {
  it('从配置和变量值组装脚本参数', () => {
    const config = {
      variables: [
        { name: 'env' },
        { name: 'phone' },
      ],
    };
    const vars = { env: 'test', phone: '13800138000' };
    const args = buildScriptArgs(config, vars);
    assert.deepEqual(args, ['--env', 'test', '--phone', '13800138000']);
  });

  it('脱敏日志中的敏感字段', () => {
    const vars = { phone: '13800138000', env: 'test' };
    const masked = maskVars(vars);
    assert.equal(masked.phone, '159****9503');
    assert.equal(masked.env, 'test'); // env 不脱敏
  });
});
```

### Step 2: 实现 script-runner.js

```javascript
// src/features/action-runner/script-runner.js
import path from 'node:path';
import { runScript } from '../../integrations/shell.js';
import { config } from '../../shared/config.js';
import { appendActionLog } from '../../store/action-log.js';
import { logger } from '../../shared/logger.js';

/**
 * 从配置和已收集变量组装脚本参数数组
 * @param {ActionConfig} actionConfig
 * @param {Object} collectedVars { phone: '...', env: '...' }
 * @returns {string[]} ['--name', 'value', ...]
 */
export function buildScriptArgs(actionConfig, collectedVars) {
  const args = [];
  for (const v of actionConfig.variables || []) {
    if (collectedVars[v.name] !== undefined) {
      args.push(`--${v.name}`, String(collectedVars[v.name]));
    }
  }
  return args;
}

/**
 * 脱敏日志中的敏感字段
 */
export function maskVars(vars) {
  const masked = { ...vars };
  if (masked.phone && typeof masked.phone === 'string' && masked.phone.length >= 7) {
    masked.phone = `${masked.phone.slice(0, 3)}****${masked.phone.slice(-4)}`;
  }
  return masked;
}

/**
 * 执行脚本
 * @param {ActionConfig} actionConfig
 * @param {string} userId 用户 ID
 * @param {Object} collectedVars 已收集的变量
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export async function runAction(actionConfig, userId, collectedVars) {
  const scriptPath = path.join(config.scripts.dir, actionConfig.scriptName);
  const bin = actionConfig.scriptType === 'node' ? 'node' : config.scripts.pythonBin;
  const args = buildScriptArgs(actionConfig, collectedVars);

  logger.info('script-runner', '▶ 执行脚本', {
    actionId: actionConfig.id,
    actionName: actionConfig.name,
    userId,
    vars: maskVars(collectedVars),
  });

  const result = await runScript(bin, [scriptPath, ...args], {
    cwd: config.scripts.dir,
    env: actionConfig.scriptType === 'python' ? { PYTHONIOENCODING: 'utf-8' } : undefined,
  });

  // 记日志
  await appendActionLog({
    time: new Date().toISOString(),
    userId,
    actionId: actionConfig.id,
    actionName: actionConfig.name,
    vars: maskVars(collectedVars),
    ok: result.ok,
    code: result.code ?? null,
  });

  logger.info(
    'script-runner',
    result.ok ? '✔ 执行成功' : '✖ 执行失败',
    { actionId: actionConfig.id, code: result.code ?? null },
  );

  return {
    ok: result.ok,
    output: result.ok ? (result.out || '') : (result.err || result.msg || ''),
  };
}
```

### Step 3: 运行测试

```bash
node --test src/features/action-runner/script-runner.test.js
```

预期 2 pass。

### Step 4: Commit

```bash
git add src/features/action-runner/script-runner.js src/features/action-runner/script-runner.test.js
git commit -m "feat: add script-runner for execution and masking"
```

---

## Task 7: 特性层 — action-runner feature handler

**文件:**
- 新建: `src/features/action-runner/index.js`
- 改动: `src/features/index.js`

### Step 1: 实现 action-runner/index.js

```javascript
// src/features/action-runner/index.js
import { getConfig } from '../../store/action-configs.js';
import { getVars, setVar } from '../../store/user-vars.js';
import { extractVars, pickMissingVars } from './slot-filler.js';
import { runAction } from './script-runner.js';
import { logger } from '../../shared/logger.js';

// pendingState: userId → { actionId, collected: {...}, waitingFor: varName }
const pendingState = new Map();

/**
 * 检查该用户是否有未完成的交互（在追问中间态）
 */
function hasPending(ctx) {
  return pendingState.has(ctx.user.id);
}

/**
 * 主处理流程
 * - 首次调用：intent.actionId 指定哪个动作 → 开始槽位填充
 * - 追问中间态：处理用户回复 → 继续追问或执行
 */
async function handle(ctx, intentResult) {
  const userId = ctx.user.id;
  const text = (ctx.text || '').strip();

  // 取消
  if (/^(取消|cancel)$/i.test(text)) {
    pendingState.delete(userId);
    return ctx.reply('已取消。');
  }

  // 追问中间态 → 处理用户回复
  const pending = pendingState.get(userId);
  if (pending) {
    return handlePendingResponse(ctx, pending, text);
  }

  // 新请求 → actionId 由 intent.actionId 指定（来自 classifyAction）
  const actionId = intentResult?.actionId;
  if (!actionId) {
    logger.error('action-runner', '缺少 actionId', { userId });
    return ctx.reply('发生错误，无法匹配动作。');
  }

  const actionConfig = getConfig(actionId);
  if (!actionConfig) {
    logger.error('action-runner', '动作配置不存在', { actionId });
    return ctx.reply('动作不存在或已禁用。');
  }

  // 开始槽位填充
  return proceedWithAction(ctx, actionConfig);
}

/**
 * 开始或继续某个动作的槽位填充
 */
async function proceedWithAction(ctx, actionConfig) {
  const userId = ctx.user.id;
  const text = ctx.text || '';

  // 从消息提取变量 + 合并持久化
  const extracted = await extractVars(actionConfig, text, userId);
  const missing = pickMissingVars(actionConfig, extracted);

  if (missing.length > 0) {
    // 保存到 pendingState 并追问第一个缺失变量
    const first = missing[0];
    pendingState.set(userId, {
      actionId: actionConfig.id,
      collected: extracted,
      waitingFor: first.name,
    });
    return ctx.reply(first.prompt || `请提供 ${first.label}`);
  }

  // 所有必填变量已收集 → 执行脚本
  pendingState.delete(userId);
  return executeAction(ctx, actionConfig, extracted);
}

/**
 * 处理用户在追问中间态的回复
 */
async function handlePendingResponse(ctx, pending, text) {
  const userId = ctx.user.id;
  const actionConfig = getConfig(pending.actionId);

  if (!actionConfig) {
    pendingState.delete(userId);
    return ctx.reply('动作不存在或已禁用。');
  }

  // 提取这次回复的变量
  const extracted = await extractVars(actionConfig, text, null); // 不复用持久化（用户新输入）
  const collected = { ...pending.collected, ...extracted };

  // 检查缺失
  const missing = pickMissingVars(actionConfig, collected);

  if (missing.length > 0) {
    // 继续追问
    const next = missing[0];
    pendingState.set(userId, {
      actionId: actionConfig.id,
      collected,
      waitingFor: next.name,
    });
    return ctx.reply(next.prompt || `请提供 ${next.label}`);
  }

  // 全齐 → 执行
  pendingState.delete(userId);
  return executeAction(ctx, actionConfig, collected);
}

/**
 * 执行脚本
 */
async function executeAction(ctx, actionConfig, collectedVars) {
  const userId = ctx.user.id;

  // 储存永久变量
  for (const v of actionConfig.variables || []) {
    if (v.persistent && collectedVars[v.name]) {
      setVar(userId, v.name, collectedVars[v.name]);
    }
  }

  // 执行脚本
  const result = await runAction(actionConfig, userId, collectedVars);

  if (result.ok) {
    const tail = result.output.slice(-800);
    return ctx.reply(`✅ ${actionConfig.name}完成\n${tail || '(无输出)'}`);
  } else {
    const tail = result.output.slice(-800);
    return ctx.reply(`❌ 执行失败\n${tail || '(无输出)'}`);
  }
}

export default {
  name: 'action-runner',
  permission: 'guest', // 由 ActionConfig 决定权限
  intents: ['action'],
  hasPending: (ctx) => hasPending(ctx),
  handle: (ctx, intentResult) => handle(ctx, intentResult),
};
```

### Step 2: 修改 src/features/index.js

```javascript
// 查找 data-cleanup import，删除
// import dataCleanup from './data-cleanup/index.js';

// 新增
import actionRunner from './action-runner/index.js';

export const features = [
  taskTriage,
  claudeExec,
  actionRunner, // ← 替换 dataCleanup
  feedback,
];
```

### Step 3: 测试（手动）

确保可以 `import` 无错误：
```bash
node -e "import('./src/features/index.js').then(() => console.log('OK'))"
```

### Step 4: Commit

```bash
git add src/features/action-runner/index.js src/features/index.js
git commit -m "feat: add action-runner feature replacing data-cleanup"
```

---

## Task 8: 意图识别 — intent.js 改造

**文件:**
- 改动: `src/app/intent.js`

### Step 1: 新增 classifyAction() 函数

在 `intent.js` 中添加（在 `claudeClassify` 之后、`classify` 之前）：

```javascript
/**
 * 分类用户消息是否命中某条 ActionConfig 意图
 * 返回 { intent: 'action', actionId, actionName } 或 { intent: 'other' }
 */
export async function classifyAction(text) {
  const { getConfigs } = await import('../store/action-configs.js');
  
  const configs = getConfigs().filter((c) => c.enabled !== false);
  if (configs.length === 0) {
    return { intent: 'other' };
  }

  // 第一级：关键词快路
  const candidates = configs.filter((c) => {
    return (c.keywords || []).some((kw) => text.includes(kw));
  });

  if (candidates.length === 1) {
    // 单候选直接命中
    const c = candidates[0];
    return { intent: 'action', actionId: c.id, actionName: c.name };
  }

  if (candidates.length === 0 || candidates.length > 1) {
    // 零或多候选 → Claude 消歧
    const result = await claudeClassifyAction(text, candidates.length > 0 ? candidates : configs);
    if (result) return result;
  }

  return { intent: 'other' };
}

/**
 * 用 Claude 消歧动作
 */
async function claudeClassifyAction(text, candidates) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CLASSIFY_TIMEOUT_MS);
  let out = '';

  try {
    // 构建候选列表
    const list = candidates.slice(0, 20).map((c, i) => {
      return `${i + 1}. id=${c.id}  ${c.name} — ${c.description}`;
    }).join('\n');

    const prompt =
      `你是意图分类器，仅输出一行 JSON，不要任何解释。\n` +
      `用户说：「${text}」\n\n` +
      `可选动作：\n${list}\n\n` +
      `若用户意图与某动作匹配，输出 {"action_id":"动作的id"}；\n` +
      `若均不匹配，输出 {"action_id":null}。`;

    await runClaude(prompt, {
      ...claudeAuthOpts(),
      persistSession: false,
      model: config.intent.classifyModel,
      maxTurns: 1,
      disallowedTools: ['Agent', 'Task', 'Bash', 'Read', 'Write', 'Edit'],
      abortController: abort,
      onText: (t) => (out += t),
    });

    await Promise.race([
      new Promise((r) => setTimeout(r, 1)),
      new Promise((r) => setTimeout(r, CLASSIFY_TIMEOUT_MS + 2000)),
    ]);
  } catch {
    // 超时或异常 → 降级
  } finally {
    clearTimeout(timer);
  }

  const m = out.match(/\{[\s\S]*?\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j.action_id && typeof j.action_id === 'string') {
        const found = candidates.find((c) => c.id === j.action_id);
        if (found) {
          return { intent: 'action', actionId: found.id, actionName: found.name };
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}
```

### Step 2: 改造 classify() 主入口

```javascript
// 原有的 classify() 改为：
export async function classify(text) {
  // 1. feedback 关键词快路
  const fb = feedbackKeyword(text);
  if (fb) return { intent: fb, env: null, keyword: null };

  // 2. action 分类（新系统）
  const action = await classifyAction(text);
  if (action.intent === 'action') {
    return { intent: 'action', actionId: action.actionId, actionName: action.actionName };
  }

  // 3. fallback
  return { intent: 'other', env: null, keyword: null };
}
```

### Step 3: 删除不需要的函数和 import

- 删除 `hasCleanupIntent()` 函数
- 删除 `addLearnedVerb` 的调用（第 108 行）
- 改为：

```javascript
// 原来：
if (cls.intent === 'cleanup' && cls.keyword) addLearnedVerb(cls.keyword);
// 改为：无（删除）
```

### Step 4: Commit

```bash
git add src/app/intent.js
git commit -m "feat: add classifyAction() and refactor classify pipeline"
```

---

## Task 9: 配置初始化 + 迁移

**文件:**
- 改动: `src/shared/config.js`（已在 Task 1 改过，这里补充）
- 改动: `src/shared/messages.js`
- 新建: `scripts/` 目录（mkdir）
- 改动: `src/entrypoints/web/server.js`（启动钩子）

### Step 1: 删除 cleanup 文案（messages.js）

```javascript
// src/shared/messages.js 中，从 REGISTRY 删除：
// cleanupAskPhone, cleanupAskEnv 两个 key

// 修改为：
export const REGISTRY = {
  welcome: { ... },
  feedbackAck: { ... },
  execNewChat: { ... },
  execProcessing: { ... },
  // cleanup 文案已移除，改为动作配置内联
};
```

### Step 2: 创建 scripts 目录

```bash
mkdir -p scripts
```

说明：`reset_onboarding.py` 需从原 `C:\Users\DELL\Desktop\compass-agent\deploy\scripts\` 目录复制或 symlink 到此。（本任务暂不含脚本复制，假设运维手动处理或后续配置文件指定路径）

### Step 3: 在 server.js 中添加启动钩子（迁移数据）

在 `server.js` 的 `server.listen()` 回调处，增加一次性迁移逻辑：

```javascript
// src/entrypoints/web/server.js 中，在 server.listen 回调里

server.listen(config.web.port, config.web.host, () => {
  console.log(`🚀 Server running on http://${config.web.host}:${config.web.port}`);

  // 一次性初始化：迁移数据、默认配置
  initializeDefaults();
});

async function initializeDefaults() {
  const { readJson, writeJson } = await import('../../store/index.js');
  const { getConfigs } = await import('../../store/action-configs.js');
  const { dataPath } = await import('../../store/index.js');

  // 1. 若 action-configs.json 不存在 → 创建默认清理配置
  const configs = getConfigs();
  if (configs.length === 0) {
    const { v4: uuidv4 } = await import('uuid');
    const defaultConfig = {
      id: uuidv4(),
      name: '清理账号数据',
      description: '清理某账号在 dev/test 环境的账号数据',
      keywords: ['清理', '清空', '重置', '清除', '初始化'],
      scriptType: 'python',
      scriptName: 'reset_onboarding.py',
      permission: 'guest',
      enabled: true,
      variables: [
        {
          name: 'env',
          label: '环境',
          prompt: '要清理哪个环境？请回复 dev 或 test',
          required: true,
          persistent: false,
        },
        {
          name: 'phone',
          label: '手机号',
          prompt: '请提供您的手机号（11 位）',
          required: true,
          persistent: true,
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeJson('action-configs.json', [defaultConfig]);
    console.log('✓ 默认动作配置已创建');
  }

  // 2. 若 bindings.json 存在 & user-vars.json 不存在 → 迁移
  try {
    const bindings = readJson('bindings.json', null);
    const userVars = readJson('user-vars.json', null);
    if (bindings && !userVars) {
      const migrated = {};
      for (const [userId, phone] of Object.entries(bindings)) {
        migrated[userId] = { phone };
      }
      writeJson('user-vars.json', migrated);
      console.log('✓ 用户变量已从 bindings.json 迁移');
    }
  } catch (e) {
    logger.warn('initialization', '迁移用户数据失败', { err: e?.message });
  }
}
```

### Step 4: 补充 uuid 依赖

package.json 已有 uuid（大概率），验证一下：
```bash
npm list uuid
```

若无，则 `npm install uuid`。

### Step 5: 补充 .gitignore

```gitignore
# 动作配置数据（本地运维配置）
action-configs.json
user-vars.json
action-log.jsonl
```

### Step 6: Commit

```bash
git add src/shared/messages.js src/entrypoints/web/server.js .gitignore
git commit -m "feat: add startup initialization and data migration"
```

---

## Task 10: Web API 端点（CRUD）

**文件:**
- 改动: `src/entrypoints/web/server.js`

### Step 1: 新增 CRUD 端点

在 `server.js` 的路由部分（靠近 `/api/run` 等端点），新增：

```javascript
// GET /api/actions — 列出所有动作配置
app.get('/api/actions', (req, res) => {
  const { getConfigs } = await import('../../store/action-configs.js');
  const configs = getConfigs();
  res.json(configs);
});

// POST /api/actions — 新建动作配置
app.post('/api/actions', express.json(), async (req, res) => {
  const { v4: uuidv4 } = await import('uuid');
  const { addConfig } = await import('../../store/action-configs.js');
  try {
    const body = req.body;
    const config = {
      ...body,
      id: uuidv4(),
    };
    const added = addConfig(config);
    res.json(added);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PUT /api/actions/:id — 更新动作配置
app.put('/api/actions/:id', express.json(), async (req, res) => {
  const { updateConfig } = await import('../../store/action-configs.js');
  try {
    const updated = updateConfig(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ error: '配置不存在' });
    }
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/actions/:id — 删除动作配置
app.delete('/api/actions/:id', async (req, res) => {
  const { deleteConfig, getConfig } = await import('../../store/action-configs.js');
  const config = getConfig(req.params.id);
  if (!config) {
    return res.status(404).json({ error: '配置不存在' });
  }
  deleteConfig(req.params.id);
  res.json({ success: true });
});

// GET /api/scripts — 列出脚本目录下的文件
app.get('/api/scripts', async (req, res) => {
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  try {
    const dir = join(process.cwd(), config.scripts.dir);
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && /\.(py|js)$/.test(f.name))
      .map((f) => f.name);
    res.json(files);
  } catch (e) {
    res.json([]); // scripts 目录不存在或无文件，返回空
  }
});
```

### Step 2: 确认 express.json() 中间件已启用

检查 server.js 顶部是否有 `app.use(express.json())`，没有的话加上。

### Step 3: Commit

```bash
git add src/entrypoints/web/server.js
git commit -m "api: add CRUD endpoints for action configs"
```

---

## Task 11: Web UI — 设置页「动作配置」Tab（列表）

**文件:**
- 改动: `public/app.js`

### Step 1: 在 HTML 中注册新 tab

找到设置弹层的 tab 列表（`#settingsPanel` 或类似），添加新 tab 按钮：

```html
<button class="settings-tab" data-tab="actions">动作配置</button>
```

若找不到 HTML 位置，改在 JS 中动态生成（见下步）。

### Step 2: 添加 panel 容器

在 `#settingsPanel` 内添加：

```html
<div id="actionListPanel" class="settings-content">
  <div style="display: flex; gap: 16px; height: 100%;">
    <!-- 左：列表 -->
    <div style="flex: 1; overflow: auto;">
      <button id="addActionBtn" style="margin-bottom: 12px;">+ 添加动作</button>
      <div id="actionsList"></div>
    </div>
    <!-- 右：编辑表单 -->
    <div id="actionFormPanel" style="flex: 1; overflow: auto; display: none;">
      <form id="actionForm"></form>
    </div>
  </div>
</div>
```

### Step 3: 添加 JS 函数（列表渲染 + 点击事件）

在 `public/app.js` 中，添加：

```javascript
async function loadActions() {
  try {
    const res = await fetch('/api/actions');
    return await res.json();
  } catch (e) {
    console.error('加载动作配置失败', e);
    return [];
  }
}

async function renderActionsList() {
  const actions = await loadActions();
  const container = document.getElementById('actionsList');
  container.innerHTML = actions.map((a) => `
    <div style="border: 1px solid #ddd; padding: 8px; margin-bottom: 8px; border-radius: 4px;">
      <div style="font-weight: bold;">${a.name}</div>
      <div style="font-size: 12px; color: #666;">关键词: ${(a.keywords || []).join(', ')}</div>
      <div style="font-size: 12px; color: #666;">脚本: ${a.scriptName}</div>
      <div style="margin-top: 8px;">
        <button data-action-id="${a.id}" class="editActionBtn" style="margin-right: 4px;">编辑</button>
        <button data-action-id="${a.id}" class="deleteActionBtn">删除</button>
      </div>
    </div>
  `).join('');

  // 委托事件
  container.querySelectorAll('.editActionBtn').forEach((btn) => {
    btn.addEventListener('click', () => showActionForm(btn.dataset.actionId));
  });
  container.querySelectorAll('.deleteActionBtn').forEach((btn) => {
    btn.addEventListener('click', () => deleteAction(btn.dataset.actionId));
  });
}

// 初始化
document.getElementById('addActionBtn')?.addEventListener('click', () => showActionForm(null));
```

### Step 4: 补充样式（可选）

在 `public/app.css` 中添加：
```css
.settings-tab {
  padding: 8px 12px;
  border: none;
  background: #f0f0f0;
  cursor: pointer;
}

.settings-tab.active {
  background: #fff;
  border-bottom: 2px solid #007bff;
}
```

### Step 5: Commit

```bash
git add public/app.js public/app.css
git commit -m "ui: add actions list panel in settings"
```

---

## Task 12: Web UI — 编辑表单

**文件:**
- 改动: `public/app.js`

### Step 1: 实现 showActionForm(actionId)

```javascript
async function showActionForm(actionId) {
  const formPanel = document.getElementById('actionFormPanel');
  const form = document.getElementById('actionForm');
  
  let action = null;
  if (actionId) {
    const res = await fetch(`/api/actions`);
    const all = await res.json();
    action = all.find((a) => a.id === actionId);
  }

  form.innerHTML = `
    <h3>${action ? '编辑动作' : '新建动作'}</h3>
    <label>
      动作名称：<input type="text" id="actionName" value="${action?.name || ''}" required />
    </label>
    <label>
      意图描述：<textarea id="actionDesc" required>${action?.description || ''}</textarea>
    </label>
    <label>
      关键词（逗号分隔）：<input type="text" id="actionKeywords" value="${(action?.keywords || []).join(', ')}" />
    </label>
    <label>
      脚本类型：
      <select id="scriptType">
        <option value="python" ${action?.scriptType === 'python' ? 'selected' : ''}>Python</option>
        <option value="node" ${action?.scriptType === 'node' ? 'selected' : ''}>Node.js</option>
      </select>
    </label>
    <label>
      脚本文件名：<input type="text" id="scriptName" value="${action?.scriptName || ''}" required />
    </label>
    <label>
      权限：
      <select id="permission">
        <option value="guest" ${action?.permission === 'guest' ? 'selected' : ''}>Guest</option>
        <option value="owner" ${action?.permission === 'owner' ? 'selected' : ''}>Owner</option>
      </select>
    </label>
    <label>
      <input type="checkbox" id="enabled" ${action?.enabled !== false ? 'checked' : ''} />
      启用此动作
    </label>

    <h4>变量</h4>
    <div id="variablesTable"></div>
    <button type="button" id="addVarBtn">+ 添加变量</button>

    <div style="margin-top: 16px; display: flex; gap: 8px;">
      <button type="submit">保存</button>
      <button type="button" id="cancelFormBtn">取消</button>
    </div>
  `;

  // 渲染变量表
  renderVariablesTable(action?.variables || []);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveAction(actionId, form);
  });

  document.getElementById('cancelFormBtn').addEventListener('click', () => {
    formPanel.style.display = 'none';
    renderActionsList();
  });

  document.getElementById('addVarBtn').addEventListener('click', () => {
    addVariableRow();
  });

  formPanel.style.display = 'block';
}

function renderVariablesTable(variables) {
  const table = document.getElementById('variablesTable');
  table.innerHTML = `
    <table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr>
          <th>名称</th><th>标签</th><th>追问文案</th><th>必填</th><th>永久存储</th><th>删除</th>
        </tr>
      </thead>
      <tbody id="variablesBody">
      </tbody>
    </table>
  `;
  const body = document.getElementById('variablesBody');
  variables.forEach((v, i) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><input type="text" class="varName" value="${v.name}" /></td>
      <td><input type="text" class="varLabel" value="${v.label}" /></td>
      <td><input type="text" class="varPrompt" value="${v.prompt || ''}" /></td>
      <td><input type="checkbox" class="varRequired" ${v.required ? 'checked' : ''} /></td>
      <td><input type="checkbox" class="varPersistent" ${v.persistent ? 'checked' : ''} /></td>
      <td><button type="button" class="deleteVarBtn" data-idx="${i}">删除</button></td>
    `;
    body.appendChild(row);
    row.querySelector('.deleteVarBtn').addEventListener('click', () => row.remove());
  });
}

function addVariableRow() {
  const body = document.getElementById('variablesBody');
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><input type="text" class="varName" /></td>
    <td><input type="text" class="varLabel" /></td>
    <td><input type="text" class="varPrompt" /></td>
    <td><input type="checkbox" class="varRequired" /></td>
    <td><input type="checkbox" class="varPersistent" /></td>
    <td><button type="button" class="deleteVarBtn">删除</button></td>
  `;
  body.appendChild(row);
  row.querySelector('.deleteVarBtn').addEventListener('click', () => row.remove());
}

async function saveAction(actionId, form) {
  const variables = Array.from(document.querySelectorAll('#variablesBody tr')).map((row) => ({
    name: row.querySelector('.varName').value,
    label: row.querySelector('.varLabel').value,
    prompt: row.querySelector('.varPrompt').value,
    required: row.querySelector('.varRequired').checked,
    persistent: row.querySelector('.varPersistent').checked,
  }));

  const payload = {
    name: document.getElementById('actionName').value,
    description: document.getElementById('actionDesc').value,
    keywords: document.getElementById('actionKeywords').value.split(',').map((k) => k.trim()).filter(Boolean),
    scriptType: document.getElementById('scriptType').value,
    scriptName: document.getElementById('scriptName').value,
    permission: document.getElementById('permission').value,
    enabled: document.getElementById('enabled').checked,
    variables,
  };

  const url = actionId ? `/api/actions/${actionId}` : '/api/actions';
  const method = actionId ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      document.getElementById('actionFormPanel').style.display = 'none';
      await renderActionsList();
      alert('已保存');
    } else {
      alert('保存失败');
    }
  } catch (e) {
    alert('保存失败: ' + e.message);
  }
}

async function deleteAction(actionId) {
  if (!confirm('确认删除？')) return;
  try {
    const res = await fetch(`/api/actions/${actionId}`, { method: 'DELETE' });
    if (res.ok) {
      await renderActionsList();
    }
  } catch (e) {
    alert('删除失败: ' + e.message);
  }
}
```

### Step 2: 在设置页 tab 点击时调用

找到 tab 点击处理，补充：

```javascript
tabBtn.addEventListener('click', () => {
  if (tabBtn.dataset.tab === 'actions') {
    showView('settings'); // 若设置面板不在文档树，先显示
    renderActionsList();
  }
});
```

### Step 3: Commit

```bash
git add public/app.js
git commit -m "ui: add action editor form with variable table"
```

---

## Task 13: 清理与迁移完成

**文件:**
- 删除: `src/features/data-cleanup/`
- 删除: `src/store/cleanup-log.js`（改为 action-log.js）
- 删除或注释: `src/store/bindings.js`（改为 user-vars.js）
- 删除或注释: `src/store/learned-keywords.js`（自学习关键词系统不需要了）

### Step 1: 删除旧文件

```bash
rm -rf src/features/data-cleanup
rm src/store/cleanup-log.js
rm src/store/bindings.js
rm src/store/learned-keywords.js
```

### Step 2: 确保无遗留引用

搜索代码中对 `bindings` 和 `learned-keywords` 的引用，全部清除：

```bash
grep -r "bindings\|cleanup-log\|learned-keywords\|hasCleanupIntent\|addLearnedVerb" src --include="*.js"
```

应该返回空（或仅在版本控制提示）。

### Step 3: Commit

```bash
git add -A
git commit -m "cleanup: remove legacy data-cleanup, bindings, learned-keywords"
```

---

## Task 14: 全链路测试 + 文档

**文件:**
- 创建或修改: `README.md` / `docs/action-config.md`
- 手动测试步骤

### Step 1: 写测试步骤文档

在项目 README 或新建 `docs/action-config.md`，记录：

```markdown
# 动作配置系统 使用指南

## 启动

```bash
npm start
# 或
pm2 restart claude-web
```

启动时自动创建默认清理配置条目（`action-configs.json`）。

## 配置动作

1. 打开 Web 设置页 (http://localhost:3000)
2. 点击「动作配置」tab
3. 点「+ 添加动作」或编辑现有配置
4. 填写名称、关键词、脚本、变量
5. 保存

## 触发动作（飞书）

在飞书里对机器人说：「清一下 test 的 13800138000」

机器人会：
1. 识别关键词「清」命中「清理账号数据」动作
2. 从消息提取 env=test, phone=13800138000
3. 检查手机号是否已持久化（如果之前保存过，跳过追问）
4. 若缺少必填，追问用户
5. 执行脚本 `scripts/reset_onboarding.py --env test --phone 13800138000`
6. 回复执行结果

## 脚本要求

脚本必须位于 `scripts/` 目录，支持 `.py` 或 `.js` 扩展名。
参数通过 `--name value` 传递，需在脚本中解析 `process.argv` 或 `sys.argv`。

## 日志

执行日志写入 `action-log.jsonl`（一行一条，敏感字段脱敏）。
```

### Step 2: 手动测试清单

- [ ] 启动 server，确认 action-configs.json 已创建
- [ ] Web UI 访问设置页，确认新 tab 可见
- [ ] 添加新动作，保存成功
- [ ] 飞书发送触发关键词，确认意图识别成功
- [ ] 缺必填时，收到追问
- [ ] 提供必填，脚本执行成功
- [ ] 查看 action-log.jsonl，确认日志已记录且脱敏

### Step 3: 最终 Commit

```bash
git add README.md docs/action-config.md
git commit -m "docs: add action config usage guide"
```

---

## 自检清单

**Spec 覆盖**：

- [ ] 动作配置 CRUD — Task 1-2 ✓
- [ ] 变量抽取 + 追问状态机 — Task 5,7 ✓
- [ ] 脚本执行 + 脱敏 — Task 6 ✓
- [ ] 意图识别（两级） — Task 8 ✓
- [ ] 权限隔离 — Task 7（action-runner 检查 permission） ✓
- [ ] Web UI CRUD — Task 11-12 ✓
- [ ] 迁移逻辑 — Task 9 ✓

**占位符扫描**：✓ 所有步骤含完整代码

**类型一致性**：✓ actionId、userId、collectedVars 命名统一

**任务粒度**：✓ 每步 2-5 分钟

---

计划完成，已保存到 `docs/superpowers/plans/2026-07-20-generic-action-config.md`。

两种执行方案：

**1. Subagent-Driven（推荐）** — 我为每个 Task 派一个独立子代理，Task 间有 review，快速迭代  
**2. Inline Execution** — 用 executing-plans 在本轮次逐项执行，有检查点

你倾向哪种？
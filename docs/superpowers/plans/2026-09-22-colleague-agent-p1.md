# 同事侧对话 Agent 化 · P1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建起 agent 工具注册表与对话型 agent 骨架，配 5 个只读工具和一个命令行探针，把「对话手感 / SDK 冷启延迟 / 订阅额度花销」这三个未知验证掉。

**Architecture:** 新增 `capabilities` 层两个模块 —— `agent-tools.js`（零业务语义的工具注册表，按角色过滤后组装成进程内 MCP server）和 `agent-session.js`（`query()` + `resume` 的对话型骨架）。业务工具由新插件 `colleague-agent` 在模块加载时**自注册**，不被任何人 import。P1 只接命令行探针，不接飞书入口。

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` v0.3.259（`query` / `createSdkMcpServer` / `tool`）、`zod`、`node --test`

**Spec:** `docs/superpowers/specs/2026-09-22-colleague-agent-design.md`

---

## ⚠️ 本项目约定（覆盖 writing-plans 的默认做法）

根 `CLAUDE.md`：**不自动 `git` 提交，改动留工作区，提交时机由维护者掌控。**

因此下面每个 Task 的收尾步骤是**跑测试验收**，不是 `git commit`。全部 Task 做完后由维护者自行决定提交时机与粒度。

注释与文档一律中文，解释「为什么」而非复述代码。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/capabilities/agent-tools.js` | 工具注册表：注册期校验、按角色过滤、组装进程内 MCP server。**零业务语义** |
| `src/capabilities/agent-tools.test.js` | 上者的单测 |
| `src/capabilities/agent-session.js` | 对话型 agent 骨架：`query()` + `resume`，产出回复文本、新 sessionId、工具轨迹 |
| `src/capabilities/agent-session.test.js` | 上者的单测（纯函数部分 + 注入假 `query` 的消息流解析） |
| `src/plugins/colleague-agent/index.js` | 插件装配：模块加载时注册全部工具。P1 不挂 feature（`features: []`） |
| `src/plugins/colleague-agent/prompt.js` | system prompt 组装（纯函数） |
| `src/plugins/colleague-agent/prompt.test.js` | 上者的单测 |
| `src/plugins/colleague-agent/tools/req-read.js` | 5 个 safe 工具的定义与 handler |
| `src/plugins/colleague-agent/tools/req-read.test.js` | 上者的单测（注入假 store） |
| `src/plugins/index.js` | 在 `PLUGIN_MANIFEST` 登记新插件（修改） |
| `scripts/agent-probe.mjs` | P1 联调探针：命令行跑两轮对话，打印耗时与工具轨迹 |

**P1 的 5 个 safe 工具**（spec §6）：`list_my_requirements`、`get_requirement`、`get_api_doc`、`get_dev_progress`、`read_project_code`。`get_ui_spec` 与全部 reversible / external 工具留到 P3、P4。

---

## Task 1: 工具注册表的纯逻辑（校验 + 过滤 + 全名）

> ✅ **已执行完毕（2026-09-22），两道审查均通过。** 下方代码块是执行前的原始规格，审查后有 6 处修正，**以工作区实际文件为准**：
>
> | # | 修正 | 理由 |
> |---|---|---|
> | I1 | `roles` 元素形状校验（每项须为非空字符串） | `roles:['Backend']`（大小写错）原本能注册成功却对任何角色不可见 —— 能力静悄悄不存在，全链路零信号。**只做形状校验，不 import `store/colleagues.js` 校验 ROLE 枚举**，那会给这个宣称零业务语义的模块装上业务知识 |
> | M1 | `DANGER_LEVELS` 改为冻结数组 + 内部私有 Set | 原本导出可变 `Set`，外部 `DANGER_LEVELS.add('yolo')` 后 `danger:'yolo'` 即通过校验 |
> | M2 | `SERVER` → `MCP_SERVER_NAME` | 调用点 `import { SERVER }` 读不出是什么的名字。**后续 Task 全部引用新名** |
> | M3 | `schema` 加 `Array.isArray` 排除 | `typeof [] === 'object'`，数组会一路带到 Task 2 的 `tool()` |
> | M4 | `filterToolsByRole` JSDoc 注明「只接受已校验的 def 列表」 | 它是导出的通用纯函数，喂未校验数据会抛 |
> | M5 | 补 4 条分支测试 | `def` 非对象 / `description` 空白 / `schema` 非对象 / roles 元素非法 |
>
> 明确**不改**的三处（审查认可，勿在后续 Task 中顺手"优化"）：`validateToolDef` 返回字符串而非抛错的设计、文件头三段注释、`registerAgentTool` 等三个函数的测试覆盖（归 Task 2）。

**Files:**
- Create: `src/capabilities/agent-tools.js`
- Test: `src/capabilities/agent-tools.test.js`

- [ ] **Step 1: 写失败的测试**

创建 `src/capabilities/agent-tools.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  validateToolDef,
  filterToolsByRole,
  toolFullName,
  MCP_SERVER_NAME,
  DANGER_LEVELS,
} from './agent-tools.js';

/** 造一个合法定义，各用例只改自己关心的那个字段 */
function def(patch = {}) {
  return {
    name: 'get_thing',
    description: '取一个东西',
    danger: 'safe',
    roles: ['*'],
    schema: { id: z.string() },
    handler: async () => ({ ok: true }),
    ...patch,
  };
}

test('toolFullName：拼成 MCP 全名（canUseTool 白名单要用它，写短名会静默不匹配）', () => {
  assert.equal(toolFullName('get_thing'), `mcp__${SERVER}__get_thing`);
});

test('DANGER_LEVELS：四档，缺一不可', () => {
  assert.deepEqual([...DANGER_LEVELS].sort(), ['external', 'notify', 'reversible', 'safe']);
});

test('validateToolDef：合法定义通过', () => {
  assert.equal(validateToolDef(def()), null);
});

test('validateToolDef：name 必须是 snake_case 小写标识符', () => {
  assert.match(validateToolDef(def({ name: 'GetThing' })), /name/);
  assert.match(validateToolDef(def({ name: '' })), /name/);
});

test('validateToolDef：danger 必须是四档之一', () => {
  assert.match(validateToolDef(def({ danger: 'dangerous' })), /danger/);
});

test('validateToolDef：roles 不能为空数组', () => {
  assert.match(validateToolDef(def({ roles: [] })), /roles/);
});

test('validateToolDef：handler 必须是函数', () => {
  assert.match(validateToolDef(def({ handler: null })), /handler/);
});

// —— 两条注册期不变式（spec §4.2）。它们守的是整个授权模型的地基：
// 一个声称可撤销却给不出撤销方式的工具，会让「乐观执行 + 可撤销」在这一个工具上悄悄失效。
test('不变式一：reversible 必须提供 buildUndo', () => {
  assert.match(validateToolDef(def({ danger: 'reversible' })), /buildUndo/);
  assert.equal(validateToolDef(def({ danger: 'reversible', buildUndo: () => ({ kind: 'x' }) })), null);
});

test('不变式二：external 必须提供 exposedFlag（撤不回的东西必须有硬开关能关）', () => {
  assert.match(validateToolDef(def({ danger: 'external' })), /exposedFlag/);
  assert.equal(validateToolDef(def({ danger: 'external', exposedFlag: 'agentExposed' })), null);
});

test('filterToolsByRole：* 对所有角色可见', () => {
  const list = [def({ name: 'a', roles: ['*'] })];
  assert.equal(filterToolsByRole(list, 'backend').length, 1);
  assert.equal(filterToolsByRole(list, 'qa').length, 1);
});

test('filterToolsByRole：按角色精确过滤', () => {
  const list = [def({ name: 'a', roles: ['backend'] }), def({ name: 'b', roles: ['product', 'qa'] })];
  assert.deepEqual(filterToolsByRole(list, 'backend').map((d) => d.name), ['a']);
  assert.deepEqual(filterToolsByRole(list, 'qa').map((d) => d.name), ['b']);
  assert.deepEqual(filterToolsByRole(list, 'design').map((d) => d.name), []);
});

test('filterToolsByRole：未知/空角色只看得到 * 工具（fail-closed，不外推）', () => {
  const list = [def({ name: 'a', roles: ['*'] }), def({ name: 'b', roles: ['backend'] })];
  assert.deepEqual(filterToolsByRole(list, '').map((d) => d.name), ['a']);
  assert.deepEqual(filterToolsByRole(list, undefined).map((d) => d.name), ['a']);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/capabilities/agent-tools.test.js
```

预期：FAIL，`Cannot find module './agent-tools.js'`

- [ ] **Step 3: 写最小实现**

创建 `src/capabilities/agent-tools.js`：

```js
/**
 * Agent 工具注册表 —— 对话 agent 与业务能力之间的唯一接缝。
 *
 * ## 为什么是「注册」而不是「import」
 *
 * 对话 agent（`plugins/colleague-agent`）要调 action-runner 的脚本、tracking-stats 的埋点，
 * 但分层约定明写**插件之间不互相 import**（协作走 store 或事件）。这里复用仓库已有的
 * `shared/card-actions.js#registerCardKindHandler` 范式：插件在**模块加载时**把自己的能力
 * 注册进来，agent 只从注册表取。
 *
 * 三个白拿的性质：
 *   1. 分层不倒挂 —— `plugins → capabilities` 是顺向依赖，本模块零业务语义；
 *   2. **插件停用即工具自然缺席** —— 与卡片回调完全同一语义，不需要额外写开关；
 *   3. 加能力不改 agent —— 新工具 = 在自己插件里注册一行。
 *
 * ## 四档危险级
 *
 *   safe        只读，无副作用                          —— 不写撤销台账
 *   reversible  有副作用但能撤回                        —— 必须能给出 undo 描述
 *   external    有真实外部副作用、撤不回（如退款脚本）  —— 必须有可关掉的硬开关
 *   notify      只给主机发消息                          —— 不写台账
 *
 * `external` 刻意单独立一档而不是塞进 `reversible`：「能撤」和「不能撤」是两种完全不同的
 * 风险，混在一档会让下面两条不变式失去意义。
 */

/** MCP server 名 —— 工具全名是 `mcp__<SERVER>__<tool>`，canUseTool 白名单必须用全名 */
export const SERVER = 'colleague';

export const DANGER_LEVELS = new Set(['safe', 'reversible', 'external', 'notify']);

/** 工具短名的形状：小写 snake_case。模型看到的是这个名字，保持可读且稳定 */
const NAME_RE = /^[a-z][a-z0-9_]*$/;

/** 注册表：name → def。模块级可变状态，测试用 clearAgentTools 复位 */
const registry = new Map();

/** 拼 MCP 全名（纯函数）。写短名会让 canUseTool 静默不匹配 —— 模型看得见工具、一调就被拒 */
export function toolFullName(name) {
  return `mcp__${SERVER}__${name}`;
}

/**
 * 校验工具定义（纯函数）。
 * @returns {string|null} 错误原因；null 表示合法
 */
export function validateToolDef(def) {
  if (!def || typeof def !== 'object') return 'def 必须是对象';
  if (typeof def.name !== 'string' || !NAME_RE.test(def.name)) return `name 非法（需小写 snake_case）：${def.name}`;
  if (typeof def.description !== 'string' || !def.description.trim()) return `${def.name}: description 不能为空`;
  if (!DANGER_LEVELS.has(def.danger)) return `${def.name}: danger 非法（需为 ${[...DANGER_LEVELS].join('/')}）`;
  if (!Array.isArray(def.roles) || def.roles.length === 0) return `${def.name}: roles 不能为空数组`;
  if (!def.schema || typeof def.schema !== 'object') return `${def.name}: schema 必须是 zod raw shape 对象`;
  if (typeof def.handler !== 'function') return `${def.name}: handler 必须是函数`;

  // —— 两条不变式。它们守的是「乐观执行 + 可撤销」这个授权模型的地基：
  //    注册一个声称可撤销却给不出撤销方式的工具，会让保证在这一个工具上悄悄失效，
  //    而代码看起来一切正常。所以在启动期硬抛，不靠自觉。
  if (def.danger === 'reversible' && typeof def.buildUndo !== 'function')
    return `${def.name}: danger=reversible 必须提供 buildUndo`;
  if (def.danger === 'external' && (typeof def.exposedFlag !== 'string' || !def.exposedFlag))
    return `${def.name}: danger=external 必须提供 exposedFlag（撤不回的工具必须有硬开关）`;

  return null;
}

/**
 * 按角色过滤（纯函数）。`roles` 含 `'*'` 即对所有角色可见。
 * **fail-closed**：未知 / 空角色只看得到 `'*'` 工具，绝不外推。
 */
export function filterToolsByRole(defs, role) {
  const r = typeof role === 'string' ? role : '';
  return defs.filter((d) => d.roles.includes('*') || (r && d.roles.includes(r)));
}

/** 注册一个工具（同名覆盖，便于测试注入替身）。校验不过直接抛 —— 启动期暴露，不拖到运行时 */
export function registerAgentTool(def) {
  const err = validateToolDef(def);
  if (err) throw new Error(`registerAgentTool: ${err}`);
  registry.set(def.name, def);
  return def;
}

/** 列出全部已注册工具 */
export function listAgentTools() {
  return [...registry.values()];
}

/** 清空注册表（仅测试用） */
export function clearAgentTools() {
  registry.clear();
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/capabilities/agent-tools.test.js
```

预期：PASS，12 个用例全绿

---

## Task 2: 工具注册表 → 进程内 MCP server 组装

**Files:**
- Modify: `src/capabilities/agent-tools.js`（追加 `buildAgentMcpServer`）
- Modify: `src/capabilities/agent-tools.test.js`（追加用例）

> **为什么写进同一个文件而不拆**（Task 1 代码审查的结论）：SDK 已无条件躺在每个真实进程的模块图里（`integrations/claude.js:6` 静态 import `query`，`plugins/tracking-stats/freeform.js:20` 也直接 import `tool`），拆分在生产上买不到任何东西；实测 SDK 冷启 96ms / +33MB，只有几个纯单测进程会付这个成本；`llm-sql-agent.js` 就是同一形状（工具定义 + options 组装 + runner 同居一文件），形状对齐比文件数整齐更重要。
>
> **但有一个不对称值得记**：`registerAgentTool` 会被很多插件 import，`buildAgentMcpServer` 只有一个消费者。「轻的一半多人用、重的一半一人用」是标准的拆分信号，只是眼下量级不够。
>
> **拆分触发条件**：本 Task 写完文件超过 ~200 行，或 Task 6 的工具单测因 SDK 明显变慢 → 新建 `src/capabilities/agent-mcp.js` 单向 import `agent-tools.js`，`registerAgentTool` 留在原处不动。拆线今天就是干净的，推迟无成本 —— 这个决定可逆，所以现在不拆。

- [ ] **Step 1: 写失败的测试**

把 `src/capabilities/agent-tools.test.js` 顶部**已有的那个 import 块**扩成：

```js
import {
  validateToolDef,
  filterToolsByRole,
  toolFullName,
  MCP_SERVER_NAME,
  DANGER_LEVELS,
  registerAgentTool,
  clearAgentTools,
  listAgentTools,
  buildAgentMcpServer,
} from './agent-tools.js';
```

并把 `node:test` 的 `beforeEach` 一并引入，在文件里加一条全局隔离：

```js
import { test, beforeEach } from 'node:test';

// 注册表是模块级可变状态，**必须用 beforeEach 隔离**，不能靠每个用例首尾自己调
// clearAgentTools()：断言一挂中间就把脏状态漏给下一个用例。将来 req-read.test.js
// 一旦 import 了会自注册的插件模块，注册表会在文件加载时就被污染，那时只有它救得了。
// （跨文件不用担心：node --test 每个测试文件独立进程。）
beforeEach(clearAgentTools);
```

然后在文件末尾追加（**各用例不再自己调 `clearAgentTools()`**）：

```js
test('registerAgentTool：合法定义进注册表，非法直接抛', () => {
  registerAgentTool(def({ name: 'a' }));
  assert.equal(listAgentTools().length, 1);
  assert.throws(() => registerAgentTool(def({ name: 'Bad' })), /name 非法/);
  assert.throws(() => registerAgentTool(def({ name: 'b', danger: 'reversible' })), /buildUndo/);
});

test('registerAgentTool：同名覆盖，不重复累积', () => {
  registerAgentTool(def({ name: 'a', description: '第一版' }));
  registerAgentTool(def({ name: 'a', description: '第二版' }));
  assert.equal(listAgentTools().length, 1);
  assert.equal(listAgentTools()[0].description, '第二版');
});

test('buildAgentMcpServer：allowed 从实际装配的工具算出来，不写死', async () => {
  registerAgentTool(def({ name: 'shared_tool', roles: ['*'] }));
  registerAgentTool(def({ name: 'backend_only', roles: ['backend'] }));

  const built = buildAgentMcpServer('backend');
  assert.deepEqual(
    [...built.allowed].sort(),
    [toolFullName('backend_only'), toolFullName('shared_tool')].sort(),
  );

  const qa = buildAgentMcpServer('qa');
  assert.deepEqual([...qa.allowed], [toolFullName('shared_tool')]);
});

test('buildAgentMcpServer：handler 的返回值被包成 MCP 的 content 形状', async () => {
  registerAgentTool(def({ name: 'echo', handler: async ({ id }) => ({ got: id }) }));
  const built = buildAgentMcpServer('backend');
  const out = await built.defs[0].handler({ id: 'x1' }, {});
  assert.equal(out.content[0].type, 'text');
  assert.deepEqual(JSON.parse(out.content[0].text), { got: 'x1' });
});

test('buildAgentMcpServer：handler 抛错被捕获成 {error}，不打断整轮', async () => {
  registerAgentTool(def({ name: 'boom', handler: async () => { throw new Error('炸了'); } }));
  const built = buildAgentMcpServer('backend');
  const out = await built.defs[0].handler({ id: 'x' }, {});
  assert.deepEqual(JSON.parse(out.content[0].text), { error: '炸了' });
});

test('buildAgentMcpServer：ctx 透传给 handler（colleagueId / role 等业务上下文）', async () => {
  let seen = null;
  registerAgentTool(def({ name: 'peek', handler: async (_i, ctx) => { seen = ctx; return { ok: 1 }; } }));
  const built = buildAgentMcpServer('backend', { ctx: { colleagueId: 'cl_1', role: 'backend' } });
  await built.defs[0].handler({ id: 'x' }, {});
  assert.deepEqual(seen, { colleagueId: 'cl_1', role: 'backend' });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/capabilities/agent-tools.test.js
```

预期：FAIL，`buildAgentMcpServer is not a function`

- [ ] **Step 3: 写最小实现**

在 `src/capabilities/agent-tools.js` 顶部加 import，文件末尾追加：

```js
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../shared/logger.js';
```

```js
/**
 * MCP 工具的返回形状：一律包成单个 text block。
 * handler 返回字符串则原样透传，其余 JSON 序列化 —— 别写成「内容是 JSON 字符串」，
 * 那句话会让人对字符串返回值去 JSON.parse，直接炸。
 *
 * ⚠️ text 绝不能是 undefined：JSON.stringify 对 undefined / 函数 / Symbol 返回的是
 * undefined 这个值本身，序列化后 text 字段整个消失，对端 schema 校验抛 -32602 并
 * **打断整轮对话** —— 而且这个错在客户端校验时抛，handler 早已返回，下面的 try/catch
 * 兜不住。notify 档工具（只给主机发消息）天然不 return，这条路径必然走到。
 */
function textResult(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text: text === undefined ? 'null' : text }] };
}

/**
 * 按角色装配一个进程内 MCP server。
 *
 * @param {string} role colleagues.js 的 ROLES id
 * @param {{ ctx?: object }} [opts] ctx 透传给每个 handler 的第二参（业务上下文：colleagueId/role/msgId/reqId）
 * @returns {{ server: object, allowed: Set<string>, defs: Array }}
 *   allowed：给 canUseTool 用的全名白名单
 *   defs：**单独暴露是为了可测** —— createSdkMcpServer 把工具埋进私有字段，
 *         测试去够它就把用例绑死在 SDK 内部结构上，SDK 一改版就红一片。
 */
export function buildAgentMcpServer(role, opts = {}) {
  const ctx = opts.ctx || {};
  const picked = filterToolsByRole(listAgentTools(), role);

  const defs = picked.map((d) =>
    tool(d.name, d.description, d.schema, async (input) => {
      try {
        return textResult(await d.handler(input, ctx));
      } catch (e) {
        // 工具抛错不该打断整轮对话 —— 包成 {error} 喂回模型，让它自己决定怎么跟人说
        logger.warn('agent-tools', '工具执行抛错', { tool: d.name, err: e?.message || String(e) });
        return textResult({ error: e?.message || String(e) });
      }
    }),
  );

  // 空工具集必须出声（spec §3.5）：web 进程不走插件装配层，忘了显式 import 插件时
  // 注册表恒为空 → 这里安静地造出一个零工具的 MCP server → 模型看不到工具就凭记忆作答，
  // 回复照样通顺，日志里什么都没有。这是最难往这里想的一类故障，一行 warn 的成本换它值。
  if (picked.length === 0)
    logger.warn('agent-tools', '按角色装配出零个工具（插件可能未加载，检查是否 import 了对应插件）', { role });

  const server = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '1.0.0',
    instructions: '这是团队协作环境的业务工具集。用它们查需求状态、查代码、办事，不要凭记忆回答事实性问题。',
    tools: defs,
    alwaysLoad: true,
  });

  // 白名单**从实际装配的工具算出来**，不写死常量 ——
  // 否则新注册的工具会被 canUseTool 静默拒掉：模型看得见工具、一调就被拒，
  // 日志里只有一句权限拒绝，极难往这里想（llm-sql-agent 踩过同款）。
  return { server, allowed: new Set(picked.map((d) => toolFullName(d.name))), defs };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/capabilities/agent-tools.test.js
```

预期：PASS，18 个用例全绿（Task 1 的 12 个 + 本 Task 新增 6 个）

- [ ] **Step 5: 验收**

```bash
npm test
```

预期：全绿（新模块不影响存量）

---

## Task 3: 对话 agent 的 options 组装（纯函数）

抽成纯函数只为可测 —— spec §3.1、§3.2 那两个坑都是**静默失效**型的：配错了代码照样跑，只是防线没了。这种东西必须有断言守着。

**Files:**
- Create: `src/capabilities/agent-session.js`
- Test: `src/capabilities/agent-session.test.js`

- [ ] **Step 1: 写失败的测试**

创建 `src/capabilities/agent-session.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnOptions, AGENT_TURN_TIMEOUT_MS } from './agent-session.js';

const base = () => ({
  server: { __fake: true },
  allowed: new Set(['mcp__colleague__get_thing']),
  systemPrompt: '你是助手',
});

test('buildTurnOptions：tools 必须是空数组（禁全部内置工具）', () => {
  const o = buildTurnOptions(base());
  assert.deepEqual(o.tools, []);
});

// —— 坑一（llm-sql-agent 文件头实测）：disallowedTools:['*'] 的语义是
// 「removed from the model's context, even if they would otherwise be allowed」，
// 通配符会把我们自己的 MCP 工具一起删掉，表现是工具全部 Permission denied。
test('buildTurnOptions：绝不设 disallowedTools（通配符会连 MCP 工具一起删）', () => {
  const o = buildTurnOptions(base());
  assert.equal(o.disallowedTools, undefined);
});

// —— 坑二：allowedTools 是免审批名单，设了会让 canUseTool 整个不被调用
// （SDK 打印 [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]）。本设计的危险级判定、
// 撤销台账、限流计数全挂在 canUseTool 上，设了它等于整套审计静默失效。
test('buildTurnOptions：绝不设 allowedTools（会架空 canUseTool）', () => {
  const o = buildTurnOptions(base());
  assert.equal(o.allowedTools, undefined);
});

test('buildTurnOptions：permissionMode 必须是 default（bypassPermissions 会绕过 canUseTool）', () => {
  const o = buildTurnOptions(base());
  assert.equal(o.permissionMode, 'default');
});

test('buildTurnOptions：mcpServers 按约定的 server 名挂载', () => {
  const o = buildTurnOptions(base());
  assert.deepEqual(Object.keys(o.mcpServers), ['colleague']);
});

test('buildTurnOptions：canUseTool 放行白名单内、拒绝白名单外', async () => {
  const o = buildTurnOptions(base());
  assert.deepEqual(await o.canUseTool('mcp__colleague__get_thing', { a: 1 }), {
    behavior: 'allow',
    updatedInput: { a: 1 },
  });
  const denied = await o.canUseTool('Bash', {});
  assert.equal(denied.behavior, 'deny');
});

test('buildTurnOptions：有 sessionId 才带 resume，没有则不带该键', () => {
  assert.equal(buildTurnOptions(base()).resume, undefined);
  assert.equal(buildTurnOptions({ ...base(), sessionId: 'sess_1' }).resume, 'sess_1');
});

test('buildTurnOptions：cwd / model 有才带，没有不带空值', () => {
  const o = buildTurnOptions(base());
  assert.equal(o.cwd, undefined);
  assert.equal(o.model, undefined);
  const o2 = buildTurnOptions({ ...base(), cwd: 'D:/p', model: 'claude-haiku-4-5-20251001' });
  assert.equal(o2.cwd, 'D:/p');
  assert.equal(o2.model, 'claude-haiku-4-5-20251001');
});

test('AGENT_TURN_TIMEOUT_MS：对话场景的超时预算是 2 分钟', () => {
  assert.equal(AGENT_TURN_TIMEOUT_MS, 120_000);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/capabilities/agent-session.test.js
```

预期：FAIL，`Cannot find module './agent-session.js'`

- [ ] **Step 3: 写最小实现**

创建 `src/capabilities/agent-session.js`：

```js
/**
 * 对话型 Agent 骨架 —— 与**人**多轮对话，不是跑一个任务。
 *
 * 与本层另外三个 LLM 骨架的分工：
 *   llm-classify.js       单轮零工具，出一行 JSON
 *   llm-readonly-agent.js 多轮只读**文件**，出一个 JSON 结论
 *   llm-sql-agent.js      多轮只读**数据库**，出一段分析
 *   本模块                多轮**带业务工具**、**跨消息续跑**，出一句给人看的回复
 *
 * 唯一的形态差别是 `resume`：上面三个都是一次性调用（`persistSession:false`），
 * 本模块要靠 SDK 的 session 维持「这个人跟我聊过什么」，所以**不设** persistSession。
 *
 * 本模块**不含业务语义** —— 不知道什么是需求、什么是同事，工具与提示词全由调用方注入。
 *
 * ## 两个用错就静默失效的坑（照抄 llm-sql-agent 的结论，勿改回去）
 *
 * 1. **不能用 `disallowedTools: ['*']` 收窄工具面。** 该字段语义是「removed from the
 *    model's context and cannot be used, **even if they would otherwise be allowed**」——
 *    通配符连我们自己的 MCP 工具一起删掉。实测表现为工具全部 Permission denied，
 *    而日志里只有一句含糊的权限拒绝。收窄工具面的正确字段是 `tools`。
 * 2. **不能把工具名列进 `allowedTools`。** 那是「auto-allowed without prompting」的免审批
 *    名单，**会让 `canUseTool` 整个不被调用**（SDK 打印 `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]`）。
 *    危险级判定、撤销台账、限流计数全挂在 canUseTool 上，设了它等于整套审计静默失效。
 *
 * `permissionMode` 必须是 `'default'`：`bypassPermissions` 会绕过 `canUseTool`。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeAuthOpts, getTokens, isPoolExhausted } from './token-rotation.js';
import { MCP_SERVER_NAME } from './agent-tools.js';
import { logger } from '../shared/logger.js';

/**
 * 单轮对话的超时预算。
 * 比 llm-readonly-agent 的 10 分钟短得多 —— 对面是个活人在等回复，
 * 超过两分钟这轮已经没有对话价值了，宁可落兜底让他重说一句。
 */
export const AGENT_TURN_TIMEOUT_MS = 120_000;

/**
 * 组装 `query()` 的 options —— **抽成纯函数只为可测**（文件头那两个坑都是静默失效型的）。
 *
 * @param {object} a
 * @param {object} a.server        buildAgentMcpServer 产出的 server
 * @param {Set<string>} a.allowed  全名白名单
 * @param {string} a.systemPrompt
 * @param {string} [a.sessionId]   有则 resume，维持长期 thread
 * @param {string} [a.cwd]
 * @param {string} [a.model]
 * @param {AbortController} [a.abort]
 */
export function buildTurnOptions({ server, allowed, systemPrompt, sessionId, cwd, model, abort }) {
  return {
    ...claudeAuthOpts(), // 跟随备用账号轮换，别烧主账号额度
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(sessionId ? { resume: sessionId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    permissionMode: 'default', // bypassPermissions 会绕过 canUseTool，绝不能用
    mcpServers: { [MCP_SERVER_NAME]: server },
    // 第 1 层：禁掉全部内置工具（Read/Bash/Write/…）。MCP 工具不在此列，仍可用。
    // 刻意**不用** disallowedTools:['*'] —— 那会连 MCP 工具一起删（见文件头「坑一」）。
    tools: [],
    // 第 2 层：运行时复核，每次工具调用都过。
    // 刻意**不设** allowedTools —— 设了会让本回调整个不被调用（见文件头「坑二」）。
    canUseTool: async (name, input) =>
      allowed.has(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: `本环境不提供 ${name}，请改用已有的业务工具` },
    ...(abort ? { abortController: abort } : {}),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/capabilities/agent-session.test.js
```

预期：PASS，9 个用例全绿

---

## Task 4: 跑一轮对话（消息流解析 + 失败归因）

**Files:**
- Modify: `src/capabilities/agent-session.js`（追加 `parseTurnStream` 与 `runAgentTurn`）
- Modify: `src/capabilities/agent-session.test.js`（追加用例）

`parseTurnStream` 单独抽出来，是为了能在**不碰真实 SDK** 的前提下测消息流解析 —— 这是本模块唯一有分支的逻辑。

- [ ] **Step 1: 写失败的测试**

在 `src/capabilities/agent-session.test.js` 的 import 里加 `parseTurnStream`，并在末尾追加：

```js
/** 造一个假的 SDK 消息流 */
async function* fakeStream(messages) {
  for (const m of messages) yield m;
}

test('parseTurnStream：拼接 assistant 的 text block', async () => {
  const r = await parseTurnStream(fakeStream([
    { type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '，我看一下' }] } },
  ]));
  assert.equal(r.text, '你好，我看一下');
});

test('parseTurnStream：记录 tool_use 轨迹（审计用）', async () => {
  const r = await parseTurnStream(fakeStream([
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'mcp__colleague__get_requirement', input: { reqId: 'r_1' } },
          { type: 'text', text: '查到了' },
        ],
      },
    },
  ]));
  assert.equal(r.text, '查到了');
  assert.deepEqual(r.toolTrace, [{ name: 'get_requirement', input: { reqId: 'r_1' } }]);
});

test('parseTurnStream：从 system/init 拿 sessionId', async () => {
  const r = await parseTurnStream(fakeStream([
    { type: 'system', subtype: 'init', session_id: 'sess_abc' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
  ]));
  assert.equal(r.sessionId, 'sess_abc');
});

test('parseTurnStream：result 上的 session_id 覆盖 init（以最终为准）', async () => {
  const r = await parseTurnStream(fakeStream([
    { type: 'system', subtype: 'init', session_id: 'sess_old' },
    { type: 'result', session_id: 'sess_new', result: '' },
  ]));
  assert.equal(r.sessionId, 'sess_new');
});

test('parseTurnStream：没有 assistant text 时退回 result.result', async () => {
  const r = await parseTurnStream(fakeStream([
    { type: 'result', session_id: 's1', result: '兜底文本' },
  ]));
  assert.equal(r.text, '兜底文本');
});

test('parseTurnStream：空流不抛，返回空文本', async () => {
  const r = await parseTurnStream(fakeStream([]));
  assert.equal(r.text, '');
  assert.equal(r.sessionId, null);
  assert.deepEqual(r.toolTrace, []);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/capabilities/agent-session.test.js
```

预期：FAIL，`parseTurnStream is not a function`

- [ ] **Step 3: 写实现**

在 `src/capabilities/agent-session.js` 末尾追加：

```js
/**
 * 解析 SDK 消息流（抽出来是为了能不碰真实 SDK 就测到全部分支）。
 *
 * @param {AsyncIterable} stream
 * @returns {Promise<{ text: string, sessionId: string|null, toolTrace: Array }>}
 */
export async function parseTurnStream(stream) {
  let text = '';
  let sessionId = null;
  let fallback = '';
  const toolTrace = [];
  const prefix = `mcp__${MCP_SERVER_NAME}__`;

  for await (const m of stream) {
    if (m.type === 'system' && m.subtype === 'init') {
      sessionId = m.session_id || sessionId;
    } else if (m.type === 'assistant') {
      for (const b of m.message?.content || []) {
        if (b.type === 'text') text += b.text;
        // 轨迹里存短名：给主机看的审计信息，mcp__colleague__ 前缀是噪音
        else if (b.type === 'tool_use')
          toolTrace.push({ name: String(b.name || '').replace(prefix, ''), input: b.input });
      }
    } else if (m.type === 'result') {
      // 以 result 上的为准：SDK 在压缩等场景下可能换 session
      if (m.session_id) sessionId = m.session_id;
      if (m.result) fallback = m.result;
    }
  }
  return { text: text || fallback, sessionId, toolTrace };
}

/**
 * 跑一轮对话。
 *
 * @param {object} opts
 * @param {string} opts.userText      这个人说的话
 * @param {string} opts.systemPrompt
 * @param {object} opts.server        buildAgentMcpServer 的 server
 * @param {Set<string>} opts.allowed  全名白名单
 * @param {string} [opts.sessionId]   上一轮的 session，维持长期 thread
 * @param {string} [opts.cwd]
 * @param {string} [opts.model]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.logTag]
 * @returns {Promise<{ text, sessionId, toolTrace, reason }>}
 *   reason: null=正常 / 'exhausted'=额度耗尽 / 'timeout' / 'error'
 */
export async function runAgentTurn(opts) {
  const { userText, systemPrompt, server, allowed, sessionId, cwd, model, signal, logTag = 'agent' } = opts;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : AGENT_TURN_TIMEOUT_MS;

  // 额度耗尽 fail-fast：同 llm-classify / llm-sql-agent —— 五小时限流窗口内
  // SDK 流可能永不结束，不发起注定失败的调用
  if (isPoolExhausted(getTokens())) {
    logger.warn('agent-session', 'token 池全部耗尽，跳过本轮（fail-fast）', { logTag });
    return { text: '', sessionId: sessionId || null, toolTrace: [], reason: 'exhausted' };
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const relay = () => abort.abort();
  signal?.addEventListener?.('abort', relay, { once: true });

  try {
    const q = query({
      prompt: userText,
      options: buildTurnOptions({ server, allowed, systemPrompt, sessionId, cwd, model, abort }),
    });
    const r = await parseTurnStream(q);
    logger.info('agent-session', '一轮完成', { logTag, tools: r.toolTrace.length, chars: r.text.length });
    // sessionId 可能为 null（SDK 未回 init/result）——此时保留旧值，别把已有 thread 弄丢
    return { ...r, sessionId: r.sessionId || sessionId || null, reason: abort.signal.aborted ? 'timeout' : null };
  } catch (e) {
    logger.warn('agent-session', '本轮调用异常（已落兜底）', { logTag, err: e?.message || String(e) });
    return {
      text: '',
      sessionId: sessionId || null,
      toolTrace: [],
      reason: abort.signal.aborted ? 'timeout' : 'error',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', relay);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/capabilities/agent-session.test.js
```

预期：PASS，15 个用例全绿

- [ ] **Step 5: 验收**

```bash
npm test
```

预期：全绿

---

## Task 5: system prompt 组装（纯函数）

**Files:**
- Create: `src/plugins/colleague-agent/prompt.js`
- Test: `src/plugins/colleague-agent/prompt.test.js`

- [ ] **Step 1: 写失败的测试**

创建 `src/plugins/colleague-agent/prompt.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, formatRequirementLine } from './prompt.js';

test('formatRequirementLine：带 id / 标题 / 阶段', () => {
  const line = formatRequirementLine({ id: 'r_a1', title: '订单列表改版', phase: 'dev' });
  assert.match(line, /r_a1/);
  assert.match(line, /订单列表改版/);
  assert.match(line, /开发期/);
});

test('buildSystemPrompt：写明对方是谁、什么职位', () => {
  const p = buildSystemPrompt({
    colleague: { id: 'cl_1', name: '张三' },
    roleLabel: '后端',
    requirements: [],
  });
  assert.match(p, /张三/);
  assert.match(p, /后端/);
});

test('buildSystemPrompt：列出他参与的需求，便于 agent 判归属', () => {
  const p = buildSystemPrompt({
    colleague: { id: 'cl_1', name: '张三' },
    roleLabel: '后端',
    requirements: [{ id: 'r_a1', title: '订单列表改版', phase: 'dev' }],
  });
  assert.match(p, /r_a1/);
  assert.match(p, /订单列表改版/);
});

test('buildSystemPrompt：没有需求时给出明确说明，不留空白让模型瞎编', () => {
  const p = buildSystemPrompt({ colleague: { id: 'cl_1', name: '张三' }, roleLabel: '后端', requirements: [] });
  assert.match(p, /暂时没有/);
});

// —— 这条 policy 是整个 2.0 相对旧分类器管线的核心增量：
// 没有它，agent 说「你这份文档和代码对不上」只能是瞎猜。
test('buildSystemPrompt：含「先查证再质疑」硬约束', () => {
  const p = buildSystemPrompt({ colleague: { id: 'cl_1', name: '张三' }, roleLabel: '后端', requirements: [] });
  assert.match(p, /查证/);
  assert.match(p, /read_project_code/);
});

test('buildSystemPrompt：含「不替主机做承诺」与「阶段流转不归你管」两条边界', () => {
  const p = buildSystemPrompt({ colleague: { id: 'cl_1', name: '张三' }, roleLabel: '后端', requirements: [] });
  assert.match(p, /排期|优先级|承诺/);
  assert.match(p, /阶段/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/plugins/colleague-agent/prompt.test.js
```

预期：FAIL，`Cannot find module './prompt.js'`

- [ ] **Step 3: 写实现**

创建 `src/plugins/colleague-agent/prompt.js`：

```js
/**
 * 对话 agent 的 system prompt 组装（纯函数，无 IO）。
 *
 * 抽成纯函数是因为 prompt 是本功能**唯一没有类型约束的接口** —— 改坏了不报错、
 * 只是行为悄悄变差。有单测钉住几条关键 policy，改动时至少能看见自己删掉了什么。
 */

/** 阶段 id → 中文，与需求工作流一致 */
const PHASE_LABEL = {
  review: '评审期',
  dev: '开发期',
  test: '测试期',
  archiving: '归档中',
  archived: '已归档',
  discarded: '已废弃',
};

/** 一行需求摘要（纯函数） */
export function formatRequirementLine(req) {
  return `- ${req.id}　《${req.title}》　${PHASE_LABEL[req.phase] || req.phase}`;
}

/**
 * @param {object} a
 * @param {{id:string, name:string}} a.colleague
 * @param {string} a.roleLabel  colleagues.js ROLES 的 label（后端 / 产品 / …）
 * @param {Array} a.requirements 他参与的需求（已过滤归档/废弃）
 */
export function buildSystemPrompt({ colleague, roleLabel, requirements = [] }) {
  const reqBlock = requirements.length
    ? requirements.map(formatRequirementLine).join('\n')
    : '（他暂时没有参与任何进行中的需求）';

  return `你是这个团队的 AI 开发协作助手，正在飞书上和 ${colleague.name}（${roleLabel}）私聊。

## 他参与的需求

${reqBlock}

## 你要做的事

听懂他说的事，判断它属于哪个需求，然后用工具把事办了，或者把话问清楚。
你**不是**一个转发器 —— 不要只回「已收到，会转达」。能自己查清楚的就查，能自己办的就办。

## 硬约束

1. **先查证，再质疑。** 觉得他给的信息有问题（接口文档和现有代码对不上、字段名不一致、
   描述的行为和实现不符），必须先用 \`read_project_code\` / \`get_api_doc\` / \`get_requirement\`
   查出依据，再把依据摆给他看。拿不出依据就不要质疑，改成提问。
2. **不确定就问，不要猜着办。** 尤其是「他说的是哪个需求」这件事 —— 判不准就直接问他。
3. **不替主机做承诺。** 排期、优先级、这个需求接不接、什么时候上线，一律不表态，
   只说「我同步给主机」。
4. **需求阶段流转不归你管。** 进测试、归档、废弃这些是主机的管理决策，你不要做，
   也不要暗示你能做。他要推进阶段，你只能记下来并告诉他会同步。
5. **事实性问题一律用工具查**，不要凭上下文记忆回答需求状态、代码现状、文档内容。

## 说话方式

像一个熟悉这个项目的同事，简短、直接、口语。不用列清单、不用标题、不用 markdown 强调。
一次说清一件事。`;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/plugins/colleague-agent/prompt.test.js
```

预期：PASS，6 个用例全绿

---

## Task 6: 5 个 safe 工具

**Files:**
- Create: `src/plugins/colleague-agent/tools/req-read.js`
- Test: `src/plugins/colleague-agent/tools/req-read.test.js`

工具的 handler 拆成**可注入依赖的纯逻辑**（`buildReqReadTools(deps)`），这样单测不用碰真实盘上的 `requirements.json`。

- [ ] **Step 1: 写失败的测试**

创建 `src/plugins/colleague-agent/tools/req-read.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReqReadTools, pickProjectDir, REQ_READ_TOOL_NAMES } from './req-read.js';

const REQS = [
  { id: 'r_a1', title: '订单列表改版', phase: 'dev', assignees: ['cl_1'],
    projects: { frontend: { dir: 'D:/fe' }, backend: { dir: 'D:/be' } },
    apiDocs: [{ id: 'd1', name: 'order.md', path: 'D:/u/order.md', updatedAt: '2026-09-20T00:00:00Z' }],
    history: [{ at: '2026-09-20T00:00:00Z', event: '定稿' }],
    sessions: [{ convId: 'c1', title: '主会话', kind: 'main', phase: 'dev' }] },
  { id: 'r_b2', title: '优惠券', phase: 'archived', assignees: ['cl_1'], projects: {}, apiDocs: [], history: [], sessions: [] },
  { id: 'r_c3', title: '别人的需求', phase: 'dev', assignees: ['cl_9'], projects: {}, apiDocs: [], history: [], sessions: [] },
];

function deps(extra = {}) {
  return {
    getRequirements: () => REQS,
    getRequirement: (id) => REQS.find((r) => r.id === id) || null,
    runReadonlyAgent: async () => ({ data: { answer: '代码里是 camelCase' }, reason: null, denied: [] }),
    ...extra,
  };
}

/** 从装配结果里按名字取一个工具定义 */
function pick(tools, name) {
  const t = tools.find((d) => d.name === name);
  assert.ok(t, `未装配工具 ${name}`);
  return t;
}

test('REQ_READ_TOOL_NAMES：P1 恰好 5 个 safe 工具，且与实际装配一一对应（防漏装）', () => {
  assert.deepEqual(REQ_READ_TOOL_NAMES, [
    'list_my_requirements', 'get_requirement', 'get_api_doc', 'get_dev_progress', 'read_project_code',
  ]);
  // 常量与实际装配必须同步 —— 只钉常量的话，handler 漏写一个测试照样绿
  assert.deepEqual(buildReqReadTools(deps()).map((t) => t.name), REQ_READ_TOOL_NAMES);
});

test('全部工具 danger 都是 safe（P1 不含任何写操作）', () => {
  for (const t of buildReqReadTools(deps())) assert.equal(t.danger, 'safe', t.name);
});

test('list_my_requirements：只返回他参与的、且未归档未废弃的', async () => {
  const t = pick(buildReqReadTools(deps()), 'list_my_requirements');
  const out = await t.handler({}, { colleagueId: 'cl_1' });
  assert.deepEqual(out.requirements.map((r) => r.id), ['r_a1']);
});

test('list_my_requirements：没有 colleagueId 时返回空而不是全部（fail-closed）', async () => {
  const t = pick(buildReqReadTools(deps()), 'list_my_requirements');
  assert.deepEqual((await t.handler({}, {})).requirements, []);
});

test('get_requirement：只返回摘要字段，不把整条记录倒给模型', async () => {
  const t = pick(buildReqReadTools(deps()), 'get_requirement');
  const out = await t.handler({ reqId: 'r_a1' }, { colleagueId: 'cl_1' });
  assert.equal(out.id, 'r_a1');
  assert.equal(out.title, '订单列表改版');
  assert.equal(out.phase, 'dev');
  assert.equal(out.apiDocCount, 1);
  assert.equal(out.busy, undefined, '内部字段不得外泄');
});

test('get_requirement：非参与人查不到（fail-closed，不泄露他人需求）', async () => {
  const t = pick(buildReqReadTools(deps()), 'get_requirement');
  const out = await t.handler({ reqId: 'r_c3' }, { colleagueId: 'cl_1' });
  assert.match(out.error, /没有|无权|找不到/);
});

test('get_requirement：id 不存在时给明确错误，不抛', async () => {
  const t = pick(buildReqReadTools(deps()), 'get_requirement');
  const out = await t.handler({ reqId: 'r_nope' }, { colleagueId: 'cl_1' });
  assert.ok(out.error);
});

test('get_api_doc：列出该需求的接口文档', async () => {
  const t = pick(buildReqReadTools(deps()), 'get_api_doc');
  const out = await t.handler({ reqId: 'r_a1' }, { colleagueId: 'cl_1' });
  assert.deepEqual(out.docs.map((d) => d.name), ['order.md']);
  assert.equal(out.docs[0].path, undefined, '落盘绝对路径不给模型');
});

test('get_dev_progress：返回历史与会话摘要', async () => {
  const t = pick(buildReqReadTools(deps()), 'get_dev_progress');
  const out = await t.handler({ reqId: 'r_a1' }, { colleagueId: 'cl_1' });
  assert.equal(out.phase, 'dev');
  assert.equal(out.sessionCount, 1);
  assert.equal(out.history.length, 1);
});

test('pickProjectDir：前端优先，缺则后端，都缺返回空串', () => {
  assert.equal(pickProjectDir({ frontend: { dir: 'D:/fe' }, backend: { dir: 'D:/be' } }), 'D:/fe');
  assert.equal(pickProjectDir({ frontend: null, backend: { dir: 'D:/be' } }), 'D:/be');
  assert.equal(pickProjectDir({}), '');
  assert.equal(pickProjectDir(null), '');
});

test('read_project_code：把问题交给只读 agent，返回它的 answer', async () => {
  const t = pick(buildReqReadTools(deps()), 'read_project_code');
  const out = await t.handler({ reqId: 'r_a1', question: '字段命名是什么风格' }, { colleagueId: 'cl_1' });
  assert.equal(out.answer, '代码里是 camelCase');
});

test('read_project_code：只读 agent 失败时给出可读原因，不抛', async () => {
  const d = deps({ runReadonlyAgent: async () => ({ data: null, reason: 'timeout', denied: [] }) });
  const t = pick(buildReqReadTools(d), 'read_project_code');
  const out = await t.handler({ reqId: 'r_a1', question: 'x' }, { colleagueId: 'cl_1' });
  assert.match(out.error, /timeout/);
});

test('read_project_code：需求没配工程目录时明确报错', async () => {
  const t = pick(buildReqReadTools(deps()), 'read_project_code');
  const out = await t.handler({ reqId: 'r_b2', question: 'x' }, { colleagueId: 'cl_1' });
  assert.match(out.error, /工程目录/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/plugins/colleague-agent/tools/req-read.test.js
```

预期：FAIL，`Cannot find module './req-read.js'`

- [ ] **Step 3: 写实现**

创建 `src/plugins/colleague-agent/tools/req-read.js`：

```js
/**
 * P1 的 5 个 safe 工具 —— agent 的「眼睛」。
 *
 * 三条贯穿全文件的纪律：
 *
 * 1. **fail-closed 的可见性**：每个工具都用 ctx.colleagueId 校验「这个需求他参不参与」。
 *    缺 colleagueId 一律当作看不见，绝不外推成「全部可见」。agent 面对的是公司同事，
 *    不是主机，需求内容不该跨人泄露。
 * 2. **不把整条记录倒给模型**：`requirements.json` 的一条记录含 busy / devSession /
 *    docSession / bitable 等一堆内部字段，倒给模型既浪费 token 又泄露实现细节。
 *    每个工具只挑它该给的字段。
 * 3. **不给落盘绝对路径**：文档的 `path` 是主机磁盘上的真实路径，模型没有用它的工具
 *    （内置工具全禁了），给了只会诱导它编造「我去读一下」这种做不到的动作。
 *
 * 依赖注入（`buildReqReadTools(deps)`）是为了单测不碰真实盘。
 */
import { z } from 'zod';
import { getRequirements as realGetRequirements, getRequirement as realGetRequirement } from '../../../store/requirements.js';
import { runReadonlyAgent as realRunReadonlyAgent } from '../../../capabilities/llm-readonly-agent.js';

/** P1 装配的工具名清单（顺序即注册顺序，测试钉住它防漏装） */
export const REQ_READ_TOOL_NAMES = [
  'list_my_requirements', 'get_requirement', 'get_api_doc', 'get_dev_progress', 'read_project_code',
];

/** 归档与废弃的需求不进 agent 视野 —— 它们已经不是「进行中的事」 */
const DEAD_PHASES = new Set(['archived', 'discarded']);

/** 取工程目录：前端优先，缺则后端（与 addNewSession 同一取法） */
export function pickProjectDir(projects) {
  return projects?.frontend?.dir || projects?.backend?.dir || '';
}

/** 他参不参与这个需求 */
function visible(req, colleagueId) {
  return !!req && !!colleagueId && (req.assignees || []).includes(colleagueId);
}

/**
 * 取一个他可见的需求，取不到返回 { error }。
 * 「不存在」与「无权」刻意用同一条文案 —— 分开说等于告诉他有这么个需求存在。
 */
function resolveVisible(getRequirement, reqId, colleagueId) {
  const req = getRequirement(reqId);
  if (!visible(req, colleagueId)) return { error: `找不到需求 ${reqId}，或者你没有参与它` };
  return { req };
}

export function buildReqReadTools(deps = {}) {
  const getRequirements = deps.getRequirements || realGetRequirements;
  const getRequirement = deps.getRequirement || realGetRequirement;
  const runReadonlyAgent = deps.runReadonlyAgent || realRunReadonlyAgent;

  return [
    {
      name: 'list_my_requirements',
      description: '列出这位同事当前参与的全部进行中需求（含 id、标题、阶段）。判断他说的是哪个需求时先用它。',
      danger: 'safe',
      roles: ['*'],
      schema: {},
      handler: async (_input, ctx) => {
        const id = ctx?.colleagueId;
        if (!id) return { requirements: [] };
        return {
          requirements: getRequirements()
            .filter((r) => !DEAD_PHASES.has(r.phase) && (r.assignees || []).includes(id))
            .map((r) => ({ id: r.id, title: r.title, phase: r.phase })),
        };
      },
    },

    {
      name: 'get_requirement',
      description: '查一个需求的概况：标题、阶段、有几份接口文档、配了哪些工程。需要知道需求现状时用它，不要凭记忆回答。',
      danger: 'safe',
      roles: ['*'],
      schema: { reqId: z.string().describe('需求 id，形如 r_xxxx') },
      handler: async ({ reqId }, ctx) => {
        const r = resolveVisible(getRequirement, reqId, ctx?.colleagueId);
        if (r.error) return r;
        const req = r.req;
        return {
          id: req.id,
          title: req.title,
          phase: req.phase,
          apiDocCount: (req.apiDocs || []).length,
          hasFrontend: !!req.projects?.frontend?.dir,
          hasBackend: !!req.projects?.backend?.dir,
          changeCount: (req.changes || []).length,
          updatedAt: req.updatedAt,
        };
      },
    },

    {
      name: 'get_api_doc',
      description: '列出某个需求已登记的接口文档（名字与更新时间）。确认「这份文档是不是已经给过了」时用它。',
      danger: 'safe',
      roles: ['*'],
      schema: { reqId: z.string().describe('需求 id') },
      handler: async ({ reqId }, ctx) => {
        const r = resolveVisible(getRequirement, reqId, ctx?.colleagueId);
        if (r.error) return r;
        // 刻意不给 path：那是主机磁盘的绝对路径，模型没有读它的工具
        return { docs: (r.req.apiDocs || []).map((d) => ({ name: d.name, updatedAt: d.updatedAt })) };
      },
    },

    {
      name: 'get_dev_progress',
      description: '查一个需求的开发进展：当前阶段、开了几个会话、最近发生了什么。对方问「做到哪了」时用它。',
      danger: 'safe',
      roles: ['*'],
      schema: { reqId: z.string().describe('需求 id') },
      handler: async ({ reqId }, ctx) => {
        const r = resolveVisible(getRequirement, reqId, ctx?.colleagueId);
        if (r.error) return r;
        const req = r.req;
        return {
          phase: req.phase,
          sessionCount: (req.sessions || []).length,
          // 只给最近 10 条：history 会长到几百条，全倒进去挤掉真正有用的上下文
          history: (req.history || []).slice(-10).map((h) => ({ at: h.at, event: h.event })),
        };
      },
    },

    {
      name: 'read_project_code',
      description:
        '让一个只读助手去项目代码里查一件事，返回结论。' +
        '**要质疑对方给的信息之前必须先用它拿到依据**（比如接口文档写的字段和前端实际调用对不对得上）。' +
        '一次问一个具体问题，不要问「看看代码」这种没有答案的问题。',
      danger: 'safe',
      roles: ['*'],
      schema: {
        reqId: z.string().describe('需求 id，用来定位要查哪个工程'),
        question: z.string().describe('一个具体问题，例如「前端调用 /api/order/list 时传了哪些参数」'),
      },
      handler: async ({ reqId, question }, ctx) => {
        const r = resolveVisible(getRequirement, reqId, ctx?.colleagueId);
        if (r.error) return r;
        const cwd = pickProjectDir(r.req.projects);
        if (!cwd) return { error: `需求 ${reqId} 还没有配置工程目录，查不了代码` };

        const out = await runReadonlyAgent({
          prompt:
            `在当前项目里查清这个问题，然后只输出 JSON：{"answer": "结论（≤300字，说清依据在哪个文件）"}\n\n` +
            `问题：${question}`,
          cwd,
          logTag: 'colleague-agent/read-code',
          requireKeys: ['answer'],
        });
        if (!out.data?.answer) return { error: `查代码没得到结论（${out.reason || 'unknown'}）` };
        return { answer: out.data.answer };
      },
    },
  ];
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/plugins/colleague-agent/tools/req-read.test.js
```

预期：PASS，13 个用例全绿

---

## Task 7: 插件装配与登记

**Files:**
- Create: `src/plugins/colleague-agent/index.js`
- Modify: `src/plugins/index.js`

- [ ] **Step 1: 先读现有清单，确认登记写法**

```bash
node --test src/plugins/index.test.js
```

预期：PASS（存量基线）。然后打开 `src/plugins/index.js`，找到 `PLUGIN_MANIFEST` 数组。

- [ ] **Step 2: 写插件装配**

创建 `src/plugins/colleague-agent/index.js`：

```js
/**
 * 同事侧对话 Agent 插件。
 *
 * **P1 只做工具注册，不挂 feature** —— 飞书入口的接管在 P2。
 * `features: []` 是合法的：装配层只是把条目摊平（`out.push(...mod.features)`），
 * 空数组等于不参与 dispatch 路由。
 *
 * 工具在**模块加载时**注册（与 `shared/card-actions.js` 的卡片回调同一范式）：
 * 插件停用 → 本文件不被 import → 工具自然缺席，不需要额外写开关。
 *
 * ⚠️ web 进程不走插件装配层（spec §3.5），必须显式 import 本文件才会注册。P2 的必做项。
 */
import { registerAgentTool } from '../../capabilities/agent-tools.js';
import { ROLES } from '../../store/colleagues.js';
import { buildReqReadTools } from './tools/req-read.js';

const ROLE_IDS = new Set(ROLES.map((r) => r.id));

/**
 * 角色名的**语义**校验 —— 注册表那层只校验形状（非空字符串），拼错的角色名（如 'Backend'）
 * 形状合法、挡不住：注册成功，但 filterToolsByRole 对任何角色都过滤掉它 ——
 * 能力消失且全链路零信号。这里是唯一能合法 import ROLES 的地方（业务层），
 * 所以这道闸必须在这里。启动期硬抛，不拖到运行时。
 */
function assertRoles(def) {
  const bad = def.roles.filter((r) => r !== '*' && !ROLE_IDS.has(r));
  if (bad.length)
    throw new Error(
      `colleague-agent: 工具 ${def.name} 的 roles 含非法角色 id：${bad.join(', ')}（合法值：*, ${[...ROLE_IDS].join(', ')}）`,
    );
}

for (const def of buildReqReadTools()) {
  assertRoles(def);
  registerAgentTool(def);
}

export default { id: 'colleague-agent', features: [] };
```

- [ ] **Step 3: 在 PLUGIN_MANIFEST 登记**

在 `src/plugins/index.js` 的 `PLUGIN_MANIFEST` 数组里，**紧跟 `colleague-relay` 那条之后**追加（P2 会把 `colleague-relay` 整条摘掉）：

```js
  {
    id: 'colleague-agent',
    description: '同事侧对话 Agent：按职位装配业务工具，与公司成员多轮对话（P1 仅注册只读工具，不接入口）',
    load: () => import('./colleague-agent/index.js'),
  },
```

装配层 `loadEnabledPluginFeatures` 里是 `out.push(...mod.features)`，`features: []` 展开为零项，不会影响 dispatch 的 feature 列表 —— 这正是 P1 「只注册工具、不参与路由」能成立的原因。

- [ ] **Step 4: 验证注册真的发生了，且 MCP server 能装起来**

```bash
node -e "import('./src/plugins/colleague-agent/index.js').then(async()=>{const m=await import('./src/capabilities/agent-tools.js');console.log('registered:',m.listAgentTools().map(t=>t.name));const b=m.buildAgentMcpServer('backend',{ctx:{colleagueId:'cl_x',role:'backend'}});console.log('allowed:',[...b.allowed]);})"
```

预期输出：
```
registered: [ 'list_my_requirements', 'get_requirement', 'get_api_doc', 'get_dev_progress', 'read_project_code' ]
allowed: [ 'mcp__colleague__list_my_requirements', ... 共 5 条 ]
```

这一步是**真的调 `tool()` 与 `createSdkMcpServer()`**，会当场暴露 zod shape 的问题。

> 空 shape `{}`（`list_my_requirements` 这种无参数工具）已在 SDK v0.3.259 上实测可用，无需占位参数 —— 2026-09-22 验证：`tool('no_args','无参数工具',{},handler)` + `createSdkMcpServer` 组装成功。

- [ ] **Step 5: 验收**

```bash
npm test
```

预期：全绿（含 `src/plugins/index.test.js` 的装配测试）

---

## Task 8: 命令行探针 —— P1 的验证目标在这里兑现

**Files:**
- Create: `scripts/agent-probe.mjs`

这个脚本是 P1 存在的理由：把「对话手感 / SDK 冷启延迟 / 额度花销」三个未知测出来。

- [ ] **Step 1: 写探针**

创建 `scripts/agent-probe.mjs`：

```js
/**
 * P1 联调探针 —— 不接飞书，命令行直接跑对话 agent。
 *
 * 用法（二选一）：
 *   # A. 用名册里的真实同事（能查到他被指派的需求）
 *   node scripts/agent-probe.mjs --colleague cl_xxx --text "订单接口我改了返回结构"
 *
 *   # B. 临时身份，不需要名册（干净机器上也能跑）
 *   node scripts/agent-probe.mjs --role backend --text "我现在参与哪几个需求？"
 *
 *   # 两轮，验证 resume
 *   node scripts/agent-probe.mjs --role backend --text "记住我最喜欢蓝色" --text2 "我最喜欢什么颜色？"
 *
 * **为什么要有临时身份模式**：P1 的三个验收目标（单轮延迟、含工具延迟、resume 是否生效）
 * 都不依赖真实名册数据 —— 工具返回空列表照样能测出「模型有没有去调工具」和「续跑记不记得」。
 * 若没有这个模式，探针要求先在 web 端配同事 + 建需求 + 指派，等于在干净机器上不可用，
 * 而 P1 的全部意义就是**尽早**把延迟与额度成本测出来。临时身份的 colleagueId 用一个
 * 不存在的值，工具的 fail-closed 可见性校验会让它查不到任何需求 —— 这正是我们要的隔离。
 *
 * `--text2` 用第一轮返回的 sessionId 续跑 —— 这是**验证 resume 真的生效**的唯一手段：
 * 第二轮若对第一轮内容一无所知，说明长期 thread 没建起来，P2 之后全盘作废。
 *
 * 打印：每轮耗时、回复文本、工具调用轨迹。
 */
import '../src/plugins/colleague-agent/index.js'; // 副作用：注册工具
import { buildAgentMcpServer } from '../src/capabilities/agent-tools.js';
import { runAgentTurn } from '../src/capabilities/agent-session.js';
import { buildSystemPrompt } from '../src/plugins/colleague-agent/prompt.js';
import { getColleague, ROLES } from '../src/store/colleagues.js';
import { getRequirements } from '../src/store/requirements.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : '';
}

const text = arg('text');
const text2 = arg('text2');

if (!text) {
  console.error('用法：');
  console.error('  A. 名册内同事：node scripts/agent-probe.mjs --colleague <同事id> --text "<话>" [--text2 "<第二句>"]');
  console.error('  B. 临时身份：  node scripts/agent-probe.mjs --role backend --text "<话>" [--text2 "<第二句>"]');
  console.error(`  可用 role：${ROLES.map((r) => r.id).join(', ')}`);
  process.exit(1);
}

// 两种身份来源：名册内真实同事，或临时身份（干净机器上也能跑，见文件头）
let colleague;
if (arg('colleague')) {
  colleague = getColleague(arg('colleague'));
  if (!colleague) {
    console.error(`名册里没有 ${arg('colleague')}。可用同事：`);
    const { getColleagues } = await import('../src/store/colleagues.js');
    const all = getColleagues();
    if (!all.length) console.error('  （名册为空 —— 改用 --role <角色> 跑临时身份模式）');
    for (const c of all) console.error(`  ${c.id}  ${c.name}  ${c.role}`);
    process.exit(1);
  }
} else {
  const role = arg('role');
  if (!ROLES.some((r) => r.id === role)) {
    console.error(`--role 非法：${role || '(空)'}。合法值：${ROLES.map((r) => r.id).join(', ')}`);
    process.exit(1);
  }
  // id 刻意用一个不存在于名册的值：工具的 fail-closed 可见性校验会让它查不到任何需求，
  // 这正是临时身份要的隔离 —— 绝不让探针误读到真实同事的数据。
  colleague = { id: '__probe__', name: arg('name') || '探针同事', role };
  console.log('（临时身份模式：不读名册，查不到任何需求属预期）');
}

const colleagueId = colleague.id;
const roleLabel = ROLES.find((r) => r.id === colleague.role)?.label || colleague.role || '未知职位';
const requirements = getRequirements()
  .filter((r) => !['archived', 'discarded'].includes(r.phase) && (r.assignees || []).includes(colleagueId))
  .map((r) => ({ id: r.id, title: r.title, phase: r.phase }));

const systemPrompt = buildSystemPrompt({ colleague, roleLabel, requirements });
const { server, allowed, defs } = buildAgentMcpServer(colleague.role, { ctx: { colleagueId, role: colleague.role } });

console.log('─'.repeat(60));
console.log(`同事：${colleague.name}（${roleLabel}）`);
console.log(`可见需求：${requirements.length} 个`);
console.log(`装配工具：${defs.map((d) => d.name).join(', ')}`);
console.log('─'.repeat(60));

async function turn(label, userText, sessionId) {
  console.log(`\n【${label}】${userText}`);
  const t0 = Date.now();
  const r = await runAgentTurn({ userText, systemPrompt, server, allowed, sessionId, logTag: 'probe' });
  const ms = Date.now() - t0;
  console.log(`耗时：${(ms / 1000).toFixed(1)}s　　工具调用：${r.toolTrace.length} 次　　结果：${r.reason || 'ok'}`);
  for (const t of r.toolTrace) console.log(`  ↳ ${t.name}(${JSON.stringify(t.input)})`);
  console.log(`回复：${r.text || '（空）'}`);
  return r;
}

const r1 = await turn('第 1 轮', text, undefined);
if (text2) {
  if (!r1.sessionId) console.warn('\n⚠️ 第 1 轮没拿到 sessionId，第 2 轮将是全新上下文（resume 未生效）');
  await turn('第 2 轮（resume）', text2, r1.sessionId);
}
```

- [ ] **Step 2: 语法自检**

```bash
node --check scripts/agent-probe.mjs
```

预期：无输出（通过）

- [ ] **Step 3: 量单轮延迟（临时身份即可，不需要任何数据）**

```bash
node scripts/agent-probe.mjs --role backend --text "你好，你能帮我做什么？"
```

预期：回复一段自我说明，工具调用 0 次。**记录耗时** = 「单轮耗时（无工具调用）」。

- [ ] **Step 4: 量含工具调用的延迟**

```bash
node scripts/agent-probe.mjs --role backend --text "我现在参与哪几个需求？"
```

预期：
- 打印出装配的 5 个工具
- 工具轨迹里出现 `list_my_requirements`
- 回复说「你暂时没有参与任何需求」（临时身份查不到，属预期）
- **记录耗时** = 「单轮耗时（含工具调用）」

⚠️ 若工具轨迹为空、模型却直接回答了 —— 说明它在凭记忆瞎答，system prompt 的「事实性问题一律用工具查」没生效，要回 Task 5 调 prompt。

- [ ] **Step 5: 验证 resume 真的生效（P1 的生死线）**

```bash
node scripts/agent-probe.mjs --role backend --text "记住一件事：我最喜欢的颜色是蓝色" --text2 "我最喜欢什么颜色？"
```

预期：第 2 轮答出「蓝色」。答不出 → `resume` 没生效，**立刻停止，回到 Task 3 排查 `buildTurnOptions` 的 resume 传参**，不要继续 P2。

- [ ] **Step 6（可选，需真实数据）: 验证「先查证再质疑」policy**

需要名册里有同事、且被指派到一个配了工程目录的需求上（web 设置页「同事设置」+ 需求「开发人员」）。

```bash
node scripts/agent-probe.mjs --colleague cl_xxx --text "前端那个订单列表是不是还在用老的分页参数？"
```

预期：工具轨迹里出现 `read_project_code`，回复带出具体文件/依据，而不是含糊其辞。

这条不阻塞 P1 验收 —— 它验的是 prompt 质量，不是技术通路可行性。

- [x] **Step 7: 记录 P1 验收数据**（2026-09-22 实测完成）

Claude Agent SDK + 进程内 MCP，临时身份模式，各 4 个样本：

| 指标 | 阈值 | 实测 | 判定 |
|---|---|---|---|
| 单轮耗时（无工具） | ≤ 6s | 6.5 / 6.5 / 6.8 / 7.3 s，中位 **6.7s** | ⚠️ 稳定超 ~0.8s |
| 单轮耗时（含 1 次工具） | ≤ 20s | 9.4 / 9.7 / 10.1 / 10.1 s，中位 **9.9s** | ✅ 余量充足 |
| resume 是否生效 | 必须 | **生效**（第 2 轮零工具答对「蓝色」，耗时反而更短，证明是靠 session 记忆而非重新查询） | ✅ |

**结论：P1 通过，可以开 P2。** 理由见下面两条。

### 一个反直觉的发现：「零工具」基线在真实场景里不存在

模型倾向「能查就查」—— 一句「你好，你能帮我做什么？」它也先调了 `list_my_requirements` 探底（17.0s）。只有纯寒暄（「辛苦了」）才真的零工具。

这说明**我定的 6s 阈值本身选错了对象**：真实对话里几乎每一轮都会带至少一次工具调用，所以**操作性指标是 ~10s 那个数，不是 ~6.7s 那个**。6.7s 超标 0.8s 不构成回炉理由 —— 它测的是一个在生产中几乎不出现的场景。

而这个「偏爱调工具」的倾向本身是**好事**：它正是 system prompt 里「事实性问题一律用工具查」生效的证据，没有出现凭记忆瞎答的倾向。代价是每轮延迟里几乎总含一次工具往返。

### ~10s 对飞书场景是否可接受

可接受。飞书是异步工作沟通，同事发完消息不会盯着输入指示器等秒回；对比现状（四期分类器管线也要一次 Haiku 调用 + 一次 ACK），体感差距不大，而换来的是能追问、能查证、能反驳。

如果后续实测抖动失败率偏高，spec §8.1 记了两条备选（给 `runClaude` 加 `mcpServers` 透传 / 本层自补重试），**依据实测数据再决定，不提前做**。

### 主观手感（探针执行者的判断，我复核认同）

语气口语、直接，没有列表/标题这类 AI 腔；三轮回复都紧扣角色设定（不表态排期优先级、主动说「同步给主机」）；没有虚构需求内容；轻微话痨但内容相关。

---

## P1 完成标准

- [ ] `npm test` 全绿
- [ ] `node scripts/agent-probe.mjs` 能跑通单轮对话，且 agent 真的调了工具（不是凭记忆瞎答）
- [ ] resume 验证通过（第 2 轮记得第 1 轮）
- [ ] 三个验收数据已记录
- [ ] 改动全部留在工作区，未提交（提交时机由维护者掌控）

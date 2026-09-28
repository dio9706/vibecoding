import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
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

// 注册表是模块级可变状态，**必须用 beforeEach 隔离**，不能靠每个用例首尾自己调
// clearAgentTools()：断言一挂中间就把脏状态漏给下一个用例。将来 req-read.test.js
// 一旦 import 了会自注册的插件模块，注册表会在文件加载时就被污染，那时只有它救得了。
// （跨文件不用担心：node --test 每个测试文件独立进程。）
beforeEach(clearAgentTools);

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
  assert.equal(toolFullName('get_thing'), `mcp__${MCP_SERVER_NAME}__get_thing`);
});

test('DANGER_LEVELS：四档，缺一不可', () => {
  assert.deepEqual([...DANGER_LEVELS].sort(), ['external', 'notify', 'reversible', 'safe']);
});

test('validateToolDef：合法定义通过', () => {
  assert.equal(validateToolDef(def()), null);
});

test('validateToolDef：def 非对象（null / 数组 / 原始值）', () => {
  assert.match(validateToolDef(null), /def/);
  assert.match(validateToolDef('x'), /def/);
});

test('validateToolDef：name 必须是 snake_case 小写标识符', () => {
  assert.match(validateToolDef(def({ name: 'GetThing' })), /name/);
  assert.match(validateToolDef(def({ name: '' })), /name/);
});

test('validateToolDef：description 为空白字符串（纯空格/纯换行）视同未填', () => {
  assert.match(validateToolDef(def({ description: '   ' })), /description/);
});

test('validateToolDef：danger 必须是四档之一', () => {
  assert.match(validateToolDef(def({ danger: 'dangerous' })), /danger/);
});

test('validateToolDef：roles 不能为空数组', () => {
  assert.match(validateToolDef(def({ roles: [] })), /roles/);
});

test('validateToolDef：roles 元素必须是非空字符串（null/空串不能静默注册成功）', () => {
  assert.match(validateToolDef(def({ roles: [null] })), /roles/);
  assert.match(validateToolDef(def({ roles: [''] })), /roles/);
  assert.match(validateToolDef(def({ roles: ['*', 42] })), /roles/); // 混入非字符串同样要拦
  // 'Backend' 大小写不对但形状合法（非空字符串）—— 本层只做形状校验，
  // 是否为合法 ROLE id 是业务语义，留给注册方（colleague-agent 插件）在注册前自查。
  assert.equal(validateToolDef(def({ roles: ['Backend'] })), null);
});

test('validateToolDef：schema 必须是对象（数组不是合法的 zod raw shape）', () => {
  assert.match(validateToolDef(def({ schema: null })), /schema/);
  assert.match(validateToolDef(def({ schema: [] })), /schema/);
});

test('validateToolDef：handler 必须是函数', () => {
  assert.match(validateToolDef(def({ handler: null })), /handler/);
});

// —— 两条注册期不变式。它们守的是整个授权模型的地基：
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
  assert.match(JSON.parse(out.content[0].text).error, /boom/);
});

// —— 这个 agent 的对话对象是公司同事，不是主机。异常原文里常有绝对路径、
// 数据目录结构、id 命名规则，对模型毫无用处，对同事是信息泄露。
test('buildAgentMcpServer：抛错详情不喂回模型（防把内部路径讲给同事）', async () => {
  const leak = "ENOENT: no such file or directory, open 'C:\\\\Users\\\\DELL\\\\data\\\\requirements\\\\r_x.json'";
  registerAgentTool(def({ name: 'leaky', handler: async () => { throw new Error(leak); } }));
  const out = await buildAgentMcpServer('backend').defs[0].handler({ id: 'x' }, {});
  const text = out.content[0].text;
  assert.doesNotMatch(text, /ENOENT/);
  assert.doesNotMatch(text, /Users/);
  assert.doesNotMatch(text, /requirements/);
});

// —— ctx 装的是身份与授权上下文，且同一个对象被闭包进所有 handler。
// 不冻结的话一个工具能改掉 ctx.role 给自己提权，还会串给其他工具和调用方。
test('buildAgentMcpServer：ctx 被冻结，工具改不动（防提权与串味）', async () => {
  const caller = { colleagueId: 'cl_1', role: 'backend' };
  let seen = null;
  registerAgentTool(def({
    name: 'writer',
    handler: async (_i, ctx) => {
      try { ctx.role = 'owner'; } catch { /* 严格模式下冻结对象赋值会抛，吞掉即可 */ }
      seen = { ...ctx };
      return { ok: 1 };
    },
  }));
  await buildAgentMcpServer('backend', { ctx: caller }).defs[0].handler({ id: 'x' }, {});
  assert.equal(seen.role, 'backend', '工具不得改掉自己的 role');
  assert.equal(caller.role, 'backend', '调用方持有的对象不得被反向污染');
});

test('buildAgentMcpServer：ctx 透传给 handler（colleagueId / role 等业务上下文）', async () => {
  let seen = null;
  registerAgentTool(def({ name: 'peek', handler: async (_i, ctx) => { seen = ctx; return { ok: 1 }; } }));
  const built = buildAgentMcpServer('backend', { ctx: { colleagueId: 'cl_1', role: 'backend' } });
  await built.defs[0].handler({ id: 'x' }, {});
  assert.deepEqual(seen, { colleagueId: 'cl_1', role: 'backend' });
});

// —— textResult 的 undefined 防线（2026-09-22 审查实测抓出的 Critical）：
// JSON.stringify 对 undefined/函数/Symbol 返回 undefined 这个值本身，会让 text 字段
// 在序列化后整个消失，对端 schema 校验抛 -32602 并**打断整轮对话**——而且这个错
// 发生在客户端校验，handler 早已返回，buildAgentMcpServer 的 try/catch 兜不住。
// notify 档工具（只给主机发消息）天然不 return，这条路径必然会被走到。
test('textResult：handler 什么都不返回时，text 不得为 undefined', async () => {
  registerAgentTool(def({ name: 'silent', handler: async () => {} }));
  const out = await buildAgentMcpServer('backend').defs[0].handler({ id: 'x' }, {});
  assert.equal(typeof out.content[0].text, 'string');
  assert.equal(out.content[0].text, 'null');
  // 序列化后 text 字段必须还在（这才是对端真正收到的东西）
  assert.ok(Object.hasOwn(JSON.parse(JSON.stringify(out)).content[0], 'text'));
});

test('textResult：handler 返回函数 / Symbol 时同样不产出 undefined', async () => {
  for (const [name, val] of [['fn', () => {}], ['sym', Symbol('x')]]) {
    clearAgentTools();
    registerAgentTool(def({ name, handler: async () => val }));
    const out = await buildAgentMcpServer('backend').defs[0].handler({ id: 'x' }, {});
    assert.equal(typeof out.content[0].text, 'string', name);
  }
});

test('textResult：正常对象与字符串的行为不受影响', async () => {
  clearAgentTools();
  registerAgentTool(def({ name: 'obj', handler: async () => ({ a: 1 }) }));
  registerAgentTool(def({ name: 'str', handler: async () => '纯文本' }));
  const built = buildAgentMcpServer('backend');
  const byName = Object.fromEntries(built.defs.map((d) => [d.name, d]));
  assert.deepEqual(JSON.parse((await byName.obj.handler({ id: 'x' }, {})).content[0].text), { a: 1 });
  assert.equal((await byName.str.handler({ id: 'x' }, {})).content[0].text, '纯文本');
});

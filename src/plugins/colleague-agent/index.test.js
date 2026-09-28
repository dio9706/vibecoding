import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { assertRoles } from './index.js';
import { listAgentTools } from '../../capabilities/agent-tools.js';
import { REQ_READ_TOOL_NAMES } from './tools/req-read.js';
import { REQ_WRITE_TOOL_NAMES } from './tools/req-write.js';

// —— 本文件 import 即触发插件的模块加载副作用（工具自注册）。这正是被测行为：
//    「import 插件 = 工具进注册表」是 P2 让 web 进程拿到工具的唯一手段。
//    注意不要在这里调 clearAgentTools()，副作用只发生一次，清了就测不回来了。

test('插件装配：id 正确，P3 Task 6 挂上 order=35 的 feature（上一代 colleague-relay 已下线）', () => {
  assert.equal(plugin.id, 'colleague-agent');
  assert.equal(plugin.features.length, 1);
  assert.equal(plugin.features[0].order, 35);
  assert.equal(plugin.features[0].feature.name, 'colleague-agent');
});

test('模块加载即完成工具自注册（P2 靠这个副作用让 web 进程拿到工具，read + write 两组都要在）', () => {
  const names = listAgentTools().map((t) => t.name);
  for (const n of [...REQ_READ_TOOL_NAMES, ...REQ_WRITE_TOOL_NAMES]) assert.ok(names.includes(n), `工具 ${n} 未注册`);
});

// —— assertRoles 是启动期守卫，拦的是「拼错角色名 → 工具对任何人不可见 → 全链路零信号」
//    这个最难排查的失败形态。注册表那层只校验形状（非空字符串），'Backend' 形状合法、
//    它挡不住，所以这道语义闸是唯一防线。零覆盖的守卫会悄悄烂掉，故必须钉住。
test('assertRoles：合法角色 id 与 * 均放行', () => {
  assert.doesNotThrow(() => assertRoles({ name: 't', roles: ['*'] }));
  assert.doesNotThrow(() => assertRoles({ name: 't', roles: ['backend', 'qa'] }));
  assert.doesNotThrow(() => assertRoles({ name: 't', roles: ['*', 'product'] }));
});

test('assertRoles：拼错大小写的角色 id 被拦（形状合法但语义非法）', () => {
  assert.throws(() => assertRoles({ name: 't', roles: ['Backend'] }), /非法角色 id：Backend/);
});

test('assertRoles：不存在的角色 id 被拦，且错误信息列出合法值', () => {
  assert.throws(() => assertRoles({ name: 't', roles: ['devops'] }), (e) => {
    assert.match(e.message, /devops/);
    assert.match(e.message, /合法值/);
    assert.match(e.message, /backend/); // 列出真实枚举，便于改正
    return true;
  });
});

test('assertRoles：多个非法值一次全报，不是只报第一个', () => {
  assert.throws(() => assertRoles({ name: 't', roles: ['Backend', 'devops'] }), /Backend, devops/);
});

test('assertRoles：合法与非法混排时仍会拦', () => {
  assert.throws(() => assertRoles({ name: 't', roles: ['backend', 'devops'] }), /devops/);
});

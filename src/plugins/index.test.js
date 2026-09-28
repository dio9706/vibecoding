import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleFeatures, PLUGIN_MANIFEST, loadPluginSideEffects } from './index.js';

const f = (name) => ({ name, handle() {} });

test('assembleFeatures：core 与插件条目按 order 合并（10 插件 < 20 core < 30/40 插件）', () => {
  const core = [{ order: 20, feature: f('claude-exec') }];
  const plug = [
    { order: 10, feature: f('task-triage') },
    { order: 40, feature: f('feedback') },
    { order: 30, feature: f('action-runner') },
  ];
  assert.deepEqual(
    assembleFeatures(core, plug).map((x) => x.name),
    ['task-triage', 'claude-exec', 'action-runner', 'feedback'], // 与插件化前 features/index.js 顺序一致
  );
});

test('assembleFeatures：同 order 稳定保序、空插件集只剩 core、不改入参', () => {
  const core = [{ order: 20, feature: f('core') }];
  const plug = [
    { order: 20, feature: f('a') },
    { order: 20, feature: f('b') },
  ];
  assert.deepEqual(assembleFeatures(core, plug).map((x) => x.name), ['core', 'a', 'b']);
  assert.deepEqual(assembleFeatures(core, []).map((x) => x.name), ['core']);
  assert.equal(core.length, 1); // 入参未被 sort 就地改动
});

// ---- loadPluginSideEffects：web 进程补装配层缺口 ----
// web 入口对 app/ 零引用 → 不走 loadEnabledPluginFeatures → 靠模块副作用注册的能力
// （colleague-agent 的 agent 工具）在 web 进程一个都不会注册。

/** 造一个可观测的假清单：load 记录调用次数 */
function fakeManifest(spec) {
  return spec.map(({ id, throws }) => ({
    id,
    description: id,
    calls: 0,
    load() {
      this.calls++;
      if (throws) throw new Error(`boom:${id}`);
      return Promise.resolve({ default: { id, features: [] } });
    },
  }));
}

test('loadPluginSideEffects：启用的插件被加载，停用的跳过', async () => {
  const manifest = fakeManifest([{ id: 'a' }, { id: 'b' }]);
  const r = await loadPluginSideEffects(['a', 'b'], { manifest, isEnabled: (id) => id === 'a' });
  assert.equal(manifest[0].calls, 1);
  assert.equal(manifest[1].calls, 0, '停用的插件绝不能被显式加载绕过开关');
  assert.deepEqual(r.loaded, ['a']);
  assert.deepEqual(r.skipped, ['b']);
});

test('loadPluginSideEffects：单个插件加载抛错被隔离，后续照常加载', async () => {
  const manifest = fakeManifest([{ id: 'bad', throws: true }, { id: 'good' }]);
  const r = await loadPluginSideEffects(['bad', 'good'], { manifest, isEnabled: () => true });
  assert.equal(manifest[1].calls, 1, '一个插件坏了不该让 web 少载后面的');
  assert.deepEqual(r.failed, ['bad']);
  assert.deepEqual(r.loaded, ['good']);
});

test('loadPluginSideEffects：id 不在清单里 → 记 failed 但不抛（拼错的 id 不该让 web 起不来）', async () => {
  const manifest = fakeManifest([{ id: 'a' }]);
  const r = await loadPluginSideEffects(['typo'], { manifest, isEnabled: () => true });
  assert.deepEqual(r.failed, ['typo']);
  assert.deepEqual(r.loaded, []);
});

test('loadPluginSideEffects：空清单不炸', async () => {
  const r = await loadPluginSideEffects([], { manifest: [], isEnabled: () => true });
  assert.deepEqual(r, { loaded: [], skipped: [], failed: [] });
});

test('colleague-agent 必须在 PLUGIN_MANIFEST 里 —— web 侧显式加载按 id 查表，改名即静默失效', () => {
  assert.ok(PLUGIN_MANIFEST.some((p) => p.id === 'colleague-agent'));
});

test('PLUGIN_MANIFEST：每项含 id/description/load，且 id 唯一', () => {
  const ids = new Set();
  for (const p of PLUGIN_MANIFEST) {
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.description, 'string');
    assert.equal(typeof p.load, 'function');
    assert.ok(!ids.has(p.id), 'id 重复: ' + p.id);
    ids.add(p.id);
  }
  assert.ok(ids.has('team-tools') && ids.has('action-runner'));
});

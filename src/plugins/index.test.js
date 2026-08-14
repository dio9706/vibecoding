import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleFeatures, PLUGIN_MANIFEST } from './index.js';

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

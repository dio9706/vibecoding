/**
 * action-configs CRUD 单测
 * 测试动作配置的读取、创建、更新、删除操作。
 *
 * 隔离：本测试会 rmSync/覆盖 dataPath('action-configs.json')。store 的数据目录取自
 * APP_DATA_DIR（打包/桌面版会指向真实数据目录），若不隔离，跑 `npm test` 会直接清空
 * 线上动作配置。故这里先把 APP_DATA_DIR 指到临时目录，再「动态」import store
 * （必须在 import 之前设好 env —— index.js 在模块求值时即固化数据目录）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'action-configs-test-'));
process.env.APP_DATA_DIR = TMP_DIR;

// 动态 import：确保 index.js 求值时读到的是上面刚设好的临时 APP_DATA_DIR
const { getConfigs, saveConfigs, getConfig, addConfig, updateConfig, deleteConfig } =
  await import('./action-configs.js');
const { dataPath } = await import('./index.js');

const FILE = 'action-configs.json';

after(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function cleanup() {
  try {
    fs.rmSync(dataPath(FILE));
  } catch {
    /* ignore */
  }
}

test('读取空配置返回空数组', () => {
  cleanup();
  const configs = getConfigs();
  assert.deepStrictEqual(configs, []);
});

test('保存并读取配置', () => {
  cleanup();
  const configs = [
    { id: 'a1', name: 'action-a', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'a2', name: 'action-b', createdAt: '2026-01-01T00:01:00Z', updatedAt: '2026-01-01T00:01:00Z' },
  ];
  saveConfigs(configs);
  const read = getConfigs();
  assert.deepStrictEqual(read, configs);
});

test('添加配置自动生成 id、createdAt、updatedAt', () => {
  cleanup();
  const before = Date.now();
  const added = addConfig({ name: 'test-action', description: 'A test action' });
  const after = Date.now();

  assert.ok(added.id);
  assert.match(added.id, /^ac_/); // id 以 ac_ 开头
  assert.ok(added.createdAt);
  assert.ok(added.updatedAt);
  const createdTime = new Date(added.createdAt).getTime();
  assert.ok(createdTime >= before && createdTime <= after);
  assert.equal(added.createdAt, added.updatedAt); // 创建时 createdAt 和 updatedAt 相同
  assert.equal(added.name, 'test-action');
  assert.equal(added.description, 'A test action');

  // 验证存储中能读到
  const read = getConfig(added.id);
  assert.deepStrictEqual(read, added);
});

test('更新配置修改 updatedAt，不修改 createdAt 和 id', async () => {
  cleanup();
  const added = addConfig({ name: 'original-name', data: { key: 'value1' } });
  const originalCreatedAt = added.createdAt;
  const originalId = added.id;

  // 短暂等待确保时间差异
  await new Promise((r) => setTimeout(r, 10));

  const updated = updateConfig(added.id, { name: 'updated-name', data: { key: 'value2' } });

  assert.ok(updated);
  assert.equal(updated.id, originalId); // id 不变
  assert.equal(updated.createdAt, originalCreatedAt); // createdAt 不变
  assert.ok(updated.updatedAt > originalCreatedAt); // updatedAt 更新
  assert.equal(updated.name, 'updated-name');
  assert.deepStrictEqual(updated.data, { key: 'value2' });

  // 验证存储中能读到
  const read = getConfig(added.id);
  assert.deepStrictEqual(read, updated);
});

test('删除配置', () => {
  cleanup();
  const added = addConfig({ name: 'to-delete' });
  const id = added.id;

  assert.ok(getConfig(id)); // 创建前存在
  deleteConfig(id);
  assert.equal(getConfig(id), null); // 删除后返回 null
  assert.equal(getConfigs().length, 0);
});

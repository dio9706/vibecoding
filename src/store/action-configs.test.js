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
const {
  getConfigs, saveConfigs, getConfig, addConfig, updateConfig, deleteConfig,
  appendAutoKeyword, reconcileAutoKeywords, DEFAULT_AUTO_KEYWORD_MAX,
} = await import('./action-configs.js');
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

test('appendAutoKeyword：双写 keywords 与 autoKeywords', () => {
  cleanup();
  const c = addConfig({ botId: 'bot_t', name: '清理', keywords: ['清一下'] });

  assert.equal(appendAutoKeyword(c.id, '清掉业务表', { sourceText: '帮我清掉业务表' }), true);

  const after = getConfig(c.id);
  assert.deepStrictEqual(after.keywords, ['清一下', '清掉业务表']);
  assert.equal(after.autoKeywords.length, 1);
  assert.equal(after.autoKeywords[0].word, '清掉业务表');
  assert.equal(after.autoKeywords[0].sourceText, '帮我清掉业务表');
  assert.ok(after.autoKeywords[0].learnedAt, 'learnedAt 必须落盘，否则面板无从判断学于何时');
});

test('appendAutoKeyword：已存在的词不重复写', () => {
  cleanup();
  const c = addConfig({ botId: 'bot_t', name: '清理', keywords: ['清一下'] });
  assert.equal(appendAutoKeyword(c.id, '清一下', {}), false);
  assert.deepStrictEqual(getConfig(c.id).keywords, ['清一下']);
});

test('appendAutoKeyword：配额在锁内复核（调用方判断时读到的是快照）', () => {
  cleanup();
  const c = addConfig({ botId: 'bot_t', name: '清理', keywords: [] });
  for (let i = 0; i < DEFAULT_AUTO_KEYWORD_MAX; i += 1) {
    assert.equal(appendAutoKeyword(c.id, `自动词${i}`, {}), true);
  }
  assert.equal(appendAutoKeyword(c.id, '再来一个', {}), false, '超出配额必须拒写');
  assert.equal(getConfig(c.id).autoKeywords.length, DEFAULT_AUTO_KEYWORD_MAX);
});

test('appendAutoKeyword：max 可被调用方覆盖（单一真相源在 keyword-guard）', () => {
  cleanup();
  const c = addConfig({ botId: 'bot_t', name: '清理', keywords: [] });
  assert.equal(appendAutoKeyword(c.id, '自动词甲', { max: 1 }), true);
  assert.equal(appendAutoKeyword(c.id, '自动词乙', { max: 1 }), false);
});

test('appendAutoKeyword：动作不存在 → 返回 false 且不写盘', () => {
  cleanup();
  assert.equal(appendAutoKeyword('ac_nope', '随便什么词', {}), false);
  assert.deepStrictEqual(getConfigs(), []);
});

test('reconcileAutoKeywords：用户删掉的自动词进 rejectedKeywords', () => {
  const prev = {
    keywords: ['清一下', '清掉业务表', '清空 test'],
    autoKeywords: [{ word: '清掉业务表' }, { word: '清空 test' }],
    rejectedKeywords: ['重置'],
  };
  // 用户在面板上删掉了「清掉业务表」
  const r = reconcileAutoKeywords(prev, ['清一下', '清空 test']);
  assert.deepStrictEqual(r.autoKeywords, [{ word: '清空 test' }]);
  assert.deepStrictEqual(r.rejectedKeywords, ['重置', '清掉业务表']);
});

test('reconcileAutoKeywords：删掉手工词不影响 rejectedKeywords', () => {
  const prev = {
    keywords: ['清一下', '清掉业务表'],
    autoKeywords: [{ word: '清掉业务表' }],
    rejectedKeywords: [],
  };
  const r = reconcileAutoKeywords(prev, ['清掉业务表']); // 删的是手工词「清一下」
  assert.deepStrictEqual(r.autoKeywords, [{ word: '清掉业务表' }]);
  assert.deepStrictEqual(r.rejectedKeywords, []);
});

test('reconcileAutoKeywords：rejectedKeywords 不重复堆积', () => {
  const prev = {
    keywords: ['清掉业务表'],
    autoKeywords: [{ word: '清掉业务表' }],
    rejectedKeywords: ['清掉业务表'],
  };
  const r = reconcileAutoKeywords(prev, []);
  assert.deepStrictEqual(r.rejectedKeywords, ['清掉业务表']);
});

test('reconcileAutoKeywords：字段缺省的存量配置不炸', () => {
  const r = reconcileAutoKeywords({}, ['清一下']);
  assert.deepStrictEqual(r, { autoKeywords: [], rejectedKeywords: [] });
});

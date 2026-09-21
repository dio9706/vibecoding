/**
 * 体检豁免清单的读写。
 *
 * 隔离：store/index.js 在模块求值时就把数据目录定死，必须「先设 APP_DATA_DIR 到临时目录，
 * 再动态 import」，否则会写进开发机真实的 checkup-ignores.json（做法同 store/optimize.test.js）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'checkup-ignores-'));

const { readIgnores, addIgnore, removeIgnore } = await import('./checkup-ignores.js');

let n = 0;
const nextDir = () => `C:/tmp/proj-${++n}`;

const rule = (over = {}) => ({
  dim: 'structure',
  code: 'A1_DEP_VIOLATION',
  file: 'src/api/request.js',
  message: 'api 层直接 import store',
  note: '历史遗留兼容层，下版本整体删除',
  at: '2026-09-18T10:00:00.000Z',
  ...over,
});

test('新项目读出空数组而不是 undefined', () => {
  assert.deepEqual(readIgnores(nextDir()), []);
});

test('加一条后能读回来', () => {
  const dir = nextDir();
  addIgnore(dir, rule());
  const got = readIgnores(dir);
  assert.equal(got.length, 1);
  assert.equal(got[0].note, '历史遗留兼容层，下版本整体删除');
});

test('同一 (dim, code, file) 重复提交是覆盖而非追加', () => {
  // 用户改主意重新写理由时，应当留下最新那条，而不是两条互相矛盾的记录
  const dir = nextDir();
  addIgnore(dir, rule({ note: '第一版理由' }));
  addIgnore(dir, rule({ note: '第二版理由', at: '2026-09-18T11:00:00.000Z' }));
  const got = readIgnores(dir);
  assert.equal(got.length, 1);
  assert.equal(got[0].note, '第二版理由');
  assert.equal(got[0].at, '2026-09-18T11:00:00.000Z');
});

test('code 不同视为两条独立记录', () => {
  // 这正是「召回阶段要全部 code 都被豁免才剔除候选」这条规则的前提
  const dir = nextDir();
  addIgnore(dir, rule({ code: 'A1_DEP_VIOLATION' }));
  addIgnore(dir, rule({ code: 'A2_DEP_SMELL' }));
  assert.equal(readIgnores(dir).length, 2);
});

test('file 不同视为两条独立记录', () => {
  const dir = nextDir();
  addIgnore(dir, rule({ file: 'src/a.js' }));
  addIgnore(dir, rule({ file: 'src/b.js' }));
  assert.equal(readIgnores(dir).length, 2);
});

test('跨项目互不影响', () => {
  const a = nextDir();
  const b = nextDir();
  addIgnore(a, rule());
  assert.equal(readIgnores(a).length, 1);
  assert.deepEqual(readIgnores(b), []);
});

test('删除命中的条目', () => {
  const dir = nextDir();
  addIgnore(dir, rule({ code: 'A1_DEP_VIOLATION' }));
  addIgnore(dir, rule({ code: 'A2_DEP_SMELL' }));
  removeIgnore(dir, { dim: 'structure', code: 'A1_DEP_VIOLATION', file: 'src/api/request.js' });
  const got = readIgnores(dir);
  assert.equal(got.length, 1);
  assert.equal(got[0].code, 'A2_DEP_SMELL');
});

test('删除不存在的条目不抛错也不改动已有数据', () => {
  const dir = nextDir();
  addIgnore(dir, rule());
  removeIgnore(dir, { dim: 'structure', code: 'NOPE', file: 'src/api/request.js' });
  assert.equal(readIgnores(dir).length, 1);
});

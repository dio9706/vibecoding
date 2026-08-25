import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePorcelain } from './git-guard.logic.js';

test('空输出 = 工作区干净', () => {
  assert.deepEqual(parsePorcelain(''), { dirty: false, count: 0, files: [] });
  assert.deepEqual(parsePorcelain('\n'), { dirty: false, count: 0, files: [] });
  assert.deepEqual(parsePorcelain(null), { dirty: false, count: 0, files: [] });
});

test('解析已修改与未跟踪', () => {
  const out = ' M src/a.js\n?? new.txt\n M src/b.js\n';
  const r = parsePorcelain(out);
  assert.equal(r.dirty, true);
  assert.equal(r.count, 3);
  assert.deepEqual(r.files, ['src/a.js', 'new.txt', 'src/b.js']);
});

test('已暂存的改动也算脏', () => {
  const r = parsePorcelain('M  staged.js\nA  added.js\nD  deleted.js\n');
  assert.equal(r.count, 3);
  assert.deepEqual(r.files, ['staged.js', 'added.js', 'deleted.js']);
});

test('带引号的路径去掉引号', () => {
  const r = parsePorcelain(' M "src/带空格 的文件.js"\n');
  assert.deepEqual(r.files, ['src/带空格 的文件.js']);
});

test('重命名取箭头后的新路径', () => {
  const r = parsePorcelain('R  old.js -> new.js\n');
  assert.deepEqual(r.files, ['new.js']);
});

test('路径本身含 -> 时不误切', () => {
  // 文件名里带 -> 很罕见但合法；只有 R/C 状态才是重命名
  const r = parsePorcelain('?? weird->name.txt\n');
  assert.deepEqual(r.files, ['weird->name.txt']);
});

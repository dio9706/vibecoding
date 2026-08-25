import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFingerprint, isCacheValid } from './fingerprint.logic.js';

test('同样的输入产生同样的指纹', () => {
  const files = [{ path: 'a.js', mtime: 100, size: 10 }, { path: 'b.js', mtime: 200, size: 20 }];
  assert.equal(computeFingerprint(files), computeFingerprint(files));
});

test('文件顺序不影响指纹', () => {
  // 目录遍历顺序在不同平台/文件系统上不保证一致，指纹必须与顺序无关
  const a = [{ path: 'a.js', mtime: 100, size: 10 }, { path: 'b.js', mtime: 200, size: 20 }];
  const b = [{ path: 'b.js', mtime: 200, size: 20 }, { path: 'a.js', mtime: 100, size: 10 }];
  assert.equal(computeFingerprint(a), computeFingerprint(b));
});

test('mtime 变了指纹就变', () => {
  const a = [{ path: 'a.js', mtime: 100, size: 10 }];
  const b = [{ path: 'a.js', mtime: 101, size: 10 }];
  assert.notEqual(computeFingerprint(a), computeFingerprint(b));
});

test('size 变了指纹就变', () => {
  const a = [{ path: 'a.js', mtime: 100, size: 10 }];
  const b = [{ path: 'a.js', mtime: 100, size: 11 }];
  assert.notEqual(computeFingerprint(a), computeFingerprint(b));
});

test('文件数量变了指纹就变', () => {
  const a = [{ path: 'a.js', mtime: 100, size: 10 }];
  const b = [{ path: 'a.js', mtime: 100, size: 10 }, { path: 'b.js', mtime: 100, size: 10 }];
  assert.notEqual(computeFingerprint(a), computeFingerprint(b));
});

test('路径名变了指纹就变', () => {
  const a = [{ path: 'a.js', mtime: 100, size: 10 }];
  const b = [{ path: 'c.js', mtime: 100, size: 10 }];
  assert.notEqual(computeFingerprint(a), computeFingerprint(b));
});

test('空列表也有稳定指纹', () => {
  assert.equal(computeFingerprint([]), computeFingerprint([]));
  assert.ok(typeof computeFingerprint([]) === 'string');
});

test('指纹是短字符串，适合存 JSON', () => {
  const fp = computeFingerprint([{ path: 'a.js', mtime: 100, size: 10 }]);
  assert.ok(fp.length <= 32);
  assert.ok(/^[0-9a-f]+$/.test(fp));
});

test('缓存有效性判定', () => {
  assert.equal(isCacheValid({ fingerprint: 'abc', result: {} }, 'abc'), true);
  assert.equal(isCacheValid({ fingerprint: 'abc', result: {} }, 'xyz'), false);
});

test('没有缓存时无效', () => {
  assert.equal(isCacheValid(null, 'abc'), false);
  assert.equal(isCacheValid(undefined, 'abc'), false);
  assert.equal(isCacheValid({}, 'abc'), false);
});

test('缓存里没有 result 时视为无效', () => {
  // 只有指纹没有结果，说明上次没跑完，不能当有效缓存
  assert.equal(isCacheValid({ fingerprint: 'abc' }, 'abc'), false);
  assert.equal(isCacheValid({ fingerprint: 'abc', result: null }, 'abc'), false);
});

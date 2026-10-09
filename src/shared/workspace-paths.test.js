/**
 * 工作目录路径工具单测：归一/越界判定/显示相对路径。
 * 这是「区内自动 / 越界审批」的分界线，边界必须钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveWorkspace, isInsideWorkspace, resolveToolPath, displayPath } from './workspace-paths.js';

const WS = path.resolve('bench-ws-test'); // 跨平台中性路径：<cwd>/bench-ws-test

test('resolveWorkspace：空值退进程 cwd，相对值按 cwd 解析后绝对化', () => {
  assert.equal(resolveWorkspace(''), path.resolve(process.cwd()));
  assert.equal(resolveWorkspace(null), path.resolve(process.cwd()));
  assert.equal(resolveWorkspace('sub'), path.resolve('sub'));
});

test('isInsideWorkspace：自身/子路径为内；父路径与平行路径为外', () => {
  assert.equal(isInsideWorkspace(WS, WS), true, '工作目录自身算内');
  assert.equal(isInsideWorkspace(WS, path.join(WS, 'a', 'b.txt')), true);
  assert.equal(isInsideWorkspace(WS, path.join(WS, '..')), false, '父目录算外');
  assert.equal(isInsideWorkspace(WS, path.join(WS, '..', 'other')), false, '兄弟目录算外');
  if (process.platform === 'win32') {
    assert.equal(isInsideWorkspace(WS, 'D:\\elsewhere'), false, '跨盘符必须算外');
  }
});

test('resolveToolPath：相对按 workspace 解析，绝对原样，均 normalize（消灭 .. 绕行）', () => {
  assert.equal(resolveToolPath('a/b.txt', WS), path.join(WS, 'a', 'b.txt'));
  assert.equal(resolveToolPath('../x.txt', WS), path.join(WS, '..', 'x.txt'));
  const abs = path.join(WS, 'x.txt');
  assert.equal(resolveToolPath(abs, WS), abs);
  assert.equal(resolveToolPath(path.join(WS, 'a', '..', 'x.txt'), WS), abs);
});

test('displayPath：区内相对（正斜杠）；区外保留绝对路径', () => {
  assert.equal(displayPath(path.join(WS, 'a', 'b.txt'), WS), 'a/b.txt');
  assert.equal(displayPath(WS, WS), WS, '工作目录自身没有相对表示，保留绝对');
  const outside = path.join(WS, '..', 'x.txt');
  assert.equal(displayPath(outside, WS), outside);
});

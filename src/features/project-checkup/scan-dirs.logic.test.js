import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DIR, shouldSkipDir } from './scan-dirs.logic.js';

test('构建产物与依赖目录一律跳过', () => {
  for (const d of ['node_modules', 'dist', 'build', 'coverage', '.git', '.expo']) {
    assert.equal(shouldSkipDir(d), true, `${d} 应被跳过`);
  }
});

test('worktree 目录的两种写法都要跳过', () => {
  // 原实现只写了 'worktrees'，而实际目录名是 '.worktrees'（带点）→ 规则形同虚设。
  // worktree 里是主仓库的完整副本，漏掉会把同一份配置重复计分。
  assert.equal(shouldSkipDir('worktrees'), true);
  assert.equal(shouldSkipDir('.worktrees'), true);
});

test('测试夹具目录跳过：夹具是刻意写坏/写好的假配置，不能当真实项目配置评分', () => {
  assert.equal(shouldSkipDir('fixtures'), true);
  assert.equal(shouldSkipDir('__fixtures__'), true);
});

test('tests 目录本身不跳过：真实测试代码的注释质量也值得体检', () => {
  assert.equal(shouldSkipDir('tests'), false);
  assert.equal(shouldSkipDir('test'), false);
});

test('普通业务目录不跳过', () => {
  for (const d of ['src', 'public', 'features', 'store']) {
    assert.equal(shouldSkipDir(d), false, `${d} 不应被跳过`);
  }
});

test('skipHidden 保留 check-map 的既有行为：点开头目录一并跳过', () => {
  assert.equal(shouldSkipDir('.serena'), false, '默认不跳过隐藏目录');
  assert.equal(shouldSkipDir('.serena', { skipHidden: true }), true);
  assert.equal(shouldSkipDir('.claude', { skipHidden: true }), true);
  // 非隐藏目录不受该开关影响
  assert.equal(shouldSkipDir('src', { skipHidden: true }), false);
});

test('SKIP_DIR 导出为 Set，供需要直接判定的调用方复用', () => {
  assert.ok(SKIP_DIR instanceof Set);
  assert.ok(SKIP_DIR.has('node_modules'));
});

test('容错：空值不抛错', () => {
  assert.equal(shouldSkipDir(''), false);
  assert.equal(shouldSkipDir(null), false);
  assert.equal(shouldSkipDir(undefined), false);
});

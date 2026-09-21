import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_DIR, shouldSkipDir, isUnderSkippedDir } from './scan-dirs.logic.js';

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

// ---------- 工具自产物的排除（自我污染防线） ----------

test('本功能自己的备份目录一律跳过', () => {
  // 不排除它就是自我污染：备份是整个源码树的快照，被扫到会让副本当真源码重复分析。
  // 实测一份备份贡献了 140 项假问题（317 项里的 44%）
  assert.equal(shouldSkipDir('optimize-backup'), true);
  assert.equal(isUnderSkippedDir('.claude/optimize-backup/2026-09-18T06-39-43/files/src/a.ts'), true);
  assert.equal(isUnderSkippedDir('.claude/optimize-backup/x/manifest.json'), true);
});

test('isUnderSkippedDir：逐段比目录，不误伤同名文件', () => {
  assert.equal(isUnderSkippedDir('src/app.ts'), false);
  assert.equal(isUnderSkippedDir('node_modules/pkg/index.js'), true);
  assert.equal(isUnderSkippedDir('tests/fixtures/demo/CLAUDE.md'), true);
  // 只比目录段：文件名本身叫 fixtures.ts / optimize-backup.md 的不该被当成目录
  assert.equal(isUnderSkippedDir('src/fixtures.ts'), false);
  assert.equal(isUnderSkippedDir('docs/optimize-backup.md'), false);
});

test('isUnderSkippedDir：容错', () => {
  assert.equal(isUnderSkippedDir(''), false);
  assert.equal(isUnderSkippedDir(null), false);
  assert.equal(isUnderSkippedDir('a.js'), false, '单段路径没有目录段');
});

/** src/entrypoints/web/routes-git.test.js */
import { test } from 'node:test';
import * as assert from 'node:assert';
import { validateBranchName, parseBranchLines } from './routes-git.js';

// ---- validateBranchName ----

test('validateBranchName: 合法分支名通过', (t) => {
  assert.strictEqual(validateBranchName('main'), true);
  assert.strictEqual(validateBranchName('dev'), true);
  assert.strictEqual(validateBranchName('feat/api'), true);
  assert.strictEqual(validateBranchName('release-1.0'), true);
  assert.strictEqual(validateBranchName('fix_bug'), true);
  assert.strictEqual(validateBranchName('feature/user.profile'), true);
  assert.strictEqual(validateBranchName('v1.0.0'), true);
});

test('validateBranchName: 非法字符被拒绝', (t) => {
  assert.strictEqual(validateBranchName('main@'), false);
  assert.strictEqual(validateBranchName('feat$branch'), false);
  assert.strictEqual(validateBranchName('branch name'), false); // 空格
  assert.strictEqual(validateBranchName('feat;rm -rf'), false); // 注入尝试
});

test('validateBranchName: 空值/非字符串被拒绝', (t) => {
  assert.strictEqual(validateBranchName(''), false);
  assert.strictEqual(validateBranchName(null), false);
  assert.strictEqual(validateBranchName(undefined), false);
  assert.strictEqual(validateBranchName(123), false);
});

test('validateBranchName: 路径遍历序列 (..) 被拒绝', (t) => {
  assert.strictEqual(validateBranchName('../etc/passwd'), false);
  assert.strictEqual(validateBranchName('feat/../etc'), false);
  assert.strictEqual(validateBranchName('a..b'), false);
});

// ---- parseBranchLines ----

test('parseBranchLines: 本地分支按字母序', (t) => {
  const lines = [
    'refs/heads/main|(SEP)|true',
    'refs/heads/feature/api|(SEP)|false',
    'refs/heads/dev|(SEP)|false',
    'refs/heads/alpha|(SEP)|false',
  ];
  const { local, remote, current } = parseBranchLines(lines);
  assert.deepStrictEqual(local, ['alpha', 'dev', 'feature/api', 'main']);
  assert.deepStrictEqual(remote, []);
  assert.strictEqual(current, 'main');
});

test('parseBranchLines: 远程分支按字母序', (t) => {
  const lines = [
    'refs/remotes/origin/main|(SEP)|false',
    'refs/remotes/origin/develop|(SEP)|false',
    'refs/remotes/origin/beta|(SEP)|false',
  ];
  const { local, remote, current } = parseBranchLines(lines);
  assert.deepStrictEqual(local, []);
  assert.deepStrictEqual(remote, ['origin/beta', 'origin/develop', 'origin/main']);
  assert.strictEqual(current, '');
});

test('parseBranchLines: 本地在前、远程在后、current 正确识别', (t) => {
  const lines = [
    'refs/remotes/origin/main|(SEP)|false',
    'refs/heads/main|(SEP)|true',
    'refs/heads/dev|(SEP)|false',
    'refs/remotes/origin/dev|(SEP)|false',
  ];
  const { local, remote, current } = parseBranchLines(lines);
  assert.deepStrictEqual(local, ['dev', 'main']);
  assert.deepStrictEqual(remote, ['origin/dev', 'origin/main']);
  assert.strictEqual(current, 'main');
});

test('parseBranchLines: 空输入返回空列表', (t) => {
  const { local, remote, current } = parseBranchLines([]);
  assert.deepStrictEqual(local, []);
  assert.deepStrictEqual(remote, []);
  assert.strictEqual(current, '');
});

// origin/HEAD 是指向默认分支的符号引用；refname:short 会把它缩成一个
// 看着像分支的 `origin`，曾导致列表里多出一条点不动的假分支。
test('parseBranchLines: 过滤 origin/HEAD 符号引用', (t) => {
  const lines = [
    'refs/heads/main|(SEP)|true',
    'refs/remotes/origin/HEAD|(SEP)|false',
    'refs/remotes/origin/main|(SEP)|false',
  ];
  const { local, remote } = parseBranchLines(lines);
  assert.deepStrictEqual(local, ['main']);
  assert.deepStrictEqual(remote, ['origin/main']);
});

// 同名本地/远程分支必须落在各自的组里（refname:short 下二者都叫得出同一个名字，
// 无从区分，这是改用 ref 全名分类的直接原因）。
test('parseBranchLines: 同名本地与远程分支不混淆', (t) => {
  const lines = [
    'refs/heads/v1.0.0|(SEP)|true',
    'refs/remotes/origin/v1.0.0|(SEP)|false',
  ];
  const { local, remote, current } = parseBranchLines(lines);
  assert.deepStrictEqual(local, ['v1.0.0']);
  assert.deepStrictEqual(remote, ['origin/v1.0.0']);
  assert.strictEqual(current, 'v1.0.0');
});

test('parseBranchLines: 非 branch ref 被忽略', (t) => {
  const lines = ['refs/tags/v1.0|(SEP)|false', 'refs/heads/main|(SEP)|true'];
  const { local, remote } = parseBranchLines(lines);
  assert.deepStrictEqual(local, ['main']);
  assert.deepStrictEqual(remote, []);
});

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
    'main|(SEP)|true',
    'feature/api|(SEP)|false',
    'dev|(SEP)|false',
    'alpha|(SEP)|false',
  ];
  const { local, remote, current } = parseBranchLines(lines);
  assert.deepStrictEqual(local, ['alpha', 'dev', 'feature/api', 'main']);
  assert.deepStrictEqual(remote, []);
  assert.strictEqual(current, 'main');
});

test('parseBranchLines: 远程分支按字母序', (t) => {
  const lines = [
    'remotes/origin/main|(SEP)|false',
    'remotes/origin/develop|(SEP)|false',
    'remotes/origin/beta|(SEP)|false',
  ];
  const { local, remote, current } = parseBranchLines(lines);
  assert.deepStrictEqual(local, []);
  assert.deepStrictEqual(remote, ['origin/beta', 'origin/develop', 'origin/main']);
  assert.strictEqual(current, '');
});

test('parseBranchLines: 本地在前、远程在后、current 正确识别', (t) => {
  const lines = [
    'remotes/origin/main|(SEP)|false',
    'main|(SEP)|true',
    'dev|(SEP)|false',
    'remotes/origin/dev|(SEP)|false',
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

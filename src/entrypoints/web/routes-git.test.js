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

// ---- handler 级：以真实 HTTP 联调 ----
// 老测试只覆盖两个纯函数，于是 handleGitCheckout 漏传 res（withJsonBody 的签名是
// (req, res, fn)）导致「请求永不响应」的缺陷一路溜到线上。这批用例钉住的正是
// 「无论走哪条分支都必须把响应发出去」。

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import fsx from 'node:fs';
import pathx from 'node:path';
import osx from 'node:os';
import { handleGitStatus, handleGitBranches, handleGitCheckout } from './routes-git.js';

function startGitServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const cwd = url.searchParams.get('cwd') || '';
    if (url.pathname === '/status') return handleGitStatus(cwd, res);
    if (url.pathname === '/branches') return handleGitBranches(cwd, url.searchParams.get('refresh') || '', res);
    if (url.pathname === '/checkout') return handleGitCheckout(cwd, req, res);
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** 带超时的请求：挂死的端点必须表现为断言失败，而不是让整个测试进程吊住 */
async function callGit(base, path, { method = 'GET', body } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(base + path, {
      method,
      signal: ac.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

/** 造一个真实的一次性 git 仓库，含 main 与 feature/x 两个分支 */
function makeRepo() {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'git-routes-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 'T');
  fsx.writeFileSync(pathx.join(dir, 'a.txt'), 'x');
  git('add', '.');
  git('commit', '-qm', 'init');
  git('branch', 'feature/x');
  return dir;
}

let gitServer;
let gitBase;
let repoDir;
test.before(async () => {
  gitServer = await startGitServer();
  gitBase = `http://127.0.0.1:${gitServer.address().port}`;
  repoDir = makeRepo();
});
test.after(() => {
  gitServer.close();
  fsx.rmSync(repoDir, { recursive: true, force: true });
});

test('checkout：切到已有分支必定回响应（漏传 res 时本用例会超时失败）', async () => {
  const q = '/checkout?cwd=' + encodeURIComponent(repoDir);
  const r = await callGit(gitBase, q, { method: 'POST', body: { branch: 'feature/x' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.branch, 'feature/x');

  // 回读 HEAD：前端标签的真相源就是这个接口，切完必须真的换了分支
  const st = await callGit(gitBase, '/status?cwd=' + encodeURIComponent(repoDir));
  assert.strictEqual(st.json.isGit, true);
  assert.strictEqual(st.json.currentBranch, 'feature/x');
});

test('checkout：非法分支名 400、缺 cwd 400、不存在的分支 500 —— 三条错误分支都要回响应', async () => {
  const q = '/checkout?cwd=' + encodeURIComponent(repoDir);
  assert.strictEqual((await callGit(gitBase, q, { method: 'POST', body: { branch: 'feat;rm -rf' } })).status, 400);
  assert.strictEqual((await callGit(gitBase, q, { method: 'POST', body: {} })).status, 400);
  assert.strictEqual((await callGit(gitBase, '/checkout?cwd=', { method: 'POST', body: { branch: 'main' } })).status, 400);
  const missing = await callGit(gitBase, q, { method: 'POST', body: { branch: 'no-such-branch' } });
  assert.strictEqual(missing.status, 500);
  assert.ok(missing.json.error);
});

test('status：git 仓库回 isGit+分支；非 git 目录回 isGit:false；空 cwd 回 isGit:false', async () => {
  const inRepo = await callGit(gitBase, '/status?cwd=' + encodeURIComponent(repoDir));
  assert.strictEqual(inRepo.json.isGit, true);
  assert.ok(inRepo.json.currentBranch);

  const plain = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'git-plain-'));
  try {
    const out = await callGit(gitBase, '/status?cwd=' + encodeURIComponent(plain));
    assert.strictEqual(out.json.isGit, false, '非 git 目录必须是确定的 false —— 前端据此永久隐藏按钮');
  } finally {
    fsx.rmSync(plain, { recursive: true, force: true });
  }

  assert.strictEqual((await callGit(gitBase, '/status?cwd=')).json.isGit, false);
});

test('branches：列出本地分支并标出 current；缺 cwd → 400', async () => {
  const r = await callGit(gitBase, '/branches?cwd=' + encodeURIComponent(repoDir));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.local.slice().sort(), ['feature/x', 'main']);
  assert.ok(r.json.local.includes(r.json.current));
  assert.strictEqual((await callGit(gitBase, '/branches?cwd=')).status, 400);
});

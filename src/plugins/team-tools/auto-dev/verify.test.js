/**
 * developWithVerify 编排测试 —— 注入桩件，钉住三条链：
 *   首次通过 / 失败→重试→通过 / 失败→重试→仍失败（含 develop 重试失败）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离数据目录：verify.js 间接 import store（模块级确保数据目录存在），必须在 import 前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-verify-'));

const { developWithVerify } = await import('./verify.js');

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const TASK = { id: 't_1', type: 'bug', title: '修复登录' };

function makeDeps({ develops, verifies }) {
  const developCalls = [];
  const verifyCalls = [];
  const updates = [];
  let di = 0;
  let vi = 0;
  return {
    developCalls,
    verifyCalls,
    updates,
    deps: {
      developFn: async (t, opts) => {
        developCalls.push(opts);
        const r = develops[Math.min(di, develops.length - 1)];
        di += 1;
        return r;
      },
      verifyFn: async (o) => {
        verifyCalls.push(o);
        const r = verifies[Math.min(vi, verifies.length - 1)];
        vi += 1;
        return r;
      },
      updateTaskFn: (id, patch, event) => {
        updates.push({ id, patch, event });
        return { ...TASK, ...patch };
      },
    },
  };
}

const OK_VERIFY = { ok: true, skipped: false, command: 'npm test', exitCode: 0, timedOut: false, durationMs: 1000, output: 'ok' };
const FAIL_VERIFY = { ok: false, skipped: false, command: 'npm test', exitCode: 1, timedOut: false, durationMs: 2000, output: '2 failed' };
const SKIP_VERIFY = { ok: true, skipped: true, command: '', reason: '未配置验证命令', durationMs: 0, output: '' };

test('首次通过：一次开发一次验证，不写中间态', async () => {
  const h = makeDeps({ develops: [{ ok: true }], verifies: [OK_VERIFY] });
  const r = await developWithVerify({ task: TASK, repo: 'R', autoDir: 'A', verifyCommand: 'npm test' }, h.deps);
  assert.equal(r.developOk, true);
  assert.equal(r.verify.ok, true);
  assert.equal(r.verify.attempts, 1);
  assert.equal(h.developCalls.length, 1);
  assert.equal(h.verifyCalls.length, 1);
  assert.equal(h.updates.length, 0);
});

test('失败→重试→通过：重试 prompt 带失败反馈，attempts=2', async () => {
  const h = makeDeps({ develops: [{ ok: true }, { ok: true }], verifies: [FAIL_VERIFY, OK_VERIFY] });
  const r = await developWithVerify({ task: TASK, repo: 'R', autoDir: 'A', verifyCommand: 'npm test' }, h.deps);
  assert.equal(r.developOk, true);
  assert.equal(r.verify.ok, true);
  assert.equal(r.verify.attempts, 2);
  assert.equal(h.developCalls.length, 2);
  assert.equal(h.developCalls[1].verifyFeedback, FAIL_VERIFY, '重试必须带上首次失败现场');
  assert.equal(h.updates.length, 1);
  assert.match(h.updates[0].event, /第 1 次/);
  assert.equal(h.updates[0].patch.verify.attempts, 1);
  assert.equal(h.updates[0].patch.verifyLog, '2 failed');
});

test('失败→重试→仍失败：如实返回失败记录，attempts=2', async () => {
  const h = makeDeps({ develops: [{ ok: true }, { ok: true }], verifies: [FAIL_VERIFY, FAIL_VERIFY] });
  const r = await developWithVerify({ task: TASK, repo: 'R', autoDir: 'A', verifyCommand: 'npm test' }, h.deps);
  assert.equal(r.developOk, true);
  assert.equal(r.verify.ok, false);
  assert.equal(r.verify.attempts, 2);
  assert.equal(r.verify.summary.includes('失败'), true);
});

test('失败→重试时 develop 再失败：developOk=false，保留首次失败现场', async () => {
  const h = makeDeps({ develops: [{ ok: true }, { ok: false }], verifies: [FAIL_VERIFY] });
  const r = await developWithVerify({ task: TASK, repo: 'R', autoDir: 'A', verifyCommand: 'npm test' }, h.deps);
  assert.equal(r.developOk, false);
  assert.equal(r.verify.ok, false);
  assert.equal(r.verify.attempts, 1);
});

test('首轮 develop 失败：不跑验证', async () => {
  const h = makeDeps({ develops: [{ ok: false }], verifies: [OK_VERIFY] });
  const r = await developWithVerify({ task: TASK, repo: 'R', autoDir: 'A', verifyCommand: 'npm test' }, h.deps);
  assert.equal(r.developOk, false);
  assert.equal(r.verify, null);
  assert.equal(h.verifyCalls.length, 0);
});

test('未配置验证命令：skipped 通过，不重试', async () => {
  const h = makeDeps({ develops: [{ ok: true }], verifies: [SKIP_VERIFY] });
  const r = await developWithVerify(
    { task: TASK, repo: 'R', autoDir: 'A', verifyCommand: '' },
    { ...h.deps, resolveCommandFn: async () => '' },
  );
  assert.equal(r.developOk, true);
  assert.equal(r.verify.skipped, true);
  assert.equal(r.verify.attempts, 1);
  assert.equal(h.developCalls.length, 1);
});

test('未显式配置但工程有 test 脚本：自动发现 npm test，prompt 与复跑同一条命令', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-verify-disc-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const h = makeDeps({ develops: [{ ok: true }], verifies: [OK_VERIFY] });
  const r = await developWithVerify({ task: TASK, repo: 'R', autoDir: dir, verifyCommand: '' }, h.deps);
  assert.equal(r.developOk, true);
  assert.equal(h.developCalls[0].verifyCommand, 'npm test', 'prompt 的完成标准必须用发现出的命令');
  assert.equal(h.verifyCalls[0].command, 'npm test', '复跑必须与 prompt 同一条命令');
});

test('显式配置优先于自动发现：工程有 test 脚本也按配置的命令跑', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-verify-explicit-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const h = makeDeps({ develops: [{ ok: true }], verifies: [OK_VERIFY] });
  await developWithVerify({ task: TASK, repo: 'R', autoDir: dir, verifyCommand: 'npm run lint' }, h.deps);
  assert.equal(h.developCalls[0].verifyCommand, 'npm run lint');
  assert.equal(h.verifyCalls[0].command, 'npm run lint');
});

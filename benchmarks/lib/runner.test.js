/**
 * benchmark 编排单测（T5）：依赖全部注入（git/agent/verify/now），离线验证
 * 「准备 → 执行 → 防篡改重置 → 评分 → 清理」的顺序与失败分支。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  prepareCaseWorkspace,
  runCaseRecord,
  validateCase,
  scanRepoCommits,
  buildBenchScopeFix,
} from './runner.js';

const mkCase = (over = {}) => ({
  id: 'c-unit',
  title: '单元题',
  type: 'bug',
  input: '按钮点了没反应',
  analysis: '',
  fixRef: 'fixabc1',
  baseRef: null,
  testFiles: ['a.test.js', 'b/b.test.js'],
  verifyCommand: '',
  tags: [],
  ...over,
});

function fakeGit({ revParseOk = true, addOk = true, overlayOk = true } = {}) {
  const calls = [];
  return {
    calls,
    git: {
      revParse: (repo, ref) => {
        calls.push(['revParse', ref]);
        return { ok: revParseOk, err: revParseOk ? '' : 'bad ref' };
      },
      addWorktree: (repo, dir, ref) => {
        calls.push(['addWorktree', ref]);
        return { ok: addOk, err: addOk ? '' : 'add failed' };
      },
      overlayFiles: (ws, ref, files) => {
        calls.push(['overlayFiles', ref, files.join(',')]);
        return { ok: overlayOk, err: overlayOk ? '' : 'overlay failed' };
      },
      removeWorktree: () => {
        calls.push(['removeWorktree']);
        return { ok: true };
      },
    },
  };
}

const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-unit-'));

test('prepareCaseWorkspace：基线 = fixRef^，随后植入判据；revParse 失败不进 worktree', async () => {
  const { calls, git } = fakeGit();
  const prep = await prepareCaseWorkspace({ case: mkCase(), repoDir: 'C:\\repo', wsRoot, git });
  assert.equal(prep.ok, true);
  assert.equal(prep.baseRef, 'fixabc1^', '缺省基线为 fixRef 的父提交');
  assert.deepEqual(calls.slice(0, 3), [
    ['revParse', 'fixabc1^'],
    ['addWorktree', 'fixabc1^'],
    ['overlayFiles', 'fixabc1', 'a.test.js,b/b.test.js'],
  ]);

  const bad = fakeGit({ revParseOk: false });
  const r = await prepareCaseWorkspace({ case: mkCase(), repoDir: 'C:\\repo', wsRoot, git: bad.git });
  assert.equal(r.ok, false);
  assert.match(r.error, /基线不可解析/);
  assert.equal(bad.calls.some((c) => c[0] === 'addWorktree'), false, '基线无效不得创建 worktree');
});

test('prepareCaseWorkspace：植入失败要回滚 worktree；baseRef 可显式覆盖', async () => {
  const bad = fakeGit({ overlayOk: false });
  const r = await prepareCaseWorkspace({ case: mkCase(), repoDir: 'C:\\repo', wsRoot, git: bad.git });
  assert.equal(r.ok, false);
  assert.match(r.error, /判据植入失败/);
  assert.ok(bad.calls.some((c) => c[0] === 'removeWorktree'), '植入失败必须清理残留');

  const ok = fakeGit();
  await prepareCaseWorkspace({ case: mkCase({ baseRef: 'parent00' }), repoDir: 'C:\\repo', wsRoot, git: ok.git });
  assert.deepEqual(ok.calls[0], ['revParse', 'parent00']);
});

test('runCaseRecord：prompt 含反馈与完成标准；评分前重置判据（防篡改）；跑完清理', async () => {
  const { calls, git } = fakeGit();
  const seen = {};
  const deps = {
    git,
    now: (() => {
      let t = 1000;
      return () => (t += 500);
    })(),
    agent: async ({ prompt, cwd, timeoutMs }) => {
      seen.prompt = prompt;
      seen.cwd = cwd;
      seen.timeoutMs = timeoutMs;
      return { toolCalls: 7, numTurns: 3, inputTokens: 1234, outputTokens: 56, costUsd: 0.12, isError: false, subtype: 'success' };
    },
    verify: async ({ cwd, command }) => {
      seen.verifyCwd = cwd;
      seen.command = command;
      return { ok: true, skipped: false, exitCode: 0, timedOut: false, durationMs: 9, summary: 'node --test 通过（9s）' };
    },
    agentTimeoutMs: 12345,
  };
  const rec = await runCaseRecord({ case: mkCase(), repoDir: 'C:\\repo', wsRoot, deps });

  assert.equal(rec.ok, true);
  assert.equal(rec.error, null);
  assert.deepEqual(rec.develop, { subtype: 'success', isError: false });
  assert.deepEqual(rec.metrics, { toolCalls: 7, numTurns: 3, inputTokens: 1234, outputTokens: 56, costUsd: 0.12, durationMs: 500 });
  assert.equal(rec.verify.summary, 'node --test 通过（9s）');
  assert.match(seen.prompt, /原始反馈：「按钮点了没反应」/);
  assert.match(seen.prompt, /【完成标准】[\s\S]*node --test a\.test\.js b\/b\.test\.js/, '完成标准 = 判据命令');
  assert.match(seen.prompt, /独立基准工作区/, '工作区说明在场');
  assert.equal(seen.timeoutMs, 12345);
  assert.equal(seen.command, 'node --test a.test.js b/b.test.js');
  const overlays = calls.filter((c) => c[0] === 'overlayFiles');
  assert.equal(overlays.length, 2, '植入 + 评分前重置各一次');
  assert.deepEqual(overlays[0], overlays[1], '重置用的是同一份 fixRef+testFiles');
  assert.ok(calls.some((c) => c[0] === 'removeWorktree'), '默认跑完清理工作树');
});

test('runCaseRecord：agent 抛错 → 不评分不重置、error 如实记录', async () => {
  const { calls, git } = fakeGit();
  let verifyCalled = false;
  const rec = await runCaseRecord({
    case: mkCase(),
    repoDir: 'C:\\repo',
    wsRoot,
    deps: {
      git,
      agent: async () => {
        throw new Error('额度爆了');
      },
      verify: async () => {
        verifyCalled = true;
        return { ok: true, skipped: false };
      },
    },
  });
  assert.equal(rec.ok, false);
  assert.match(rec.error, /agent 执行失败：额度爆了/);
  assert.equal(verifyCalled, false, 'agent 失败时不跑验证');
  assert.equal(calls.filter((c) => c[0] === 'overlayFiles').length, 1, '不重置判据');
  assert.ok(calls.some((c) => c[0] === 'removeWorktree'));
});

test('runCaseRecord：验证失败 → ok=false；验证被跳过 → 视为无效题并记 error；--keep 保留现场', async () => {
  const fail = await runCaseRecord({
    case: mkCase(),
    repoDir: 'C:\\repo',
    wsRoot,
    deps: {
      git: fakeGit().git,
      agent: async () => ({ toolCalls: 1, numTurns: 1, inputTokens: 1, outputTokens: 1, costUsd: null, isError: false, subtype: 'success' }),
      verify: async () => ({ ok: false, skipped: false, exitCode: 1, timedOut: false, durationMs: 5, summary: '失败' }),
    },
  });
  assert.equal(fail.ok, false);
  assert.equal(fail.verify.ok, false);

  const skipGit = fakeGit();
  const skip = await runCaseRecord({
    case: mkCase(),
    repoDir: 'C:\\repo',
    wsRoot,
    deps: {
      git: skipGit.git,
      keep: true,
      agent: async () => ({ toolCalls: 0, numTurns: null, inputTokens: 0, outputTokens: 0, costUsd: null, isError: false, subtype: 'success' }),
      verify: async () => ({ ok: true, skipped: true, reason: '未配置验证命令', summary: '未配置验证命令' }),
    },
  });
  assert.equal(skip.ok, false, 'skipped 不算通过');
  assert.match(skip.error, /验证被跳过/);
  assert.equal(skipGit.calls.some((c) => c[0] === 'removeWorktree'), false, '--keep 不清理');
});

test('validateCase：修复前失败=有效；通过/跳过/准备失败=无效', async () => {
  const mkDeps = (verifyImpl) => ({ git: fakeGit().git, verify: verifyImpl });

  const pass = await validateCase({
    case: mkCase(),
    repoDir: 'C:\\repo',
    wsRoot,
    deps: mkDeps(async () => ({ ok: true, skipped: false, summary: '已经通过了' })),
  });
  assert.equal(pass.valid, false);
  assert.equal(pass.why, 'already_passes');

  const fail = await validateCase({
    case: mkCase(),
    repoDir: 'C:\\repo',
    wsRoot,
    deps: mkDeps(async () => ({ ok: false, skipped: false, exitCode: 1, summary: '失败' })),
  });
  assert.equal(fail.valid, true);
  assert.equal(fail.why, 'ok');

  const skipped = await validateCase({
    case: mkCase(),
    repoDir: 'C:\\repo',
    wsRoot,
    deps: mkDeps(async () => ({ ok: true, skipped: true, reason: '命令不存在' })),
  });
  assert.equal(skipped.valid, false);
  assert.equal(skipped.why, 'skipped');

  const badPrep = await validateCase({
    case: mkCase(),
    repoDir: 'C:\\repo',
    wsRoot,
    deps: { git: fakeGit({ revParseOk: false }).git, verify: async () => assert.fail('不应执行') },
  });
  assert.equal(badPrep.valid, false);
  assert.equal(badPrep.why, 'prepare_failed');
});

test('scanRepoCommits：注入 runGit 解析候选；git 失败返回错误不抛', async () => {
  const stdout =
    '\x00h1\x1faaa1111\x1ffix(x): 修 bug\x1fp1\n5\t1\tsrc/a.js\n2\t0\tsrc/a.test.js\n' +
    '\x00h2\x1fbbb2222\x1ftest(x): 加测试\x1fp2\n1\t0\tsrc/b.test.js\n';
  const ok = await scanRepoCommits({ repoDir: 'C:\\repo', runGit: () => ({ ok: true, out: stdout }) });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.commits.map((c) => c.short), ['aaa1111'], '纯测试提交被候选判定过滤');

  const bad = await scanRepoCommits({ repoDir: 'C:\\repo', runGit: () => ({ ok: false, err: 'not a repo' }) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not a repo/);
});

test('buildBenchScopeFix：包含工作树路径与隔离纪律', () => {
  const s = buildBenchScopeFix('C:\\repo\\.bench-ws\\case-1');
  assert.match(s, /C:\\repo\\\.bench-ws\\case-1/);
  assert.match(s, /绝对不要修改该目录之外的任何文件/);
});

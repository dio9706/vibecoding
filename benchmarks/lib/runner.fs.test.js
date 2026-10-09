/**
 * benchmark 编排的真 git fs 级测试（T5）：临时仓库上验证
 * 「worktree 基线 → 判据植入 → 修复前必须失败 → 跑题通过 → 改测试作弊被判负 → 清理」全链。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runScript } from '../../src/integrations/shell.js';
import { makeGit, prepareCaseWorkspace, cleanupWorkspace, validateCase, runCaseRecord } from './runner.js';

// node --test 会给本进程注入 NODE_TEST_CONTEXT；被验证器再 spawn 的 `node --test <file>` 见到它会
// 「skipping running files」并**以 0 退出**（实验证实）——嵌套验证会假通过。本文件先摘掉，
// 让验证器拿到干净环境；生产 CLI（benchmarks/run.mjs）在测试运行器之外，本就不受影响。
delete process.env.NODE_TEST_CONTEXT;

/** 工作树文件比对：git 检出在 Windows 上可能做 CRLF 转换，语义与换行无关 */
const readText = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const BUGGY = 'export function add(a, b) { return a - b; }\n';
const FIXED = 'export function add(a, b) { return a + b; }\n';
const TEST_SRC = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from './calc.js';",
  "test('add 求和', () => { assert.equal(add(2, 3), 5); });",
  '',
].join('\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-fs-'));
const repo = path.join(tmp, 'repo');
const wsRoot = path.join(repo, '.bench-ws');
let fixRef = '';

const git = (args) => runScript('git', args, { shell: false, cwd: repo });
const must = (r, what) => {
  if (!r.ok) throw new Error(`${what} 失败：${r.err || r.msg}`);
  return r;
};

test.before(async () => {
  fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
  fs.mkdirSync(wsRoot, { recursive: true });
  must(await git(['init']), 'git init');
  must(await git(['config', 'user.email', 'bench@test']), 'git config email');
  must(await git(['config', 'user.name', 'bench']), 'git config name');
  must(await git(['config', 'commit.gpgsign', 'false']), 'git config gpgsign');
  fs.writeFileSync(path.join(repo, 'lib', 'calc.js'), BUGGY);
  must(await git(['add', '.']), 'git add base');
  must(await git(['commit', '-m', 'base: add 有 bug']), 'git commit base');
  fs.writeFileSync(path.join(repo, 'lib', 'calc.js'), FIXED);
  fs.writeFileSync(path.join(repo, 'lib', 'calc.test.js'), TEST_SRC);
  must(await git(['add', '.']), 'git add fix');
  must(await git(['commit', '-m', 'fix: add 改为求和 + 判据测试']), 'git commit fix');
  fixRef = must(await git(['rev-parse', 'HEAD']), 'rev-parse').out.trim();
});

test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const benchCase = (over = {}) => ({
  id: 'tmp-add-sum',
  title: '加法算错',
  type: 'bug',
  input: 'add(2,3) 结果是 -1，应该是 5',
  analysis: '',
  fixRef,
  baseRef: null,
  testFiles: ['lib/calc.test.js'],
  verifyCommand: '',
  tags: [],
  ...over,
});

test('准备：基线上是 buggy 实现、判据已植入；清理后目录消失', async () => {
  const gitOps = makeGit();
  const prep = await prepareCaseWorkspace({ case: benchCase(), repoDir: repo, wsRoot, git: gitOps });
  assert.equal(prep.ok, true, prep.error);
  assert.equal(readText(path.join(prep.dir, 'lib', 'calc.js')), BUGGY, '基线取父提交（bug 实现）');
  assert.equal(readText(path.join(prep.dir, 'lib', 'calc.test.js')), TEST_SRC, '判据取修复提交版本');
  await cleanupWorkspace({ repoDir: repo, wsDir: prep.dir, git: gitOps });
  assert.equal(fs.existsSync(prep.dir), false);
});

test('校验：修复前判据失败 → valid；基线即已修好 → already_passes 无效', async () => {
  const valid = await validateCase({ case: benchCase(), repoDir: repo, wsRoot, deps: {} });
  assert.equal(valid.valid, true, JSON.stringify(valid));

  const aware = await validateCase({ case: benchCase({ baseRef: fixRef }), repoDir: repo, wsRoot, deps: {} });
  assert.equal(aware.valid, false);
  assert.equal(aware.why, 'already_passes');
});

test('跑题：agent 真修好 → 通过（真 verify）；只改测试作弊 → 重置后判负', async () => {
  // 1) 正常修复：agent 把实现改对，真 runVerify 判 pass
  const rec = await runCaseRecord({
    case: benchCase(),
    repoDir: repo,
    wsRoot,
    deps: {
      agent: async ({ cwd }) => {
        fs.writeFileSync(path.join(cwd, 'lib', 'calc.js'), FIXED);
        return { toolCalls: 4, numTurns: 2, inputTokens: 100, outputTokens: 20, costUsd: 0.01, isError: false, subtype: 'success' };
      },
    },
  });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  assert.equal(rec.metrics.toolCalls, 4);
  assert.match(rec.verify.summary, /通过/);

  // 2) 作弊：只改测试不改实现 → 评分前重置判据 → 判负
  const cheat = await runCaseRecord({
    case: benchCase(),
    repoDir: repo,
    wsRoot,
    deps: {
      agent: async ({ cwd }) => {
        fs.writeFileSync(
          path.join(cwd, 'lib', 'calc.test.js'),
          "import { test } from 'node:test';\ntest('永远通过', () => {});\n",
        );
        return { toolCalls: 1, numTurns: 1, inputTokens: 10, outputTokens: 5, costUsd: null, isError: false, subtype: 'success' };
      },
    },
  });
  assert.equal(cheat.ok, false, '改测试作弊不得通过');
  assert.equal(cheat.verify.ok, false);
  assert.equal(fs.existsSync(path.join(wsRoot, 'tmp-add-sum')), false, '跑完默认清理工作树');
});

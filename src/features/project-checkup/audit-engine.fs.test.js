/**
 * 审计引擎的**免 LLM 路径**集成测试。
 *
 * 覆盖三条不发请求就能定论的早退分支——它们恰恰是最容易写错、又最省钱的部分：
 *   1. 指纹缓存命中 → 直接复用上次结果
 *   2. 取材判定「无法判断」（na）→ 不是满分
 *   3. 零候选 → 满分，且**不发请求**
 *
 * 真正的判定路径要调模型，不在单测里跑（那是 `npm run test:e2e` 的事，且要花额度）。
 * 这里用「recall 返回什么」驱动，把引擎的分支逻辑全部走到。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAudit } from './audit-engine.js';
import { collectEvidence } from './evidence/collect.js';

/** 一个最小 audit 维度声明。recall 由每个用例注入，用来驱动不同分支 */
function mkDim(recall, over = {}) {
  return {
    id: 'demo',
    label: '演示维度',
    source: '测试',
    engine: 'audit',
    fingerprintScope: 'sources',
    recall,
    rubric: {
      role: '你是审查员。', intro: 'i', criteria: 'c', examples: 'e', outputRule: 'o',
    },
    verdicts: { bad: { weight: 10, code: 'T1', severity: 'warn' }, ok: { weight: 0 } },
    scoring: { mode: 'absolute', maxDeduct: 100 },
    fix: 'advisory',
    ...over,
  };
}

const EVIDENCE = {
  files: [{ rel: 'a.js', text: 'x', measure: { total: 1, significant: 1 } }],
  exports: [],
  tracked: [],
  manifest: null,
  readme: null,
  conventions: '',
  isRepo: true,
  fingerprints: { sources: 'FP-SRC', manifest: 'FP-MAN', docs: 'FP-DOC', tracked: 'FP-TRK' },
};

test('指纹命中缓存时直接复用，不再取材也不发请求', async () => {
  let recallCalls = 0;
  const dim = mkDim(() => { recallCalls += 1; return []; });
  const cache = {
    fingerprint: 'FP-SRC',
    result: { score: 77, status: 'done', issues: [{ code: 'T1' }], verdictLog: [], reason: '' },
  };

  const r = await runAudit(dim, EVIDENCE, { cache });

  assert.equal(r.cached, true);
  assert.equal(r.score, 77);
  assert.equal(r.issues.length, 1);
  assert.equal(recallCalls, 0, '命中缓存就不该再走取材');
});

test('指纹变了就不复用缓存（否则改了代码还拿旧结论）', async () => {
  const dim = mkDim(() => []);
  const r = await runAudit(dim, EVIDENCE, {
    cache: { fingerprint: '别的指纹', result: { score: 1, status: 'done', issues: [] } },
  });
  assert.equal(r.cached, false);
  assert.equal(r.score, 100, '重新取材后零候选 → 满分');
});

test('force 能绕过命中的缓存', async () => {
  const dim = mkDim(() => []);
  const r = await runAudit(dim, EVIDENCE, {
    cache: { fingerprint: 'FP-SRC', result: { score: 1, status: 'done', issues: [] } },
    force: true,
  });
  assert.equal(r.cached, false);
  assert.equal(r.score, 100);
});

test('零候选 → 满分 done，且产出可缓存条目', async () => {
  const r = await runAudit(mkDim(() => []), EVIDENCE, {});
  assert.equal(r.status, 'done');
  assert.equal(r.score, 100);
  assert.equal(r.candidateCount, 0);
  assert.equal(r.batchCount, 0, '不该发起任何一批请求');
  assert.equal(r.cacheEntry.fingerprint, 'FP-SRC');
});

test('取材说「无法判断」时报 na，不是满分', async () => {
  // 这个区分很要紧：没有依赖清单的项目不该凭空拿到依赖健康满分并抬高总分
  const dim = mkDim(() => ({ candidates: [], na: '项目没有依赖清单' }));
  const r = await runAudit(dim, EVIDENCE, {});
  assert.equal(r.status, 'na');
  assert.equal(r.score, null);
  assert.equal(r.reason, '项目没有依赖清单');
  assert.equal(r.cacheEntry, null, 'na 不该被缓存固化');
});

test('吃源码指纹的维度在零源码文件时报 na（引擎级兜底，不必每个召回器各写一遍）', async () => {
  const r = await runAudit(mkDim(() => [{ file: 'a', line: 1, text: 't' }]), { ...EVIDENCE, files: [] }, {});
  assert.equal(r.status, 'na');
  assert.match(r.reason, /没有可分析的源码文件/);
});

test('召回器抛错只让本维度失败，且不产出缓存（失败不该被固化）', async () => {
  const dim = mkDim(() => { throw new Error('取材炸了'); });
  const r = await runAudit(dim, EVIDENCE, {});
  assert.equal(r.status, 'error');
  assert.match(r.reason, /取材失败：取材炸了/);
  assert.equal(r.cacheEntry, null);
});

test('partial / error 一律不产出缓存条目', async () => {
  for (const recall of [
    () => ({ candidates: [], na: 'x' }),
    () => { throw new Error('y'); },
  ]) {
    const r = await runAudit(mkDim(recall), EVIDENCE, {});
    assert.equal(r.cacheEntry, null, `${r.status} 不该被缓存`);
  }
});

test('collectEvidence 在非 git 目录上降级为目录遍历，并按 scope 给出四份指纹', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fs-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'export function f() { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n\n```bash\nnpm start\n```\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node a.js' }, dependencies: {} }));
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'nope');

    const ev = await collectEvidence(dir);

    assert.equal(ev.isRepo, false);
    assert.deepEqual(ev.files.map((f) => f.rel), ['a.js'], 'node_modules 必须被排除');
    assert.equal(ev.manifest.kind, 'npm');
    assert.equal(ev.manifest.scripts.start, 'node a.js');
    assert.equal(ev.readme.rel, 'README.md');
    assert.deepEqual(ev.exports.map((e) => e.name), ['f']);

    for (const k of ['sources', 'manifest', 'docs', 'tracked']) {
      assert.match(ev.fingerprints[k], /^[0-9a-f]{16}$/, `${k} 指纹形状不对`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectEvidence 跳过压缩/打包产物（它们一行几万字符，行级度量无意义）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fs-'));
  try {
    fs.writeFileSync(path.join(dir, 'real.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'lib.min.js'), 'var a=1;');
    fs.writeFileSync(path.join(dir, 'marked.umd.js'), 'var b=2;');
    fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vendor', 'third.js'), 'var c=3;');

    const ev = await collectEvidence(dir);
    assert.deepEqual(ev.files.map((f) => f.rel), ['real.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

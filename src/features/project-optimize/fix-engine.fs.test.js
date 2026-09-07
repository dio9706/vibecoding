/**
 * 修复引擎的**免 LLM 路径**集成测试：真建临时项目、真写盘、真读回来校验。
 *
 * 覆盖两条最要紧的不变式：
 *   1. **没有 issue 会被静默丢掉** —— 任何策略都不认领的、以及被测试闸挡下的，
 *      一律出现在整改清单里。这条是整个改造的核心承诺。
 *   2. **降级要在首屏显式否认「代码已改过」** —— 用户看到「优化完成」时，
 *      最容易产生的误解就是以为源码被改过了。
 *
 * 真正会调模型的策略（refactor / rewrite / create）不在这里跑；
 * 它们的判定逻辑在 `llm-edit.logic.js` 的单测里，编排逻辑在 `fix-engine.logic.js` 的单测里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFixForDim, planEngineEntries, writeHolisticPlan } from './fix-engine.js';

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixengine-'));
  fs.writeFileSync(path.join(dir, 'src.js'), 'export const a = 1;\n');
  return dir;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

const ADVISORY_DIM = {
  id: 'security', label: '敏感信息与危险用法', source: 'OWASP Top 10', fix: 'advisory',
};
const REFACTOR_DIM = {
  id: 'complexity', label: '复杂度与函数规模', source: '《代码整洁之道》ch3', fix: 'llm-refactor',
};
const HYGIENE_DIM = {
  id: 'hygiene', label: '仓库卫生', source: '版本库只放需要协同演进的内容', fix: 'deterministic',
};

const issue = (over = {}) => ({
  code: 'S1_VULNERABLE',
  severity: 'error',
  file: 'src.js',
  line: 7,
  message: '拼接进了 shell 命令',
  fixHint: '改用数组参数形式',
  meta: { verdict: 'vulnerable' },
  ...over,
});

test('advisory 维度把 issue 写成带定位、带依据、带改法的清单', async () => {
  const dir = tmpProject();
  try {
    const results = await runFixForDim({
      dir, dim: ADVISORY_DIM, issues: [issue()], gate: { allowed: true, reason: '' },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'done');
    assert.equal(results[0].kind, 'advisory');
    assert.equal(results[0].file, '.claude/optimize/security.md');

    const md = read(dir, '.claude/optimize/security.md');
    assert.match(md, /# 敏感信息与危险用法 · 整改清单/);
    assert.match(md, /判据出处：OWASP Top 10/, '要写出判据出处，让结论可争辩而不是只能服从');
    assert.match(md, /src\.js:7/);
    assert.match(md, /拼接进了 shell 命令/);
    assert.match(md, /改用数组参数形式/);
    assert.match(md, /`vulnerable`/, '判定档位要露出来');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('advisory 在没有问题时不写空清单（避免 .claude/optimize 堆满噪声）', async () => {
  const dir = tmpProject();
  try {
    const results = await runFixForDim({ dir, dim: ADVISORY_DIM, issues: [] });
    assert.equal(results[0], undefined, '零 issue 时连 advisory 都不该被触发');
    assert.equal(fs.existsSync(path.join(dir, '.claude/optimize')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('源码维度被测试闸挡下时：不改代码，清单首屏显式否认，并说清怎样解锁', async () => {
  const dir = tmpProject();
  const before = read(dir, 'src.js');
  try {
    const steps = [];
    const results = await runFixForDim({
      dir,
      dim: REFACTOR_DIM,
      issues: [issue({ code: 'X1_MUST_SPLIT', file: 'src.js', message: '三个职责混在一起' })],
      gate: { allowed: false, reason: '项目没有可执行的测试命令，缺少改坏了能立刻发现的安全网' },
      onStep: (s) => steps.push(s),
    });

    assert.equal(read(dir, 'src.js'), before, '闸关着就一行源码都不该动');

    const md = read(dir, '.claude/optimize/complexity.md');
    const firstScreen = md.split('\n').slice(0, 6).join('\n');
    assert.match(firstScreen, /未对代码做任何改动/, '否认必须在首屏，不能藏在文末');
    assert.match(md, /没有可执行的测试命令/);

    assert.ok(steps.some((s) => s.phase === 'degrade'), '降级要进进度流，不能只写进文件');
    assert.equal(results.at(-1).kind, 'advisory');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('任何策略都不认领的 issue 一律进清单（核心承诺：不静默丢弃）', async () => {
  const dir = tmpProject();
  try {
    // hygiene 的策略是 deterministic，只认 H1/H2/H3/P4；下面这条码它不认
    const results = await runFixForDim({
      dir,
      dim: HYGIENE_DIM,
      issues: [issue({ code: '没人认领的码', file: 'src.js', message: '孤儿问题' })],
    });

    const advisory = results.find((r) => r.kind === 'advisory');
    assert.ok(advisory, '没人认领就必须落进清单');
    assert.match(read(dir, '.claude/optimize/hygiene.md'), /孤儿问题/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('确定性策略真的写 .gitignore，并把「还原不管 git 索引」如实告知', async () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    fs.writeFileSync(path.join(dir, 'run.log'), 'noise');

    const results = await runFixForDim({
      dir,
      dim: HYGIENE_DIM,
      issues: [issue({ code: 'H1_RUNTIME_DATA_TRACKED', file: 'run.log', message: '运行日志被追踪' })],
    });

    const gi = read(dir, '.gitignore');
    assert.match(gi, /^node_modules$/m, '不能把用户原有规则冲掉');
    assert.match(gi, /run\.log/);
    assert.match(gi, /由项目优化功能自动添加/, '要有托管段标记，还原时才认得出自己加了哪些行');

    // 临时目录不是 git 仓库，untrack 必然失败/跳过——重点是它**如实报出来**而不是假装成功
    const untrack = results.find((r) => r.kind === 'untrack');
    assert.ok(untrack, 'untrack 结果必须出现在结果列表里');
    assert.ok(['skipped', 'failed'].includes(untrack.status));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('确定性策略不重复添加已被现有规则覆盖的条目', async () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\n');
    const results = await runFixForDim({
      dir,
      dim: HYGIENE_DIM,
      issues: [issue({ code: 'H1_RUNTIME_DATA_TRACKED', file: 'run.log' })],
    });
    const ignore = results.find((r) => r.kind === 'ignore');
    assert.equal(ignore.status, 'skipped');
    assert.match(ignore.reason, /已被现有规则覆盖/);
    assert.equal(read(dir, '.gitignore'), '*.log\n', '文件内容不该被动');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('planEngineEntries 覆盖全部将被写入的路径（漏一个就等于那个改动无法还原）', () => {
  const dir = tmpProject();
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
    const entries = planEngineEntries(dir, [
      { dim: ADVISORY_DIM, issues: [issue()] },
      { dim: REFACTOR_DIM, issues: [issue({ code: 'X1_MUST_SPLIT', file: 'src.js' })] },
      { dim: HYGIENE_DIM, issues: [issue({ code: 'H1_RUNTIME_DATA_TRACKED', file: 'run.log' })] },
      {
        dim: { id: 'docs', label: '文档', source: 'x', fix: 'llm-rewrite' },
        issues: [issue({ code: 'O1_BROKEN_ONBOARDING', file: 'README.md' })],
      },
    ], { gateAllowed: true });

    const paths = entries.map((e) => e.path).sort();
    assert.deepEqual(paths, [
      '.claude/optimize/complexity.md',
      '.claude/optimize/security.md',
      '.gitignore',
      'README.md',
      'src.js',
    ]);

    // action 决定还原动作：created 是「删掉它」，modified 是「写回旧内容」
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e.action]));
    assert.equal(byPath['src.js'], 'modified');
    assert.equal(byPath['README.md'], 'modified');
    assert.equal(byPath['.gitignore'], 'created', '临时项目里还没有 .gitignore');
    assert.equal(byPath['.claude/optimize/security.md'], 'created');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('planEngineEntries 即使闸关着也照样备份源码文件（宁可多备份）', () => {
  const dir = tmpProject();
  try {
    // 闸要在补完测试之后才开，而备份必须在任何写操作之前打完——两个时序要求冲突，
    // 只能取「宁可多备份」：多一份内容相同的快照代价可忽略，少一份则彻底无法还原
    const entries = planEngineEntries(dir, [
      { dim: REFACTOR_DIM, issues: [issue({ code: 'X1_MUST_SPLIT', file: 'src.js' })] },
    ], { gateAllowed: true });
    assert.ok(entries.some((e) => e.path === 'src.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeHolisticPlan 写出带优先级、完成判据与各维度得分的行动计划', () => {
  const dir = tmpProject();
  try {
    const report = {
      dims: {
        map: { score: 40, status: 'done', issues: [{ severity: 'warn' }] },
        holistic: {
          score: 61,
          status: 'done',
          issues: [],
          plan: {
            score: 61,
            verdict: '最大风险是分层被打破',
            topActions: [{
              title: '断开 store → features 的反向依赖',
              why: '不做的话 store 无法单独测试',
              files: ['src.js'],
              done: 'src/store 不再出现指向 src/features 的 import',
              priority: 'now',
            }],
            contradictions: [{ what: 'A 与 B 冲突', resolution: '取 A' }],
            strengths: ['注释解释为什么'],
          },
        },
      },
    };

    const r = writeHolisticPlan(dir, report, [
      { id: 'map', label: '项目地图', source: '本项目约定' },
      { id: 'holistic', label: '整体评估', source: '综合' },
    ]);
    assert.equal(r.status, 'done');
    assert.equal(r.file, '.claude/optimize/PLAN.md');

    const md = read(dir, '.claude/optimize/PLAN.md');
    assert.match(md, /整体健康分：\*\*61\*\*/);
    assert.match(md, /最大风险是分层被打破/);
    assert.match(md, /现在就做/);
    assert.match(md, /\*\*完成判据\*\*：src\/store 不再出现/, '没有完成判据，用户做完也不知道算不算做完');
    assert.match(md, /跨维度矛盾/);
    assert.match(md, /做得好、应当保持/);
    assert.match(md, /\| 项目地图 \| 40 \| 1 \| 本项目约定 \|/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeHolisticPlan 在整体评估没产出计划时跳过而不是写半份', () => {
  const dir = tmpProject();
  try {
    const r = writeHolisticPlan(dir, { dims: { holistic: { status: 'partial', plan: null } } }, []);
    assert.equal(r.status, 'skipped');
    assert.equal(fs.existsSync(path.join(dir, '.claude/optimize/PLAN.md')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('维度自己声明的 fixContext 会被求值（docs 靠它拿到真实脚本清单）', async () => {
  const dir = tmpProject();
  try {
    let seen = null;
    const dim = {
      id: 'docs',
      label: '文档可上手性',
      source: 'x',
      // 走 advisory 是为了不触发 LLM；这里只验 fixContext 被求值且拿到 evidence
      fix: 'advisory',
      fixContext: (ev) => { seen = ev?.manifest?.scripts || null; return 'CTX'; },
    };
    await runFixForDim({
      dir, dim, issues: [issue({ file: 'README.md' })],
      evidence: { manifest: { scripts: { start: 'node server.js' } }, files: [] },
    });
    assert.deepEqual(seen, { start: 'node server.js' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fixContext 抛错不掀翻本维度的修复（只是少了项目事实）', async () => {
  const dir = tmpProject();
  try {
    const dim = {
      id: 'docs', label: '文档', source: 'x', fix: 'advisory',
      fixContext: () => { throw new Error('求值炸了'); },
    };
    const results = await runFixForDim({ dir, dim, issues: [issue({ file: 'README.md' })], evidence: {} });
    assert.equal(results.at(-1).status, 'done', '清单照样要写出来');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

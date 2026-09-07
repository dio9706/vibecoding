import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRecall, buildSystemPrompt, buildPrompt, validateVerdicts,
  reanchor, scoreOf, evaluateAudit, chunk, mergeAugmentDim,
} from './audit-engine.logic.js';

/** 一个最小维度声明，覆盖「有扣分档 + 有免扣档」两类 verdict */
const DIM = {
  id: 'demo',
  fix: 'llm-refactor',
  verdicts: {
    bad: { weight: 10, code: 'T1_BAD', severity: 'error' },
    meh: { weight: 4, code: 'T2_MEH', severity: 'warn' },
    ok: { weight: 0 },
  },
  scoring: { mode: 'absolute', maxDeduct: 100 },
  rubric: {
    role: '你是测试审查员。',
    intro: '下面是候选。',
    criteria: '- `bad`：坏\n- `ok`：好',
    examples: '### 示例 A\nverdict: `bad`',
    outputRule: '- reason 必须具体。',
  },
};

const cands = [
  { file: 'a.js', line: 1, text: 'AAA', meta: { kind: 'unit' } },
  { file: 'b.js', line: 2, text: 'BBB', meta: { kind: 'unit' } },
];

test('normalizeRecall 同时接受裸数组与对象形式', () => {
  assert.deepStrictEqual(normalizeRecall([1, 2]), { candidates: [1, 2], sharedContext: '', na: null });
  assert.deepStrictEqual(
    normalizeRecall({ candidates: [1], sharedContext: 'ctx', na: '无法判断' }),
    { candidates: [1], sharedContext: 'ctx', na: '无法判断' },
  );
  assert.deepStrictEqual(normalizeRecall(null), { candidates: [], sharedContext: '', na: null });
});

test('buildSystemPrompt 带上角色与「你没有任何工具」纪律', () => {
  const sp = buildSystemPrompt(DIM.rubric);
  assert.equal(sp.type, 'custom');
  assert.ok(sp.custom.includes('你是测试审查员'));
  assert.ok(sp.custom.includes('没有任何工具'));
  assert.ok(sp.custom.includes('不要 markdown 代码围栏'));
});

test('buildPrompt 要求对象包数组、列全词表、并区分扣分与免扣档', () => {
  const p = buildPrompt({ dim: DIM, batch: cands });
  assert.ok(p.includes('{"verdicts":['), '必须要求对象包数组，裸数组会被 JSON 提取截断');
  assert.ok(p.includes('`bad` / `meh` / `ok`'));
  assert.ok(p.includes('写成别的值会让这一整批判定全部作废'));
  assert.ok(p.includes('只有 `bad` / `meh` 会被计入扣分'));
  assert.ok(p.includes('`ok` 不扣分'));
  assert.ok(p.includes('共 2 条'));
  assert.ok(p.includes('file=a.js line=1'));
});

test('buildPrompt 有共享上下文时把它插在判据之前', () => {
  const p = buildPrompt({ dim: DIM, batch: cands, sharedContext: '## 项目约定\n\nA → B' });
  assert.ok(p.indexOf('## 项目约定') < p.indexOf('## 判定口径'));
});

test('validateVerdicts 条数不等即整批作废', () => {
  const names = Object.keys(DIM.verdicts);
  assert.equal(validateVerdicts({ verdicts: [{ line: 1, verdict: 'bad' }] }, 2, names), null);
  assert.ok(validateVerdicts({ verdicts: [{ line: 1, verdict: 'bad' }, { line: 2, verdict: 'ok' }] }, 2, names));
});

test('validateVerdicts 拒绝词表外的 verdict 与非法 line', () => {
  const names = Object.keys(DIM.verdicts);
  assert.equal(validateVerdicts({ verdicts: [{ line: 1, verdict: 'nope' }] }, 1, names), null);
  assert.equal(validateVerdicts({ verdicts: [{ line: 'x', verdict: 'bad' }] }, 1, names), null);
  assert.equal(validateVerdicts({ verdicts: 'not-an-array' }, 1, names), null);
  assert.equal(validateVerdicts(null, 1, names), null);
});

test('reanchor 以本地候选表为准覆盖模型回填的 file', () => {
  const out = reanchor([{ file: '拼错了.js', line: 2, verdict: 'bad', reason: 'r' }], cands);
  assert.equal(out[0].file, 'b.js', '应按 line 命中本地候选并覆盖 file');
  assert.equal(out[0].candidate.text, 'BBB');
});

test('reanchor 在 file 与 line 都对不上时按索引兜底', () => {
  const out = reanchor([{ file: 'zzz', line: 999, verdict: 'bad' }], cands);
  assert.equal(out[0].file, 'a.js');
});

test('scoreOf 的 absolute 模式按条数与严重度扣分，并受上限约束', () => {
  assert.equal(scoreOf(DIM, [{ verdict: 'ok' }], 100), 100);
  assert.equal(scoreOf(DIM, [{ verdict: 'bad' }, { verdict: 'meh' }], 100), 86);
  const many = Array.from({ length: 20 }, () => ({ verdict: 'bad' }));
  assert.equal(scoreOf(DIM, many, 100), 0, '200 分扣分应被 maxDeduct=100 截到 0');
});

test('scoreOf 的 density 模式按每文件密度扣分，大项目不因规模被误判', () => {
  const dim = { ...DIM, scoring: { mode: 'density', factor: 40, maxDeduct: 70 } };
  const ten = Array.from({ length: 10 }, () => ({ verdict: 'bad' })); // 权重合计 100
  // 同样 10 条问题：20 个文件的项目扣满上限，500 个文件的项目只扣 8 分
  assert.equal(scoreOf(dim, ten, 20), 30);
  assert.equal(scoreOf(dim, ten, 500), 92);
});

test('evaluateAudit 的 na 优先于一切（无法判断 ≠ 满分）', () => {
  const r = evaluateAudit({ dim: DIM, candidates: [], na: '没有依赖清单' });
  assert.equal(r.status, 'na');
  assert.equal(r.score, null);
  assert.equal(r.reason, '没有依赖清单');
});

test('evaluateAudit 零候选 → 满分 done（查过了，没有可疑项）', () => {
  const r = evaluateAudit({ dim: DIM, candidates: [], verdicts: null });
  assert.equal(r.status, 'done');
  assert.equal(r.score, 100);
});

test('evaluateAudit 有候选但判定失败 → partial 且分数留空', () => {
  const r = evaluateAudit({ dim: DIM, candidates: cands, verdicts: null });
  assert.equal(r.status, 'partial');
  assert.equal(r.score, null);
  assert.ok(r.reason.includes('2 条候选未判'));
});

test('evaluateAudit 只把扣分档变成 issue，免扣档只进 verdictLog', () => {
  const verdicts = reanchor([
    { file: 'a.js', line: 1, verdict: 'bad', reason: '会静默失败', suggestion: '重抛' },
    { file: 'b.js', line: 2, verdict: 'ok', reason: '合理' },
  ], cands);
  const r = evaluateAudit({ dim: DIM, candidates: cands, verdicts, fileCount: 100 });

  assert.equal(r.status, 'done');
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].code, 'T1_BAD');
  assert.equal(r.issues[0].severity, 'error');
  assert.equal(r.issues[0].message, '会静默失败');
  assert.equal(r.issues[0].fixHint, '重抛');
  assert.equal(r.issues[0].fixable, true, 'fix 策略非 advisory → 可自动修');
  assert.equal(r.issues[0].meta.verdict, 'bad');
  assert.equal(r.issues[0].meta.kind, 'unit', '候选的 meta 应并进 issue');

  assert.equal(r.verdictLog.length, 2, '全部判定都要留档，含免扣档');
  assert.deepStrictEqual(r.verdictLog.map((v) => v.verdict), ['bad', 'ok']);
});

test('evaluateAudit 在 advisory 维度上把 issue 标为不可自动修', () => {
  const verdicts = reanchor([{ file: 'a.js', line: 1, verdict: 'bad', reason: 'r' }], [cands[0]]);
  const r = evaluateAudit({
    dim: { ...DIM, fix: 'advisory' },
    candidates: [cands[0]],
    verdicts,
    fileCount: 10,
  });
  assert.equal(r.issues[0].fixable, false);
});

test('chunk 按批大小切分且不丢条目', () => {
  assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepStrictEqual(chunk([], 3), []);
});

test('mergeAugmentDim 拼接 issue 并把补充层的扣分累加到宿主分上', () => {
  const merged = mergeAugmentDim(
    { score: 90, status: 'done', issues: [{ code: 'H1' }], verdictLog: [], reason: '' },
    { score: 82, status: 'done', issues: [{ code: 'H3' }], verdictLog: [{ verdict: 'keep' }] },
  );
  assert.equal(merged.score, 72, '宿主 90 减去补充层的 18 分扣分');
  assert.deepStrictEqual(merged.issues.map((i) => i.code), ['H1', 'H3']);
  assert.equal(merged.verdictLog.length, 1);
});

test('mergeAugmentDim 在补充层没跑成时保留宿主结论，但说明召回可能不全', () => {
  const merged = mergeAugmentDim(
    { score: 100, status: 'done', issues: [], reason: '' },
    { score: null, status: 'partial', issues: [] },
  );
  assert.equal(merged.score, 100);
  assert.ok(merged.reason.includes('召回可能不完整'), '满分必须说明是否完整检查过');
});

test('mergeAugmentDim 在宿主无分（非 git 仓库）时不硬凑分数', () => {
  const merged = mergeAugmentDim(
    { score: null, status: 'na', issues: [], reason: '不是 git 仓库' },
    { score: 90, status: 'done', issues: [{ code: 'H3' }] },
  );
  assert.equal(merged.score, null);
  assert.equal(merged.status, 'na');
  assert.equal(merged.issues.length, 1);
});

test('mergeAugmentDim 不原地改写宿主（调用方可能还持有它）', () => {
  const host = { score: 90, status: 'done', issues: [], verdictLog: [] };
  mergeAugmentDim(host, { score: 80, status: 'done', issues: [{ code: 'H3' }] });
  assert.equal(host.score, 90);
  assert.equal(host.issues.length, 0);
});

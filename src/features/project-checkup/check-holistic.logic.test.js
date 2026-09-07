import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  outlineOf, summarizeDims, buildHolisticPrompt, buildBusinessContext, validatePlan, evaluateHolistic,
} from './check-holistic.logic.js';

const REGISTRY = [
  { id: 'map', label: '项目地图', source: '本项目约定', weight: 10 },
  { id: 'security', label: '敏感信息', source: 'OWASP Top 10', weight: 6 },
  { id: 'hygiene-audit', label: '深化', source: '同 hygiene', augments: 'hygiene' },
  { id: 'holistic', label: '整体评估', source: '综合' },
];

test('outlineOf 按前两段路径聚合并按文件数降序', () => {
  const out = outlineOf([
    { rel: 'src/features/a.js' }, { rel: 'src/features/b.js' },
    { rel: 'public/js/c.js' }, { rel: 'server.js' },
  ]);
  const lines = out.split('\n');
  assert.equal(lines[0], '- src/features（2 个源文件）');
  assert.ok(out.includes('- public/js（1 个源文件）'));
  assert.ok(out.includes('- server.js（1 个源文件）'));
});

test('summarizeDims 带上判据出处与权重，并跳过 holistic 与 augment 条目', () => {
  const s = summarizeDims({
    map: { score: 40, status: 'done', issues: [{ severity: 'warn', file: 'a.md', line: 1, message: '地图过期' }] },
    security: { score: null, status: 'partial', issues: [] },
    'hygiene-audit': { score: 90, status: 'done', issues: [] },
    holistic: { score: 70, status: 'done', issues: [] },
  }, REGISTRY);

  assert.ok(s.includes('判据出处：OWASP Top 10'));
  assert.ok(s.includes('总分权重 10'));
  assert.ok(s.includes('无分（partial）'));
  assert.ok(!s.includes('整体评估'), 'holistic 不该出现在自己的输入里');
  assert.ok(!s.includes('同 hygiene'), 'augment 条目不单独成段');
});

test('summarizeDims 超过上限的 issue 折叠成一行', () => {
  const issues = Array.from({ length: 9 }, (_, i) => ({ severity: 'info', file: 'a.js', line: i, message: 'm' }));
  const s = summarizeDims({ map: { score: 10, status: 'done', issues } }, REGISTRY);
  assert.ok(s.includes('还有 5 条同类问题'));
});

test('buildHolisticPrompt 明确要求可验证的完成判据，并禁止元动作', () => {
  const p = buildHolisticPrompt({ dimsSummary: 'S', outline: 'O', dir: 'D' });
  assert.ok(p.includes('可验证的完成判据'));
  assert.ok(p.includes('为什么是现在做'));
  assert.ok(p.includes('不要把「跑一次体检」'));
  assert.ok(p.includes('now / next / later'));
  assert.ok(p.includes('项目路径：D'));
});

test('validatePlan 归一优先级、裁剪数量、并对分数做区间约束', () => {
  const plan = validatePlan({
    score: 250,
    verdict: '还行',
    topActions: [
      { title: 'A', why: 'w', done: 'd', priority: 'now', files: ['a.js'] },
      { title: 'B', why: 'w', done: 'd', priority: '乱写的' },
      ...Array.from({ length: 6 }, (_, i) => ({ title: `X${i}`, priority: 'later' })),
    ],
    contradictions: [{ what: 'c1', resolution: 'r1' }, { what: '' }],
    strengths: ['好一点', ''],
  });

  assert.equal(plan.score, 100, '越界分数应被截到 100');
  assert.equal(plan.topActions.length, 5, '最多 5 条');
  assert.equal(plan.topActions[1].priority, 'next', '非法优先级归一为 next');
  assert.deepStrictEqual(plan.contradictions, [{ what: 'c1', resolution: 'r1' }]);
  assert.deepStrictEqual(plan.strengths, ['好一点']);
});

test('validatePlan 在没有任何完整 action 时返回 null（这一维就没产出）', () => {
  assert.equal(validatePlan({ score: 80, topActions: [] }), null);
  assert.equal(validatePlan({ score: 80, topActions: [{ why: '缺 title' }] }), null);
  assert.equal(validatePlan(null), null);
});

test('validatePlan 不因个别 action 字段不全就作废全批（计划的价值是可分的）', () => {
  const plan = validatePlan({
    score: 60,
    topActions: [{ title: '完整的', why: 'w', done: 'd', priority: 'now' }, { nothing: 1 }],
  });
  assert.equal(plan.topActions.length, 1);
  assert.equal(plan.topActions[0].title, '完整的');
});

test('evaluateHolistic 把 action 与矛盾都变成 issue，verdict 进 reason', () => {
  const r = evaluateHolistic({
    score: 68,
    verdict: '最大风险是分层被打破',
    topActions: [
      { title: '断开反向依赖', why: '不做的话 store 无法单测', done: 'store 不再 import features', priority: 'now', files: ['src/store/a.js'] },
      { title: '补测试', why: '为重构解锁', done: 'npm test 全绿', priority: 'next', files: [] },
    ],
    contradictions: [{ what: 'prompts 要求补说明而 docs 判定过载', resolution: '把说明下沉为 skill' }],
    strengths: ['注释解释为什么'],
  });

  assert.equal(r.status, 'done');
  assert.equal(r.score, 68);
  assert.equal(r.reason, '最大风险是分层被打破');
  assert.equal(r.issues.length, 3);

  assert.equal(r.issues[0].severity, 'error', 'now → error');
  assert.equal(r.issues[0].file, 'src/store/a.js');
  assert.ok(r.issues[0].message.includes('为什么现在做'));
  assert.ok(r.issues[0].fixHint.includes('完成判据'));

  assert.equal(r.issues[1].severity, 'warn', 'next → warn');
  assert.equal(r.issues[1].file, '.', '没给文件时用 . 兜底，issue 仍可渲染');

  const contra = r.issues.find((i) => i.meta.kind === 'contradiction');
  assert.equal(contra.fixable, false, '矛盾要人拍板，不可自动修');
  assert.equal(contra.fixHint, '把说明下沉为 skill');
});

test('evaluateHolistic 在计划缺失时报 partial 并带上失败原因', () => {
  const r = evaluateHolistic(null, 'AI 整体评估超时未返回');
  assert.equal(r.status, 'partial');
  assert.equal(r.score, null);
  assert.equal(r.reason, 'AI 整体评估超时未返回');
  assert.equal(r.plan, null);
});


// ---------- 业务个性化：这一维的价值在于「只对这个项目成立」的判断 ----------

test('buildBusinessContext 四段材料各就各位（对外是什么/内部怎么分工/怎么跑/技术域）', () => {
  const ctx = buildBusinessContext({
    readme: { rel: 'README.md', text: '# Principal\n把 headless Claude 搬进网页。' },
    conventions: '## 项目定位\n后端常驻执行、状态落盘。',
    manifest: {
      scripts: { start: 'node server.js' },
      deps: { '@anthropic-ai/claude-agent-sdk': '^1', '@larksuiteoapi/node-sdk': '^1' },
    },
  });
  assert.match(ctx, /先读懂这个项目是做什么的/);
  assert.match(ctx, /把 headless Claude 搬进网页/);
  assert.match(ctx, /后端常驻执行、状态落盘/);
  assert.match(ctx, /start → node server\.js/);
  // 依赖能透露目录名看不出来的外部集成——飞书就是这样被发现的
  assert.match(ctx, /@larksuiteoapi\/node-sdk/);
});

test('buildBusinessContext 一份材料都没有时如实说明，不让模型在空白上编业务', () => {
  const ctx = buildBusinessContext({});
  assert.match(ctx, /请用 Read \/ Glob 自行探明/);
});

test('buildHolisticPrompt 把业务语境插在维度结论之前，并禁止通用建议', () => {
  const p = buildHolisticPrompt({ dimsSummary: 'DIMS', outline: 'O', dir: 'D', business: 'BIZ' });
  assert.ok(p.indexOf('BIZ') < p.indexOf('DIMS'), '先读业务再看扫描结论，顺序即引导');
  assert.match(p, /businessRead/);
  assert.match(p, /businessRisks/);
  assert.match(p, /禁止写「提高可维护性」/);
  assert.match(p, /换个项目也照样成立，那它就不该出现在这里/);
});

test('validatePlan 收下业务理解与业务风险，并过滤空条目', () => {
  const plan = validatePlan({
    businessRead: '这是个长时任务执行台。',
    score: 70,
    verdict: 'v',
    businessRisks: [
      { what: '关键状态只存内存而进程会重启', evidence: 'src/store/runs.js' },
      { what: '', evidence: 'x' },
    ],
    topActions: [{ title: 'A', why: 'w', done: 'd', priority: 'now' }],
  });
  assert.equal(plan.businessRead, '这是个长时任务执行台。');
  assert.deepEqual(plan.businessRisks, [{ what: '关键状态只存内存而进程会重启', evidence: 'src/store/runs.js' }]);
});

test('validatePlan 缺业务字段时不作废整份计划（topActions 仍然可用）', () => {
  const plan = validatePlan({ score: 70, topActions: [{ title: 'A', why: 'w', done: 'd', priority: 'now' }] });
  assert.ok(plan);
  assert.equal(plan.businessRead, '');
  assert.deepEqual(plan.businessRisks, []);
});

test('evaluateHolistic 把业务风险单独成 issue，且业务理解排在 reason 最前', () => {
  const r = evaluateHolistic({
    businessRead: '长时任务执行台，最怕任务静默消失。',
    score: 70,
    verdict: '最大风险是可观测性。',
    businessRisks: [{ what: '长时任务没有中断点', evidence: 'src/entrypoints/web/run-claude.js' }],
    topActions: [{ title: 'A', why: 'w', done: 'd', priority: 'now', files: [] }],
    contradictions: [],
    strengths: [],
  });

  const risk = r.issues.find((i) => i.meta.kind === 'business-risk');
  assert.ok(risk, '业务风险要单独成 issue，不能混进 action');
  assert.equal(risk.file, 'src/entrypoints/web/run-claude.js', 'evidence 要能点开定位');
  assert.equal(risk.fixable, false, '业务风险的处置是设计决策');
  assert.match(risk.message, /业务风险：长时任务没有中断点/);

  assert.ok(r.reason.startsWith('长时任务执行台'), '业务理解要在最前，卡片副标题就是它');
  assert.match(r.reason, /最大风险是可观测性/);
});

test('evaluateHolistic 接受不带 businessRisks 的 plan（防御外部构造）', () => {
  const r = evaluateHolistic({
    score: 60, verdict: 'v', topActions: [{ title: 'A', why: 'w', done: 'd', priority: 'now', files: [] }],
    contradictions: [], strengths: [],
  });
  assert.equal(r.status, 'done');
  assert.equal(r.issues.length, 1);
});

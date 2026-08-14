import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideVerdict, parseReviewJson, buildReviewPrompt } from './logic.js';

const base = { belongs: true, evidence: 'src/pay.js 存在支付模块', confidence: 0.9, reasons: 'ok' };

test('decideVerdict：解析失败 → ask（保守兜底）', () => {
  assert.equal(decideVerdict(null).verdict, 'ask');
  assert.equal(decideVerdict('x').verdict, 'ask');
});

test('decideVerdict：非本项目或证据为空 → reject', () => {
  assert.equal(decideVerdict({ ...base, belongs: false }).verdict, 'reject');
  assert.equal(decideVerdict({ ...base, evidence: '  ' }).verdict, 'reject');
});

test('decideVerdict：置信度不足 → ask（含缺失/NaN）', () => {
  assert.equal(decideVerdict({ ...base, confidence: 0.5 }).verdict, 'ask');
  assert.equal(decideVerdict({ ...base, confidence: undefined }).verdict, 'ask');
  assert.equal(decideVerdict({ ...base, confidence: 'high' }).verdict, 'ask');
});

test('decideVerdict：bug 定位成功 → fix；未定位 → ask（绝不自动修）', () => {
  assert.equal(decideVerdict({ ...base, type: 'bug', located: true }).verdict, 'fix');
  const r = decideVerdict({ ...base, type: 'bug', located: false });
  assert.equal(r.verdict, 'ask');
  assert.match(r.reason, /定位/);
});

test('decideVerdict：需求收益 ≥ 复杂度 → plan；不足 → ask 附理由', () => {
  assert.equal(decideVerdict({ ...base, type: 'feature', benefit: 3, complexity: 3 }).verdict, 'plan');
  assert.equal(decideVerdict({ ...base, type: 'feature', benefit: 5, complexity: 2 }).verdict, 'plan');
  const r = decideVerdict({ ...base, type: 'feature', benefit: 1, complexity: 5, counterArgument: '牵一发动全身' });
  assert.equal(r.verdict, 'ask');
  assert.match(r.reason, /复杂度\(5\/5\).*收益\(1\/5\)/);
  assert.match(r.reason, /牵一发动全身/);
});

test('decideVerdict：需求打分缺失 → ask', () => {
  assert.equal(decideVerdict({ ...base, type: 'feature', benefit: undefined, complexity: 2 }).verdict, 'ask');
});

test('parseReviewJson：取最后一个合法 JSON、容忍前后杂讯、失败返回 null', () => {
  assert.deepEqual(parseReviewJson('思考中… {"a":1} 最终 {"belongs":true}'), { belongs: true });
  assert.equal(parseReviewJson('没有 json'), null);
  assert.equal(parseReviewJson(''), null);
  assert.equal(parseReviewJson(null), null);
});

test('buildReviewPrompt：含反方论证要求与判例块；bug/需求要求不同', () => {
  const bugPrompt = buildReviewPrompt({ type: 'bug', detail: '登录白屏' }, { projectDir: 'C:/p' });
  assert.match(bugPrompt, /反方论证/);
  assert.match(bugPrompt, /located/);
  const featPrompt = buildReviewPrompt(
    { type: 'feature', detail: '加个导出' },
    { projectDir: 'C:/p', precedents: [{ type: 'feature', title: '导入功能', verdict: 'ask', override: 'proceed' }] },
  );
  assert.match(featPrompt, /complexity/);
  assert.match(featPrompt, /历史判例/);
  assert.match(featPrompt, /导入功能/);
});

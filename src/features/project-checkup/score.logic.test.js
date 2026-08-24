import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEIGHTS, aggregateScore, gradeOf } from './score.logic.js';

test('权重合计为 100', () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100);
});

test('全维度可用时按权重加权', () => {
  const r = aggregateScore({
    map: { score: 100, status: 'done' },
    prompts: { score: 100, status: 'done' },
    rules: { score: 100, status: 'done' },
    comments: { score: 100, status: 'done' },
  });
  assert.equal(r.total, 100);
});

test('不同分数按权重加权', () => {
  const r = aggregateScore({
    map: { score: 60, status: 'done' },
    prompts: { score: 80, status: 'done' },
    rules: { score: 100, status: 'done' },
    comments: { score: 90, status: 'done' },
  });
  // (60*35 + 80*30 + 100*15 + 90*20) / 100 = (2100+2400+1500+1800)/100 = 78
  assert.equal(r.total, 78);
});

test('N/A 维度的权重按比例分给其余维度', () => {
  const r = aggregateScore({
    map: { score: 100, status: 'done' },
    prompts: { score: 100, status: 'done' },
    rules: { score: null, status: 'na' },
    comments: { score: 100, status: 'done' },
  });
  assert.equal(r.total, 100);
});

test('pending 维度不计入总分', () => {
  const r = aggregateScore({
    map: { score: 80, status: 'done' },
    prompts: { score: null, status: 'pending' },
    rules: { score: 60, status: 'done' },
    comments: { score: null, status: 'pending' },
  });
  // 只有 map(35) 和 rules(15) 参与：(80×35 + 60×15) / 50 = (2800+900)/50 = 74
  assert.equal(r.total, 74);
  assert.deepEqual(r.countedDims.sort(), ['map', 'rules']);
});

test('disabled 维度不计入总分', () => {
  const r = aggregateScore({
    map: { score: 90, status: 'done' },
    prompts: { score: null, status: 'disabled' },
    rules: { score: null, status: 'disabled' },
    comments: { score: null, status: 'disabled' },
  });
  assert.equal(r.total, 90);
  assert.deepEqual(r.countedDims, ['map']);
});

test('缺失的维度键不会崩', () => {
  const r = aggregateScore({ map: { score: 70, status: 'done' } });
  assert.equal(r.total, 70);
});

test('score 不是数字时排除该维度', () => {
  const r = aggregateScore({
    map: { score: 70, status: 'done' },
    prompts: { score: 'abc', status: 'done' },
  });
  assert.equal(r.total, 70);
  assert.deepEqual(r.countedDims, ['map']);
});

test('全部不可用时总分为 null', () => {
  const r = aggregateScore({
    map: { score: null, status: 'pending' },
    prompts: { score: null, status: 'pending' },
    rules: { score: null, status: 'na' },
    comments: { score: null, status: 'pending' },
  });
  assert.equal(r.total, null);
  assert.equal(r.grade, null);
  assert.deepEqual(r.countedDims, []);
});

test('档位映射', () => {
  assert.equal(gradeOf(95).key, 'healthy');
  assert.equal(gradeOf(90).key, 'healthy');
  assert.equal(gradeOf(89).key, 'good');
  assert.equal(gradeOf(70).key, 'good');
  assert.equal(gradeOf(69).key, 'needs-work');
  assert.equal(gradeOf(50).key, 'needs-work');
  assert.equal(gradeOf(49).key, 'poor');
  assert.equal(gradeOf(0).key, 'poor');
  assert.equal(gradeOf(null), null);
  assert.equal(gradeOf(undefined), null);
});

test('档位带中文标签和 CSS 变量名', () => {
  const g = gradeOf(95);
  assert.equal(g.label, '健康');
  assert.equal(g.cssVar, '--green');
});

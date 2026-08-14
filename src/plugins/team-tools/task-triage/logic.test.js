import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupPending, sortForTriage, parseAction, parseYesNo } from './logic.js';

const mk = (o) => ({
  id: o.id,
  type: o.type || 'feature',
  title: o.title || o.id,
  status: o.status,
  createdAt: o.createdAt || '2026-01-01T00:00:00.000Z',
  analysis: o.analysis,
});

test('groupPending：按状态分「已有方案 / 分析中」，排除 done/rejected/developing', () => {
  const tasks = [
    mk({ id: 'a', status: 'analyzed', analysis: { suggestion: '方案A' } }),
    mk({ id: 'b', status: 'analyzing' }),
    mk({ id: 'c', status: 'new' }),
    mk({ id: 'd', status: 'analyzed', analysis: { suggestion: '' } }), // 空方案 → 归入分析中
    mk({ id: 'e', status: 'done' }),
    mk({ id: 'f', status: 'rejected' }),
    mk({ id: 'g', status: 'developing' }),
  ];
  const { ready, analyzing } = groupPending(tasks);
  assert.deepEqual(ready.map((t) => t.id), ['a']);
  assert.deepEqual(analyzing.map((t) => t.id).sort(), ['b', 'c', 'd']);
});

test('sortForTriage：bug 优先，同类按 createdAt 升序', () => {
  const ready = [
    mk({ id: 'f1', type: 'feature', createdAt: '2026-01-01T00:00:00.000Z' }),
    mk({ id: 'b2', type: 'bug', createdAt: '2026-01-03T00:00:00.000Z' }),
    mk({ id: 'b1', type: 'bug', createdAt: '2026-01-02T00:00:00.000Z' }),
    mk({ id: 'f2', type: 'feature', createdAt: '2026-01-04T00:00:00.000Z' }),
  ];
  assert.deepEqual(sortForTriage(ready).map((t) => t.id), ['b1', 'b2', 'f1', 'f2']);
});

test('sortForTriage：不修改原数组', () => {
  const ready = [mk({ id: 'x', type: 'feature' }), mk({ id: 'y', type: 'bug' })];
  const before = ready.map((t) => t.id);
  sortForTriage(ready);
  assert.deepEqual(ready.map((t) => t.id), before);
});

test('parseAction：关键词命中', () => {
  assert.equal(parseAction('开始处理'), 'start');
  assert.equal(parseAction('就这个'), 'start');
  assert.equal(parseAction('ok'), 'start');
  assert.equal(parseAction('放弃'), 'reject');
  assert.equal(parseAction('不做了'), 'reject');
  assert.equal(parseAction('跳过'), 'skip');
  assert.equal(parseAction('下一个'), 'skip');
  assert.equal(parseAction('补充：要考虑移动端'), 'fix');
  assert.equal(parseAction('重新分析'), 'fix');
  assert.equal(parseAction('退出'), 'exit');
  assert.equal(parseAction('结束'), 'exit');
});

test('parseAction：无关文本 → unknown（交给 Claude 兜底）', () => {
  assert.equal(parseAction('今天天气不错'), 'unknown');
  assert.equal(parseAction(''), 'unknown');
});

test('parseAction：withNote 取「补充」后的正文', () => {
  const r = parseAction('补充：要考虑移动端', { withNote: true });
  assert.equal(r.action, 'fix');
  assert.equal(r.note, '要考虑移动端');
});

test('parseYesNo', () => {
  assert.equal(parseYesNo('开始'), 'yes');
  assert.equal(parseYesNo('好的'), 'yes');
  assert.equal(parseYesNo('取消'), 'no');
  assert.equal(parseYesNo('先不了'), 'no');
  assert.equal(parseYesNo('嗯嗯天气'), 'unknown');
});

// —— C1/I3：否定穿透，「不X」不能被误判为 yes ——
test('parseYesNo：否定前缀优先，不被 yes 单字误命中', () => {
  assert.equal(parseYesNo('不行'), 'no');
  assert.notEqual(parseYesNo('不好'), 'yes'); // no 或 unknown 均可，就是不能是 yes
  assert.notEqual(parseYesNo('不太行'), 'yes');
});

// —— C1/I2/I3：parseAction 否定与误命中收敛 ——
test('parseAction：否定/单字误命中不落 start', () => {
  assert.notEqual(parseAction('不好'), 'start'); // reject 或 unknown
  assert.equal(parseAction('干'), 'unknown'); // 单字「干」误命中面大，移除后应为 unknown
  // 回归保护：既有拒绝用例仍成立
  assert.equal(parseAction('不做了'), 'reject');
  assert.equal(parseAction('不用了'), 'reject');
});

// —— I1/I3：groupPending 处理合法态 confirmed 与空数组 ——
test('groupPending：confirmed 归入 analyzing（已确认待分析、尚无方案）', () => {
  const { ready, analyzing } = groupPending([mk({ id: 'cf', status: 'confirmed' })]);
  assert.deepEqual(ready.map((t) => t.id), []);
  assert.deepEqual(analyzing.map((t) => t.id), ['cf']);
});

test('groupPending：空数组返回空分组', () => {
  assert.deepEqual(groupPending([]), { ready: [], analyzing: [] });
});

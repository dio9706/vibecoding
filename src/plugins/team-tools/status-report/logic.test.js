import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_TRIGGERS, ACTIVE_STATUS_LABELS, groupTasks, minutesSince, buildStatusReport } from './logic.js';

test('STATUS_TRIGGERS 回归锚点', () => {
  assert.deepEqual(STATUS_TRIGGERS, ['\\10002 帮我检查当前正在进行的任务']);
});

test('groupTasks：活跃四态入 active，done 未合并且有分支入 merge，其余排除', () => {
  const tasks = [
    { id: '1', type: 'bug', title: 'A', status: 'reviewing', updatedAt: '2026-08-01T00:00:00Z' },
    { id: '2', type: 'feature', title: 'B', status: 'analyzing', updatedAt: '2026-08-03T00:00:00Z' },
    { id: '3', type: 'bug', title: 'C', status: 'queued', updatedAt: '2026-08-02T00:00:00Z' },
    { id: '4', type: 'bug', title: 'D', status: 'developing', updatedAt: '2026-08-04T00:00:00Z' },
    { id: '5', type: 'bug', title: 'E', status: 'done', merged: false, branch: 'auto/t5', updatedAt: '2026-08-01T00:00:00Z' },
    { id: '6', type: 'bug', title: 'F', status: 'done' }, // 老数据无 merged → 不属于待合并
    { id: '7', type: 'bug', title: 'G', status: 'done', merged: true, branch: 'auto/t7' }, // 已合并
    { id: '8', type: 'bug', title: 'H', status: 'new' },
    { id: '9', type: 'bug', title: 'I', status: 'rejected' },
    { id: '10', type: 'bug', title: 'J', status: 'analyzed' }, // 方案就绪等确认 ≠ 正在进行
  ];
  const { active, merge } = groupTasks(tasks);
  assert.deepEqual(active.map((t) => t.title), ['D', 'B', 'C', 'A']); // updatedAt 倒序
  assert.deepEqual(merge.map((t) => t.title), ['E']);
});

test('groupTasks：容忍非数组/脏数据', () => {
  assert.deepEqual(groupTasks(null), { active: [], merge: [] });
  const { active } = groupTasks([null, {}, { status: 'developing', type: 'bug', title: 'X' }]);
  assert.equal(active.length, 1);
});

test('minutesSince：向下取整，非法输入归零', () => {
  const now = 10 * 60_000 + 30_000;
  assert.equal(minutesSince(0, now), 10);
  assert.equal(minutesSince(now - 59_000, now), 0);
  assert.equal(minutesSince(undefined, 1000), 0);
  assert.equal(minutesSince(now + 999, now), 0); // 未来时间不出负数
});

test('buildStatusReport：三组齐全的排版', () => {
  const text = buildStatusReport({
    runs: [{ title: '修复登录页样式', minutes: 12 }],
    active: [
      { type: 'bug', title: '扫码白屏', status: 'developing' },
      { type: 'feature', title: '记住密码', status: 'analyzing' },
    ],
    merge: [{ type: 'bug', title: '闪退', status: 'done', merged: false, branch: 'auto/t1' }],
  });
  assert.match(text, /▶ 对话（1）/);
  assert.match(text, /修复登录页样式 — 进行中 · 已运行 12 分钟/);
  assert.match(text, /▶ 需求\/故障（2）/);
  assert.match(text, /\[故障\] 扫码白屏 — 开发中/);
  assert.match(text, /\[需求\] 记住密码 — 分析中/);
  assert.match(text, /▶ 待确认合并（1）/);
  assert.match(text, /\[故障\] 闪退 — 已完成，待合并（分支 auto\/t1）/);
});

test('buildStatusReport：全空 → 无任务提示；空组不渲染组头', () => {
  assert.equal(buildStatusReport({}), '当前没有正在进行的任务 🎉');
  const text = buildStatusReport({ runs: [{ title: 'X', minutes: 1 }], active: [], merge: [] });
  assert.doesNotMatch(text, /需求\/故障/);
  assert.doesNotMatch(text, /待确认合并/);
});

test('buildStatusReport：超过 20 条截断提示', () => {
  const active = Array.from({ length: 23 }, (_, i) => ({ type: 'bug', title: 'T' + i, status: 'queued' }));
  const text = buildStatusReport({ runs: [], active, merge: [] });
  assert.match(text, /…其余 3 条略/);
});

test('ACTIVE_STATUS_LABELS 覆盖且仅覆盖四个活跃态', () => {
  assert.deepEqual(Object.keys(ACTIVE_STATUS_LABELS).sort(), ['analyzing', 'developing', 'queued', 'reviewing']);
});

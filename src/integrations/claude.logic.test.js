/**
 * describeTaskEvent：SDK task_* 系统事件 → 活动转录文案。
 *
 * 为什么要测：只有 task_started 带 workflow_name，progress/notification 得靠 task_id 查表；
 * 记错、漏记或没把常驻任务（skip_transcript）的 progress 一起压掉，转录就会出现错标或噪声（改前的实际表现）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeTaskEvent, taskKindLabel, isTaskEvent } from './claude.logic.js';

const started = (over = {}) => ({ type: 'system', subtype: 'task_started', task_id: 't1', description: '审查 src/store 的 Promise 处理', ...over });
const progress = (over = {}) => ({ type: 'system', subtype: 'task_progress', task_id: 't1', description: '读取 runs.js', usage: { total_tokens: 1, tool_uses: 3, duration_ms: 12400 }, last_tool_name: 'Read', ...over });
const notified = (over = {}) => ({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', output_file: '/x', summary: '发现 2 处未 catch', ...over });

test('taskKindLabel：工作流 > 子代理 > 后台任务', () => {
  assert.equal(taskKindLabel({ workflow_name: 'spec', subagent_type: 'Explore' }), '工作流(spec)');
  assert.equal(taskKindLabel({ subagent_type: 'Explore' }), '子代理(Explore)');
  assert.equal(taskKindLabel({}), '后台任务');
});

test('isTaskEvent：system + task_ 前缀为真；task_updated 也为真（交给 describeTaskEvent 返回 null）；其它为假', () => {
  assert.equal(isTaskEvent(started()), true);
  assert.equal(isTaskEvent(progress()), true);
  assert.equal(isTaskEvent(notified()), true);
  assert.equal(isTaskEvent({ type: 'system', subtype: 'task_updated' }), true);
  assert.equal(isTaskEvent({ type: 'system', subtype: 'background_tasks_changed' }), false);
  assert.equal(isTaskEvent({ type: 'system', subtype: 'init' }), false);
  assert.equal(isTaskEvent({ type: 'assistant', subtype: 'task_started' }), false);
  assert.equal(isTaskEvent({ type: 'system' }), false);
  assert.equal(isTaskEvent(undefined), false);
});

test('task_started（工作流）→ 记类型 + 「工作流(名)启动：描述」，name 为 Workflow', () => {
  const kinds = new Map();
  const a = describeTaskEvent(started({ workflow_name: 'spec', task_type: 'local_workflow' }), kinds);
  assert.deepEqual(kinds.get('t1'), { name: 'Workflow', label: '工作流(spec)', skip: false });
  assert.equal(a.name, 'Workflow');
  assert.equal(a.sub, true);
  assert.equal(a.text, '工作流(spec)启动：审查 src/store 的 Promise 处理');
});

test('task_started（子代理）→ 「子代理(类型)启动：…」，name 为 Agent', () => {
  const a = describeTaskEvent(started({ subagent_type: 'Explore' }), new Map());
  assert.equal(a.name, 'Agent');
  assert.equal(a.text, '子代理(Explore)启动：审查 src/store 的 Promise 处理');
});

test('task_started（无类型）→ 「后台任务启动：…」', () => {
  const a = describeTaskEvent(started(), new Map());
  assert.equal(a.text, '后台任务启动：审查 src/store 的 Promise 处理');
});

test('task_started 描述超 40 字被截断', () => {
  const a = describeTaskEvent(started({ description: 'x'.repeat(50) }), new Map());
  assert.equal(a.text, `后台任务启动：${'x'.repeat(40)}…`);
});

test('task_progress 沿用 started 记下的标签与 name，文案含工具名 / 次数 / 秒数', () => {
  const kinds = new Map();
  describeTaskEvent(started({ workflow_name: 'spec' }), kinds);
  const a = describeTaskEvent(progress(), kinds);
  assert.equal(a.name, 'Workflow');
  assert.equal(a.text, '工作流(spec)正在 Read · 已 3 次工具 12s：读取 runs.js');
});

test('task_progress 未知 task_id 但自带 subagent_type → 用它，不浪费信息', () => {
  const a = describeTaskEvent(progress({ task_id: 'ghost', subagent_type: 'Explore' }), new Map());
  assert.equal(a.name, 'Agent');
  assert.equal(a.text, '子代理(Explore)正在 Read · 已 3 次工具 12s：读取 runs.js');
});

test('task_progress 未知 task_id 且无类型 → 回落「子代理」；无 last_tool_name → 「执行中」；usage 空 → 「已 ?」且无孤立空格', () => {
  const a = describeTaskEvent(progress({ task_id: 'ghost', last_tool_name: undefined, usage: {} }), new Map());
  assert.equal(a.text, '子代理执行中 · 已 ? 次工具：读取 runs.js');
});

test('task_progress usage 整体缺失 → 不抛，「已 ?」', () => {
  const a = describeTaskEvent(progress({ task_id: 'ghost', usage: undefined }), new Map());
  assert.equal(a.text, '子代理正在 Read · 已 ? 次工具：读取 runs.js');
});

test('task_progress tool_uses 为 0 → 打印 0（?? 而非 ||）；duration_ms 为 0 → 省略秒数', () => {
  const a = describeTaskEvent(progress({ task_id: 'ghost', usage: { tool_uses: 0, duration_ms: 0 } }), new Map());
  assert.equal(a.text, '子代理正在 Read · 已 0 次工具：读取 runs.js');
});

test('task_notification 沿用标签并按 status 映射中文', () => {
  const kinds = new Map();
  describeTaskEvent(started({ workflow_name: 'spec' }), kinds);
  assert.equal(describeTaskEvent(notified(), kinds).text, '工作流(spec)完成：发现 2 处未 catch');
});

test('task_notification 是终态：随后从 kinds 清除', () => {
  const kinds = new Map();
  describeTaskEvent(started({ workflow_name: 'spec' }), kinds);
  describeTaskEvent(notified(), kinds);
  assert.equal(kinds.has('t1'), false, '不清会让 Map 随 attempt 无限增长');
});

test('task_notification：failed / stopped 映射，未知 status 原样输出，空 summary 不抛', () => {
  const kinds = new Map();
  assert.equal(describeTaskEvent(notified({ task_id: 't9', status: 'failed', summary: '' }), kinds).text, '子代理失败：');
  assert.equal(describeTaskEvent(notified({ task_id: 't9', status: 'stopped' }), kinds).text, '子代理已停止：发现 2 处未 catch');
  assert.equal(describeTaskEvent(notified({ task_id: 't9', status: 'killed' }), kinds).text, '子代理killed：发现 2 处未 catch');
});

test('skip_transcript 常驻任务：started 记类型不出文案；其 progress 也被压掉；notification 清类型不出文案', () => {
  const kinds = new Map();
  assert.equal(describeTaskEvent(started({ workflow_name: 'spec', skip_transcript: true }), kinds), null);
  assert.equal(kinds.get('t1').skip, true, 'progress 不带 skip_transcript，只能靠这条记录压掉');
  assert.equal(describeTaskEvent(progress(), kinds), null);
  assert.equal(describeTaskEvent(notified({ skip_transcript: true }), kinds), null);
  assert.equal(kinds.has('t1'), false);
});

test('task_updated 等其它 task_* 子类型 → null', () => {
  assert.equal(describeTaskEvent({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: {} }, new Map()), null);
});

test('task_notification 自带 skip_transcript 但表里无记录（started 漏收）→ 仍不出文案', () => {
  assert.equal(describeTaskEvent(notified({ task_id: 'ghost', skip_transcript: true }), new Map()), null);
});

test('task_notification 不带 skip_transcript 但 started 记了 skip → 仍不出文案（以记录为准）', () => {
  const kinds = new Map();
  describeTaskEvent(started({ skip_transcript: true }), kinds);
  assert.equal(describeTaskEvent(notified(), kinds), null);
  assert.equal(kinds.has('t1'), false);
});

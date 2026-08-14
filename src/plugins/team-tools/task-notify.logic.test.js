/**
 * task-notify.logic 单测：任务完成卡片的构造 + 卡片回调解析（纯函数，无 I/O）。
 *
 * 重点验「按钮集合随待合并态变化」与「value 契约」——飞书侧点按钮回来只带 value，
 * 契约一旦漂移（kind/taskId/action 少一个），回调就静默落空，线上表现是「点了没反应」，
 * 没有任何异常可循，只能靠单测钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TASK_CARD_KIND, buildTaskDoneCard, parseTaskCardAction, taskResultCard } from './task-notify.logic.js';

const awaiting = {
  id: 't_1',
  type: 'feature',
  title: '加导出按钮',
  status: 'done',
  auto: true,
  merged: false,
  branch: 'auto/t_1',
  baseBranch: 'main',
  devLog: '已完成开发',
};

/** 取卡片里的按钮组（不存在则返回空数组，断言失败信息更直观） */
function actionsOf(card) {
  return card.elements.find((e) => e.tag === 'action')?.actions || [];
}

test('待合并任务：三个按钮，value 契约正确', () => {
  const actions = actionsOf(buildTaskDoneCard(awaiting, true));
  assert.equal(actions.length, 3);
  assert.deepEqual(
    actions.map((a) => a.value.action),
    ['merge', 'supplement', 'discard'],
  );
  assert.deepEqual(
    actions.map((a) => a.type),
    ['primary', 'default', 'danger'],
  );
  assert.ok(actions.every((a) => a.value.kind === TASK_CARD_KIND && a.value.taskId === 't_1'));
});

test('无分支任务（轻度托管）：只给补充按钮', () => {
  const t = { ...awaiting, auto: false, branch: null, baseBranch: null };
  const card = buildTaskDoneCard(t, true);
  const actions = actionsOf(card);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].value.action, 'supplement');
  // 分支两者不全 → 不显示分支行（拼出「分支：null → null」比不显示更糟）
  assert.doesNotMatch(card.elements[0].text.content, /分支：/);
});

test('文案：需求/故障标签与成败标记', () => {
  assert.match(buildTaskDoneCard(awaiting, true).elements[0].text.content, /\[需求\]/);
  assert.match(buildTaskDoneCard({ ...awaiting, type: 'bug' }, true).elements[0].text.content, /\[故障\]/);
  assert.match(buildTaskDoneCard(awaiting, true).elements[0].text.content, /✅/);
  assert.match(buildTaskDoneCard(awaiting, false).elements[0].text.content, /❌/);
  assert.match(buildTaskDoneCard(awaiting, true).elements[0].text.content, /auto\/t_1 → main/);
});

test('devLog 摘要：超长截断，空则显示 (无输出)', () => {
  const long = buildTaskDoneCard({ ...awaiting, devLog: 'x'.repeat(500) }, true).elements[0].text.content;
  assert.match(long, /x{200}…/);
  assert.doesNotMatch(long, /x{201}/);
  assert.match(buildTaskDoneCard({ ...awaiting, devLog: '   ' }, true).elements[0].text.content, /\(无输出\)/);
});

test('parseTaskCardAction：kind/action 校验与 messageId 兜底', () => {
  const ok = parseTaskCardAction({
    action: { value: { kind: TASK_CARD_KIND, taskId: 't_1', action: 'merge' } },
    operator: { open_id: 'ou_1' },
    message_id: 'om_1',
  });
  assert.deepEqual(ok, { taskId: 't_1', action: 'merge', operatorOpenId: 'ou_1', messageId: 'om_1' });
  // context.open_message_id 优先于顶层 message_id（v2 schema 两者可能同时出现）
  const prefer = parseTaskCardAction({
    action: { value: JSON.stringify({ kind: TASK_CARD_KIND, taskId: 't_2', action: 'discard' }) },
    operator: { open_id: 'ou_2' },
    context: { open_message_id: 'om_ctx' },
    message_id: 'om_top',
  });
  assert.deepEqual(prefer, { taskId: 't_2', action: 'discard', operatorOpenId: 'ou_2', messageId: 'om_ctx' });
  // 别的 kind / 缺 taskId / 未知动作 / 畸形报文一律 null
  assert.equal(parseTaskCardAction({ action: { value: { kind: 'conv-settled', convId: 'c' } } }), null);
  assert.equal(parseTaskCardAction({ action: { value: { kind: TASK_CARD_KIND, action: 'merge' } } }), null);
  assert.equal(parseTaskCardAction({ action: { value: { kind: TASK_CARD_KIND, taskId: 't', action: 'nuke' } } }), null);
  assert.equal(parseTaskCardAction({ action: { value: '{坏 JSON' } }), null);
  assert.equal(parseTaskCardAction(null), null);
});

test('taskResultCard：只剩一句结果，无按钮', () => {
  const c = taskResultCard('✅ 已合并');
  assert.equal(c.elements.length, 1);
  assert.equal(c.elements[0].tag, 'div');
  assert.equal(c.elements[0].text.content, '✅ 已合并');
});

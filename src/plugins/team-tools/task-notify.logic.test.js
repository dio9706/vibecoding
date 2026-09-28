/**
 * task-notify.logic 单测：任务完成卡片的构造 + 卡片回调解析（纯函数，无 I/O）。
 *
 * 重点验「按钮集合随待合并态变化」与「value 契约」——飞书侧点按钮回来只带 value，
 * 契约一旦漂移（kind/taskId/action 少一个），回调就静默落空，线上表现是「点了没反应」，
 * 没有任何异常可循，只能靠单测钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TASK_CARD_KIND, buildTaskDoneCard, parseTaskCardAction, taskResultCard, taskDoneFallbackText, mergeStatusOf } from './task-notify.logic.js';

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

test('buildTaskDoneCard：已自动合并 → 不给合并按钮，正文写明已合并，仍保留放弃', () => {
  const card = buildTaskDoneCard(
    { id: 't1', type: 'bug', title: 'x', branch: 'task/x', baseBranch: 'main', status: 'done', auto: true, merged: true, autoMerged: true },
    true,
  );
  const json = JSON.stringify(card);
  assert.doesNotMatch(json, /合并到主分支/, '已合并再给合并按钮，点了只会被挡回');
  assert.match(json, /已自动合并到 main/, '正文必须说清改动已经进主干');
  assert.match(json, /放弃改动/, '放弃按钮必须保留（改为 revert 撤销）');
});

test('buildTaskDoneCard：合并失败降级态 → 照旧给合并按钮', () => {
  const card = buildTaskDoneCard(
    { id: 't2', type: 'bug', title: 'x', branch: 'task/x', baseBranch: 'main', status: 'done', auto: true, merged: false, mergeError: '合并冲突：xxx' },
    true,
  );
  const json = JSON.stringify(card);
  assert.match(json, /合并到主分支/);
  assert.match(json, /放弃改动/);
});

// ---- 合并结果必须出现在卡片正文里 ----
// 2026-09-28 实测事故：三条任务自动合并失败后卡片只写「✅ 已处理完成」配一个合并按钮，
// 看不出自动合并已经试过并失败，人会以为是自己还没点 —— 任务因此积压四天无人处理。

const doneTask = (over = {}) => ({
  id: 't', type: 'bug', title: '点头像没出系统行', branch: 'auto/t_x', baseBranch: 'v6.2.0',
  status: 'done', auto: true, merged: false, ...over,
});

test('buildTaskDoneCard：自动合并失败 → 正文写明失败并带上原因', () => {
  const c = buildTaskDoneCard(doneTask({ mergeError: '合并冲突：Merge conflict in src/pages/chat/index.vue' }), true).elements[0].text.content;
  assert.match(c, /自动合并失败/, '不写这句，人就以为是自己还没点合并');
  assert.match(c, /src\/pages\/chat\/index\.vue/, '原因要能直接指向该看哪个文件');
});

test('buildTaskDoneCard：合并失败原因过长时截断，不把整段 git 诊断刷进卡片', () => {
  const c = buildTaskDoneCard(doneTask({ mergeError: '合并冲突：' + 'x'.repeat(600) }), true).elements[0].text.content;
  assert.ok(c.length < 700, `卡片正文不该被诊断刷屏，实际 ${c.length}`);
  assert.match(c, /…/);
});

test('buildTaskDoneCard：合并成功但改动没从 stash 回来 → 正文必须出警告', () => {
  const c = buildTaskDoneCard(
    doneTask({ merged: true, autoMerged: true, mergeWarning: '⚠️ 主工作区未提交改动未能自动恢复：本地改动完整保留在 stash（12ab34cd）' }),
    true,
  ).elements[0].text.content;
  assert.match(c, /已自动合并到 v6\.2\.0/);
  assert.match(c, /stash（12ab34cd）/, '改动在哪能找回来，是这条通知唯一的价值');
});

test('buildTaskDoneCard：AI 解了冲突 → 正文提示复核（合并成功不等于没事要管）', () => {
  const c = buildTaskDoneCard(
    doneTask({ merged: true, autoMerged: true, mergeWarning: '合并冲突由 AI 解决，建议复核代码' }),
    true,
  ).elements[0].text.content;
  assert.match(c, /AI 解决/);
  assert.match(c, /建议复核/);
});

test('buildTaskDoneCard：干净合并不添噪音，失败与警告都没有时只报已合并', () => {
  const c = buildTaskDoneCard(doneTask({ merged: true, autoMerged: true }), true).elements[0].text.content;
  assert.match(c, /已自动合并到 v6\.2\.0/);
  assert.doesNotMatch(c, /⚠️/);
});

test('buildTaskDoneCard：mergeError 与 merged 同时存在时以失败为准（状态不一致的兜底）', () => {
  // 正常流程不会同时出现，但盘上数据可能因历史版本或并发写而不一致；
  // 此时必须报失败——漏报「还没合上」比多报一次严重得多
  const c = buildTaskDoneCard(doneTask({ merged: true, mergeError: '合并冲突：yyy' }), true).elements[0].text.content;
  assert.match(c, /自动合并失败/);
});

// ---- 卡片发不出时的降级纯文本 ----

test('taskDoneFallbackText：卡片发送失败降级为纯文本时，合并失败同样不能丢', () => {
  const t = taskDoneFallbackText(doneTask({ mergeError: '合并冲突：zzz' }), true);
  assert.match(t, /自动合并失败/);
  assert.match(t, /zzz/);
  assert.match(t, /网页端/, '降级态点不到按钮，必须指明去哪处理');
  assert.doesNotMatch(t, /\*\*/, '纯文本通道不能出现 lark_md 的粗体标记');
});

test('taskDoneFallbackText：开发本身失败时报 ❌，且不谎称合并过', () => {
  const t = taskDoneFallbackText(doneTask({ status: 'analyzed' }), false);
  assert.match(t, /❌/);
  assert.doesNotMatch(t, /合并/);
});

// ---- 共用判定 ----

test('mergeStatusOf：四态判定（卡片与纯文本共用一把尺子，防文案分叉）', () => {
  assert.equal(mergeStatusOf({ mergeError: 'e' }).kind, 'failed');
  assert.equal(mergeStatusOf({ merged: true, mergeWarning: 'w' }).kind, 'warned');
  assert.equal(mergeStatusOf({ merged: true }).kind, 'merged');
  assert.equal(mergeStatusOf({ merged: false }).kind, 'none');
  assert.equal(mergeStatusOf(null).kind, 'none', '空任务不该抛');
});

test('taskResultCard：只剩一句结果，无按钮', () => {
  const c = taskResultCard('✅ 已合并');
  assert.equal(c.elements.length, 1);
  assert.equal(c.elements[0].tag, 'div');
  assert.equal(c.elements[0].text.content, '✅ 已合并');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargets, buildPickCard, ACK_TEXT, PICK_KIND } from './logic.js';

const COLLEAGUES = [
  { id: 'cl_a', name: '后端丙', role: 'backend', feishuOpenId: 'ou_b' },
  { id: 'cl_b', name: '产品甲', role: 'product', feishuOpenId: 'ou_p' },
];
const REQS = [
  { id: 'r_1', title: '扫码支付', phase: 'dev', assignees: ['cl_a'] },
  { id: 'r_2', title: '对账补偿', phase: 'dev', assignees: ['cl_a', 'cl_b'] },
  { id: 'r_3', title: '已归档的', phase: 'archived', assignees: ['cl_a'] },
  { id: 'r_4', title: '评审中的', phase: 'review', assignees: ['cl_a'] },
];

test('resolveTargets：open_id 不在名册 → 非同事', () => {
  const r = resolveTargets('ou_unknown', COLLEAGUES, REQS);
  assert.equal(r.colleague, null);
  assert.deepEqual(r.reqs, []);
});

test('resolveTargets：只取开发期需求（归档/评审期不算）', () => {
  const r = resolveTargets('ou_p', COLLEAGUES, REQS);
  assert.equal(r.colleague.id, 'cl_b');
  assert.deepEqual(r.reqs.map((x) => x.id), ['r_2'], '产品甲只被指派到 r_2');
});

test('resolveTargets：参与多个开发期需求时全部返回，由调用方发卡让其自选', () => {
  const r = resolveTargets('ou_b', COLLEAGUES, REQS);
  assert.deepEqual(r.reqs.map((x) => x.id), ['r_1', 'r_2']);
  assert.equal(r.reqs.length, 2, 'r_3 已归档、r_4 在评审期，都不该进来');
});

test('resolveTargets：是同事但一个开发期需求都没有 → reqs 空（调用方据此 PASS）', () => {
  const r = resolveTargets('ou_b', COLLEAGUES, [REQS[2], REQS[3]]);
  assert.ok(r.colleague);
  assert.deepEqual(r.reqs, []);
});

test('resolveTargets：入参非数组不炸', () => {
  const r = resolveTargets('ou_b', null, undefined);
  assert.equal(r.colleague, null);
  assert.deepEqual(r.reqs, []);
});

test('resolveTargets：名册里 open_id 为空的同事不会被空 openId 误匹配', () => {
  const list = [{ id: 'cl_noid', name: '没号的', role: 'ops', feishuOpenId: '' }];
  assert.equal(resolveTargets('', list, REQS).colleague, null);
  assert.equal(resolveTargets(undefined, list, REQS).colleague, null);
});

test('buildPickCard：每个需求一个按钮，value 自带 kind/openId/reqId/colleagueId', () => {
  const card = buildPickCard('ou_b', 'cl_a', [REQS[0], REQS[1]]);
  const actionEl = card.elements.find((e) => e.tag === 'action');
  assert.equal(actionEl.actions.length, 2);
  const v = actionEl.actions[0].value;
  assert.equal(v.kind, PICK_KIND);
  assert.equal(v.openId, 'ou_b');
  assert.equal(v.colleagueId, 'cl_a');
  assert.equal(v.reqId, 'r_1');
  assert.equal(actionEl.actions[0].text.content, '扫码支付');
  assert.ok(Object.keys(v).every((k) => ['kind', 'openId', 'colleagueId', 'reqId', '_timestamp'].includes(k)));
});

test('buildPickCard：说明文案点明「选哪个需求」，否则同事不知道为什么要点', () => {
  const card = buildPickCard('ou_b', 'cl_a', [REQS[0]]);
  const div = card.elements.find((e) => e.tag === 'div');
  assert.match(div.text.content, /哪个需求/);
});

test('ACK_TEXT：与用户拍板的文案逐字一致', () => {
  assert.equal(ACK_TEXT, '已收到，信息会同步发送给主机！');
});

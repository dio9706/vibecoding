/**
 * 入站共用层单测：名册判定 → 落盘 → 跨进程触发。
 * 文本与附件两条链路共用它，所以这里钉死的是「什么人的消息会被接管」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayToAgent, isColleagueMessage } from './relay.js';

const colleagues = [
  { id: 'cl_1', name: '张三', role: 'backend', feishuOpenId: 'ou_1' },
  { id: 'cl_2', name: '李四', role: 'frontend', feishuOpenId: '' },
];

function deps(over = {}) {
  const appended = [];
  const posted = [];
  return {
    appended,
    posted,
    d: {
      getColleagues: () => colleagues,
      appendTo: (cid, e) => (appended.push({ cid, e }), { ...e, id: 'cm_new' }),
      postToWeb: async (body) => posted.push(body),
      ...over,
    },
  };
}

test('名册内同事：落盘入站消息 + 跨进程触发，返回 true（调用方应 return）', async () => {
  const { d, appended, posted } = deps();
  const r = await relayToAgent({ openId: 'ou_1', text: '接口给你了' }, d);
  assert.equal(r, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].cid, 'cl_1');
  assert.equal(appended[0].e.dir, 'in');
  assert.equal(appended[0].e.role, 'backend', '职位是发信当时的快照');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].colleagueId, 'cl_1');
  assert.equal(posted[0].msgId, 'cm_new', 'msgId 必须带上，工具靠它知道这轮在处理哪条');
});

test('不在名册：返回 false，不落盘不触发（交回 feedback 等后续 feature）', async () => {
  const { d, appended, posted } = deps();
  assert.equal(await relayToAgent({ openId: 'ou_stranger', text: 'x' }, d), false);
  assert.equal(appended.length, 0);
  assert.equal(posted.length, 0);
});

test('附件：files 一并落盘并透传给 web', async () => {
  const { d, appended, posted } = deps();
  const files = [{ name: 'order.md', path: 'D:/order.md', kind: 'file' }];
  await relayToAgent({ openId: 'ou_1', text: '', files }, d);
  assert.equal(appended[0].e.files.length, 1);
  assert.equal(posted[0].files[0].name, 'order.md');
});

test('跨进程 POST 失败不影响接管结论 —— 消息已落盘，主机在 web 端看得到', async () => {
  const { d, appended } = deps({ postToWeb: async () => { throw new Error('web 没起来'); } });
  const r = await relayToAgent({ openId: 'ou_1', text: 'x' }, d);
  assert.equal(r, true, 'POST 失败不能让消息退回材料池，那会导致同一条消息被两套逻辑处理');
  assert.equal(appended.length, 1);
});

test('2.0 不再看「有没有开发期需求」—— 名册内就接管，归属由 agent 逐条判', async () => {
  // 1.0 的 resolveTargets 要求同事至少在一个 dev 需求里，否则 PASS 回 feedback。
  // 换锚点后对话锚在人身上，没有需求也能聊（agent 会问清楚或如实说不知道）。
  const { d, posted } = deps();
  await relayToAgent({ openId: 'ou_1', text: '在忙啥' }, d);
  assert.equal(posted.length, 1);
});

test('isColleagueMessage：纯判定不产生副作用（附件链路要先判再决定走哪条）', () => {
  assert.equal(isColleagueMessage('ou_1', colleagues)?.id, 'cl_1');
  assert.equal(isColleagueMessage('ou_stranger', colleagues), null);
  assert.equal(isColleagueMessage('', colleagues), null);
});

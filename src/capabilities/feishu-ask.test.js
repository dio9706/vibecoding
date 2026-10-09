/**
 * feishu-ask.js（委托同事对话核心）测试—— 全程注入桩件，不触网络/不写盘。
 *
 * 覆盖的关键不变式：不重复委托同一人；判定未结论 → 自动追问；追问上限 → 如实交回；
 * 等待超时/中断 = 取消委托（迟到回复回落同事对话 agent）；等待期间持续打心跳。
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离数据目录：feishu-ask 间接 import 多个 store（读盘路径），必须在 import 前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-ask-'));

const { askColleague, handleColleagueAskReply, waitForReply, clearAsks } = await import('./feishu-ask.js');

const ZHANG = { id: 'cl_z', role: 'backend', name: '张三', feishuOpenId: 'ou_zhang' };
const WANG = { id: 'cl_w', role: 'frontend', name: '王五', feishuOpenId: 'ou_wang' };

/** 造一套可注入依赖；sent 里按顺序记录发出的飞书消息 */
function makeDeps(over = {}) {
  const sent = [];
  const appended = [];
  return {
    sent,
    appended,
    getColleagues: () => [ZHANG, WANG],
    sendCard: async (creds, openId, card) => {
      sent.push({ kind: 'card', openId, card });
      return 'om_card_1';
    },
    sendText: async (creds, openId, text) => {
      sent.push({ kind: 'text', openId, text });
      return true;
    },
    appendMessage: (colleagueId, msg) => appended.push({ colleagueId, msg }),
    getBotCreds: () => ({ appId: 'app', appSecret: 'sec' }),
    judge: async () => ({ done: true, conclusion: '默认结论' }),
    ...over,
  };
}

beforeEach(clearAsks);
after(clearAsks);

// ---------- 发起 ----------

test('askColleague：发卡片、登记委托、返回问题ID', async () => {
  const d = makeDeps();
  const r = await askColleague({ role: 'backend', question: '字段是哪个？', context: '接口 500' }, d);
  assert.equal(r.ok, true);
  assert.match(r.questionId, /^fq_/);
  assert.equal(r.colleague.name, '张三');
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0].kind, 'card');
  assert.equal(d.sent[0].openId, 'ou_zhang');
  assert.match(JSON.stringify(d.sent[0].card), /字段是哪个？/);
  assert.equal(d.appended.length, 1);
  assert.match(d.appended[0].msg.text, /^【提问】/);
  assert.equal(d.appended[0].msg.dir, 'out');
});

test('askColleague：同一同事已有进行中的委托 → 拒绝，不重复打扰', async () => {
  const d = makeDeps();
  const first = await askColleague({ role: 'backend', question: '问题一' }, d);
  const second = await askColleague({ role: 'backend', question: '问题二' }, d);
  assert.equal(first.ok, true);
  assert.match(second.error, /进行中/);
  assert.equal(d.sent.length, 1, '第二条不应发出去');
});

test('askColleague：不同同事可各自委托', async () => {
  const d = makeDeps();
  assert.equal((await askColleague({ role: 'backend', question: '后端问题' }, d)).ok, true);
  assert.equal((await askColleague({ role: 'frontend', question: '前端问题' }, d)).ok, true);
  assert.equal(d.sent.length, 2);
});

test('askColleague：目标/凭证/发送失败都给出可行动的错误', async () => {
  const d = makeDeps();
  assert.match((await askColleague({ role: 'backend' }, d)).error, /question/);
  assert.match((await askColleague({ role: 'hr', question: 'x' }, d)).error, /未知职位/);
  assert.match((await askColleague({ role: 'backend', question: 'x' }, makeDeps({ sendCard: async () => null }))).error, /发送失败/);
  assert.match((await askColleague({ role: 'backend', question: 'x' }, makeDeps({ getBotCreds: () => null }))).error, /机器人/);
});

// ---------- 引擎：追问直到结论 ----------

test('答复未得出结论 → 自动追问；再答复得出结论 → 等待者拿到结论', async () => {
  let round = 0;
  const d = makeDeps({
    judge: async () => {
      round++;
      return round === 1 ? { done: false, followUp: '具体是哪个字段？' } : { done: true, conclusion: '字段是 user_id' };
    },
  });
  const r = await askColleague({ role: 'backend', question: '用的哪个字段？' }, d);

  const hit1 = handleColleagueAskReply(ZHANG.id, { text: '说不太清' }, d);
  assert.ok(hit1, '进行中的委托应截获同事回复');
  await hit1.step;
  assert.ok(
    d.sent.some((m) => m.kind === 'text' && m.openId === 'ou_zhang' && m.text === '具体是哪个字段？'),
    '应自动发出追问',
  );
  assert.ok(d.appended.some((a) => /^【追问】/.test(a.msg.text)), '追问要留痕');

  const hit2 = handleColleagueAskReply(ZHANG.id, { text: 'user_id' }, d);
  await hit2.step;

  const res = await waitForReply(r.questionId);
  assert.equal(res.status, 'concluded');
  assert.equal(res.conclusion, '字段是 user_id');
  assert.equal(res.followUps, 1);
  assert.ok(res.transcript.some((t) => t.dir === 'in' && t.text === 'user_id'));
});

test('结论先到、等待后到：结论缓存住，wait 立即返回', async () => {
  const d = makeDeps({ judge: async () => ({ done: true, conclusion: '缓存的结论' }) });
  const r = await askColleague({ role: 'backend', question: 'x' }, d);
  const hit = handleColleagueAskReply(ZHANG.id, { text: '答案' }, d);
  await hit.step;
  const res = await waitForReply(r.questionId);
  assert.equal(res.status, 'concluded');
  assert.equal(res.conclusion, '缓存的结论');
});

test('追问达上限仍未结论 → abandoned，带上对话原文交回', async () => {
  const d = makeDeps({ judge: async () => ({ done: false, followUp: '再确认一下？' }) });
  const r = await askColleague({ role: 'backend', question: 'x' }, d);
  // MAX_FOLLOW_UPS=3：第 4 条回复进来时预算已尽，直接结算
  for (let i = 0; i < 4; i++) {
    const hit = handleColleagueAskReply(ZHANG.id, { text: `回复${i}` }, d);
    assert.ok(hit);
    await hit.step;
  }
  const res = await waitForReply(r.questionId);
  assert.equal(res.status, 'abandoned');
  assert.equal(res.followUps, 3);
  assert.match(res.reason, /追问 3 轮/);
  assert.ok(res.transcript.length >= 7, '问题 + 4 条回复 + 3 条追问');
});

test('判定输出无效 / 判定抛错 → 不结算不追问，保持等待', async () => {
  let fail = true;
  const d = makeDeps({
    judge: async () => {
      if (fail) throw new Error('模型超时');
      return { done: true, conclusion: '恢复后的结论' };
    },
  });
  const r = await askColleague({ role: 'backend', question: 'x' }, d);
  const hit = handleColleagueAskReply(ZHANG.id, { text: '先回一句' }, d);
  await hit.step;
  assert.equal(d.sent.filter((m) => m.kind === 'text').length, 0, '判定失败不应乱发追问');

  fail = false;
  const hit2 = handleColleagueAskReply(ZHANG.id, { text: '再试试' }, d);
  await hit2.step;
  const res = await waitForReply(r.questionId);
  assert.equal(res.status, 'concluded');
  assert.equal(res.conclusion, '恢复后的结论');
});

test('追问发送失败 → 不消耗预算、保持等待', async () => {
  let sendShouldFail = true;
  const d = makeDeps({
    judge: async () => ({ done: false, followUp: '追问内容' }),
    sendText: async () => !sendShouldFail,
  });
  const r = await askColleague({ role: 'backend', question: 'x' }, d);
  // 第 1 条回复的追问发送失败（不计数）；随后 3 条成功追问把预算用满；第 5 条触发结算
  const hit1 = handleColleagueAskReply(ZHANG.id, { text: '回答1' }, d);
  await hit1.step;
  sendShouldFail = false;
  for (let i = 2; i <= 5; i++) {
    const hit = handleColleagueAskReply(ZHANG.id, { text: `回答${i}` }, d);
    await hit.step;
  }
  const res = await waitForReply(r.questionId, { timeoutMs: 1000 });
  assert.equal(res.status, 'abandoned');
  assert.equal(res.followUps, 3);
});

// ---------- 等待语义 ----------

test('等待超时 = 取消委托：迟到回复不再被截获，回落同事对话 agent', async () => {
  const d = makeDeps();
  const r = await askColleague({ role: 'backend', question: 'x' }, d);
  const res = await waitForReply(r.questionId, { timeoutMs: 50 });
  assert.equal(res.status, 'timeout');
  assert.equal(handleColleagueAskReply(ZHANG.id, { text: '迟到的答案' }, d), null);
});

test('运行中断 → aborted，同样取消委托', async () => {
  const d = makeDeps();
  const r = await askColleague({ role: 'backend', question: 'x' }, d);
  const ac = new AbortController();
  const p = waitForReply(r.questionId, { timeoutMs: 5000, signal: ac.signal });
  ac.abort();
  const res = await p;
  assert.equal(res.status, 'aborted');
  assert.equal(handleColleagueAskReply(ZHANG.id, { text: 'x' }, d), null);
});

test('等待期间持续打心跳（防看门狗误杀）', async () => {
  const d = makeDeps();
  const r = await askColleague({ role: 'backend', question: 'x' }, d);
  let beats = 0;
  const res = await waitForReply(r.questionId, { timeoutMs: 150, pulse: () => beats++, pulseIntervalMs: 30 });
  assert.equal(res.status, 'timeout');
  assert.ok(beats >= 2, `等待期间应有多次心跳（实际 ${beats}）`);
});

test('同一提问并发等待 → busy；未知 questionId → unknown', async () => {
  const d = makeDeps();
  const r = await askColleague({ role: 'backend', question: 'x' }, d);
  const p1 = waitForReply(r.questionId, { timeoutMs: 100 });
  const second = await waitForReply(r.questionId);
  assert.equal(second.status, 'busy');
  assert.equal((await p1).status, 'timeout');
  assert.equal((await waitForReply('fq_nope')).status, 'unknown');
});

test('没有进行中的委托时，同事回复不被截获', () => {
  const d = makeDeps();
  assert.equal(handleColleagueAskReply(ZHANG.id, { text: '随便聊聊' }, d), null);
});

test('空文本且无附件的消息不触发截获；纯附件可以', async () => {
  const d = makeDeps({ judge: async () => ({ done: true, conclusion: '收到文件' }) });
  const r = await askColleague({ role: 'backend', question: 'x' }, d);
  assert.equal(handleColleagueAskReply(ZHANG.id, { text: '   ' }, d), null);
  const hit = handleColleagueAskReply(ZHANG.id, { text: '', files: [{ name: 'a.md', path: 'C:/tmp/a.md', kind: 'file' }] }, d);
  assert.ok(hit);
  await hit.step;
  const res = await waitForReply(r.questionId);
  assert.equal(res.status, 'concluded');
  assert.equal(res.transcript.at(-1).files[0].name, 'a.md');
});

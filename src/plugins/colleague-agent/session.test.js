/**
 * agent 编排层单测。真实 SDK / lark / store 全部经 deps 注入替换 ——
 * 这一层的价值全在「四条失败路径各自退化成什么」，那才是要钉死的东西。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleColleagueTurn, ACK_FALLBACK, ACK_BUSY, ACK_RATE } from './session.js';

/** 一套跑得通的默认依赖，各用例按需覆盖 */
function deps(over = {}) {
  const sent = [];
  const appended = [];
  return {
    sent,
    appended,
    d: {
      getColleague: () => ({ id: 'cl_1', name: '张三', role: 'backend', feishuOpenId: 'ou_1' }),
      getRequirements: () => [{ id: 'r_a', title: '需求A', phase: 'dev', assignees: ['cl_1'] }],
      getAgentSessionId: () => null,
      setAgentSessionId: () => {},
      appendTo: (cid, e) => (appended.push({ cid, e }), { ...e, id: 'cm_out' }),
      buildServer: () => ({ server: {}, allowed: new Set(['mcp__colleague__get_requirement']), defs: [{}] }),
      runTurn: async () => ({ text: '查过了，接口没问题', sessionId: 'sess_new', toolTrace: [{ name: 'get_requirement', input: {} }], reason: null }),
      sendText: async (openId, text) => sent.push({ openId, text }),
      tryAcquire: () => ({ ok: true, release() {} }),
      ...over,
    },
  };
}

test('正常一轮：回复发给同事、出站消息落盘、sessionId 回填', async () => {
  const { d, sent, appended } = deps();
  let saved = null;
  d.setAgentSessionId = (cid, id) => (saved = { cid, id });

  const r = await handleColleagueTurn({ colleagueId: 'cl_1', text: '接口文档发你了' }, d);

  assert.equal(r.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].openId, 'ou_1');
  assert.equal(sent[0].text, '查过了，接口没问题');
  assert.equal(appended.length, 1, '只落出站这一条——入站那条由飞书进程落，这里再落一次就是重复');
  assert.equal(appended[0].e.dir, 'out');
  assert.equal(appended[0].e.toolTrace.length, 1, '工具轨迹必须落盘，这是 P5 监管面的数据源');
  assert.deepEqual(saved, { cid: 'cl_1', id: 'sess_new' });
});

test('resume：已有 sessionId 时透传给 runAgentTurn，长期 thread 全靠它', async () => {
  const { d } = deps({ getAgentSessionId: () => 'sess_old' });
  let seen = null;
  d.runTurn = async (o) => ((seen = o), { text: 'ok', sessionId: 'sess_old', toolTrace: [], reason: null });
  await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(seen.sessionId, 'sess_old');
});

test('限流 rate：回固定话术，不起 agent，不落出站消息', async () => {
  const { d, sent, appended } = deps({ tryAcquire: () => ({ ok: false, reason: 'rate' }) });
  let ran = false;
  d.runTurn = async () => ((ran = true), {});

  const r = await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rate');
  assert.equal(ran, false, '超限就绝不能起 agent，那正是限流的意义');
  assert.equal(sent[0].text, ACK_RATE);
  assert.equal(appended.length, 0);
});

test('限流 busy：话术与 rate 不同（一个是你太快、一个是机器忙，处置不一样）', async () => {
  const { d, sent } = deps({ tryAcquire: () => ({ ok: false, reason: 'busy' }) });
  await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(sent[0].text, ACK_BUSY);
  assert.notEqual(ACK_BUSY, ACK_RATE);
});

test('额度耗尽：退化到 ACK，消息不丢（spec §8「不会比现状更糟」）', async () => {
  const { d, sent } = deps();
  d.runTurn = async () => ({ text: '', sessionId: null, toolTrace: [], reason: 'exhausted' });
  const r = await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exhausted');
  assert.equal(sent[0].text, ACK_FALLBACK);
});

test('超时 / 异常：同样退化到 ACK', async () => {
  for (const reason of ['timeout', 'error']) {
    const { d, sent } = deps();
    d.runTurn = async () => ({ text: '', sessionId: null, toolTrace: [], reason });
    await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
    assert.equal(sent[0].text, ACK_FALLBACK, `reason=${reason} 应落 ACK`);
  }
});

test('模型返回空文本（无 reason）也走 ACK —— 静默不回是最糟的失败形态', async () => {
  const { d, sent } = deps();
  d.runTurn = async () => ({ text: '   ', sessionId: 'sess_x', toolTrace: [], reason: null });
  await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(sent[0].text, ACK_FALLBACK);
});

test('失败路径也要 release 限流位 —— 不放的话并发闸会被永久占死', async () => {
  let released = 0;
  const { d } = deps({ tryAcquire: () => ({ ok: true, release: () => released++ }) });
  d.runTurn = async () => {
    throw new Error('boom');
  };
  await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(released, 1);
});

test('runTurn 抛错：吞掉并回 ACK，绝不让异常穿回 HTTP 层', async () => {
  const { d, sent } = deps();
  d.runTurn = async () => {
    throw new Error('boom');
  };
  const r = await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(r.ok, false);
  assert.equal(sent[0].text, ACK_FALLBACK);
});

test('同事不在名册：直接放弃，不起 agent 也不发消息', async () => {
  const { d, sent } = deps({ getColleague: () => null });
  const r = await handleColleagueTurn({ colleagueId: 'cl_x', text: 'x' }, d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-colleague');
  assert.equal(sent.length, 0);
});

test('同事没填 feishuOpenId：不起 agent（回复无处可送，跑了纯属烧额度）', async () => {
  const { d } = deps({ getColleague: () => ({ id: 'cl_1', name: '张三', role: 'backend', feishuOpenId: '' }) });
  let ran = false;
  d.runTurn = async () => ((ran = true), {});
  const r = await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-openid');
  assert.equal(ran, false);
});

test('零工具时仍继续（有 warn 兜底），但要在结果里标出来供排查', async () => {
  const { d } = deps({ buildServer: () => ({ server: {}, allowed: new Set(), defs: [] }) });
  const r = await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.equal(r.ok, true);
  assert.equal(r.toolCount, 0, '零工具是「插件没加载」的信号，必须可观测');
});

test('附件只把文件名喂进 userText，绝不带磁盘绝对路径 —— 那是主机机器的真实路径', async () => {
  const { d } = deps();
  let seen = null;
  d.runTurn = async (o) => ((seen = o), { text: 'ok', sessionId: 's', toolTrace: [], reason: null });
  await handleColleagueTurn(
    { colleagueId: 'cl_1', text: '接口文档给你', files: [{ name: 'order.md', path: 'C:\\Users\\DELL\\data\\uploads\\order.md' }] },
    d,
  );
  assert.match(seen.userText, /order\.md/, '文件名要能让模型知道「他发了什么文件」');
  assert.doesNotMatch(seen.userText, /C:\\Users/, '磁盘路径绝不能进模型上下文');
  assert.doesNotMatch(seen.userText, /uploads/, '路径的任何片段都不该出现');
});

test('附件的真实路径经 ctx 交给工具，不经模型之手', async () => {
  const { d } = deps();
  let seenCtx = null;
  d.buildServer = (role, opts) => ((seenCtx = opts.ctx), { server: {}, allowed: new Set(), defs: [] });
  const files = [{ name: 'order.md', path: 'C:\\Users\\DELL\\data\\uploads\\order.md' }];
  await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x', files }, d);
  assert.deepEqual(seenCtx.files, files, 'register_api_doc 之类的工具靠 ctx.files 按文件名反查路径');
});

test('只把 dev/review/test 阶段的需求喂进 prompt —— 归档废弃的是噪音', async () => {
  const { d } = deps({
    getRequirements: () => [
      { id: 'r_a', title: 'A', phase: 'dev', assignees: ['cl_1'] },
      { id: 'r_z', title: 'Z', phase: 'archived', assignees: ['cl_1'] },
      { id: 'r_o', title: 'O', phase: 'dev', assignees: ['cl_9'] },
    ],
  });
  let seen = null;
  d.runTurn = async (o) => ((seen = o), { text: 'ok', sessionId: 's', toolTrace: [], reason: null });
  await handleColleagueTurn({ colleagueId: 'cl_1', text: 'x' }, d);
  assert.match(seen.systemPrompt, /r_a/);
  assert.doesNotMatch(seen.systemPrompt, /r_z/, '已归档的不该出现');
  assert.doesNotMatch(seen.systemPrompt, /r_o/, '别人的需求不该出现');
});

/**
 * routes-run 的用户输入埋点单测（记忆库数据采集层）。
 *
 * 只验证「哪些请求会被记进原始日志、记成什么样」这一件事 —— 这正是最容易出错的地方：
 * 起跑/插话两个接口同时也是程序化发送（自动开发提示词/复盘总结）的通道，
 * 一旦把系统派发的提示词记进去，提炼层就被永久污染了。
 *
 * 起跑用例一律走 provider='openai-compat' 且不配任何凭证：埋点在 provider 分支之前执行，
 * 而 startOpenAiRun 会因取不到凭证立刻 failRun —— 既覆盖到埋点，又不会真的发起模型调用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'run-routes-'));
const DATA_DIR = process.env.APP_DATA_DIR;
const { handleRunStart, handleRunSend } = await import('./routes-run.js');
const { createRun, getRun, finishRun } = await import('../../store/runs.js');
const { readUserLog, userLogFile } = await import('../../store/user-log.js');

let server, base;
test.before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/start') return handleRunStart(req, res);
    if (url.pathname === '/send') return handleRunSend(req, res);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function post(p, body) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** 起跑一次并立刻收尾（不留看门狗定时器拖住测试进程） */
async function start(body) {
  const r = await post('/start', { provider: 'openai-compat', model: 'gpt-x', ...body });
  const run = r.json?.runId && getRun(r.json.runId);
  if (run) finishRun(run);
  return r;
}

/** 清空日志，让每个用例从零开始断言 */
function resetLog() {
  fs.writeFileSync(userLogFile(), '');
}
const logged = () => readUserLog().entries;

test('起跑：带 userTyped 的请求记一条 send，并带上会话/目录/模型上下文', async () => {
  resetLog();
  const r = await start({ prompt: '以后注释一律用中文', cwd: DATA_DIR, session: 'sess-1', convId: 'c1' });
  assert.equal(r.status, 200);
  assert.deepEqual(logged(), []); // 没打标记 → 不记（下面才是带标记的那次）

  await start({ prompt: '以后注释一律用中文', cwd: DATA_DIR, session: 'sess-1', convId: 'c1', userTyped: true });
  const [e] = logged();
  assert.equal(e.text, '以后注释一律用中文');
  assert.equal(e.source, 'web');
  assert.equal(e.kind, 'send');
  assert.equal(e.convId, 'c1');
  assert.equal(e.sessionId, 'sess-1');
  assert.equal(e.cwd, DATA_DIR);
  assert.equal(e.model, 'gpt-x');
  assert.ok(e.at > 0);
});

test('起跑：程序化发送（自动开发/复盘总结等不带 userTyped）一条都不记', async () => {
  resetLog();
  await start({ prompt: '请按开发文档实现以下需求……', cwd: DATA_DIR, convId: 'c1' });
  await start({ prompt: '请对本次开发做复盘总结', cwd: DATA_DIR, convId: 'c1', userTyped: 'true' }); // 字符串不算标记
  await start({ prompt: '继续', cwd: DATA_DIR, convId: 'c1', userTyped: 1 });
  assert.deepEqual(logged(), []);
});

test('起跑：种子前置时只记用户原文，不记被拼进去的系统正文', async () => {
  resetLog();
  await start({
    prompt: '【需求上下文】……一大段系统种子……\n\n先看下登录模块',
    typedText: '先看下登录模块',
    cwd: DATA_DIR,
    convId: 'c1',
    userTyped: true,
  });
  assert.equal(logged()[0].text, '先看下登录模块');
});

test('插话：带 userTyped 记成 kind=steer，上下文取自 run', async (t) => {
  resetLog();
  const run = createRun();
  t.after(() => finishRun(run));
  run.steerHold = true;
  run.convId = 'c9';
  run.session_id = 'sess-9';
  run.cwd = 'C:\\proj';
  run.model = 'sonnet';

  const r = await post('/send', { runId: run.id, text: '停，别动那个文件', userTyped: true });
  assert.equal(r.json.ok, true);
  const [e] = logged();
  assert.equal(e.kind, 'steer', 'steer 是「AI 跑偏被打断」的高价值信号，必须与 send 区分');
  assert.equal(e.text, '停，别动那个文件');
  assert.equal(e.convId, 'c9');
  assert.equal(e.sessionId, 'sess-9');
  assert.equal(e.cwd, 'C:\\proj');
  assert.equal(e.model, 'sonnet');
});

test('插话：程序化插话（无 userTyped）不记', async (t) => {
  resetLog();
  const run = createRun();
  t.after(() => finishRun(run));
  run.steerHold = true;
  const r = await post('/send', { runId: run.id, text: '设计准则已更新，请在后续开发中遵循：……' });
  assert.equal(r.json.ok, true);
  assert.deepEqual(logged(), []);
});

test('插话未被持有（run 已结束）时不记 —— 前端会降级成新一轮，由起跑那边记，避免重复', async () => {
  resetLog();
  const run = createRun();
  run.steerHold = true;
  finishRun(run);
  const r = await post('/send', { runId: run.id, text: '这句会走降级路径', userTyped: true });
  assert.equal(r.json.ok, false);
  assert.deepEqual(logged(), []);
});

test('空文本仍按原有 400 处理，且不落日志', async () => {
  resetLog();
  const run = createRun();
  run.steerHold = true;
  const r = await post('/send', { runId: run.id, text: '   ', userTyped: true });
  finishRun(run);
  assert.equal(r.status, 400);
  assert.deepEqual(logged(), []);
});

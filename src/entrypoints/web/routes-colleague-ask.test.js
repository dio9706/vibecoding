/**
 * /api/req/colleague-agent/turn 的「委托截获」分支测试。
 *
 * 不打真 HTTP、不碰真实注册表：直接调 handler + 假 req/res，`handleAskReply` 用桩件注入。
 * 原因：命中委托会异步跑判定引擎（真实 LLM 调用），集成路径由 feishu-ask.test.js 覆盖；
 * 本文件只钉路由层的分支与顺序（截获先于插件检查、不双起同事 agent）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

// 防 env 污染 + 隔离数据目录（routes-requirements 间接拉进多个 store）
delete process.env.LARK_APP_ID;
delete process.env.LARK_APP_SECRET;
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-ask-'));

const { handleColleagueAgentTurn } = await import('./routes-requirements.js');

function mockReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body))]);
}

function mockRes() {
  const cap = { code: 0, body: null };
  const res = {
    headersSent: false,
    setHeader() {},
    writeHead(code) {
      cap.code = code;
      res.headersSent = true;
    },
    end(text) {
      cap.body = text ? JSON.parse(text) : null;
    },
  };
  return { res, cap };
}

const flush = () => new Promise((r) => setImmediate(r));

test('命中进行中的委托 → 202 delegated，不启动同事对话 agent', async () => {
  const seen = [];
  const turns = [];
  const { res, cap } = mockRes();
  await handleColleagueAgentTurn(mockReq({ colleagueId: 'cl_z', text: '字段是 user_id' }), res, {
    handleAskReply: (cid, msg) => {
      seen.push([cid, msg.text]);
      return { questionId: 'fq_1', step: Promise.resolve() };
    },
    handleTurn: (x) => {
      turns.push(x);
      return Promise.resolve();
    },
    isEnabled: () => true,
  });
  await flush();
  assert.equal(cap.code, 202);
  assert.deepEqual(cap.body, { ok: true, delegated: true });
  assert.equal(turns.length, 0, '一条消息只能有一套处理：截获后不得再起同事 agent');
  assert.deepEqual(seen, [['cl_z', '字段是 user_id']]);
});

test('截获先于插件启停检查：colleague-agent 停用时答复也不丢', async () => {
  const { res, cap } = mockRes();
  await handleColleagueAgentTurn(mockReq({ colleagueId: 'cl_z', text: '答复' }), res, {
    handleAskReply: () => ({ questionId: 'fq_1', step: Promise.resolve() }),
    handleTurn: async () => {},
    isEnabled: () => false,
  });
  assert.equal(cap.code, 202);
  assert.equal(cap.body.delegated, true);
});

test('没有进行中的委托 → 正常路径：202 并起一轮同事 agent', async () => {
  const turns = [];
  const { res, cap } = mockRes();
  await handleColleagueAgentTurn(mockReq({ colleagueId: 'cl_z', text: '随便聊聊' }), res, {
    handleAskReply: () => null,
    handleTurn: (x) => {
      turns.push(x);
      return Promise.resolve();
    },
    isEnabled: () => true,
  });
  await flush();
  assert.equal(cap.code, 202);
  assert.deepEqual(cap.body, { ok: true });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].colleagueId, 'cl_z');
});

test('没有委托 + 插件停用 → 409', async () => {
  const { res, cap } = mockRes();
  await handleColleagueAgentTurn(mockReq({ colleagueId: 'cl_z', text: 'x' }), res, {
    handleAskReply: () => null,
    handleTurn: async () => {},
    isEnabled: () => false,
  });
  assert.equal(cap.code, 409);
});

test('缺 colleagueId / 空内容 → 400（截获之前先校验）', async () => {
  const a = mockRes();
  await handleColleagueAgentTurn(mockReq({ text: 'x' }), a.res, { handleAskReply: () => null });
  assert.equal(a.cap.code, 400);

  const b = mockRes();
  await handleColleagueAgentTurn(mockReq({ colleagueId: 'cl_z', text: '  ' }), b.res, { handleAskReply: () => null });
  assert.equal(b.cap.code, 400);
});

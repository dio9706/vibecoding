/**
 * develop 首轮提示词的「领票」端点。
 *
 * 为什么要有票：原判据是前端 localStorage 里「这个会话有没有消息」。服务端起的开发 run
 * 若当时没人挂着看，过程压根不落 localStorage（loadReqTranscript 的注释自己承认这点），
 * 于是下次进入被判成「从没开发过」，提示词重发一遍、开新 session、再烧一份额度
 *（2026-08-28 日志实证：02:09:01 与 02:58:56 各发了一次同一份【需求】v5.8 提示词）。
 * 而且 localStorage 不跨窗口加锁，两个窗口会同时判 false 各发一遍。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reqv2-claim-'));

const { handleReqV2Routes } = await import('./routes-req-v2.js');
const { createRequirement, updateRequirement, getRequirement } = await import('../../store/requirements.js');

let server, base;
test.before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const hit = handleReqV2Routes(req, res, url, url.pathname, req.method);
    if (!hit) res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const claim = async (id) => {
  const res = await fetch(`${base}/api/req/dev-prompt-claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test('首次领票 granted:true 并落 devPromptSentAt；再领 granted:false', async () => {
  const r = createRequirement({ title: '领票需求' });
  updateRequirement(r.id, { phase: 'dev' });

  const first = await claim(r.id);
  assert.equal(first.status, 200);
  assert.equal(first.json.granted, true, '首次必须领到票，否则提示词永远发不出去');
  assert.ok(getRequirement(r.id).devPromptSentAt, '领到票就要落标记，否则下次还会重发');

  const second = await claim(r.id);
  assert.equal(second.json.granted, false, '第二次必须拒票——这正是重发 bug 的闸门');
});

test('存量数据：无 devPromptSentAt 但有 devSession → 拒票并回填标记', async () => {
  const r = createRequirement({ title: '存量需求' });
  updateRequirement(r.id, { phase: 'dev', devSession: 'sess-old' });

  const got = await claim(r.id);
  assert.equal(got.json.granted, false, '历史需求上线后首次打开不能被补发一次提示词');
  assert.ok(getRequirement(r.id).devPromptSentAt, '兜底判定也要回填，避免每次进入都重算');
});

test('两者都无 → 视为全新，放票', async () => {
  const r = createRequirement({ title: '全新需求' });
  updateRequirement(r.id, { phase: 'dev' });
  assert.equal((await claim(r.id)).json.granted, true);
});

test('id 不存在 → 400，不放票', async () => {
  const got = await claim('r_not_exist');
  assert.equal(got.status, 400);
  assert.notEqual(got.json?.granted, true);
});

test('缺 id → 400', async () => {
  const got = await claim('');
  assert.equal(got.status, 400);
});

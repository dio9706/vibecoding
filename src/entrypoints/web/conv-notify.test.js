/**
 * injectToConv 的 busy inbox 路由（T2-P4）：同 conv 有运行中 run 时按能力进 inbox
 * （Claude → steer 持有区；openai → follow-up 排队），绝不并发起第二个 run；
 * 两个能力都没有时明确拒绝。非运行路径（起新 run）需要真实 provider，另行覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-notify-inject-'));
const { injectToConv } = await import('./conv-notify.js');
const { enableConv, getEntry } = await import('../../store/conv-notify.js');
const { createRun, finishRun, listFollowUps, clearFollowUps } = await import('../../store/runs.js');

test.beforeEach(() => clearFollowUps());

test('openai 运行中注入 → follow-up 排队（不再并发第二个 run），并落 entry.inbox', async (t) => {
  const convId = 'c_inject_fu';
  enableConv({ convId, title: 't', cwd: process.cwd() });
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = convId;
  run.provider = 'openai-compat';
  run.capabilities.followUp = true;
  run.cwd = 'C:\\proj';
  run.model = 'glm-4';

  const r = injectToConv(convId, '  补充一句  ');
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'follow_up');
  assert.equal(r.runId, run.id, '响应 runId 指向运行中的 run，便于前端接流');
  const items = listFollowUps(convId);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, '补充一句', '注入文本 trim 后入队');
  assert.equal(items[0].source, 'feishu');
  assert.equal(items[0].cwd, 'C:\\proj', '上下文快照取自运行中的 run（排空起跑用）');

  const entry = getEntry(convId);
  assert.equal(entry.inbox.length, 1);
  assert.equal(entry.inbox[0].id, items[0].id);
  assert.equal(entry.inbox[0].mode, 'follow_up');
  assert.equal(entry.inbox[0].runId, run.id);
});

test('Claude 运行中注入 → 保持现有 steer 语义（进持有区，不排队）', async (t) => {
  const convId = 'c_inject_steer';
  enableConv({ convId, title: 't', cwd: process.cwd() });
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = convId;
  run.provider = 'claude-agent';
  run.capabilities.steer = true;

  const r = injectToConv(convId, '插一句');
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'steer');
  assert.equal(run.heldMsgs.length, 1);
  assert.equal(run.heldMsgs[0].text, '插一句');
  assert.equal(listFollowUps(convId).length, 0);
});

test('两能力都没有的运行中 run → 明确拒绝（409），绝不退回并发起新 run', async (t) => {
  const convId = 'c_inject_none';
  enableConv({ convId, title: 't', cwd: process.cwd() });
  const run = createRun();
  t.after(() => finishRun(run));
  run.convId = convId;

  const r = injectToConv(convId, '无处安放');
  assert.equal(r.ok, false);
  assert.equal(r.code, 409);
  assert.equal(listFollowUps(convId).length, 0);
});

/**
 * busy inbox 排空编排（conv-inbox.js）单测：起跑路由 / 合批 / 不并发 / 失败兜底。
 * 隔离与惯例：APP_DATA_DIR → 临时目录 + 动态 import（run-claude/run-openai 的依赖链在模块求值时
 * 会读数据目录）；起跑器用 deps 注入假实现——不碰真实 provider、不落盘、不起子进程。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-inbox-'));
const { drainFollowUps } = await import('./conv-inbox.js');
const { createRun, finishRun, enqueueFollowUp, buildFollowUpItem, listFollowUps, clearFollowUps } = await import(
  '../../store/runs.js'
);

function fakeDeps() {
  const calls = { openai: [], claude: [], fail: [], marks: [], events: [] };
  let n = 0;
  return {
    calls,
    deps: {
      createRun: () => ({ id: 'run_new_' + ++n, convId: null, capabilities: { steer: false, followUp: false } }),
      emitRunEvent: (run, type, data) => calls.events.push({ runId: run.id, type, data }),
      markFollowUpStarted: (convId, info) => calls.marks.push({ convId, ...info }),
      startOpenAiRun: (run, opts) => {
        calls.openai.push({ run, opts });
        return Promise.resolve();
      },
      startClaudeRun: (run, opts) => calls.claude.push({ run, opts }),
      failRun: (run, msg) => calls.fail.push({ run, msg }),
    },
  };
}

/** 造一个已终结的 openai run（排空的触发者） */
function deadOpenAiRun(convId, fields = {}) {
  const run = createRun();
  run.convId = convId;
  run.provider = 'openai-compat';
  run.cwd = 'C:\\proj';
  run.model = 'glm-4';
  run.credId = 'cred_1';
  Object.assign(run, fields);
  finishRun(run);
  return run;
}

test.beforeEach(() => clearFollowUps());

test('排空：多条排队合并为一轮，快照上下文（含 effort/mode）原样传给 openai 起跑器，并记 follow_up_started', () => {
  const src = deadOpenAiRun('c_drain', { effort: 'low', mode: 'acceptEdits' });
  const id1 = enqueueFollowUp('c_drain', buildFollowUpItem(src, { text: '第一句', source: 'feishu' }));
  const id2 = enqueueFollowUp('c_drain', buildFollowUpItem(src, { text: '第二句' }));
  // 排队期间用户切档（A6 起中途切档实时写回 run.mode）→ 排空应取最新值而不是排队快照
  src.mode = 'bypassPermissions';
  const { calls, deps } = fakeDeps();

  const started = drainFollowUps(src, deps);
  assert.deepEqual(started, { convId: 'c_drain', runId: 'run_new_1', ids: [id1, id2] });
  assert.equal(calls.openai.length, 1, 'openai 排队只起一个 run');
  assert.equal(calls.claude.length, 0);
  assert.equal(calls.openai[0].opts.prompt, '第一句\n\n第二句', '多条合并为一轮');
  assert.equal(calls.openai[0].opts.cwd, 'C:\\proj');
  assert.equal(calls.openai[0].opts.model, 'glm-4');
  assert.equal(calls.openai[0].opts.credId, 'cred_1');
  assert.equal(calls.openai[0].opts.effort, 'low', 'openai 自定义模型强度随快照带入排空（reasoning_effort）');
  assert.equal(calls.openai[0].opts.mode, 'bypassPermissions', '档位取排空时刻的最新值（此前丢失 → 退回 default 逐次询问）');
  assert.equal(calls.openai[0].opts.convId, 'c_drain');
  assert.deepEqual(calls.marks, [{ convId: 'c_drain', runId: 'run_new_1', ids: [id1, id2] }]);
  assert.equal(calls.events.length, 1);
  assert.equal(calls.events[0].type, 'follow_up_started');
  assert.equal(calls.events[0].runId, 'run_new_1');
  assert.deepEqual(calls.events[0].data.ids, [id1, id2]);
  assert.equal(calls.events[0].data.fromRunId, src.id);
  assert.deepEqual(listFollowUps('c_drain'), [], '排空后队列清空');
  assert.equal(drainFollowUps(src, fakeDeps().deps), null, '空队列再排空是 no-op');
});

test('不并发：该 conv 仍有 run 在跑时不取队列，留给它的终结口排空', (t) => {
  const src = deadOpenAiRun('c_busy');
  const live = createRun();
  t.after(() => finishRun(live));
  live.convId = 'c_busy';
  live.provider = 'openai-compat';
  live.capabilities.followUp = true;
  const id = enqueueFollowUp('c_busy', buildFollowUpItem(live, { text: '留给下个终结口' }));

  const { calls, deps } = fakeDeps();
  assert.equal(drainFollowUps(src, deps), null);
  assert.equal(listFollowUps('c_busy').length, 1, '并发守卫命中时不得清队列');
  assert.equal(calls.openai.length + calls.claude.length, 0);
  assert.equal(calls.marks.length, 0);

  // 活 run 终结后，同一份队列由新的排空接管
  finishRun(live);
  const started = drainFollowUps(live, deps);
  assert.equal(started.ids.length, 1);
  assert.equal(started.ids[0], id);
});

test('路由：claude-agent 排队项走 startClaudeRun（session/mode/effort 快照原样带上）', () => {
  const src = deadOpenAiRun('c_claude_item');
  const item = buildFollowUpItem(src, { text: '给 Claude 的下一轮' });
  // 手工造一条 Claude 快照（现实中 Claude 走 steer 不入队列；本用例钉住路由分支的正确性）
  enqueueFollowUp('c_claude_item', {
    ...item,
    provider: 'claude-agent',
    session: 'sess_1',
    effort: 'high',
    mode: 'acceptEdits',
  });
  const { calls, deps } = fakeDeps();

  const started = drainFollowUps(src, deps);
  assert.ok(started);
  assert.equal(calls.claude.length, 1);
  assert.equal(calls.openai.length, 0);
  const opts = calls.claude[0].opts;
  assert.equal(opts.prompt, '给 Claude 的下一轮');
  assert.equal(opts.session, 'sess_1');
  assert.equal(opts.effort, 'high');
  assert.equal(opts.mode, 'acceptEdits');
  assert.equal(opts.convId, 'c_claude_item');
});

test('失败兜底：起跑器同步抛错 → 对占位 run 走 failRun，排空不炸', () => {
  const src = deadOpenAiRun('c_throw');
  // provider 覆盖为 claude-agent：走同步起跑分支（openai 分支的 rejection 由下一个用例覆盖）
  enqueueFollowUp('c_throw', { ...buildFollowUpItem(src, { text: '会炸的消息' }), provider: 'claude-agent' });
  const { calls, deps } = fakeDeps();
  deps.startClaudeRun = () => {
    throw new Error('settings.json 损坏');
  };
  // provider 缺省按 Claude 分支走（与快照缺 provider 的兼容路径一致）
  const started = drainFollowUps(src, deps);
  assert.ok(started);
  assert.equal(calls.fail.length, 1);
  assert.equal(calls.fail[0].run.id, started.runId);
  assert.match(calls.fail[0].msg, /排队消息启动失败.*settings\.json 损坏/);
  assert.deepEqual(listFollowUps('c_throw'), []);
});

test('失败兜底：openai 起跑器异步 rejection → 占位 run 走 failRun（不产生未处理 rejection）', async () => {
  const src = deadOpenAiRun('c_reject');
  enqueueFollowUp('c_reject', buildFollowUpItem(src, { text: '异步炸' }));
  const { calls, deps } = fakeDeps();
  deps.startOpenAiRun = () => Promise.reject(new Error('凭证已删'));
  const started = drainFollowUps(src, deps);
  assert.ok(started);
  await new Promise((r) => setImmediate(r)); // 让 .catch 落下
  assert.equal(calls.fail.length, 1);
  assert.match(calls.fail[0].msg, /凭证已删/);
});

/**
 * conv 级 busy inbox 单测（T2-P4）：能力位默认值、排队/撤回/排空、快照字段、
 * 排空启动记录的 GC 与消费（findFollowUpStartByItem）。runs.js 保持纯内存——
 * 本文件不落盘；真实排空编排见 entrypoints/web/conv-inbox.test.js。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRun,
  finishRun,
  registerRunJournalSink,
  buildFollowUpItem,
  enqueueFollowUp,
  listFollowUps,
  takeFollowUps,
  cancelFollowUp,
  markFollowUpStarted,
  listFollowUpStarts,
  findFollowUpStartByItem,
  clearFollowUps,
} from './runs.js';

const events = [];
registerRunJournalSink((e) => events.push(e));

const drain = (run) => run && finishRun(run); // 及时收尾，避免看门狗定时器拖住测试进程

test('能力位默认值：新建 run 两个能力均为 false（由各 provider 入口显式开启）', (t) => {
  const run = createRun();
  t.after(() => drain(run));
  assert.deepEqual(run.capabilities, { steer: false, followUp: false });
});

test('buildFollowUpItem：快照取自入队时运行中的 run（含 cwd/session/model/mode/provider/credId）', (t) => {
  const run = createRun();
  t.after(() => drain(run));
  run.convId = 'c1';
  run.cwd = 'C:\\proj';
  run.session_id = 'sess-1';
  run.model = 'glm-4';
  run.mode = 'acceptEdits';
  run.provider = 'openai-compat';
  run.credId = 'cred-1';
  const item = buildFollowUpItem(run, { text: '补充', source: 'feishu' });
  assert.deepEqual(
    { ...item, runId: undefined },
    {
      text: '补充',
      source: 'feishu',
      cwd: 'C:\\proj',
      session: 'sess-1',
      model: 'glm-4',
      effort: null,
      mode: 'acceptEdits',
      provider: 'openai-compat',
      credId: 'cred-1',
      runId: undefined,
    },
  );
});

test('enqueue/list/take：先进先出，take 取全量并清空；重复 id 不冲突', (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => drain(run));
  run.convId = 'c_order';
  run.capabilities.followUp = true;

  const id1 = enqueueFollowUp('c_order', buildFollowUpItem(run, { text: '第一句' }));
  const id2 = enqueueFollowUp('c_order', buildFollowUpItem(run, { text: '第二句' }));
  assert.notEqual(id1, id2);
  assert.deepEqual(listFollowUps('c_order').map((m) => m.text), ['第一句', '第二句']);
  assert.deepEqual(listFollowUps('c_other'), []);

  const taken = takeFollowUps('c_order');
  assert.deepEqual(taken.map((m) => m.text), ['第一句', '第二句']);
  assert.deepEqual(listFollowUps('c_order'), [], 'take 后队列清空');
});

test('journal：排队记 follow_up（截断文本），撤回记 follow_up_cancelled', (t) => {
  clearFollowUps();
  events.length = 0;
  const run = createRun();
  t.after(() => drain(run));
  run.convId = 'c_journal';
  run.capabilities.followUp = true;

  const id = enqueueFollowUp('c_journal', buildFollowUpItem(run, { text: 'x'.repeat(3000) }));
  assert.equal(cancelFollowUp('c_journal', id), true);
  assert.deepEqual(events.map((e) => e.type), ['follow_up', 'follow_up_cancelled']);
  assert.equal(events[0].runId, run.id, '挂在入队时运行中的 run 上');
  assert.equal(events[0].data.id, id);
  assert.equal(events[0].data.text.length, 2001, '2000 字 + 省略号');
  assert.ok(events[0].data.text.endsWith('…'));
  assert.equal(events[1].data.id, id);
});

test('cancelFollowUp：不存在/已排空返回 false；仅删指定项', (t) => {
  clearFollowUps();
  const run = createRun();
  t.after(() => drain(run));
  run.convId = 'c_cancel';
  const id1 = enqueueFollowUp('c_cancel', buildFollowUpItem(run, { text: 'a' }));
  enqueueFollowUp('c_cancel', buildFollowUpItem(run, { text: 'b' }));
  assert.equal(cancelFollowUp('c_cancel', 'fu_ghost'), false);
  assert.equal(cancelFollowUp('c_cancel', id1), true);
  assert.deepEqual(listFollowUps('c_cancel').map((m) => m.text), ['b']);
  assert.equal(cancelFollowUp('c_cancel', id1), false, '重复撤回返回 false');
});

test('markFollowUpStarted：列表记录、按项查排空 run、30min GC、上限淘汰', () => {
  clearFollowUps();
  const t0 = Date.now();
  markFollowUpStarted('c_a', { runId: 'run_a', ids: ['fu_1', 'fu_2'], now: t0 });
  markFollowUpStarted('c_b', { runId: 'run_b', ids: ['fu_3'], now: t0 + 1000 });

  assert.deepEqual(findFollowUpStartByItem('fu_2', t0 + 2000)?.runId, 'run_a');
  assert.deepEqual(findFollowUpStartByItem('fu_3', t0 + 2000)?.runId, 'run_b');
  assert.equal(findFollowUpStartByItem('fu_unknown', t0 + 2000), null);
  assert.deepEqual(listFollowUpStarts(t0 + 2000).map((e) => e.runId), ['run_a', 'run_b']);

  // 30 分钟窗口：旧记录被 GC，新记录仍在（懒清理：下次调用时生效）
  const later = t0 + 30 * 60 * 1000 + 500; // run_a 恰好过窗、run_b 未过
  assert.deepEqual(listFollowUpStarts(later).map((e) => e.runId), ['run_b']);
  assert.equal(findFollowUpStartByItem('fu_1', later), null);

  // 上限淘汰：超量只留最新
  for (let i = 0; i < 60; i++) markFollowUpStarted('c_bulk', { runId: 'run_bulk_' + i, ids: ['fu_bulk_' + i], now: later });
  const kept = listFollowUpStarts(later);
  assert.ok(kept.length <= 50, '50 条上限');
  assert.equal(kept.at(-1).runId, 'run_bulk_59');
});

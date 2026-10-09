/**
 * P5 落盘接线单测：journal sink 链路（emitRunEvent → sink → run-journal.jsonl）
 * + run 锚点单写 run-index（active-runs 已退役；旧表升级迁移的用例在 run-index.test.js）。
 * 隔离：APP_DATA_DIR → 临时目录；动态 import（store 基座在模块求值时定死数据目录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'run-durability-'));
const {
  startRunDurability,
  appendStandaloneRunEvent,
  mirrorRunStart,
  mirrorRunPatch,
  mirrorRunRemove,
  mirrorRunsRemove,
} = await import('./run-durability.js');
const { listRunIndex, clearRunIndex } = await import('../../store/run-index.js');
const { readRunEvents, tailRunEvents, clearRunJournal } = await import('../../store/run-journal.js');
const { createRun, finishRun, emitRunEvent } = await import('../../store/runs.js');

test('mirror：START/PATCH/REMOVE 全部落到 run-index（P5 唯一恢复来源）', () => {
  clearRunIndex();
  const entry = {
    runId: 'run_dual_1',
    convId: 'c1',
    provider: 'claude-agent',
    session_id: null,
    pid: process.pid,
    startedAt: Date.now(),
    status: 'running',
  };
  mirrorRunStart(entry);
  assert.equal(listRunIndex().length, 1);
  assert.equal(listRunIndex()[0].provider, 'claude-agent');

  mirrorRunPatch('run_dual_1', { session_id: 's1' });
  assert.equal(listRunIndex()[0].session_id, 's1');

  mirrorRunStart({ ...entry, runId: 'run_dual_2' });
  mirrorRunsRemove(['run_dual_1', 'run_dual_2', 'ghost']);
  assert.deepEqual(listRunIndex(), []);
});

test('mirrorRunRemove：单条移除', () => {
  clearRunIndex();
  mirrorRunStart({ runId: 'run_dual_3', convId: 'c3' });
  mirrorRunRemove('run_dual_3');
  assert.deepEqual(listRunIndex(), []);
});

/**
 * P5 由影子转正后**保持尽力而为**语义：索引文件损坏/磁盘抖动时 mirror 只记日志不向上抛。
 * 若改为冒泡，一次 EBUSY 就能让 run 启动路径 500、或让终止清理把收尾链打断——
 * 代价（最坏崩溃后不自动续跑）远小于收益（对话稳定）。
 */
test('mirror 写失败吞掉：索引文件损坏时（读改写抛错）不向上抛', () => {
  const file = path.join(process.env.APP_DATA_DIR, 'run-index.json');
  fs.writeFileSync(file, '{broken');
  assert.doesNotThrow(() => mirrorRunStart({ runId: 'run_boom' }));
  assert.doesNotThrow(() => mirrorRunPatch('run_boom', { session_id: 's' }));
  assert.doesNotThrow(() => mirrorRunRemove('run_boom'));
  assert.doesNotThrow(() => mirrorRunsRemove(['run_boom']));
  fs.writeFileSync(file, '[]'); // 复原，不影响后续用例
});

test('startRunDurability：emitRunEvent 经 sink 落盘 journal；重复注册不落重', () => {
  clearRunJournal();
  startRunDurability();
  startRunDurability(); // 幂等：第二次不得再注册一个 sink
  const run = createRun();
  run.convId = 'c_sink';
  emitRunEvent(run, 'session', { session_id: 's_sink' });
  finishRun(run); // 终结事件（settled）也落盘
  const evs = readRunEvents(run.id);
  assert.deepEqual(evs.map((e) => e.type), ['session', 'settled'], '同一事件只落一条');
  assert.equal(evs[0].data.session_id, 's_sink');
  assert.equal(evs[0].convId, 'c_sink');
});

test('appendStandaloneRunEvent：无 run 的独立事件（abandoned）落盘且不抛', () => {
  clearRunJournal();
  appendStandaloneRunEvent('c_ab', 'abandoned', { attempts: 4, reason: '超过上限' });
  const tail = tailRunEvents(1);
  assert.equal(tail.length, 1);
  assert.equal(tail[0].type, 'abandoned');
  assert.equal(tail[0].convId, 'c_ab');
  assert.equal(tail[0].runId, null);
  assert.equal(tail[0].data.attempts, 4);
});

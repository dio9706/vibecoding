/**
 * run-index 单测：CRUD（影子索引落盘） + 多实例守卫 partition（自 active-runs.test.js 迁移，
 * 背景注释见原文件/run-index.js——PM2 web 与桌面版共用 APP_DATA_DIR 时的抢跑事故）。
 * 隔离：APP_DATA_DIR 指向临时目录后再动态 import（store/index.js 在模块求值时定死数据目录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'run-index-'));
const DATA_DIR = process.env.APP_DATA_DIR;
const {
  listRunIndex,
  upsertRun,
  patchRun,
  removeRun,
  removeRuns,
  clearRunIndex,
  isPidAlive,
  partitionRunIndex,
  migrateLegacyActiveRuns,
} = await import('./run-index.js');

// ---- CRUD ----

test('upsertRun：登记与覆盖（同 runId 去重，后写覆盖）', () => {
  clearRunIndex();
  upsertRun({ runId: 'r1', convId: 'c1', status: 'running' });
  upsertRun({ runId: 'r2', convId: 'c2', status: 'running' });
  upsertRun({ runId: 'r1', convId: 'c1', status: 'settled', subtype: 'done' });
  const list = listRunIndex();
  assert.equal(list.length, 2);
  const r1 = list.find((e) => e.runId === 'r1');
  assert.equal(r1.status, 'settled');
  assert.equal(r1.subtype, 'done');
});

test('patchRun：补写字段；不存在的 runId 不写盘（宁缺勿补）', () => {
  clearRunIndex();
  upsertRun({ runId: 'r1', session_id: null });
  patchRun('r1', { session_id: 's1' });
  assert.equal(listRunIndex()[0].session_id, 's1');
  patchRun('ghost', { session_id: 'x' });
  assert.equal(listRunIndex().length, 1, '幽灵补写不得新增条目');
});

test('removeRun / removeRuns：按 id 移除，不整表清空', () => {
  clearRunIndex();
  upsertRun({ runId: 'a' });
  upsertRun({ runId: 'b' });
  upsertRun({ runId: 'c' });
  removeRun('a');
  assert.deepEqual(listRunIndex().map((e) => e.runId), ['b', 'c']);
  removeRuns(['b', 'ghost']);
  assert.deepEqual(listRunIndex().map((e) => e.runId), ['c']);
  removeRuns([]); // 空集合是 no-op，不得误伤
  assert.equal(listRunIndex().length, 1);
});

// ---- 多实例守卫（自 active-runs.test.js 原样迁移）----

const BOOT = 1_000_000; // 本次开机时间（ms）
const alive = (pids) => (pid) => pids.includes(pid);

test('partitionRunIndex：属主进程已死 → 判为孤儿，可回收', () => {
  const e = { runId: 'r1', pid: 4242, startedAt: BOOT + 500 };
  const r = partitionRunIndex([e], { selfPid: 99, isPidAlive: alive([99]), bootTimeMs: BOOT });
  assert.deepEqual(r.orphans, [e]);
  assert.deepEqual(r.foreign, []);
});

test('partitionRunIndex：属主进程仍存活且不是自己 → 判为他人所有，不得回收（核心回归）', () => {
  const e = { runId: 'r1', pid: 4242, startedAt: BOOT + 500 };
  const r = partitionRunIndex([e], { selfPid: 99, isPidAlive: alive([99, 4242]), bootTimeMs: BOOT });
  assert.deepEqual(r.orphans, []);
  assert.deepEqual(r.foreign, [e]);
});

test('partitionRunIndex：条目属于本进程 → 判为孤儿（刚启动时不该存在自己的残留）', () => {
  const e = { runId: 'r1', pid: 99, startedAt: BOOT + 500 };
  const r = partitionRunIndex([e], { selfPid: 99, isPidAlive: alive([99]), bootTimeMs: BOOT });
  assert.deepEqual(r.orphans, [e]);
});

test('partitionRunIndex：pid 存活但条目早于本次开机 → pid 是被复用的，判为孤儿', () => {
  const e = { runId: 'r1', pid: 4242, startedAt: BOOT - 10_000 };
  const r = partitionRunIndex([e], { selfPid: 99, isPidAlive: alive([99, 4242]), bootTimeMs: BOOT });
  assert.deepEqual(r.orphans, [e], 'pid 复用时必须仍能回收，否则任务永远卡住');
});

test('partitionRunIndex：旧数据没有 pid 字段 → 按孤儿处理（向后兼容）', () => {
  const e = { runId: 'r1', session_id: 's', convId: 'c' };
  const r = partitionRunIndex([e], { selfPid: 99, isPidAlive: alive([99]), bootTimeMs: BOOT });
  assert.deepEqual(r.orphans, [e]);
});

test('partitionRunIndex：混合场景正确分组', () => {
  const mine = { runId: 'a', pid: 99, startedAt: BOOT + 1 };
  const dead = { runId: 'b', pid: 500, startedAt: BOOT + 1 };
  const live = { runId: 'c', pid: 600, startedAt: BOOT + 1 };
  const legacy = { runId: 'd' };
  const r = partitionRunIndex([mine, dead, live, legacy], {
    selfPid: 99,
    isPidAlive: alive([99, 600]),
    bootTimeMs: BOOT,
  });
  assert.deepEqual(r.orphans.map((x) => x.runId), ['a', 'b', 'd']);
  assert.deepEqual(r.foreign.map((x) => x.runId), ['c']);
});

test('partitionRunIndex：空输入不抛异常', () => {
  const r = partitionRunIndex([], { selfPid: 1, isPidAlive: () => false, bootTimeMs: 0 });
  assert.deepEqual(r, { orphans: [], foreign: [] });
  const r2 = partitionRunIndex(null, { selfPid: 1, isPidAlive: () => false, bootTimeMs: 0 });
  assert.deepEqual(r2, { orphans: [], foreign: [] });
});

test('isPidAlive：本进程存活；非法值一律 false（signal 0 探测）', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(NaN), false);
  assert.equal(isPidAlive('42'), false);
});

// ---- 升级迁移（P5：旧 active-runs.json → 本索引）----

const LEGACY = path.join(DATA_DIR, 'active-runs.json');

test('migrateLegacyActiveRuns：旧表条目并入（不覆盖既有索引版本），随后清空旧表', () => {
  clearRunIndex();
  upsertRun({ runId: 'dup', convId: 'c_index', marker: 'index' }); // 双写期索引版本为准
  fs.writeFileSync(
    LEGACY,
    JSON.stringify([
      { runId: 'legacy_1', convId: 'c_legacy', session_id: 's1' },
      { runId: 'dup', convId: 'c_legacy_dup' },
    ]),
  );
  const added = migrateLegacyActiveRuns();
  assert.equal(added, 1, '只并入索引里没有的那条');
  const list = listRunIndex();
  assert.equal(list.length, 2);
  assert.equal(list.find((e) => e.runId === 'legacy_1').convId, 'c_legacy');
  assert.equal(list.find((e) => e.runId === 'dup').convId, 'c_index', '既有条目不覆盖');
  assert.deepEqual(JSON.parse(fs.readFileSync(LEGACY, 'utf8')), [], '旧表已清空');

  // 幂等：旧表已空，再次迁移是 no-op
  assert.equal(migrateLegacyActiveRuns(), 0);
});

test('migrateLegacyActiveRuns：旧表损坏时跳过（返回 0、不抛、保留原文件待人工处理）', () => {
  clearRunIndex();
  fs.writeFileSync(LEGACY, '{broken');
  assert.equal(migrateLegacyActiveRuns(), 0);
  assert.equal(fs.readFileSync(LEGACY, 'utf8'), '{broken', '损坏文件不得被清掉');
  assert.deepEqual(listRunIndex(), [], '索引不得被写入脏数据');
  fs.writeFileSync(LEGACY, '[]'); // 复原
});

test('migrateLegacyActiveRuns：旧表不存在/为空 → 0 且不新建文件', () => {
  clearRunIndex();
  fs.rmSync(LEGACY, { force: true });
  assert.equal(migrateLegacyActiveRuns(), 0);
  assert.equal(fs.existsSync(LEGACY), false, '没有存量就不该凭空建旧表文件');
  fs.writeFileSync(LEGACY, '[]');
  assert.equal(migrateLegacyActiveRuns(), 0);
});

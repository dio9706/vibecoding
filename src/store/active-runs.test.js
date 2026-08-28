import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionActiveRuns } from './active-runs.js';

/**
 * 背景：recoverPendingAndOrphans 启动时**无条件** clearActiveRuns()，
 * 并把读到的每一条都当孤儿转「待续跑」自动发「继续」。
 * 而 ecosystem.config.cjs 明确让 PM2 的 principal-web 与 Tauri 桌面版**共用同一个 APP_DATA_DIR**
 * （前者 3000、后者 9701，设计上可同时运行），根 server.js 又是 sidecar 入口、加载同一个 web server 模块。
 * 于是：PM2 有 run 在跑时双击启动桌面版 → 桌面进程把这些条目当孤儿清空并对同一 session_id
 * 自动续跑 → **同一会话被两个进程并发跑**：重复烧额度、并发写同一工作目录、resumeAttempt 被污染。
 *
 * 判定要点：pid 存活即视为「有主」；但 pid 会在重启后被复用，
 * 所以还要求条目的 startedAt 不早于本次开机时间。
 */

const BOOT = 1_000_000; // 本次开机时间（ms）
const alive = (pids) => (pid) => pids.includes(pid);

test('partitionActiveRuns：属主进程已死 → 判为孤儿，可回收', () => {
  const e = { runId: 'r1', pid: 4242, startedAt: BOOT + 500 };
  const r = partitionActiveRuns([e], { selfPid: 99, isPidAlive: alive([99]), bootTimeMs: BOOT });
  assert.deepEqual(r.orphans, [e]);
  assert.deepEqual(r.foreign, []);
});

test('partitionActiveRuns：属主进程仍存活且不是自己 → 判为他人所有，不得回收（核心回归）', () => {
  const e = { runId: 'r1', pid: 4242, startedAt: BOOT + 500 };
  const r = partitionActiveRuns([e], { selfPid: 99, isPidAlive: alive([99, 4242]), bootTimeMs: BOOT });
  assert.deepEqual(r.orphans, []);
  assert.deepEqual(r.foreign, [e]);
});

test('partitionActiveRuns：条目属于本进程 → 判为孤儿（刚启动时不该存在自己的残留）', () => {
  const e = { runId: 'r1', pid: 99, startedAt: BOOT + 500 };
  const r = partitionActiveRuns([e], { selfPid: 99, isPidAlive: alive([99]), bootTimeMs: BOOT });
  assert.deepEqual(r.orphans, [e]);
});

test('partitionActiveRuns：pid 存活但条目早于本次开机 → pid 是被复用的，判为孤儿', () => {
  const e = { runId: 'r1', pid: 4242, startedAt: BOOT - 10_000 };
  const r = partitionActiveRuns([e], { selfPid: 99, isPidAlive: alive([99, 4242]), bootTimeMs: BOOT });
  assert.deepEqual(r.orphans, [e], 'pid 复用时必须仍能回收，否则任务永远卡住');
});

test('partitionActiveRuns：旧数据没有 pid 字段 → 按孤儿处理（向后兼容）', () => {
  const e = { runId: 'r1', session_id: 's', convId: 'c' };
  const r = partitionActiveRuns([e], { selfPid: 99, isPidAlive: alive([99]), bootTimeMs: BOOT });
  assert.deepEqual(r.orphans, [e]);
});

test('partitionActiveRuns：混合场景正确分组', () => {
  const mine = { runId: 'a', pid: 99, startedAt: BOOT + 1 };
  const dead = { runId: 'b', pid: 500, startedAt: BOOT + 1 };
  const live = { runId: 'c', pid: 600, startedAt: BOOT + 1 };
  const legacy = { runId: 'd' };
  const r = partitionActiveRuns([mine, dead, live, legacy], {
    selfPid: 99,
    isPidAlive: alive([99, 600]),
    bootTimeMs: BOOT,
  });
  assert.deepEqual(r.orphans.map((x) => x.runId), ['a', 'b', 'd']);
  assert.deepEqual(r.foreign.map((x) => x.runId), ['c']);
});

test('partitionActiveRuns：空输入不抛异常', () => {
  const r = partitionActiveRuns([], { selfPid: 1, isPidAlive: () => false, bootTimeMs: 0 });
  assert.deepEqual(r, { orphans: [], foreign: [] });
  const r2 = partitionActiveRuns(null, { selfPid: 1, isPidAlive: () => false, bootTimeMs: 0 });
  assert.deepEqual(r2, { orphans: [], foreign: [] });
});

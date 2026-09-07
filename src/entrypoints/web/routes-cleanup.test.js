/**
 * 会话清理三端点的边界、状态码与响应契约。
 *
 * 不发任何 LLM 调用，纯文件系统：在假 cwd 对应的 project 目录里造若干带时间戳的会话，
 * 打 preview/execute 验证「按窗筛选 + confirmed 闸门 + 物理删除 + 审计日志」。
 *
 * 隔离：store/index.js 在模块求值时定死数据目录（event-log/active-runs 落这里），
 * 必须先设 APP_DATA_DIR 再动态 import。历史会话目录另在 ~/.claude/projects 下，用带 pid 的假 cwd 隔离。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-routes-'));
const { handleCleanupRoutes } = await import('./routes-cleanup.js');
const { getHistoryDir } = await import('../../store/history.js');
const { addActiveRun, clearActiveRuns } = await import('../../store/active-runs.js');
const { getEvents } = await import('../../store/event-log.js');

const FAKE_CWD = 'C:\\__cleanup-routes-' + process.pid;
const HIST_DIR = getHistoryDir(FAKE_CWD);

let server, base;
test.before(async () => {
  server = createServer((req, res) => handleCleanupRoutes(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  fs.rmSync(HIST_DIR, { recursive: true, force: true });
});

// 每个用例前重建历史目录与 active-runs，避免相互污染
test.beforeEach(() => {
  fs.rmSync(HIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(HIST_DIR, { recursive: true });
  clearActiveRuns();
});

/** 造一个 mtime 为 daysAgo 天前的会话文件 */
function writeAged(sid, daysAgo) {
  const f = path.join(HIST_DIR, sid + '.jsonl');
  fs.writeFileSync(f, JSON.stringify({ type: 'ai-title', aiTitle: sid }) + '\n');
  const t = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  fs.utimesSync(f, t, t);
}

async function call(pathname, method, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(base + pathname, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json };
}
const cwdQ = 'cwd=' + encodeURIComponent(FAKE_CWD);

test('GET /api/cleanup/stats：返回 totalCount 与 historyDir', async () => {
  writeAged('a', 10);
  writeAged('b', 2);
  const r = await call('/api/cleanup/stats?' + cwdQ, 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.json.totalCount, 2);
  assert.equal(r.json.cwd, FAKE_CWD);
  assert.ok(r.json.historyDir.includes('projects'));
});

test('GET /api/cleanup/preview：range 只数早于阈值的会话', async () => {
  writeAged('old', 20);
  writeAged('fresh', 1);
  const r = await call('/api/cleanup/preview?' + cwdQ + '&range=7', 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.json.willDeleteCount, 1);
  assert.ok(r.json.oldestSession);
});

test('GET /api/cleanup/preview：自定义日期区间闭区间命中', async () => {
  writeAged('in', 15);
  writeAged('out', 1);
  const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const to = new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10);
  const r = await call(`/api/cleanup/preview?${cwdQ}&fromDate=${from}&toDate=${to}`, 'GET');
  assert.equal(r.json.willDeleteCount, 1);
});

test('POST /api/cleanup/execute：confirmed 缺失时 400 且不删', async () => {
  writeAged('x', 30);
  const r = await call('/api/cleanup/execute', 'POST', { cwd: FAKE_CWD, range: 7 });
  assert.equal(r.status, 400);
  assert.ok(fs.existsSync(path.join(HIST_DIR, 'x.jsonl')));
});

test('POST /api/cleanup/execute：缺时间范围时 400', async () => {
  const r = await call('/api/cleanup/execute', 'POST', { cwd: FAKE_CWD, confirmed: true });
  assert.equal(r.status, 400);
});

test('POST /api/cleanup/execute：确认后物理删除并回报剩余数 + 记审计日志', async () => {
  writeAged('old1', 20);
  writeAged('old2', 30);
  writeAged('fresh', 1);
  const r = await call('/api/cleanup/execute', 'POST', { cwd: FAKE_CWD, range: 7, confirmed: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.deletedCount, 2);
  assert.equal(r.json.remainingCount, 1);
  assert.ok(r.json.freedBytes > 0);
  assert.ok(!fs.existsSync(path.join(HIST_DIR, 'old1.jsonl')));
  assert.ok(fs.existsSync(path.join(HIST_DIR, 'fresh.jsonl')));
  // 审计：event-log 里应有一条 session-cleanup
  assert.ok(getEvents().some((e) => e.type === 'session-cleanup' && e.deletedCount === 2));
});

test('POST /api/cleanup/execute：正在运行的 session 受保护不被删', async () => {
  writeAged('running', 30);
  writeAged('idle', 30);
  addActiveRun({ runId: 'r1', session_id: 'running', pid: process.pid, startedAt: Date.now() });
  const r = await call('/api/cleanup/execute', 'POST', { cwd: FAKE_CWD, range: 7, confirmed: true });
  assert.equal(r.json.deletedCount, 1);
  assert.ok(fs.existsSync(path.join(HIST_DIR, 'running.jsonl')), '运行中会话被误删');
  assert.ok(!fs.existsSync(path.join(HIST_DIR, 'idle.jsonl')));
});

test('未知路径 404', async () => {
  const r = await call('/api/cleanup/nope', 'GET');
  assert.equal(r.status, 404);
});

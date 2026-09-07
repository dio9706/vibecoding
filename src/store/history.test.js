import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getHistoryDir,
  getHistorySession,
  listHistorySessions,
  parseCleanupWindow,
  inCleanupWindow,
  countHistorySessions,
  previewCleanup,
  deleteHistorySessions,
} from './history.js';

// 用带 pid 的假 cwd 隔离出专用 project 目录，测完整体删除
const FAKE_CWD = 'C:\\__history-test-' + process.pid;
const SID = 'testsession';

function writeFixture(lines) {
  const dir = getHistoryDir(FAKE_CWD);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SID + '.jsonl'), lines.map((o) => JSON.stringify(o)).join('\n'));
  return dir;
}

test('getHistorySession 提取最后的 model 与 permissionMode', async (t) => {
  const dir = writeFixture([
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'user', message: { content: '你好' } },
    { type: 'assistant', message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'permission-mode', permissionMode: 'acceptEdits' },
    // 最后一条 assistant 只有 tool_use 无文本：不进 messages，但 model 仍应被采纳
    { type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [{ type: 'tool_use' }] } },
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = await getHistorySession(SID, FAKE_CWD);
  assert.equal(s.model, 'claude-sonnet-4-6');
  assert.equal(s.permissionMode, 'acceptEdits');
});

test('无相关行时 model/permissionMode 为空串', async (t) => {
  const dir = writeFixture([{ type: 'user', message: { content: 'hi' } }]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = await getHistorySession(SID, FAKE_CWD);
  assert.equal(s.model, '');
  assert.equal(s.permissionMode, '');
});

// ── listHistorySessions 的 mtime 缓存 ────────────────────────────
// 列表接口会被前端反复请求，而它对每个 jsonl 都要开文件解析前 50 行。
// 加了「mtime 没变就复用解析结果」的缓存后，必须证明它**该失效时真的会失效** ——
// 缓存最典型的故障不是慢，而是改了文件却还返回旧数据。

/** 往假 project 目录写一个会话文件，返回目录路径 */
function writeSession(sid, lines) {
  const dir = getHistoryDir(FAKE_CWD);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), lines.map((o) => JSON.stringify(o)).join('\n'));
  return dir;
}

test('mtime 缓存：内容变化后必须返回新标题（该失效就失效）', async (t) => {
  const dir = writeSession('cachetest', [{ type: 'ai-title', aiTitle: '旧标题' }]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = await listHistorySessions(100, 0, FAKE_CWD);
  assert.equal(first.find((s) => s.sessionId === 'cachetest')?.title, '旧标题');

  // 重写内容。文件系统 mtime 精度可能只到毫秒，显式改 mtime 确保它与上次不同 ——
  // 否则这条用例会因为「两次写入落在同一毫秒」而偶发假绿。
  writeSession('cachetest', [{ type: 'ai-title', aiTitle: '新标题' }]);
  const f = path.join(dir, 'cachetest.jsonl');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(f, future, future);

  const second = await listHistorySessions(100, 0, FAKE_CWD);
  assert.equal(
    second.find((s) => s.sessionId === 'cachetest')?.title,
    '新标题',
    'mtime 变了却仍返回旧标题 —— 缓存没失效',
  );
});

test('mtime 缓存：mtime 未变时结果保持一致（缓存命中路径正确）', async (t) => {
  const dir = writeSession('stable', [{ type: 'ai-title', aiTitle: '稳定标题' }]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const a = await listHistorySessions(100, 0, FAKE_CWD);
  const b = await listHistorySessions(100, 0, FAKE_CWD);
  const pick = (list) => list.find((s) => s.sessionId === 'stable');
  assert.deepEqual(pick(a), pick(b), '同一文件两次读取结果应完全一致');
  assert.equal(pick(b).title, '稳定标题');
});

test('mtime 缓存：文件删除后不得再出现在列表里（缓存要被淘汰）', async (t) => {
  const dir = writeSession('gone', [{ type: 'ai-title', aiTitle: '将被删除' }]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const before = await listHistorySessions(100, 0, FAKE_CWD);
  assert.ok(before.some((s) => s.sessionId === 'gone'));

  fs.rmSync(path.join(dir, 'gone.jsonl'));
  const after = await listHistorySessions(100, 0, FAKE_CWD);
  assert.equal(
    after.some((s) => s.sessionId === 'gone'),
    false,
    '文件已删除但仍从缓存里被列出',
  );
});

test('mtime 缓存：新增文件能被发现', async (t) => {
  const dir = writeSession('first', [{ type: 'ai-title', aiTitle: '第一个' }]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await listHistorySessions(100, 0, FAKE_CWD);

  writeSession('second', [{ type: 'ai-title', aiTitle: '第二个' }]);
  const list = await listHistorySessions(100, 0, FAKE_CWD);
  assert.ok(list.some((s) => s.sessionId === 'second'), '新增的会话未出现在列表里');
});

// ── 会话清理：纯逻辑（parseCleanupWindow / inCleanupWindow）────────────────

test('parseCleanupWindow：合法预设天数返回 range', () => {
  for (const r of [7, 14, 30, 90]) {
    assert.deepEqual(parseCleanupWindow({ range: r }), { range: r });
  }
  // 字符串数字也接受（来自 query string）
  assert.deepEqual(parseCleanupWindow({ range: '30' }), { range: 30 });
});

test('parseCleanupWindow：非预设天数不走 range，回落到自定义/无效', () => {
  // 15 不在预设集合、又无自定义日期 → null
  assert.equal(parseCleanupWindow({ range: 15 }), null);
  // 完全空 → null
  assert.equal(parseCleanupWindow({}), null);
});

test('parseCleanupWindow：自定义日期得到 [fromMs, toMs]，止=当日 23:59:59.999', () => {
  const win = parseCleanupWindow({ fromDate: '2026-08-01', toDate: '2026-08-31' });
  assert.equal(win.fromMs, new Date('2026-08-01T00:00:00').getTime());
  assert.equal(win.toMs, new Date('2026-08-31T23:59:59.999').getTime());
  // 单边也允许
  assert.equal(parseCleanupWindow({ toDate: '2026-08-31' }).fromMs, null);
  assert.equal(parseCleanupWindow({ fromDate: '2026-08-01' }).toMs, null);
});

test('parseCleanupWindow：非法输入返回 null', () => {
  assert.equal(parseCleanupWindow({ fromDate: '不是日期', toDate: '2026-08-31' }), null);
  assert.equal(parseCleanupWindow({ fromDate: '2026-09-30', toDate: '2026-08-31' }), null); // 起晚于止
});

test('inCleanupWindow：range 删除早于 now-N 天的，边界外的保留', () => {
  const now = Date.parse('2026-09-04T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const win = parseCleanupWindow({ range: 7 });
  assert.equal(inCleanupWindow(now - 8 * day, now, win), true); // 8 天前 → 删
  assert.equal(inCleanupWindow(now - 6 * day, now, win), false); // 6 天前 → 留
  assert.equal(inCleanupWindow(now, now, win), false); // 刚动过 → 留
});

test('inCleanupWindow：自定义区间为闭区间，两端命中、区间外保留', () => {
  const win = parseCleanupWindow({ fromDate: '2026-08-01', toDate: '2026-08-31' });
  const now = Date.now();
  assert.equal(inCleanupWindow(new Date('2026-08-15T10:00:00').getTime(), now, win), true);
  assert.equal(inCleanupWindow(new Date('2026-08-01T00:00:00').getTime(), now, win), true); // 下界含
  assert.equal(inCleanupWindow(new Date('2026-08-31T23:59:59').getTime(), now, win), true); // 上界含
  assert.equal(inCleanupWindow(new Date('2026-07-31T23:00:00').getTime(), now, win), false);
  assert.equal(inCleanupWindow(new Date('2026-09-01T00:30:00').getTime(), now, win), false);
});

test('inCleanupWindow：无效窗（null）一律不删', () => {
  assert.equal(inCleanupWindow(0, Date.now(), null), false);
});

// ── 会话清理：IO（previewCleanup / deleteHistorySessions / count）──────────

const CLEAN_CWD = 'C:\\__cleanup-test-' + process.pid;

/** 写一个会话文件并把它的 mtime 设成 daysAgo 天前 */
function writeAged(sid, daysAgo) {
  const dir = getHistoryDir(CLEAN_CWD);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, sid + '.jsonl');
  fs.writeFileSync(f, JSON.stringify({ type: 'ai-title', aiTitle: sid }) + '\n');
  const t = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  fs.utimesSync(f, t, t);
  return dir;
}

test('previewCleanup / deleteHistorySessions：range 只清早于阈值的旧会话', async (t) => {
  const dir = getHistoryDir(CLEAN_CWD);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAged('old20', 20); // 应删
  writeAged('old10', 10); // 应删
  writeAged('fresh2', 2); // 应留

  assert.equal(await countHistorySessions(CLEAN_CWD), 3);

  const preview = await previewCleanup(CLEAN_CWD, { range: 7 });
  assert.equal(preview.willDeleteCount, 2);
  assert.ok(preview.oldestSession && preview.newestSession);

  const res = await deleteHistorySessions(CLEAN_CWD, { range: 7 });
  assert.equal(res.deletedCount, 2);
  assert.ok(res.freedBytes > 0);
  assert.equal(await countHistorySessions(CLEAN_CWD), 1); // 只剩 fresh2
  assert.ok(fs.existsSync(path.join(dir, 'fresh2.jsonl')));
});

test('deleteHistorySessions：protectedIds 中的会话不删', async (t) => {
  const dir = getHistoryDir(CLEAN_CWD);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAged('running', 30);
  writeAged('idle', 30);

  const res = await deleteHistorySessions(CLEAN_CWD, { range: 7, protectedIds: ['running'] });
  assert.equal(res.deletedCount, 1);
  assert.ok(fs.existsSync(path.join(dir, 'running.jsonl')), '受保护会话被误删');
  assert.ok(!fs.existsSync(path.join(dir, 'idle.jsonl')));
});

test('deleteHistorySessions：无效窗不删任何文件（fail-closed）', async (t) => {
  const dir = getHistoryDir(CLEAN_CWD);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAged('keep', 100);
  const res = await deleteHistorySessions(CLEAN_CWD, { range: 15 }); // 15 非预设 → null 窗
  assert.equal(res.deletedCount, 0);
  assert.ok(fs.existsSync(path.join(dir, 'keep.jsonl')));
});

test('previewCleanup / count：目录不存在时返回 0，不抛错', async () => {
  const NOPE = 'C:\\__cleanup-nonexist-' + process.pid;
  assert.equal(await countHistorySessions(NOPE), 0);
  const preview = await previewCleanup(NOPE, { range: 7 });
  assert.equal(preview.willDeleteCount, 0);
  assert.equal(preview.oldestSession, null);
});

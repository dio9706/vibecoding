import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getHistoryDir, getHistorySession, listHistorySessions } from './history.js';

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

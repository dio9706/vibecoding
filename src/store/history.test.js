import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getHistoryDir, getHistorySession } from './history.js';

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

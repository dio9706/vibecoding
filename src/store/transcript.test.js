import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readTranscriptEvents, listTranscriptsSince, encodeProjectId } from './transcript.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'));

function writeJsonl(name, lines, mtimeMs, dir = tmpDir) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  if (mtimeMs) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

test('encodeProjectId 与 Claude CLI 目录名规则一致', () => {
  assert.equal(encodeProjectId('C:\\Users\\DELL\\Desktop\\claude-p-web-demo'),
    'C--Users-DELL-Desktop-claude-p-web-demo');
});

test('readTranscriptEvents 返回原始事件，保留块结构', () => {
  const p = writeJsonl('a.jsonl', [
    { type: 'user', message: { role: 'user', content: '你好' }, sessionId: 'a' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] }, sessionId: 'a' },
  ]);
  const evs = readTranscriptEvents(p);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].message.content, '你好');
  assert.equal(evs[1].message.content[0].type, 'tool_result', 'tool_result 块必须原样保留');
});

test('readTranscriptEvents 跳过坏行而不是整体失败', () => {
  const p = path.join(tmpDir, 'bad.jsonl');
  fs.writeFileSync(p, '{"type":"user"}\n{坏行\n\n{"type":"assistant"}\n', 'utf8');
  const evs = readTranscriptEvents(p);
  assert.equal(evs.length, 2);
});

test('readTranscriptEvents：文件不存在返回空数组', () => {
  assert.deepEqual(readTranscriptEvents(path.join(tmpDir, 'nope.jsonl')), []);
});

test('listTranscriptsSince 只返回 mtime 更新的会话，按 mtime 升序', () => {
  // 用独立子目录而非共享 tmpDir：前面的用例往 tmpDir 写了 a.jsonl/bad.jsonl，
  // 未指定 mtimeMs 时它们的 mtime 是「当前真实时间」，在任何真实年份都远晚于
  // 这里用的 sinceMs=1500000（1970 年附近），若共享目录会被一并列出而污染断言。
  const mtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-mtime-'));
  writeJsonl('old.jsonl', [{ type: 'user' }], 1000000, mtimeDir);
  writeJsonl('new1.jsonl', [{ type: 'user' }], 3000000, mtimeDir);
  writeJsonl('new2.jsonl', [{ type: 'user' }], 2000000, mtimeDir);
  const got = listTranscriptsSince(mtimeDir, 1500000).map((f) => path.basename(f.file));
  assert.deepEqual(got, ['new2.jsonl', 'new1.jsonl']);
});

test('listTranscriptsSince：目录不存在返回空数组', () => {
  assert.deepEqual(listTranscriptsSince(path.join(tmpDir, 'nodir'), 0), []);
});

test('listTranscriptsSince 忽略非 .jsonl 文件', () => {
  fs.writeFileSync(path.join(tmpDir, 'note.txt'), 'x', 'utf8');
  const got = listTranscriptsSince(tmpDir, 0).map((f) => path.basename(f.file));
  assert.ok(!got.includes('note.txt'));
});

/**
 * conv-messages 单测（T7 v2）：形状归一 / 磁盘安全裁剪（纯函数）+ 追加 / 摘要 / v1 兼容（fs 级）。
 * 隔离：APP_DATA_DIR → 临时目录；动态 import（store 基座在模块求值时定死数据目录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-messages-'));
const DATA_DIR = process.env.APP_DATA_DIR;
const {
  MAX_STORED,
  normalizeConvState,
  trimForStorage,
  getConvState,
  getMessages,
  getSummary,
  appendMessages,
  setSummary,
  clearMessages,
} = await import('./conv-messages.js');

const FILE = path.join(DATA_DIR, 'conv-messages.json');

// ---------- 纯函数 ----------

test('normalizeConvState：v1 数组归一；v2 摘要取合法字段（covered 收敛/坏形状弃用）', () => {
  const arr = [{ role: 'user', content: 'a' }];
  assert.deepEqual(normalizeConvState(arr), { messages: arr, summary: null });
  assert.deepEqual(normalizeConvState(undefined), { messages: [], summary: null });
  assert.deepEqual(normalizeConvState({ v: 2 }), { messages: [], summary: null });

  const v2 = normalizeConvState({ v: 2, messages: arr, summary: { text: 's', covered: 3.7, at: '123', model: 'm' } });
  assert.deepEqual(v2.summary, { text: 's', covered: 1, at: 123, model: 'm' }, 'covered 收敛到消息条数且取整');
  assert.equal(normalizeConvState({ messages: arr, summary: { text: 's', covered: 99 } }).summary.covered, 1);
  assert.equal(normalizeConvState({ messages: arr, summary: { covered: 1 } }).summary, null, '缺 text 弃用');
  assert.equal(normalizeConvState({ messages: arr, summary: 'x' }).summary, null);
});

test('trimForStorage：未超限原样；超限从头部丢到「新头部不是 tool 结果」', () => {
  const small = [{ role: 'user' }, { role: 'assistant' }];
  assert.deepEqual(trimForStorage(small, 10), { messages: small, dropped: 0 });

  const msgs = [{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }, { role: 'tool' }, { role: 'user' }];
  // 丢 3 条后新头部是 tool → 继续丢到 user（k=4）
  const r = trimForStorage(msgs, 2);
  assert.equal(r.dropped, 4);
  assert.deepEqual(r.messages.map((m) => m.role), ['user']);

  // 全 tool 的退化输入：至少留最后一条，不返回空数组
  const allTool = [{ role: 'tool' }, { role: 'tool' }];
  const r2 = trimForStorage(allTool, 1);
  assert.equal(r2.messages.length, 1);
});

// ---------- fs 级 ----------

test('appendMessages：追加落盘为 v2；setSummary 与消息同文件，往返一致', () => {
  clearMessages('c1');
  appendMessages('c1', [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
  assert.deepEqual(getMessages('c1').map((m) => m.content), ['a', 'b']);
  assert.equal(getSummary('c1'), null);

  const saved = setSummary('c1', { text: ' 摘要文本 ', covered: 1, model: 'glm-4' });
  assert.equal(saved.covered, 1);
  assert.equal(saved.model, 'glm-4');
  assert.equal(getSummary('c1').text.trim(), '摘要文本');

  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(raw.c1.v, 2, '写入即升级 v2 形状');
  assert.equal(raw.c1.summary.covered, 1);

  // 空文本不写（返回 null，不产生空摘要）
  assert.equal(setSummary('c1', { text: '   ', covered: 2 }), null);
  assert.equal(getSummary('c1').covered, 1);
});

test('appendMessages：v1 旧数组读侧兼容，写入后升级 v2', () => {
  fs.writeFileSync(FILE, JSON.stringify({ c_legacy: [{ role: 'user', content: 'old' }] }));
  assert.deepEqual(getMessages('c_legacy'), [{ role: 'user', content: 'old' }], 'v1 数组直接可读');
  assert.equal(getSummary('c_legacy'), null);

  appendMessages('c_legacy', [{ role: 'assistant', content: 'new' }]);
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(raw.c_legacy.v, 2);
  assert.equal(raw.c_legacy.messages.length, 2);
});

test('appendMessages：超过 MAX_STORED 按安全边界裁剪，covered 同锁平移', () => {
  clearMessages('c_big');
  appendMessages('c_big', Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: 'u' + i })));
  setSummary('c_big', { text: 's', covered: 5 });
  const bulk = Array.from({ length: 1000 }, (_, i) => (i % 2 ? { role: 'assistant', content: 'a' + i } : { role: 'user', content: 'u' + i }));
  appendMessages('c_big', bulk);

  const state = getConvState('c_big');
  assert.equal(state.messages.length, MAX_STORED, '磁盘 backstop 生效');
  assert.notEqual(state.messages[0].role, 'tool', '新头部不得是孤儿 tool 结果');
  assert.equal(state.summary.covered, 0, '裁剪 5 条 ≥ 覆盖 5 条 → 归零（摘要文本仍描述更早内容）');

  // covered 大于裁剪量时按差值下移
  clearMessages('c_shift');
  appendMessages('c_shift', Array.from({ length: 300 }, (_, i) => ({ role: 'user', content: 'u' + i })));
  setSummary('c_shift', { text: 's2', covered: 300 });
  appendMessages('c_shift', Array.from({ length: 800 }, (_, i) => ({ role: 'user', content: 'x' + i })));
  assert.equal(getConvState('c_shift').summary.covered, 300 - (1100 - MAX_STORED));
});

test('clearMessages：删除会话状态（消息+摘要）；不存在不写盘', () => {
  clearMessages('c_gone');
  assert.deepEqual(getMessages('c_gone'), []);
  appendMessages('c_gone', [{ role: 'user', content: 'x' }]);
  setSummary('c_gone', { text: 's', covered: 1 });
  clearMessages('c_gone');
  assert.deepEqual(getMessages('c_gone'), []);
  assert.equal(getSummary('c_gone'), null);
});

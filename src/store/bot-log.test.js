import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// APP_DATA_DIR 必须先于 store 模块引入设定（DATA_DIR 全进程只求值一次，详见 jsonl.test.js）。
const TMP = path.join(os.tmpdir(), `cad-botlog-test-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.APP_DATA_DIR = TMP;

const { appendBotLog, getBotLogs, clearBotLogs } = await import('./bot-log.js');
const FILE = path.join(TMP, 'bot-log.jsonl');

/** 每个用例前把落点恢复成「文件不存在」的干净状态 */
function reset() {
  fs.rmSync(FILE, { recursive: true, force: true });
}

after(() => {
  delete process.env.APP_DATA_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('文件不存在时 getBotLogs 返回空数组而非抛错', () => {
  reset();
  assert.deepStrictEqual(getBotLogs(), []);
});

test('写入后按最新在前读出，time 自动补齐', async () => {
  reset();

  await appendBotLog({
    botId: 'bot_1', botName: '机器人 1',
    userId: 'ou_abc', userName: '申孟涛',
    kind: 'action', detail: '获取小程序二维码', ok: true, code: 0,
  });
  await appendBotLog({
    botId: 'bot_1', botName: '机器人 1',
    userId: 'ou_abc', userName: '申孟涛',
    kind: 'chat', detail: '帮我看下登录接口报错', ok: true,
  });

  const logs = getBotLogs();
  assert.equal(logs.length, 2);
  assert.equal(logs[0].kind, 'chat', '最新在前');
  assert.equal(logs[1].kind, 'action');
  assert.ok(logs[0].time, 'time 应由 store 自动补齐');
  assert.equal(logs[1].userName, '申孟涛');
});

test('clearBotLogs 清空', async () => {
  reset();
  await appendBotLog({ kind: 'action', detail: 'X', ok: true });
  assert.equal(getBotLogs().length, 1);
  clearBotLogs();
  assert.deepStrictEqual(getBotLogs(), []);
});

test('写失败不抛（目标文件名被目录占住）', async () => {
  reset();
  fs.mkdirSync(FILE); // 目录占位 → append 必然 EISDIR
  try {
    await appendBotLog({ kind: 'action', detail: 'X', ok: true });
    // 不抛即通过
  } finally {
    fs.rmSync(FILE, { recursive: true, force: true });
  }
});

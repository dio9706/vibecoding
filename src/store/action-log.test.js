import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// APP_DATA_DIR 必须先于 store 模块引入设定（DATA_DIR 全进程只求值一次，详见 jsonl.test.js）。
// 两个用例共用 action-log.jsonl，靠执行顺序 + 用例内自清理隔离（同文件内默认串行）。
const TMP = path.join(os.tmpdir(), `cad-actionlog-test-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.APP_DATA_DIR = TMP;

const { appendActionLog } = await import('./action-log.js');
const FILE = path.join(TMP, 'action-log.jsonl');

after(() => {
  delete process.env.APP_DATA_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('appendActionLog 落盘 + vars 脱敏', async () => {
  fs.rmSync(FILE, { recursive: true, force: true });

  await appendActionLog({
    time: new Date().toISOString(),
    userId: 'ou_abc',
    actionId: 'ac_1',
    actionName: '清理账号数据',
    vars: { phone: '15912349503', env: 'dev' },
    ok: true,
    code: 0,
  });

  const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, '应写入一行');
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.actionName, '清理账号数据');
  assert.equal(rec.ok, true);
  assert.equal(rec.vars.env, 'dev');
  assert.notEqual(rec.vars.phone, '15912349503', '手机号必须脱敏后落盘');
  assert.match(rec.vars.phone, /\*/, '脱敏后应含掩码字符');
});

test('写失败不抛（目标文件名被目录占住）', async () => {
  fs.rmSync(FILE, { recursive: true, force: true });
  fs.mkdirSync(FILE); // 目录占住目标文件名 → append 必然 EISDIR
  try {
    await appendActionLog({ userId: 'ou_x', actionName: 'X', ok: true, code: 0 });
    // 不抛即通过：日志写失败绝不能影响主流程
  } finally {
    fs.rmSync(FILE, { recursive: true, force: true });
  }
});

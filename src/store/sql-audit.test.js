/**
 * sql-audit 单测。
 * 隔离：必须在动态 import 之前设 APP_DATA_DIR（store/index.js 在模块初始化时定死数据目录）。
 */
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-audit-test-'));
process.env.APP_DATA_DIR = TMP_DIR;
const { appendSqlAudit, readSqlAudit, summarizeDenials } = await import('./sql-audit.js');

after(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

const FILE = path.join(TMP_DIR, 'sql-audit.jsonl');
beforeEach(() => fs.rmSync(FILE, { force: true }));

describe('appendSqlAudit', () => {
  it('成功执行的记录字段完整', async () => {
    await appendSqlAudit({
      userId: 'ou_1', userName: '张三', question: '上周订单数',
      sql: 'SELECT COUNT(*) FROM orders', purpose: '统计订单总量',
      ok: true, rows: 1, ms: 120,
    });
    const [e] = readSqlAudit();
    assert.equal(e.userId, 'ou_1');
    assert.equal(e.sql, 'SELECT COUNT(*) FROM orders');
    assert.equal(e.ok, true);
    assert.equal(e.rows, 1);
    assert.ok(e.time, '必须有时间戳');
  });

  it('被拒绝的 SQL 也要落盘 —— 这是发现「有人试探边界」的唯一信号', async () => {
    await appendSqlAudit({
      userId: 'ou_2', sql: 'SELECT phone FROM users', ok: false, denyCode: 'pii_denied',
    });
    const [e] = readSqlAudit();
    assert.equal(e.ok, false);
    assert.equal(e.denyCode, 'pii_denied');
    assert.equal(e.sql, 'SELECT phone FROM users', 'SQL 原文要留着，脱敏后无法复现');
  });

  it('只记行数，不记结果内容（结果集才是泄露面）', async () => {
    await appendSqlAudit({ userId: 'ou_3', sql: 'SELECT 1', ok: true, rows: 42 });
    const [e] = readSqlAudit();
    assert.equal(e.rows, 42);
    assert.equal('data' in e, false);
    assert.equal('result' in e, false);
  });

  it('超长 SQL 截断但标明原长度', async () => {
    const long = 'SELECT ' + 'x'.repeat(9000);
    await appendSqlAudit({ userId: 'ou_4', sql: long, ok: true });
    const [e] = readSqlAudit();
    assert.ok(e.sql.length < long.length);
    assert.match(e.sql, /共 \d+ 字/);
  });

  it('写失败不抛（它在用户消息处理路径上）', async () => {
    // 传一个会让 JSON.stringify 抛的循环引用
    const circular = {};
    circular.self = circular;
    await assert.doesNotReject(() =>
      appendSqlAudit({ userId: 'ou_5', sql: 'SELECT 1', ok: true, question: circular }),
    );
  });

  it('缺字段不炸，落成 null', async () => {
    await appendSqlAudit({ sql: 'SELECT 1', ok: true });
    const [e] = readSqlAudit();
    assert.equal(e.userId, null);
    assert.equal(e.denyCode, null);
  });
});

describe('readSqlAudit', () => {
  it('最新在前', async () => {
    await appendSqlAudit({ userId: 'a', sql: 'SELECT 1', ok: true });
    await appendSqlAudit({ userId: 'b', sql: 'SELECT 2', ok: true });
    const list = readSqlAudit();
    assert.equal(list[0].userId, 'b');
  });

  it('文件不存在返回空数组', () => {
    assert.deepEqual(readSqlAudit(), []);
  });
});

describe('summarizeDenials', () => {
  it('按 denyCode 分组计数，忽略成功记录', () => {
    const got = summarizeDenials([
      { ok: false, denyCode: 'pii_denied' },
      { ok: false, denyCode: 'pii_denied' },
      { ok: false, denyCode: 'not_select' },
      { ok: true, denyCode: null },
      null,
    ]);
    assert.deepEqual(got, { pii_denied: 2, not_select: 1 });
  });
});

import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

test('event-log: getEvents 过滤过期(含3天边界) + clearEvents 清空', async (t) => {
  const tmp = path.join(os.tmpdir(), `cad-eventlog-test-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  t.after(() => {
    delete process.env.APP_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  process.env.APP_DATA_DIR = tmp;

  // 查询串打散 ESM 缓存，确保模块顶层用最新 APP_DATA_DIR 求值
  const mod = await import(`./event-log.js?case=${process.pid}`);

  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const DAY = 24 * 60 * 60 * 1000;

  // jsonl 只放新条目（模块加载 compact 不会误删它）
  fs.writeFileSync(
    path.join(tmp, 'event-log.jsonl'),
    JSON.stringify({ path: '/api/fresh', time: iso(now) }) + '\n',
  );
  // 过期/边界条目放遗留 event-log.json（compact 从不改写 → 隔离验证 getEvents 的过滤）
  fs.writeFileSync(
    path.join(tmp, 'event-log.json'),
    JSON.stringify([
      { path: '/api/old', time: iso(now - 4 * DAY) }, // 越界 → 丢
      { path: '/api/edge-keep', time: iso(now - 3 * DAY + 1000) }, // 3天内 → 留
      { path: '/api/edge-drop', time: iso(now - 3 * DAY - 1000) }, // 略超 → 丢
    ]),
  );

  const paths = mod.getEvents().map((e) => e.path);
  assert.deepStrictEqual(
    paths,
    ['/api/fresh', '/api/edge-keep'],
    '仅保留 3 天窗口内条目（含 3 天整边界），过期与略超均被 getEvents 过滤',
  );

  mod.clearEvents();
  assert.deepStrictEqual(mod.getEvents(), [], 'clearEvents 后应为空');
});

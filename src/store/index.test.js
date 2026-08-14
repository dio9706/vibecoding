import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

test('dataPath 在设置 APP_DATA_DIR 时以其为根，并自动创建目录', async (t) => {
  const tmp = path.join(os.tmpdir(), `cad-store-test-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  t.after(() => {
    delete process.env.APP_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  process.env.APP_DATA_DIR = tmp;

  // 查询串做 ESM 缓存打散，确保模块顶层用最新 env 求值
  const mod = await import(`./index.js?case=env-${process.pid}`);

  assert.strictEqual(mod.dataPath('settings.json'), path.join(tmp, 'settings.json'));
  assert.ok(fs.existsSync(tmp), 'DATA_DIR 应被创建');
});

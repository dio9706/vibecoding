/** listScriptFiles 单测：只列 .py/.js，目录不存在返回 [] */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-'));
const { listScriptFiles } = await import('./routes-ops.js');

test('listScriptFiles 只返回 .py/.js', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-'));
  fs.writeFileSync(path.join(dir, 'a.py'), '');
  fs.writeFileSync(path.join(dir, 'b.js'), '');
  fs.writeFileSync(path.join(dir, 'c.txt'), '');
  assert.deepEqual(listScriptFiles(dir).sort(), ['a.py', 'b.js']);
});

test('listScriptFiles 目录不存在 → []', () => {
  assert.deepEqual(listScriptFiles(path.join(os.tmpdir(), 'no-such-dir-xyz')), []);
});

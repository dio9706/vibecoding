/**
 * Repo map 开关的真落盘读写回归（隔离 APP_DATA_DIR，避免污染本机设置）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-repomap-'));

const { setRepoMapEnabled, getRepoMapSettings } = await import('./settings.js');

test('setRepoMapEnabled：默认开；写入 false/true 均往返一致', () => {
  assert.equal(getRepoMapSettings().enabled, true, '默认开启');
  setRepoMapEnabled(false);
  assert.equal(getRepoMapSettings().enabled, false);
  setRepoMapEnabled(true);
  assert.equal(getRepoMapSettings().enabled, true);
});

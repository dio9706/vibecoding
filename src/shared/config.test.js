/** config.scriptsDirFor 解析规则单测 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// 隔离：import config.js 会连带初始化 store 数据目录，先把 APP_DATA_DIR 指向临时目录
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-test-'));
const { scriptsDirFor, config, parseOpenIdList } = await import('./config.js');

test('scriptsDirFor: SCRIPTS_DIR 覆盖优先，原样返回', () => {
  assert.equal(scriptsDirFor({ SCRIPTS_DIR: 'D:\\custom\\scripts' }), 'D:\\custom\\scripts');
});

test('scriptsDirFor: APP_DATA_DIR → <APP_DATA_DIR>/scripts', () => {
  assert.equal(scriptsDirFor({ APP_DATA_DIR: 'D:\\data' }), path.join('D:\\data', 'scripts'));
});

test('scriptsDirFor: 无 env → 仓库根/scripts（绝对、以 scripts 结尾）', () => {
  const d = scriptsDirFor({});
  assert.ok(path.isAbsolute(d));
  assert.equal(path.basename(d), 'scripts');
});

test('scriptsDirFor: 相对 SCRIPTS_DIR 被绝对化', () => {
  const d = scriptsDirFor({ SCRIPTS_DIR: 'scripts' });
  assert.ok(path.isAbsolute(d));
});

test('scriptsDirFor: SCRIPTS_DIR 优先于 APP_DATA_DIR', () => {
  const d = scriptsDirFor({ SCRIPTS_DIR: 'D:\\x\\s', APP_DATA_DIR: 'D:\\data' });
  assert.equal(d, path.resolve('D:\\x\\s'));
});

test('config.autoDev 提供默认编译脚本名', () => {
  assert.equal(config.autoDev.compileScript, 'get_qrcode.py');
});

// ---- parseOpenIdList 单测（OWNER_OPEN_IDS 解析） ----

test('parseOpenIdList：逗号分隔 + trim + 去空', () => {
  assert.deepEqual(parseOpenIdList('ou_a, ou_b ,,ou_c'), ['ou_a', 'ou_b', 'ou_c']);
});

test('parseOpenIdList：空串 / undefined → 空数组', () => {
  assert.deepEqual(parseOpenIdList(''), []);
  assert.deepEqual(parseOpenIdList(undefined), []);
});

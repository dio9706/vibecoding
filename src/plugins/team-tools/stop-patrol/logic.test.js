import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STOP_TRIGGERS } from './logic.js';
import { matchesExactTrigger } from '../trusted-trigger.js';

test('STOP_TRIGGERS 是触发文案的回归锚点（改动必须是有意的）', () => {
  assert.deepEqual(STOP_TRIGGERS, ['\\10004 停止巡检']);
});

test('全等才命中：前后缀 / 变体一律不触发', () => {
  assert.equal(matchesExactTrigger('\\10004 停止巡检', STOP_TRIGGERS), true);
  assert.equal(matchesExactTrigger('  \\10004 停止巡检  ', STOP_TRIGGERS), true); // 仅去首尾空白
  assert.equal(matchesExactTrigger('\\10004 停止巡检吧', STOP_TRIGGERS), false);
  assert.equal(matchesExactTrigger('停止巡检', STOP_TRIGGERS), false);
  assert.equal(matchesExactTrigger('\\10004停止巡检', STOP_TRIGGERS), false); // 少了空格
  assert.equal(matchesExactTrigger('', STOP_TRIGGERS), false);
  assert.equal(matchesExactTrigger(null, STOP_TRIGGERS), false);
});

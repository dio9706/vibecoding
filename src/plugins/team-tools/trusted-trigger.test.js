import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesExactTrigger, isTrustedSubmitter } from './trusted-trigger.js';

const TRIGGERS = ['\\10001 开始进行BUG巡检与修复', '\\10001 开始进行BUG巡检与修复(多维表格)'];

test('matchesExactTrigger：全等命中（含首尾空白容忍）', () => {
  assert.equal(matchesExactTrigger('\\10001 开始进行BUG巡检与修复', TRIGGERS), true);
  assert.equal(matchesExactTrigger('  \\10001 开始进行BUG巡检与修复  ', TRIGGERS), true);
  assert.equal(matchesExactTrigger('\\10001 开始进行BUG巡检与修复(多维表格)', TRIGGERS), true);
});

test('matchesExactTrigger：非全等一律不命中（前缀/后缀/变体/空值）', () => {
  assert.equal(matchesExactTrigger('\\10001', TRIGGERS), false); // 裸编号不算（用户拍板：全等完整文案）
  assert.equal(matchesExactTrigger('\\10001 开始进行BUG巡检与修复吧', TRIGGERS), false);
  assert.equal(matchesExactTrigger('请 \\10001 开始进行BUG巡检与修复', TRIGGERS), false);
  assert.equal(matchesExactTrigger('\\10001开始进行BUG巡检与修复', TRIGGERS), false);
  assert.equal(matchesExactTrigger('', TRIGGERS), false);
  assert.equal(matchesExactTrigger(null, TRIGGERS), false);
  assert.equal(matchesExactTrigger(123, TRIGGERS), false);
});

test('isTrustedSubmitter：名单命中或 owner 角色', () => {
  assert.equal(isTrustedSubmitter({ user: { id: 'ou_a', role: 'guest' } }, ['ou_a']), true);
  assert.equal(isTrustedSubmitter({ user: { id: 'ou_b', role: 'guest' } }, ['ou_a']), false);
  assert.equal(isTrustedSubmitter({ user: { id: 'ou_b', role: 'owner' } }, []), true);
  assert.equal(isTrustedSubmitter({ user: { id: '', role: 'guest' } }, ['']), false); // 空 id 永不命中
  assert.equal(isTrustedSubmitter({}, ['ou_a']), false);
  assert.equal(isTrustedSubmitter({ user: { id: 'ou_a' } }, null), false);
});

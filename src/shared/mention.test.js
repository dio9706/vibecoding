/**
 * 群聊 @ 前缀纯函数单测 —— 只有群聊才 @，p2p 加 <at> 会渲染成怪东西。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atPrefix } from './mention.js';

test('群聊 → 输出飞书 at 标签前缀（含尾随空格）', () => {
  assert.equal(atPrefix('ou_abc', 'group'), '<at user_id="ou_abc"></at> ');
});

test('p2p → 空串（单聊不需要 @）', () => {
  assert.equal(atPrefix('ou_abc', 'p2p'), '');
});

test('chatType 缺失（老任务无该字段）→ 空串，安全降级', () => {
  assert.equal(atPrefix('ou_abc', null), '');
  assert.equal(atPrefix('ou_abc', undefined), '');
});

test('openId 缺失 → 空串（绝不输出半截标签）', () => {
  assert.equal(atPrefix('', 'group'), '');
  assert.equal(atPrefix(null, 'group'), '');
});

test('openId 含引号等异常字符 → 空串（防标签注入）', () => {
  assert.equal(atPrefix('ou_a"b', 'group'), '');
  assert.equal(atPrefix('ou_a<b>', 'group'), '');
});

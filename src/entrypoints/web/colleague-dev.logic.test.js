import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, BRIEF_MAX_CHARS, newSubConvId } from './colleague-dev.logic.js';

test('buildBrief：成功带结果并截断，失败固定文案，空结果不带冒号', () => {
  assert.equal(buildBrief(false, '随便什么'), '接入遇到问题，已转主机处理');
  assert.equal(buildBrief(true, ''), '已处理完成');
  assert.equal(buildBrief(true, '  改了\n\n三个  文件 '), '已处理完成：改了 三个 文件');
  const b = buildBrief(true, 'x'.repeat(BRIEF_MAX_CHARS + 50));
  assert.equal(b, '已处理完成：' + 'x'.repeat(BRIEF_MAX_CHARS) + '…');
  assert.equal(buildBrief(true, 'y'.repeat(BRIEF_MAX_CHARS)), '已处理完成：' + 'y'.repeat(BRIEF_MAX_CHARS), '恰好到上限不加省略号');
  // 必须用星际平面字符（😀 .length===2）：BMP 内的 ✅ 用旧的 slice 也能过，测不出代理对是否被切开
  const emoji = buildBrief(true, '😀'.repeat(BRIEF_MAX_CHARS + 1));
  assert.ok(emoji.endsWith('…'));
  assert.equal(Array.from(emoji).length, Array.from('已处理完成：').length + BRIEF_MAX_CHARS + 1, '按字符截断，不切开 emoji 代理对');
  assert.ok(emoji.isWellFormed(), '不能含孤立的半个代理对（Node ≥20 的 isWellFormed 直接判）');
});

test('newSubConvId：c + 13 位时间戳 + 3 位随机，与前端纯数字 id 不撞', () => {
  assert.match(newSubConvId(1700000000000), /^c1700000000000[a-z0-9]{3}$/);
  assert.notEqual(newSubConvId(1700000000000).slice(0, 14), newSubConvId(1700000000001).slice(0, 14), '不同时间戳前缀不同');
  assert.match(newSubConvId(), /^c\d{13}[a-z0-9]{3}$/);
});

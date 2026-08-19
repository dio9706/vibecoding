import { test } from 'node:test';
import assert from 'node:assert/strict';
import feature from './feature.js';

// 只测 match 与静态契约：handle 要 mock LLM + 子进程 + 飞书三方，收益远低于成本。

test('feature 契约：全员可用、不参与意图路由', () => {
  assert.equal(feature.name, 'tracking-stats');
  assert.equal(feature.permission, 'any');
  assert.deepEqual(feature.intents, []);
  assert.equal(typeof feature.match, 'function');
  assert.equal(typeof feature.handle, 'function');
});

test('match：前缀在开头即命中，冒号与空格可有可无', () => {
  assert.equal(feature.match({ text: '帮我统计埋点: 最近7天分享功能' }), true);
  assert.equal(feature.match({ text: '帮我统计埋点：最近7天分享功能' }), true);
  assert.equal(feature.match({ text: '帮我统计埋点 最近7天分享功能' }), true);
  assert.equal(feature.match({ text: '  帮我统计埋点: x' }), true);
});

test('match：只发前缀（正文为空）仍命中 —— 由 handle 去追问', () => {
  // 不命中的话这条消息会掉进 claude-exec，用户得到的是一段莫名其妙的执行结果
  assert.equal(feature.match({ text: '帮我统计埋点' }), true);
  assert.equal(feature.match({ text: '帮我统计埋点：' }), true);
});

test('match：前缀不在开头不命中', () => {
  // 历史事故：整篇文档被贴进来，全文命中关键词而误判意图
  assert.equal(feature.match({ text: '这个需求要帮我统计埋点: x' }), false);
  assert.equal(feature.match({ text: '顺便帮我统计埋点' }), false);
});

test('match：空文本 / 非字符串不命中', () => {
  assert.equal(feature.match({ text: '' }), false);
  assert.equal(feature.match({ text: '   ' }), false);
  assert.equal(feature.match({ text: undefined }), false);
  assert.equal(feature.match({ text: 123 }), false);
});

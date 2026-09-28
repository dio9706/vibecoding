/**
 * dispatch feature 单测。它只做一件事：名册内的同事消息交给 relay，否则 PASS 回落。
 * 群聊 @ 过滤不在这里 —— 那是 feishu 入口的事（feature 收到的已经是过滤后的）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import feature from './feature.js';
import { PASS } from '../../app/signals.js';

test('feature 契约：order 由插件装配给，这里只暴露 name/permission/intents/handle', () => {
  assert.equal(feature.name, 'colleague-agent');
  assert.equal(feature.permission, 'any');
  assert.deepEqual(feature.intents.sort(), ['bug', 'feature', 'material', 'other', 'question'].sort());
  assert.equal(typeof feature.handle, 'function');
  assert.equal(feature.hasPending, undefined, '选择卡已下线，不该再有待归属态');
});

test('名册内：交给 relay 接管，不回任何话（回复由 web 进程的 agent 发）', async () => {
  let got = null;
  let replied = false;
  const r = await feature.handle(
    { user: { id: 'ou_1' }, text: '接口给你了', reply: async () => (replied = true) },
    null,
    { relay: async (m) => ((got = m), true) },
  );
  assert.notEqual(r, PASS);
  assert.equal(got.openId, 'ou_1');
  assert.equal(got.text, '接口给你了');
  assert.equal(replied, false, 'ACK 由 web 侧按需发（正常路径不发，等 agent 真回复）');
});

test('不在名册：返回 PASS，把消息交回 feedback', async () => {
  const r = await feature.handle({ user: { id: 'ou_x' }, text: 'x' }, null, { relay: async () => false });
  assert.equal(r, PASS);
});

test('relay 抛错：吞掉并 PASS —— 绝不能让同事的消息因为一次异常彻底消失', async () => {
  const r = await feature.handle({ user: { id: 'ou_1' }, text: 'x' }, null, {
    relay: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(r, PASS);
});

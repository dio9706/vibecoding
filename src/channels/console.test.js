import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createConsoleChannel } from './console.js';

test('契约形状：id/capabilities/start/stop/send', () => {
  const c = createConsoleChannel();
  assert.equal(c.id, 'console');
  assert.equal(c.capabilities.text, true);
  assert.equal(c.capabilities.image, false);
  for (const k of ['start', 'stop', 'send']) assert.equal(typeof c[k], 'function');
});

test('收发闭环：stdin 行 → InboundMessage → send 打印（注入流，离线）', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (d) => (out += d.toString()));
  const c = createConsoleChannel({ userId: 'u1', input, output });

  const got = [];
  await c.start({
    onInbound: async (m) => {
      got.push(m);
      await c.send(m.chatKey, { text: 'echo:' + m.text });
    },
  });
  input.write('你好 世界\n');
  input.write('   \n'); // 空行忽略
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(got.length, 1);
  assert.deepEqual(
    { channelId: got[0].channelId, chatKey: got[0].chatKey, userId: got[0].userId, kind: got[0].kind, text: got[0].text, images: got[0].images },
    { channelId: 'console', chatKey: 'console', userId: 'u1', kind: 'text', text: '你好 世界', images: [] },
  );
  assert.ok(got[0].messageId, '应有 messageId');
  assert.ok(out.includes('🤖 echo:你好 世界'), '出站应打印: ' + out);
  c.stop();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, dispatchSafely } from './dispatch.js';
import { PASS } from './signals.js';

/**
 * 背景（静默失败三连）：
 *   dispatch.js 记录后 **重抛** → entrypoints/feishu/index.js 的 `try{...}finally{...}` 无 catch
 *   → channels/feishu.js 的 handler 只 `.catch(e => logger.error(...))`。
 * 而飞书 SDK 在 handler 立即 resolve 时就已回 200 ack，**不会重推**；
 * 去重表 seen 也已标记该 messageId，用户重发同一条同样不会被重跑。
 * 净效果：用户看到表情贴上又取下，然后**永远没有下文**。
 * 典型触发：飞书 429 限流或网络抖动让某次 ctx.reply 抛错。
 */

function ctxOf() {
  const replies = [];
  return {
    replies,
    ctx: {
      source: 'feishu',
      user: { id: 'ou_x', role: 'guest' },
      text: 'hi',
      reply: async (t) => {
        replies.push(t);
      },
    },
  };
}

test('dispatchSafely：正常路径不插入任何额外回复', async () => {
  const { ctx, replies } = ctxOf();
  const r = await dispatchSafely(ctx, { run: async () => {} });
  assert.equal(r.ok, true);
  assert.deepEqual(replies, []);
});

test('dispatchSafely：dispatch 抛错时必须回告用户（核心回归）', async () => {
  const { ctx, replies } = ctxOf();
  const r = await dispatchSafely(ctx, {
    run: async () => {
      throw new Error('飞书 429');
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.notified, true);
  assert.equal(replies.length, 1, '必须给用户一条失败回告，不能静默');
  assert.ok(replies[0].length > 0);
});

test('dispatchSafely：异常不再向上冒泡（入口层无 catch，冒泡即静默丢失）', async () => {
  const { ctx } = ctxOf();
  await dispatchSafely(ctx, {
    run: async () => {
      throw new Error('boom');
    },
  }); // 不抛即通过
});

test('dispatchSafely：回告本身也失败时仍不冒泡，并如实标记未通知', async () => {
  const ctx = {
    source: 'feishu',
    user: { id: 'ou_x', role: 'guest' },
    text: 'hi',
    reply: async () => {
      throw new Error('限流未恢复，回告也发不出去');
    },
  };
  const r = await dispatchSafely(ctx, {
    run: async () => {
      throw new Error('原始失败');
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.notified, false);
});

test('dispatchSafely：同步抛出的异常同样被兜住', async () => {
  const { ctx, replies } = ctxOf();
  const r = await dispatchSafely(ctx, {
    run: () => {
      throw new Error('同步炸');
    },
  });
  assert.equal(r.ok, false);
  assert.equal(replies.length, 1);
});

/**
 * 会话中间态（hasPending）的**放弃接管**通道。
 * 背景事故：第 0 步只要 hasPending 为真就无条件劫持该用户全部消息、直接 return，
 * 于是 action-runner 一次缺字段追问后，用户问别的问题也被吞进追问里。
 * 现在 feature 可返回 PASS 表示「我不接这条」，dispatch 必须继续往下走常规意图识别。
 */
test('dispatch：hasPending 的 feature 返回 PASS → 继续走常规意图匹配', async () => {
  const seen = [];
  const featureList = [
    {
      name: 'sticky',
      permission: 'any',
      intents: [],
      hasPending: () => true,
      handle: async () => {
        seen.push('sticky');
        return PASS;
      },
    },
    {
      name: 'qa',
      permission: 'any',
      intents: ['question'],
      handle: async () => {
        seen.push('qa');
      },
    },
  ];
  const { ctx } = ctxOf();
  await dispatch(ctx, { featureList, classifyFn: async () => ({ intent: 'question', body: '' }) });
  assert.deepEqual(seen, ['sticky', 'qa'], 'PASS 后必须继续分发，不能吞掉这条消息');
});

test('dispatch：hasPending 的 feature 正常接管时仍然短路（不回归）', async () => {
  const seen = [];
  const featureList = [
    { name: 'sticky', permission: 'any', intents: [], hasPending: () => true, handle: async () => void seen.push('sticky') },
    { name: 'qa', permission: 'any', intents: ['question'], handle: async () => void seen.push('qa') },
  ];
  const { ctx } = ctxOf();
  await dispatch(ctx, {
    featureList,
    classifyFn: async () => {
      throw new Error('接管时不该再做意图识别');
    },
  });
  assert.deepEqual(seen, ['sticky']);
});

test('dispatchSafely：ctx 没有 reply 时不额外抛异常', async () => {
  const r = await dispatchSafely(
    { source: 'console', user: { id: 'u' }, text: 'hi' },
    {
      run: async () => {
        throw new Error('boom');
      },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.notified, false);
});

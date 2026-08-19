import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, dispatchSafely } from './dispatch.js';
import { PASS } from './signals.js';
import { buildWelcomeText } from '../shared/messages.js';

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
      sendCard: async (card) => {
        replies.push(card);
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

test('dispatch：无匹配意图时应调用 buildWelcomeCard 返回卡片', async () => {
  const { ctx, replies } = ctxOf();

  // 创建一个空 featureList（无任何 feature 匹配）
  const featureList = [];

  // 调用 dispatch，classifyFn 返回无法匹配的意图，触发第 3 段帮助路径
  await dispatch(ctx, {
    featureList,
    classifyFn: async () => ({
      intent: 'other',
      body: '',
      strong: false,
      env: 'test',
    }),
  });

  // 验证：ctx.sendCard 被调用
  assert.equal(replies.length, 1, '应该有且仅有一条回复');
  const card = replies[0];

  // 验证卡片是一个对象且包含 elements 字段（飞书卡片结构）
  assert.ok(typeof card === 'object', '回复应该是卡片对象');
  assert.ok(Array.isArray(card.elements), '卡片应该包含 elements 数组');
  assert.ok(card.elements.length > 0, 'elements 数组不应为空');
});

test('dispatch：Welcome 卡片集成测试 - 验证卡片完整结构与按钮配置', async () => {
  const { buildWelcomeCard } = await import('../shared/messages.js');

  // Mock 动作配置数据
  const mockActions = [
    {
      id: 'ac_1',
      botId: 'bot_123',
      name: '清理数据',
      description: '清理测试数据',
      example: '输入环境',
      enabled: true,
    },
    {
      id: 'ac_2',
      botId: 'bot_123',
      name: '查询日志',
      description: '查询系统日志',
      enabled: true,
    },
    {
      id: 'ac_3',
      botId: 'bot_456',
      name: '其他 bot 动作',
      enabled: true, // 不属于当前 bot，不应显示
    },
  ];

  // 调用 buildWelcomeCard，传入 botId 和 mock 的 actions
  const card = buildWelcomeCard('bot_123', mockActions);

  // 验证卡片基础结构
  assert.ok(typeof card === 'object', '卡片应该是对象');
  assert.ok(Array.isArray(card.elements), '卡片应该包含 elements 数组');
  assert.equal(card.elements.length, 2, '卡片应该有两个元素（说明 + 按钮区）');

  // 验证第一个元素：说明文本
  const textElem = card.elements[0];
  assert.equal(textElem.tag, 'div', '第一个元素应该是 div');
  assert.ok(textElem.text, 'div 应该包含 text');
  assert.equal(textElem.text.tag, 'lark_md', 'text 应该是 lark_md 格式');
  assert.ok(textElem.text.content.includes('没有识别到你的意图'), '说明文本应该包含关键词');
  assert.ok(textElem.text.content.includes('提交需求'), '说明文本应该包含提交需求');
  assert.ok(textElem.text.content.includes('提交故障'), '说明文本应该包含提交故障');
  assert.ok(textElem.text.content.includes('问个问题'), '说明文本应该包含问个问题');

  // 验证第二个元素：动作按钮区
  const actionElem = card.elements[1];
  assert.equal(actionElem.tag, 'action', '第二个元素应该是 action');
  assert.ok(Array.isArray(actionElem.actions), 'action 应该包含 actions 数组');
  assert.equal(actionElem.actions.length, 2, '应该有 2 个按钮（属于 bot_123）');

  // 验证第一个按钮
  const btn1 = actionElem.actions[0];
  assert.equal(btn1.tag, 'button', '按钮应该是 button tag');
  assert.equal(btn1.type, 'primary', '按钮应该是 primary 类型');
  assert.equal(btn1.text.tag, 'plain_text', '按钮文本应该是 plain_text');
  assert.equal(btn1.text.content, '清理数据', '按钮文本应该是动作名');
  assert.equal(btn1.value.kind, 'quick-action', '按钮 value 的 kind 应该是 quick-action');
  assert.equal(btn1.value.actionId, 'ac_1', '按钮 value 应该包含 actionId');
  assert.equal(btn1.value.actionName, '清理数据', '按钮 value 应该包含 actionName');
  assert.equal(btn1.value.botId, 'bot_123', '按钮 value 应该包含 botId');
  assert.ok(typeof btn1.value._timestamp === 'number', '按钮 value 应该包含 _timestamp');

  // 验证第二个按钮
  const btn2 = actionElem.actions[1];
  assert.equal(btn2.tag, 'button', '第二个按钮应该是 button tag');
  assert.equal(btn2.text.content, '查询日志', '第二个按钮文本应该是动作名');
  assert.equal(btn2.value.actionId, 'ac_2', '第二个按钮应该有正确的 actionId');
  assert.equal(btn2.value.actionName, '查询日志', '第二个按钮应该有正确的 actionName');
  assert.equal(btn2.value.botId, 'bot_123', '第二个按钮应该有正确的 botId');
});

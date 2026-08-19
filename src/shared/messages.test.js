import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY, MAX_LEN, BOT_MESSAGE_KEYS, resolveMessage, sanitizeMessages, listBotMessages } from './messages.js';

test('resolveMessage：有覆盖值用覆盖值', () => {
  assert.equal(resolveMessage('welcome', { welcome: '自定义欢迎' }), '自定义欢迎');
});

test('resolveMessage：无覆盖 / 空白覆盖 / 无 overrides 均回默认', () => {
  assert.equal(resolveMessage('welcome', {}), REGISTRY.welcome.defaultText);
  assert.equal(resolveMessage('welcome', { welcome: '   ' }), REGISTRY.welcome.defaultText);
  assert.equal(resolveMessage('welcome', undefined), REGISTRY.welcome.defaultText);
});

test('resolveMessage：未知 key 抛错（注册表与调用点不一致属开发错误）', () => {
  assert.throws(() => resolveMessage('nope', {}), /未知文案 key/);
});

test('sanitizeMessages：只收机器人可配 key，trim、剔除空值', () => {
  const r = sanitizeMessages({ ackBug: '  收到  ', execProcessing: '   ', welcome: '不可配', hacker: 'x' });
  assert.deepEqual(r, { ok: true, values: { ackBug: '收到' } });
});

test('sanitizeMessages：非对象入参报错', () => {
  assert.equal(sanitizeMessages(null).ok, false);
  assert.equal(sanitizeMessages([]).ok, false);
  assert.equal(sanitizeMessages('x').ok, false);
});

test('sanitizeMessages：单条超长报错并指明条目', () => {
  const r = sanitizeMessages({ ackFeature: 'x'.repeat(MAX_LEN + 1) });
  assert.equal(r.ok, false);
  assert.match(r.error, /需求即时应答/);
});

test('listBotMessages：四条可配文案，key/label/defaultText/value 齐全，覆盖值回填', () => {
  const items = listBotMessages({ execProcessing: '在做了' });
  assert.equal(items.length, BOT_MESSAGE_KEYS.length);
  for (const it of items) {
    assert.ok(BOT_MESSAGE_KEYS.includes(it.key));
    assert.equal(typeof it.label, 'string');
    assert.equal(typeof it.defaultText, 'string');
  }
  assert.equal(items.find((i) => i.key === 'execProcessing').value, '在做了');
  assert.equal(items.find((i) => i.key === 'ackQuestion').value, '');
});

test('listBotMessages：无入参不炸，value 全空', () => {
  for (const it of listBotMessages()) assert.equal(it.value, '');
});

test('materialAck 在注册表且不可配（不在 BOT_MESSAGE_KEYS）', () => {
  assert.equal(typeof REGISTRY.materialAck.defaultText, 'string');
  assert.ok(!BOT_MESSAGE_KEYS.includes('materialAck'));
  assert.equal(resolveMessage('materialAck', {}), REGISTRY.materialAck.defaultText);
});

test('三条即时应答已注册且默认文案与产品口径一致', () => {
  assert.equal(REGISTRY.ackBug.defaultText, '请稍等，我先思考此故障是否由我的项目引发！');
  assert.equal(REGISTRY.ackFeature.defaultText, '请稍等，我先思考此需求的复杂度与收益是否值得做！');
  assert.equal(REGISTRY.ackQuestion.defaultText, '请稍等，我先去翻阅代码再回来回答你的问题！');
});

test('四条即时应答可 per-bot 配置（出现在 BOT_MESSAGE_KEYS）', () => {
  for (const k of ['ackBug', 'ackFeature', 'ackQuestion', 'ackAction']) {
    assert.ok(BOT_MESSAGE_KEYS.includes(k), `${k} 应可配置`);
  }
});

test('ackAction 存在（动作路径槽位抽取要等 6~12s，不能全程静默）', () => {
  assert.ok(REGISTRY.ackAction?.defaultText?.trim());
});

test('feedbackAck 已下线（被即时应答取代）', () => {
  assert.equal(REGISTRY.feedbackAck, undefined);
  assert.equal(BOT_MESSAGE_KEYS.includes('feedbackAck'), false);
});

test('welcome 变为未识别意图引导文案，含三种示例说法', () => {
  const w = REGISTRY.welcome.defaultText;
  assert.match(w, /没有识别到你的意图/);
  assert.match(w, /提交需求/);
  assert.match(w, /提交故障/);
  assert.match(w, /问个问题/);
});

test('sanitizeMessages：丢弃已下线的 feedbackAck，保留新 key', () => {
  const r = sanitizeMessages({ ackBug: ' 稍等 ', feedbackAck: '旧文案' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.values, { ackBug: '稍等' });
});

test.describe('buildWelcomeText', () => {
  test('有已启用动作时应列出动作列表', async (t) => {
    // 模拟的已启用动作列表
    const mockActions = [
      {
        id: 'ac_001',
        botId: 'bot_123',
        name: '小程序二维码',
        description: '生成并发送小程序二维码给指定用户',
        enabled: true,
      },
      {
        id: 'ac_002',
        botId: 'bot_123',
        name: '清理环境',
        description: '清除测试环境中的所有测试数据',
        enabled: true,
      },
      {
        id: 'ac_003',
        botId: 'bot_123',
        name: '退款流程',
        description: '执行退款流程并通知相关人员',
        enabled: true,
      },
    ];

    const { buildWelcomeText } = await import('./messages.js');
    const text = buildWelcomeText('bot_123', mockActions);

    // 断言：应包含核心操作提示
    assert.match(text, /没有识别到你的意图/, '包含未识别提示');
    assert.match(text, /提交需求/, '包含提交需求');
    assert.match(text, /提交故障/, '包含提交故障');
    assert.match(text, /问个问题/, '包含问个问题');

    // 断言：应包含动作列表
    assert.match(text, /或其他已配置的功能，比如/, '包含「比如」标题');
    assert.match(text, /生成并发送小程序二维码给指定用户/, '包含第一个动作描述');
    assert.match(text, /清除测试环境中的所有测试数据/, '包含第二个动作描述');
    assert.match(text, /执行退款流程并通知相关人员/, '包含第三个动作描述');

    // 断言：应包含结尾提示语
    assert.match(text, /识别到我会及时回复你～/, '包含结尾提示');
  });
});

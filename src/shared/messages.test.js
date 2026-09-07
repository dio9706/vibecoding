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

/**
 * 埋点统计是**插件型 feature**（tracking-stats，靠 `帮我统计埋点` 前缀 match 触发），
 * 不走 action-configs，因此 welcome 的动作段永远列不到它 —— 用户不知道这个前缀，
 * 功能等于不存在（生产近 4 天「没有识别到意图」兜底触发 109 次）。
 * 这里把它钉进静态核心段；例句必须与 tracking-stats/logic.js 的 TRACKING_PREFIX 一致，
 * 且前缀必须在**句首**，否则等于教用户说一句触发不了的话。
 */
test.describe('welcome 必须提到埋点统计', () => {
  test('buildWelcomeText 含「帮我统计埋点」及可直接照抄的例句', async () => {
    const { buildWelcomeText } = await import('./messages.js');
    const text = buildWelcomeText('bot_x', []);
    assert.match(text, /帮我统计埋点/, '缺少埋点统计能力说明');
    assert.match(text, /例: 帮我统计埋点/, '例句必须以触发前缀开头');
  });

  test('buildWelcomeCard 同样含「帮我统计埋点」', async () => {
    const { buildWelcomeCard } = await import('./messages.js');
    const card = buildWelcomeCard('bot_x', []);
    const header = card.elements[0].text.content;
    assert.match(header, /帮我统计埋点/, '卡片缺少埋点统计能力说明');
    assert.match(header, /例: 帮我统计埋点/, '例句必须以触发前缀开头');
  });

  test('REGISTRY.welcome 默认文案与两个构造函数保持同步', async () => {
    const { REGISTRY } = await import('./messages.js');
    assert.match(REGISTRY.welcome.defaultText, /帮我统计埋点/, '注册表默认文案漏了埋点统计');
  });
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

  test('无已启用动作时应显示「暂未配置」提示', async (t) => {
    // 模拟无已启用动作的场景（传入空数组）
    const { buildWelcomeText } = await import('./messages.js');
    const text = buildWelcomeText('bot_456', []);

    // 断言：应包含核心操作提示
    assert.match(text, /没有识别到你的意图/, '包含未识别提示');
    assert.match(text, /提交需求/, '包含提交需求');

    // 断言：应包含「暂未配置」提示，而非「比如」列表
    assert.match(text, /或其他已配置的功能（暂未配置）/, '包含暂未配置提示');
    assert.doesNotMatch(text, /或其他已配置的功能，比如/, '不包含「比如」列表标题');

    // 断言：应包含结尾提示语
    assert.match(text, /识别到我会及时回复你～/, '包含结尾提示');
  });

  test('超过 5 条动作时应显示前 5 条并提示还有其他项', async (t) => {
    // 模拟 8 条已启用的动作
    const actions = Array.from({ length: 8 }, (_, i) => ({
      id: `ac_${i + 1}`,
      botId: 'bot_789',
      name: `动作 ${i + 1}`,
      description: `这是第 ${i + 1} 个动作`,
      enabled: true,
    }));

    const { buildWelcomeText } = await import('./messages.js');
    const text = buildWelcomeText('bot_789', actions);

    // 断言：前 5 条动作应在文本中
    assert.match(text, /这是第 1 个动作/, '包含第 1 个动作');
    assert.match(text, /这是第 2 个动作/, '包含第 2 个动作');
    assert.match(text, /这是第 3 个动作/, '包含第 3 个动作');
    assert.match(text, /这是第 4 个动作/, '包含第 4 个动作');
    assert.match(text, /这是第 5 个动作/, '包含第 5 个动作');

    // 断言：第 6、7、8 条应在「…等」提示中，不单独列出
    assert.match(text, /…等 3 项/, '包含「…等 3 项」提示');
    assert.doesNotMatch(text, /这是第 6 个动作/, '第 6 个动作不单独列出');
    assert.doesNotMatch(text, /这是第 7 个动作/, '第 7 个动作不单独列出');
    assert.doesNotMatch(text, /这是第 8 个动作/, '第 8 个动作不单独列出');
  });

  test('botId 为 null 时应降级到「暂未配置」', async (t) => {
    // 模拟的动作列表包含其他 bot 的动作
    const mockActions = [
      {
        id: 'ac_x',
        botId: 'bot_other',
        name: '其他机器人的动作',
        description: '这是另一个机器人的动作',
        enabled: true,
      },
    ];

    const { buildWelcomeText } = await import('./messages.js');
    const text = buildWelcomeText(null, mockActions);

    // 断言：应包含基础操作提示
    assert.match(text, /没有识别到你的意图/, '包含未识别提示');
    assert.match(text, /提交需求/, '包含提交需求');

    // 断言：因为 botId 不匹配，无法找到 null 的动作，应显示「暂未配置」
    assert.match(text, /或其他已配置的功能（暂未配置）/, '包含暂未配置提示');

    // 断言：不应包含其他 bot 的动作描述
    assert.doesNotMatch(text, /这是另一个机器人的动作/, '不包含其他 bot 的动作');
  });
});

test.describe('buildWelcomeCard', () => {
  test('有已启用动作时应生成卡片含操作说明和按钮', async (t) => {
    const { buildWelcomeCard } = await import('./messages.js');

    const mockActions = [
      {
        id: 'ac_001',
        botId: 'bot_123',
        name: '清理数据',
        description: '清理测试数据',
        example: '输入环境名称',
        enabled: true,
      },
      {
        id: 'ac_002',
        botId: 'bot_123',
        name: '生成二维码',
        description: '生成小程序二维码',
        example: '输入用户 ID',
        enabled: true,
      },
    ];

    const card = buildWelcomeCard('bot_123', mockActions);

    // 验证卡片结构
    assert.ok(card.elements, '卡片有 elements 字段');
    assert.equal(card.elements.length, 2, '有两个元素（说明 + 按钮区）');

    // 验证说明段
    assert.equal(card.elements[0].tag, 'div', '第一个元素是 div');
    assert.equal(card.elements[0].text.tag, 'lark_md', '说明段使用 lark_md');
    assert.match(card.elements[0].text.content, /没有识别到你的意图/, '包含操作说明');
    assert.match(card.elements[0].text.content, /提交需求/, '包含需求说明');

    // 验证按钮区
    const actionElem = card.elements[1];
    assert.equal(actionElem.tag, 'action', '第二个元素是 action');
    assert.equal(actionElem.actions.length, 2, '有两个按钮');

    // 验证第一个按钮
    const btn1 = actionElem.actions[0];
    assert.equal(btn1.tag, 'button', '是 button 元素');
    assert.equal(btn1.text.content, '清理数据', '第一个按钮文案');
    assert.equal(btn1.value.kind, 'quick-action', '按钮 value 有 kind');
    assert.equal(btn1.value.actionId, 'ac_001', '按钮 value 有 actionId');
    assert.equal(btn1.value.botId, 'bot_123', '按钮 value 有 botId');

    // 验证第二个按钮
    const btn2 = actionElem.actions[1];
    assert.equal(btn2.text.content, '生成二维码', '第二个按钮文案');
    assert.equal(btn2.value.actionId, 'ac_002', '第二个按钮的 actionId');
  });

  test('无已启用动作时卡片仅含操作说明', async (t) => {
    const { buildWelcomeCard } = await import('./messages.js');

    const card = buildWelcomeCard('bot_456', []);

    // 无动作时卡片应仅含操作说明（elements 只有一个）
    assert.ok(card.elements, '卡片有 elements');
    assert.equal(card.elements.length, 1, '无动作时只有 1 个元素');
    assert.match(card.elements[0].text.content, /没有识别到你的意图/, '仍有操作说明');
  });

  test('超过 5 条动作时仅显示前 5 条并提示还有更多', async (t) => {
    const { buildWelcomeCard } = await import('./messages.js');

    const actions = Array.from({ length: 8 }, (_, i) => ({
      id: `ac_${i + 1}`,
      botId: 'bot_789',
      name: `动作 ${i + 1}`,
      description: `说明 ${i + 1}`,
      example: `示例 ${i + 1}`,
      enabled: true,
    }));

    const card = buildWelcomeCard('bot_789', actions);

    const actionElem = card.elements[1];
    assert.ok(actionElem, '有 action 元素');

    // 应该显示 5 个按钮 + 1 个文本提示
    const buttons = actionElem.actions.filter(a => a.tag === 'button');
    const texts = actionElem.actions.filter(a => a.tag === 'text');

    assert.equal(buttons.length, 5, '显示 5 个按钮');
    assert.equal(texts.length, 1, '有 1 个文本提示');
    assert.match(texts[0].content, /还有 3 项/, '提示「还有 3 项」');

    // 验证前 5 个按钮的名称
    for (let i = 0; i < 5; i++) {
      assert.equal(buttons[i].text.content, `动作 ${i + 1}`, `第 ${i + 1} 个按钮文案`);
    }
  });

  test('botId 为 null 时应无任何按钮', async (t) => {
    const { buildWelcomeCard } = await import('./messages.js');

    const mockActions = [
      {
        id: 'ac_x',
        botId: 'bot_other',
        name: '其他机器人的动作',
        description: '这是另一个机器人的动作',
        enabled: true,
      },
    ];

    const card = buildWelcomeCard(null, mockActions);

    // 因为 botId 不匹配，无法找到 null 的动作，应只有说明段
    assert.equal(card.elements.length, 1, '无动作时只有说明段');
    assert.match(card.elements[0].text.content, /没有识别到你的意图/, '仍有操作说明');
  });
});

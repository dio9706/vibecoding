import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexDict } from './logic.js';
import {
  beijingNow,
  renderCategoryCatalog,
  buildUnderstandPrompt,
  buildPickPrompt,
} from './understand.js';

// 只钉住纯函数：understandRequest / pickTargets 真去调 LLM，要 mock 才测得动，收益远低于成本。

test('beijingNow：UTC 时刻按 +8 换算', () => {
  const r = beijingNow(new Date('2026-08-19T04:00:00Z'));
  assert.equal(r.date, '2026-08-19');
  assert.equal(r.time, '12:00');
});

test('beijingNow：跨日边界 —— UTC 当天傍晚已是北京次日凌晨', () => {
  // 回归锚点：整个阶段 A 靠这个日期做时间锚。差一天，「最近一个月」的区间就整体偏移，
  // 而报告照样能生成、数字照样查得出来 —— 错得完全看不出来。
  const r = beijingNow(new Date('2026-08-19T16:30:00Z'));
  assert.equal(r.date, '2026-08-20');
  assert.equal(r.time, '00:30');
});

test('beijingNow：UTC 跨月/跨年边界', () => {
  assert.equal(beijingNow(new Date('2026-08-31T16:00:00Z')).date, '2026-09-01');
  assert.equal(beijingNow(new Date('2026-12-31T16:00:00Z')).date, '2027-01-01');
});

test('beijingNow：时分补零', () => {
  const r = beijingNow(new Date('2026-08-19T00:05:00Z'));
  assert.equal(r.time, '08:05');
});

/** 构造一个含 named / unnamed / 已下线事件的迷你字典 */
function miniDict() {
  return indexDict({
    events: [
      { name: 'baby_food_intro_next', label: '介绍页下一步', count: 900, live: true, named: true },
      { name: 'baby_food_confirm_birthday', label: '确认生日', count: 800, live: true, named: true },
      { name: 'baby_food_select_milk', label: '选择奶源', count: 700, live: true, named: true },
      { name: 'baby_food_paywall_pay_success', label: 'baby_food_paywall_pay_success', count: 999, live: true, named: false },
      { name: 'pet_feed_add', label: 'pet_feed_add', count: 50, live: true, named: false },
      { name: 'pet_feed_del', label: 'pet_feed_del', count: 40, live: true, named: false },
      { name: 'legacy_mod_a', label: '旧模块A', count: 0, live: false, named: true },
      { name: 'legacy_mod_b', label: '旧模块B', count: 0, live: false, named: true },
      { name: '$MPViewScreen', label: '页面浏览', count: 99999, live: true, named: true },
    ],
    pages: [],
    categories: [
      { prefix: 'baby_food', label: '介绍页下一步', count: 4 },
      { prefix: 'pet_feed', label: 'pet_feed', count: 2 },
      { prefix: 'legacy_mod', label: '旧模块A', count: 2 },
    ],
  });
}

test('renderCategoryCatalog：每行是「前缀：样例 / 样例 / 样例」', () => {
  const lines = renderCategoryCatalog(miniDict()).split('\n');
  assert.equal(lines[0], 'baby_food：介绍页下一步 / 确认生日 / 选择奶源');
});

test('renderCategoryCatalog：有中文名的排前面，机器名只做补位', () => {
  // 回归锚点：baby_food 里频次最高的其实是没中文名的 paywall 事件。
  // 若按纯频次取样例，第一条就是一串机器名 —— 而模型要靠中文名才对得上用户口语。
  const line = renderCategoryCatalog(miniDict()).split('\n')[0];
  assert.ok(!line.includes('baby_food_paywall_pay_success'), '被三条中文名挤出前三，不应出现');

  // 全组无中文名时，机器名照样要给出来（总比只有一个光秃秃的前缀强）
  const petLine = renderCategoryCatalog(miniDict()).split('\n').find((l) => l.startsWith('pet_feed'));
  assert.equal(petLine, 'pet_feed：pet_feed_add / pet_feed_del');
});

test('renderCategoryCatalog：样例最多 3 条', () => {
  const events = [];
  for (let i = 0; i < 10; i++) {
    events.push({ name: `mod_x_e${i}`, label: `动作${i}`, count: 100 - i, live: true, named: true });
  }
  const out = renderCategoryCatalog(indexDict({ events, categories: [{ prefix: 'mod_x', label: '动作0', count: 10 }] }));
  assert.equal(out, 'mod_x：动作0 / 动作1 / 动作2');
});

test('renderCategoryCatalog：组内没有活跃事件的分类被整组跳过', () => {
  // 已经不在跑的模块喂给模型，只会把它往历史埋点上引
  const out = renderCategoryCatalog(miniDict());
  assert.ok(!out.includes('legacy_mod'), 'live=false 的分类不应出现');
});

test('renderCategoryCatalog：神策系统事件（$ 开头）不参与样例', () => {
  const out = renderCategoryCatalog(miniDict());
  assert.ok(!out.includes('$MPViewScreen'));
});

test('renderCategoryCatalog：最多 40 组', () => {
  const events = [];
  const categories = [];
  for (let i = 0; i < 60; i++) {
    events.push({ name: `mod${i}_a_x`, label: `模块${i}动作`, count: 60 - i, live: true, named: true });
    categories.push({ prefix: `mod${i}_a`, label: `模块${i}动作`, count: 3 });
  }
  const out = renderCategoryCatalog(indexDict({ events, categories }));
  assert.equal(out.split('\n').length, 40);
  // limit 可调，便于调用方按 prompt 预算收紧
  assert.equal(renderCategoryCatalog(indexDict({ events, categories }), 5).split('\n').length, 5);
});

test('renderCategoryCatalog：脏字典安全返回空串', () => {
  assert.equal(renderCategoryCatalog(null), '');
  assert.equal(renderCategoryCatalog(indexDict(null)), '');
  assert.equal(renderCategoryCatalog(indexDict({ events: [], categories: [{ prefix: 'a_b', label: 'x', count: 3 }] })), '');
});

test('buildUnderstandPrompt：prompt 里必须出现传入的今天日期', () => {
  // 回归锚点：模型不知道当前日期，没有这个锚点「最近一个月」会被算成训练数据里的某个月份。
  // 日期格式合法、数字也查得出来，只是查的是别的月份 —— 比直接报错危险得多。
  const p = buildUnderstandPrompt('帮我拿最近一个月的宝宝辅食页面的埋点', miniDict(), '2026-08-19');
  assert.ok(p.includes('2026-08-19'), 'prompt 必须包含今天的日期');
  assert.match(p, /今天是 2026-08-19（北京时间）/);
});

test('buildUnderstandPrompt：带上用户原文与模块目录', () => {
  const p = buildUnderstandPrompt('最近一个月宝宝辅食', miniDict(), '2026-08-19');
  assert.ok(p.includes('最近一个月宝宝辅食'));
  assert.ok(p.includes('baby_food：介绍页下一步 / 确认生日 / 选择奶源'));
});

test('buildUnderstandPrompt：目录为空时给出占位而不是空行', () => {
  const p = buildUnderstandPrompt('随便查查', indexDict(null), '2026-08-19');
  assert.ok(p.includes('（暂无模块目录）'));
});

test('buildPickPrompt：候选事件与候选页面都出现在 prompt 里', () => {
  const p = buildPickPrompt('分享功能', {
    events: [{ name: 'dish_share_wechat', label: '分享到微信' }],
    pages: [{ path: '/pages/chat/index', label: '会话页' }],
  });
  assert.ok(p.includes('分享功能'));
  assert.ok(p.includes('- dish_share_wechat : 分享到微信'));
  assert.ok(p.includes('- /pages/chat/index : 会话页'));
});

test('buildPickPrompt：明确禁止发明候选之外的标识', () => {
  const p = buildPickPrompt('x', { events: [], pages: [] });
  assert.match(p, /不要发明候选列表之外的标识/);
});

test('buildPickPrompt：候选为空时用「（无）」占位，不产出畸形文本', () => {
  // 空字符串会在 prompt 里留一段空白，模型容易读成「这里被截断了」而自行编造标识补上
  const p = buildPickPrompt('x', { events: [], pages: [] });
  assert.ok(p.includes('候选事件：\n（无）'));
  assert.ok(p.includes('候选页面：\n（无）'));
  assert.ok(!/\n\n\n/.test(p), '不应出现连续空行');
});

test('buildPickPrompt：candidates 结构脏也不炸', () => {
  for (const bad of [null, undefined, {}, { events: 'nope', pages: 7 }]) {
    const p = buildPickPrompt('x', bad);
    assert.ok(p.includes('（无）'));
  }
});

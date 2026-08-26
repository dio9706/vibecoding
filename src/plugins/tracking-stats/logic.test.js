import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRACKING_PREFIX,
  parseTrackingCommand,
  indexDict,
  recallCandidates,
  normalizeRange,
  inferGroupBy,
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  RETENTION_DAYS,
  validateSelection,
  MAX_TARGETS,
  buildSummaryText,
  buildReportFileName,
  buildUnderstandFailureReply,
  normalizeScope,
  buildScopeNotice,
  SCOPE_SAFE_TITLE,
} from './logic.js';

test('TRACKING_PREFIX 回归锚点', () => {
  assert.equal(TRACKING_PREFIX, '帮我统计埋点');
});

test('parseTrackingCommand：中英文冒号与无冒号都认', () => {
  assert.deepEqual(parseTrackingCommand('帮我统计埋点: 最近7天分享功能'), { hit: true, body: '最近7天分享功能' });
  assert.deepEqual(parseTrackingCommand('帮我统计埋点：最近7天分享功能'), { hit: true, body: '最近7天分享功能' });
  assert.deepEqual(parseTrackingCommand('帮我统计埋点 最近7天分享功能'), { hit: true, body: '最近7天分享功能' });
});

test('parseTrackingCommand：正文可以是任意自然语言（含"埋点"二字也不受影响）', () => {
  const r = parseTrackingCommand('帮我统计埋点: 帮我拿最近一个月的宝宝辅食页面的埋点');
  assert.deepEqual(r, { hit: true, body: '帮我拿最近一个月的宝宝辅食页面的埋点' });
});

test('parseTrackingCommand：只发前缀 → 命中但正文为空（调用方据此追问）', () => {
  assert.deepEqual(parseTrackingCommand('帮我统计埋点'), { hit: true, body: '' });
  assert.deepEqual(parseTrackingCommand('帮我统计埋点：  '), { hit: true, body: '' });
});

test('parseTrackingCommand：前缀不在开头一律不命中', () => {
  // 回归锚点：沿用 intent-keywords 的铁律 —— 历史事故是整篇文档贴进来被全文命中而误判
  assert.deepEqual(parseTrackingCommand('这个需求要帮我统计埋点: 分享'), { hit: false, body: '' });
  assert.deepEqual(parseTrackingCommand('文档里写了帮我统计埋点这几个字'), { hit: false, body: '' });
});

test('parseTrackingCommand：允许行首空白，但不允许其它前置文字', () => {
  assert.deepEqual(parseTrackingCommand('  帮我统计埋点: 分享'), { hit: true, body: '分享' });
});

test('parseTrackingCommand：非字符串与空串安全返回', () => {
  assert.deepEqual(parseTrackingCommand(null), { hit: false, body: '' });
  assert.deepEqual(parseTrackingCommand(''), { hit: false, body: '' });
  assert.deepEqual(parseTrackingCommand(123), { hit: false, body: '' });
});

const RAW_DICT = {
  events: [
    { name: 'dish_share_wechat', label: '分享到微信', count: 5000, live: true, named: true },
    { name: 'dish_share_save_photo', label: '保存分享图片', count: 300, live: true, named: true },
    { name: 'dish_share_page_load', label: '分享页加载', count: 20, live: true, named: true },
    { name: 'dish_share_legacy', label: '旧版分享', count: 0, live: false, named: true },
    { name: 'chat_sse_send', label: '会话发送', count: 68210, live: true, named: true },
    { name: 'baby_food_paywall_pay_success', label: 'baby_food_paywall_pay_success', count: 1820, live: true, named: false },
    { name: 'order_confirm_click_submit', label: '确认订单提交', count: 900, live: true, named: true },
  ],
  pages: [
    { path: '/pages-agent/baby-food/index', key: 'pages-agent/baby-food/index', label: '宝宝辅食首页', count: 4000, live: true, named: true },
    { path: '/pages/chat/index', key: 'pages/chat/index', label: '会话页', count: 52130, live: true, named: true },
  ],
  categories: [],
};
const DICT = indexDict(RAW_DICT);

test('indexDict：建立 O(1) 查找索引，原数组保持不变', () => {
  assert.equal(DICT.eventIndex.get('chat_sse_send').label, '会话发送');
  assert.equal(DICT.pageIndex.get('/pages/chat/index').label, '会话页');
  assert.equal(DICT.events.length, 7);
  assert.equal(DICT.eventIndex.size, 7);
});

test('indexDict：脏输入不炸', () => {
  const d = indexDict(null);
  assert.deepEqual(d.events, []);
  assert.equal(d.eventIndex.size, 0);
});

test('recallCandidates：中文名子串命中', () => {
  const r = recallCandidates(['分享'], DICT, 'event');
  const names = r.events.map((e) => e.name);
  assert.ok(names.includes('dish_share_wechat'));
  assert.ok(names.includes('dish_share_save_photo'));
  assert.ok(names.includes('dish_share_page_load'));
  assert.deepEqual(r.pages, []);
});

test('recallCandidates：标识名子串命中（用户直接说事件名）', () => {
  const r = recallCandidates(['chat_sse'], DICT, 'event');
  assert.deepEqual(r.events.map((e) => e.name), ['chat_sse_send']);
});

test('recallCandidates：字典缺中文名的事件同样能被标识名召回', () => {
  // 回归锚点：这类事件占生产实际的一半以上，漏掉它们等于功能瞎一半
  const r = recallCandidates(['paywall'], DICT, 'event');
  assert.deepEqual(r.events.map((e) => e.name), ['baby_food_paywall_pay_success']);
});

test('recallCandidates：同族前缀扩展 —— 命中一个就把同前缀一族拉进来', () => {
  const r = recallCandidates(['保存分享图片'], DICT, 'event');
  const names = r.events.map((e) => e.name);
  assert.ok(names.includes('dish_share_wechat'), '同族 dish_share_* 应被一并召回');
  assert.ok(names.includes('dish_share_page_load'));
});

test('recallCandidates：同等字面强度下，高频事件排在低频前面', () => {
  // 频次是比字面匹配更强的相关性信号：都叫「分享」，一个月触发 5000 次的
  // 显然比触发 20 次的更可能是用户想问的那个
  const r = recallCandidates(['分享'], DICT, 'event');
  const idxWechat = r.events.findIndex((e) => e.name === 'dish_share_wechat');
  const idxLoad = r.events.findIndex((e) => e.name === 'dish_share_page_load');
  assert.ok(idxWechat < idxLoad, '5000 次的应排在 20 次的前面');
});

test('recallCandidates：已下线事件（live=false）被降权到活跃事件之后', () => {
  const r = recallCandidates(['分享'], DICT, 'event');
  const idxLegacy = r.events.findIndex((e) => e.name === 'dish_share_legacy');
  const idxLoad = r.events.findIndex((e) => e.name === 'dish_share_page_load');
  assert.ok(idxLegacy > idxLoad, '已下线的应排在活跃的之后');
  assert.ok(idxLegacy >= 0, '但不能直接丢弃 —— 用户可能就是要查历史数据');
});

test('recallCandidates：target=page 只查页面', () => {
  const r = recallCandidates(['宝宝辅食'], DICT, 'page');
  assert.deepEqual(r.pages.map((p) => p.path), ['/pages-agent/baby-food/index']);
  assert.deepEqual(r.events, []);
});

test('recallCandidates：召回的页面必须带库内原始 path（带前导斜杠）', () => {
  // 回归锚点：SQL 用的是 path 不是 key，少个斜杠就是 0 命中且不报错
  const r = recallCandidates(['会话'], DICT, 'page');
  assert.ok(r.pages[0].path.startsWith('/'));
});

test('recallCandidates：target=both 两边都查', () => {
  const r = recallCandidates(['会话'], DICT, 'both');
  assert.ok(r.events.length >= 1);
  assert.ok(r.pages.length >= 1);
});

test('recallCandidates：事件与页面合计截断到 30 条（不是各 30）', () => {
  const events = [];
  for (let i = 0; i < 40; i++) events.push({ name: `evt_x${i}`, label: `测试事件${i}`, count: i, live: true, named: true });
  const pages = [];
  for (let i = 0; i < 40; i++) pages.push({ path: `/p/x${i}`, key: `p/x${i}`, label: `测试页面${i}`, count: i, live: true, named: true });
  const r = recallCandidates(['测试'], indexDict({ events, pages }), 'both');
  assert.equal(r.events.length + r.pages.length, 30);
});

test('recallCandidates：空关键词 / 脏字典安全返回', () => {
  assert.deepEqual(recallCandidates([], DICT, 'both'), { events: [], pages: [] });
  assert.deepEqual(recallCandidates(['分享'], indexDict(null), 'both'), { events: [], pages: [] });
  assert.deepEqual(recallCandidates(null, DICT, 'both'), { events: [], pages: [] });
});

test('常量回归锚点', () => {
  assert.equal(DEFAULT_RANGE_DAYS, 7);
  assert.equal(MAX_RANGE_DAYS, 90);
  assert.equal(RETENTION_DAYS, 180);
});

test('MAX_RANGE_DAYS 必须小于 RETENTION_DAYS，否则跨度上限是死代码', () => {
  // 回归锚点：曾经 RETENTION=75 < MAX_RANGE=90，导致 90 天上限永远不可达。
  // 这类 bug 不会让任何单个用例变红，只会让一整条分支静默失效。
  assert.ok(MAX_RANGE_DAYS < RETENTION_DAYS);
});

test('normalizeRange：正常区间原样通过', () => {
  const r = normalizeRange({ start: '2026-08-12', end: '2026-08-19' }, '2026-08-19');
  assert.equal(r.start, '2026-08-12');
  assert.equal(r.end, '2026-08-19');
  assert.deepEqual(r.notes, []);
});

test('normalizeRange：缺省 / 非法 → 近 7 天', () => {
  const r = normalizeRange(null, '2026-08-19');
  assert.equal(r.start, '2026-08-13'); // 含今天共 7 天
  assert.equal(r.end, '2026-08-19');
  assert.ok(r.notes.some((n) => n.includes('默认')));
});

test('normalizeRange：跨度超 90 天 → 收敛并留痕', () => {
  const r = normalizeRange({ start: '2026-01-01', end: '2026-08-19' }, '2026-08-19');
  assert.equal(r.end, '2026-08-19');
  assert.equal(r.start, '2026-05-22'); // 含首尾共 90 天
  assert.ok(r.notes.some((n) => n.includes('90')));
});

test('normalizeRange：早于保留期 → 抬到保留期起点并留痕', () => {
  // 跨度本身不超 90 天，只有起点早于保留期 —— 这样才能单独验证保留期这条分支
  const r = normalizeRange({ start: '2024-01-01', end: '2026-03-01' }, '2026-08-19');
  assert.equal(r.start, '2026-02-20'); // 今天往前 180 天
  assert.equal(r.outOfRetention, false); // end 还在保留期内，属于「收窄」而非「拒答」
  const retentionNote = r.notes.find((n) => n.includes('保留'));
  assert.ok(retentionNote);
  // 脚注只说明发生了什么、不写具体日期（日期是中间态，可能被后续收敛改掉）
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(retentionNote));
});

test('normalizeRange：start 晚于 end → 互换', () => {
  const r = normalizeRange({ start: '2026-08-19', end: '2026-08-12' }, '2026-08-19');
  assert.equal(r.start, '2026-08-12');
  assert.equal(r.end, '2026-08-19');
});

test('normalizeRange：end 超过今天 → 收敛到今天', () => {
  const r = normalizeRange({ start: '2026-08-12', end: '2026-12-31' }, '2026-08-19');
  assert.equal(r.end, '2026-08-19');
});

test('normalizeRange：区间整体早于保留期 → 标记 outOfRetention，不产出倒挂区间', () => {
  // 回归锚点：曾经只抬 start 不管 end，「2025年双十一」会变成 2026-02-20 ~ 2025-11-11，
  // days 为负。这种倒挂区间查 SQL 是 0 行且不报错，报告写「该时段无数据」——
  // 用户会以为那几天真没人用，是最难发现的一类错。
  const r = normalizeRange({ start: '2025-11-01', end: '2025-11-11' }, '2026-08-19');
  assert.equal(r.outOfRetention, true);
  assert.ok(r.days > 0, 'days 不得为负');
  assert.ok(r.start <= r.end, '起止不得倒挂');
  assert.ok(r.notes.some((n) => n.includes('保留')));
});

test('normalizeRange：正常路径 outOfRetention 恒为 false（不是 undefined）', () => {
  const r = normalizeRange({ start: '2026-08-12', end: '2026-08-19' }, '2026-08-19');
  assert.equal(r.outOfRetention, false);
});

test('normalizeRange：保留期脚注不写具体日期（避免中间态误导）', () => {
  // 两条分支都触发时，保留期抬到的日期会被 90 天上限进一步收窄，
  // 脚注若写中间态日期，用户会以为报告覆盖到那一天
  const r = normalizeRange({ start: '2024-01-01', end: '2026-08-19' }, '2026-08-19');
  assert.equal(r.start, '2026-05-22');
  const retentionNote = r.notes.find((n) => n.includes('保留'));
  assert.ok(retentionNote, '应有保留期提示');
  assert.ok(!retentionNote.includes('2026-02-20'), '不应出现被后续收窄掉的中间态日期');
});

test('normalizeRange：includesToday 标记', () => {
  assert.equal(normalizeRange({ start: '2026-08-12', end: '2026-08-19' }, '2026-08-19').includesToday, true);
  assert.equal(normalizeRange({ start: '2026-08-10', end: '2026-08-15' }, '2026-08-19').includesToday, false);
});

test('inferGroupBy：跨度 > 1 天按天，单日不分组', () => {
  assert.equal(inferGroupBy({ start: '2026-08-12', end: '2026-08-19' }), 'day');
  assert.equal(inferGroupBy({ start: '2026-08-19', end: '2026-08-19' }), 'none');
});

test('MAX_TARGETS 回归锚点', () => {
  assert.equal(MAX_TARGETS, 20);
});

test('validateSelection：索引里不存在的事件名一律剔除（模型编造防线）', () => {
  const r = validateSelection(
    { events: [{ name: 'dish_share_wechat' }, { name: 'totally_made_up_event' }], pages: [] },
    DICT,
  );
  assert.deepEqual(r.events, [{ name: 'dish_share_wechat', label: '分享到微信' }]);
  assert.deepEqual(r.dropped, ['totally_made_up_event']);
});

test('validateSelection：label 一律以索引为准，忽略模型自己写的', () => {
  const r = validateSelection({ events: [{ name: 'chat_sse_send', label: '模型瞎编的名字' }] }, DICT);
  assert.equal(r.events[0].label, '会话发送');
});

test('validateSelection：字典缺中文名的事件照常通过，label 回退为标识名', () => {
  const r = validateSelection({ events: [{ name: 'baby_food_paywall_pay_success' }] }, DICT);
  assert.equal(r.empty, false);
  assert.equal(r.events[0].label, 'baby_food_paywall_pay_success');
});

test('validateSelection：页面走白名单，且必须用库内原始 path', () => {
  const r = validateSelection(
    { pages: [{ path: '/pages/chat/index' }, { path: '/pages/nope' }] },
    DICT,
  );
  assert.deepEqual(r.pages, [{ path: '/pages/chat/index', label: '会话页' }]);
  assert.deepEqual(r.dropped, ['/pages/nope']);
});

test('validateSelection：缺前导斜杠的页面路径被剔除而不是静默放行', () => {
  // 回归锚点：字典 key 无斜杠、库内有。若这里放行归一化形式，
  // SQL 会拿着 'pages/chat/index' 去查，0 命中且不报错 —— 报告写「该时段无数据」
  const r = validateSelection({ pages: [{ path: 'pages/chat/index' }] }, DICT);
  assert.equal(r.empty, true);
  assert.deepEqual(r.dropped, ['pages/chat/index']);
});

test('validateSelection：全部剔除后 empty=true（调用方据此不查询）', () => {
  const r = validateSelection({ events: [{ name: 'nope' }] }, DICT);
  assert.equal(r.empty, true);
});

test('validateSelection：合计超过 20 条截断', () => {
  const events = [];
  const picks = [];
  for (let i = 0; i < 25; i++) {
    events.push({ name: `evt_${i}`, label: `事件${i}`, count: 1, live: true, named: true });
    picks.push({ name: `evt_${i}` });
  }
  const r = validateSelection({ events: picks }, indexDict({ events, pages: [] }));
  assert.equal(r.events.length, 20);
  assert.ok(r.truncated);
});

test('validateSelection：去重（模型重复选同一个）', () => {
  const r = validateSelection(
    { events: [{ name: 'chat_sse_send' }, { name: 'chat_sse_send' }] },
    DICT,
  );
  assert.equal(r.events.length, 1);
});

test('validateSelection：脏输入安全返回 empty', () => {
  assert.equal(validateSelection(null, DICT).empty, true);
  assert.equal(validateSelection({ events: 'nope' }, DICT).empty, true);
  assert.equal(validateSelection({ events: [{ name: 'chat_sse_send' }] }, indexDict(null)).empty, true);
});

test('buildSummaryText：完整数据的排版', () => {
  const text = buildSummaryText({
    title: '分享功能使用情况',
    range: '2026-08-12 ~ 2026-08-19',
    totalPv: 12847,
    totalUv: 3201,
    compareRate: 0.123,
    top: [
      { label: '分享到微信', pv: 5210 },
      { label: '保存分享图片', pv: 3120 },
      { label: '分享页加载', pv: 1900 },
    ],
  });
  assert.match(text, /分享功能使用情况/);
  assert.match(text, /2026-08-12 ~ 2026-08-19/);
  assert.match(text, /12,847/);       // 千分位
  assert.match(text, /3,201/);
  assert.match(text, /↑12\.3%/);
  assert.match(text, /分享到微信 5,210/);
});

test('buildSummaryText：环比为负显示下降箭头', () => {
  const text = buildSummaryText({ title: 'T', range: 'R', totalPv: 10, totalUv: 5, compareRate: -0.08, top: [] });
  assert.match(text, /↓8\.0%/);
});

test('buildSummaryText：环比缺失时不渲染该行', () => {
  const text = buildSummaryText({ title: 'T', range: 'R', totalPv: 10, totalUv: 5, compareRate: null, top: [] });
  assert.ok(!text.includes('↑') && !text.includes('↓'));
});

test('buildSummaryText：纯页面维度说「总浏览」而不是「总触发」', () => {
  const text = buildSummaryText({
    title: 'T', range: 'R', dimension: 'page',
    totalPv: 4521, eventPv: 0, pagePv: 4521, totalUv: 800,
    compareRate: null, top: [],
  });
  assert.match(text, /总浏览 4,521 次 · 独立用户 800 人/);
  assert.ok(!text.includes('总触发'), '页面浏览量不能被叫成「触发」');
});

test('buildSummaryText：混合维度拆开事件与页面，绝不相加', () => {
  // 回归锚点：曾经这里把点击次数和页面浏览量加成一个「总触发 90,091 次」——
  // 苹果加橘子，既不能回答「用了多少次」也不能回答「看了多少页」
  const text = buildSummaryText({
    title: 'T', range: 'R', dimension: 'both',
    totalPv: 90091, eventPv: 44949, pagePv: 45142, totalUv: 3726,
    compareRate: null, top: [],
  });
  assert.match(text, /事件触发 44,949 次 · 页面浏览 45,142 次 · 独立用户 3,726 人/);
  assert.ok(!text.includes('90,091'), '两个维度的量不得合并展示');
});

test('buildSummaryText：混合维度的环比分维度各写一条', () => {
  const text = buildSummaryText({
    title: 'T', range: 'R', dimension: 'both',
    totalPv: 30, eventPv: 10, pagePv: 20, totalUv: 5,
    compareRate: null, eventCompareRate: 0.25, pageCompareRate: -0.1, top: [],
  });
  assert.match(text, /事件触发 较上一周期 ↑25\.0%/);
  assert.match(text, /页面浏览 较上一周期 ↓10\.0%/);
});

test('buildSummaryText：混合维度只有一侧有环比时只写那一条', () => {
  const text = buildSummaryText({
    title: 'T', range: 'R', dimension: 'both',
    totalPv: 30, eventPv: 10, pagePv: 20, totalUv: 5,
    compareRate: null, eventCompareRate: null, pageCompareRate: 0.5, top: [],
  });
  assert.ok(!text.includes('事件触发 较上一周期'));
  assert.match(text, /页面浏览 较上一周期 ↑50\.0%/);
});

test('buildSummaryText：无 dimension 字段时按事件口径兜底（向后兼容）', () => {
  const text = buildSummaryText({ title: 'T', range: 'R', totalPv: 12, totalUv: 3, compareRate: null, top: [] });
  assert.match(text, /总触发 12 次 · 独立用户 3 人/);
});

test('buildSummaryText：空结果给出明确结论而不是空白', () => {
  const text = buildSummaryText({ title: 'T', range: 'R', totalPv: 0, totalUv: 0, compareRate: null, top: [] });
  assert.match(text, /该时段无数据/);
});

test('buildReportFileName：含标题与时间戳，非法字符被替换', () => {
  const name = buildReportFileName('分享/功能: 使用<情况>', new Date('2026-08-19T10:30:00Z'), 480);
  assert.match(name, /^埋点统计_分享_功能_ 使用_情况__20260819_1830\.html$/);
});

test('buildReportFileName：超长标题被截断', () => {
  const name = buildReportFileName('标'.repeat(60), new Date('2026-08-19T02:30:00Z'), 480);
  assert.ok(name.length < 80);
  assert.ok(name.endsWith('.html'));
});

// —— 阶段 A 失败回话 ——
// 2026-08-26 事故：用户发「统计从 8 月 1 日至今所有付费用户的行为轨迹」，模型 52.2s 算完，
// 而预算只有 47s，结果被丢弃后回了一句「没听懂这个统计需求，换个说法试试」。
// 需求表述完全正常，改说法一点用都没有 —— 归因错了，用户就只能瞎试。

test('buildUnderstandFailureReply：超时不能说成没听懂', () => {
  const r = buildUnderstandFailureReply('timeout');
  assert.ok(!r.includes('没听懂'), '超时说成没听懂会把用户引向改说法这条死路');
  assert.match(r, /超时/);
  assert.match(r, /再发一次|重试|再试/, '必须给出可执行的下一步');
});

test('buildUnderstandFailureReply：额度耗尽要点明原因', () => {
  const r = buildUnderstandFailureReply('exhausted');
  assert.ok(!r.includes('没听懂'));
  assert.match(r, /额度/);
});

test('buildUnderstandFailureReply：真的解析不出才说没听懂', () => {
  // 这条分支是唯一「换个说法」有意义的场景
  const r = buildUnderstandFailureReply('unparsable');
  assert.match(r, /没听懂/);
  assert.match(r, /帮我统计埋点/, '给个可照抄的正确例子');
});

test('buildUnderstandFailureReply：未知原因兜底为没听懂文案', () => {
  // 新增 reason 时忘了加分支也不能回一句 undefined
  for (const bad of [undefined, null, '', 'whatever']) {
    const r = buildUnderstandFailureReply(bad);
    assert.ok(typeof r === 'string' && r.length > 0);
    assert.ok(!r.includes('undefined'));
  }
});

// —— 能力边界守卫 ——
// 设计文档早就写明「不做：漏斗/留存/下钻/多事件关联/用户分群」，但实现里没有任何机制
// 让这条边界对用户可见 —— 越界需求会被当成普通关键词召回，产出一份看着有效实则答非所问的报告。
// 见 docs/superpowers/specs/2026-08-26-tracking-stats-scope-guard-design.md

test('normalizeScope：字段缺失/脏值一律退回「支持」——失效方向必须是现状', () => {
  // 这是本守卫最重要的安全属性：模型漏字段时退回今天的行为，
  // 而不是把所有需求都判成越界。反过来会让整个功能一夜之间失灵。
  for (const bad of [undefined, null, {}, 'nope', 123, []]) {
    const r = normalizeScope(bad);
    assert.equal(r.supported, true, `${JSON.stringify(bad)} 应退回 supported`);
    assert.deepEqual(r.unsupported, []);
  }
});

test('normalizeScope：只有显式 false 才算越界', () => {
  assert.equal(normalizeScope({ supported: true }).supported, true);
  // 非布尔的真值不该被当成越界信号
  assert.equal(normalizeScope({ supported: 'yes' }).supported, true);
  const r = normalizeScope({ supported: false, unsupported: ['用户分群'] });
  assert.equal(r.supported, false);
  assert.deepEqual(r.unsupported, ['用户分群']);
});

test('normalizeScope：声明越界却说不出禁区名 → 视为支持', () => {
  // 说不出「越界在哪」的判定不足以改变行为：拿它去拒答，用户会收到一条
  // 无法解释、也无法据此修改需求的拒绝 —— 那比直接给数据更糟。
  assert.equal(normalizeScope({ supported: false }).supported, true);
  assert.equal(normalizeScope({ supported: false, unsupported: [] }).supported, true);
  assert.equal(normalizeScope({ supported: false, unsupported: 'x' }).supported, true);
  assert.equal(normalizeScope({ supported: false, unsupported: ['', '  '] }).supported, true);
});

test('normalizeScope：禁区项去空白、丢空值', () => {
  const r = normalizeScope({ supported: false, unsupported: ['  用户分群 ', '', '多事件关联'] });
  assert.deepEqual(r.unsupported, ['用户分群', '多事件关联']);
});

test('buildScopeNotice：点明禁区、给替代口径、指出人工 SQL 更快', () => {
  const r = buildScopeNotice(['用户分群', '多事件关联']);
  assert.match(r, /用户分群/);
  assert.match(r, /多事件关联/);
  assert.match(r, /PV|UV|触发/, '必须说明替代口径是什么');
  assert.match(r, /SQL/, '必须给出真正能解决问题的出路');
});

test('buildScopeNotice：脏输入不炸且不印 undefined', () => {
  for (const bad of [undefined, null, [], 'x', [null, '']]) {
    const r = buildScopeNotice(bad);
    assert.ok(typeof r === 'string' && r.length > 0);
    assert.ok(!r.includes('undefined'));
  }
});

test('SCOPE_SAFE_TITLE：不含任何越界措辞', () => {
  // 用户拍板「报告附件不加声明」，于是 title 是报告脱离对话后唯一的防线。
  // 它绝不能出现轨迹/漏斗/分群这类词 —— 那正是要防的误导。
  for (const word of ['轨迹', '漏斗', '分群', '留存', '路径', '付费']) {
    assert.ok(!SCOPE_SAFE_TITLE.includes(word), `安全标题不该含「${word}」`);
  }
  assert.match(SCOPE_SAFE_TITLE, /PV|UV/, '要点明真实口径');
});

test('SCOPE_SAFE_TITLE：能安全用作文件名', () => {
  // title 会经 buildReportFileName 变成飞书附件名，非法字符会让上传或本地保存失败
  const name = buildReportFileName(SCOPE_SAFE_TITLE, new Date('2026-08-26T02:30:00Z'), 480);
  assert.ok(name.endsWith('.html'));
  assert.ok(!/[\\/:*?"<>|]/.test(name.replace(/\.html$/, '')), '不应残留非法字符');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJsonLoose,
  normalizeMap,
  nextMapVersion,
  buildMapgenPrompt,
  buildMapFixPrompt,
  buildMapChangePrompt,
  buildImpactPrompt,
  parseImpact,
  collectAnnotLines,
  markFreshPoints,
} from './req-map.logic.js';

// ---- parseJsonLoose ----

test('parseJsonLoose 解析裸 JSON', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
});

test('parseJsonLoose 剥掉 ```json 围栏', () => {
  // 模型极爱把 JSON 裹进代码围栏，这是最高频的解析失败来源
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```\n{"a":1}\n```'), { a: 1 });
});

test('parseJsonLoose 截掉前后的解释性文字', () => {
  assert.deepEqual(parseJsonLoose('好的，结果如下：\n{"a":1}\n希望有帮助'), { a: 1 });
});

test('parseJsonLoose 支持顶层数组', () => {
  assert.deepEqual(parseJsonLoose('前言\n[{"a":1}]\n后记'), [{ a: 1 }]);
});

test('parseJsonLoose 解析失败时抛错并带原文片段', () => {
  assert.throws(() => parseJsonLoose('完全不是 JSON'), /完全不是 JSON/);
});

test('parseJsonLoose 空输入抛错', () => {
  assert.throws(() => parseJsonLoose(''), /空/);
});

// ---- normalizeMap ----

test('normalizeMap 补全缺失 id 并保持稳定前缀', () => {
  const m = normalizeMap({ pages: [{ name: '列表页' }, { name: '详情页' }] });
  assert.deepEqual(m.pages.map((p) => p.id), ['p1', 'p2']);
});

test('normalizeMap 重复 id 自动去重', () => {
  const m = normalizeMap({ pages: [{ id: 'x', name: 'A' }, { id: 'x', name: 'B' }] });
  assert.equal(m.pages[0].id, 'x');
  assert.notEqual(m.pages[1].id, 'x');
});

test('normalizeMap 丢弃无名页面', () => {
  const m = normalizeMap({ pages: [{ name: 'A' }, { file: 'b.vue' }, { name: '' }] });
  assert.equal(m.pages.length, 1);
});

test('normalizeMap 归一逻辑点类型别名', () => {
  const m = normalizeMap({
    pages: [{ name: 'A', points: [
      { title: '1', type: '新增' }, { title: '2', type: 'update' },
      { title: '3', type: 'delete' }, { title: '4', type: 'new' },
      { title: '5', type: '乱写' },
    ] }],
  });
  assert.deepEqual(m.pages[0].points.map((p) => p.type), ['add', 'mod', 'del', 'add', 'mod']);
});

test('normalizeMap 丢弃无标题的逻辑点', () => {
  const m = normalizeMap({ pages: [{ name: 'A', points: [{ type: 'add' }, { title: 'ok', type: 'add' }] }] });
  assert.equal(m.pages[0].points.length, 1);
});

test('normalizeMap 无逻辑点的页面标记 untouched，有则 changed', () => {
  const m = normalizeMap({ pages: [{ name: 'A' }, { name: 'B', points: [{ title: 't', type: 'add' }] }] });
  assert.equal(m.pages[0].state, 'untouched');
  assert.equal(m.pages[1].state, 'changed');
});

test('normalizeMap 保留模型显式声明的 new 页面', () => {
  const m = normalizeMap({ pages: [{ name: 'A', state: 'new', points: [{ title: 't', type: 'add' }] }] });
  assert.equal(m.pages[0].state, 'new');
});

test('normalizeMap 边端点按 id 兜底时，丢弃指向不存在页面的孤儿边', () => {
  const m = normalizeMap({
    pages: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'ghost' }, { from: 'nope', to: 'b' }],
  });
  assert.equal(m.edges.length, 1);
});

test('normalizeMap 边端点按 id 兜底时，去重同向重复边', () => {
  const m = normalizeMap({
    pages: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    edges: [{ from: 'a', to: 'b', label: '点1' }, { from: 'a', to: 'b', label: '点2' }],
  });
  assert.equal(m.edges.length, 1);
});

test('normalizeMap 边端点按 id 兜底时，丢弃自环边', () => {
  const m = normalizeMap({ pages: [{ id: 'a', name: 'A' }], edges: [{ from: 'a', to: 'a' }] });
  assert.equal(m.edges.length, 0);
});

test('normalizeMap 按页面 name 解析边端点，落盘统一存 id', () => {
  // 契约要求 LLM 用 name（mapOutputContract），而 id 是本地自动编号 —— 这正是原 bug 现场
  const m = normalizeMap({
    pages: [{ name: '游戏广场' }, { name: '今晚吃什么转盘' }],
    edges: [{ from: '游戏广场', to: '今晚吃什么转盘', label: '点击 今晚吃什么' }],
  });
  const [square, wheel] = m.pages;
  assert.deepEqual(m.edges, [{ from: square.id, to: wheel.id, label: '点击 今晚吃什么' }]);
});

test('normalizeMap 边端点 name / id 混用都能解析', () => {
  const m = normalizeMap({
    pages: [{ id: 'a', name: '广场' }, { id: 'b', name: '转盘' }],
    edges: [{ from: '广场', to: 'b' }],
  });
  assert.deepEqual(m.edges.map((e) => [e.from, e.to]), [['a', 'b']]);
});

test('normalizeMap 跨表达方式的重复边只留首条', () => {
  // 去重键必须用解析后的 id，否则同一对页面「一次 name 一次 id」会在画布上画出重影
  const m = normalizeMap({
    pages: [{ id: 'a', name: '广场' }, { id: 'b', name: '转盘' }],
    edges: [{ from: '广场', to: '转盘', label: '点击' }, { from: 'a', to: 'b', label: '再点' }],
  });
  assert.equal(m.edges.length, 1);
  assert.equal(m.edges[0].label, '点击');
});

test('normalizeMap 同名页面的边指向首次出现的那个', () => {
  const m = normalizeMap({
    pages: [{ id: 'a', name: '重名' }, { id: 'b', name: '重名' }, { id: 'c', name: '目标' }],
    edges: [{ from: '重名', to: '目标' }],
  });
  assert.deepEqual(m.edges.map((e) => [e.from, e.to]), [['a', 'c']]);
});

test('normalizeMap 输入完全非法时返回空地图而不抛', () => {
  assert.deepEqual(normalizeMap(null).pages, []);
  assert.deepEqual(normalizeMap({}).pages, []);
  assert.deepEqual(normalizeMap({ pages: 'nope' }).pages, []);
});

test('normalizeMap 把 src/files 规整为字符串数组', () => {
  const m = normalizeMap({
    pages: [{ name: 'A', points: [{ title: 't', type: 'add', src: '需求文档 3.2', files: null }] }],
  });
  assert.deepEqual(m.pages[0].points[0].src, ['需求文档 3.2']);
  assert.deepEqual(m.pages[0].points[0].files, []);
});

test('normalizeMap 保留旧版的 figma / restoredAt，不被重生成抹掉', () => {
  // 地图修订会全量重出 pages，用户挂的设计稿必须按页面名回迁，否则每修订一次就丢一次
  const prev = normalizeMap({ pages: [{ name: 'A', file: 'a.vue' }] });
  prev.pages[0].figma = { url: 'u', node: 'n' };
  prev.pages[0].restoredAt = '2026-08-25T00:00:00.000Z';
  const next = normalizeMap({ pages: [{ name: 'A', file: 'a.vue' }] }, { prev });
  assert.deepEqual(next.pages[0].figma, { url: 'u', node: 'n' });
  assert.equal(next.pages[0].restoredAt, '2026-08-25T00:00:00.000Z');
});

test('normalizeMap 回迁只认同名页面，改名的页面不误挂设计稿', () => {
  const prev = normalizeMap({ pages: [{ name: 'A' }] });
  prev.pages[0].figma = { url: 'u', node: 'n' };
  const next = normalizeMap({ pages: [{ name: 'B' }] }, { prev });
  assert.equal(next.pages[0].figma, null);
});

// ---- nextMapVersion ----

test('nextMapVersion 空 → 1，有 → max+1', () => {
  assert.equal(nextMapVersion(null), 1);
  assert.equal(nextMapVersion({ versions: [] }), 1);
  assert.equal(nextMapVersion({ versions: [{ v: 1 }, { v: 3 }] }), 4);
});

// ---- prompt ----

test('buildMapgenPrompt 要求纯 JSON 且明确不要坐标', () => {
  const p = buildMapgenPrompt();
  assert.match(p, /JSON/);
  assert.match(p, /坐标/);
});

test('collectAnnotLines 只收有误的标注并带上页面与逻辑点名', () => {
  const map = normalizeMap({
    pages: [{ id: 'a', name: '列表页', points: [
      { id: 'lp1', title: '筛选', type: 'mod' },
      { id: 'lp2', title: '导出', type: 'add' },
    ] }],
  });
  const lines = collectAnnotLines(map, {
    lp1: { verdict: 'wrong', text: '要保留单选兼容' },
    lp2: { verdict: 'ok', text: '' },
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /列表页/);
  assert.match(lines[0], /筛选/);
  assert.match(lines[0], /保留单选兼容/);
});

test('collectAnnotLines 忽略指向已不存在逻辑点的标注', () => {
  const map = normalizeMap({ pages: [{ id: 'a', name: 'A', points: [{ id: 'lp1', title: 't', type: 'add' }] }] });
  assert.deepEqual(collectAnnotLines(map, { ghost: { verdict: 'wrong', text: 'x' } }), []);
});

test('buildMapFixPrompt 无有效标注时抛错，避免空跑一次 LLM', () => {
  const map = normalizeMap({ pages: [{ name: 'A' }] });
  assert.throws(() => buildMapFixPrompt({ map, annots: {} }), /标注/);
});

test('buildMapFixPrompt 把标注正文与输出契约都带上', () => {
  const map = normalizeMap({
    pages: [{ id: 'a', name: '列表页', points: [{ id: 'lp1', title: '筛选', type: 'mod' }] }],
  });
  const p = buildMapFixPrompt({ map, annots: { lp1: { verdict: 'wrong', text: '要保留单选兼容' } } });
  assert.match(p, /保留单选兼容/);
  assert.match(p, /JSON/);
});

test('buildMapgenPrompt 给了文档路径时要求先读文档（无 session 可 resume 的降级路径）', () => {
  assert.match(buildMapgenPrompt({ docPath: 'D:/x/dev-doc-v1.md' }), /dev-doc-v1\.md/);
  assert.doesNotMatch(buildMapgenPrompt(), /Read/);
});

// ---- buildMapChangePrompt ----

test('buildMapChangePrompt 带上变动正文与输出契约', () => {
  const map = normalizeMap({ pages: [{ name: 'A', points: [{ title: 't', type: 'add' }] }] });
  const p = buildMapChangePrompt({ map, text: '导出格式砍掉 CSV' });
  assert.match(p, /导出格式砍掉 CSV/);
  assert.match(p, /JSON/);
});

test('buildMapChangePrompt 正文为空时抛错', () => {
  const map = normalizeMap({ pages: [{ name: 'A' }] });
  assert.throws(() => buildMapChangePrompt({ map, text: '  ' }), /变动/);
});

// ---- buildImpactPrompt / parseImpact ----

const impactMap = normalizeMap({
  pages: [
    { id: 'pa', name: '列表页', points: [{ id: 'lp1', title: '批量导出按钮', type: 'add' }] },
    { id: 'pb', name: '未变更页', points: [] },
  ],
});

test('buildImpactPrompt 只带逻辑点摘要，不带 before/after 全文', () => {
  const p = buildImpactPrompt({ map: impactMap, text: '砍掉 CSV' });
  assert.match(p, /lp1/);
  assert.match(p, /批量导出按钮/);
  assert.match(p, /砍掉 CSV/);
});

test('buildImpactPrompt 跳过无逻辑点的页面', () => {
  assert.doesNotMatch(buildImpactPrompt({ map: impactMap, text: 'x' }), /未变更页/);
});

test('buildImpactPrompt 地图里一个逻辑点都没有时抛错', () => {
  assert.throws(() => buildImpactPrompt({ map: normalizeMap({ pages: [{ name: 'A' }] }), text: 'x' }), /逻辑点/);
});

test('parseImpact 回填页面名与逻辑点标题', () => {
  const r = parseImpact('[{"pointId":"lp1","action":"改","why":"要加一项"}]', impactMap);
  assert.deepEqual(r, [
    { pointId: 'lp1', pageName: '列表页', title: '批量导出按钮', type: 'add', action: '改', why: '要加一项' },
  ]);
});

test('parseImpact 丢弃模型编造的 pointId', () => {
  assert.deepEqual(parseImpact('[{"pointId":"ghost","action":"改"}]', impactMap), []);
});

test('parseImpact 非数组输出降级为空，不抛', () => {
  assert.deepEqual(parseImpact('{"a":1}', impactMap), []);
});

// ---- markFreshPoints ----

const mk = (pts) => normalizeMap({ pages: [{ id: 'a', name: '列表页', points: pts }] });

test('markFreshPoints 把新增的逻辑点标为本轮变化', () => {
  const prev = mk([{ id: 'lp1', title: '筛选', type: 'mod', after: 'x' }]);
  const next = mk([
    { id: 'lp1', title: '筛选', type: 'mod', after: 'x' },
    { id: 'lp2', title: '回填', type: 'add', after: 'y' },
  ]);
  markFreshPoints(prev, next);
  assert.equal(next.pages[0].points[0].fresh, false);
  assert.equal(next.pages[0].points[1].fresh, true);
});

test('markFreshPoints 把「变更后」描述改了的点标为本轮变化', () => {
  const prev = mk([{ id: 'lp1', title: '筛选', type: 'mod', after: '旧口径' }]);
  const next = mk([{ id: 'lp1', title: '筛选', type: 'mod', after: '新口径' }]);
  markFreshPoints(prev, next);
  assert.equal(next.pages[0].points[0].fresh, true);
});

test('markFreshPoints 类型变了也算本轮变化', () => {
  const prev = mk([{ id: 'lp1', title: '筛选', type: 'mod', after: 'x' }]);
  const next = mk([{ id: 'lp1', title: '筛选', type: 'del', after: 'x' }]);
  markFreshPoints(prev, next);
  assert.equal(next.pages[0].points[0].fresh, true);
});

test('markFreshPoints 按「页面名+逻辑点标题」比对，不依赖易变的 id', () => {
  // 模型每次重出地图 id 都会变，用 id 比对会导致「全部都是新的」
  const prev = mk([{ id: 'old-1', title: '筛选', type: 'mod', after: 'x' }]);
  const next = mk([{ id: 'brand-new', title: '筛选', type: 'mod', after: 'x' }]);
  markFreshPoints(prev, next);
  assert.equal(next.pages[0].points[0].fresh, false);
});

test('markFreshPoints 首版（无上一版）一律不标', () => {
  const next = mk([{ id: 'lp1', title: '筛选', type: 'mod' }]);
  markFreshPoints(null, next);
  assert.equal(next.pages[0].points[0].fresh, false);
});

test('markFreshPoints 全新页面上的点全部标为本轮变化', () => {
  const prev = mk([{ id: 'lp1', title: '筛选', type: 'mod' }]);
  const next = normalizeMap({ pages: [{ name: '新弹窗', points: [{ title: '范围选择', type: 'add' }] }] });
  markFreshPoints(prev, next);
  assert.equal(next.pages[0].points[0].fresh, true);
});

test('地图输出契约把 edges 列为硬性要求', () => {
  const p = buildMapgenPrompt({});
  for (const kw of ['入口页', '至少要有一条入边', '全部下钻链路']) {
    assert.ok(p.includes(kw), '契约缺少要求：' + kw);
  }
});

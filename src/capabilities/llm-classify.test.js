import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFirstJsonObject, classifyOutcome } from './llm-classify.js';

// 只测纯函数：runClassifierOnce 会发起真实 LLM 调用（烧额度），单测一律不碰。
// 提取逻辑正是 2026-08-19 埋点统计冒烟暴露的故障点，抽出来单独钉死。
// classifyOutcome 是 2026-08-26「超时被误报成没听懂」那次事故的判定核心，同样钉死。

/** 断言：提取出的原文能 JSON.parse，且结构与期望深相等 */
const parsed = (text) => JSON.parse(extractFirstJsonObject(text));

test('扁平对象：现有三个调用方的形状必须原样通过（回归）', () => {
  // intent.js quickClassify
  assert.deepEqual(parsed('{"type":"bug","action_id":null}'), { type: 'bug', action_id: null });
  // slot-filler 变量抽取
  assert.deepEqual(parsed('{"env":"test","phone":"13800138000"}'), { env: 'test', phone: '13800138000' });
  // bug-patrol / req-inspect 字段映射
  assert.deepEqual(
    parsed('{"status_field":"处理进展","pending_value":"待处理","fixing_value":"修复中","assignee_field":"处理人"}'),
    { status_field: '处理进展', pending_value: '待处理', fixing_value: '修复中', assignee_field: '处理人' },
  );
  // task-triage 动作分类
  assert.deepEqual(parsed('{"action":"start"}'), { action: 'start' });
});

test('嵌套对象：本次故障场景（旧正则在此截断成残缺 JSON）', () => {
  const out = '{"range": {"start": "2026-07-21", "end": "2026-08-19"}, "target": "page", "keywords": ["宝宝辅食","baby_food"], "title": "报告"}';
  assert.deepEqual(parsed(out), {
    range: { start: '2026-07-21', end: '2026-08-19' },
    target: 'page',
    keywords: ['宝宝辅食', 'baby_food'],
    title: '报告',
  });
  // 旧正则的行为：停在第一个 } → 截出的片段必然 parse 不了
  assert.notEqual(extractFirstJsonObject(out), out.match(/\{[\s\S]*?\}/)[0]);
});

test('数组含对象：精选阶段 / memory-bank items 的形状', () => {
  assert.deepEqual(parsed('{"events": [{"name": "a"}], "pages": []}'), { events: [{ name: 'a' }], pages: [] });
  assert.deepEqual(
    parsed('{"items":[{"category":"code-style","statement":"注释用中文","contradicts":false}]}'),
    { items: [{ category: 'code-style', statement: '注释用中文', contradicts: false }] },
  );
});

test('字符串字面量里的大括号不参与深度计数', () => {
  assert.deepEqual(parsed('{"tip": "用 {} 包起来"}'), { tip: '用 {} 包起来' });
  assert.deepEqual(parsed('{"a": "只有左 {", "b": "只有右 }"}'), { a: '只有左 {', b: '只有右 }' });
});

test('字符串里的转义引号不打乱「是否在字符串内」的判断', () => {
  assert.deepEqual(parsed('{"a": "he said \\"hi\\"", "b": 1}'), { a: 'he said "hi"', b: 1 });
  // 结尾是转义反斜杠：\\ 之后的 " 是真正的字符串结束符，不能被吞掉
  assert.deepEqual(parsed('{"p": "C:\\\\tmp\\\\", "q": {"n": 2}}'), { p: 'C:\\tmp\\', q: { n: 2 } });
  // 反斜杠转义的大括号场景：字符串里带 \" 和 } 同时出现
  assert.deepEqual(parsed('{"s": "说 \\"}\\" 不算结束"}'), { s: '说 "}" 不算结束' });
});

test('前后被说明文字包裹时只截中间那个对象', () => {
  const out = '好的，结果如下：{"target": "page", "range": {"start": "2026-08-01"}} 希望有帮助';
  assert.equal(extractFirstJsonObject(out), '{"target": "page", "range": {"start": "2026-08-01"}}');
  assert.deepEqual(parsed(out), { target: 'page', range: { start: '2026-08-01' } });
});

test('多个对象时只取第一个（不贪婪吃到最后一个 }）', () => {
  assert.equal(extractFirstJsonObject('{"a":1} 还有 {"b":2}'), '{"a":1}');
});

test('markdown 代码块包裹也能提取（模型常见的不听话输出）', () => {
  assert.deepEqual(parsed('```json\n{"events":[{"name":"x"}],"pages":[]}\n```'), {
    events: [{ name: 'x' }],
    pages: [],
  });
});

test('提取不出时返回 null（与旧正则的失败语义一致）', () => {
  assert.equal(extractFirstJsonObject('这里没有任何 JSON'), null);
  assert.equal(extractFirstJsonObject(''), null);
  assert.equal(extractFirstJsonObject(null), null);
  assert.equal(extractFirstJsonObject(undefined), null);
  assert.equal(extractFirstJsonObject(123), null);
  // 只有左括号 / 被截断的回复：宁可 null 也不交残缺 JSON
  assert.equal(extractFirstJsonObject('{'), null);
  assert.equal(extractFirstJsonObject('{"range": {"start": "2026-07-21"'), null);
  // 未闭合的字符串里即使有 }，也不算配平
  assert.equal(extractFirstJsonObject('{"a": "未闭合 }'), null);
});

test('classifyOutcome：正常输出 → 数据到手、无失败原因', () => {
  const r = classifyOutcome({ text: '{"target":"page"}' });
  assert.deepEqual(r.data, { target: 'page' });
  assert.equal(r.reason, null);
});

test('classifyOutcome：额度耗尽的 fail-fast 单独成因', () => {
  // 不能和「没听懂」混为一谈：额度问题让用户改说法是纯粹的误导，他改一百遍也没用
  const r = classifyOutcome({ exhausted: true, text: '' });
  assert.equal(r.data, null);
  assert.equal(r.reason, 'exhausted');
});

test('classifyOutcome：超时且无有效输出 → timeout', () => {
  // 2026-08-26 事故：阶段 A 47s 预算用尽，回话却说「没听懂这个统计需求」
  const r = classifyOutcome({ aborted: true, text: '' });
  assert.equal(r.data, null);
  assert.equal(r.reason, 'timeout');
});

test('classifyOutcome：超时但已攒到完整 JSON → 照样采纳', () => {
  // 关键改进：abort 只说明「流没按时结束」，不代表没拿到答案。
  // 模型常在早期就把 JSON 吐完，SDK 流却迟迟不收尾（限流时尤其明显）——
  // 此时丢掉手里已经完整的结果去回一句失败，是白烧了一次额度还骗了用户。
  const r = classifyOutcome({ aborted: true, text: '{"target":"event","keywords":["分享"]}' });
  assert.deepEqual(r.data, { target: 'event', keywords: ['分享'] });
  assert.equal(r.reason, null);
});

test('classifyOutcome：未超时但输出里没有 JSON → unparsable', () => {
  const r = classifyOutcome({ text: '我不太确定你想统计什么' });
  assert.equal(r.data, null);
  assert.equal(r.reason, 'unparsable');
});

test('classifyOutcome：截出来了却 parse 不了，仍归 unparsable', () => {
  // 大括号配平但内容非法（如尾逗号）：属于模型输出质量问题，不是超时
  const r = classifyOutcome({ aborted: false, text: '{"a":1,}' });
  assert.equal(r.data, null);
  assert.equal(r.reason, 'unparsable');
});

test('classifyOutcome：超时且输出是残缺 JSON → timeout（而非 unparsable）', () => {
  // 被截断正是超时的典型表现，归因必须落在超时上，否则排查会往「模型不听话」的方向跑偏
  const r = classifyOutcome({ aborted: true, text: '{"range": {"start": "2026-08-01"' });
  assert.equal(r.data, null);
  assert.equal(r.reason, 'timeout');
});

test('classifyOutcome：脏输入不炸', () => {
  for (const bad of [undefined, null, {}, { text: null }, { text: 123 }]) {
    const r = classifyOutcome(bad);
    assert.equal(r.data, null);
    assert.ok(typeof r.reason === 'string');
  }
});

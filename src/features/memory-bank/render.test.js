import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, selectForInjection } from './render.js';

const NOW = Date.parse('2026-08-11T00:00:00.000Z');
const DAY = 86400000;

const item = (over = {}) => ({
  id: 'm1', category: 'code-style', scope: 'global', projectDir: '',
  statement: '注释写中文', status: 'active', inject: true, source: 'inferred',
  evidenceCount: 3, evidenceSessions: ['s1', 's2'], lastSeenAt: NOW,
  ...over,
});

test('只渲染 active 且 inject 的条目', () => {
  const items = [
    item({ id: 'a', statement: '生效的' }),
    item({ id: 'b', statement: '候选的', status: 'candidate' }),
    item({ id: 'c', statement: '休眠的', status: 'dormant' }),
    item({ id: 'd', statement: '冲突的', status: 'conflict' }),
    item({ id: 'e', statement: '仅记录的', category: 'dialogue', inject: false }),
  ];
  const { text, included } = renderMarkdown(items, { scope: 'global', now: NOW });
  assert.equal(included.length, 1);
  assert.match(text, /生效的/);
  assert.doesNotMatch(text, /候选的|休眠的|冲突的|仅记录的/);
});

test('按 category 分节，用中文小节名', () => {
  const items = [
    item({ id: 'a', category: 'code-style', statement: '注释写中文' }),
    item({ id: 'b', category: 'collaboration', statement: '大改前先问我' }),
  ];
  const { text } = renderMarkdown(items, { scope: 'global', now: NOW });
  assert.match(text, /## 代码风格\n- 注释写中文/);
  assert.match(text, /## 协作习惯\n- 大改前先问我/);
});

test('未知 category 的条目不会被静默丢弃 —— 必须计入 truncated', () => {
  const items = [item({ id: 'x', category: 'other', statement: '未知分类的规则' })];
  const { text, included, truncated } = renderMarkdown(items, { scope: 'global', now: NOW });
  assert.equal(included.length, 0, '未知 category 不该进入 included');
  assert.equal(truncated, 1, '被挡掉的条目必须诚实计入 truncated，否则面板会显示「0 条未注入」但规则实际哪儿都不在');
  assert.equal(text, '', '没有任何已知分类的条目时，text 应为空串，而不是只含头部注释的“假非空”');
});

test('顶部带「勿手工编辑」声明，避免用户改了被覆盖', () => {
  const { text } = renderMarkdown([item()], { scope: 'global', now: NOW });
  assert.match(text, /自动生成/);
});

test('scope 过滤：project 渲染只取该 projectDir 的条目', () => {
  const items = [
    item({ id: 'a', scope: 'global', statement: '全局的' }),
    item({ id: 'b', scope: 'project', projectDir: 'C:/x', statement: 'X 工程的' }),
    item({ id: 'c', scope: 'project', projectDir: 'C:/y', statement: 'Y 工程的' }),
  ];
  const g = renderMarkdown(items, { scope: 'global', now: NOW });
  assert.deepEqual(g.included.map((i) => i.id), ['a']);
  const p = renderMarkdown(items, { scope: 'project', projectDir: 'C:/x', now: NOW });
  assert.deepEqual(p.included.map((i) => i.id), ['b']);
});

test('超条数预算 —— explicit 优先保留，并如实报告截断数', () => {
  const items = [
    item({ id: 'a', source: 'inferred', statement: '推断的', evidenceCount: 9 }),
    item({ id: 'b', source: 'explicit', statement: '我明说的', evidenceCount: 1 }),
  ];
  const { included, truncated } = renderMarkdown(items, { scope: 'global', now: NOW, maxItems: 1 });
  assert.deepEqual(included.map((i) => i.id), ['b'], 'explicit 必须压过高证据数的 inferred');
  assert.equal(truncated, 1);
});

test('同为 inferred 时，证据多且新的排前面', () => {
  const items = [
    item({ id: 'old', evidenceCount: 3, lastSeenAt: NOW - 60 * DAY }),
    item({ id: 'new', evidenceCount: 3, lastSeenAt: NOW }),
  ];
  const { included } = selectForInjection(items, { scope: 'global', now: NOW, maxItems: 2, maxChars: 9999 });
  assert.equal(included[0].id, 'new');
});

test('同为 inferred 且 lastSeenAt 相同时，证据多的排前面（单独验证 evidenceCount 因子，不与 recency 混着测）', () => {
  const items = [
    item({ id: 'few', evidenceCount: 1, lastSeenAt: NOW }),
    item({ id: 'many', evidenceCount: 5, lastSeenAt: NOW }),
  ];
  const { included } = selectForInjection(items, { scope: 'global', now: NOW, maxItems: 2, maxChars: 9999 });
  assert.equal(included[0].id, 'many', 'lastSeenAt 相同时，evidenceCount 更大的必须排前面');
});

test('statement 为 null 时不抛异常（手工编辑或迁移来的 memory-bank.json 可能有脏字段）', () => {
  const items = [item({ id: 'x', statement: null })];
  assert.doesNotThrow(() => selectForInjection(items, { scope: 'global', now: NOW }));
});

test('selectForInjection 不得修改传入的 items 数组 —— 纯函数契约，防止「优化」把 filter 去掉或改成 items.sort() 后原地重排调用方数组', () => {
  const items = [
    item({ id: 'a', evidenceCount: 1, lastSeenAt: NOW - 60 * DAY }),
    item({ id: 'b', evidenceCount: 9, lastSeenAt: NOW }),
  ];
  const originalOrder = items.map((it) => it.id);
  selectForInjection(items, { scope: 'global', now: NOW });
  assert.deepEqual(items.map((it) => it.id), originalOrder, '调用后入参数组的顺序不该被就地打乱');
});

test('超字符预算按行截断，truncated 计入', () => {
  const items = [
    item({ id: 'a', source: 'explicit', statement: 'A'.repeat(100) }),
    item({ id: 'b', source: 'inferred', statement: 'B'.repeat(100) }),
  ];
  const { text, included, truncated } = renderMarkdown(items, {
    scope: 'global', now: NOW, maxItems: 40, maxChars: 160,
  });
  assert.equal(included.length, 1);
  assert.equal(truncated, 1);
  assert.doesNotMatch(text, /B{100}/, '被截断的条目不能出现在正文里 —— 只断言长度上界会近乎恒真，验证不到任何截断行为');
});

test('无可渲染条目时返回空串 —— 调用方必须把 memory-bank.md 写成空文件，而不是跳过写盘（跳过会让旧内容继续被 CLAUDE.md 引用，用户否掉的规则将永久生效）', () => {
  const { text, included } = renderMarkdown([], { scope: 'global', now: NOW });
  assert.equal(text, '');
  assert.deepEqual(included, []);
});

// ── v2 memories 归一化路径 ────────────────────────────────────────────────────
// v2 memory 对象来自 synthesize.js，缺少 v1 字段（status/inject/scope），
// normalizeMem 负责补全，使其能正常通过 selectForInjection 过滤器并被渲染入 CLAUDE.md。

const v2mem = (over = {}) => ({
  id: 'v2_1',
  category: 'code-style',
  statement: 'v2 规则：注释写中文',
  reasoning: '用户多次使用中文注释',
  createdAt: NOW,
  source: 'synthesized',
  ...over,
});

test('v2 memory（无 status 字段）能被 normalizeMem 归一化并正常渲染到 Markdown', () => {
  const items = [v2mem()];
  const { text, included, truncated } = renderMarkdown(items, { scope: 'global', now: NOW });
  assert.equal(included.length, 1, 'v2 memory 应能通过过滤器进入 included');
  assert.equal(truncated, 0, '正常 v2 memory 不应被截断');
  assert.match(text, /v2 规则：注释写中文/, '渲染结果里应包含 statement 文本');
  assert.match(text, /## 代码风格/, '应按 category 分节，用中文节名');
});

test('v2 memory 含未知 category 时，必须计入 truncated 而非静默丢弃', () => {
  const items = [v2mem({ category: 'unknown-cat', statement: '未知分类的 v2 规则' })];
  const { text, included, truncated } = renderMarkdown(items, { scope: 'global', now: NOW });
  assert.equal(included.length, 0, '未知 category 不应进入 included');
  assert.equal(truncated, 1, '被挡掉的 v2 memory 必须诚实计入 truncated');
  assert.equal(text, '', '无可渲染条目时 text 应为空串');
});

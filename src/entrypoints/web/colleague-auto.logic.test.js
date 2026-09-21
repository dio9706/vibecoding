import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extOf,
  isApiDocCandidate,
  API_DOC_SAMPLE_CHARS,
  buildApiDocClassifyPrompt,
  parseApiDocVerdict,
  buildTextClassifyPrompt,
  parseTextVerdict,
  buildBrief,
  BRIEF_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  buildColleagueDevPrompt,
  newSubConvId,
} from './colleague-auto.logic.js';

test('extOf：取小写扩展名；无扩展名 / 空 / 非字符串归空串', () => {
  assert.equal(extOf('api.MD'), 'md');
  assert.equal(extOf('a.b.yaml'), 'yaml');
  assert.equal(extOf('README'), '');
  assert.equal(extOf(''), '');
  assert.equal(extOf(null), '');
});

test('isApiDocCandidate：只放行能抽出文本的格式', () => {
  for (const ok of ['a.md', 'a.txt', 'a.json', 'a.yaml', 'a.yml', 'a.docx', 'A.DOCX']) assert.equal(isApiDocCandidate(ok), true, ok);
  for (const no of ['a.pdf', 'a.png', 'a.xlsx', 'a', 'a.doc']) assert.equal(isApiDocCandidate(no), false, no);
});

test('buildApiDocClassifyPrompt：含文件名、样本、只输出 JSON 的契约', () => {
  const p = buildApiDocClassifyPrompt({ fileName: 'order-api.md', sample: 'GET /api/orders' });
  assert.match(p, /order-api\.md/);
  assert.match(p, /GET \/api\/orders/);
  assert.match(p, /"isApiDoc"/);
  assert.match(p, /只输出/);
  assert.match(p, /README/);
  assert.match(p, /以内容为准/);
});

test('parseApiDocVerdict：只认字面 true', () => {
  assert.equal(parseApiDocVerdict({ isApiDoc: true }), true);
  assert.equal(parseApiDocVerdict({ isApiDoc: 'true' }), false);
  assert.equal(parseApiDocVerdict({ isApiDoc: false }), false);
  assert.equal(parseApiDocVerdict(null), false);
  assert.equal(parseApiDocVerdict({}), false);
});

test('buildTextClassifyPrompt：含需求标题与原句，要求 needsAction/summary/prompt 三字段', () => {
  const p = buildTextClassifyPrompt({ reqTitle: '订单导出', text: '列表接口加了 status 字段' });
  assert.match(p, /订单导出/);
  assert.match(p, /status 字段/);
  assert.match(p, /"needsAction"/);
  assert.match(p, /"summary"/);
  assert.match(p, /"prompt"/);
  assert.match(p, /只输出/);
  assert.match(p, /原文保留/);
  assert.match(p, /不要换行/);
  assert.match(p, new RegExp(String(SUMMARY_MAX_CHARS)));
});

test('parseTextVerdict：needsAction 为真且 prompt 非空才返回任务，summary 截 30 字且缺省取 prompt 开头', () => {
  const v = parseTextVerdict({ needsAction: true, summary: '加 status 字段', prompt: '后端列表接口新增 status，前端表格加一列' });
  assert.deepEqual(v, { summary: '加 status 字段', prompt: '后端列表接口新增 status，前端表格加一列' });
  const long = parseTextVerdict({ needsAction: true, summary: '一'.repeat(50), prompt: 'p' });
  assert.equal(Array.from(long.summary).length, SUMMARY_MAX_CHARS);
  const noSummary = parseTextVerdict({ needsAction: true, summary: '', prompt: '接口改了字段名 foo→bar，前端同步' });
  assert.equal(noSummary.summary, '接口改了字段名 foo→bar，前端同步'.slice(0, 30));
  const nl = parseTextVerdict({ needsAction: true, summary: '加\n\nstatus  字段', prompt: 'p' });
  assert.equal(nl.summary, '加 status 字段', 'summary 会成为会话标题，内部空白要压平');
});

test('parseTextVerdict：不需要 / prompt 空 / 脏输入一律 null', () => {
  assert.equal(parseTextVerdict({ needsAction: false, summary: 'x', prompt: 'y' }), null);
  assert.equal(parseTextVerdict({ needsAction: true, summary: 'x', prompt: '   ' }), null, '没有任务描述的 run 只会让 Claude 反问');
  assert.equal(parseTextVerdict({ needsAction: 'true', prompt: 'y' }), null);
  assert.equal(parseTextVerdict(null), null);
  assert.equal(parseTextVerdict('junk'), null);
  assert.equal(parseTextVerdict([{ needsAction: true, prompt: 'x' }]), null, '数组不是判定对象');
});

test('buildBrief：成功带结果并截断，失败固定文案，空结果不带冒号', () => {
  assert.equal(buildBrief(false, '随便什么'), '接入遇到问题，已转主机处理');
  assert.equal(buildBrief(true, ''), '已处理完成');
  assert.equal(buildBrief(true, '  改了\n\n三个  文件 '), '已处理完成：改了 三个 文件');
  const b = buildBrief(true, 'x'.repeat(BRIEF_MAX_CHARS + 50));
  assert.equal(b, '已处理完成：' + 'x'.repeat(BRIEF_MAX_CHARS) + '…');
  assert.equal(buildBrief(true, 'y'.repeat(BRIEF_MAX_CHARS)), '已处理完成：' + 'y'.repeat(BRIEF_MAX_CHARS), '恰好到上限不加省略号');
  // 必须用星际平面字符（😀 .length===2）：BMP 内的 ✅ 用旧的 slice 也能过，测不出代理对是否被切开
  const emoji = buildBrief(true, '😀'.repeat(BRIEF_MAX_CHARS + 1));
  assert.ok(emoji.endsWith('…'));
  assert.equal(Array.from(emoji).length, Array.from('已处理完成：').length + BRIEF_MAX_CHARS + 1, '按字符截断，不切开 emoji 代理对');
  assert.ok(emoji.isWellFormed(), '不能含孤立的半个代理对（Node ≥20 的 isWellFormed 直接判）');
});

test('newSubConvId：c + 13 位时间戳 + 3 位随机，与前端纯数字 id 不撞', () => {
  assert.match(newSubConvId(1700000000000), /^c1700000000000[a-z0-9]{3}$/);
  assert.notEqual(newSubConvId(1700000000000).slice(0, 14), newSubConvId(1700000000001).slice(0, 14), '不同时间戳前缀不同');
  assert.match(newSubConvId(), /^c\d{13}[a-z0-9]{3}$/);
});

test('API_DOC_SAMPLE_CHARS 是正整数', () => {
  assert.ok(Number.isInteger(API_DOC_SAMPLE_CHARS) && API_DOC_SAMPLE_CHARS > 0);
});

test('buildColleagueDevPrompt：同时带原话与提炼，要求以原话为准', () => {
  const p = buildColleagueDevPrompt({ reqTitle: '订单导出', original: 'status 改成 number', task: '表格列类型同步' });
  assert.match(p, /订单导出/);
  assert.match(p, /status 改成 number/);
  assert.match(p, /表格列类型同步/);
  assert.match(p, /以原话为准/);
  assert.match(p, /只读参考工程禁止修改/);
});

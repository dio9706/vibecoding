import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PATROL_TRIGGERS,
  isCancelText,
  parseBitableLink,
  summarizeFieldsForMapping,
  buildFieldMappingPrompt,
  validateFieldMapping,
  primaryFieldName,
  buildStatusFilter,
  cellText,
  personOpenIds,
  isAssignedToMe,
  recordTitle,
  buildRecordDetail,
  buildPatrolSummary,
} from './logic.js';

// —— 触发文案常量本身的回归锚点（严格匹配的“规格”就是这两个字符串，改动必须是有意的）——
test('PATROL_TRIGGERS 覆盖两种写法', () => {
  assert.deepEqual(PATROL_TRIGGERS, [
    '\\10001 开始进行BUG巡检与修复',
    '\\10001 开始进行BUG巡检与修复(多维表格)',
  ]);
});

test('isCancelText：短取消词命中，普通句子/长文不命中', () => {
  assert.equal(isCancelText('取消'), true);
  assert.equal(isCancelText(' 算了吧 '), true);
  assert.equal(isCancelText('不用了'), true);
  assert.equal(isCancelText('退出'), true);
  assert.equal(isCancelText('取消这个需求的评审'), false);
  assert.equal(isCancelText('算了，还是改吧'), false);
  assert.equal(isCancelText(''), false);
  assert.equal(isCancelText(null), false);
});

test('parseBitableLink：/base/ 直链（含 table 参数）', () => {
  const r = parseBitableLink('表在这 https://xx.feishu.cn/base/bascnAbC123?table=tblXyZ9&view=vew1 麻烦了');
  assert.equal(r.kind, 'base');
  assert.equal(r.appToken, 'bascnAbC123');
  assert.equal(r.tableId, 'tblXyZ9');
  assert.ok(r.url.startsWith('https://xx.feishu.cn/base/bascnAbC123'));
});

test('parseBitableLink：/base/ 无参数 → tableId null', () => {
  const r = parseBitableLink('https://xx.feishu.cn/base/bascnAbC123');
  assert.equal(r.kind, 'base');
  assert.equal(r.tableId, null);
});

test('parseBitableLink：wiki 链接抽 token；无链接/docx 链接返回 null', () => {
  const r = parseBitableLink('https://xx.feishu.cn/wiki/WikiTok123?table=tblA1');
  assert.equal(r.kind, 'wiki');
  assert.equal(r.token, 'WikiTok123');
  assert.equal(r.tableId, 'tblA1');
  assert.equal(parseBitableLink('没有链接'), null);
  assert.equal(parseBitableLink('https://xx.feishu.cn/docx/DocTok1'), null);
});

const FIELDS = [
  { field_name: '标题', ui_type: 'Text', is_primary: true },
  { field_name: '进展状态', ui_type: 'SingleSelect', property: { options: [{ name: '待处理' }, { name: '修复中' }, { name: '已修复' }] } },
  { field_name: '处理人', ui_type: 'User' },
  { field_name: '优先级', ui_type: 'SingleSelect', property: { options: [{ name: '高' }, { name: '低' }] } },
];

test('summarize/buildFieldMappingPrompt：字段与选项进入 prompt', () => {
  const lines = summarizeFieldsForMapping(FIELDS);
  assert.equal(lines.length, 4);
  assert.match(lines[1], /进展状态（SingleSelect；选项: 待处理 \/ 修复中 \/ 已修复）/);
  const prompt = buildFieldMappingPrompt(FIELDS);
  assert.match(prompt, /status_field/);
  assert.match(prompt, /处理人（User）/);
});

test('validateFieldMapping：合法映射通过并归一化字段名', () => {
  const v = validateFieldMapping(
    { status_field: '进展状态', pending_value: '待处理', fixing_value: '修复中', assignee_field: '处理人' },
    FIELDS,
  );
  assert.equal(v.ok, true);
  assert.equal(v.statusField, '进展状态');
  assert.equal(v.fixingValue, '修复中');
});

test('validateFieldMapping：字段不存在/选项不存在/人员字段类型不对/缺项 → 拒绝', () => {
  const base = { status_field: '进展状态', pending_value: '待处理', fixing_value: '修复中', assignee_field: '处理人' };
  assert.equal(validateFieldMapping(null, FIELDS).ok, false);
  assert.equal(validateFieldMapping({ ...base, status_field: '状态X' }, FIELDS).ok, false);
  assert.equal(validateFieldMapping({ ...base, pending_value: '不存在的选项' }, FIELDS).ok, false);
  assert.equal(validateFieldMapping({ ...base, fixing_value: '处理中' }, FIELDS).ok, false);
  assert.equal(validateFieldMapping({ ...base, assignee_field: '标题' }, FIELDS).ok, false);
  assert.equal(validateFieldMapping({ ...base, assignee_field: null }, FIELDS).ok, false);
});

test('validateFieldMapping：requireFixingValue:false 时 fixing_value 缺失/非法均放行（req-inspect 不回写表格，不需要「修复中」选项）', () => {
  const noFixing = { status_field: '进展状态', pending_value: '待处理', assignee_field: '处理人' };
  assert.equal(validateFieldMapping(noFixing, FIELDS).ok, false); // 默认（\10001）仍然必填，行为零影响
  assert.equal(validateFieldMapping(noFixing, FIELDS, { requireFixingValue: false }).ok, true);
  const badFixing = { ...noFixing, fixing_value: '不存在的选项' };
  assert.equal(validateFieldMapping(badFixing, FIELDS, { requireFixingValue: false }).ok, true);
});

test('validateFieldMapping：文本类状态字段（无 options）不校验选项值', () => {
  const fields = [
    { field_name: '状态', ui_type: 'Text' },
    { field_name: '处理人', ui_type: 'User' },
  ];
  const v = validateFieldMapping(
    { status_field: '状态', pending_value: '待处理', fixing_value: '修复中', assignee_field: '处理人' },
    fields,
  );
  assert.equal(v.ok, true);
});

test('primaryFieldName：is_primary 优先，缺失退第一个字段', () => {
  assert.equal(primaryFieldName(FIELDS), '标题');
  assert.equal(primaryFieldName([{ field_name: 'A' }, { field_name: 'B' }]), 'A');
  assert.equal(primaryFieldName([]), null);
});

test('buildStatusFilter：is 单值过滤', () => {
  assert.deepEqual(buildStatusFilter('进展状态', '待处理'), {
    conjunction: 'and',
    conditions: [{ field_name: '进展状态', operator: 'is', value: ['待处理'] }],
  });
});

test('cellText：多形态值归一化为字符串', () => {
  assert.equal(cellText('文本'), '文本');
  assert.equal(cellText(42), '42');
  assert.equal(cellText([{ type: 'text', text: '分段1' }, { type: 'text', text: '分段2' }]), '分段1、分段2');
  assert.equal(cellText([{ id: 'ou_1', name: '张三' }]), '张三');
  assert.equal(cellText(['高', '低']), '高、低');
  assert.equal(cellText(null), '');
  assert.equal(cellText({ text: 'obj' }), 'obj');
});

test('personOpenIds / isAssignedToMe：按 open_id 过滤「关于我的」', () => {
  const rec = { fields: { 处理人: [{ id: 'ou_me', name: '我' }, { id: 'ou_other', name: '别人' }] } };
  assert.deepEqual(personOpenIds(rec.fields['处理人']), ['ou_me', 'ou_other']);
  assert.equal(isAssignedToMe(rec, '处理人', 'ou_me'), true);
  assert.equal(isAssignedToMe(rec, '处理人', 'ou_none'), false);
  assert.equal(isAssignedToMe({ fields: {} }, '处理人', 'ou_me'), false);
  assert.equal(isAssignedToMe(rec, '处理人', ''), false);
});

test('recordTitle / buildRecordDetail：标题与 detail 拼装', () => {
  const rec = {
    record_id: 'recA1',
    fields: {
      标题: [{ type: 'text', text: '扫码页白屏' }],
      进展状态: '待处理',
      处理人: [{ id: 'ou_me', name: '我' }],
      描述: [{ type: 'text', text: '安卓13必现' }],
    },
  };
  assert.equal(recordTitle(rec, '标题'), '扫码页白屏');
  assert.equal(recordTitle({ fields: {} }, '标题'), '（未命名记录）');
  const detail = buildRecordDetail(rec, { tableName: 'BUG表', url: 'https://xx.feishu.cn/base/bascn1' });
  assert.match(detail, /标题：扫码页白屏/);
  assert.match(detail, /描述：安卓13必现/);
  assert.match(detail, /所在数据表：BUG表/);
  assert.match(detail, /记录ID：recA1/);
});

test('buildPatrolSummary：零命中 / 混合结果 / 跳过表', () => {
  assert.match(buildPatrolSummary({ mine: 0, fixed: [], rejected: [], failed: [], skippedTables: [] }), /没有找到分配给你的「待处理」BUG/);
  const s = buildPatrolSummary({
    mine: 3,
    fixed: [{ title: 'A' }],
    rejected: [{ title: 'B', reason: '非本项目' }],
    failed: [{ title: 'C', reason: '写表失败' }],
    skippedTables: [{ name: '表2', reason: '未识别出状态字段' }],
  });
  assert.match(s, /共 3 条/);
  assert.match(s, /转自动修复 1 条/);
  assert.match(s, /B — 非本项目/);
  assert.match(s, /C — 写表失败/);
  assert.match(s, /表2 — 未识别出状态字段/);
});

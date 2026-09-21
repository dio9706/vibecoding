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
  collectImageAttachments,
  filterUnseen,
  parseReqChoice,
  buildStartReply,
  buildReqChoicePrompt,
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

// —— 循环巡检（\10004 / 20min 待命复查）新增的纯函数 ——

test('filterUnseen：已判过的 recordId 被过滤掉（成本护栏）', () => {
  const records = [{ record_id: 'r1' }, { record_id: 'r2' }, { record_id: 'r3' }];
  const seen = { r1: { verdict: 'reject' }, r3: { verdict: 'fix', side: 'backend' } };
  assert.deepEqual(
    filterUnseen(records, seen).map((r) => r.record_id),
    ['r2'],
  );
});

test('filterUnseen：seen 为空/非法 → 原样返回（不吞记录）', () => {
  const records = [{ record_id: 'r1' }];
  assert.equal(filterUnseen(records, {}).length, 1);
  assert.equal(filterUnseen(records, null).length, 1);
  assert.equal(filterUnseen(records, 'bad').length, 1);
  assert.equal(filterUnseen(null, {}).length, 0);
});

test('parseReqChoice：解析 1-based 序号，越界/非数字返回 null', () => {
  assert.equal(parseReqChoice('2', 3), 1); // 返回 0-based 下标
  assert.equal(parseReqChoice(' 1 ', 3), 0);
  assert.equal(parseReqChoice('3', 3), 2);
  assert.equal(parseReqChoice('4', 3), null); // 越界
  assert.equal(parseReqChoice('0', 3), null);
  assert.equal(parseReqChoice('abc', 3), null);
  assert.equal(parseReqChoice('1个', 3), null); // 带尾字不认，避免把正文误判成选择
  assert.equal(parseReqChoice('', 3), null);
  assert.equal(parseReqChoice(null, 3), null);
});

test('buildStartReply：有需求名则回显，无则给出未关联说明', () => {
  const withReq = buildStartReply('订单中心改版');
  assert.match(withReq, /关联需求：订单中心改版/);
  assert.match(withReq, /每 20 分钟/);
  assert.match(withReq, /\\10004/);

  const without = buildStartReply(null);
  assert.doesNotMatch(without, /关联需求/);
  assert.match(without, /未找到测试期需求/);
  assert.match(without, /\\10004/); // 停止指令两种情况都要给
});

test('collectImageAttachments：只收 image/* 附件，按字段归类', () => {
  const rec = {
    fields: {
      流程佐证: [{ file_token: 'ft1', name: 'a.jpg', type: 'image/jpeg' }],
      优化后的UI: [
        { file_token: 'ft2', name: 'b.png', type: 'image/png' },
        { file_token: 'ft3', name: 'c.mp4', type: 'video/mp4' }, // 非图片，不收
      ],
    },
  };
  assert.deepEqual(collectImageAttachments(rec), [
    { field: '流程佐证', fileToken: 'ft1', name: 'a.jpg', type: 'image/jpeg' },
    { field: '优化后的UI', fileToken: 'ft2', name: 'b.png', type: 'image/png' },
  ]);
});

test('collectImageAttachments：人员/多选字段不会被误当附件（判据是 file_token）', () => {
  const rec = {
    fields: {
      处理人: [{ id: 'ou_x', name: '张三' }], // 人员字段：有 name 无 file_token
      标签: ['A', 'B'], // 多选：字符串数组
      文本: '普通文本',
      空附件: [],
    },
  };
  assert.deepEqual(collectImageAttachments(rec), []);
});

test('collectImageAttachments：空记录/畸形输入不抛错', () => {
  assert.deepEqual(collectImageAttachments(null), []);
  assert.deepEqual(collectImageAttachments({}), []);
  assert.deepEqual(collectImageAttachments({ fields: { x: [null, 42, 'str'] } }), []);
});

test('buildRecordDetail：带截图时给出路径并明确要求用 Read 查看', () => {
  const rec = { record_id: 'rec1', fields: { 问题描述: '按钮点不动' } };
  const s = buildRecordDetail(rec, {
    tableName: '测试表',
    images: [{ field: '流程佐证', path: 'C:/tmp/a.jpg' }],
  });
  assert.match(s, /【截图】/);
  assert.match(s, /Read 工具/);
  assert.match(s, /流程佐证：C:\/tmp\/a\.jpg/);
});

test('buildRecordDetail：无截图时不出现截图段（行为与改造前一致）', () => {
  const rec = { record_id: 'rec1', fields: { 问题描述: '按钮点不动' } };
  const s = buildRecordDetail(rec, { tableName: '测试表' });
  assert.doesNotMatch(s, /【截图】/);
  assert.match(s, /问题描述：按钮点不动/);
});

test('buildReqChoicePrompt：1-based 编号列出，未命名需求有占位', () => {
  const s = buildReqChoicePrompt([{ title: '需求A' }, { title: '' }]);
  assert.match(s, /找到 2 个/);
  assert.match(s, /1\. 需求A/);
  assert.match(s, /2\. （未命名需求）/);
  assert.match(s, /取消/);
});

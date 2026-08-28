/**
 * dialog payload 解析。
 *
 * 为什么这条重要：Claude 需要用户拍板时会调 AskUserQuestion 工具，CLI 据此向宿主发
 * request_user_dialog。宿主答不出来（parseDialog 返回 null → behavior:'cancelled'）时，
 * CLI 按 sdk.d.ts:3369 的约定 fail closed，把 dialog-gated 流程退化成 no-dialog 行为 ——
 * 表现就是 Claude 只能在正文里列「1. 2. 3.」让用户手打回答（2026-08-28 实测形态）。
 *
 * AskUserQuestionInput 的 schema（sdk-tools.d.ts:800）：
 *   questions[1-4] { question, header, options[2-4]{ label, description, preview? }, multiSelect? }
 * 旧实现只猜 p.options / p.choices / p.answers，认不出这层 questions 嵌套。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDialog } from './tool-summary.js';

/** 造一条最简 AskUserQuestion payload */
const askPayload = (over = {}) => ({
  questions: [
    {
      question: '状态放 Context 还是 Zustand？',
      header: '状态方案',
      options: [
        { label: 'Context', description: '零依赖，跨层更新会重渲染' },
        { label: 'Zustand', description: '选择性订阅，多一个依赖' },
      ],
      ...over,
    },
  ],
});

test('标准 AskUserQuestion payload → 解析出问句与带说明的选项', () => {
  const d = parseDialog({ dialogKind: 'ask_user_question', payload: askPayload() });
  assert.ok(d, '认不出就会被 cancelled，Claude 只能退回正文列 1.2.3.');
  assert.equal(d.title, '❓ 状态放 Context 还是 Zustand？');
  assert.equal(d.body, '', 'header 是 ≤12 字符的 chip 标签，当正文读是噪音；问句已在 title');
  assert.equal(d.options.length, 2);
  assert.deepEqual(
    d.options.map((o) => [o.id, o.label, o.desc]),
    [
      ['0', 'Context', '零依赖，跨层更新会重渲染'],
      ['1', 'Zustand', '选择性订阅，多一个依赖'],
    ],
  );
});

test('toResult 按 AskUserQuestionOutput 形状回传选中项的 label', () => {
  const d = parseDialog({ dialogKind: 'ask_user_question', payload: askPayload() });
  const out = d.toResult('1');
  assert.deepEqual(out.questions[0].answers, ['Zustand']);
  assert.equal(out.questions[0].question, '状态放 Context 还是 Zustand？', '原问题字段须原样带回');
  assert.equal(out.questions[0].header, '状态方案');
});

test('toResult 收到未知 id → 回落为该 id 原值，不抛', () => {
  const d = parseDialog({ dialogKind: 'ask_user_question', payload: askPayload() });
  assert.deepEqual(d.toResult('99').questions[0].answers, ['99']);
});

test('多问 payload → 只呈现第一问（不自攒队列，剩下的靠 CLI 下一轮再发）', () => {
  const payload = {
    questions: [
      { question: '第一问？', header: 'A', options: [{ label: 'a1', description: '' }, { label: 'a2', description: '' }] },
      { question: '第二问？', header: 'B', options: [{ label: 'b1', description: '' }, { label: 'b2', description: '' }] },
      { question: '第三问？', header: 'C', options: [{ label: 'c1', description: '' }, { label: 'c2', description: '' }] },
    ],
  };
  const d = parseDialog({ dialogKind: 'ask_user_question', payload });
  assert.equal(d.title, '❓ 第一问？');
  assert.deepEqual(d.options.map((o) => o.label), ['a1', 'a2']);
});

test('multiSelect 降级为单选（本轮不做多选，答一项也能让 Claude 继续）', () => {
  const d = parseDialog({ dialogKind: 'ask_user_question', payload: askPayload({ multiSelect: true }) });
  assert.equal(d.options.length, 2);
  assert.deepEqual(d.toResult('0').questions[0].answers, ['Context']);
});

test('option 缺 description → desc 为空串，不是 undefined（渲染层按真值判断是否加副行）', () => {
  const payload = { questions: [{ question: 'Q？', header: 'H', options: [{ label: 'x' }, { label: 'y' }] }] };
  const d = parseDialog({ dialogKind: 'ask_user_question', payload });
  assert.deepEqual(d.options.map((o) => o.desc), ['', '']);
});

test('questions 存在但 options 空/缺失 → 回落旧分支；两者都无 → null', () => {
  // options 空数组 + 无旧字段 → null
  assert.equal(parseDialog({ payload: { questions: [{ question: 'Q？', options: [] }] } }), null);
  // options 缺失但有旧式 p.options → 走旧分支
  const d = parseDialog({ payload: { questions: [{ question: 'Q？' }], options: ['甲', '乙'] } });
  assert.ok(d, '新分支不该把旧结构挡掉');
  assert.deepEqual(d.options.map((o) => o.label), ['甲', '乙']);
});

test('旧结构 p.options 行为不变（回归保护）', () => {
  const d = parseDialog({ dialogKind: 'x', payload: { question: '选一个', options: ['甲', '乙'] } });
  assert.equal(d.title, '❓ 选一个');
  assert.deepEqual(d.options.map((o) => o.label), ['甲', '乙']);
  assert.equal(d.toResult('0'), '甲', '旧分支的 toResult 回传原始选项，保持原契约');
});

test('questions 非数组 / payload 空 / 无 payload → null，不抛', () => {
  assert.equal(parseDialog({ payload: { questions: 'nope' } }), null);
  assert.equal(parseDialog({ payload: {} }), null);
  assert.equal(parseDialog({}), null);
});

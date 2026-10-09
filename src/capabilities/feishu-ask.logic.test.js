/**
 * feishu-ask.logic.js 的纯函数测试：目标解析 / 卡片 / 判定 prompt / 判定解析 / 转录格式化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAskCard,
  buildJudgePrompt,
  formatTranscript,
  normalizeRole,
  parseJudgeResult,
  resolveColleagueTarget,
  MAX_FOLLOW_UPS,
} from './feishu-ask.logic.js';

const ZHANG = { id: 'cl_z', role: 'backend', name: '张三', feishuOpenId: 'ou_zhang' };
const LI = { id: 'cl_l', role: 'backend', name: '李四', feishuOpenId: 'ou_li' };
const WANG = { id: 'cl_w', role: 'frontend', name: '王五', feishuOpenId: 'ou_wang' };
const ZHAO = { id: 'cl_zhao', role: 'product', name: '赵六', feishuOpenId: '' };
const ROSTER = [ZHANG, LI, WANG, ZHAO];

test('normalizeRole：id / label 都认，未知/空返回 null', () => {
  assert.equal(normalizeRole('backend'), 'backend');
  assert.equal(normalizeRole('后端'), 'backend');
  assert.equal(normalizeRole(' UI设计 '), 'design');
  assert.equal(normalizeRole('不存在'), null);
  assert.equal(normalizeRole(''), null);
  assert.equal(normalizeRole(undefined), null);
});

test('resolveColleagueTarget：按职位唯一命中', () => {
  const r = resolveColleagueTarget([ZHANG, WANG], { role: 'backend' });
  assert.equal(r.colleague.id, 'cl_z');
});

test('resolveColleagueTarget：中文职位同样可解析', () => {
  const r = resolveColleagueTarget(ROSTER, { role: '前端' });
  assert.equal(r.colleague.id, 'cl_w');
});

test('resolveColleagueTarget：同职位多人 → 要求用 name 指定，不替模型赌一个', () => {
  const r = resolveColleagueTarget(ROSTER, { role: 'backend' });
  assert.match(r.error, /多位/);
  assert.match(r.error, /张三/);
  assert.match(r.error, /李四/);
  assert.equal(resolveColleagueTarget(ROSTER, { role: 'backend', name: '李四' }).colleague.id, 'cl_l');
});

test('resolveColleagueTarget：缺 open_id 的目标单独报错（可定位到人）', () => {
  const r = resolveColleagueTarget(ROSTER, { role: 'product' });
  assert.match(r.error, /赵六/);
  assert.match(r.error, /open_id/);
});

test('resolveColleagueTarget：未知职位 / 没这个人 / 什么都没给', () => {
  assert.match(resolveColleagueTarget(ROSTER, { role: 'hr' }).error, /未知职位/);
  assert.match(resolveColleagueTarget(ROSTER, { name: '不存在的人' }).error, /没找到/);
  assert.match(resolveColleagueTarget(ROSTER, {}).error, /role 或 name/);
});

test('buildAskCard：含问题与补充背景，并带回复指引', () => {
  const card = buildAskCard({ question: '字段用哪个？', context: '接口报 500' });
  const text = JSON.stringify(card);
  assert.match(text, /字段用哪个？/);
  assert.match(text, /接口报 500/);
  assert.match(text, /直接回复本条消息/);
  assert.equal(card.header.title.tag, 'plain_text');
});

test('buildJudgePrompt：包含问题、同事名、对话记录与剩余预算', () => {
  const prompt = buildJudgePrompt({
    colleagueName: '张三',
    question: '订单号是哪个字段？',
    context: '接口返回里没找到',
    transcript: [
      { dir: 'out', text: '订单号是哪个字段？' },
      { dir: 'in', text: '应该是 order_no，我确认下', files: [{ name: '字段表.md' }] },
    ],
    followUps: 1,
    maxFollowUps: 3,
  });
  assert.match(prompt, /订单号是哪个字段？/);
  assert.match(prompt, /张三：应该是 order_no/);
  assert.match(prompt, /附件：字段表\.md/);
  assert.match(prompt, /还剩 2 次/);
  assert.match(prompt, /"done": true/);
});

test('parseJudgeResult：合法结果通过并 trim；缺关键字段视为无效', () => {
  assert.deepEqual(parseJudgeResult({ done: true, conclusion: ' 答案 ' }), { done: true, followUp: '', conclusion: '答案' });
  assert.deepEqual(parseJudgeResult({ done: false, followUp: ' 再问 ' }), { done: false, followUp: '再问', conclusion: '' });
  assert.equal(parseJudgeResult({ done: true }), null, 'done 但没结论 = 无效');
  assert.equal(parseJudgeResult({ done: false }), null, '未完成但没追问 = 无效');
  assert.equal(parseJudgeResult(null), null);
  assert.equal(parseJudgeResult('x'), null);
  assert.equal(parseJudgeResult([1]), null);
});

test('formatTranscript：区分双方、标注附件、超长截断', () => {
  const text = formatTranscript([
    { dir: 'out', text: '问题' },
    { dir: 'in', text: '回答', files: [{ name: 'a.md' }, { name: '' }] },
  ]);
  assert.match(text, /^助手：问题\n对方：回答（附件：a\.md）$/);

  const long = formatTranscript(
    Array.from({ length: 30 }, (_, i) => ({ dir: 'in', text: 'x'.repeat(100) + i })),
    { maxChars: 300 },
  );
  assert.match(long, /已截断/);
});

test('MAX_FOLLOW_UPS 是有限正整数（防无限叨扰同事的硬上限）', () => {
  assert.ok(Number.isInteger(MAX_FOLLOW_UPS) && MAX_FOLLOW_UPS > 0 && MAX_FOLLOW_UPS <= 5);
});

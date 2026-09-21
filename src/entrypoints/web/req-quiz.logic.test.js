import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuizPrompt, parseQuiz, answersToPromptPart, sanitizeAnswers,
  UNSURE_VALUE, QUIZ_MIN, QUIZ_MAX,
} from './req-quiz.logic.js';

const okQuiz = (n = 3) =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      id: 'Q' + (i + 1),
      title: '问题' + (i + 1),
      hint: '提示',
      why: '来源：需求文档',
      opts: [
        { v: 'a', lab: '选项 A', desc: '', guess: true },
        { v: 'b', lab: '选项 B', desc: '' },
      ],
    })),
  );

test('buildQuizPrompt 带上需求文档全文与工程角色', () => {
  const p = buildQuizPrompt({
    reqDocText: '要做批量导出',
    projects: { frontend: { dir: 'D:/web', dev: true }, backend: null },
  });
  assert.match(p, /要做批量导出/);
  assert.match(p, /D:\/web/);
  assert.match(p, /JSON/);
});

test('buildQuizPrompt 只写上限，并明示题数随规模缩放', () => {
  // 刻意不写下限：写了下限模型就会往那个锚点凑，小需求也硬出满额
  const p = buildQuizPrompt({ reqDocText: 'x', projects: {} });
  assert.match(p, new RegExp(String(QUIZ_MAX)));
  assert.match(p, /不凑数/);
  assert.match(p, /空数组/); // 「一个歧义都没有」必须有合法出口，否则模型只能硬编
});

test('parseQuiz 解析合法问卷', () => {
  const q = parseQuiz(okQuiz(3));
  assert.equal(q.length, 3);
  assert.equal(q[0].opts.length, 2);
});

test('parseQuiz 剥围栏', () => {
  assert.equal(parseQuiz('```json\n' + okQuiz(3) + '\n```').length, 3);
});

test('parseQuiz 只出 1 题也是合法问卷', () => {
  // 小需求就该少问；卡下限会把「克制」和「没找到」判成同一种结局
  assert.equal(parseQuiz(okQuiz(1)).length, 1);
  assert.equal(QUIZ_MIN, 1);
});

test('parseQuiz 空数组时抛错（降级信号）', () => {
  assert.throws(() => parseQuiz('[]'), /题数/);
});

test('parseQuiz 题数超上限时截断而不抛', () => {
  // 多问几题只是啰嗦，不值得让整条链路失败
  assert.equal(parseQuiz(okQuiz(QUIZ_MAX + 4)).length, QUIZ_MAX);
});

test('parseQuiz 丢弃选项不足 2 项的题', () => {
  const raw = JSON.parse(okQuiz(4));
  raw[0].opts = [{ v: 'a', lab: '只有一个', guess: true }];
  assert.equal(parseQuiz(JSON.stringify(raw)).length, 3);
});

test('parseQuiz 选项超 4 项时截断', () => {
  const raw = JSON.parse(okQuiz(3));
  raw[0].opts = ['a', 'b', 'c', 'd', 'e', 'f'].map((v) => ({ v, lab: v, guess: v === 'a' }));
  assert.equal(parseQuiz(JSON.stringify(raw))[0].opts.length, 4);
});

test('parseQuiz 无 guess 时把首项补为 AI 猜测', () => {
  // 「不选就按这个实现」是整个问卷的意义所在，缺了必须补，否则跳过语义就没了
  const raw = JSON.parse(okQuiz(3));
  raw[0].opts.forEach((o) => delete o.guess);
  const q = parseQuiz(JSON.stringify(raw));
  assert.equal(q[0].opts[0].guess, true);
});

test('parseQuiz 多个 guess 时只保留第一个', () => {
  const raw = JSON.parse(okQuiz(3));
  raw[0].opts.forEach((o) => (o.guess = true));
  const q = parseQuiz(JSON.stringify(raw));
  assert.deepEqual(q[0].opts.map((o) => !!o.guess), [true, false]);
});

test('parseQuiz 缺 id 时按序补齐且不重复', () => {
  const raw = JSON.parse(okQuiz(3));
  raw.forEach((q) => delete q.id);
  const ids = parseQuiz(JSON.stringify(raw)).map((q) => q.id);
  assert.equal(new Set(ids).size, 3);
});

test('parseQuiz 顶层不是数组时抛错', () => {
  assert.throws(() => parseQuiz('{"a":1}'), /数组/);
});

test('parseQuiz 所有题都不合格时抛错', () => {
  // 单题不合格只丢单题，全丢光才等同「没找出东西」，走降级
  const raw = JSON.parse(okQuiz(3));
  raw[0].opts = [];
  raw[1].opts = [];
  raw[2].title = '';
  assert.throws(() => parseQuiz(JSON.stringify(raw)), /题数/);
});

// ---- sanitizeAnswers（草稿保存与定稿提交共用）----

const quizOf = (n = 3) => ({ questions: parseQuiz(okQuiz(n)) });

test('sanitizeAnswers 保留合法作答并截断补充说明', () => {
  const out = sanitizeAnswers(quizOf(2), { Q1: { v: 'b', note: 'x'.repeat(50) } }, 10);
  assert.deepEqual(out, { Q1: { v: 'b', note: 'x'.repeat(10) } });
});

test('sanitizeAnswers 放行「不确定」', () => {
  const out = sanitizeAnswers(quizOf(2), { Q1: { v: UNSURE_VALUE, note: '' } }, 100);
  assert.equal(out.Q1.v, UNSURE_VALUE);
});

test('sanitizeAnswers 丢弃不存在的题与不存在的选项', () => {
  const out = sanitizeAnswers(quizOf(2), { Q9: { v: 'a' }, Q1: { v: '不存在' } }, 100);
  assert.deepEqual(out, {});
});

test('sanitizeAnswers 丢弃「只写补充不选项」', () => {
  // 逃生口是「不确定」而不是留空，否则绕过接口就能提交半份问卷
  const out = sanitizeAnswers(quizOf(2), { Q1: { v: '', note: '我再想想' } }, 100);
  assert.deepEqual(out, {});
});

test('sanitizeAnswers 对任何脏形状都不抛错', () => {
  const q = quizOf(2);
  for (const bad of [null, undefined, 'x', 42, [], { Q1: null }, { Q1: { v: 7 } }]) {
    assert.deepEqual(sanitizeAnswers(q, bad, 100), {});
  }
  assert.deepEqual(sanitizeAnswers(null, { Q1: { v: 'a' } }, 100), {});
});

test('sanitizeAnswers 允许部分作答（草稿态的立足点）', () => {
  // 定稿的「必答」校验在路由层做；本函数不判完整性，否则草稿就存不下半份答案
  const out = sanitizeAnswers(quizOf(3), { Q2: { v: 'a', note: '' } }, 100);
  assert.deepEqual(Object.keys(out), ['Q2']);
});

// ---- answersToPromptPart ----

const quiz3 = {
  questions: parseQuiz(okQuiz(3)),
  answers: { Q1: { v: 'b', note: '顺便把 CSV 砍了' } },
};

test('answersToPromptPart 用户已答的取用户选项', () => {
  const s = answersToPromptPart(quiz3);
  assert.match(s, /选项 B/);
  assert.match(s, /顺便把 CSV 砍了/);
});

test('answersToPromptPart 未答的落到 AI 猜测项并显式标注', () => {
  const s = answersToPromptPart(quiz3);
  assert.match(s, /选项 A/);
  assert.match(s, /未作答/);
});

test('answersToPromptPart 无问卷时返回空串', () => {
  assert.equal(answersToPromptPart(null), '');
  assert.equal(answersToPromptPart({ questions: [] }), '');
});

// ---- 「不确定」选项（必答规则下的逃生口）----

test('answersToPromptPart 选「不确定」落到猜测项，措辞区别于未作答', () => {
  const s = answersToPromptPart({
    questions: parseQuiz(okQuiz(3)),
    answers: { Q1: { v: UNSURE_VALUE, note: '' } },
  });
  assert.match(s, /明确表示不确定/);
  // 不能复用「未作答」措辞：用户看过题目才选的不确定，和压根没答不是一回事，
  // 模型遇到冲突时的取舍权重不同
  assert.doesNotMatch(s.split('\n')[1], /未作答/);
});

test('answersToPromptPart 选「不确定」但写了补充时补充仍要进 prompt', () => {
  const s = answersToPromptPart({
    questions: parseQuiz(okQuiz(3)),
    answers: { Q1: { v: UNSURE_VALUE, note: '得问下设计，跟旧版有关' } },
  });
  assert.match(s, /明确表示不确定/);
  assert.match(s, /得问下设计，跟旧版有关/);
});

test('answersToPromptPart 保留「未作答」分支以兼容历史数据', () => {
  // 必答规则只约束新提交；已落盘的 answered 问卷仍可能缺题，删掉分支会让老数据渲染出错
  const s = answersToPromptPart({ questions: parseQuiz(okQuiz(3)), answers: {} });
  assert.match(s, /未作答/);
  assert.doesNotMatch(s, /明确表示不确定/);
});

// ---- buildQuizPrompt 注入 prime ----

test('buildQuizPrompt 注入用户背景并要求不重复提问', () => {
  const p = buildQuizPrompt({ reqDocText: '需求正文', projects: {}, primeText: '旧版本地筛选卡死过' });
  assert.match(p, /旧版本地筛选卡死过/);
  assert.match(p, /不要再问/);
});

test('buildQuizPrompt 无 prime 时不产出空背景节', () => {
  const p = buildQuizPrompt({ reqDocText: '需求正文', projects: {} });
  assert.doesNotMatch(p, /用户已补充的背景/);
});

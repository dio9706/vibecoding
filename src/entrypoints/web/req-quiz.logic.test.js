import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuizPrompt, parseQuiz, answersToPromptPart, UNSURE_VALUE, QUIZ_MIN, QUIZ_MAX } from './req-quiz.logic.js';

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

test('buildQuizPrompt 把题数上下限写进契约', () => {
  const p = buildQuizPrompt({ reqDocText: 'x', projects: {} });
  assert.match(p, new RegExp(String(QUIZ_MIN)));
  assert.match(p, new RegExp(String(QUIZ_MAX)));
});

test('parseQuiz 解析合法问卷', () => {
  const q = parseQuiz(okQuiz(3));
  assert.equal(q.length, 3);
  assert.equal(q[0].opts.length, 2);
});

test('parseQuiz 剥围栏', () => {
  assert.equal(parseQuiz('```json\n' + okQuiz(3) + '\n```').length, 3);
});

test('parseQuiz 题数不足下限时抛错', () => {
  assert.throws(() => parseQuiz(okQuiz(1)), /题数/);
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

test('parseQuiz 有效题数不足下限时抛错', () => {
  const raw = JSON.parse(okQuiz(3));
  raw[1].opts = [];
  raw[2].title = '';
  assert.throws(() => parseQuiz(JSON.stringify(raw)), /题数/);
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

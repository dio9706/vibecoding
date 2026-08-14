import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExtractionInput, hasExplicitPhrasing, attributeTurn } from './prefilter.js';

const e = (over = {}) => ({
  at: 1000, text: '随便说点什么', source: 'web', kind: 'send',
  convId: 'c1', sessionId: 's1', cwd: 'C:/proj', model: 'sonnet', ...over,
});

test('hasExplicitPhrasing：命中下规矩措辞才算显式，普通提问不算', () => {
  assert.equal(hasExplicitPhrasing('以后注释一律用中文'), true);
  assert.equal(hasExplicitPhrasing('记住，不许自动提交'), true);
  assert.equal(hasExplicitPhrasing('帮我看下这个函数'), false);
  assert.equal(hasExplicitPhrasing(''), false);
  assert.equal(hasExplicitPhrasing(null), false);
});

test('按 convId 分组，组内保持落盘（时间）顺序 —— LLM 要看到同一次对话里的连续表达', () => {
  const { sessions } = buildExtractionInput([
    e({ at: 1, convId: 'c1', text: '先做方案' }),
    e({ at: 2, convId: 'c2', text: '另一个对话里的话' }),
    e({ at: 3, convId: 'c1', text: '再动手' }),
  ]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, 'c1');
  assert.deepEqual(sessions[0].turns.map((t) => t.text), ['先做方案', '再动手']);
  assert.equal(sessions[1].id, 'c2');
});

test('convId 缺失时回落 sessionId；两者都缺的归入同一未知组 —— 组 id 不能为空串，否则 promote 的跨会话计数会整条丢掉', () => {
  const { sessions } = buildExtractionInput([
    e({ at: 1, convId: null, sessionId: 's9', text: '只有 sessionId' }),
    e({ at: 2, convId: null, sessionId: null, text: '什么都没有' }),
  ]);
  assert.equal(sessions[0].id, 's9');
  assert.ok(sessions[1].id, '未知会话也必须有个非空 id');
  assert.notEqual(sessions[1].id, '');
});

test('steer（插话打断）被如实标注 —— 用户打断说明 AI 走偏了，是高价值信号', () => {
  const { sessions } = buildExtractionInput([
    e({ at: 1, kind: 'send', text: '帮我改下登录页' }),
    e({ at: 2, kind: 'steer', text: '停，别动那个文件' }),
  ]);
  assert.equal(sessions[0].turns[0].kind, 'send');
  assert.equal(sessions[0].turns[1].kind, 'steer');
});

test('命中显式措辞的条目标 explicit=true，其余 false —— 正则只决定标记，不再决定去留', () => {
  const { sessions, used } = buildExtractionInput([
    e({ at: 1, text: '以后注释一律用中文' }),
    e({ at: 2, text: '让 AI 越用越懂我，并且可以导出' }),
  ]);
  assert.equal(used, 2, '未命中正则的决断式表达也必须留下，不能像旧预筛器那样被丢掉');
  assert.equal(sessions[0].turns[0].explicit, true);
  assert.equal(sessions[0].turns[1].explicit, false);
});

test('单条超长输入截断并标记，原始入参不被修改', () => {
  const long = 'X'.repeat(5000);
  const entries = [e({ text: long })];
  const snapshot = JSON.parse(JSON.stringify(entries));
  const { sessions } = buildExtractionInput(entries, { maxEntryChars: 100 });
  assert.equal(sessions[0].turns[0].text.length, 100);
  assert.equal(sessions[0].turns[0].truncated, true);
  assert.deepEqual(entries, snapshot, '预筛是纯函数：原始日志条目一个字都不能改');
});

test('超出字符预算时优先保留 explicit / steer，并如实报告丢弃数 —— 不许静默丢', () => {
  const { sessions, used, dropped } = buildExtractionInput([
    e({ at: 1, kind: 'send', text: '一二三四五' }),
    e({ at: 2, kind: 'steer', text: '六七八九十' }),
    e({ at: 3, kind: 'send', text: '记住甲乙丙' }),
  ], { maxChars: 10 });
  assert.equal(used, 2);
  assert.equal(dropped, 1);
  assert.deepEqual(sessions[0].turns.map((t) => t.text), ['六七八九十', '记住甲乙丙'],
    '入选后必须还原成时间顺序：优先级只用于挑选，不该把对话顺序打乱');
});

test('条目数上限同样如实报告丢弃数', () => {
  const { used, dropped } = buildExtractionInput([e({ at: 1 }), e({ at: 2 }), e({ at: 3 })], { maxEntries: 2 });
  assert.equal(used, 2);
  assert.equal(dropped, 1);
});

test('空白/畸形条目被剔除且不抛异常', () => {
  const { sessions, used, dropped } = buildExtractionInput([
    null, {}, e({ text: '   \n ' }), e({ text: 123 }), e({ at: 9, text: '真话' }),
  ]);
  assert.equal(used, 1);
  assert.equal(dropped, 0, '本来就不是用户说的话，不算「丢弃」——否则告警会天天喊狼来了');
  assert.equal(sessions[0].turns[0].text, '真话');
});

test('会话的 cwd 取该会话最后一条非空 cwd —— 提炼时要靠它判 project scope', () => {
  const { sessions } = buildExtractionInput([
    e({ at: 1, cwd: null, text: '第一句' }),
    e({ at: 2, cwd: 'C:/a', text: '第二句' }),
  ]);
  assert.equal(sessions[0].cwd, 'C:/a');
});

test('畸形入参一律得到空结果，不抛错', () => {
  assert.deepEqual(buildExtractionInput(null), { sessions: [], used: 0, dropped: 0, chars: 0 });
  assert.deepEqual(buildExtractionInput([]).sessions, []);
});

// —— attributeTurn：把 LLM 回吐的 quote 归位到具体会话 ——
// 一次提炼跨多个会话，但 promote.js 的核心不变量是「跨 >=2 个不同 session」；
// 若整批候选共用一个 sessionId，同一天里两次独立对话说的同一条偏好会被算成一次证据，永远晋升不了。

test('attributeTurn：按 quote 逐字回溯到所在会话，并带回该行的 explicit 标记', () => {
  const { sessions } = buildExtractionInput([
    e({ at: 1, convId: 'c1', cwd: 'C:/a', text: '让我先看方案再动手' }),
    e({ at: 2, convId: 'c2', cwd: 'C:/b', text: '以后注释一律用中文' }),
  ]);
  const hit = attributeTurn('以后注释一律用中文', sessions);
  assert.equal(hit.sessionId, 'c2');
  assert.equal(hit.explicit, true);
  assert.equal(hit.cwd, 'C:/b');

  const hit2 = attributeTurn('让我先看方案再动手', sessions);
  assert.equal(hit2.sessionId, 'c1');
  assert.equal(hit2.explicit, false);
});

test('attributeTurn：quote 只是原话的一部分（LLM 常这么干）也能归位；空白差异忽略', () => {
  const { sessions } = buildExtractionInput([e({ at: 1, convId: 'c7', text: '这次先出方案，  别直接改代码' })]);
  assert.equal(attributeTurn('别直接改代码', sessions).sessionId, 'c7');
  assert.equal(attributeTurn('先出方案，别直接改代码', sessions).sessionId, 'c7', '空白差异不该导致归位失败');
});

test('attributeTurn：过短或对不上的 quote 返回 null，不冒认 —— 认错会话比不认更糟（证据记到别的会话头上）', () => {
  const { sessions } = buildExtractionInput([e({ at: 1, convId: 'c1', text: '以后注释一律用中文' })]);
  assert.equal(attributeTurn('以后', sessions), null, '两三个字的 quote 满地都是，不足以定位');
  assert.equal(attributeTurn('完全没说过的一句话', sessions), null);
  assert.equal(attributeTurn('', sessions), null);
  assert.equal(attributeTurn('以后注释一律用中文', null), null);
});

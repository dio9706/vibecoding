import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, sanitizeCandidates, EXTRACT_SYSTEM_PROMPT, extractFromSessions } from './extract.js';

/** 提炼输入 = prefilter.buildExtractionInput 的 sessions 形状 */
const turn = (over = {}) => ({ at: 1000, kind: 'send', explicit: false, text: '注释写中文', truncated: false, ...over });
const session = (over = {}) => ({ id: 'c1', cwd: 'C:/proj', turns: [turn()], ...over });

test('buildPrompt 含工程目录、会话分组与用户原话', () => {
  const p = buildPrompt([session()], { cwd: 'C:/proj' });
  assert.match(p, /注释写中文/);
  assert.match(p, /C:\/proj/, '要给出工程路径，模型才能判 scope');
  assert.match(p, /会话/, '要分组，模型才看得出哪些话出自同一次对话');
});

test('buildPrompt 明确标注 steer（插话打断）—— 用户打断说明 AI 走偏了，这是最高价值的信号', () => {
  const p = buildPrompt([session({ turns: [turn({ kind: 'steer', text: '停，别动那个文件' })] })], { cwd: 'C:/proj' });
  assert.match(p, /插话/);
  assert.match(p, /停，别动那个文件/);
  // 标记的含义必须写在提示里，否则模型只看见一个不认识的词
  assert.match(p, /打断/);
});

test('buildPrompt 标注显式规矩措辞，让模型据此填 source', () => {
  const p = buildPrompt([session({ turns: [turn({ explicit: true, text: '以后注释一律用中文' })] })], { cwd: 'C:/proj' });
  assert.match(p, /明示/);
});

test('buildPrompt 逐个会话给出各自的工程目录 —— 一次提炼跨多个工程时，scope 判定要靠它', () => {
  const p = buildPrompt([
    session({ id: 'c1', cwd: 'C:/a', turns: [turn({ text: '甲工程的话' })] }),
    session({ id: 'c2', cwd: 'C:/b', turns: [turn({ text: '乙工程的话' })] }),
  ], { cwd: 'C:/a' });
  assert.match(p, /C:\/b/);
});

test('系统提示词写死「宁缺毋滥」与禁空话约束', () => {
  assert.match(EXTRACT_SYSTEM_PROMPT.custom, /空数组/);
  assert.match(EXTRACT_SYSTEM_PROMPT.custom, /逐字/);
});

test('系统提示词必须交代新的信号模型：偏好不限于「纠正」，指令式/决策式/约束式表达同样算', () => {
  assert.match(EXTRACT_SYSTEM_PROMPT.custom, /不.*只.*纠正|不必是.*纠正|不限于.*纠正/,
    '旧提示词假设输入是「用户纠正 AI 的片段」，真实数据里用户是决断式表达，一句纠正都没有');
});

test('系统提示词必须要求忽略无关闲聊与一次性任务指令，禁止硬凑', () => {
  assert.match(EXTRACT_SYSTEM_PROMPT.custom, /忽略/);
  assert.match(EXTRACT_SYSTEM_PROMPT.custom, /一次性/, '「把这个函数改成 async」是任务不是偏好');
  assert.match(EXTRACT_SYSTEM_PROMPT.custom, /凑/, '新输入里大部分是日常对话，必须明说不许凑数');
});

test('sanitizeCandidates 丢弃缺字段的条目', () => {
  const out = sanitizeCandidates({ items: [
    { category: 'code-style', statement: 'A', fingerprint: 'f1' },
    { category: 'code-style', statement: '', fingerprint: 'f2' },
    { statement: 'C', fingerprint: 'f3' },
    { category: 'code-style', statement: 'D' },
  ] }, { cwd: 'C:/proj', sessionId: 's1' });
  assert.equal(out.length, 1);
  assert.equal(out[0].statement, 'A');
});

test('sanitizeCandidates 拒绝未知 category', () => {
  const out = sanitizeCandidates({ items: [
    { category: 'vibes', statement: 'A', fingerprint: 'f1' },
  ] }, { cwd: 'C:/proj', sessionId: 's1' });
  assert.deepEqual(out, []);
});

test('sanitizeCandidates 回填 sessionId/projectDir，scope 非 project 时清空 projectDir', () => {
  const out = sanitizeCandidates({ items: [
    { category: 'code-style', statement: 'A', fingerprint: 'f1', scope: 'project' },
    { category: 'code-style', statement: 'B', fingerprint: 'f2', scope: 'global', projectDir: 'C:/x' },
  ] }, { cwd: 'C:/proj', sessionId: 's9' });
  assert.equal(out[0].projectDir, 'C:/proj');
  assert.equal(out[0].sessionId, 's9');
  assert.equal(out[1].projectDir, '', 'global 条目不得带 projectDir');
});

test('sanitizeCandidates：非法/空返回值一律得到空数组，不抛错', () => {
  const ctx = { cwd: 'C:/proj', sessionId: 's1' };
  assert.deepEqual(sanitizeCandidates(null, ctx), []);
  assert.deepEqual(sanitizeCandidates({}, ctx), []);
  assert.deepEqual(sanitizeCandidates({ items: 'nope' }, ctx), []);
});

test('sanitizeCandidates 截断超长 statement，防污染注入预算', () => {
  const out = sanitizeCandidates({ items: [
    { category: 'code-style', statement: 'X'.repeat(500), fingerprint: 'f1' },
  ] }, { cwd: 'C:/proj', sessionId: 's1' });
  assert.ok(out[0].statement.length <= 200);
});

// —— quote 归位：一次提炼跨多个会话，证据必须落到各自会话头上 ——

test('sanitizeCandidates 按 quote 把候选归位到出处会话，并用该会话的 cwd 作 projectDir', () => {
  const sessions = [
    session({ id: 'c1', cwd: 'C:/a', turns: [turn({ text: '让我先看方案再动手' })] }),
    session({ id: 'c2', cwd: 'C:/b', turns: [turn({ text: '以后注释一律用中文', explicit: true })] }),
  ];
  const out = sanitizeCandidates({ items: [
    { category: 'code-style', statement: '注释用中文', fingerprint: 'f1', scope: 'project', quote: '以后注释一律用中文' },
  ] }, { cwd: 'C:/别的目录', sessionId: 'batch', sessions });
  assert.equal(out[0].sessionId, 'c2', '证据必须记到 quote 真正出自的会话上');
  assert.equal(out[0].projectDir, 'C:/b', 'project scope 要落到那次对话所在的工程，而不是提炼进程的 cwd');
});

test('归位成功时 source 以正则标记为准 —— 模型说 explicit 也不算数，误标一条就跳过了全部晋升把关', () => {
  const sessions = [session({ id: 'c1', turns: [turn({ text: '让我先看方案再动手', explicit: false })] })];
  const out = sanitizeCandidates({ items: [
    { category: 'collaboration', statement: '先给方案再动手', fingerprint: 'f1', source: 'explicit', quote: '让我先看方案再动手' },
  ] }, { cwd: 'C:/proj', sessionId: 'batch', sessions });
  assert.equal(out[0].source, 'inferred');
});

test('归位失败（quote 对不上任何原话）时回落到传入的 sessionId 与模型给的 source，不静默丢条目', () => {
  const sessions = [session({ id: 'c1', turns: [turn({ text: '让我先看方案再动手' })] })];
  const out = sanitizeCandidates({ items: [
    { category: 'code-style', statement: 'A', fingerprint: 'f1', source: 'explicit', quote: '模型自己编的一句话' },
  ] }, { cwd: 'C:/proj', sessionId: 'batch', sessions });
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, 'batch');
  assert.equal(out[0].source, 'explicit');
});

// —— extractFromSessions 的返回契约：null（调用失败）与 []（正常无产出）不可混同 ——
// 全部通过 _runner 注入假实现，绝不触达真实 runClassifierOnce / LLM，防止单测烧用户额度。

test('底层调用失败（_runner 返回 null，对应超时/额度耗尽/解析不出）时，extractFromSessions 必须返回 null，而不是 []', async () => {
  const fakeRunner = async () => null;
  const out = await extractFromSessions([session()], { cwd: 'C:/proj', sessionId: 's1', _runner: fakeRunner });
  assert.equal(out, null, '调用失败必须能与「正常但无产出」区分开，否则调用方无法决定是否推进游标');
});

test('调用成功但模型判定确实提炼不出偏好（_runner 返回 {items:[]}）时，extractFromSessions 返回 []', async () => {
  const fakeRunner = async () => ({ items: [] });
  const out = await extractFromSessions([session()], { cwd: 'C:/proj', sessionId: 's1', _runner: fakeRunner });
  assert.deepEqual(out, [], '正常无产出属成功路径，必须与调用失败的 null 区分开');
});

test('调用成功且有产出时，extractFromSessions 透传 sanitizeCandidates 的结果', async () => {
  const fakeRunner = async () => ({ items: [
    { category: 'code-style', statement: '注释写中文', fingerprint: 'code-style:注释语言' },
  ] });
  const out = await extractFromSessions([session()], { cwd: 'C:/proj', sessionId: 's1', _runner: fakeRunner });
  assert.equal(out.length, 1);
  assert.equal(out[0].statement, '注释写中文');
});

test('会话为空 / 会话里没有任何一句话时直接返回 []，不发起任何调用（_runner 不会被调用）', async () => {
  let called = false;
  const fakeRunner = async () => { called = true; return null; };
  assert.deepEqual(await extractFromSessions([], { cwd: 'C:/proj', sessionId: 's1', _runner: fakeRunner }), []);
  assert.deepEqual(
    await extractFromSessions([session({ turns: [] })], { cwd: 'C:/proj', sessionId: 's1', _runner: fakeRunner }),
    [],
    '一个空会话也是「没话可提炼」，不该白烧一次额度',
  );
  assert.equal(called, false, '无内容时不该发起 LLM 调用');
});

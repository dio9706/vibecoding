import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINDING_TYPES, buildAnalysisPrompt, sanitizeFindings, analyzeSession } from './analyze.js';

// 只测纯函数与依赖注入路径；analyzeSession 用 _runner 注入避免真实 LLM 调用（烧额度）。

// ──────────────────────────────────────────────
// buildAnalysisPrompt
// ──────────────────────────────────────────────

test('buildAnalysisPrompt：空输入仍返回包含分析要求的字符串', () => {
  const prompt = buildAnalysisPrompt('');
  assert.ok(typeof prompt === 'string');
  assert.ok(prompt.includes('findings'));
  assert.ok(prompt.includes('bug'));
  assert.ok(prompt.includes('solution'));
  assert.ok(prompt.includes('pattern'));
  assert.ok(prompt.includes('preference'));
});

test('buildAnalysisPrompt：null 输入不抛错', () => {
  assert.doesNotThrow(() => buildAnalysisPrompt(null));
  assert.doesNotThrow(() => buildAnalysisPrompt(undefined));
});

test('buildAnalysisPrompt：正确解析 user/assistant 消息', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: '请帮我修复这个 bug' } }),
    JSON.stringify({ type: 'assistant', message: { content: '好的，问题在第 42 行' } }),
  ];
  const prompt = buildAnalysisPrompt(lines.join('\n'));
  assert.ok(prompt.includes('[User] 请帮我修复这个 bug'));
  assert.ok(prompt.includes('[Assistant] 好的，问题在第 42 行'));
});

test('buildAnalysisPrompt：content 为 content-block 数组时提取 text 类型', () => {
  const lines = [
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'text', text: '这是文本内容' },
          { type: 'tool_result', content: '工具结果应被忽略' },
        ],
      },
    }),
  ];
  const prompt = buildAnalysisPrompt(lines.join('\n'));
  assert.ok(prompt.includes('这是文本内容'));
  assert.ok(!prompt.includes('工具结果应被忽略'));
});

test('buildAnalysisPrompt：跳过非 user/assistant 类型的行', () => {
  const lines = [
    JSON.stringify({ type: 'system', message: { content: '系统消息' } }),
    JSON.stringify({ type: 'tool_use', message: { content: '工具调用' } }),
    JSON.stringify({ type: 'user', message: { content: '用户消息' } }),
  ];
  const prompt = buildAnalysisPrompt(lines.join('\n'));
  assert.ok(!prompt.includes('系统消息'));
  assert.ok(!prompt.includes('工具调用'));
  assert.ok(prompt.includes('用户消息'));
});

test('buildAnalysisPrompt：跳过空内容的行', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: '   ' } }),
    JSON.stringify({ type: 'user', message: { content: '' } }),
    JSON.stringify({ type: 'user', message: { content: '有效内容' } }),
  ];
  const prompt = buildAnalysisPrompt(lines.join('\n'));
  assert.ok(prompt.includes('有效内容'));
  // 空白行不应产生 [User] 条目（除了最后那条有效的）
  const userMatches = (prompt.match(/\[User\]/g) || []).length;
  assert.equal(userMatches, 1);
});

test('buildAnalysisPrompt：超过 8000 字符时截断并添加提示', () => {
  // 构造超长内容
  const longText = 'x'.repeat(9000);
  const lines = [JSON.stringify({ type: 'user', message: { content: longText } })];
  const prompt = buildAnalysisPrompt(lines.join('\n'));
  assert.ok(prompt.includes('...（内容已截断）'));
});

test('buildAnalysisPrompt：跳过 JSON 格式非法的行', () => {
  const input = 'not json\n' + JSON.stringify({ type: 'user', message: { content: '合法行' } });
  assert.doesNotThrow(() => buildAnalysisPrompt(input));
  const prompt = buildAnalysisPrompt(input);
  assert.ok(prompt.includes('合法行'));
});

// ──────────────────────────────────────────────
// sanitizeFindings
// ──────────────────────────────────────────────

test('sanitizeFindings：null / undefined 返回空数组', () => {
  assert.deepEqual(sanitizeFindings(null), []);
  assert.deepEqual(sanitizeFindings(undefined), []);
});

test('sanitizeFindings：findings 不是数组时返回空数组', () => {
  assert.deepEqual(sanitizeFindings({}), []);
  assert.deepEqual(sanitizeFindings({ findings: 'not-array' }), []);
  assert.deepEqual(sanitizeFindings({ findings: null }), []);
});

test('sanitizeFindings：空数组原样返回', () => {
  assert.deepEqual(sanitizeFindings({ findings: [] }), []);
});

test('sanitizeFindings：非法 type 的条目被过滤', () => {
  const json = {
    findings: [
      { type: 'invalid', summary: '非法类型', detail: '' },
      { type: 'bug', summary: '合法类型', detail: '' },
    ],
  };
  const result = sanitizeFindings(json);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'bug');
});

test('sanitizeFindings：summary 为空的条目被过滤', () => {
  const json = {
    findings: [
      { type: 'bug', summary: '', detail: '有 detail 但没 summary' },
      { type: 'solution', summary: '   ', detail: '' },
      { type: 'pattern', summary: '有效 summary', detail: '' },
    ],
  };
  const result = sanitizeFindings(json);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'pattern');
});

test('sanitizeFindings：所有合法 FINDING_TYPES 均通过', () => {
  const json = {
    findings: FINDING_TYPES.map((type) => ({ type, summary: `${type} 测试`, detail: '' })),
  };
  const result = sanitizeFindings(json);
  assert.equal(result.length, FINDING_TYPES.length);
  assert.deepEqual(
    result.map((r) => r.type),
    FINDING_TYPES,
  );
});

test('sanitizeFindings：summary 超过 200 字符时截断', () => {
  const json = {
    findings: [{ type: 'bug', summary: 'x'.repeat(300), detail: '' }],
  };
  const result = sanitizeFindings(json);
  assert.equal(result[0].summary.length, 200);
});

test('sanitizeFindings：detail 超过 500 字符时截断', () => {
  const json = {
    findings: [{ type: 'solution', summary: '有效', detail: 'y'.repeat(600) }],
  };
  const result = sanitizeFindings(json);
  assert.equal(result[0].detail.length, 500);
});

test('sanitizeFindings：detail 可选，缺失时返回空字符串', () => {
  const json = { findings: [{ type: 'preference', summary: '偏好描述' }] };
  const result = sanitizeFindings(json);
  assert.equal(result[0].detail, '');
});

test('sanitizeFindings：非对象条目被跳过', () => {
  const json = {
    findings: [null, undefined, 'string', 42, { type: 'pattern', summary: '合法' }],
  };
  const result = sanitizeFindings(json);
  assert.equal(result.length, 1);
});

// ──────────────────────────────────────────────
// analyzeSession
// ──────────────────────────────────────────────

test('analyzeSession：transcript 为空时直接返回 []', async () => {
  const result = await analyzeSession('');
  assert.deepEqual(result, []);
});

test('analyzeSession：transcript 为 null 时直接返回 []', async () => {
  const result = await analyzeSession(null);
  assert.deepEqual(result, []);
});

test('analyzeSession：transcript 少于 100 字符时直接返回 []，不调 runner', async () => {
  let called = false;
  const runner = async () => { called = true; return null; };
  const result = await analyzeSession('短内容', { _runner: runner });
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test('analyzeSession：_runner 返回合法 findings 时正常返回', async () => {
  const mockResult = {
    findings: [
      { type: 'bug', summary: '发现了一个空指针问题', detail: '在第 42 行未做 null 检查' },
    ],
  };
  const runner = async () => mockResult;
  const transcript = JSON.stringify({ type: 'user', message: { content: '发现 bug：空指针' } }).repeat(5) + '\n'.repeat(10) + 'x'.repeat(50);
  const result = await analyzeSession(transcript, { _runner: runner });
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'bug');
  assert.equal(result[0].summary, '发现了一个空指针问题');
});

test('analyzeSession：_runner 返回空 findings 时返回 []', async () => {
  const runner = async () => ({ findings: [] });
  const transcript = 'x'.repeat(200);
  const result = await analyzeSession(transcript, { _runner: runner });
  assert.deepEqual(result, []);
});

test('analyzeSession：_runner 返回 null 时 analyzeSession 返回 null', async () => {
  const runner = async () => null;
  const transcript = 'x'.repeat(200);
  const result = await analyzeSession(transcript, { _runner: runner });
  assert.equal(result, null);
});

test('analyzeSession：_runner 接收到正确的 model 参数', async () => {
  let receivedOpts = null;
  const runner = async (opts) => { receivedOpts = opts; return { findings: [] }; };
  const transcript = 'x'.repeat(200);
  await analyzeSession(transcript, { model: 'test-model', _runner: runner });
  assert.equal(receivedOpts.model, 'test-model');
  assert.equal(receivedOpts.logTag, 'memory-bank/analyze');
});

test('analyzeSession：默认使用 config.intent.classifyModel', async () => {
  let receivedOpts = null;
  const runner = async (opts) => { receivedOpts = opts; return { findings: [] }; };
  const transcript = 'x'.repeat(200);
  await analyzeSession(transcript, { _runner: runner });
  // 只验证 model 字段存在且是非空字符串
  assert.ok(typeof receivedOpts.model === 'string' && receivedOpts.model.length > 0);
});

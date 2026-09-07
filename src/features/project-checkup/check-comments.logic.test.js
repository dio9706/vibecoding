import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSampleFiles, extractCommentBlocks, buildPayload, evaluateComments, SAMPLE_SIZE } from './check-comments.logic.js';

test('抽样上限是 30', () => {
  assert.equal(SAMPLE_SIZE, 30);
});

test('按修改时间倒序取前 N 个', () => {
  const files = [
    { path: 'a.js', mtime: 100 },
    { path: 'b.js', mtime: 300 },
    { path: 'c.js', mtime: 200 },
  ];
  assert.deepEqual(pickSampleFiles(files, 2).map((f) => f.path), ['b.js', 'c.js']);
});

test('排除测试文件与构建产物', () => {
  const files = [
    { path: 'src/a.js', mtime: 5 },
    { path: 'src/a.test.js', mtime: 9 },
    { path: 'src/__tests__/b.js', mtime: 8 },
    { path: 'dist/c.js', mtime: 7 },
    { path: 'src/d.min.js', mtime: 6 },
    { path: 'node_modules/e.js', mtime: 10 },
  ];
  assert.deepEqual(pickSampleFiles(files, 10).map((f) => f.path), ['src/a.js']);
});

test('只取源码扩展名', () => {
  const files = [
    { path: 'a.js', mtime: 3 },
    { path: 'b.md', mtime: 4 },
    { path: 'c.json', mtime: 5 },
    { path: 'd.vue', mtime: 2 },
  ];
  assert.deepEqual(pickSampleFiles(files, 10).map((f) => f.path).sort(), ['a.js', 'd.vue']);
});

test('提取行注释及紧邻代码', () => {
  const src = 'const a = 1;\n// 把 b 设为 2\nconst b = 2;\nconst c = 3;\n';
  const blocks = extractCommentBlocks(src);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].line, 2);
  assert.ok(blocks[0].comment.includes('把 b 设为 2'));
  assert.ok(blocks[0].context.includes('const b = 2;'));
});

test('连续行注释合并成一块', () => {
  const src = '// 第一行\n// 第二行\nconst a = 1;\n';
  const blocks = extractCommentBlocks(src);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].comment.includes('第一行'));
  assert.ok(blocks[0].comment.includes('第二行'));
});

test('提取块注释', () => {
  const src = '/**\n * 说明文字\n */\nfunction f() {}\n';
  const blocks = extractCommentBlocks(src);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].comment.includes('说明文字'));
});

test('每个文件最多取 10 处', () => {
  const src = Array.from({ length: 20 }, (_, i) => `// 注释${i}\nconst v${i} = ${i};`).join('\n');
  assert.equal(extractCommentBlocks(src).length, 10);
});

test('没有注释时返回空', () => {
  assert.deepEqual(extractCommentBlocks('const a = 1;\n'), []);
});

test('URL 里的 // 不当注释', () => {
  const src = 'const u = "https://example.com/x";\n';
  assert.deepEqual(extractCommentBlocks(src), []);
});

test('组装载荷并按上限截断', () => {
  const files = [
    { path: 'a.js', blocks: [{ line: 1, comment: '// x', context: 'const a=1' }] },
    { path: 'b.js', blocks: [{ line: 2, comment: '// y', context: 'const b=2' }] },
  ];
  const p = buildPayload(files, 10000);
  assert.ok(p.text.includes('a.js'));
  assert.ok(p.text.includes('b.js'));
  assert.equal(p.truncated, false);
});

test('超长载荷会被截断并标记', () => {
  const files = Array.from({ length: 50 }, (_, i) => ({
    path: `f${i}.js`,
    blocks: [{ line: 1, comment: '// ' + 'x'.repeat(300), context: 'code' }],
  }));
  const p = buildPayload(files, 1000);
  assert.equal(p.truncated, true);
  assert.ok(p.text.length <= 1200); // 允许少量越界，但不能失控
});

test('按问题密度判分', () => {
  // 30 个文件出 5 个问题：100 - (5/30)*60 = 90
  const r = evaluateComments({ sampledFiles: 30, findings: Array.from({ length: 5 }, () => ({ type: 'restates-code', file: 'a.js', line: 1, message: 'm' })) });
  assert.equal(r.score, 90);
  assert.equal(r.status, 'done');
  assert.equal(r.issues.length, 5);
});

test('零问题给满分', () => {
  const r = evaluateComments({ sampledFiles: 30, findings: [] });
  assert.equal(r.score, 100);
});

test('findings 为 null 表示 LLM 未完成，标 partial', () => {
  const r = evaluateComments({ sampledFiles: 30, findings: null });
  assert.equal(r.status, 'partial');
  assert.equal(r.score, null);
});

test('没有可抽样文件时标 na', () => {
  const r = evaluateComments({ sampledFiles: 0, findings: [] });
  assert.equal(r.status, 'na');
  assert.equal(r.score, null);
});

test('注释类问题标为可自动修（走带测试闸的重构策略）', () => {
  // 原断言是 fixable:false，理由是「改注释要动源码，改错了比不改更误导人」。
  // 现在 llm-refactor 补上了当初缺的那道保证：改前测试全绿 → 改完重跑 → 红了回滚该文件，
  // 项目没有可跑的测试时整个策略降级为只出清单。「改错了」有机制发现了，所以放行
  const r = evaluateComments({ sampledFiles: 10, findings: [{ type: 'stale', file: 'a.js', line: 3, message: 'm' }] });
  assert.equal(r.issues[0].fixable, true);
});

// —— verdictLog：判定层可审计 ——
// 只有 restates-code / stale / dead-code 会变成 issue，判为 ok 的连同模型给的 reason 一起被丢弃。
// 后果是出现「0 个问题」这种结果时，无法区分「模型认真判了且都合格」和「模型摆烂 / 漏判了大半」。
// verdictLog 把全部判定原样留档，不产 issue、不扣分，纯供事后审计与回归对比。

test('verdictLog 记录全部判定，含判为 ok 的那些', () => {
  const r = evaluateComments({
    sampledFiles: 10,
    findings: [{ type: 'restates-code', file: 'a.js', line: 1, message: 'm' }],
    blocks: [
      { file: 'a.js', line: 1, comment: '// 把 b 设为 2' },
      { file: 'a.js', line: 5, comment: '// 这里必须先等 uid，否则校验会串号' },
      { file: 'b.js', line: 9, comment: '// const old = 1;' },
    ],
    verdicts: [
      { file: 'a.js', line: 1, verdict: 'restates-code', reason: 'r1' },
      { file: 'a.js', line: 5, verdict: 'ok', reason: 'r2' },
      { file: 'b.js', line: 9, verdict: 'dead-code', reason: 'r3' },
    ],
  });
  assert.equal(r.verdictLog.length, 3);
  assert.deepEqual(r.verdictLog.map((v) => v.verdict), ['restates-code', 'ok', 'dead-code']);
  // ok 不产 issue：issues 只来自 findings
  assert.equal(r.issues.length, 1);
});

test('verdictLog 每条带注释原文与理由，按 file#line 精确回锚', () => {
  const r = evaluateComments({
    sampledFiles: 10,
    findings: [],
    blocks: [
      { file: 'a.js', line: 47, comment: '来自 a 的注释' },
      { file: 'b.js', line: 47, comment: '来自 b 的注释' },
    ],
    verdicts: [
      { file: 'a.js', line: 47, verdict: 'ok', reason: 'ra' },
      { file: 'b.js', line: 47, verdict: 'ok', reason: 'rb' },
    ],
  });
  const a = r.verdictLog.find((v) => v.file === 'a.js');
  const b = r.verdictLog.find((v) => v.file === 'b.js');
  assert.equal(a.text, '来自 a 的注释');
  assert.equal(a.reason, 'ra');
  assert.equal(b.text, '来自 b 的注释');
  assert.equal(b.reason, 'rb');
});

test('verdictLog 截断超长文本，避免 optimize.json 膨胀', () => {
  const r = evaluateComments({
    sampledFiles: 10,
    findings: [],
    blocks: [{ file: 'a.js', line: 1, comment: 'x'.repeat(500) }],
    verdicts: [{ file: 'a.js', line: 1, verdict: 'ok', reason: 'y'.repeat(800) }],
  });
  assert.ok(r.verdictLog[0].text.length <= 200);
  assert.ok(r.verdictLog[0].reason.length <= 300);
});

test('没有判定时 verdictLog 为空数组', () => {
  const r = evaluateComments({ sampledFiles: 10, findings: [] });
  assert.deepEqual(r.verdictLog, []);
});

test('verdictLog 不影响 score', () => {
  const r = evaluateComments({
    sampledFiles: 10,
    findings: [],
    blocks: [{ file: 'a.js', line: 1, comment: 'c1' }, { file: 'a.js', line: 2, comment: 'c2' }],
    verdicts: [
      { file: 'a.js', line: 1, verdict: 'ok', reason: 'r' },
      { file: 'a.js', line: 2, verdict: 'ok', reason: 'r' },
    ],
  });
  assert.equal(r.score, 100); // 两条都判 ok，一分不扣
  assert.equal(r.verdictLog.length, 2);
});

test('partial 与 na 也带 verdictLog 字段（恒为空数组）', () => {
  // 调用方不必对不同 status 分支写两套取值逻辑
  assert.deepEqual(evaluateComments({ sampledFiles: 10, findings: null }).verdictLog, []);
  assert.deepEqual(evaluateComments({ sampledFiles: 0, findings: [] }).verdictLog, []);
});

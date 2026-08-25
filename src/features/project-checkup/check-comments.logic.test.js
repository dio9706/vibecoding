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

test('注释类问题不可自动修复', () => {
  const r = evaluateComments({ sampledFiles: 10, findings: [{ type: 'stale', file: 'a.js', line: 3, message: 'm' }] });
  assert.equal(r.issues[0].fixable, false);
});

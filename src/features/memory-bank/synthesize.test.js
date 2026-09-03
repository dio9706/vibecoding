/**
 * synthesize.js 单测
 * 覆盖：buildSynthesisPrompt / sanitizeMemories / synthesizeMemories
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildSynthesisPrompt, sanitizeMemories, synthesizeMemories, MEMORY_CATEGORIES } from './synthesize.js';
import { writeBank, readBank, EMPTY_BANK } from '../../store/memory-bank.js';

// ── buildSynthesisPrompt ──────────────────────────────────────────────────────

describe('buildSynthesisPrompt', () => {
  it('空输入：返回包含格式要求的字符串', () => {
    const result = buildSynthesisPrompt([]);
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('memories'));
    assert.ok(result.includes('category'));
    assert.ok(result.includes('statement'));
    // 包含合法分类列表
    assert.ok(result.includes('collaboration'));
    assert.ok(result.includes('code-style'));
    assert.ok(result.includes('tech-pref'));
  });

  it('null 输入：不抛错，返回包含格式要求的字符串', () => {
    const result = buildSynthesisPrompt(null);
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('memories'));
  });

  it('有 findings 时：包含摘要内容', () => {
    const findings = [
      { type: 'preference', summary: '用户偏好 TypeScript', detail: '项目中始终使用 TS' },
      { type: 'pattern', summary: '测试文件与源文件同目录' },
    ];
    const result = buildSynthesisPrompt(findings);
    assert.ok(result.includes('用户偏好 TypeScript'));
    assert.ok(result.includes('测试文件与源文件同目录'));
    assert.ok(result.includes('项目中始终使用 TS'));
    // 应包含 findings 序号
    assert.ok(result.includes('[1]'));
    assert.ok(result.includes('[2]'));
  });

  it('findings 条数在 prompt 中标注', () => {
    const findings = [{ type: 'bug', summary: 'bug 描述' }];
    const result = buildSynthesisPrompt(findings);
    assert.ok(result.includes('1 条 findings'));
  });
});

// ── sanitizeMemories ──────────────────────────────────────────────────────────

describe('sanitizeMemories', () => {
  it('null 输入返回 []', () => {
    assert.deepEqual(sanitizeMemories(null), []);
  });

  it('undefined 输入返回 []', () => {
    assert.deepEqual(sanitizeMemories(undefined), []);
  });

  it('memories 非数组返回 []', () => {
    assert.deepEqual(sanitizeMemories({ memories: 'not-array' }), []);
    assert.deepEqual(sanitizeMemories({ memories: 42 }), []);
    assert.deepEqual(sanitizeMemories({}), []);
  });

  it('非法 category 的条目被过滤', () => {
    const result = sanitizeMemories({
      memories: [
        { category: 'invalid-cat', statement: '有效语句' },
        { category: 'code-style', statement: '有效语句' },
      ],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].category, 'code-style');
  });

  it('statement 为空的条目被过滤', () => {
    const result = sanitizeMemories({
      memories: [
        { category: 'writing', statement: '' },
        { category: 'writing', statement: '   ' },
        { category: 'dialogue', statement: '有效的对话规则' },
      ],
    });
    assert.equal(result.length, 1);
  });

  it('所有合法 category 均被接受', () => {
    const memories = MEMORY_CATEGORIES.map((cat) => ({
      category: cat,
      statement: `测试 ${cat}`,
    }));
    const result = sanitizeMemories({ memories });
    assert.equal(result.length, MEMORY_CATEGORIES.length);
  });

  it('statement 超 300 字符时截断', () => {
    const long = 'x'.repeat(400);
    const result = sanitizeMemories({
      memories: [{ category: 'tech-pref', statement: long }],
    });
    assert.equal(result[0].statement.length, 300);
  });

  it('reasoning 超 300 字符时截断', () => {
    const long = 'r'.repeat(400);
    const result = sanitizeMemories({
      memories: [{ category: 'collaboration', statement: '规则', reasoning: long }],
    });
    assert.equal(result[0].reasoning.length, 300);
  });

  it('reasoning 可选，缺失时为空字符串', () => {
    const result = sanitizeMemories({
      memories: [{ category: 'collaboration', statement: '规则' }],
    });
    assert.equal(result[0].reasoning, '');
  });

  it('valid 条目正常通过，字段完整', () => {
    const result = sanitizeMemories({
      memories: [
        { category: 'code-style', statement: '使用双引号', reasoning: '项目历史惯例' },
      ],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].category, 'code-style');
    assert.equal(result[0].statement, '使用双引号');
    assert.equal(result[0].reasoning, '项目历史惯例');
  });

  it('非对象条目被跳过', () => {
    const result = sanitizeMemories({
      memories: [null, 42, 'string', { category: 'dialogue', statement: '有效' }],
    });
    assert.equal(result.length, 1);
  });
});

// ── synthesizeMemories ────────────────────────────────────────────────────────

describe('synthesizeMemories', () => {
  before(() => {
    // 初始化空 bank，避免上轮测试数据污染
    writeBank({ ...EMPTY_BANK });
  });

  it('findings 为空数组时直接返回 []，不调 runner', async () => {
    let called = false;
    const mockRunner = async () => { called = true; return null; };
    const result = await synthesizeMemories([], { _runner: mockRunner });
    assert.deepEqual(result, []);
    assert.equal(called, false);
  });

  it('findings 为 null 时直接返回 []，不调 runner', async () => {
    let called = false;
    const mockRunner = async () => { called = true; return null; };
    const result = await synthesizeMemories(null, { _runner: mockRunner });
    assert.deepEqual(result, []);
    assert.equal(called, false);
  });

  it('_runner 返回 null 时返回 null', async () => {
    const findings = [{ type: 'preference', summary: '用户喜欢简洁代码' }];
    const mockRunner = async () => null;
    const result = await synthesizeMemories(findings, { _runner: mockRunner });
    assert.equal(result, null);
  });

  it('_runner 返回合法 JSON 时写入 bank 并返回 memory 数组', async () => {
    // 初始化干净 bank
    writeBank({ ...EMPTY_BANK });

    const findings = [
      { type: 'preference', summary: '偏好函数式风格', detail: '用 map/filter 代替 for' },
    ];
    const mockRunner = async () => ({
      memories: [
        { category: 'code-style', statement: '使用函数式风格，map/filter 代替 for 循环', reasoning: '用户一贯偏好' },
      ],
    });

    const result = await synthesizeMemories(findings, { _runner: mockRunner });

    // 返回值应是 memory 数组
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    const m = result[0];
    assert.equal(m.category, 'code-style');
    assert.ok(m.statement.includes('函数式'));
    assert.ok(typeof m.id === 'string');
    assert.ok(m.id.startsWith('mem_'));
    assert.ok(typeof m.createdAt === 'number');
    assert.equal(m.source, 'synthesized');

    // 已写入 bank
    const bank = readBank();
    const found = bank.memories.find((mem) => mem.id === m.id);
    assert.ok(found, 'memory 应已写入 bank');
  });

  it('_runner 返回多条 memory，非法条目被过滤，合法条目写入', async () => {
    writeBank({ ...EMPTY_BANK });

    const findings = [{ type: 'pattern', summary: '测试驱动开发' }];
    const mockRunner = async () => ({
      memories: [
        { category: 'invalid', statement: '应被过滤' },
        { category: 'tech-pref', statement: '使用 node:test 而非 jest' },
        { category: 'collaboration', statement: '' }, // 空 statement，过滤
        { category: 'writing', statement: '注释解释为什么而非是什么' },
      ],
    });

    const result = await synthesizeMemories(findings, { _runner: mockRunner });

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 2);
    assert.ok(result.some((m) => m.category === 'tech-pref'));
    assert.ok(result.some((m) => m.category === 'writing'));

    const bank = readBank();
    assert.equal(bank.memories.length, 2);
  });
});

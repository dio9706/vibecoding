/**
 * synthesize.js 单测
 * 覆盖：buildSynthesisPrompt / sanitizeMemories / synthesizeMemories / batchSessionsForSynthesis
 *
 * ⚠️ 本文件的 synthesizeMemories 用例会**真实写 bank**（那是它的被测行为）。
 * 必须先把 APP_DATA_DIR 指向临时目录、再动态 import 被测模块 —— store/index.js 在模块加载时
 * 就读定 DATA_DIR，静态 import 会来不及。曾经漏了这一步：`npm test` 把用户桌面版的生产记忆库
 * （1500+ 会话索引）整份清空，并留下两条 mock statement 冒充真记忆，事后无从分辨。
 * 写 bank 的测试一律照 store/memory-bank.test.js 这么隔离。
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'membank-synth-'));
const { buildSynthesisPrompt, sanitizeMemories, synthesizeMemories, MEMORY_CATEGORIES,
  batchSessionsForSynthesis, BATCH_MAX_CHARS, MAX_BATCHES_PER_RUN } = await import('./synthesize.js');
const { writeBank, readBank, EMPTY_BANK } = await import('../../store/memory-bank.js');

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

  // ── 提炼门槛（2026-09-18）────────────────────────────────────────────────
  // 实测 56 条产出里约 4 条是业界通识（DRY/KISS/极简主义）、37 条是项目专属技术细节。
  // 通识零信息量却照样吃注入预算，把真正能改变行为的条目挤出截断线。

  it('含负面清单，点名拒绝业界通识与一次性决策', () => {
    const p = buildSynthesisPrompt([{ type: 'preference', summary: 'x' }]);
    assert.ok(p.includes('不要产出'), '应有显式的负面清单');
    assert.ok(/DRY|KISS|SOLID/.test(p), '应点名通识作为反例，否则模型分不清什么算"通识"');
    assert.ok(p.includes('一次性'), '应拒绝做完就过期的一次性决策');
  });

  it('含正面判据：只收模型默认不会这么做的条目', () => {
    const p = buildSynthesisPrompt([{ type: 'preference', summary: 'x' }]);
    assert.ok(/反直觉|默认不会/.test(p));
  });

  it('要求输出 explicit 与 strength 字段', () => {
    const p = buildSynthesisPrompt([{ type: 'preference', summary: 'x' }]);
    assert.ok(p.includes('"explicit"'));
    assert.ok(p.includes('"strength"'));
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

  // ── 注入排序字段（2026-09-18）──────────────────────────────────────────────

  it('归一 explicit 与 strength，非法值与缺失一律兜底', () => {
    const out = sanitizeMemories({
      memories: [
        { category: 'collaboration', statement: 'a', explicit: true, strength: 'strong' },
        { category: 'code-style', statement: 'b' },                                  // 缺字段
        { category: 'writing', statement: 'c', explicit: 'yes', strength: 'HUGE' },  // 非法值
        { category: 'dialogue', statement: 'd', explicit: false, strength: 'normal' },
      ],
    });
    assert.equal(out.length, 4);
    assert.deepEqual([out[0].explicit, out[0].evidenceCount], [true, 3]);
    assert.deepEqual([out[1].explicit, out[1].evidenceCount], [false, 1]);
    // 'yes' 不是布尔真值：宽松解析会把推断条目误升成「用户明说的」，挤掉真正的硬性要求
    assert.deepEqual([out[2].explicit, out[2].evidenceCount], [false, 1]);
    assert.deepEqual([out[3].explicit, out[3].evidenceCount], [false, 1]);
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

  it('existingStatements 透传进 prompt，供模型自行去重', async () => {
    writeBank({ ...EMPTY_BANK });
    let seen = '';
    const mockRunner = async ({ prompt }) => { seen = prompt; return { memories: [] }; };
    await synthesizeMemories([{ type: 'pattern', summary: 'x' }], {
      _runner: mockRunner,
      existingStatements: ['已经记住的老规则'],
    });
    assert.ok(seen.includes('已经记住的老规则'));
  });

  it('写入的 memory 带全套注入排序字段', async () => {
    writeBank({ ...EMPTY_BANK });
    const mockRunner = async () => ({
      memories: [{ category: 'collaboration', statement: '明说的规矩', explicit: true, strength: 'strong' }],
    });
    const got = await synthesizeMemories([{ type: 'preference', summary: 'x' }], { _runner: mockRunner });

    assert.equal(got.length, 1);
    const m = got[0];
    // 缺了这几个字段，render 的 weight() 对所有条目算出同一个值，
    // 「哪 40 条进 CLAUDE.md」就退化成数组下标顺序
    assert.equal(m.explicit, true);
    assert.equal(m.evidenceCount, 3);
    assert.equal(m.status, 'active');
    assert.equal(m.inject, true);
    assert.equal(typeof m.lastSeenAt, 'number');
    assert.ok(m.lastSeenAt > 0);

    // 落盘的那份也要带上，否则重启后排序依据就丢了
    const stored = readBank().memories.find((x) => x.id === m.id);
    assert.equal(stored.explicit, true);
    assert.equal(stored.evidenceCount, 3);
  });
});

// ── batchSessionsForSynthesis ────────────────────────────────────────────────

describe('batchSessionsForSynthesis', () => {
  /** 造一个 findings 字符数约为 chars 的 session */
  const mkSession = (id, chars, extra = {}) => ({
    id,
    findings: [{ type: 'pattern', summary: 'x'.repeat(Math.max(1, chars)) }],
    ...extra,
  });

  it('非数组输入返回 []，不抛错', () => {
    assert.deepEqual(batchSessionsForSynthesis(null), []);
    assert.deepEqual(batchSessionsForSynthesis(undefined), []);
    assert.deepEqual(batchSessionsForSynthesis('nope'), []);
  });

  it('跳过 findings 为空的 session', () => {
    const batches = batchSessionsForSynthesis([
      { id: 'a', findings: [] },
      { id: 'b', findings: null },
      mkSession('c', 10),
    ]);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].sessionIds, ['c']);
  });

  it('跳过已合成过的 session（synthesizedAt 有值）', () => {
    const batches = batchSessionsForSynthesis([
      mkSession('done', 10, { synthesizedAt: 123 }),
      mkSession('todo', 10),
    ]);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].sessionIds, ['todo']);
  });

  it('超出字符预算时切成多批，findings 不跨批', () => {
    // 预算 300 ≈ 容得下两个 session（每个 100 字符正文 + 渲染壳开销），第三个溢出到下一批
    const batches = batchSessionsForSynthesis(
      [mkSession('a', 100), mkSession('b', 100), mkSession('c', 100)],
      { maxChars: 300, maxBatches: 10 }
    );
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[0].sessionIds, ['a', 'b']);
    assert.deepEqual(batches[1].sessionIds, ['c']);
    // 每条 finding 恰好归属一个批，不重不漏
    const all = batches.flatMap((b) => b.findings);
    assert.equal(all.length, 3);
  });

  it('受 maxBatches 限制：一轮只推进有限批，剩下的留给下轮', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => mkSession(`s${i}`, 100));
    const batches = batchSessionsForSynthesis(sessions, { maxChars: 150, maxBatches: 2 });
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[0].sessionIds, ['s0']);
    assert.deepEqual(batches[1].sessionIds, ['s1']);
  });

  it('单个 session 独自超预算时仍自成一批，不会被永久卡住', () => {
    const batches = batchSessionsForSynthesis([mkSession('huge', 1000)], { maxChars: 100 });
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].sessionIds, ['huge']);
  });

  it('默认预算下，全量存量规模的输入不会产出超预算的批', () => {
    // 回归 2026-09-09 事故：6081 条 findings 一次性送出 → ~71 万 token，限额 20 万
    const sessions = Array.from({ length: 1258 }, (_, i) => mkSession(`s${i}`, 700));
    const batches = batchSessionsForSynthesis(sessions);
    assert.ok(batches.length <= MAX_BATCHES_PER_RUN, '单轮批数受限');
    for (const b of batches) {
      const chars = b.findings.reduce((a, f) => a + String(f.summary || '').length + String(f.detail || '').length, 0);
      assert.ok(chars <= BATCH_MAX_CHARS * 1.2, `单批字符数 ${chars} 应在预算内`);
    }
  });
});

// ── 调用预算与工作目录 ────────────────────────────────────────────────────────
// 2026-09-18 事故：Phase 2 自 9/10 起 83 次调用、成功 0 次，全部卡在 30s 预算上。
// 实测一批（4.4 万字符 prompt）需 51.5s；放宽后同一批一次产出 20 条 memories。

describe('synthesizeMemories 的调用预算', () => {
  it('用自己的超时预算，不吃 llm-classify 的 30s 默认', async () => {
    let seen = null;
    const runner = async (opts) => { seen = opts; return { memories: [] }; };
    await synthesizeMemories([{ type: 'preference', summary: 's' }], { _runner: runner });
    assert.equal(typeof seen.timeoutMs, 'number');
    assert.ok(seen.timeoutMs >= 90_000, `预算 ${seen.timeoutMs}ms 跑不完一批合成`);
  });

  it('传干净 cwd，避免 SDK 加载项目 CLAUDE.md / skills / MCP', async () => {
    let seen = null;
    const runner = async (opts) => { seen = opts; return { memories: [] }; };
    await synthesizeMemories([{ type: 'preference', summary: 's' }], { _runner: runner });
    assert.equal(typeof seen.cwd, 'string');
    assert.ok(seen.cwd.length > 0, '必须显式指定 cwd，否则落到 server 进程的项目根目录');
  });
});

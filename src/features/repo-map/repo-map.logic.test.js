/**
 * repo-map.logic.js 纯函数测试：查询词/标识符、引用与入度、排序（含查询加权）、预算裁剪、格式化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BUDGET_CHARS,
  computeInDegree,
  computeRefs,
  extractQueryTerms,
  extractTokens,
  formatRepoMap,
  queryBoost,
  rankFiles,
  splitIdentifier,
} from './repo-map.logic.js';

// ---------- 查询词 / 标识符 ----------

test('splitIdentifier：camelCase / snake_case / kebab 拆成小写词', () => {
  assert.deepEqual(splitIdentifier('repoMap'), ['repo', 'map']);
  assert.deepEqual(splitIdentifier('user_id'), ['user', 'id']);
  assert.deepEqual(splitIdentifier('repo-map'), ['repo', 'map']);
  assert.deepEqual(splitIdentifier('HTTPServer'), ['httpserver']); // 连续大写不拆（与常见口径一致）
});

test('extractQueryTerms：拆词、去重、滤停用词、限长；纯中文 → 空', () => {
  const terms = extractQueryTerms('Fix createRun bug in repo-map logic');
  assert.ok(terms.includes('create') && terms.includes('run') && terms.includes('map'));
  assert.ok(!terms.includes('the') && !terms.includes('in'));
  assert.deepEqual(extractQueryTerms('把登录流程修复一下，看看为什么会失败'), []);
  assert.deepEqual(extractQueryTerms('the and for with'), []);
  const many = extractQueryTerms('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi', { max: 5 });
  assert.equal(many.length, 5);
});

test('extractTokens：唯一化并受上限约束', () => {
  const toks = extractTokens('const a = 1; function b(a) { return a; }');
  assert.deepEqual([...toks].sort(), ['a', 'b', 'const', 'function', 'return']);
  const capped = extractTokens(Array.from({ length: 50 }, (_, i) => `v${i}`).join(' '), { max: 10 });
  assert.equal(capped.length, 10);
});

// ---------- 引用 / 入度 ----------

test('computeRefs：按文件集合计引用、排除自身；只有测试引用时标 refsFromTestsOnly', () => {
  const files = {
    'src/core.js': { symbols: [{ name: 'createCore', kind: 'function', line: 1, decl: 'x' }], tokens: ['createCore'] },
    'src/use.js': { symbols: [{ name: 'useCore', kind: 'function', line: 2, decl: 'y' }], tokens: ['createCore', 'useCore'] },
    'src/core.test.js': { symbols: [], tokens: ['createCore'] },
  };
  const refs = computeRefs(files);
  assert.equal(refs['src/core.js'][0].refs, 2, 'use.js + test 各算一次（文件集合）');
  assert.equal(refs['src/core.js'][0].refsFromTestsOnly, false);
  assert.equal(refs['src/use.js'][0].refs, 0, '只有自己持有 useCore → 0');

  const onlyTest = {
    'src/x.js': { symbols: [{ name: 'xSym', kind: 'const', line: 1, decl: 'z' }], tokens: ['xSym'] },
    'tests/x.test.js': { symbols: [], tokens: ['xSym'] },
  };
  assert.equal(computeRefs(onlyTest)['src/x.js'][0].refsFromTestsOnly, true);
});

test('computeInDegree：import 目标解析（去扩展名/去 index）、去重、排除自身', () => {
  const files = {
    'src/core.js': { imports: [], symbols: [], tokens: [] },
    'src/util/index.js': { imports: [], symbols: [], tokens: [] },
    'src/use.js': { imports: ['src/core', 'src/util'], symbols: [], tokens: [] },
    'src/use2.js': { imports: ['src/core.js', 'src/core'], symbols: [], tokens: [] },
    'src/self.js': { imports: ['src/self'], symbols: [], tokens: [] },
  };
  const deg = computeInDegree(files);
  assert.equal(deg['src/core.js'], 2, '两条边来自两个文件；use2 里重复 import 只算一次');
  assert.equal(deg['src/util/index.js'], 1, '/index 也能被解析到');
  assert.equal(deg['src/self.js'], 0, '自引用不计');
});

// ---------- 排序 ----------

test('rankFiles：引用度 + 入度决定排序；同分按路径稳定', () => {
  const files = {
    'src/a.js': { symbols: [{ name: 'aSym', kind: 'const', line: 1, decl: 'a' }], tokens: ['aSym'], imports: [] },
    'src/b.js': { symbols: [{ name: 'bSym', kind: 'const', line: 1, decl: 'b' }], tokens: ['bSym', 'aSym'], imports: [] },
    'src/c.js': { symbols: [{ name: 'cSym', kind: 'const', line: 1, decl: 'c' }], tokens: ['cSym'], imports: [] },
  };
  const rows = rankFiles(files);
  assert.equal(rows[0].rel, 'src/a.js', '被 b 引用一次 → 最高');
  // b/c 同为 0 分 → 路径字典序
  assert.deepEqual(rows.slice(1).map((r) => r.rel), ['src/b.js', 'src/c.js']);
});

test('rankFiles：查询加权能翻转同分顺序，且路径段命中加权', () => {
  const files = {
    'src/alpha.js': { symbols: [{ name: 'alphaThing', kind: 'const', line: 1, decl: 'a' }], tokens: ['alphaThing'], imports: [] },
    'src/beta.js': { symbols: [{ name: 'betaThing', kind: 'const', line: 1, decl: 'b' }], tokens: ['betaThing'], imports: [] },
  };
  assert.equal(rankFiles(files)[0].rel, 'src/alpha.js', '无查询 → 路径序');
  const boosted = rankFiles(files, { queryTerms: ['beta'] });
  assert.equal(boosted[0].rel, 'src/beta.js');
  assert.ok(boosted[0].boost > 0);

  const byPath = rankFiles(files, { queryTerms: ['alpha'] });
  assert.equal(byPath[0].rel, 'src/alpha.js');
});

test('queryBoost：符号命中 4 分/个（上限 5 个），路径段命中 1 分/个（上限 3）', () => {
  const symbols = Array.from({ length: 8 }, (_, i) => ({ name: `thing${i}` }));
  assert.equal(queryBoost('src/a.js', symbols, ['thing']), 20, '8 个命中被截到 5 个 = 20');
  assert.equal(queryBoost('src/thing/a.js', [], ['thing']), 1, '路径段命中 +1');
  assert.equal(queryBoost('src/a.js', [{ name: 'other' }], []), 0);
});

// ---------- 格式化 / 预算 ----------

const row = (rel, score, syms, total = syms.length) => ({
  rel,
  score,
  base: score,
  boost: 0,
  inDegree: 0,
  totalSymbols: total,
  symbols: syms.map((d, i) => ({ name: `s${i}`, kind: 'function', line: i + 1, decl: d })),
});

test('formatRepoMap：正常输出含文件行/符号/脚注；空符号文件跳过', () => {
  const out = formatRepoMap([
    row('src/a.js', 7, ['export function a()', 'export const b = 1']),
    row('src/empty.js', 5, []),
    row('src/c.js', 3, ['export class C']),
  ]);
  assert.match(out, /^src\/a\.js {2}\(7\)/m);
  assert.match(out, /│ export function a\(\)/);
  assert.match(out, /src\/c\.js/);
  assert.ok(!out.includes('src/empty.js'), '无导出符号的文件不进地图');
  assert.match(out, /（共 2 个含导出符号的源文件，展示 2 个）/);
});

test('formatRepoMap：预算裁剪——整文件丢弃、不超预算、脚注注明；首文件超预算时保文件行', () => {
  const rows = [row('src/a.js', 9, ['export function a()']), row('src/b.js', 8, ['export function b()'])];
  const small = formatRepoMap(rows, { budgetChars: 40 });
  assert.ok(!small.includes('src/b.js'), '装不下的文件整体丢弃');
  assert.match(small, /已按预算裁剪/);
  const body = small.slice(0, small.lastIndexOf('\n（共'));
  assert.ok(body.length <= 40, `正文不得超预算（实际 ${body.length}）`);

  const tiny = formatRepoMap([row('src/a.js', 9, ['x'.repeat(200)])], { budgetChars: 30 });
  assert.match(tiny, /^src\/a\.js/);
  assert.match(tiny, /展示 1 个/);
});

test('formatRepoMap：符号被截断时追加 ⋮；无内容返回空串', () => {
  const truncated = formatRepoMap([row('src/a.js', 9, ['export function a()'], 20)], { budgetChars: 1000 });
  assert.match(truncated, /⋮/);
  assert.equal(formatRepoMap([]), '');
  assert.equal(formatRepoMap([row('src/e.js', 1, [])]), '');
});

test('DEFAULT_BUDGET_CHARS 为拍板值 6000', () => {
  assert.equal(DEFAULT_BUDGET_CHARS, 6000);
});

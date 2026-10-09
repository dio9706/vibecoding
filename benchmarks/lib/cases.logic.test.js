/**
 * benchmark 案例纯函数单测（T5）：schema 校验 / git 日志解析 / 候选判定 / draft 生成。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTestFile,
  isSafeRelPath,
  normalizeCase,
  validateCase,
  buildVerifyCommand,
  parseGitNumstatLog,
  isCaseCandidate,
  slugify,
  draftCaseFromCommit,
} from './cases.logic.js';

const base = () => ({
  id: 'c1-fix-thing',
  title: '修个东西',
  type: 'bug',
  input: '功能坏了，点了没反应',
  fixRef: 'abcdef1',
  testFiles: ['src/x.test.js'],
});

test('isSafeRelPath / isTestFile：绝对路径、..、非测试文件一律拒绝', () => {
  assert.equal(isSafeRelPath('src/a.test.js'), true);
  assert.equal(isSafeRelPath('src\\a.test.js'), true, 'Windows 分隔符可用');
  assert.equal(isSafeRelPath('C:\\repo\\a.test.js'), false);
  assert.equal(isSafeRelPath('/etc/a.test.js'), false);
  assert.equal(isSafeRelPath('\\\\server\\share\\a.test.js'), false);
  assert.equal(isSafeRelPath('src/../secret.test.js'), false);
  assert.equal(isSafeRelPath(''), false);
  assert.equal(isTestFile('a.test.js'), true);
  assert.equal(isTestFile('a.test.mjs'), false);
  assert.equal(isTestFile('a.js'), false);
});

test('normalizeCase：trim、去重 testFiles、补默认 type=feature', () => {
  const c = normalizeCase({ id: ' x ', testFiles: [' a.test.js ', 'a.test.js', ''], type: 'unknown' });
  assert.deepEqual(c.testFiles, ['a.test.js']);
  assert.equal(c.type, 'feature');
  assert.equal(c.id, 'x');
  assert.equal(c.baseRef, null);
});

test('validateCase：合法案例通过；各类非法输入给出可读错误', () => {
  assert.equal(validateCase(base()).ok, true);

  const cases = [
    [{ ...base(), id: '' }, /id 必填/],
    [{ ...base(), id: 'has space' }, /id 含非法字符/],
    [{ ...base(), input: '' }, /input/],
    [{ ...base(), fixRef: '' }, /fixRef 必填/],
    [{ ...base(), fixRef: 'not-a-hash!' }, /fixRef 不是合法 commit/],
    [{ ...base(), testFiles: [] }, /testFiles 不能为空/],
    [{ ...base(), testFiles: ['C:\\x.test.js'] }, /不安全路径/],
    [{ ...base(), testFiles: ['src/x.js'] }, /必须是 \*\.test\.js/],
  ];
  for (const [raw, re] of cases) {
    const r = validateCase(raw);
    assert.equal(r.ok, false, JSON.stringify(raw.testFiles));
    assert.match(r.errors.join(';'), re);
  }

  // id 查重（与其他案例）
  const dup = validateCase(base(), { knownIds: new Set(['c1-fix-thing']) });
  assert.equal(dup.ok, false);
  assert.match(dup.errors.join(';'), /id 重复/);
});

test('buildVerifyCommand：显式命令优先；缺省 node --test + 转义含空格路径', () => {
  assert.equal(buildVerifyCommand(['a.test.js'], 'npm test'), 'npm test');
  assert.equal(buildVerifyCommand(['a.test.js', 'b/b.test.js']), 'node --test a.test.js b/b.test.js');
  assert.equal(buildVerifyCommand(['dir with space/a.test.js']), 'node --test "dir with space/a.test.js"');
});

test('parseGitNumstatLog：多提交块、二进制（-）、元数据与文件归位', () => {
  const out =
    '\x00hash1\x1fabc1234\x1ffix(x): 修一个 bug\x1fparent1\n' +
    '10\t2\tsrc/a.js\n' +
    '-\t-\tassets/logo.png\n' +
    '\x00hash2\x1fdef5678\x1fadd feature\x1fparent2 parent3\n' +
    '3\t0\tsrc/b.js\n';
  const commits = parseGitNumstatLog(out);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0].parents, ['parent1']);
  assert.equal(commits[0].files[0].path, 'src/a.js');
  assert.equal(commits[0].files[0].insertions, 10);
  assert.equal(commits[0].files[1].insertions, null, '二进制为 null');
  assert.deepEqual(commits[1].parents, ['parent2', 'parent3']);
  assert.equal(parseGitNumstatLog('').length, 0);
});

test('isCaseCandidate：测试+实现同改才适用；规模/主题过滤', () => {
  const mk = (files, subject = 'fix(x): 修个 bug', parents = ['p']) => ({
    hash: 'h',
    short: 'abc',
    subject,
    parents,
    files: files.map((p) => ({ path: p, insertions: 1, deletions: 1 })),
  });
  assert.equal(isCaseCandidate(mk(['src/a.js', 'src/a.test.js'])), true);
  assert.equal(isCaseCandidate(mk(['src/a.test.js'])), false, '只有测试没有实现 → 回放没活干');
  assert.equal(isCaseCandidate(mk(['src/a.js'])), false, '只有实现没有测试 → 无判据');
  assert.equal(isCaseCandidate(mk(['docs/x.md', 'src/a.test.js'])), false, '文档不算实现');
  assert.equal(isCaseCandidate(mk(['src/a.js', 'src/a.test.js'], 'test(x): 加测试')), false, '纯测试主题');
  assert.equal(isCaseCandidate(mk(['src/a.js', 'src/a.test.js'], 'fix(x): ok', [])), false, '无父提交（根提交）跳过');
  assert.equal(
    isCaseCandidate(
      mk(Array.from({ length: 20 }, (_, i) => `src/f${i}.js`).concat('src/x.test.js')),
      { maxFiles: 12 },
    ),
    false,
    '大杂烩提交超出文件上限',
  );
  const big = mk(['src/a.js', 'src/a.test.js']);
  big.files = [
    { path: 'src/a.js', insertions: 900, deletions: 0 },
    { path: 'src/a.test.js', insertions: 1, deletions: 1 },
  ];
  assert.equal(isCaseCandidate(big, { maxDiffLines: 800 }), false, '改动行数超限');
});

test('slugify / draftCaseFromCommit：生成占位 draft（input 待人工改写）', () => {
  assert.equal(slugify('Feat: A B / C!'), 'feat-a-b-c');
  assert.equal(slugify('修个东西'), '', '全中文标题得到空 slug（id 回退为短哈希）');
  const commit = {
    hash: 'full',
    short: 'abc1234',
    subject: 'fix(memory-bank): 修复 sessions CRUD 污染',
    parents: ['p'],
    files: [
      { path: 'src/store/memory-bank.js', insertions: 5, deletions: 2 },
      { path: 'src/store/memory-bank.test.js', insertions: 9, deletions: 1 },
    ],
  };
  const draft = draftCaseFromCommit(commit);
  assert.equal(draft.type, 'bug');
  assert.equal(draft.draft, true);
  assert.equal(draft.id, 'abc1234-sessions-crud', '中文被剥离，slug 取英文片段');
  assert.equal(draft.fixRef, 'abc1234');
  assert.deepEqual(draft.testFiles, ['src/store/memory-bank.test.js']);
  assert.deepEqual(draft.tags, ['memory-bank']);
  assert.ok(draft.input.length > 0, 'input 先占位，人工改写后再入库');
  assert.equal(draftCaseFromCommit({ ...commit, files: [{ path: 'src/a.js', insertions: 1, deletions: 0 }] }), null, '无测试文件不成案');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LARGE_FILE_LINES, testPathsFor, findLargeFilesWithoutTest, evaluateTests,
} from './check-tests.logic.js';

test('配对规则：x.js 的测试是 x.test.js 或 x.logic.test.js', () => {
  assert.deepStrictEqual(
    testPathsFor('src/store/runs.js'),
    ['src/store/runs.test.js', 'src/store/runs.logic.test.js'],
  );
});

test('只报超过阈值且无配对测试的文件', () => {
  const files = [
    { rel: 'a/big.js', lines: 900 },      // 超阈值，无测试 → 报
    { rel: 'a/tested.js', lines: 900 },   // 超阈值，有测试 → 不报
    { rel: 'a/logic.js', lines: 900 },    // 超阈值，有 .logic.test.js → 不报
    { rel: 'a/small.js', lines: 100 },    // 未超阈值 → 不报
  ];
  const all = new Set(['a/tested.test.js', 'a/logic.logic.test.js']);
  assert.deepStrictEqual(findLargeFilesWithoutTest(files, all), [{ file: 'a/big.js', lines: 900 }]);
});

test('阈值边界：恰好等于阈值不报，超过才报', () => {
  const all = new Set();
  assert.equal(findLargeFilesWithoutTest([{ rel: 'x.js', lines: LARGE_FILE_LINES }], all).length, 0);
  assert.equal(findLargeFilesWithoutTest([{ rel: 'x.js', lines: LARGE_FILE_LINES + 1 }], all).length, 1);
});

test('测试红了 → error 级 issue，重扣分', () => {
  const r = evaluateTests({
    testRun: { status: 'fail', reason: '测试未通过（退出码 1）' },
    largeFilesWithoutTest: [], testFileCount: 10, sourceFileCount: 20,
  });
  assert.equal(r.status, 'done');
  assert.equal(r.issues[0].code, 'S1_TESTS_FAILING');
  assert.equal(r.issues[0].severity, 'error');
  assert.ok(r.score <= 60, `测试红了分数应显著下降，实际 ${r.score}`);
});

test('超时 → 整个维度 partial，不计入总分，且绝不判成「测试失败」', () => {
  const r = evaluateTests({
    testRun: { status: 'timeout', reason: '测试执行超过 120s' },
    largeFilesWithoutTest: [], testFileCount: 10, sourceFileCount: 20,
  });
  assert.equal(r.status, 'partial', '超时是「无法判断」，不是「测试红了」');
  assert.equal(r.score, null);
  assert.equal(r.issues.filter((i) => i.code === 'S1_TESTS_FAILING').length, 0);
});

test('占位 test 脚本 → 不因此扣分（npm init 的默认脚本就是 exit 1）', () => {
  const r = evaluateTests({
    testRun: { status: 'na', reason: 'test 脚本是 npm init 的占位脚本' },
    largeFilesWithoutTest: [], testFileCount: 5, sourceFileCount: 10,
  });
  assert.equal(r.status, 'done');
  assert.equal(r.score, 100, '无法执行测试不等于测试失败');
  assert.equal(r.issues.length, 0);
});

test('项目完全没有测试文件 → warn', () => {
  const r = evaluateTests({
    testRun: { status: 'na', reason: 'package.json 未定义 test 脚本' },
    largeFilesWithoutTest: [], testFileCount: 0, sourceFileCount: 12,
  });
  assert.equal(r.issues[0].code, 'S3_NO_TESTS');
  assert.equal(r.issues[0].severity, 'warn');
  assert.ok(r.score < 100);
});

test('没有测试文件时不再重复报「大文件无测试」（否则同一件事报两遍）', () => {
  const r = evaluateTests({
    testRun: { status: 'na' },
    largeFilesWithoutTest: [{ file: 'a.js', lines: 900 }, { file: 'b.js', lines: 800 }],
    testFileCount: 0, sourceFileCount: 12,
  });
  assert.equal(r.issues.length, 1, '只报 S3');
  assert.equal(r.issues[0].code, 'S3_NO_TESTS');
});

test('大文件无测试 → 每个一条 info，分数按条数递减但有下限', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ file: `f${i}.js`, lines: 900 }));
  const r = evaluateTests({
    testRun: { status: 'pass' }, largeFilesWithoutTest: many,
    testFileCount: 5, sourceFileCount: 40,
  });
  assert.equal(r.issues.every((i) => i.code === 'S2_LARGE_FILE_UNTESTED'), true);
  assert.ok(r.score >= 0, '分数不能为负');
  assert.ok(r.score < 100);
});

test('全绿且无大文件缺口 → 100 done', () => {
  const r = evaluateTests({
    testRun: { status: 'pass' }, largeFilesWithoutTest: [],
    testFileCount: 10, sourceFileCount: 20,
  });
  assert.equal(r.score, 100);
  assert.equal(r.status, 'done');
  assert.deepStrictEqual(r.issues, []);
});

test('没有任何源文件 → na（空仓库不该扣分也不该计入）', () => {
  const r = evaluateTests({
    testRun: { status: 'na' }, largeFilesWithoutTest: [], testFileCount: 0, sourceFileCount: 0,
  });
  assert.equal(r.status, 'na');
  assert.equal(r.score, null);
});

test('容错：不传参不抛', () => {
  assert.doesNotThrow(() => evaluateTests());
  assert.doesNotThrow(() => evaluateTests({}));
});

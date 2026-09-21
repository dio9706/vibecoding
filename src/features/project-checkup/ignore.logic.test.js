import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFile, matchesIgnore, filterIgnoredIssues, ignoredCodesFor,
  appendIgnoreNote, renderIgnoredMd,
} from './ignore.logic.js';

const rule = (over = {}) => ({
  dim: 'structure',
  code: 'A1_DEP_VIOLATION',
  file: 'src/api/request.js',
  message: 'api 层直接 import store',
  note: '历史遗留兼容层',
  at: '2026-09-18T10:00:00.000Z',
  ...over,
});

const issue = (over = {}) => ({
  code: 'A1_DEP_VIOLATION',
  severity: 'error',
  file: 'src/api/request.js',
  line: 12,
  message: 'api 层直接 import store',
  ...over,
});

test('分隔符归一：反斜杠与正斜杠视为同一路径', () => {
  assert.equal(normalizeFile('src\\api\\request.js'), 'src/api/request.js');
  assert.equal(normalizeFile('  src/api/request.js  '), 'src/api/request.js');
});

test('大小写**不**归一：大小写敏感的文件系统上它们是两个文件', () => {
  assert.notEqual(normalizeFile('src/Api/x.js'), normalizeFile('src/api/x.js'));
});

test('三元组全中才算匹配', () => {
  assert.equal(matchesIgnore('structure', issue(), rule()), true);
});

test('维度不同不匹配', () => {
  assert.equal(matchesIgnore('complexity', issue(), rule()), false);
});

test('code 不同不匹配（同文件的其他类型问题仍要报）', () => {
  assert.equal(matchesIgnore('structure', issue({ code: 'A2_DEP_SMELL' }), rule()), false);
});

test('行号不参与匹配：代码上下挪动后豁免依然有效', () => {
  assert.equal(matchesIgnore('structure', issue({ line: 987 }), rule()), true);
});

test('过滤返回保留项与被豁免条数', () => {
  const issues = [issue(), issue({ code: 'A2_DEP_SMELL' }), issue({ file: 'src/b.js' })];
  const out = filterIgnoredIssues('structure', issues, [rule()]);
  assert.equal(out.ignoredCount, 1);
  assert.equal(out.kept.length, 2);
  assert.deepEqual(out.kept.map((i) => i.code), ['A2_DEP_SMELL', 'A1_DEP_VIOLATION']);
});

test('没有豁免记录时原样返回，不复制数组', () => {
  const issues = [issue()];
  const out = filterIgnoredIssues('structure', issues, []);
  assert.equal(out.ignoredCount, 0);
  assert.equal(out.kept, issues, '零豁免是最常见的路径，不该产生垃圾');
});

test('ignoredCodesFor 只收该维度该文件的 code', () => {
  const ignores = [
    rule({ code: 'A1_DEP_VIOLATION' }),
    rule({ code: 'A2_DEP_SMELL' }),
    rule({ file: 'src/other.js', code: 'A3_X' }),
    rule({ dim: 'complexity', code: 'A4_Y' }),
  ];
  const got = ignoredCodesFor('structure', 'src/api/request.js', ignores);
  assert.deepEqual([...got].sort(), ['A1_DEP_VIOLATION', 'A2_DEP_SMELL']);
});

test('分数已调整与未调整的说明文案必须不同', () => {
  // 两类维度的分数口径不同，不说清楚就会出现「0 个问题却 72 分」的无解观感
  assert.equal(appendIgnoreNote('', 2, true), '已豁免 2 条');
  assert.equal(appendIgnoreNote('', 2, false), '已豁免 2 条，本维度分数未重算');
  assert.equal(appendIgnoreNote('原因说明', 1, true), '原因说明（已豁免 1 条）');
  assert.equal(appendIgnoreNote('原因说明', 0, true), '原因说明', '零豁免不该留痕');
});

test('md 渲染含备注原文、维度中文名与免改声明', () => {
  const md = renderIgnoredMd([rule()], [{ id: 'structure', label: '分层与依赖方向' }]);
  assert.match(md, /手工修改会在下次豁免操作时被覆盖/);
  assert.match(md, /分层与依赖方向/);
  assert.match(md, /src\/api\/request\.js/);
  assert.match(md, /A1_DEP_VIOLATION/);
  assert.match(md, /历史遗留兼容层/);
});

test('md 在清单为空时也给出完整文件（而不是空串）', () => {
  // 撤销最后一条豁免后要把文件写成「空清单」，不能留着上一版内容骗人
  const md = renderIgnoredMd([], []);
  assert.match(md, /体检豁免清单/);
  assert.match(md, /目前没有任何豁免记录/);
});

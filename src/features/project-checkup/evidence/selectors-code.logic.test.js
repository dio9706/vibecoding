import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recallOversizedUnits, recallSimilarBlocks, recallVagueNames,
  recallDeadCode, recallCatchBlocks, recallRiskyPatterns, recallHardcodedConfig,
} from './selectors-code.logic.js';
import { measureFile } from './units.logic.js';

/** 构造召回器入参：measure 由 collect.js 负责，这里就地补上 */
function mkArgs(map) {
  return { files: Object.entries(map).map(([rel, text]) => ({ rel, text, measure: measureFile(text) })) };
}

const longBody = Array.from({ length: 70 }, (_, i) => `  step${i}();`).join('\n');

test('recallOversizedUnits 捞出超长函数，并把超阈值理由写进 text', () => {
  const out = recallOversizedUnits(mkArgs({
    'a.js': `function big(a) {\n${longBody}\n}\nfunction ok() {\n  return 1;\n}`,
  }));
  assert.equal(out.length, 1);
  assert.equal(out[0].meta.name, 'big');
  assert.ok(out[0].text.includes('有效行'));
  assert.equal(out[0].line, 1);
});

test('recallOversizedUnits 把深嵌套与参数过多也当独立信号', () => {
  const deep = 'function d(a) {\n  if(a){\n    if(a){\n      if(a){\n        if(a){\n          if(a){\n            go();\n}}}}}\n}';
  const many = 'function m(a, b, c, d, e, f) {\n  return 1;\n}';
  const out = recallOversizedUnits(mkArgs({ 'd.js': deep, 'm.js': many }));
  assert.deepStrictEqual(out.map((o) => o.meta.name).sort(), ['d', 'm']);
});

test('recallOversizedUnits 巨型文件单独成一条候选（与函数过长是两个问题）', () => {
  const huge = Array.from({ length: 650 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const out = recallOversizedUnits(mkArgs({ 'huge.js': huge }));
  assert.equal(out.length, 1);
  assert.equal(out[0].meta.kind, 'file');
});

test('recallSimilarBlocks 只在结构相同且够长时成组，并列出全部位置', () => {
  const body = ['  const a = load(1);', '  const b = load(2);', '  send(a);', '  send(b);', '  flush();', '  done();'].join('\n');
  const out = recallSimilarBlocks(mkArgs({
    'x.js': `function alpha() {\n${body}\n}`,
    'y.js': `function beta() {\n${body.replace(/1/, '9')}\n}`,
  }));
  assert.equal(out.length, 1);
  assert.equal(out[0].meta.sites.length, 2);
  assert.ok(out[0].text.includes('x.js'));
  assert.ok(out[0].text.includes('y.js'));
});

test('recallSimilarBlocks 忽略太短的雷同（单行转发不是重复问题）', () => {
  const out = recallSimilarBlocks(mkArgs({
    'x.js': 'function a() {\n  return 1;\n}',
    'y.js': 'function b() {\n  return 1;\n}',
  }));
  assert.deepStrictEqual(out, []);
});

test('recallVagueNames 三类低信息量命名各自命中', () => {
  const out = recallVagueNames({
    exports: [
      { name: 'data', kind: 'const', file: 'a.js', line: 3, decl: 'export const data = {}', refs: 2 },
      { name: 'ab', kind: 'const', file: 'a.js', line: 4, decl: 'export const ab = 1', refs: 0 },
      { name: 'cfgMgr', kind: 'class', file: 'b.js', line: 9, decl: 'export class cfgMgr {}', refs: 1 },
      { name: 'renderInvoice', kind: 'function', file: 'c.js', line: 1, decl: 'export function renderInvoice() {}', refs: 5 },
    ],
  });
  assert.deepStrictEqual(out.map((o) => o.meta.name).sort(), ['ab', 'cfgMgr', 'data']);
});

test('recallVagueNames 抓「仅数字后缀区分」的成对符号', () => {
  const out = recallVagueNames({
    exports: [
      { name: 'parse', kind: 'function', file: 'a.js', line: 1, decl: 'export function parse() {}', refs: 3 },
      { name: 'parse2', kind: 'function', file: 'a.js', line: 5, decl: 'export function parse2() {}', refs: 1 },
    ],
  });
  assert.deepStrictEqual(out.map((o) => o.meta.name), ['parse2']);
});

test('recallDeadCode 区分「零引用」与「只被测试引用」', () => {
  const out = recallDeadCode({
    files: [],
    exports: [
      { name: 'gone', kind: 'function', file: 'a.js', line: 2, decl: 'export function gone() {}', refs: 0, refFiles: [], refsFromTestsOnly: false },
      { name: 'onlyTested', kind: 'function', file: 'b.js', line: 4, decl: 'export function onlyTested() {}', refs: 1, refFiles: ['b.test.js'], refsFromTestsOnly: true },
      { name: 'live', kind: 'function', file: 'c.js', line: 1, decl: 'export function live() {}', refs: 3, refFiles: ['d.js'], refsFromTestsOnly: false },
    ],
  });
  assert.deepStrictEqual(
    out.map((o) => [o.meta.name, o.meta.kind]),
    [['gone', 'unused-export'], ['onlyTested', 'test-only-export']],
  );
});

test('recallDeadCode 捞注释掉的代码块，但不把中文说明当代码', () => {
  const out = recallDeadCode({
    ...mkArgs({
      'a.js': [
        '// const a = 1;',
        '// doThing(a);',
        '// return a;',
        'run();',
        '// 这里解释为什么要这么写',
        '// 它涉及一个历史包袱',
        '// 所以不能直接删',
      ].join('\n'),
    }),
    exports: [],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].meta.kind, 'commented-code');
  assert.equal(out[0].meta.lines, 3);
});

test('recallCatchBlocks 只捞空体与只打日志的，正常处理不进候选', () => {
  const out = recallCatchBlocks(mkArgs({
    'a.js': [
      'try { a(); } catch (e) {',
      '}',
      'try { b(); } catch (e) {',
      '  console.warn(e);',
      '}',
      'try { c(); } catch (e) {',
      '  fallback();',
      '  notify(e);',
      '}',
    ].join('\n'),
  }));
  assert.deepStrictEqual(out.map((o) => o.meta.kind), ['silent-catch', 'log-only-catch']);
});

test('recallCatchBlocks 认 Python 的 except', () => {
  const out = recallCatchBlocks(mkArgs({
    'a.py': ['try:', '    go()', 'except Exception:', '    pass', 'next_step()'].join('\n'),
  }));
  assert.equal(out.length, 1);
  assert.equal(out[0].meta.kind, 'silent-catch');
});

test('recallRiskyPatterns 命中硬编码凭证与危险 API，并跳过注释里的示范', () => {
  const out = recallRiskyPatterns(mkArgs({
    'a.js': [
      'const apiKey = "sk-live-abcdefghijklmn";',
      'eval(userInput);',
      '// 禁止使用 eval(userInput) —— 这是注入面',
      'el.innerHTML = raw;',
    ].join('\n'),
  }));
  const kinds = out.map((o) => o.meta.kind);
  assert.ok(kinds.includes('hardcoded-credential'));
  assert.ok(kinds.includes('unsafe-html'));
  assert.equal(kinds.filter((k) => k === 'code-injection').length, 1, '注释里的示范不该被计入');
});

test('recallHardcodedConfig 命中绝对路径，并把 env 分散聚合成一条', () => {
  const args = mkArgs({
    'a.js': 'const p = "C:\\\\Users\\\\me\\\\data";\nconst k = process.env.A;',
    'b.js': 'const k = process.env.B;',
    'c.js': 'const k = process.env.C;',
    'd.js': 'const k = process.env.D;',
  });
  const out = recallHardcodedConfig(args);
  const kinds = out.map((o) => o.meta.kind);
  assert.ok(kinds.includes('absolute-path'));
  assert.equal(kinds.filter((k) => k === 'env-scattered').length, 1);
  assert.equal(out.find((o) => o.meta.kind === 'env-scattered').meta.count, 4);
});

test('recallHardcodedConfig 在 env 读取点不多时不报分散', () => {
  const out = recallHardcodedConfig({ ...mkArgs({ 'a.js': 'const k = process.env.A;' }) });
  assert.deepStrictEqual(out.filter((o) => o.meta.kind === 'env-scattered'), []);
});

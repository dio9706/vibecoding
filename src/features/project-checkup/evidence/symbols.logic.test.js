import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTokenIndex, isTestFile, extractExports, collectExports,
} from './symbols.logic.js';

test('buildTokenIndex 记的是「出现在哪些文件」而非出现次数', () => {
  const idx = buildTokenIndex([
    { rel: 'a.js', text: 'foo(); foo(); foo();' },
    { rel: 'b.js', text: 'foo();' },
  ]);
  assert.deepStrictEqual([...idx.get('foo')].sort(), ['a.js', 'b.js']);
});

test('isTestFile 认目录式与后缀式两种测试布局', () => {
  assert.ok(isTestFile('src/a.test.js'));
  assert.ok(isTestFile('src/a.logic.test.js'));
  assert.ok(isTestFile('tests/e2e.mjs'));
  assert.ok(isTestFile('src/__tests__/a.js'));
  assert.ok(isTestFile('pkg/test_thing.py'));
  assert.ok(!isTestFile('src/latest/a.js'));
});

test('extractExports 认全部 JS 导出写法', () => {
  const src = [
    'export function alpha() {}',
    'export async function beta() {}',
    'export const GAMMA = 1;',
    'export class Delta {}',
    'export { epsilon, zeta as eta };',
    'exports.theta = 1;',
    'function notExported() {}',
  ].join('\n');
  const names = extractExports(src, 'a.js').map((e) => e.name);
  assert.deepStrictEqual(names, ['alpha', 'beta', 'GAMMA', 'Delta', 'epsilon', 'eta', 'theta']);
});

test('extractExports 的 Python 口径：顶层且非下划线前缀', () => {
  const src = ['def public_fn():', '    pass', 'def _private():', '    pass', 'class Thing:', '    def method(self):', '        pass'].join('\n');
  assert.deepStrictEqual(extractExports(src, 'm.py').map((e) => e.name), ['public_fn', 'Thing']);
});

test('extractExports 的 Go 口径：首字母大写即导出', () => {
  const src = ['func Handle() {}', 'func internal() {}', 'type Config struct {}'].join('\n');
  assert.deepStrictEqual(extractExports(src, 'm.go').map((e) => e.name), ['Handle', 'Config']);
});

test('extractExports 对不认识的语言返回空', () => {
  assert.deepStrictEqual(extractExports('export function x() {}', 'a.md'), []);
});

test('collectExports 算出跨文件引用数，并标出「只被测试引用」', () => {
  const out = collectExports([
    { rel: 'src/a.js', text: 'export function used() {}\nexport function dead() {}\nexport function tested() {}' },
    { rel: 'src/b.js', text: 'import { used } from "./a.js";\nused();' },
    { rel: 'src/a.test.js', text: 'import { tested } from "./a.js";\ntested();' },
  ]);
  const by = Object.fromEntries(out.map((e) => [e.name, e]));

  assert.equal(by.used.refs, 1);
  assert.equal(by.used.refsFromTestsOnly, false);
  assert.equal(by.dead.refs, 0);
  assert.equal(by.tested.refs, 1);
  assert.equal(by.tested.refsFromTestsOnly, true);
});

test('collectExports 不收测试文件自身的导出（测试函数没有别的调用方是正常的）', () => {
  const out = collectExports([
    { rel: 'src/a.test.js', text: 'export function helperForTest() {}' },
  ]);
  assert.deepStrictEqual(out, []);
});

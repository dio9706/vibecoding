import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  familyOf, toLines, matchFunctionDecl, countParams, sliceUnits,
  measureFile, normalizeForDuplicate,
} from './units.logic.js';

test('familyOf 按扩展名分家族，不认识的归 unknown', () => {
  assert.equal(familyOf('src/a.js'), 'brace');
  assert.equal(familyOf('Main.java'), 'brace');
  assert.equal(familyOf('app.py'), 'indent');
  assert.equal(familyOf('README.md'), 'unknown');
  assert.equal(familyOf('noext'), 'unknown');
});

test('toLines 把纯注释行标成非有效行（度量按有效行算）', () => {
  const lines = toLines(['// c', '/* block', ' * mid', ' */', 'const a = 1;', ''].join('\n'));
  assert.deepStrictEqual(lines.map((l) => l.significant), [false, false, false, false, true, false]);
});

test('matchFunctionDecl 认四种写法', () => {
  assert.equal(matchFunctionDecl('export function handle(req, res) {').name, 'handle');
  assert.equal(matchFunctionDecl('  doWork(a, b) {').name, 'doWork');
  assert.equal(matchFunctionDecl('const run = async (x) => {').name, 'run');
  assert.equal(matchFunctionDecl('public static void main(String[] args) {').name, 'main');
});

test('matchFunctionDecl 不把控制流和普通调用当声明', () => {
  for (const line of [
    'if (x) {', '} else if (y) {', 'for (const a of b) {', 'while (t) {',
    'switch (k) {', '} catch (e) {', 'const v = compute(a, b);', 'return wrap(x);',
    '  .then((r) => {', '});',
  ]) {
    assert.equal(matchFunctionDecl(line), null, `误判为声明：${line}`);
  }
});

test('matchFunctionDecl 跳过声明引导词，拿到 Go 方法真名与真参数', () => {
  const d = matchFunctionDecl('func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {');
  assert.equal(d.name, 'Handle');
  assert.equal(countParams(d.params), 2);
});

test('countParams 不把泛型/嵌套里的逗号算成参数分隔', () => {
  assert.equal(countParams(''), 0);
  assert.equal(countParams('a'), 1);
  assert.equal(countParams('a, b, c'), 3);
  assert.equal(countParams('Map<K, V> m, List<T> l'), 2);
  assert.equal(countParams('{ a, b }, c'), 2);
});

test('sliceUnits 切出 JS 函数，行数只算有效行、深度不含函数自身那层', () => {
  const src = [
    'function flat(a) {',       // 1
    '  // 说明',                // 2 注释，不计
    '  return a + 1;',          // 3
    '}',                        // 4
    '',
    'function nested(a, b) {',  // 6
    '  if (a) {',               // 7
    '    for (const x of b) {', // 8
    '      run(x);',            // 9
    '    }',
    '  }',
    '}',
  ].join('\n');

  const units = sliceUnits(src, 'a.js');
  assert.deepStrictEqual(units.map((u) => u.name), ['flat', 'nested']);

  const flat = units[0];
  assert.equal(flat.startLine, 1);
  assert.equal(flat.endLine, 4);
  assert.equal(flat.significant, 3); // 声明行 + return + }
  assert.equal(flat.maxDepth, 0);

  assert.equal(units[1].maxDepth, 2);
  assert.equal(units[1].params, 2);
});

test('sliceUnits 处理单行函数体，不把文件剩余部分吞进同一个单元', () => {
  const src = ['function one() { return 1; }', 'function two() { return 2; }'].join('\n');
  const units = sliceUnits(src, 'a.js');
  assert.deepStrictEqual(units.map((u) => u.name), ['one', 'two']);
  assert.equal(units[0].endLine, 1);
});

test('sliceUnits 认得 class 花括号里的方法（Java 深度为 1 的场景）', () => {
  const src = [
    'public class Svc {',
    '  public void alpha(int a) {',
    '    doIt(a);',
    '  }',
    '  private String beta() {',
    '    return "x";',
    '  }',
    '}',
  ].join('\n');
  const names = sliceUnits(src, 'Svc.java').map((u) => u.name);
  assert.ok(names.includes('alpha'), `alpha 未被识别，实际：${names}`);
  assert.ok(names.includes('beta'), `beta 未被识别，实际：${names}`);
});

test('sliceUnits 把回调算进外层函数，不单独成单元', () => {
  const src = [
    'function outer() {',
    '  items.forEach((it) => {',
    '    use(it);',
    '  });',
    '}',
  ].join('\n');
  const units = sliceUnits(src, 'a.js');
  assert.equal(units.length, 1);
  assert.equal(units[0].name, 'outer');
});

test('sliceUnits 切 Python：缩进回落即结束', () => {
  const src = [
    'def alpha(a, b):',
    '    if a:',
    '        return b',
    '    return None',
    '',
    'def beta():',
    '    pass',
  ].join('\n');
  const units = sliceUnits(src, 'm.py');
  assert.deepStrictEqual(units.map((u) => u.name), ['alpha', 'beta']);
  assert.equal(units[0].params, 2);
  assert.equal(units[0].maxDepth, 1);
});

test('sliceUnits 对不认识的语言返回空数组（不猜边界）', () => {
  assert.deepStrictEqual(sliceUnits('anything (x) {', 'a.md'), []);
});

test('measureFile 分别给出总行与有效行', () => {
  const m = measureFile(['// a', 'x = 1', '', 'y = 2'].join('\n'));
  assert.equal(m.total, 4);
  assert.equal(m.significant, 2);
});

test('normalizeForDuplicate 归一字面量与空白，但保留标识符差异', () => {
  const a = normalizeForDuplicate(['  send("hello", 1);', '  // 注释']);
  const b = normalizeForDuplicate(['send("world",  2);']);
  assert.equal(a, b, '仅字面量不同应视为同一份重复');

  const c = normalizeForDuplicate(['sendOther("hello", 1);']);
  assert.notEqual(a, c, '标识符不同不算重复');
});

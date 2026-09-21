import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  familyOf, toLines, matchFunctionDecl, countParams, sliceUnits,
  measureFile, normalizeForDuplicate, scriptOnly,
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

// ---------- SFC：只留 <script>，且必须保住行号 ----------

/** 行号标在注释里，断言直接对着它们看 */
const VUE_LINES = [
  '<template>', //                    1
  '  <div class="a">{{ x }}</div>', // 2
  '</template>', //                   3
  '', //                              4
  '<script setup lang="ts">', //      5
  'function calc(n) {', //            6
  '  return n * 2;', //               7
  '}', //                             8
  '</script>', //                     9
  '', //                             10
  '<style scoped>', //               11
  '.a { color: red; }', //           12
  '</style>', //                     13
];
const VUE = VUE_LINES.join('\n');

test('scriptOnly：只保留 <script> 内容，template / style 抹成空行', () => {
  const out = scriptOnly(VUE, 'src/C.vue').split('\n');
  assert.equal(out.length, VUE_LINES.length, '行数必须与原文完全一致');
  assert.equal(out[5], 'function calc(n) {', '第 6 行仍是第 6 行');
  assert.equal(out[6], '  return n * 2;');
  assert.equal(out[1], '', 'template 内容被抹掉');
  assert.equal(out[11], '', 'style 里的 CSS 不该被当成代码单元');
  assert.equal(out[4], '', '<script> 开标签本身不是代码');
});

test('scriptOnly：行号不能漂 —— 抹掉的行留空而不是删除', () => {
  // 删行会让后续 issue 的 file:line 整体前移，静默指向隔壁代码
  const units = sliceUnits(scriptOnly(VUE, 'a.vue'), 'a.vue');
  assert.ok(units.length >= 1, 'script 段里的函数要能被切出来');
  assert.equal(units[0].name, 'calc');
  assert.equal(units[0].startLine, 6, '函数起始行等于它在真实文件里的行号');
  assert.equal(units[0].endLine, 8);
});

test('scriptOnly：非 SFC 原样返回', () => {
  const src = ['function f() {', '  return 1;', '}'].join('\n');
  assert.equal(scriptOnly(src, 'src/a.ts'), src);
  assert.equal(scriptOnly(src, 'src/a.py'), src);
});

test('scriptOnly：无 script 段 / 空输入不炸', () => {
  assert.equal(scriptOnly('<template><div/></template>', 'a.vue').trim(), '');
  assert.equal(scriptOnly('', 'a.vue'), '');
  assert.equal(scriptOnly(null, 'a.vue'), '');
});

test('scriptOnly：同行自闭合的空 script 不会吞掉后面所有内容', () => {
  const t = ['<script src="x.js"></script>', '<template>', '  <p/>', '</template>'].join('\n');
  assert.equal(scriptOnly(t, 'a.vue').trim(), '', '开闭同行 → 不进入脚本态');
});

test('familyOf：SFC 归花括号族（其 script 段是 JS/TS）', () => {
  assert.equal(familyOf('src/C.vue'), 'brace');
  assert.equal(familyOf('src/C.svelte'), 'brace');
});

/**
 * 附加抽取器（类方法）单测：JS/TS 类体定位（词法扫描防字符串/注释干扰）+ Python 缩进法。
 * 这些规则只进代码地图，不影响体检——误判的代价是地图多/少一行，测试钉住的是「明显该收/该排除」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractExtraSymbols,
  extractJsClassMethods,
  extractPyClassMethods,
  scanJsStructure,
} from './extra-symbols.logic.js';

test('scanJsStructure：字符串/注释/模板里的花括号不参与深度', () => {
  const src = [
    'class A {', // depth 0 → 1
    '  x() {', // 1 → 2
    "    const s = '}';",
    '    // } 注释里的也不算',
    '    return `}{`;',
    '  }', // 2 → 1
    '}', // 1 → 0
  ].join('\n');
  const lines = scanJsStructure(src);
  assert.deepEqual(lines.map((l) => l.depth), [0, 1, 2, 2, 2, 2, 1]);
  assert.deepEqual(lines.map((l) => l.endDepth), [1, 2, 2, 2, 2, 1, 0]);
  assert.ok(lines[2].code.includes('const s') && !lines[2].code.includes('}'), '字符串被清成空白');
});

test('JS：类方法（构造器/async/static/getter/TS 修饰符）收集，类外函数排除', () => {
  const src = [
    'export class Store {',
    '  constructor(db) {',
    '    this.db = db;',
    '  }',
    '',
    '  async load(id) {',
    '    return this.db.get(id);',
    '  }',
    '',
    '  static create() {',
    '    return new Store(null);',
    '  }',
    '',
    '  get size() {',
    '    return this.db.length;',
    '  }',
    '}',
    'export function outside() {',
    '  return 1;',
    '}',
  ].join('\n');
  const symbols = extractJsClassMethods(src);
  assert.deepEqual(symbols.map((s) => s.name), ['constructor', 'load', 'create', 'size']);
  assert.ok(symbols.every((s) => s.kind === 'method'));
  assert.equal(symbols[1].line, 6);
  assert.equal(symbols[1].decl, 'async load(id) {');
});

test('JS：注释/字符串里的花括号不破坏类体定位，类体结束后正常收手', () => {
  const src = [
    'export class Tricky {',
    '  // } 这个注释里的花括号不算',
    '  describe(text) {',
    '    const tpl = `}`;',
    '    const s = "{";',
    '    return text;',
    '  }',
    '  /* } */',
    '  after() {',
    '    return 1;',
    '  }',
    '}',
    'function notAMethod() {',
    '  return 0;',
    '}',
  ].join('\n');
  assert.deepEqual(extractJsClassMethods(src).map((s) => s.name), ['describe', 'after']);
});

test('JS：类体一层之外的嵌套/对象方法不收；块语句关键字不误收', () => {
  const objLiteral = ['const api = {', '  foo() {', '    return 1;', '  },', '};'].join('\n');
  assert.deepEqual(extractJsClassMethods(objLiteral), [], '对象字面量方法不是类方法');

  const nested = [
    'class Outer {',
    '  run() {',
    '    const inner = {',
    '      hidden() {',
    '        return 1;',
    '      },',
    '    };',
    '    return inner;',
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(extractJsClassMethods(nested).map((s) => s.name), ['run'], '方法体内的对象方法不进图');

  // 词法扫描失误（深度错位）时也别把 `if (x) {` 当成方法
  assert.deepEqual(extractJsClassMethods('class A {\n  if (x) {\n  }\n}'), []);
});

test('TS：参数注解与返回类型里的冒号/尖括号不影响签名识别', () => {
  const src = [
    'export class Svc {',
    '  private async fetch(id: string): Promise<{ ok: boolean }> {',
    '    return { ok: true };',
    '  }',
    '  public static make(): void {',
    '  }',
    '}',
  ].join('\n');
  // 返回类型含 `{` → 该签名收不进（正则刻意保守）；但 static make(): void 必须收进
  assert.deepEqual(extractJsClassMethods(src).map((s) => s.name), ['make']);
});

test('Python：class 内与首个方法同缩进的 def 收集；__init__/下划线/嵌套函数排除', () => {
  const src = [
    'class Client:',
    '    """docstring"""',
    '',
    '    def __init__(self, base):',
    '        self.base = base',
    '',
    '    def fetch(self, path):',
    '        def helper():',
    '            return 1',
    '        return helper()',
    '',
    '    @staticmethod',
    '    def build():',
    '        return 1',
    '',
    'class Other:',
    '    async def send(self):',
    '        pass',
  ].join('\n');
  const symbols = extractPyClassMethods(src);
  assert.deepEqual(symbols.map((s) => s.name), ['fetch', 'build', 'send']);
});

test('extractExtraSymbols：按扩展名派发；其他语言返回空', () => {
  assert.equal(extractExtraSymbols('class A {\n  go() {\n  }\n}', 'src/a.ts').length, 1);
  assert.equal(extractExtraSymbols('class A:\n    def go(self):\n        pass\n', 'a.py').length, 1);
  assert.deepEqual(extractExtraSymbols('func (r *T) Foo() {}', 'a.go'), []);
  assert.deepEqual(extractExtraSymbols('public void run() {}', 'A.java'), []);
  assert.deepEqual(extractExtraSymbols('class A {\n  go() {}\n}', 'a.md'), []);
});

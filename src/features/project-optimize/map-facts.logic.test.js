import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractExports, headComment, formatFactPack } from './map-facts.logic.js';

// ---------- extractExports ----------

test('抽出具名导出的函数、常量、类', () => {
  const code = [
    'export function alpha() {}',
    'export async function beta() {}',
    'export const GAMMA = 1;',
    'export class Delta {}',
  ].join('\n');
  assert.deepEqual(extractExports(code), ['alpha', 'beta', 'GAMMA', 'Delta']);
});

test('忽略 re-export 与默认导出', () => {
  // `export * from` 没有具名信息；default 的名字对「这个模块提供什么」没有帮助
  const code = 'export * from "./x.js";\nexport default function () {}';
  assert.deepEqual(extractExports(code), []);
});

test('不把注释掉的导出算进去', () => {
  // 注释里的示例代码很常见，收进来会让地图列出根本不存在的 API
  const code = '// export function ghost() {}\nexport function real() {}';
  assert.deepEqual(extractExports(code), ['real']);
});

test('空输入返回空数组', () => {
  assert.deepEqual(extractExports(''), []);
  assert.deepEqual(extractExports(null), []);
});

// ---------- headComment ----------

test('取出文件顶部块注释的首个实义行', () => {
  const code = '/**\n * 维度①的文件系统层：遍历模块目录、比对 mtime。\n *\n * 更多细节……\n */\nimport fs from "fs";';
  assert.equal(headComment(code), '维度①的文件系统层：遍历模块目录、比对 mtime。');
});

test('没有块注释时返回空串', () => {
  assert.equal(headComment('import fs from "fs";'), '');
});

test('块注释不在文件开头时不取', () => {
  // 文件中部的注释描述的是局部逻辑，冒充文件职责会误导地图
  assert.equal(headComment('import fs from "fs";\n/** 局部说明 */'), '');
});

test('超长首行被截断', () => {
  const long = '/**\n * ' + 'x'.repeat(300) + '\n */';
  assert.ok(headComment(long).length <= 120);
});

// ---------- formatFactPack ----------

test('把事实包渲染成带小节标题的文本', () => {
  const text = formatFactPack([
    { title: '目录结构', body: 'src/\n  a/\n  b/' },
    { title: '常用命令', body: 'npm test' },
  ]);
  assert.ok(text.includes('### 目录结构'));
  assert.ok(text.includes('### 常用命令'));
  assert.ok(text.includes('npm test'));
});

test('空 body 的小节被整节丢掉', () => {
  // 留下「### 依赖\n（无）」这种空壳只会占 token，还让模型以为这是重要信息
  const text = formatFactPack([
    { title: '有内容', body: 'x' },
    { title: '空的', body: '' },
    { title: '也空', body: null },
  ]);
  assert.ok(text.includes('### 有内容'));
  assert.ok(!text.includes('### 空的'));
  assert.ok(!text.includes('### 也空'));
});

test('空输入返回空串', () => {
  assert.equal(formatFactPack([]), '');
  assert.equal(formatFactPack(null), '');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from './frontmatter.logic.js';

test('解析出 paths 列表', () => {
  const raw = "---\npaths:\n  - 'src/**'\n  - \"src/a/*.vue\"\n---\n\n# 标题\n";
  const fm = parseFrontmatter(raw);
  assert.deepEqual(fm.paths, ['src/**', 'src/a/*.vue']);
  assert.equal(fm.hasFrontmatter, true);
});

test('没有 frontmatter 时 paths 为 null', () => {
  const fm = parseFrontmatter('# 只有正文\n');
  assert.equal(fm.hasFrontmatter, false);
  assert.equal(fm.paths, null);
});

test('有 frontmatter 但没有 paths 字段', () => {
  const raw = '---\nname: foo\n---\n\n正文\n';
  const fm = parseFrontmatter(raw);
  assert.equal(fm.hasFrontmatter, true);
  assert.equal(fm.paths, null);
});

test('CRLF 换行也能解析', () => {
  const raw = "---\r\npaths:\r\n  - 'src/**'\r\n---\r\n\r\n正文\r\n";
  assert.deepEqual(parseFrontmatter(raw).paths, ['src/**']);
});

// —— 以下为代码审查发现的 7 类回归用例 ——
// 之所以每条都要有测试：解析结果会驱动「降级为 skill」的破坏性自动化，
// 漏解析等于把宽 rule 误判成无条件加载，动错文件的代价远高于少个字段。

test('issue1: 单引号流式序列(inline array)', () => {
  const raw = "---\npaths: ['src/**/*.vue', 'src/**/*.scss']\n---\n";
  assert.deepEqual(parseFrontmatter(raw).paths, ['src/**/*.vue', 'src/**/*.scss']);
});

test('issue1: 双引号流式序列', () => {
  const raw = '---\npaths: ["src/a/**", "src/b/**"]\n---\n';
  assert.deepEqual(parseFrontmatter(raw).paths, ['src/a/**', 'src/b/**']);
});

test('issue1: 流式序列后带行内注释', () => {
  const raw = "---\npaths: ['src/**']  # 只覆盖源码\n---\n";
  assert.deepEqual(parseFrontmatter(raw).paths, ['src/**']);
});

test('issue2: 单标量(带引号)', () => {
  const raw = "---\npaths: 'src/**'\n---\n";
  assert.deepEqual(parseFrontmatter(raw).paths, ['src/**']);
});

test('issue2: 单标量(无引号)', () => {
  const raw = '---\npaths: src/**\n---\n';
  assert.deepEqual(parseFrontmatter(raw).paths, ['src/**']);
});

test('issue2: 单标量带行内注释', () => {
  const raw = '---\npaths: src/**  # 全部源码\n---\n';
  assert.deepEqual(parseFrontmatter(raw).paths, ['src/**']);
});

test('issue3: paths 键后带行内注释，块序列仍能解析', () => {
  const raw = "---\npaths:  # 只对 vue 生效\n  - 'src/**/*.vue'\n---\n";
  assert.deepEqual(parseFrontmatter(raw).paths, ['src/**/*.vue']);
});

test('issue4: 列表条目带行内注释要剥干净', () => {
  const raw = "---\npaths:\n  - 'src/**'  # 全部源码\n  - \"src/a/*.vue\"\t# 组件\n---\n";
  assert.deepEqual(parseFrontmatter(raw).paths, ['src/**', 'src/a/*.vue']);
});

test('issue4: 剥注释必须引号感知，不能误伤路径里的 #', () => {
  const raw = "---\npaths:\n  - 'src/#tmp/**'\n  - 'src/x/**'  # 注释\n---\n";
  assert.deepEqual(parseFrontmatter(raw).paths, ['src/#tmp/**', 'src/x/**']);
});

test('issue5: UTF-8 BOM 开头仍算有 frontmatter', () => {
  const raw = "﻿---\npaths:\n  - 'src/**'\n---\n";
  const fm = parseFrontmatter(raw);
  assert.equal(fm.hasFrontmatter, true);
  assert.deepEqual(fm.paths, ['src/**']);
});

test('issue6: 起始分隔行尾带空格仍算有 frontmatter', () => {
  const raw = "--- \npaths:\n  - 'src/**'\n--- \n";
  const fm = parseFrontmatter(raw);
  assert.equal(fm.hasFrontmatter, true);
  assert.deepEqual(fm.paths, ['src/**']);
});

test('issue7: 显式空数组返回 []，不是 null', () => {
  const raw = '---\npaths: []\n---\n';
  const fm = parseFrontmatter(raw);
  assert.equal(fm.hasFrontmatter, true);
  assert.deepEqual(fm.paths, []);
});

test('边界: 跨行流式序列不支持，返回 null(YAGNI)', () => {
  const raw = "---\npaths: [\n  'a',\n  'b'\n]\n---\n";
  assert.equal(parseFrontmatter(raw).paths, null);
});

test('边界: paths 块结束后的顶格新键不会被吞进列表', () => {
  const raw = "---\npaths:\n  - 'src/**'\nname: foo\n  - 'not-a-path'\n---\n";
  assert.deepEqual(parseFrontmatter(raw).paths, ['src/**']);
});

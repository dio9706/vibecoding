import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPathsWidth, evaluateRules } from './check-rules.logic.js';

test('paths 宽度分级', () => {
  assert.equal(classifyPathsWidth(null), 'unconditional');
  assert.equal(classifyPathsWidth(['src/**']), 'wide');
  assert.equal(classifyPathsWidth(['**/*']), 'wide');
  assert.equal(classifyPathsWidth(['src/**/*.vue']), 'medium');
  assert.equal(classifyPathsWidth(['src/components/*.ts']), 'narrow');
});

test('显式空数组 = 不匹配任何文件,应算最窄', () => {
  // 语义上「paths: []」和「没写 paths」是相反的两件事,不能都塌陷成 unconditional
  assert.equal(classifyPathsWidth([]), 'narrow');
});

test('多条 paths 取最宽的那条', () => {
  assert.equal(classifyPathsWidth(['src/a/*.ts', 'src/**']), 'wide');
});

test('花括号扩展限定了扩展名,应算 medium', () => {
  assert.equal(classifyPathsWidth(['src/**/*.{ts,tsx}']), 'medium');
  assert.equal(classifyPathsWidth(['src/**/*.{js,jsx,ts}']), 'medium');
  assert.equal(classifyPathsWidth(['**/*.{md,mdx}']), 'medium');
});

test('bracket expression 限定了扩展名,也算 medium', () => {
  assert.equal(classifyPathsWidth(['src/**/*.[jt]s']), 'medium');
});

test('含 ** 但未限定扩展名的一律算 wide', () => {
  assert.equal(classifyPathsWidth(['src/**']), 'wide');
  assert.equal(classifyPathsWidth(['src/**/*']), 'wide');
  assert.equal(classifyPathsWidth(['src/pages*/**']), 'wide');
  assert.equal(classifyPathsWidth(['docs/**']), 'wide');
  assert.equal(classifyPathsWidth(['**/*']), 'wide');
});

test('不含 ** 的一律算 narrow', () => {
  assert.equal(classifyPathsWidth(['src/components/*.ts']), 'narrow');
  assert.equal(classifyPathsWidth(['*.md']), 'narrow');
  assert.equal(classifyPathsWidth(['src/a/b.vue']), 'narrow');
});

test('大且宽 → 判定应降级', () => {
  const r = evaluateRules([
    { name: 'fat.md', sizeBytes: 15000, paths: ['src/**'], hasFrontmatter: true },
  ]);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].code, 'R1_SHOULD_DEMOTE');
  assert.equal(r.issues[0].fixable, true);
  assert.ok(r.score < 100);
});

test('小文件即使 paths 宽也不判降级', () => {
  const r = evaluateRules([{ name: 'tiny.md', sizeBytes: 900, paths: ['src/**'], hasFrontmatter: true }]);
  assert.equal(r.issues.length, 0);
  assert.equal(r.score, 100);
});

test('大文件但 paths 窄,不判降级', () => {
  const r = evaluateRules([
    { name: 'bigNarrow.md', sizeBytes: 20000, paths: ['src/components/*.vue'], hasFrontmatter: true },
  ]);
  assert.equal(r.issues.length, 0);
});

test('单文件扣分上限 20', () => {
  const r = evaluateRules([{ name: 'huge.md', sizeBytes: 500000, paths: null, hasFrontmatter: false }]);
  assert.equal(r.score, 80);
});

test('有 frontmatter 但解析不出 paths → 仍提示但拒绝自动修复', () => {
  // 这种情况最可疑：解析器读到了 frontmatter 却没提取到 paths，
  // 很可能是它不认识的写法，而不是真的没写 paths。
  const r = evaluateRules([
    { name: 'weird.md', sizeBytes: 15000, paths: null, hasFrontmatter: true },
  ]);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].code, 'R2_DEMOTE_UNCERTAIN');
  assert.equal(r.issues[0].fixable, false);
});

test('确实没有 frontmatter → 正常判定可修复', () => {
  const r = evaluateRules([
    { name: 'nofm.md', sizeBytes: 15000, paths: null, hasFrontmatter: false },
  ]);
  assert.equal(r.issues[0].code, 'R1_SHOULD_DEMOTE');
  assert.equal(r.issues[0].fixable, true);
});

test('没有 rules 目录 → N/A', () => {
  const r = evaluateRules(null);
  assert.equal(r.score, null);
  assert.equal(r.status, 'na');
});

test('有目录但没文件 → 满分', () => {
  const r = evaluateRules([]);
  assert.equal(r.score, 100);
  assert.equal(r.status, 'done');
});

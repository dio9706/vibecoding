import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirSlug, buildRestorePrompt, buildSpecDraftPrompt } from './req-uispec.logic.js';

test('dirSlug 取目录尾段并带路径哈希', () => {
  const s = dirSlug('D:/work/op-admin-web');
  assert.match(s, /^op-admin-web-[0-9a-z]{6}$/);
});

test('dirSlug 对同名不同路径给出不同 slug', () => {
  // 前后端仓库都叫 web 是常态，撞名会让两个项目共用一份 UI 规范
  assert.notEqual(dirSlug('D:/a/web'), dirSlug('D:/b/web'));
});

test('dirSlug 忽略末尾分隔符与正反斜杠差异', () => {
  assert.equal(dirSlug('D:/work/web'), dirSlug('D:\\work\\web\\'));
});

test('dirSlug 清洗尾段里的非法文件名字符', () => {
  assert.match(dirSlug('D:/work/my proj@1'), /^my-proj-1-[0-9a-z]{6}$/);
});

test('dirSlug 空目录返回稳定兜底值', () => {
  assert.equal(dirSlug(''), dirSlug(''));
  assert.ok(dirSlug('').length > 0);
});

// ---- buildRestorePrompt ----

const page = { name: '导出确认弹窗', file: 'src/pages/order/ExportConfirmModal.vue', figma: { url: 'https://figma.com/x', node: '12:3480' } };

test('buildRestorePrompt 带上设计稿链接、目标文件与规范全文', () => {
  const p = buildRestorePrompt({ page, specText: '弹框统一用 OpModal，圆角 12px' });
  assert.match(p, /figma\.com\/x/);
  assert.match(p, /ExportConfirmModal\.vue/);
  assert.match(p, /OpModal/);
});

test('buildRestorePrompt 明确规范优先于设计稿，并要求列出冲突', () => {
  // 这是整个还原能力的核心约束：设计稿和规范打架时不能让模型自己拍脑袋
  const p = buildRestorePrompt({ page, specText: 'x' });
  assert.match(p, /规范/);
  assert.match(p, /冲突/);
});

test('buildRestorePrompt 规范为空时改口径为「按现有代码风格」并说明未配置', () => {
  const p = buildRestorePrompt({ page, specText: '' });
  assert.match(p, /未配置/);
});

test('buildRestorePrompt 缺设计稿时抛错', () => {
  assert.throws(() => buildRestorePrompt({ page: { name: 'A' }, specText: 'x' }), /设计稿/);
});

test('buildSpecDraftPrompt 要求产出可直接落盘的 markdown 规范', () => {
  const p = buildSpecDraftPrompt({ dir: 'D:/work/web' });
  assert.match(p, /D:\/work\/web/);
  assert.match(p, /markdown/i);
});

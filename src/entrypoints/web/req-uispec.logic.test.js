import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRestorePrompt, buildSpecDraftPrompt } from './req-uispec.logic.js';

// dirSlug 的测试已随函数迁到 shared/dir-slug.test.js

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

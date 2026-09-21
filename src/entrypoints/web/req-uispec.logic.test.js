import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRestorePrompt, buildSpecDraftPrompt } from './req-uispec.logic.js';

// dirSlug 的测试已随函数迁到 shared/dir-slug.test.js

// ---- buildRestorePrompt ----

const FG_DEFAULT = { id: 'fg-a', url: 'https://figma.com/x', label: '默认态', restoredAt: null };
const FG_EMPTY = { id: 'fg-b', url: 'https://figma.com/y', label: '空态', restoredAt: null };
const page = {
  name: '导出确认弹窗',
  file: 'src/pages/order/ExportConfirmModal.vue',
  figmas: [FG_DEFAULT, FG_EMPTY],
};

test('buildRestorePrompt 带上设计稿链接、目标文件与规范全文', () => {
  const p = buildRestorePrompt({ page, figma: FG_DEFAULT, specText: '弹框统一用 OpModal，圆角 12px' });
  assert.match(p, /figma\.com\/x/);
  assert.match(p, /ExportConfirmModal\.vue/);
  assert.match(p, /OpModal/);
  // node 是已废弃的死字段（前端从未写入过），不该借尸还魂出现在 prompt 里
  assert.ok(!p.includes('节点'), 'node 是死字段，不该回归 prompt');
});

test('buildRestorePrompt 在标题里点明这一轮还原的是哪个状态', () => {
  const p = buildRestorePrompt({ page, figma: FG_EMPTY, specText: 'x' });
  assert.match(p, /【空态】/);
});

test('buildRestorePrompt 列出同页其他状态名，但不给它们的链接', () => {
  // 逐条还原的固有风险是后一轮把前一轮覆盖掉，所以要告诉模型这页还有别的状态；
  // 但给了链接模型会一次全做完，就退化成页面级还原了
  const p = buildRestorePrompt({ page, figma: FG_EMPTY, specText: 'x' });
  assert.match(p, /默认态/);
  assert.ok(!p.includes('figma.com/x'), '不应出现其他稿的链接');
  assert.match(p, /不要把组件写死/);
});

test('buildRestorePrompt 同页只有一张稿时不出护栏段', () => {
  const solo = { name: 'A', file: 'a.vue', figmas: [FG_DEFAULT] };
  const p = buildRestorePrompt({ page: solo, figma: FG_DEFAULT, specText: 'x' });
  assert.ok(!p.includes('其他状态'), '单张稿不该提其他状态');
});

test('buildRestorePrompt label 为空时不出空的【】', () => {
  const fg = { id: 'fg-a', url: 'https://figma.com/x', label: '', restoredAt: null };
  const p = buildRestorePrompt({ page: { name: 'A', file: 'a.vue', figmas: [fg] }, figma: fg, specText: 'x' });
  assert.ok(!p.includes('【】'));
  assert.match(p, /还原页面「A」的视觉实现/);
});

test('buildRestorePrompt 其他稿没填状态名时以「未命名状态」占位', () => {
  const anon = { id: 'fg-c', url: 'https://figma.com/z', label: '', restoredAt: null };
  const p = buildRestorePrompt({ page: { name: 'A', figmas: [FG_DEFAULT, anon] }, figma: FG_DEFAULT, specText: 'x' });
  assert.match(p, /未命名状态/);
});

test('buildRestorePrompt 明确规范优先于设计稿，并要求列出冲突', () => {
  // 这是整个还原能力的核心约束：设计稿和规范打架时不能让模型自己拍脑袋
  const p = buildRestorePrompt({ page, figma: FG_DEFAULT, specText: 'x' });
  assert.match(p, /规范/);
  assert.match(p, /冲突/);
});

test('buildRestorePrompt 规范为空时改口径为「按现有代码风格」并说明未配置', () => {
  const p = buildRestorePrompt({ page, figma: FG_DEFAULT, specText: '' });
  assert.match(p, /未配置/);
});

test('buildRestorePrompt 缺设计稿时抛错', () => {
  assert.throws(() => buildRestorePrompt({ page: { name: 'A' }, figma: null, specText: 'x' }), /设计稿/);
  assert.throws(() => buildRestorePrompt({ page, figma: { id: 'fg-x', url: '' }, specText: 'x' }), /设计稿/);
  // 纯空白 url 不 trim 就是真值，会绕过前面的空串检查——钉住 .trim() 这一步不能省
  assert.throws(() => buildRestorePrompt({ page, figma: { id: 'fg-x', url: '   ' }, specText: 'x' }), /设计稿/);
});

test('buildSpecDraftPrompt 要求产出可直接落盘的 markdown 规范', () => {
  const p = buildSpecDraftPrompt({ dir: 'D:/work/web' });
  assert.match(p, /D:\/work\/web/);
  assert.match(p, /markdown/i);
});

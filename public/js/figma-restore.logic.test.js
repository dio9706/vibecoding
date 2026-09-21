/**
 * 设计稿精确还原开关纯逻辑。
 * 单跑：node --test public/js/figma-restore.logic.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasFigmaUrl,
  decorateFigmaRestore,
  buildRestoreDirective,
  OSS_TOOL_PATH,
} from './figma-restore.logic.js';

const CLAUDE = { on: true, provider: 'claude-agent' };
const LINK = 'https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/MyFile?node-id=1-2';

test('开 + Claude provider + 含链接 → 追加指令段', () => {
  const out = decorateFigmaRestore(`还原这个页面 ${LINK}`, CLAUDE);
  assert.ok(out.startsWith(`还原这个页面 ${LINK}`), '用户原文必须原样保留在开头');
  assert.ok(out.includes('【设计稿精确还原 · 自动资源管线】'));
  assert.ok(out.includes('figma-precise-restore'));
});

test('开但文本无 Figma 链接 → 原样返回', () => {
  assert.equal(decorateFigmaRestore('帮我看看这段代码', CLAUDE), '帮我看看这段代码');
});

test('关 → 原样返回', () => {
  const text = `还原这个页面 ${LINK}`;
  assert.equal(decorateFigmaRestore(text, { on: false, provider: 'claude-agent' }), text);
});

test('openai-compat provider → 原样返回（那边没有 figma MCP 与 skill 机制）', () => {
  const text = `还原这个页面 ${LINK}`;
  assert.equal(decorateFigmaRestore(text, { on: true, provider: 'openai-compat' }), text);
});

test('design / file / board / slides 四种路径形态都识别', () => {
  const key = 'AbCdEfGhIjKlMnOpQrStUv';
  for (const seg of ['design', 'file', 'board', 'slides']) {
    assert.ok(hasFigmaUrl(`https://www.figma.com/${seg}/${key}/X`), seg + ' 应识别');
  }
});

test('省略 www 也识别', () => {
  assert.ok(hasFigmaUrl('https://figma.com/design/AbCdEfGhIjKlMnOpQrStUv/X'));
});

test('相似域名不误判', () => {
  assert.equal(hasFigmaUrl('https://evil-figma.com/design/AbCdEfGhIjKlMnOpQrStUv/X'), false);
  assert.equal(hasFigmaUrl('https://figma.com.evil.com/design/AbCdEfGhIjKlMnOpQrStUv/X'), false);
});

test('空值不炸', () => {
  assert.equal(hasFigmaUrl(''), false);
  assert.equal(hasFigmaUrl(null), false);
  assert.equal(hasFigmaUrl(undefined), false);
});

test('指令段带上传命令的关键组成', () => {
  const d = buildRestoreDirective();
  assert.ok(d.includes(OSS_TOOL_PATH), '必须含工具路径');
  assert.ok(d.includes('bin/upload.mjs'));
  assert.ok(d.includes('--prefix='));
  assert.ok(d.includes('git rev-parse --abbrev-ref HEAD'), '分支由模型自己取');
  assert.ok(d.includes('kebab-case'));
  assert.ok(d.includes('download_assets'));
});

// 以下三条对应一次真实还原暴露的缺陷：模型混用了 export（把页面背景一起渲染进切图）、
// 直传了 2112px 的原始素材，且在上传实际失败后谎称「资源全部上传完成」。
test('指令段禁止 export，并说明理由', () => {
  const d = buildRestoreDirective();
  assert.ok(d.includes('禁止使用 export'), '必须显式禁用 export');
  assert.ok(d.includes('rawImages'), '必须指明用 rawImages');
  assert.ok(d.includes('svgAssets'));
  assert.ok(d.includes('叶子节点'), '要给出选错节点时的补救方向');
});

test('指令段要求按 2x 导出而非直传原始素材', () => {
  assert.ok(buildRestoreDirective().includes('2x'));
});

test('指令段强制校验上传结果，且堵死绕过手段', () => {
  const d = buildRestoreDirective();
  assert.ok(d.includes('rejected'), '必须让模型认识 rejected 状态');
  assert.ok(d.includes('failed'));
  assert.ok(d.includes('skipped'));
  assert.ok(d.includes('--allow-opaque'), '必须点名这个绕过手段并禁止滥用');
  assert.ok(d.includes('占位色块'), '禁止用占位图顶替');
});

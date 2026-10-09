/**
 * develop 提示词模板单测：生产（task-ops）与 benchmark 共用同一份，模板契约必须被钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDevelopPrompt } from './prompt.logic.js';

test('bug/feature 措辞不同，原始反馈与分析建议都进入 prompt', () => {
  const bug = buildDevelopPrompt({ type: 'bug', detail: '点采买没反应', analysis: '按钮回调为空实现' });
  assert.match(bug, /实际实现这个修复/);
  assert.match(bug, /原始反馈：「点采买没反应」/);
  assert.match(bug, /分析建议：\n按钮回调为空实现/);

  const feat = buildDevelopPrompt({ type: 'feature', detail: '欢迎语改渐变色' });
  assert.match(feat, /实际实现这个需求/);
  assert.match(feat, /分析建议：\n\(无\)/, '缺分析建议时回落 (无)');
});

test('scopeSection/scopeFix 按序拼接；verify 段只在有命令时出现；结尾行为固定', () => {
  const p = buildDevelopPrompt({
    type: 'bug',
    detail: 'x',
    scopeSection: '\n【作用域】A\n',
    scopeFix: '\n【工作区】B\n',
    verifyCommand: 'npm test',
  });
  const iScope = p.indexOf('【作用域】A');
  const iFix = p.indexOf('【工作区】B');
  const iVerify = p.indexOf('【完成标准】');
  assert.ok(iScope >= 0 && iFix > iScope && iVerify > iFix, '段落顺序：scopeSection → scopeFix → 完成标准');
  assert.match(p, /npm test/);
  assert.ok(p.endsWith('请修改代码完成它；完成后用一段话说明你改了哪些文件、做了什么。'));

  const noCmd = buildDevelopPrompt({ type: 'feature', detail: 'x' });
  assert.ok(!noCmd.includes('【完成标准】'), '无验证命令时不出现完成标准段');
});

test('verifyFeedback（重试）带失败现场与反绕过纪律', () => {
  const p = buildDevelopPrompt({
    type: 'feature',
    detail: 'x',
    verifyCommand: 'npm test',
    verifyFeedback: { command: 'npm test', exitCode: 1, timedOut: false, durationMs: 1000, output: 'AssertionError: expected 1 to be 2' },
  });
  assert.match(p, /【上一次未通过自检】/);
  assert.match(p, /AssertionError: expected 1 to be 2/);
  assert.match(p, /禁止通过删除\/改写测试/);
});

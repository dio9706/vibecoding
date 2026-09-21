/** revert 纯函数单测：commit message 必须过 commitlint，prompt 必须交代清「保留后续提交」。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revertCommitMessage, buildRevertPrompt } from './revert.logic.js';

test('revertCommitMessage：符合 conventional 规范且控长 ≤72', () => {
  const m = revertCommitMessage({ title: '修复登录按钮错位' });
  assert.match(m, /^revert: /, '必须带 type，否则目标仓库的 commitlint 会挡下这次提交');
  assert.ok(m.length <= 72, `header 应控长，实际 ${m.length}`);
});

test('revertCommitMessage：超长标题截断后 subject 仍非空', () => {
  const m = revertCommitMessage({ title: '超长'.repeat(100) });
  assert.ok(m.length <= 72);
  assert.match(m, /^revert: \S/);
});

test('revertCommitMessage：无标题任务不产生空 subject', () => {
  assert.match(revertCommitMessage({}), /^revert: \S/);
  assert.match(revertCommitMessage(null), /^revert: \S/);
});

test('buildRevertPrompt：含 sha、任务描述，且明确要求保留后续提交、不要自行 commit', () => {
  const p = buildRevertPrompt({
    task: { title: '登录按钮错位', detail: '点了没反应' },
    mergeCommit: 'abc1234def5678',
  });
  assert.match(p, /abc1234def5678/, '必须给出锚点 sha');
  assert.match(p, /登录按钮错位/);
  assert.match(p, /点了没反应/);
  assert.match(p, /保留/, '必须交代「保留此后其他提交的改动」，否则会被整体回滚');
  assert.match(p, /不要.*commit|不要.*提交/, '提交由调用方统一做，模型自己 commit 会绕过 commitAll 的校验');
});

test('buildRevertPrompt：无 mergeCommit 时不拼出 undefined', () => {
  const p = buildRevertPrompt({ task: { title: 'x', detail: 'y' }, mergeCommit: '' });
  assert.doesNotMatch(p, /undefined|null/);
});

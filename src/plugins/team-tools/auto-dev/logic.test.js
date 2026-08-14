import test from 'node:test';
import assert from 'node:assert';
import { taskBranchName, buildCommitMessage, parseQrUrl } from './logic.js';

test('taskBranchName：auto/<taskId>', () => {
  assert.equal(taskBranchName({ id: 't_abc123' }), 'auto/t_abc123');
});

test('buildCommitMessage：bug=fix、feature=feat、失败带标记', () => {
  assert.equal(buildCommitMessage({ type: 'bug', title: '闪退', id: 't1' }, true), 'fix: 闪退 (task t1)');
  assert.equal(buildCommitMessage({ type: 'feature', title: '加按钮', id: 't2' }, false), 'feat: 加按钮 [failed] (task t2)');
});

test('buildCommitMessage：清洗 shell 敏感字符', () => {
  const m = buildCommitMessage({ type: 'bug', title: 'x" & echo hi `id`', id: 't3' }, true);
  assert.doesNotMatch(m, /[&`$|;<>^"']/);
  assert.match(m, /^fix: /);
});

test('parseQrUrl：取最后一个图片直链（含 ?t=）', () => {
  const out = 'log\nhttps://oss.x/a/dev/qrcode.png?t=123\ntail';
  assert.equal(parseQrUrl(out), 'https://oss.x/a/dev/qrcode.png?t=123');
  assert.equal(parseQrUrl('没有链接'), null);
});

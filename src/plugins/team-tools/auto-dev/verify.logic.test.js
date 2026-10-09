/**
 * auto-dev/verify.logic.js 纯函数测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerifyLine, buildVerifyRetrySection, buildVerifySection, MAX_VERIFY_ATTEMPTS } from './verify.logic.js';

test('MAX_VERIFY_ATTEMPTS：首次 + 1 次重试', () => {
  assert.equal(MAX_VERIFY_ATTEMPTS, 2);
});

test('buildVerifySection：空命令不给段落；有命令时含命令与反绕过纪律', () => {
  assert.equal(buildVerifySection(''), '');
  assert.equal(buildVerifySection('  '), '');
  const s = buildVerifySection('npm test');
  assert.match(s, /【完成标准】/);
  assert.match(s, /npm test/);
  assert.match(s, /禁止通过删除\/改写测试/);
});

test('buildVerifyRetrySection：带命令/退出码/输出与修复要求', () => {
  const s = buildVerifyRetrySection({
    command: 'npm test',
    exitCode: 1,
    timedOut: false,
    durationMs: 133_000,
    output: 'AssertionError: expected 1 to be 2',
  });
  assert.match(s, /【上一次未通过自检】/);
  assert.match(s, /npm test（退出码 1，用时 2m13s）/);
  assert.match(s, /AssertionError/);
  assert.match(s, /请修复到通过/);

  assert.equal(buildVerifyRetrySection(null), '');
  assert.equal(buildVerifyRetrySection({ command: '' }), '');
});

test('buildVerifyRetrySection：超时与空输出都有明确文案', () => {
  const s = buildVerifyRetrySection({ command: 'npm test', timedOut: true, durationMs: 600_000, output: '' });
  assert.match(s, /超时/);
  assert.match(s, /\(无输出\)/);
});

test('buildVerifyLine：跳过/通过/失败三种行，markdown 与纯文本共用取数', () => {
  assert.equal(buildVerifyLine({ skipped: true, reason: '未配置验证命令' }), '\n🔍 未配置自检命令（可在设置页补充）');
  assert.equal(
    buildVerifyLine({ skipped: true, reason: '命令不存在或无法执行（请检查自检命令配置）' }),
    '\n🔍 自检已跳过：命令不存在或无法执行（请检查自检命令配置）',
  );
  assert.equal(buildVerifyLine({ ok: true, command: 'npm test', durationMs: 45_000 }), '\n🔍 自检通过：npm test（45s）');

  const failed = buildVerifyLine({ ok: false, command: 'npm test', exitCode: 1, attempts: 2 });
  assert.equal(failed, '\n⚠️ **自检未通过**：npm test 退出码 1（已重试 1 次）');
  const plain = buildVerifyLine({ ok: false, command: 'npm test', exitCode: 1, attempts: 1 }, { markdown: false });
  assert.equal(plain, '\n⚠️ 自检未通过：npm test 退出码 1');

  assert.equal(buildVerifyLine(null), '');
  assert.equal(buildVerifyLine(undefined), '');
});

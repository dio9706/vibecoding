/**
 * verifier.logic.js 纯函数测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVerifySummary,
  discoverVerifyCommand,
  formatDuration,
  lastMeaningfulLine,
  toVerifyRecord,
  truncateOutput,
} from './verifier.logic.js';

test('discoverVerifyCommand：有真实 test 脚本 → npm test；占位/缺失/非法形态 → 空串', () => {
  assert.equal(discoverVerifyCommand({ scripts: { test: 'node --test "src/**/*.test.js"' } }), 'npm test');
  assert.equal(discoverVerifyCommand({ scripts: { test: '  jest && npm run lint  ' } }), 'npm test');
  // npm init 占位脚本不是测试：发现它会让所有未配置自检的裸 npm 工程必然失败
  assert.equal(discoverVerifyCommand({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }), '');
  // 各种「没有」形态都不产出命令
  assert.equal(discoverVerifyCommand({ scripts: {} }), '');
  assert.equal(discoverVerifyCommand({ scripts: { test: '' } }), '');
  assert.equal(discoverVerifyCommand({ scripts: { test: '   ' } }), '');
  assert.equal(discoverVerifyCommand({ scripts: { test: 42 } }), '');
  assert.equal(discoverVerifyCommand({}), '');
  assert.equal(discoverVerifyCommand(null), '');
  assert.equal(discoverVerifyCommand('not-an-object'), '');
});

test('truncateOutput：短输出原样；长输出保留头+尾并标注省略量', () => {
  assert.equal(truncateOutput('hello'), 'hello');
  assert.equal(truncateOutput(''), '');
  assert.equal(truncateOutput(null), '');

  const long = 'a'.repeat(10000);
  const out = truncateOutput(long, { head: 100, tail: 200 });
  assert.ok(out.startsWith('a'.repeat(100)));
  assert.ok(out.endsWith('a'.repeat(200)));
  assert.match(out, /略 9700 字符/);
});

test('formatDuration：秒/分/小时三档与非法输入', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(133_000), '2m13s');
  assert.equal(formatDuration(120_000), '2m');
  assert.equal(formatDuration(3_720_000), '1h2m');
  assert.equal(formatDuration(-1), '-');
  assert.equal(formatDuration('x'), '-');
});

test('lastMeaningfulLine：取尾部非空行并截断', () => {
  assert.equal(lastMeaningfulLine('line1\n\n  line2  \n'), 'line2');
  assert.equal(lastMeaningfulLine(''), '');
  assert.equal(lastMeaningfulLine('x'.repeat(300), 50).length, 51); // 50 + 省略号
});

test('buildVerifySummary：五类结果各有明确文案', () => {
  assert.equal(buildVerifySummary({ skipped: true, reason: '未配置验证命令' }), '未配置验证命令');
  assert.equal(buildVerifySummary({ skipped: true, reason: '命令不存在或无法执行（请检查自检命令配置）' }), '已跳过（命令不存在或无法执行（请检查自检命令配置））');
  assert.equal(buildVerifySummary({ command: 'npm test', ok: true, durationMs: 45_000 }), 'npm test 通过（45s）');
  assert.equal(
    buildVerifySummary({ command: 'npm test', ok: false, exitCode: 1, durationMs: 1000, output: 'a\n2 tests failed' }),
    'npm test 失败（退出码 1：2 tests failed）',
  );
  assert.equal(buildVerifySummary({ command: 'npm test', timedOut: true, durationMs: 600_000 }), 'npm test 超时（10m）');
});

test('toVerifyRecord：剥离 output、带 attempts/at，字段完整', () => {
  const rec = toVerifyRecord(
    { ok: false, skipped: false, command: 'npm test', reason: '', exitCode: 1, timedOut: false, durationMs: 1234, output: 'RAW OUTPUT', summary: 'npm test 失败（退出码 1）' },
    2,
    '2026-09-30T00:00:00.000Z',
  );
  assert.deepEqual(rec, {
    ok: false,
    skipped: false,
    command: 'npm test',
    reason: '',
    exitCode: 1,
    timedOut: false,
    durationMs: 1234,
    summary: 'npm test 失败（退出码 1）',
    attempts: 2,
    at: '2026-09-30T00:00:00.000Z',
  });
  assert.ok(!('output' in rec), '完整输出不进任务字段（单独进 verifyLog）');
});

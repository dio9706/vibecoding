/**
 * script-runner 单测
 * 测试脚本参数组装、变量脱敏、脚本执行流程。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScriptArgs, maskVars, pickOutput, describeTarget } from './script-runner.js';

test('buildScriptArgs 按配置顺序组装参数数组', () => {
  const actionConfig = {
    scriptName: 'notify.py',
    variables: [
      { name: 'env', required: true },
      { name: 'phone', required: true },
      { name: 'message', required: false },
    ],
  };

  const collectedVars = {
    env: 'test',
    phone: '15901039503',
    message: 'Hello',
  };

  const args = buildScriptArgs(actionConfig, collectedVars);
  assert.deepStrictEqual(args, [
    '--env',
    'test',
    '--phone',
    '15901039503',
    '--message',
    'Hello',
  ]);
});

test('buildScriptArgs 跳过不存在的变量', () => {
  const actionConfig = {
    scriptName: 'notify.py',
    variables: [
      { name: 'env', required: true },
      { name: 'phone', required: true },
      { name: 'missing', required: false },
    ],
  };

  const collectedVars = {
    env: 'prod',
    phone: '15901039503',
  };

  const args = buildScriptArgs(actionConfig, collectedVars);
  assert.deepStrictEqual(args, [
    '--env',
    'prod',
    '--phone',
    '15901039503',
  ]);
});

test('maskVars 脱敏手机号字段', () => {
  const vars = {
    phone: '15901039503',
    env: 'test',
    message: 'some text',
  };

  const masked = maskVars(vars);
  assert.equal(masked.phone, '159****9503');
  assert.equal(masked.env, 'test');
  assert.equal(masked.message, 'some text');
});

test('maskVars 脱敏嵌套对象中的手机号', () => {
  const vars = {
    phone: '18812345678',
    user: {
      phone: '13912345678',
      name: 'John',
    },
    list: [
      { phone: '15512345678' },
      { phone: '14512345678' },
    ],
  };

  const masked = maskVars(vars);
  assert.equal(masked.phone, '188****5678');
  assert.equal(masked.user.phone, '139****5678');
  assert.equal(masked.user.name, 'John');
  assert.equal(masked.list[0].phone, '155****5678');
  assert.equal(masked.list[1].phone, '145****5678');
});

test('maskVars 不脱敏短于 7 位的字符串', () => {
  const vars = {
    phone: '123',
    code: '456789',
  };

  const masked = maskVars(vars);
  assert.equal(masked.phone, '123');
  assert.equal(masked.code, '456789');
});

/**
 * pickOutput —— 线上事故回归（实证 app-2026-09-11.log:777）：
 * 两次 test 环境「清理账号数据」失败，用户只看到「❌ 执行失败 (无输出)」，
 * 真实原因被静默丢弃。根因是失败分支只取 stderr，而脚本把原因 print 到 **stdout**
 * （reset_onboarding.py / refund_orders.py 都是 `print(f"❌ {e}")` 再 exit 1）。
 */
test('pickOutput 失败时保留脚本打在 stdout 的失败原因', () => {
  const r = { ok: false, code: 1, out: '❌ 清理失败：用户不存在', err: '' };
  assert.equal(pickOutput(r), '❌ 清理失败：用户不存在');
});

test('pickOutput 失败时 stdout 与 stderr 都不丢', () => {
  const r = { ok: false, code: 1, out: '❌ 清理失败：用户不存在', err: 'Traceback (most recent call last)' };
  assert.equal(pickOutput(r), '❌ 清理失败：用户不存在\nTraceback (most recent call last)');
});

test('pickOutput 失败且脚本没打任何东西 → 回落到启动错误 msg', () => {
  const r = { ok: false, msg: '无法启动 python：找不到可执行文件（检查 PATH）' };
  assert.equal(pickOutput(r), '无法启动 python：找不到可执行文件（检查 PATH）');
});

test('pickOutput 成功时只取 stdout（stderr 上的告警不污染回执）', () => {
  assert.equal(pickOutput({ ok: true, out: '清理账号数据完成', err: 'DeprecationWarning' }), '清理账号数据完成');
});

/**
 * describeTarget —— 破坏性动作必须让用户当场看见「清的是哪个环境、哪个号」。
 * 事故实证：`phone` 声明为 persistent，用户 2026-09-07 为帮别人退款报过一次
 * 13364860092，此后 11 天所有清理/退款都静默打在该号上，而回执不含目标，
 * 表现就是「说清了但实际没清」且完全不可观测。
 */
test('describeTarget 按变量顺序回显目标，手机号脱敏', () => {
  const cfg = { variables: [{ name: 'env', label: '环境' }, { name: 'phone', label: '手机号' }] };
  assert.equal(describeTarget(cfg, { env: 'dev', phone: '13364860092' }), '环境 dev ｜ 手机号 133****0092');
});

test('describeTarget 缺失或空值的变量不出现在回显里', () => {
  const cfg = { variables: [{ name: 'env', label: '环境' }, { name: 'phone', label: '手机号' }] };
  assert.equal(describeTarget(cfg, { env: 'test' }), '环境 test');
  assert.equal(describeTarget(cfg, { env: 'test', phone: '' }), '环境 test');
});

test('describeTarget 无变量动作返回空串（调用方据此不加回显行）', () => {
  assert.equal(describeTarget({ variables: [] }, {}), '');
  assert.equal(describeTarget({}, {}), '');
});

test('describeTarget 没写 label 时退回变量名', () => {
  assert.equal(describeTarget({ variables: [{ name: 'orderId' }] }, { orderId: 'A1' }), 'orderId A1');
});

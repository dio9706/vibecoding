/**
 * script-runner 单测
 * 测试脚本参数组装、变量脱敏、脚本执行流程。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScriptArgs, maskVars } from './script-runner.js';

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

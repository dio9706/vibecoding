import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskValue, maskDeep } from './mask.js';

/**
 * 背景：store/action-log.js 的 maskValue **硬编码 fieldName === 'phone'**，
 * 其余字段一律原样返回。而 action-runner 的变量完全由管理员在设置页自定义，
 * 用户通过飞书聊天填入 —— password / token / apiKey / secret / 身份证 / 邮箱
 * 全部明文落盘到 action-log.jsonl（该文件无加密、无权限收紧、且永久保留）。
 */

// ── 字段名识别 ─────────────────────────────────────────────────

test('maskValue：手机号沿用原有格式（前 3 后 4）', () => {
  assert.equal(maskValue('13812345678', 'phone'), '138****5678');
});

test('maskValue：凭证类字段名一律全遮蔽（核心回归）', () => {
  for (const k of ['password', 'passwd', 'pwd', 'token', 'apiKey', 'api_key', 'secret', 'appSecret', 'accessToken', 'privateKey']) {
    const out = maskValue('super-secret-value-123', k);
    assert.notEqual(out, 'super-secret-value-123', `字段 ${k} 未脱敏`);
    assert.equal(/super|secret-value/.test(out), false, `字段 ${k} 仍泄漏原文：${out}`);
  }
});

test('maskValue：字段名大小写与分隔符变体都要认（apiKey / API_KEY / api-key）', () => {
  for (const k of ['apiKey', 'API_KEY', 'api-key', 'ApiKey']) {
    assert.notEqual(maskValue('abcdef123456', k), 'abcdef123456', `字段 ${k} 未脱敏`);
  }
});

test('maskValue：邮箱保留可辨识的首尾，不整条泄漏', () => {
  const out = maskValue('zhangsan@example.com', 'email');
  assert.notEqual(out, 'zhangsan@example.com');
  assert.match(out, /@/, '应保留 @ 便于辨识');
  assert.equal(out.includes('zhangsan'), false, `本地部分未遮蔽：${out}`);
});

test('maskValue：身份证号脱敏', () => {
  const out = maskValue('110101199003078515', 'idCard');
  assert.notEqual(out, '110101199003078515');
  assert.equal(out.includes('19900307'), false, `出生日期泄漏：${out}`);
});

// ── 值模式识别（字段名无辜但值本身是凭证）────────────────────

test('maskValue：即便字段名无害，值形如 API key 也要遮蔽', () => {
  const out = maskValue('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'note');
  assert.equal(out.includes('AAAAAAAA'), false, `按值识别失败，密钥泄漏：${out}`);
});

// ── 非敏感字段不得被误伤 ───────────────────────────────────────

test('maskValue：普通字段原样保留（脱敏不能把日志变成无用的星号）', () => {
  assert.equal(maskValue('dev', 'env'), 'dev');
  assert.equal(maskValue('订单页白屏', 'title'), '订单页白屏');
  assert.equal(maskValue(42, 'count'), 42);
  assert.equal(maskValue(true, 'enabled'), true);
  assert.equal(maskValue(null, 'whatever'), null);
});

test('maskValue：短值不做前后保留式脱敏（否则等于没遮）', () => {
  const out = maskValue('abc', 'token');
  assert.equal(out.includes('abc'), false, `短凭证仍泄漏：${out}`);
});

// ── 递归 ───────────────────────────────────────────────────────

test('maskDeep：递归处理嵌套对象与数组', () => {
  const r = maskDeep({
    env: 'dev',
    user: { phone: '13812345678', password: 'hunter2hunter2' },
    list: [{ token: 'tok_abcdefghijklmn' }, { note: 'ok' }],
  });
  assert.equal(r.env, 'dev');
  assert.equal(r.user.phone, '138****5678');
  assert.equal(r.user.password.includes('hunter2'), false);
  assert.equal(r.list[0].token.includes('abcdefghij'), false);
  assert.equal(r.list[1].note, 'ok');
});

test('maskDeep：不修改入参（避免把脱敏结果写回业务对象）', () => {
  const src = { password: 'hunter2hunter2' };
  maskDeep(src);
  assert.equal(src.password, 'hunter2hunter2', '入参被就地改写了');
});

test('maskDeep：标量与 null 原样返回，不抛异常', () => {
  assert.equal(maskDeep(null), null);
  assert.equal(maskDeep(5), 5);
  assert.equal(maskDeep('x'), 'x');
  assert.equal(maskDeep(undefined), undefined);
});

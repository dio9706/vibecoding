import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTrustedOpenIds, isTrustedSubmitter } from './trusted-ids.js';

test('resolveTrustedOpenIds：单 open_id → 单元素数组；空 → 空数组', () => {
  assert.deepEqual(resolveTrustedOpenIds('ou_abc'), ['ou_abc']);
  assert.deepEqual(resolveTrustedOpenIds(''), []);
  assert.deepEqual(resolveTrustedOpenIds(undefined), []);
});

test('resolveTrustedOpenIds：传对象（旧签名误用）不得产出对象元素', () => {
  // 回归锚点：曾有 4 处调用点传 bot 对象进来，导致 includes(openId) 永远 false，
  // 可信名单门禁静默失效，只剩 role==='owner' 生效。
  const out = resolveTrustedOpenIds({ id: 'bot_x' });
  assert.deepEqual(out, [], '非字符串一律视为未配置');
});

test('resolveTrustedOpenIds：首尾空白归一化，纯空白视为未配置', () => {
  // trim 在正常路径上冗余（setMyFeishuOpenId 写入时已 trim），这里钉住是防手改
  // settings.json / 历史脏数据：'  ' 若原样入列会变成永不匹配的幽灵名单成员
  assert.deepEqual(resolveTrustedOpenIds(' ou_a '), ['ou_a']);
  assert.deepEqual(resolveTrustedOpenIds('   '), []);
});

test('resolveTrustedOpenIds：传数组同样视为未配置', () => {
  // 函数名是复数、返回数组，但入参是单个字符串 —— 传数组是相当自然的误用，
  // 把「传数组=未配置」固化成契约，而不是留作意外行为
  assert.deepEqual(resolveTrustedOpenIds(['ou_a', 'ou_b']), []);
});

test('isTrustedSubmitter：owner 直通', () => {
  assert.equal(isTrustedSubmitter({ user: { id: 'ou_x', role: 'owner' } }, []), true);
});

test('isTrustedSubmitter：名单命中', () => {
  assert.equal(isTrustedSubmitter({ user: { id: 'ou_a', role: 'guest' } }, ['ou_a']), true);
});

test('isTrustedSubmitter：名单不命中 / 无 id / 名单非数组', () => {
  assert.equal(isTrustedSubmitter({ user: { id: 'ou_b', role: 'guest' } }, ['ou_a']), false);
  assert.equal(isTrustedSubmitter({ user: { role: 'guest' } }, ['ou_a']), false);
  assert.equal(isTrustedSubmitter({ user: { id: 'ou_a', role: 'guest' } }, 'ou_a'), false);
});

test('isTrustedSubmitter：空 id 永不命中，即便名单里也有空串', () => {
  // 名单读到脏数据（空串）时不能靠 includes('') 蒙混过关：无身份就是不可信
  assert.equal(isTrustedSubmitter({ user: { id: '', role: 'guest' } }, ['']), false);
});

test('isTrustedSubmitter：空 ctx / 无 user 不炸也不放行', () => {
  // 事件解析失败时 ctx 可能退化成 {}，门禁要静默拒绝而不是抛错打穿调用方
  assert.equal(isTrustedSubmitter({}, ['ou_a']), false);
  assert.equal(isTrustedSubmitter(undefined, ['ou_a']), false);
});

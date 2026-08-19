import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONV_CARD_KIND, parseConvCardAction, matchSupplementText, isEndSessionText, matchSessionText, canOperateRelay } from './logic.js';

test('parseConvCardAction：对象 value 正常解析', () => {
  const r = parseConvCardAction({
    action: { value: { kind: CONV_CARD_KIND, convId: 'c1', action: 'supplement' } },
    operator: { open_id: 'ou_1' },
    context: { open_message_id: 'om_1' },
  });
  assert.deepEqual(r, { convId: 'c1', action: 'supplement', operatorOpenId: 'ou_1', messageId: 'om_1' });
});

test('parseConvCardAction：JSON 字符串 value 也认；顶层 message_id 兜底', () => {
  const r = parseConvCardAction({
    action: { value: JSON.stringify({ kind: CONV_CARD_KIND, convId: 'c2', action: 'end' }) },
    operator: { open_id: 'ou_2' },
    message_id: 'om_2',
  });
  assert.equal(r.convId, 'c2');
  assert.equal(r.action, 'end');
  assert.equal(r.messageId, 'om_2');
});

test('parseConvCardAction：别的 kind / 畸形 / 未知 action 一律 null', () => {
  assert.equal(parseConvCardAction({ action: { value: { kind: 'review-verdict', taskId: 't' } } }), null);
  assert.equal(parseConvCardAction({ action: { value: '不是json' } }), null);
  assert.equal(parseConvCardAction({ action: { value: { kind: CONV_CARD_KIND, convId: 'c', action: 'drop' } } }), null);
  assert.equal(parseConvCardAction(null), null);
});

test('matchSupplementText：只匹配开头，且要有非空正文', () => {
  assert.equal(matchSupplementText('补充内容 把按钮改成蓝色'), '把按钮改成蓝色');
  assert.equal(matchSupplementText('补充内容：再加一个筛选'), '再加一个筛选');
  assert.equal(matchSupplementText('补充内容'), null); // 只发前缀不算
  assert.equal(matchSupplementText('补充内容   '), null);
  assert.equal(matchSupplementText('我补充内容如下：xxx'), null); // 不在开头
  assert.equal(matchSupplementText(''), null);
  assert.equal(matchSupplementText(null), null);
});

test('isEndSessionText：trim 后全等才算', () => {
  assert.equal(isEndSessionText(' 结束会话 '), true);
  assert.equal(isEndSessionText('结束会话吧'), false);
  assert.equal(isEndSessionText('请结束会话'), false);
});

test('matchSessionText：正常匹配 8 位 ID + 正文', () => {
  const result = matchSessionText('会话 a1b2c3d4 我要补充内容');
  assert.deepEqual(result, { shortId: 'a1b2c3d4', body: '我要补充内容' });
});

test('matchSessionText：超过 8 位 ID 也匹配', () => {
  const result = matchSessionText('会话 a1b2c3d4e5f6g7h8 详细说明');
  assert.deepEqual(result, { shortId: 'a1b2c3d4e5f6g7h8', body: '详细说明' });
});

test('matchSessionText：少于 8 位 ID 不匹配', () => {
  const result = matchSessionText('会话 a1b2c3 内容');
  assert.equal(result, null);
});

test('matchSessionText：不是「会话」开头不匹配', () => {
  const result = matchSessionText('我要说 a1b2c3d4 内容');
  assert.equal(result, null);
});

test('matchSessionText：空格不足不匹配', () => {
  const result = matchSessionText('会话a1b2c3d4内容');
  assert.equal(result, null);
});

test('matchSessionText：非字符串输入返回 null', () => {
  assert.equal(matchSessionText(null), null);
  assert.equal(matchSessionText(123), null);
  assert.equal(matchSessionText(undefined), null);
  assert.equal(matchSessionText({}), null);
});

test('matchSessionText：trim 会话前后空格', () => {
  const result = matchSessionText('  会话 a1b2c3d4 内容  ');
  assert.deepEqual(result, { shortId: 'a1b2c3d4', body: '内容' });
});

test('matchSessionText：正文可包含多空格', () => {
  const result = matchSessionText('会话 abc12345 我 想  要   多个   空格');
  assert.deepEqual(result, { shortId: 'abc12345', body: '我 想  要   多个   空格' });
});

test('canOperateRelay：本人/owner/可信名单放行，其他人拒绝', () => {
  const opts = { myOpenId: 'ou_me', ownerOpenIds: ['ou_owner'], trustedOpenIds: ['ou_trust'] };
  assert.equal(canOperateRelay('ou_me', opts), true);
  assert.equal(canOperateRelay('ou_owner', opts), true);
  assert.equal(canOperateRelay('ou_trust', opts), true);
  assert.equal(canOperateRelay('ou_other', opts), false);
  assert.equal(canOperateRelay('', opts), false);
});

test('canOperateRelay：名单传成非数组的 truthy 值不抛错，按空名单处理', () => {
  // 配置读坏时可能传对象/字符串：`x || []` 拦不住，会在 .includes 上抛穿门禁调用方
  const bad = { myOpenId: 'ou_me', ownerOpenIds: {}, trustedOpenIds: 'ou_x' };
  assert.equal(canOperateRelay('ou_other', bad), false);
  assert.equal(canOperateRelay('ou_x', bad), false); // 字符串不当名单用，避免子串误放行
  assert.equal(canOperateRelay('ou_me', bad), true); // 本人仍放行
  assert.equal(canOperateRelay('ou_any', { ownerOpenIds: null, trustedOpenIds: undefined }), false);
});

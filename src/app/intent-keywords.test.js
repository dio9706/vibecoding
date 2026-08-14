/**
 * 强意图前缀单测 —— 收缩后的零成本快路。
 * 铁律：只匹配消息开头；长文中间出现关键词绝不命中（历史事故：接口文档整篇贴入被误判为故障）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchStrongIntent } from './intent-keywords.js';

test('需求前缀：各种说法都命中 feature，并剥出正文', () => {
  const cases = [
    ['提交需求：登录页加记住密码', '登录页加记住密码'],
    ['提交需求: 登录页加记住密码', '登录页加记住密码'],
    ['提个需求，登录页加记住密码', '登录页加记住密码'],
    ['提一个需求 登录页加记住密码', '登录页加记住密码'],
    ['有个需求：登录页加记住密码', '登录页加记住密码'],
    ['有一个需求 登录页加记住密码', '登录页加记住密码'],
    ['提需求：登录页加记住密码', '登录页加记住密码'],
    ['需求：登录页加记住密码', '登录页加记住密码'],
  ];
  for (const [input, body] of cases) {
    assert.deepEqual(matchStrongIntent(input), { type: 'feature', body }, `输入：${input}`);
  }
});

test('故障前缀：各种说法都命中 bug，bug 大小写不敏感', () => {
  const cases = [
    ['提交故障：扫码页白屏', '扫码页白屏'],
    ['提个故障 扫码页白屏', '扫码页白屏'],
    ['有个故障：扫码页白屏', '扫码页白屏'],
    ['提交BUG：扫码页白屏', '扫码页白屏'],
    ['提个bug，扫码页白屏', '扫码页白屏'],
    ['有个Bug：扫码页白屏', '扫码页白屏'],
    ['报个bug：扫码页白屏', '扫码页白屏'],
    ['提交问题：扫码页白屏', '扫码页白屏'],
    ['故障：扫码页白屏', '扫码页白屏'],
    ['bug：扫码页白屏', '扫码页白屏'],
  ];
  for (const [input, body] of cases) {
    assert.deepEqual(matchStrongIntent(input), { type: 'bug', body }, `输入：${input}`);
  }
});

test('问询前缀：各种说法都命中 question', () => {
  const cases = [
    ['问个问题：订单状态怎么流转', '订单状态怎么流转'],
    ['问一个问题 订单状态怎么流转', '订单状态怎么流转'],
    ['想问一下，订单状态怎么流转', '订单状态怎么流转'],
    ['问一下 订单状态怎么流转', '订单状态怎么流转'],
    ['请问订单状态怎么流转', '订单状态怎么流转'],
    ['有个疑问：订单状态怎么流转', '订单状态怎么流转'],
    ['咨询一下 订单状态怎么流转', '订单状态怎么流转'],
  ];
  for (const [input, body] of cases) {
    assert.deepEqual(matchStrongIntent(input), { type: 'question', body }, `输入：${input}`);
  }
});

test('裸词（需求/故障/bug/咨询）必须带标点分隔符 → 陈述句不命中，交给 L3', () => {
  // 真实反例：这些都是「陈述/闲聊」而非提交诉求，旧版分隔符可零长 → 全被误立案。
  for (const t of [
    '需求文档我已经发你了',
    'bug 我已经修好了，不用管',
    '故障已经恢复了，谢谢',
    '咨询过产品了，他说不用做',
    '需求评审会改到明天',
    'bug 复现不了，先放着',
    '故障单我关了',
  ]) {
    assert.equal(matchStrongIntent(t), null, `期望不命中：${t}`);
  }
});

test('裸词带标点分隔符仍命中（规格 §3.2 的「需求：」「故障：」「bug：」写法）', () => {
  assert.deepEqual(matchStrongIntent('需求：登录页加记住密码'), { type: 'feature', body: '登录页加记住密码' });
  assert.deepEqual(matchStrongIntent('故障，扫码页白屏'), { type: 'bug', body: '扫码页白屏' });
  assert.deepEqual(matchStrongIntent('bug：扫码页白屏'), { type: 'bug', body: '扫码页白屏' });
  assert.deepEqual(matchStrongIntent('BUG - 扫码页白屏'), { type: 'bug', body: '扫码页白屏' });
  assert.deepEqual(matchStrongIntent('咨询：订单状态怎么流转'), { type: 'question', body: '订单状态怎么流转' });
});

test('请问一下 / 想问下 等变体：正文剥离正确（前缀必须完整收进词表）', () => {
  const cases = [
    ['请问一下这个怎么用', '这个怎么用'],
    ['请问一下，这个怎么用', '这个怎么用'],
    ['想问下这个怎么用', '这个怎么用'],
    ['想问一下这个怎么用', '这个怎么用'],
    ['想问问这个怎么用', '这个怎么用'],
    ['请问这个怎么用', '这个怎么用'],
  ];
  for (const [input, body] of cases) {
    assert.deepEqual(matchStrongIntent(input), { type: 'question', body }, `输入：${input}`);
  }
});

test('「想问」收紧为「想问一下/想问下/想问问」→ 裸「想问」不再吃掉正文', () => {
  assert.equal(matchStrongIntent('想问过他了'), null);
  assert.equal(matchStrongIntent('想问题都是这样'), null);
});

test('只发前缀不带正文 → 命中且 body 为空串（调用方据此追问）', () => {
  assert.deepEqual(matchStrongIntent('提交需求'), { type: 'feature', body: '' });
  assert.deepEqual(matchStrongIntent('提交故障：'), { type: 'bug', body: '' });
  assert.deepEqual(matchStrongIntent('问个问题 '), { type: 'question', body: '' });
});

test('关键词出现在长文中间 → 不命中（避免整篇文档被误判）', () => {
  const long = '这是本次联调的接口文档，若有需求：请联系产品；如遇bug：请提工单。' + '字'.repeat(200);
  assert.equal(matchStrongIntent(long), null);
});

test('歧义表达不入词表 → 不命中，交给语义分类', () => {
  for (const t of ['有个问题想跟你说', '这个不能用了', '希望能优化一下', '登录页白屏了', '今天天气不错']) {
    assert.equal(matchStrongIntent(t), null, `期望不命中：${t}`);
  }
});

test('前导空白/表情不影响命中', () => {
  assert.deepEqual(matchStrongIntent('  提交需求：加导出'), { type: 'feature', body: '加导出' });
  assert.deepEqual(matchStrongIntent('👍 提交故障：白屏'), { type: 'bug', body: '白屏' });
});

test('空/非字符串输入 → null（不抛错）', () => {
  assert.equal(matchStrongIntent(''), null);
  assert.equal(matchStrongIntent(null), null);
  assert.equal(matchStrongIntent(undefined), null);
});

test('重复调用结果稳定（正则无 g flag 的回归保护）', () => {
  const t = '提交需求：加导出';
  assert.deepEqual(matchStrongIntent(t), matchStrongIntent(t));
  assert.deepEqual(matchStrongIntent(t), { type: 'feature', body: '加导出' });
});

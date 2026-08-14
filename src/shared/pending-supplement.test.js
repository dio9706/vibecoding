import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armSupplement, peekSupplement, takeSupplement, clearSupplement, matchSupplementText } from './pending-supplement.js';

test('arm 后可 peek 到，label 与执行器都在', () => {
  armSupplement('ou_a', { label: '会话《测试》', onText: async (t) => t });
  const e = peekSupplement('ou_a');
  assert.equal(e.label, '会话《测试》');
  assert.equal(typeof e.onText, 'function');
  clearSupplement('ou_a');
});

test('take 取走后即清空（一次性）', async () => {
  armSupplement('ou_b', { label: 'x', onText: async () => 'ran' });
  const e = takeSupplement('ou_b');
  assert.equal(await e.onText(), 'ran');
  assert.equal(peekSupplement('ou_b'), null);
});

test('TTL 过期不命中，且顺手清理', () => {
  armSupplement('ou_c', { label: 'x', onText: async () => {}, ttlMs: -1 });
  assert.equal(peekSupplement('ou_c'), null);
  assert.equal(takeSupplement('ou_c'), null);
});

test('同一 openId 后 arm 覆盖前 arm（单槽）', async () => {
  armSupplement('ou_d', { label: '旧', onText: async () => '旧' });
  armSupplement('ou_d', { label: '新', onText: async () => '新' });
  const e = takeSupplement('ou_d');
  assert.equal(e.label, '新');
  assert.equal(await e.onText(), '新');
});

test('clear 幂等，未 arm 时 peek/take 返回 null', () => {
  clearSupplement('ou_never');
  assert.equal(peekSupplement('ou_never'), null);
  assert.equal(takeSupplement('ou_never'), null);
});

// matchSupplementText 自 feishu-relay/logic.js 上移至此（会话域与任务域共用），
// 原处再导出 → feishu-relay 侧行为与测试不变；这里补一份内核侧的直测。
test('matchSupplementText：只匹配开头，且要有非空正文', () => {
  assert.equal(matchSupplementText('补充内容 把按钮改成蓝色'), '把按钮改成蓝色');
  assert.equal(matchSupplementText('补充内容：再加一个筛选'), '再加一个筛选');
  assert.equal(matchSupplementText('补充内容'), null); // 只发前缀不算
  assert.equal(matchSupplementText('我补充内容如下：xxx'), null); // 不在开头
  assert.equal(matchSupplementText(''), null);
  assert.equal(matchSupplementText(null), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCredential } from './run-openai.js';

/**
 * openai-compat 凭证解析。
 *
 * 起因是个真串台 bug：model 由前端按用户点的 pill 传入，凭证却走 pickActive
 * 取「第一条可用的」，两者来源不同。多厂商共存时，点智谱发出 model=glm-4，
 * 配上的却是 DeepSeek 的 apiKey/baseURL——请求打到 api.deepseek.com 去要
 * 一个 glm-4，必然 400，而错误信息里完全看不出是凭证配错了。
 */

const DEEPSEEK = { id: 'tk_ds', providerId: 'openai-compat', label: 'DeepSeek', token: 'sk-ds', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', status: 'healthy' };
const ZHIPU = { id: 'tk_zp', providerId: 'openai-compat', label: '智谱', token: 'sk-zp', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4', status: 'healthy' };
const CLAUDE = { id: 'tk_c', providerId: 'claude-agent', label: '我', token: 'oauth-x', status: 'healthy' };
const ALL = [DEEPSEEK, ZHIPU, CLAUDE];

test('credId 精确命中：不受列表顺序影响', () => {
  const r = resolveCredential(ALL, { credId: 'tk_zp', model: 'glm-4' });
  assert.equal(r.cred.id, 'tk_zp');
  assert.equal(r.reason, 'by-id');
});

// 这条就是原 bug 的回归防线：DeepSeek 排在前面，点智谱不能拿到 DeepSeek 的 key
test('回归：选后面的凭证不会被前面的顶替（原串台 bug）', () => {
  const r = resolveCredential(ALL, { credId: 'tk_zp', model: 'glm-4' });
  assert.equal(r.cred.token, 'sk-zp');
  assert.equal(r.cred.baseURL, 'https://open.bigmodel.cn/api/paas/v4');
});

test('无 credId（老前端/老会话）：按 model 唯一匹配', () => {
  const r = resolveCredential(ALL, { model: 'glm-4' });
  assert.equal(r.cred.id, 'tk_zp');
  assert.equal(r.reason, 'by-model');
});

// 同 model 多条（同厂商两个 key）无从判断用哪条，挑一条等于赌 —— 交给 pickActive 的确定顺序
test('同 model 多条时不猜，落到 pickActive', () => {
  const dup = { ...DEEPSEEK, id: 'tk_ds2', token: 'sk-ds2', label: 'DeepSeek 备用' };
  const r = resolveCredential([DEEPSEEK, dup], { model: 'deepseek-chat' });
  assert.equal(r.reason, 'fallback-active');
  assert.equal(r.cred.id, 'tk_ds'); // pickActive = 顺序最靠前的 healthy
});

test('credId 指向已删凭证：退到 model 匹配，reason 变化以便上层提示', () => {
  const r = resolveCredential(ALL, { credId: 'tk_gone', model: 'glm-4' });
  assert.equal(r.cred.id, 'tk_zp');
  assert.notEqual(r.reason, 'by-id'); // 上层据此告知用户「指定凭证已不存在」
});

test('credId 与 model 都失配：兜底 pickActive，不空手而归', () => {
  const r = resolveCredential(ALL, { credId: 'tk_gone', model: 'no-such-model' });
  assert.equal(r.reason, 'fallback-active');
  assert.equal(r.cred.id, 'tk_ds');
});

test('只挑 openai-compat：claude-agent 条目绝不会被选中', () => {
  const r = resolveCredential([CLAUDE], { model: 'deepseek-chat' });
  assert.equal(r.cred, null);
  assert.equal(r.reason, 'none');
});

test('缺 providerId 的旧条目按 claude-agent 处理，不误入 openai 池', () => {
  const legacy = { id: 'tk_old', label: '旧号', token: 'x', status: 'healthy' };
  const r = resolveCredential([legacy], { credId: 'tk_old' });
  assert.equal(r.cred, null);
});

test('空池 / 非数组输入不抛错', () => {
  assert.equal(resolveCredential([], { credId: 'x' }).cred, null);
  assert.equal(resolveCredential(null, {}).cred, null);
  assert.equal(resolveCredential(undefined, { model: 'm' }).reason, 'none');
});

test('exhausted 凭证：credId 指名仍照用（用户明确选了它，由上层报限流）', () => {
  const dead = { ...ZHIPU, status: 'exhausted' };
  const r = resolveCredential([DEEPSEEK, dead], { credId: 'tk_zp', model: 'glm-4' });
  assert.equal(r.cred.id, 'tk_zp');
  assert.equal(r.reason, 'by-id');
});

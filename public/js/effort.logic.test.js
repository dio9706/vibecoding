/**
 * 强度/Ultracode 纯逻辑单测：两套档位、回落规则、Ultracode 语义。
 * 这里钉的是「哪些值能被选、选完变成什么」——UI 只是壳。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_EFFORTS,
  EFFORT_OFF,
  ULTRACODE,
  effortLabel,
  effortOptions,
  pickEffort,
  isEffortValid,
  applyEffortChoice,
  effortDesc,
  effortTickLabel,
  rehomeCustomCred,
} from './effort.logic.js';

test('effortLabel：已知档位中文标签；未知值原样显示', () => {
  assert.equal(effortLabel('low'), '低');
  assert.equal(effortLabel('xhigh'), '极高');
  assert.equal(effortLabel('max'), 'Max');
  assert.equal(effortLabel(EFFORT_OFF), '关闭思考');
  assert.equal(effortLabel(ULTRACODE), '✨ Ultracode');
  assert.equal(effortLabel('weird'), 'weird');
  assert.equal(effortLabel(''), '');
});

test('effortOptions：Claude = 五档 + Ultracode 档；顺序稳定', () => {
  assert.deepEqual(effortOptions({ provider: 'claude-agent' }), [...CLAUDE_EFFORTS, ULTRACODE]);
});

test('effortOptions：自定义 = none + supported_levels；无元数据 → 空（置灰）', () => {
  assert.deepEqual(effortOptions({ provider: 'openai-compat', efforts: ['low', 'high', 'max'] }), ['none', 'low', 'high', 'max']);
  assert.deepEqual(effortOptions({ provider: 'openai-compat', efforts: [' low ', '', 'high'] }), ['none', 'low', 'high']);
  assert.deepEqual(effortOptions({ provider: 'openai-compat', efforts: [] }), []);
  assert.deepEqual(effortOptions({ provider: 'openai-compat' }), []);
});

test('pickEffort：合法值保留；自定义优先 defaultEffort 再第一档；Claude 回落 medium', () => {
  // 合法保留
  assert.equal(pickEffort({ provider: 'claude-agent', current: 'high' }), 'high');
  assert.equal(pickEffort({ provider: 'openai-compat', efforts: ['low', 'high'], current: 'none' }), 'none');
  // 自定义：current 非法 → defaultEffort；无 default → 第一档（none 在最前，但 isEffortValid 保证语义）
  assert.equal(pickEffort({ provider: 'openai-compat', efforts: ['low', 'high', 'max'], defaultEffort: 'high', current: 'ultracode' }), 'high');
  assert.equal(pickEffort({ provider: 'openai-compat', efforts: ['low', 'high'], current: 'xhigh' }), 'low');
  assert.equal(pickEffort({ provider: 'openai-compat', efforts: ['low', 'high'], current: 'none' }), 'none', 'none 是合法值，不被回落');
  // Claude：非法 → medium
  assert.equal(pickEffort({ provider: 'claude-agent', current: 'none' }), 'medium');
  // 无档位：原样保留（控件置灰）
  assert.equal(pickEffort({ provider: 'openai-compat', efforts: [], current: 'high' }), 'high');
});

test('isEffortValid：Claude 五档 + ultracode；自定义含 none 不含 ultracode；无元数据一律 false', () => {
  assert.equal(isEffortValid('max', { provider: 'claude-agent' }), true);
  assert.equal(isEffortValid(ULTRACODE, { provider: 'claude-agent' }), true);
  assert.equal(isEffortValid('none', { provider: 'claude-agent' }), false);
  assert.equal(isEffortValid('none', { provider: 'openai-compat', efforts: ['low'] }), true);
  assert.equal(isEffortValid('low', { provider: 'openai-compat', efforts: ['low'] }), true);
  assert.equal(isEffortValid('max', { provider: 'openai-compat', efforts: ['low'] }), false);
  assert.equal(isEffortValid(ULTRACODE, { provider: 'openai-compat', efforts: ['low'] }), false);
  assert.equal(isEffortValid('high', { provider: 'openai-compat', efforts: [] }), false);
});

test('applyEffortChoice：Ultracode 档 = 开编排 + 强制 xhigh；其他档关闭编排', () => {
  assert.deepEqual(applyEffortChoice(ULTRACODE), { effort: 'xhigh', ultracode: true });
  assert.deepEqual(applyEffortChoice('high'), { effort: 'high', ultracode: false });
  assert.deepEqual(applyEffortChoice('none'), { effort: 'none', ultracode: false });
});

test('effortDesc：已知档位一句话说明；未知值空串（强度面板描述行）', () => {
  assert.equal(effortDesc('low'), '更快');
  assert.equal(effortDesc('max'), '最强');
  assert.equal(effortDesc(EFFORT_OFF), '不进行深度思考');
  assert.equal(effortDesc(ULTRACODE), '多智能体编排');
  assert.equal(effortDesc('weird'), '');
  assert.equal(effortDesc(undefined), '');
});

test('effortTickLabel：Ultracode 收成 ✨；其余与 effortLabel 一致（刻度横向空间紧）', () => {
  assert.equal(effortTickLabel(ULTRACODE), '✨');
  assert.equal(effortTickLabel('xhigh'), '极高');
  assert.equal(effortTickLabel(EFFORT_OFF), '关闭思考');
});

// ── 凭证归属认领：强度能否出档的前置条件（认不到 = 控件只能显示「—」）────────
const CREDS = [
  { id: 'cred-1', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner', efforts: ['low', 'high'] }] },
  { id: 'cred-2', models: [{ id: 'glm-4' }] },
];

test('rehomeCustomCred：credId 命中就用它（claimed=false，不改写 localStorage）', () => {
  assert.deepEqual(rehomeCustomCred({ creds: CREDS, credId: 'cred-2', model: 'glm-4' }), { id: 'cred-2', claimed: false });
  // 命中优先于 model 认领：即使 model 挂在别的凭证上也不漂移
  assert.deepEqual(rehomeCustomCred({ creds: CREDS, credId: 'cred-1', model: 'glm-4' }), { id: 'cred-1', claimed: false });
});

test('rehomeCustomCred：credId 有值但凭证已删 → null（回落 Claude，不串到别的凭证）', () => {
  assert.equal(rehomeCustomCred({ creds: CREDS, credId: 'cred-gone', model: 'deepseek-chat' }), null);
});

test('rehomeCustomCred：credId 为空（老用户升级路径）→ 按 model 唯一认领', () => {
  assert.deepEqual(rehomeCustomCred({ creds: CREDS, credId: '', model: 'deepseek-reasoner' }), { id: 'cred-1', claimed: true });
  assert.deepEqual(rehomeCustomCred({ creds: CREDS, model: 'glm-4' }), { id: 'cred-2', claimed: true });
});

test('rehomeCustomCred：同名模型挂多条凭证 / 模型不在任何凭证 → null（宁可不认，也不配错 key）', () => {
  const dup = [
    { id: 'a', models: [{ id: 'glm-4' }] },
    { id: 'b', models: [{ id: 'glm-4' }] },
  ];
  assert.equal(rehomeCustomCred({ creds: dup, model: 'glm-4' }), null);
  assert.equal(rehomeCustomCred({ creds: CREDS, model: 'nope' }), null);
});

test('rehomeCustomCred：凭证列表未取到（null）/ 形状坏 → null，不抛', () => {
  assert.equal(rehomeCustomCred({ creds: null, credId: '', model: 'deepseek-chat' }), null);
  assert.equal(rehomeCustomCred({ creds: [null, {}, { id: 'x' }], model: 'deepseek-chat' }), null);
  assert.deepEqual(rehomeCustomCred({ creds: [{ id: 'x', models: null }], model: 'x' }), null);
  assert.deepEqual(rehomeCustomCred({}), null);
});

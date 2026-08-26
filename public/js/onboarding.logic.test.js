/**
 * 新用户引导的纯逻辑单测。
 * isNewUser：靠 settings.tokens 是否为空判定「还没配任何模型」。
 * validateOnboardForm：模型段必填（按 Tab 分支），飞书两段选填但「填了就要填全」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewUser, validateOnboardForm } from './onboarding.logic.js';

// ---- isNewUser ----

test('isNewUser：tokens 为空数组 → 新用户', () => {
  assert.equal(isNewUser({ tokens: [] }), true);
});

test('isNewUser：有任意 token → 老用户', () => {
  assert.equal(isNewUser({ tokens: [{ id: 't1' }] }), false);
});

// tokens 是两类模型（Claude 账号池 / openai-compat 凭证）的唯一存储，
// 所以一个 openai-compat 凭证也足以判定为老用户
test('isNewUser：只有 openai-compat 凭证也算老用户（共用 tokens 存储）', () => {
  assert.equal(isNewUser({ tokens: [{ id: 'c1', providerId: 'openai-compat' }] }), false);
});

// 脏数据/字段缺失按「未配置」处理：宁可多引导一次，也不要让真新用户
// 掉进一个必然报错的界面
test('isNewUser：字段缺失/非数组/入参为空 → 按新用户处理', () => {
  assert.equal(isNewUser({}), true);
  assert.equal(isNewUser({ tokens: 'x' }), true);
  assert.equal(isNewUser({ tokens: null }), true);
  assert.equal(isNewUser(null), true);
  assert.equal(isNewUser(undefined), true);
});

// ---- validateOnboardForm：模型段（必填）----

const CLAUDE_OK = { modelTab: 'claude', claude: { token: 'sk-ant-oat01-abc' } };
const CUSTOM_OK = {
  modelTab: 'custom',
  custom: { apiKey: 'sk-x', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
};

test('模型段 claude Tab：token 有值 → 通过', () => {
  const r = validateOnboardForm(CLAUDE_OK);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, {});
});

test('模型段 claude Tab：token 空/纯空格/缺失 → 报错', () => {
  assert.match(validateOnboardForm({ modelTab: 'claude', claude: { token: '' } }).errors.model, /Token/);
  assert.match(validateOnboardForm({ modelTab: 'claude', claude: { token: '   ' } }).errors.model, /Token/);
  assert.match(validateOnboardForm({ modelTab: 'claude', claude: {} }).errors.model, /Token/);
  assert.match(validateOnboardForm({ modelTab: 'claude' }).errors.model, /Token/);
});

test('模型段 custom Tab：三项齐 → 通过', () => {
  const r = validateOnboardForm(CUSTOM_OK);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, {});
});

test('模型段 custom Tab：缺 apiKey / baseURL / model 各自报错', () => {
  const mk = (patch) => ({ modelTab: 'custom', custom: { ...CUSTOM_OK.custom, ...patch } });
  assert.match(validateOnboardForm(mk({ apiKey: '' })).errors.model, /API Key/);
  assert.match(validateOnboardForm(mk({ baseURL: '' })).errors.model, /Base URL/);
  assert.match(validateOnboardForm(mk({ model: '' })).errors.model, /模型/);
});

// modelTab 缺失/非法时按 claude 分支走：默认 Tab 就是 Claude 账号，
// 不能因为一个脏枚举值把校验整段跳过、放一个空模型进去
test('模型段：modelTab 缺失或非法 → 按 claude 分支校验', () => {
  assert.match(validateOnboardForm({}).errors.model, /Token/);
  assert.match(validateOnboardForm({ modelTab: 'wat' }).errors.model, /Token/);
  assert.equal(validateOnboardForm({ modelTab: 'wat', claude: { token: 'x' } }).ok, true);
});

// ---- validateOnboardForm：open_id（选填）----

test('open_id：空 → 通过；正常值 → 通过', () => {
  assert.equal(validateOnboardForm({ ...CLAUDE_OK, openId: '' }).ok, true);
  assert.equal(validateOnboardForm({ ...CLAUDE_OK, openId: 'ou_abc123' }).ok, true);
});

test('open_id：超 128 字符 → 报错（对齐后端上限）', () => {
  const r = validateOnboardForm({ ...CLAUDE_OK, openId: 'o'.repeat(129) });
  assert.equal(r.ok, false);
  assert.match(r.errors.openId, /128/);
});

test('open_id：正好 128 字符 → 通过（边界）', () => {
  assert.equal(validateOnboardForm({ ...CLAUDE_OK, openId: 'o'.repeat(128) }).ok, true);
});

// ---- validateOnboardForm：机器人（选填，填了就要填全）----

const APP_ID = 'cli_0123456789abcdef';

test('机器人：三字段全空 → 视为未填，通过', () => {
  const r = validateOnboardForm({ ...CLAUDE_OK, bot: { name: '', appId: '', appSecret: '' } });
  assert.equal(r.ok, true);
  assert.equal(r.errors.bot, undefined);
});

test('机器人：appId + appSecret 齐 → 通过', () => {
  assert.equal(
    validateOnboardForm({ ...CLAUDE_OK, bot: { name: '助手', appId: APP_ID, appSecret: 's' } }).ok,
    true,
  );
});

// 只填了名称就动了这一段，此时缺 appId 必须拦住 ——
// 放过去就是拿一个后端存不进的半截配置去调 /api/bots
test('机器人：只填名称 → 要求补 App ID', () => {
  const r = validateOnboardForm({ ...CLAUDE_OK, bot: { name: '助手' } });
  assert.equal(r.ok, false);
  assert.match(r.errors.bot, /App ID/);
});

test('机器人：appId 格式非法 → 报错（对齐后端 cleanBotInput）', () => {
  const bad = ['cli_123', 'cli_0123456789abcdeg', 'xxx_0123456789abcdef', 'cli_0123456789ABCDEF0'];
  for (const appId of bad) {
    const r = validateOnboardForm({ ...CLAUDE_OK, bot: { appId, appSecret: 's' } });
    assert.equal(r.ok, false, `${appId} 应被拒`);
    assert.match(r.errors.bot, /App ID/);
  }
});

test('机器人：appId 大写十六进制合法', () => {
  assert.equal(
    validateOnboardForm({ ...CLAUDE_OK, bot: { appId: 'cli_0123456789ABCDEF', appSecret: 's' } }).ok,
    true,
  );
});

test('机器人：appId 填了但 secret 空 → 报错', () => {
  const r = validateOnboardForm({ ...CLAUDE_OK, bot: { appId: APP_ID, appSecret: '' } });
  assert.equal(r.ok, false);
  assert.match(r.errors.bot, /Secret/);
});

// ---- 多段同时出错 ----

test('多段同时出错 → errors 各段独立可读', () => {
  const r = validateOnboardForm({
    modelTab: 'claude',
    claude: { token: '' },
    openId: 'o'.repeat(200),
    bot: { name: '助手' },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.model, /Token/);
  assert.match(r.errors.openId, /128/);
  assert.match(r.errors.bot, /App ID/);
});

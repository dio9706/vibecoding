import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunAction } from './permission.js';

// 背景：ActionConfig.permission 此前是**死字段**——全仓无任何代码读取它，
// executeAction 直接跑脚本。管理员在设置页选的 Guest/Owner 只是摆设，
// 任意员工一句含关键词的话即可触发破坏性脚本（如 reset_onboarding.py 删用户数据）。
// 角色取值只有两种：'owner'（在 OWNER_OPEN_IDS 白名单内）与 'guest'。

test('canRunAction：permission=owner 时仅 owner 可执行', () => {
  const cfg = { permission: 'owner' };
  assert.equal(canRunAction(cfg, 'owner'), true);
  assert.equal(canRunAction(cfg, 'guest'), false);
});

test('canRunAction：permission=guest 表示「guest 及以上」，owner 也应放行', () => {
  const cfg = { permission: 'guest' };
  assert.equal(canRunAction(cfg, 'guest'), true);
  // 关键回归：旧 dispatch 的 `f.permission === ctx.user.role` 全等语义会让 owner 反而被挡，
  // 权限档是「最低要求」而非「精确匹配」。
  assert.equal(canRunAction(cfg, 'owner'), true);
});

test('canRunAction：permission=any 对所有角色放行', () => {
  const cfg = { permission: 'any' };
  assert.equal(canRunAction(cfg, 'guest'), true);
  assert.equal(canRunAction(cfg, 'owner'), true);
});

test('canRunAction：permission 缺失时 fail-closed（收窄到 owner），不得默认放行', () => {
  assert.equal(canRunAction({}, 'guest'), false);
  assert.equal(canRunAction({ permission: undefined }, 'guest'), false);
  assert.equal(canRunAction({ permission: null }, 'guest'), false);
  assert.equal(canRunAction({}, 'owner'), true);
});

test('canRunAction：非法/未知 permission 值 fail-closed', () => {
  assert.equal(canRunAction({ permission: 'everyone' }, 'guest'), false);
  assert.equal(canRunAction({ permission: '__proto__' }, 'guest'), false);
  assert.equal(canRunAction({ permission: 123 }, 'guest'), false);
});

test('canRunAction：未知角色一律拒绝（不把陌生角色当 owner）', () => {
  assert.equal(canRunAction({ permission: 'guest' }, 'anonymous'), false);
  assert.equal(canRunAction({ permission: 'any' }, 'anonymous'), false);
  assert.equal(canRunAction({ permission: 'owner' }, undefined), false);
});

test('canRunAction：配置为空不抛异常，判负', () => {
  assert.equal(canRunAction(null, 'owner'), false);
  assert.equal(canRunAction(undefined, 'owner'), false);
});

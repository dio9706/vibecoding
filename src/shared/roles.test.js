import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRole } from './roles.js';

/**
 * 角色判定回归 —— 线上事故（app-2026-09-0{1,2,3}.log，共 4 次）：
 *
 *   [WARN] [action-runner] 权限不足，拒绝执行 |
 *     {"actionName":"清理账号数据","role":"member","required":"guest"}
 *
 * 卡片按钮回调把 role 写死成 'member'，而 permission.js 的 ROLE_RANK 只认 guest/owner，
 * 未知角色一律判负 —— 于是欢迎卡上的按钮对**所有人**都是死的，连 permission:'guest'
 * 这种最低门槛的动作也点不动。修复的前提是：角色判定只能有一份，消息链路与卡片回调共用。
 */
describe('resolveRole', () => {
  const OWNERS = ['ou_owner_a', 'ou_owner_b'];

  it('名单内的 open_id → owner', () => {
    assert.equal(resolveRole('ou_owner_a', OWNERS), 'owner');
    assert.equal(resolveRole('ou_owner_b', OWNERS), 'owner');
  });

  it('名单外的 open_id → guest（而不是 member 之类不在权限表里的值）', () => {
    assert.equal(resolveRole('ou_someone_else', OWNERS), 'guest');
  });

  it('缺 open_id → guest（fail-safe：降到最低档，不外推也不返回未知值）', () => {
    assert.equal(resolveRole(null, OWNERS), 'guest');
    assert.equal(resolveRole(undefined, OWNERS), 'guest');
    assert.equal(resolveRole('', OWNERS), 'guest');
  });

  it('名单读坏成非数组 → 不得在 .includes 上打穿，一律 guest', () => {
    assert.equal(resolveRole('ou_owner_a', null), 'guest');
    assert.equal(resolveRole('ou_owner_a', undefined), 'guest');
    assert.equal(resolveRole('ou_owner_a', 'ou_owner_a'), 'guest');
  });

  it('返回值只可能是 permission.js 的 ROLE_RANK 认识的两个值', () => {
    const seen = new Set([
      resolveRole('ou_owner_a', OWNERS),
      resolveRole('ou_x', OWNERS),
      resolveRole(null, []),
    ]);
    for (const r of seen) assert.ok(['owner', 'guest'].includes(r), `非法角色值：${r}`);
  });
});

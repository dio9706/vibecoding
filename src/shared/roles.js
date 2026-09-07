/**
 * 飞书身份 → 角色判定。**全项目唯一一份**（纯函数 + 一层读配置的薄包装）。
 *
 * 为什么必须住在 shared：这套判定原先只长在飞书入口 `entrypoints/feishu/index.js#roleOf` 里，
 * 而卡片回调走的是 `plugins/action-runner/card-action.js` —— 插件不能 import 入口层
 *（分层单向依赖），于是那里干脆写死了 `role: 'member'`，并留下一句「canRunAction 会再判权限」
 * 的错误注释。事实是 `permission.js` 的 ROLE_RANK 只认 guest/owner，未知角色一律判负，
 * 结果欢迎卡上的按钮对所有人都点不动（生产实证：09-01 两次、09-02 一次、09-03 一次
 * `权限不足，拒绝执行 | {"role":"member","required":"guest"}`）。
 *
 * 判定只有一份，两条链路（消息 / 卡片回调）共用，才不会再次分叉。
 * 形状对齐同模块的 `trusted-ids.js`：纯函数在前，读配置的包装在后。
 */
import { config } from './config.js';

/**
 * 纯函数：open_id 是否在 owner 白名单里。
 *
 * fail-safe 到 guest（而不是抛错或返回未知值）：名单读坏、字段缺失都只该**降权**，
 * 绝不能产出一个 `permission.js` 不认识的角色 —— 那会让权限判定整体失效（本次事故的形状）。
 * 名单非数组时不走 `.includes`：配置读坏时那会直接抛，把门禁打穿成 500。
 *
 * @param {unknown} openId
 * @param {unknown} ownerOpenIds owner 白名单（期望 string[]）
 * @returns {'owner'|'guest'}
 */
export function resolveRole(openId, ownerOpenIds) {
  if (!openId || typeof openId !== 'string') return 'guest';
  if (!Array.isArray(ownerOpenIds)) return 'guest';
  return ownerOpenIds.includes(openId) ? 'owner' : 'guest';
}

/**
 * 按当前配置判定角色（`OWNER_OPEN_IDS`，经 `config.lark.ownerOpenIds`）。
 * @param {unknown} openId
 * @returns {'owner'|'guest'}
 */
export function roleOf(openId) {
  return resolveRole(openId, config.lark.ownerOpenIds);
}

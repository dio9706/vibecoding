/**
 * 卡片回调 kind 注册表 —— 按钮 value.kind → 处理器（如 feedback 的 review-verdict）。
 *
 * 独立小模块而非放 feishu 入口：各插件与入口都要 import，
 * 放入口会形成 entrypoint → features → plugins → entrypoint 的环，
 * 且 web 进程 import 入口模块会误触发飞书 channel.start 等模块级副作用。
 *
 * **本模块只提供机制，不含任何 kind 的实现。** 处理器一律由各插件在自己的模块里注册
 * （feishu-relay 的会话卡、feedback 的评审结论、task-notify 的任务卡、action-runner 的快捷动作），
 * 这样插件停用时对应的 kind 自然就没有处理器 —— 与「停用插件不载入业务代码」一致。
 *
 * 曾经 `quick-action` 的实现直接写在这里并 import 了 action-runner 插件，
 * 造成 `shared → plugins` 的分层倒挂；已迁至 `plugins/action-runner/card-action.js`。
 */

const handlers = new Map();

/** 注册 kind 处理器（插件模块加载时调用；重复注册后者覆盖前者） */
export function registerCardKindHandler(kind, handler) {
  handlers.set(kind, handler);
}

/** 取 kind 处理器；未注册返回 null（如插件被停用未加载） */
export function getCardKindHandler(kind) {
  return handlers.get(kind) || null;
}

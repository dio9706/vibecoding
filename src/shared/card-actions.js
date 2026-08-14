/**
 * 卡片回调 kind 注册表 —— 按钮 value.kind → 处理器（如 feedback 的 review-verdict）。
 * 独立小模块而非放 feishu 入口：feedback 等插件与入口都要 import，
 * 放入口会形成 entrypoint → features → plugins → entrypoint 的环，
 * 且 web 进程 import 入口模块会误触发飞书 channel.start 等模块级副作用。
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

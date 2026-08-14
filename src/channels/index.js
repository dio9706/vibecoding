/**
 * Channel 默认注册表 —— 组装层统一从这里 get(id)。
 * 新增渠道（QQ / 微信）= 实现契约 + 在此 register 一次，dispatch/features 无需改动。
 */
import { createRegistry } from './registry.js';
import { createFeishuChannel } from './feishu.js';
import { createConsoleChannel } from './console.js';

const registry = createRegistry();
registry.register(createFeishuChannel());
registry.register(createConsoleChannel()); // 开发调试渠道（契约第二实现；entrypoints/console 使用）

// 方法用闭包捕获内部 map（不依赖 this），解构导出安全
export const { register, get, has, list } = registry;
export { registry };

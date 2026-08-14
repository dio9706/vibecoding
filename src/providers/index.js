/**
 * Provider 默认注册表 —— 内核统一从这里 get(id).run(...)。
 * 新增 provider = 在此 register 一次，内核与调用方无需改动。
 */
import { createRegistry } from './registry.js';
import { claudeAgentProvider } from './claude-agent.js';
import { openaiCompatProvider } from './openai-compat.js';

const registry = createRegistry();
registry.register(claudeAgentProvider);
registry.register(openaiCompatProvider);

// 方法用闭包捕获内部 map（不依赖 this），解构导出安全
export const { register, get, has, list } = registry;
export { registry };

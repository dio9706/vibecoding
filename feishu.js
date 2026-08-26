/**
 * 飞书入口薄启动器 —— 实际实现见 src/entrypoints/feishu/index.js。
 *
 * `node --env-file=.env feishu.js` 依然可用，但**不再是必须的**：loadAppEnv 会兜底加载 .env，
 * 且 process.loadEnvFile 不覆盖已存在的键 —— 显式 --env-file 传进来的值仍然优先。
 * 之所以不再依赖那个参数：它只写在注释里，漏打一次就静默丢掉全部配置（2026-08-26 事故）。
 */
import { loadAppEnv } from './src/shared/load-env.js';

// 在业务模块之前：config.js 模块求值即读 env，静态 import 会抢在本行之前跑
loadAppEnv();

await import('./src/entrypoints/feishu/index.js');

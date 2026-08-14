/**
 * 功能装配 —— 内核 feature（claude-exec）+ 启用插件的 features 按 order 合并。
 * 业务功能一律走插件挂载（src/plugins/，settings.plugins 启停），此处不再登记业务 feature。
 * 顺序影响匹配优先级：owner 兜底(match) / 意图匹配(intents) 由 dispatch 统一处理。
 */
import claudeExec from './claude-exec/index.js';
import { assembleFeatures, loadEnabledPluginFeatures } from '../plugins/index.js';

const CORE = [
  { order: 20, feature: claudeExec }, // owner 全接（task-triage 插件以 order=10 抢占在前）
];

export const features = assembleFeatures(CORE, await loadEnabledPluginFeatures());

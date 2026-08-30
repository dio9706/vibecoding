/**
 * 动作执行插件 —— 配置驱动的通用动作（脚本 + 槽位填充，取代旧 data-cleanup）。
 * 业务代码就在本插件目录内（Phase 2 已物理搬迁）。
 */
import actionRunner from './feature/index.js';
// 副作用 import：模块加载即把 quick-action 的卡片回调处理器注册进 shared/card-actions 的表。
// 与 feishu-relay / feedback / task-notify 的做法一致。
import './card-action.js';

export default {
  id: 'action-runner',
  features: [{ order: 30, feature: actionRunner }],
};

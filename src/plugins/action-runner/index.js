/**
 * 动作执行插件 —— 配置驱动的通用动作（脚本 + 槽位填充，取代旧 data-cleanup）。
 * 业务代码就在本插件目录内（Phase 2 已物理搬迁）。
 */
import actionRunner from './feature/index.js';

export default {
  id: 'action-runner',
  features: [{ order: 30, feature: actionRunner }],
};

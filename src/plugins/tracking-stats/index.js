/**
 * 埋点统计插件装配。
 *
 * order 16：必须小于内核 claude-exec(20)，否则「帮我统计埋点: …」这类消息会被
 * claude-exec 先接走；与 bug-patrol(12)/status-report(14) 同属前缀指令区间。
 */
import trackingStats from './feature.js';

export default {
  id: 'tracking-stats',
  features: [{ order: 16, feature: trackingStats }],
};

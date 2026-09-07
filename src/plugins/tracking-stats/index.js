/**
 * 埋点统计插件装配 —— 两条并行路径。
 *
 * order 16/17：必须小于内核 claude-exec(20)，否则这两类前缀消息会被 claude-exec 先接走；
 * 与 bug-patrol(12)/status-report(14) 同属前缀指令区间。
 *
 * 两条路径**不是替换关系**（见 spec `docs/superpowers/specs/2026-09-07-data-qa-freeform-design.md`）：
 * - `帮我统计埋点:`（16）— 闭合 QuerySpec → 固定 SQL → 精美 HTML 报告，处理标准埋点报表。
 * - `帮我查数据:`（17）— 只读 Agent 多轮探 schema 自己写 SQL → 文字结论，处理长尾自由问题。
 *
 * 两者前缀互不包含，谁在前都不会互抢；仍显式错开 order，让「先匹配谁」是写定的而非偶然。
 */
import trackingStats from './feature.js';
import trackingFreeform from './freeform.js';

export default {
  id: 'tracking-stats',
  features: [
    { order: 16, feature: trackingStats },
    { order: 17, feature: trackingFreeform },
  ],
};

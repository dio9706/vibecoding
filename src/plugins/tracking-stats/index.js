/**
 * 埋点统计插件装配。
 *
 * order 16：必须小于内核 claude-exec(20)，否则这类前缀消息会被 claude-exec 先接走；
 * 与 bug-patrol(12)/status-report(14) 同属前缀指令区间。
 *
 * ## 只挂一个 feature（2026-09-07 合并）
 *
 * `帮我查数据:` 与 `帮我统计埋点:` 现在**都走 freeform**（只读 Agent 多轮探表、自己写 SQL）。
 *
 * 老的 `feature.js` 已不再注册，原因不是它坏了，而是它的形态天生受限：只有两条写死的
 * SQL（事件 PV/UV、页面 PV/UV），凡是超出这两种形状的问题都答不了。为此它配了一套
 * 「能力边界 + 越界降级为 PV/UV」的机制，而这套机制实测有害 —— 用户问「某个用户的操作
 * 路径」，拿回一份标题被换成「事件与页面 PV/UV 汇总」的全站报告，看上去像是返回了上一次
 * 的结果（两次降级报告的通用标题与默认区间完全一样）。
 *
 * 给答非所问的替代品，比直说做不到更糟：它消耗了用户几分钟等待，还要他自己看出来
 * 这份报告回答的是另一个问题。而 freeform 能真正答这类问题，「边界」这个概念对它不成立。
 *
 * **`feature.js` / `tracking_report.py` / `understand.js` / `logic.js` 都原样留在盘上**，
 * 想恢复只需在下面 features 数组里加回 `{ order: 16, feature: trackingStats }`。
 * 保留它们的实际理由：`tracking_report.py` 那份 Python 渲染的图表报告
 *（折线图 + KPI 卡片 + 明细表）目前 freeform 产不出同等质量，日后可能会被接回来当工具用。
 */
import trackingFreeform from './freeform.js';

export default {
  id: 'tracking-stats',
  features: [{ order: 16, feature: trackingFreeform }],
};

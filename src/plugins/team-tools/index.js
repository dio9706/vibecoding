/**
 * 团队工具插件 —— 需求/故障收集（feedback）+ owner 待办分诊（task-triage）+ 项目问答（project-qa）
 * + 可信提交人专属指令（bug-patrol \10001 / status-report \10002 / create-session \10003，触发文案严格匹配）。
 * order 对齐原 features/index.js 顺序：task-triage(10) 必须在内核 claude-exec(20) 之前抢占 owner match；
 * bug-patrol(12)/create-session(13)/status-report(14) 同理必须排在 claude-exec 之前，否则可信人的指令消息会被全接；
 * project-qa(90) 只接显式问询意图（intent=question）；未识别消息由 dispatch 回引导文案，不再走读码问答。
 */
import taskTriage from './task-triage/index.js';
import bugPatrol from './bug-patrol/index.js';
import createSession from './create-session/index.js';
import statusReport from './status-report/index.js';
import feedback from './feedback/index.js';
import projectQa from './project-qa/index.js';

export default {
  id: 'team-tools',
  features: [
    { order: 10, feature: taskTriage },
    { order: 12, feature: bugPatrol },
    { order: 13, feature: createSession },
    { order: 14, feature: statusReport },
    { order: 40, feature: feedback },
    { order: 90, feature: projectQa },
  ],
};

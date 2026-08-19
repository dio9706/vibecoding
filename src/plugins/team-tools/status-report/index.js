/**
 * feature: 当前任务清单（\10002，可信提交人专属）。
 * 触发文案严格匹配（零 LLM）→ 纯本地读盘汇总：运行中对话（active-runs.json，pid 存活过滤孤儿）
 * + 需求/故障活跃任务 + 待确认合并，仅列标题和进度。一次性无状态查询。
 */
import path from 'node:path';
import { listActiveRuns, isPidAlive } from '../../../store/active-runs.js';
import { listHistorySessions } from '../../../store/history.js';
import { getTasks } from '../../../store/tasks.js';
import { getMyFeishuOpenId } from '../../../store/settings.js';
import { resolveTrustedOpenIds, isTrustedSubmitter } from '../../../shared/trusted-ids.js';
import { matchesExactTrigger } from '../trusted-trigger.js';
import { logger } from '../../../shared/logger.js';
import { STATUS_TRIGGERS, groupTasks, minutesSince, buildStatusReport } from './logic.js';

/**
 * 解析各 run 的会话标题：按 cwd 分组只扫一次历史目录，session_id 匹配取 title；
 * 拿不到（新会话 onInit 未回填 / 历史读取失败）用「目录名 · 模型」兜底，绝不因标题失败丢整个清单。
 */
async function resolveRunTitles(runs) {
  const byCwd = new Map();
  for (const r of runs) {
    const key = r.cwd || '';
    if (!byCwd.has(key)) byCwd.set(key, []);
    byCwd.get(key).push(r);
  }
  const out = [];
  for (const [cwd, group] of byCwd) {
    let sessions = [];
    try {
      sessions = await listHistorySessions(100, 0, cwd);
    } catch (e) {
      logger.warn('status-report', '读取会话历史失败（用兜底标题）', { cwd, err: e?.message || String(e) });
    }
    for (const r of group) {
      const hit = r.session_id ? sessions.find((s) => s.sessionId === r.session_id) : null;
      const fallback = `${path.basename(cwd || '') || '默认目录'} · ${r.model || 'auto'}`;
      out.push({
        title: (hit?.title || '').trim() || fallback,
        minutes: minutesSince(r.startedAt),
      });
    }
  }
  return out;
}

export default {
  name: 'status-report',
  permission: 'any', // match 自带可信门禁
  intents: [],
  // 全等比较在前，isTrusted 要读设置，别让每条消息都付这个成本
  match: (ctx) =>
    matchesExactTrigger(ctx.text, STATUS_TRIGGERS) &&
    isTrustedSubmitter(ctx, resolveTrustedOpenIds(getMyFeishuOpenId())),
  handle: async (ctx) => {
    // pid 存活过滤：崩溃残留的孤儿条目不算「正在进行」（缺 pid 的旧条目同样排除）
    const runs = listActiveRuns().filter((e) => isPidAlive(e?.pid));
    const titled = await resolveRunTitles(runs);
    const { active, merge } = groupTasks(getTasks());
    logger.info('status-report', '任务清单', { runs: titled.length, active: active.length, merge: merge.length });
    return ctx.reply(buildStatusReport({ runs: titled, active, merge }));
  },
};

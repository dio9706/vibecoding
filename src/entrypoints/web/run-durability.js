/**
 * Run 生命周期落盘接线（T2-P5：run-index 成为崩溃恢复的唯一来源，active-runs 已退役）—— 两件事：
 *   1. 注册 journal sink：`store/runs.js` 的事件经 `store/run-journal.js` 追加落盘；
 *   2. run 锚点写 `run-index`（`mirrorRunStart/Patch/Remove/RunsRemove`，语义与旧 active-runs 镜像一一对应）。
 *
 * 由 web 入口在 listen 回调里调用 `startRunDurability()`（与 startConvNotify 同范式，幂等）。
 * 旧 active-runs.json 的升级迁移在 `store/run-index.js#migrateLegacyActiveRuns`，由启动对账
 * （run-claude.js#reconcileRuns）调用——不要在这里迁移：recover 先于本函数执行。
 *
 * 失败纪律：journal / run-index 都是**尽力而为的持久化**——写失败一律吞掉并留日志，
 * 绝不改变主流程语义（run 收尾、SSE、恢复主链）。最坏结果是「崩溃后该 run 不自动续跑」，
 * 比「磁盘抖动打挂对话」可接受得多；openai 路径的索引直写早就是同一取舍。
 */
import { logger } from '../../shared/logger.js';
import { registerRunJournalSink } from '../../store/runs.js';
import { appendRunEvent } from '../../store/run-journal.js';
import { upsertRun, patchRun, removeRun, removeRuns } from '../../store/run-index.js';

let _started = false;

/** 注册 journal sink（幂等；重复调用不重复注册——否则同一事件会落多条） */
export function startRunDurability() {
  if (_started) return;
  _started = true;
  registerRunJournalSink((event) => {
    try {
      appendRunEvent(event);
    } catch (e) {
      logger.warn('web', 'run 事件落盘失败（已忽略）', {
        runId: event?.runId || null,
        type: event?.type || null,
        err: e?.message || String(e),
      });
    }
  });
}

/** 无 run 对象的独立事件（如熔断 abandoned）：直写 journal，写失败吞掉 */
export function appendStandaloneRunEvent(convId, type, data) {
  try {
    appendRunEvent({ v: 1, seq: 0, runId: null, convId: convId || null, at: Date.now(), type, data: data || {} });
  } catch (e) {
    logger.warn('web', 'run 事件独立落盘失败（已忽略）', { convId: convId || null, type, err: e?.message || String(e) });
  }
}

/** run-index 写口统一兜底：失败吞掉并留日志（见文件头失败纪律） */
function guarded(op, fn) {
  try {
    fn();
  } catch (e) {
    logger.warn('web', `run-index ${op} 失败（已忽略）`, { err: e?.message || String(e) });
  }
}

/** 登记 run（P5 起索引是唯一恢复来源；写失败吞掉，最坏该 run 崩溃后不自动续） */
export function mirrorRunStart(entry) {
  guarded('upsert', () => upsertRun(entry));
}

/** 补写字段（如 onInit 回填 session_id） */
export function mirrorRunPatch(runId, patch) {
  guarded('patch', () => patchRun(runId, patch));
}

/** run 收尾：摘除索引；失败时残留条目由启动对账按 journal settled 摘掉 */
export function mirrorRunRemove(runId) {
  guarded('remove', () => removeRun(runId));
}

/** 批量移除（孤儿回收自对账使用；保留给测试/历史调用方） */
export function mirrorRunsRemove(runIds) {
  guarded('remove-many', () => removeRuns(runIds));
}

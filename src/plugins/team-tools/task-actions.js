/**
 * 任务分支的「合并到主分支 / 放弃改动」编排 —— web 路由与飞书任务卡片按钮共用。
 *
 * 原实现内联在 src/entrypoints/web/routes-ops.js 的 handleTaskAction 里。飞书侧要在
 * 「任务完成卡片」上给同样的两个按钮，若各写一份，两条入口的状态机迟早分叉
 * （典型后果：飞书合并后忘了写 mergedAt/mergeError，web 面板显示的还是「待合并」）。
 *
 * 边界：**插件启用判断（getPluginEnabled('team-tools')）留在各入口层**，本模块只管任务
 * 本身的编排——同一段编排在 web 是 HTTP 404，在飞书是「不回话」，处置方式本就不同。
 */
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { getTask, updateTask } from '../../store/tasks.js';
import { getActiveBot } from '../../store/settings.js';
import { mergeBranch, deleteBranch } from './auto-dev/git.js';
import { revertMergeCommit } from './auto-dev/revert.js';

/** 待合并谓词：自动开发完成、未合并，且分支与基线分支齐全——只有这种任务才谈得上合并 */
export function isAwaitingMerge(task) {
  return !!(task && task.auto && task.status === 'done' && !task.merged && task.branch && task.baseBranch);
}

/**
 * 可放弃谓词：自动完成、有分支、尚未放弃过。**合并前后都成立** ——
 * 未合并删分支即可；已合并则走 revert 撤销（见 discardTaskById），两者都是「放弃」。
 * 刻意不要求 baseBranch：分支还在就删得掉，没记住合并目标不该妨碍放弃。
 *
 * 独立导出而不是让调用方各写一遍条件：飞书卡片要据此给出「已不在可放弃态」的友好短路，
 * 与 discardTaskById 内部判据一旦分叉，就会出现「卡片说能放弃、点了却被挡回」的错位。
 */
export function isDiscardable(task) {
  return !!(task && task.auto && task.status === 'done' && task.branch && !task.discarded);
}

/**
 * 取任务开发时快照的 repo（防此后切换启用机器人导致在错误仓库找/删分支）；
 * 旧数据没有快照才回落到当前启用机器人 → 全局配置。
 */
function repoOf(task) {
  return task.repo || getActiveBot()?.projectDir || config.feedback.frontendDir;
}

/**
 * 合并任务分支到基线分支。
 * @param {string} id 任务 id
 * @param {{auto?:boolean}} opts auto=true 表示由 auto-dev 管线自动触发（仅影响面板/卡片文案）
 * @returns {Promise<{ok:boolean, code:200|400|404|409, error?:string, task?:object, hookBypassed?:boolean}>}
 */
export async function mergeTaskById(id, opts = {}) {
  const task = getTask(id);
  if (!task) return { ok: false, code: 404, error: '任务不存在' };
  if (!isAwaitingMerge(task)) {
    return { ok: false, code: 400, error: '任务不满足合并条件（须为自动完成且未合并）' };
  }
  const repo = repoOf(task);
  const r = await mergeBranch(repo, task.branch, task.baseBranch);
  if (!r.ok) {
    // r.error 自带「合并冲突：」/「合并失败：」前缀，别再套一层前缀（曾出现「合并失败：合并冲突：…」）
    const t = updateTask(task.id, { mergeError: r.error }, r.error);
    logger.warn('task-actions', '任务合并失败', { id: task.id, err: r.error });
    return { ok: false, code: 409, error: r.error, task: t };
  }
  const t = updateTask(
    task.id,
    {
      merged: true,
      mergedAt: new Date().toISOString(),
      mergeError: null,
      // 放弃改动要靠它精确 revert；合并那一刻不记，事后无从反推
      // （基线分支上可能已叠了别的任务的合并提交）。取不到时为空串，不是缺失
      mergeCommit: r.mergeCommit || '',
      autoMerged: opts.auto === true,
    },
    `已合并 ${task.branch} → ${task.baseBranch}` +
      // 钩子被绕过必须让人看见：merge commit 未过目标仓库的 commit-msg/pre-merge-commit 校验
      (r.hookBypassed ? '（提交钩子拦截，已跳过钩子校验完成合并）' : ''),
  );
  logger.info('task-actions', '任务已合并', {
    id: task.id,
    branch: task.branch,
    base: task.baseBranch,
    hookBypassed: !!r.hookBypassed,
    auto: opts.auto === true,
  });
  return { ok: true, code: 200, task: t, hookBypassed: !!r.hookBypassed };
}

/**
 * 放弃改动。按是否已合并分两条路（条件见 isDiscardable）：
 * - 未合并：删任务分支（分支从未进主干，删掉即撤销）
 * - 已合并：在基线分支上 revert 掉那次合并，成功后再删任务分支
 *
 * 任一路径失败都**不改任务状态**——绝不留「已放弃但改动还在主干上」的半放弃态。
 * @returns {Promise<{ok:boolean, code:200|400|404|409, error?:string, task?:object}>}
 */
export async function discardTaskById(id) {
  const task = getTask(id);
  if (!task) return { ok: false, code: 404, error: '任务不存在' };
  if (!isDiscardable(task)) {
    return { ok: false, code: 400, error: '任务不满足放弃条件（须为自动完成且未放弃）' };
  }
  const repo = repoOf(task);

  // ── 已合并：改动在基线分支上，删分支撤不回任何东西 ──
  if (task.merged) {
    const rv = await revertMergeCommit(repo, { task, mergeCommit: task.mergeCommit || '' });
    if (!rv.ok) {
      logger.warn('task-actions', '撤销已合并改动失败', { id: task.id, err: rv.error });
      return { ok: false, code: 409, error: rv.error, task };
    }
    // 改动已撤，任务分支再留着只会让人误以为还有东西可合；删除失败不影响结论，仅告警
    const del = await deleteBranch(repo, task.branch);
    if (!del.ok) logger.warn('task-actions', '撤销后删除任务分支失败（不影响撤销结果）', { id: task.id, err: del.error });

    const now = new Date().toISOString();
    const t = updateTask(
      task.id,
      {
        status: 'rejected',
        rejectedBy: 'owner',
        discarded: true,
        discardedAt: now,
        revertedAt: now,
        revertedBy: rv.by,
        mergeError: null,
      },
      // 不预设失败原因：无 mergeCommit 锚点时压根没跑过 git revert，说「冲突」是错的
      // （revert.js 的日志口径也已从「冲突」改为「失败」，非冲突的预检拒绝同样会走到 LLM 兜底）
      `放弃改动，已从 ${task.baseBranch} 撤销` + (rv.by === 'llm' ? '（由 AI 完成撤销）' : ''),
    );
    logger.info('task-actions', '任务已撤销已合并改动', { id: task.id, branch: task.branch, by: rv.by });
    return { ok: true, code: 200, task: t };
  }

  // ── 未合并：删分支即可（原逻辑，一行不动）──
  const r = await deleteBranch(repo, task.branch);
  if (!r.ok) {
    // 删分支失败不改状态：绝不留「已放弃但分支还在」的半放弃态
    logger.warn('task-actions', '任务放弃改动失败', { id: task.id, err: r.error });
    return { ok: false, code: 409, error: r.error, task };
  }
  const t = updateTask(
    task.id,
    { status: 'rejected', rejectedBy: 'owner', discarded: true, discardedAt: new Date().toISOString(), mergeError: null },
    `放弃改动，已删除分支 ${task.branch}`,
  );
  logger.info('task-actions', '任务已放弃改动', { id: task.id, branch: task.branch });
  return { ok: true, code: 200, task: t };
}

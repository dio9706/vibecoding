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

/** 待合并谓词：自动开发完成、未合并，且分支与基线分支齐全——只有这种任务才谈得上合并 */
export function isAwaitingMerge(task) {
  return !!(task && task.auto && task.status === 'done' && !task.merged && task.branch && task.baseBranch);
}

/**
 * 可放弃谓词：与合并同源（自动完成、未合并、有分支），但**不要求 baseBranch**——
 * 分支还在就删得掉，没记住合并目标不该妨碍放弃。
 * 独立导出而不是让调用方各写一遍条件：飞书卡片要据此给出「已不在可放弃态」的友好短路，
 * 与 discardTaskById 内部判据一旦分叉，就会出现「卡片说能放弃、点了却被挡回」的错位。
 */
export function isDiscardable(task) {
  return !!(task && task.auto && task.status === 'done' && !task.merged && task.branch);
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
 * @returns {Promise<{ok:boolean, code:200|400|404|409, error?:string, task?:object, hookBypassed?:boolean}>}
 */
export async function mergeTaskById(id) {
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
    { merged: true, mergedAt: new Date().toISOString(), mergeError: null },
    `已合并 ${task.branch} → ${task.baseBranch}` +
      // 钩子被绕过必须让人看见：merge commit 未过目标仓库的 commit-msg/pre-merge-commit 校验
      (r.hookBypassed ? '（提交钩子拦截，已跳过钩子校验完成合并）' : ''),
  );
  logger.info('task-actions', '任务已合并', {
    id: task.id,
    branch: task.branch,
    base: task.baseBranch,
    hookBypassed: !!r.hookBypassed,
  });
  return { ok: true, code: 200, task: t, hookBypassed: !!r.hookBypassed };
}

/**
 * 放弃改动：删除任务分支并把任务置为已放弃。条件见 isDiscardable。
 * @returns {Promise<{ok:boolean, code:200|400|404|409, error?:string, task?:object}>}
 */
export async function discardTaskById(id) {
  const task = getTask(id);
  if (!task) return { ok: false, code: 404, error: '任务不存在' };
  if (!isDiscardable(task)) {
    return { ok: false, code: 400, error: '任务不满足放弃条件（须为自动完成且未合并）' };
  }
  const repo = repoOf(task);
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

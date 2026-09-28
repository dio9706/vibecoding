/**
 * agent 改码的合并队列 —— **按 repo 串行**。
 *
 * 为什么只有合并要排队（改码不用）：worktree 隔离之后，两个 agent 任务在各自目录改码
 * 互不可见，可以并行；但 `mergeBranch` 会落到**主工作区**（git 不允许两个 worktree
 * 检出同一分支，而开发期主机人就在需求分支上），那里同一时刻只能有一个人动。
 *
 * 为什么按 repo 而不是全局：前后端是两个仓库，一个在合并没理由挡住另一个。
 *
 * `isClean` 闸防的是 `commitAll` 的 `add -A` 在主工作区吞掉主机未提交的改动 ——
 * 这是本仓已知大坑（`auto-dev/revert.js:114` 同款闸）。脏则**降级为待合并而非失败**：
 * 代码已经提交在分支上不会丢，主机清干净工作区后自己点合并即可。
 */
import { isClean as realIsClean, mergeBranch as realMergeBranch } from '../../plugins/team-tools/auto-dev/git.js';
import { logger } from '../../shared/logger.js';

/**
 * @param {{isClean?: Function, mergeBranch?: Function}} [deps] 注入便于单测
 */
export function createMergeQueue(deps = {}) {
  const isClean = deps.isClean || realIsClean;
  const mergeBranch = deps.mergeBranch || realMergeBranch;

  /** repo → 该 repo 上最后一个任务的 Promise（链式串联即串行） */
  const tails = new Map();

  async function runOne({ repo, branch, baseBranch }) {
    if (!(await isClean(repo))) {
      logger.warn('merge-queue', '主工作区不干净，降级为待合并', { repo, branch });
      return { ok: true, status: 'pending-merge', sha: null };
    }
    const r = await mergeBranch(repo, branch, baseBranch);
    if (!r?.ok) return { ok: false, status: 'failed', sha: null, error: r?.error || '合并失败' };
    // ⚠️ git.js 返回的字段叫 mergeCommit，不叫 sha；且它**取不到时是空串不是缺失**
    //（该函数 JSDoc 原话：「消费方要用 if (!mergeCommit) 而不是判字段存在」）。
    // 队列对外统一暴露 sha，空串一律归一成 null —— 撤销分派靠 null 判「还没合并」。
    return { ok: true, status: 'merged', sha: r.mergeCommit || null };
  }

  return {
    /**
     * 排队合并一个 agent 分支。
     * @returns {Promise<{ok, status:'merged'|'pending-merge'|'failed', sha, error?}>} **不抛**
     */
    enqueue(task) {
      const prev = tails.get(task.repo) || Promise.resolve();
      // 用 .then 而非 await prev：前一个任务的失败绝不能让后面的整条链断掉。
      // catch 收在 runOne 外层，保证 tails 上挂的永远是一个必定 resolve 的 Promise。
      const next = prev.then(() =>
        runOne(task).catch((e) => {
          logger.warn('merge-queue', '合并任务异常', { repo: task.repo, branch: task.branch, err: e?.message || String(e) });
          return { ok: false, status: 'failed', sha: null, error: e?.message || String(e) };
        }),
      );
      tails.set(task.repo, next.then(() => {}, () => {}));
      return next;
    },
  };
}

/** 进程内单例：合并的串行性必须全进程唯一，每次 new 一个等于没有队列 */
export const mergeQueue = createMergeQueue();

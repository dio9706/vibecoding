/**
 * 放弃「已合并进基线分支」的自动改动。
 *
 * 分支已经进了主干，删分支撤不回任何东西——必须在基线分支上做一次反向提交：
 *   1. git revert -m 1 <mergeCommit>：确定性操作，绝大多数情况一步到位、零额度消耗
 *   2. 失败（内容冲突，或工作区脏导致的预检拒绝）→ revert --abort，起 Claude 判断怎么安全撤
 *
 * 执行目录走 git.js#withBranchWorktree（与 mergeBranch 同一套路径 A/B 分流）：
 * 主工作区恰在基线分支上就原地做，否则建临时 worktree，完全不动主工作区。
 *
 * ⚠️ LLM 兜底的超时是「不再等」而不是「真的取消」：integrations/claude.js#runClaude 不支持
 * abortController（同 side-review 的既有结论），Promise.race 落空只是本函数不再等待那次调用，
 * 模型进程本身仍可能在后台继续写文件。两条路径下的后果不同：
 *   - 路径 A（主工作区原地执行）：超时返回后模型仍可能以 bypassPermissions 继续改用户的主工作区；
 *   - 路径 B（临时 worktree）：withBranchWorktree 的 finally 会立刻 worktree remove --force，
 *     Windows 上文件被模型占用时可能删除失败，留下一个已注册却半删的 worktree。
 * 目前没有真正的取消机制，也不要自己发明一个——这里只是如实记录这个缺口。
 */
import { runClaude } from '../../../integrations/claude.js';
import { claudeAuthOpts } from '../../../capabilities/token-rotation.js';
import { runScript } from '../../../integrations/shell.js';
import { logger } from '../../../shared/logger.js';
import { withBranchWorktree, branchExists, commitAll, isClean, headSha } from './git.js';
import { buildRevertPrompt, revertCommitMessage, REVERT_TIMEOUT_MS } from './revert.logic.js';

// shell:false —— 与 git.js 同款：参数直传 git.exe，含空格的消息不被 cmd 拆散
const git = (args) => runScript('git', args, { shell: false });

/**
 * 真实 LLM 调用：在 dir 里改码撤销（bypassPermissions —— 要动文件）。
 * 刻意不让模型自己 commit：提交由调用方 commitAll 统一做，那里有「无改动即失败」的校验。
 */
async function callLlmRevert({ dir, task, mergeCommit }) {
  let out = '';
  try {
    await runClaude(buildRevertPrompt({ task, mergeCommit }), {
      ...claudeAuthOpts(), // 跟随备用账号轮换（与 web run 同一 token 池）
      cwd: dir,
      permissionMode: 'bypassPermissions',
      persistSession: false, // 内部一次性调用不落盘 session
      onText: (t) => (out += t),
      onResult: (i) => {
        if (i.result) out = i.result;
      },
    });
    return { ok: true, log: out };
  } catch (e) {
    return { ok: false, error: `AI 撤销失败：${(e?.message || String(e)).slice(0, 200)}` };
  }
}

/**
 * 带超时的 LLM 兜底。超时不真正中断底层调用，只是不再等它——形式上与 side-review 的 race
 * 兜底相同，但 side-review 是只读调用，这里是 bypassPermissions 的写调用，超时后模型仍可能
 * 继续改动文件（两条路径各自的后果见文件头注释）。
 */
async function llmRevertWithTimeout(fn, args, timeoutMs) {
  const TIMEOUT = Symbol('timeout');
  let timer;
  try {
    const r = await Promise.race([
      fn(args),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      }),
    ]);
    if (r === TIMEOUT) return { ok: false, error: 'AI 撤销超时' };
    return r;
  } finally {
    // 调用先赢时计时器仍会挂到 timeoutMs 后才触发，不清会拖住进程退出
    clearTimeout(timer);
  }
}

/**
 * 撤销一次已合并的自动改动。
 *
 * @param {string} repo 主工作区路径
 * @param {{ task: object, mergeCommit: string }} p task 需含 baseBranch
 * @param {{ llmRevert?: Function, timeoutMs?: number }} opts 供测试注入
 * @returns {Promise<{ ok: boolean, by?: 'git'|'llm', error?: string }>}
 */
export async function revertMergeCommit(repo, { task, mergeCommit } = {}, opts = {}) {
  const { llmRevert = callLlmRevert, timeoutMs = REVERT_TIMEOUT_MS } = opts;
  const target = task?.baseBranch;
  if (!target) return { ok: false, error: '任务未记录基线分支，无法撤销已合并的改动' };
  if (!(await branchExists(repo, target))) return { ok: false, error: `基线分支不存在：${target}` };

  return withBranchWorktree(repo, target, '.revert-tmp', async (dir) => {
    // ── 路径 1：确定性 git revert ──
    if (mergeCommit) {
      const r = await git(['-C', dir, 'revert', '-m', '1', '--no-edit', mergeCommit]);
      if (r.ok) {
        logger.info('auto-dev', '已 git revert 撤销合并', { repo, target, mergeCommit });
        return { ok: true, by: 'git' };
      }
      // 幂等：未开始 revert 时非 0 但无副作用。不 abort 会把半 revert 态留给下一步的 AI
      await git(['-C', dir, 'revert', '--abort']);
      // 失败原因不止「冲突」——工作区脏导致的预检拒绝同样会走到这里，且不是内容冲突。
      // 不在这里用 `ls-files -u` 之类去区分：真冲突场景下用户脏文件照样会被卷走（见下面 isClean 闸），
      // 区分只能改善这行日志的措辞，挡不住实际风险，所以这里只改文案、不加判定逻辑。
      logger.warn('auto-dev', 'git revert 失败，转 AI 处理', {
        repo,
        target,
        mergeCommit,
        err: (r.err || r.out || '').slice(0, 200),
      });
    }

    // LLM 兜底会以 bypassPermissions 在 dir 里改码，随后 commitAll 走的是 add -A。
    // 路径 A 下 dir 就是用户的主工作区：脏则必须停手，否则（1）与本次撤销无关的未提交改动会被
    // 一起卷进 revert 提交；（2）下面那道「无改动即失败」的防谎报闸会被脏文件顶开，
    // 变成「什么都没撤销却报成功」。宁可报错转人工，绝不留半放弃态。
    if (!(await isClean(dir))) {
      return { ok: false, error: '工作区有未提交改动，无法安全撤销：请先提交或 stash 后重试' };
    }

    // ── 路径 2：LLM 兜底 ──
    const llm = await llmRevertWithTimeout(llmRevert, { dir, task, mergeCommit }, timeoutMs);
    if (!llm.ok) return { ok: false, error: llm.error || 'AI 撤销失败' };

    const c = await commitAll(dir, revertCommitMessage(task));
    // AI 说完成了但一行没改 —— 绝不谎报撤销成功，否则任务被标成已放弃而改动还在主干上
    if (!c.committed) return { ok: false, error: 'AI 未产生可提交的撤销改动' };
    // 事后审计要靠 sha 定位这次 LLM 撤销提交；取不到就留空串，绝不能因为取不到 sha 反过来判撤销失败
    const sha = await headSha(dir);
    logger.info('auto-dev', 'AI 已完成撤销并提交', { repo, target, sha });
    return { ok: true, by: 'llm' };
  });
}

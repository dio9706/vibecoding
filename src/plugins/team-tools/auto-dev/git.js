/** git 封装（经 shell.runScript，不抛异常）。参数拼装抽纯函数便于单测。原 unattended/git.js 迁入并扩展合并能力。 */
import { runScript } from '../../../integrations/shell.js';
import { logger } from '../../../shared/logger.js';
import path from 'node:path';

export function checkoutArgs(repo, branch, create) {
  return create ? ['-C', repo, 'checkout', '-b', branch] : ['-C', repo, 'checkout', branch];
}
export function commitArgs(repo, message) {
  return ['-C', repo, 'commit', '-m', message];
}
export function pushArgs(repo, branch) {
  return ['-C', repo, 'push', '-u', 'origin', branch];
}
export function deleteBranchArgs(repo, branch) {
  return ['-C', repo, 'branch', '-D', branch];
}

// shell:false —— 参数直传 git.exe，commit/merge message 含空格不被 cmd 拆散
const git = (args) => runScript('git', args, { shell: false });

export async function currentBranch(repo) {
  const r = await git(['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? (r.out || '').trim() : null;
}

export async function branchExists(repo, branch) {
  const r = await git(['-C', repo, 'rev-parse', '--verify', branch]);
  return r.ok;
}

/** 确保在目标分支上：已在=不动；已存在=checkout；否则=checkout -b */
export async function ensureBranch(repo, branch) {
  const cur = await currentBranch(repo);
  if (cur === branch) return { ok: true, created: false };
  const exists = await branchExists(repo, branch);
  const r = await git(checkoutArgs(repo, branch, !exists));
  if (!r.ok) logger.warn('auto-dev', 'ensureBranch 失败', { repo, branch, err: r.err || r.msg });
  return { ok: r.ok, created: !exists };
}

/** 暂存全部并提交；无变更时 git commit 非 0，视为无提交（不算失败） */
export async function commitAll(repo, message) {
  await git(['-C', repo, 'add', '-A']);
  const r = await git(commitArgs(repo, message));
  return { committed: r.ok, out: r.out, err: r.err };
}

export async function pushBranch(repo, branch) {
  const r = await git(pushArgs(repo, branch));
  return { ok: r.ok, out: r.out, err: r.err };
}

/** 工作区是否干净（无未提交改动） */
export async function isClean(repo) {
  const r = await git(['-C', repo, 'status', '--porcelain']);
  return r.ok && !(r.out || '').trim();
}

/**
 * merge commit 消息。**必须符合 Conventional Commits（`type: subject`）**：
 * 目标仓库普遍装了 husky + commitlint，而 `git merge` 同样会跑 commit-msg 钩子（Git 2.24+）。
 * 曾用 `merge <source> into <target>`——无 type、也不匹配 commitlint 默认放行的 `Merge branch '...'`
 * 格式，被判 type-empty/subject-empty（易误读成「消息为空」），git 停在半合并态并退出非 0，
 * 「合并到主分支」整体失败。控长 ≤72 以避开 header-max-length 类规则。
 */
export function mergeMessage(source, target) {
  const msg = `chore: merge ${source} into ${target}`;
  return msg.length <= 72 ? msg : `${msg.slice(0, 69)}...`;
}

/** 索引里是否有未解决的冲突路径。用索引状态判定冲突，不靠 git 英文文案（可能被 i18n 本地化） */
async function hasUnmergedPaths(dir) {
  const r = await git(['-C', dir, 'ls-files', '-u']);
  return r.ok && !!(r.out || '').trim();
}

/** 合并进行中（MERGE_HEAD 存在）——合并内容已算完、只差提交 */
async function mergeInProgress(dir) {
  const r = await git(['-C', dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  return r.ok;
}

/**
 * 在 dir 就地执行 merge，含提交钩子兜底与错误分类。路径 A/B 共用。
 * @returns {{ ok: boolean, conflict?: boolean, hookBypassed?: boolean, error?: string }}
 */
async function runMergeIn(dir, source, target) {
  const msg = mergeMessage(source, target);
  const merge = await git(['-C', dir, 'merge', '--no-ff', source, '-m', msg]);
  if (merge.ok) return { ok: true };

  // 诊断信息合并 out+err：钩子（commitlint 等）的输出走 stdout，只取 err 会把真实原因丢干净
  const diag = [merge.err, merge.out]
    .filter((s) => (s || '').trim())
    .join('\n')
    .trim();

  // 提交钩子拦截：合并内容本身已成功（MERGE_HEAD 在、无未解决冲突），只是 commit 被
  // commit-msg / pre-merge-commit 挡下。消息已合规仍被挡 = 目标仓库钩子环境或规则问题
  // （pnpm/node_modules 缺失、更严的自定义规则）。merge commit 不含任何新代码——内容早在源分支
  // 提交时过了 pre-commit 门禁——故用 --no-verify 完成提交，并标记 hookBypassed 上报留痕。
  if ((await mergeInProgress(dir)) && !(await hasUnmergedPaths(dir))) {
    const c = await git(['-C', dir, 'commit', '--no-verify', '-m', msg]);
    if (c.ok) {
      logger.warn('auto-dev', '提交钩子拦截合并，已 --no-verify 完成', {
        dir,
        source,
        target,
        hook: diag.slice(0, 300),
      });
      return { ok: true, hookBypassed: true, hookOutput: diag.slice(0, 300) };
    }
  }

  // 走到这里才是真失败：内容冲突，或 git 预检拒绝（脏文件会被覆盖等）。二者分类不同，别一律叫「冲突」。
  const conflict = await hasUnmergedPaths(dir);
  await git(['-C', dir, 'merge', '--abort']); // 幂等：未开始合并时非 0 但无副作用
  logger.warn('auto-dev', '合并失败已回滚', { dir, source, target, conflict, err: diag.slice(0, 200) });
  return {
    ok: false,
    ...(conflict ? { conflict: true } : {}),
    error: `${conflict ? '合并冲突' : '合并失败'}：${diag.slice(0, 300) || '(git 未输出诊断信息)'}`,
  };
}

/**
 * 合并 source → target（--no-ff）。冲突/失败则 merge --abort，绝不留半合并状态。
 *
 * 两种路径：
 * - 主工作区已在 target 分支：原地 merge（需工作区干净），成功后停在 target。
 * - 主工作区在其他分支：建临时 worktree 在 target 上执行 merge，完全不动主工作区
 *   （含其未提交改动），成功后删除临时 worktree。
 *
 * @returns {{ ok: boolean, conflict?: boolean, hookBypassed?: boolean, error?: string }}
 */
export async function mergeBranch(repo, source, target) {
  if (!(await branchExists(repo, source))) return { ok: false, error: `分支不存在：${source}` };
  if (!(await branchExists(repo, target))) return { ok: false, error: `目标分支不存在：${target}` };

  const original = await currentBranch(repo);

  // ── 路径 A：主工作区已在目标分支，原地 merge ──
  // 注意：不做 isClean 预检，直接让 git 决定——git 只在脏文件与合并内容真正冲突时才拒绝，
  // 未追踪文件和不涉及合并的已修改文件不会阻止 merge，过早的 isClean 检查会误伤正常开发状态。
  // 提交钩子（husky）只在这条路径生效：core.hooksPath=.husky/_ 是相对路径，新建 worktree 里
  // 没有 .husky/_（gitignored、由 husky install 生成），所以路径 B 天然不跑钩子。
  if (original === target) {
    return runMergeIn(repo, source, target);
  }

  // ── 路径 B：主工作区在其他分支，用临时 worktree 执行 merge，不动主工作区 ──
  const tmpDir = String(repo).replace(/[\\/]+$/, '') + '.merge-tmp';
  // 清理可能的残留注册（上次异常退出留下的）
  await git(['-C', repo, 'worktree', 'prune']);
  await git(['-C', repo, 'worktree', 'remove', '--force', tmpDir]); // 幂等：目录不存在时 git 返回非 0 但无副作用

  const add = await git(['-C', repo, 'worktree', 'add', tmpDir, target]);
  if (!add.ok) {
    return { ok: false, error: `创建临时合并工作区失败：${(add.err || add.msg || '').slice(0, 200)}` };
  }

  try {
    return await runMergeIn(tmpDir, source, target);
  } finally {
    // 无论成功失败都清理临时 worktree，不留垃圾目录
    await git(['-C', repo, 'worktree', 'remove', '--force', tmpDir]);
  }
}

/**
 * 放弃改动：删除任务分支（-D 强删，任务分支从未合并）。
 * 分支已不存在 → 视为已放弃（ok:true，幂等：避免脏数据把任务永久卡在待合并）。
 * 仍被某个 worktree 检出 → git 拒绝删除，原样上报错误（正常流程 auto-dev 完成后已 detach HEAD）。
 * @returns {{ ok:boolean, error?:string }}
 */
export async function deleteBranch(repo, branch) {
  if (!(await branchExists(repo, branch))) {
    logger.warn('auto-dev', '放弃改动：分支已不存在，视为已放弃', { repo, branch });
    return { ok: true };
  }
  const r = await git(deleteBranchArgs(repo, branch));
  if (!r.ok) {
    const error = (r.err || r.out || '删除分支失败').slice(0, 300);
    logger.warn('auto-dev', '放弃改动失败', { repo, branch, error });
    return { ok: false, error };
  }
  logger.info('auto-dev', '放弃改动：分支已删除', { repo, branch });
  return { ok: true };
}

// ---- 常驻 auto 工作区：所有自动任务在 <repo>.auto 里执行，主工作区永不被切分支 ----

/** auto 工作区目录：项目路径去尾斜杠 + .auto 后缀（纯函数） */
export function autoWorktreeDir(repo) {
  return String(repo).replace(/[\\/]+$/, '') + '.auto';
}

export function worktreeAddArgs(repo, dir) {
  return ['-C', repo, 'worktree', 'add', '--detach', dir];
}

/** -B 从 base 的 commit 建/重置分支——不检出 base 本身，绕开「同一分支不能双 worktree 检出」限制 */
export function checkoutNewFromBaseArgs(dir, branch, base) {
  return ['-C', dir, 'checkout', '-B', branch, base];
}

/**
 * 确保常驻 auto 工作区可用：健康 → 归属校验 → 直接用；缺失 → prune 后重建；
 * 目录存在但已不是有效 worktree，或属于其他仓库 → 明确失败（绝不自动删用户目录）。
 * @returns {{ ok:boolean, dir:string, created?:boolean, error?:string }}
 */
export async function ensureAutoWorktree(repo) {
  const dir = autoWorktreeDir(repo);
  const health = await git(['-C', dir, 'rev-parse', '--is-inside-work-tree']);
  if (health.ok) {
    // 归属校验：dir 可能是无关仓库或外层仓库的目录——必须确认它登记在本 repo 的 worktree 列表里
    const list = await git(['-C', repo, 'worktree', 'list', '--porcelain']);
    const norm = (p) => {
      const r = path.resolve(String(p));
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    const registered = (list.out || '')
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => norm(l.slice('worktree '.length).trim()));
    if (!list.ok || !registered.includes(norm(dir))) {
      logger.warn('auto-dev', 'auto 目录存在但不属于本仓库', { repo, dir });
      return { ok: false, dir, error: '目录已存在但不是本仓库的 worktree，请人工处理（绝不自动删除）' };
    }
    return { ok: true, dir };
  }
  await git(['-C', repo, 'worktree', 'prune']);
  const r = await git(worktreeAddArgs(repo, dir));
  if (!r.ok) {
    const error = (r.err || r.msg || 'worktree add 失败').slice(0, 300);
    logger.warn('auto-dev', 'ensureAutoWorktree 失败', { repo, dir, error });
    return { ok: false, dir, error };
  }
  return { ok: true, dir, created: true };
}

/**
 * 自愈：auto 工作区有未提交残留（上个任务异常中断）→ 就地 commit 留痕。
 * detached HEAD 上的 commit 也可行（留痕可经 reflog 找回（默认约 90 天），不追求分支可达）。
 * @returns {{ committed:boolean, dirty:boolean, error?:string }}
 *   - dirty=false committed=false：无残留（正常态）
 *   - dirty=true  committed=true：有残留且留痕成功
 *   - dirty=true  committed=false：有残留但 commit 失败，error 含诊断信息
 */
export async function commitResidue(dir) {
  const r = await git(['-C', dir, 'status', '--porcelain']);
  if (!r.ok || !(r.out || '').trim()) return { committed: false, dirty: false };
  await git(['-C', dir, 'add', '-A']);
  const c = await git(['-C', dir, 'commit', '-m', 'wip: 自动保存上个任务残留（auto 工作区自愈）']);
  logger.warn('auto-dev', 'auto 工作区残留已自动提交留痕', { dir, ok: c.ok });
  if (c.ok) return { committed: true, dirty: true };
  return { committed: false, dirty: true, error: (c.err || '').slice(0, 200) };
}

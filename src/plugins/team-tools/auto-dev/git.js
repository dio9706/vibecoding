/** git 封装（经 shell.runScript，不抛异常）。参数拼装抽纯函数便于单测。原 unattended/git.js 迁入并扩展合并能力。 */
import { runScript } from '../../../integrations/shell.js';
import { logger } from '../../../shared/logger.js';
import path from 'node:path';
import fs from 'node:fs';

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

/**
 * 本地分支名清单（不含远程）。读不到一律回 []——调用方拿它做「这个名字已存在吗」的提示，
 * 读失败时宁可少提示也不能报错拦路：真正的把关在 ensureBranch，它对已存在的分支本就幂等。
 * 用 for-each-ref 而非 `branch --list`：后者会带 `* ` 前缀和缩进，还可能被 i18n 影响。
 */
export async function localBranches(repo) {
  const r = await git(['-C', repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (!r.ok) return [];
  return (r.out || '').split('\n').map((s) => s.trim()).filter(Boolean);
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
 * 取 dir 当前 HEAD 的完整 sha（拿不到返回空串——操作本身可能已成功，只是丢了锚点，
 * 不该反过来判操作失败）。merge/revert 都要用来回填事后审计锚点，故导出供 revert.js 复用。
 */
export async function headSha(dir) {
  const r = await git(['-C', dir, 'rev-parse', 'HEAD']);
  return r.ok ? (r.out || '').trim() : '';
}

/** 索引里仍处于 unmerged 的路径清单（冲突文件）。非冲突态返回 [] */
async function conflictedFiles(dir) {
  const r = await git(['-C', dir, 'diff', '--name-only', '--diff-filter=U']);
  if (!r.ok) return [];
  return (r.out || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

/** 冲突标记行：`<<<<<<< ` 开头。用行首锚定，避免误伤正文里恰好有七个尖括号的内容 */
const CONFLICT_MARKER_RE = /^<{7}( |$)/m;

/**
 * 这些文件里还留着冲突标记吗 —— **模型谎报的唯一硬判据**。
 * 不用 `ls-files -u`：模型可能把带标记的文件 `git add` 了，索引就此「干净」，
 * 而文件里的 `<<<<<<<` 会被原样提交进主干。只有读文件内容才拦得住。
 * 读不到（被删/二进制）不算残留——删掉冲突文件也是一种解决方式，交给后面的编译/测试把关。
 */
function markerFiles(dir, files) {
  const bad = [];
  for (const f of files) {
    try {
      if (CONFLICT_MARKER_RE.test(fs.readFileSync(path.join(dir, f), 'utf8'))) bad.push(f);
    } catch {
      /* 读不到就不算残留 */
    }
  }
  return bad;
}

/** 当前 stash 栈顶的 sha（栈空返回空串）。用它做并发锚点，绝不靠 `stash@{0}` 这个会漂移的名字 */
async function stashTopSha(dir) {
  const r = await git(['-C', dir, 'rev-parse', '-q', '--verify', 'stash@{0}']);
  return r.ok ? (r.out || '').trim() : '';
}

/** stash 消息带固定前缀：维护者在 `git stash list` 里一眼能认出这是自动合并压的 */
const STASH_LABEL = 'principal: 自动合并临时暂存';

/**
 * 执行一次 merge 尝试，含提交钩子兜底。
 * **失败时刻意不 abort** —— 冲突现场要留给上层决定怎么处置（stash 重试 / 交 LLM 解）。
 * 这是它与旧版 runMergeIn 的唯一行为差异，回滚责任上移到 finishOrAbort / mergeWithStash。
 */
async function attemptMerge(dir, source, target, msg) {
  const merge = await git(['-C', dir, 'merge', '--no-ff', source, '-m', msg]);
  if (merge.ok) return { ok: true, mergeCommit: await headSha(dir) };

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
      return { ok: true, hookBypassed: true, hookOutput: diag.slice(0, 300), mergeCommit: await headSha(dir) };
    }
  }

  // 真失败：内容冲突，或 git 预检拒绝（脏文件会被覆盖等）。二者分类不同，别一律叫「冲突」。
  return { ok: false, conflict: await hasUnmergedPaths(dir), diag };
}

/**
 * 把冲突现场交给 LLM 解，解完由**本函数**提交（模型被要求不要自己 commit）。
 *
 * `add -A` 的安全前提是「merge 之前工作区是干净的」—— 否则维护者无关的未提交改动会被
 * 一起提交进合并（`revert.js` 踩过同款坑）。这个前提由调用链保证：路径 B 的临时 worktree
 * 天然干净，路径 A 的脏工作区已在 mergeWithStash 里 stash 过。**改动这里前先确认它仍成立。**
 */
async function llmResolveConflict(dir, source, target, msg, resolver) {
  const files = await conflictedFiles(dir); // 必须在 add -A 之前取，add 会清掉 unmerged 标记
  const r = await resolver.resolveConflict({ dir, source, target, files });
  if (!r?.ok) return { ok: false, error: r?.error || 'AI 解冲突失败' };

  const bad = markerFiles(dir, files);
  if (bad.length) return { ok: false, error: `AI 未解净冲突标记：${bad.slice(0, 5).join('、')}` };

  await git(['-C', dir, 'add', '-A']);
  if (await hasUnmergedPaths(dir)) return { ok: false, error: 'AI 解冲突后索引仍有未解决路径' };

  // 先走正常提交（过钩子），被挡再 --no-verify —— 与 attemptMerge 同一套兜底纪律
  let c = await git(['-C', dir, 'commit', '-m', msg]);
  let hookBypassed = false;
  if (!c.ok) {
    c = await git(['-C', dir, 'commit', '--no-verify', '-m', msg]);
    hookBypassed = c.ok;
  }
  if (!c.ok) return { ok: false, error: `AI 解完冲突但提交失败：${(c.err || c.out || '').slice(0, 200)}` };

  logger.warn('auto-dev', 'AI 已解合并冲突并提交', { dir, source, target, files: files.slice(0, 10), hookBypassed });
  return {
    ok: true,
    conflictResolvedBy: 'llm',
    ...(hookBypassed ? { hookBypassed: true } : {}),
    mergeCommit: await headSha(dir),
  };
}

/** 合并失败后的统一出口：够格就交 LLM，LLM 也没搞定才 abort 回滚并报错 */
async function finishOrAbort(dir, source, target, msg, attempt, resolver) {
  let llmError = '';
  if (attempt.conflict && resolver?.resolveConflict) {
    const r = await llmResolveConflict(dir, source, target, msg, resolver);
    if (r.ok) return r;
    llmError = r.error || '';
  }
  await git(['-C', dir, 'merge', '--abort']); // 幂等：未开始合并时非 0 但无副作用
  logger.warn('auto-dev', '合并失败已回滚', { dir, source, target, conflict: attempt.conflict, err: (attempt.diag || '').slice(0, 200), llmError });
  return {
    ok: false,
    ...(attempt.conflict ? { conflict: true } : {}),
    error:
      `${attempt.conflict ? '合并冲突' : '合并失败'}：${(attempt.diag || '').slice(0, 300) || '(git 未输出诊断信息)'}` +
      (llmError ? `；AI 兜底亦失败：${llmError}` : ''),
  };
}

/**
 * 恢复 stash。**这个函数里每一条出口都在保同一样东西：维护者未提交的代码。**
 *
 * `git stash pop` 冲突时不会 drop 条目 —— 那是改动的最后一份拷贝，因此：
 * drop 只允许出现在「融合确认成功」之后，其余分支一律留着并把 sha 写进提示。
 */
async function popStash(dir, sha, resolver, ctx) {
  const hint = `本地改动完整保留在 stash（${sha.slice(0, 8)}），可 git checkout -- . 后 git stash pop 重来`;

  // 并发锚点：窗口期内若有人（另一个进程、维护者自己）压了新 stash，栈顶就不是我们那条了
  if ((await stashTopSha(dir)) !== sha) {
    return { ok: false, error: `stash 栈顶已变化，未自动恢复；请 git stash list 找到 ${sha.slice(0, 8)} 后手动 pop` };
  }

  const pop = await git(['-C', dir, 'stash', 'pop']);
  if (pop.ok) return { ok: true };

  const files = await conflictedFiles(dir);
  if (!files.length || !resolver?.mergeStash) return { ok: false, error: `恢复本地改动时冲突；${hint}` };

  const r = await resolver.mergeStash({ dir, files, ...ctx });
  if (!r?.ok) return { ok: false, error: `${r?.error || 'AI 融合本地改动失败'}；${hint}` };
  const bad = markerFiles(dir, files);
  if (bad.length) return { ok: false, error: `AI 未解净冲突标记：${bad.slice(0, 5).join('、')}；${hint}` };

  // 融合结果必须停在「未提交改动」：reset 只重置索引、不碰工作区文件，正好把 pop 留下的
  // 暂存态退回去。**绝不 commit** —— 那是维护者自己的代码，自动流程无权替他提交。
  await git(['-C', dir, 'reset']);
  // 再校验一次栈顶：融合期间（LLM 调用可能数分钟）同样存在并发窗口
  if ((await stashTopSha(dir)) === sha) await git(['-C', dir, 'stash', 'drop']);
  logger.warn('auto-dev', 'AI 已融合本地改动与合并结果', { dir, files: files.slice(0, 10) });
  return { ok: true, llmMerged: true };
}

/**
 * 先 stash 再合并。**脏工作区是两类合并失败的共同放大器**，stash 一次把两者都消掉：
 *   - git 预检拒绝：脏文件与合并内容重叠，git 根本不开始合并；
 *   - 内容冲突：LLM 解完要 `add -A`，无关脏文件会被一并提交。
 * 暂存后工作区变干净 → 预检通过、`add -A` 只含合并内容，合完再原样 pop 回来。
 */
async function mergeWithStash(dir, source, target, msg, resolver) {
  const before = await stashTopSha(dir);
  const push = await git(['-C', dir, 'stash', 'push', '-u', '-m', `${STASH_LABEL} ${source}`]);
  const sha = await stashTopSha(dir);
  // push 在「无改动可存」时也返回 0 —— 只认栈顶确实变了才算暂存成功，否则后面会 pop 掉别人的东西
  if (!push.ok || !sha || sha === before) {
    return {
      ok: false,
      error: `合并失败：主工作区有未提交改动且无法自动暂存（${(push.err || push.out || '').slice(0, 200)}）`,
    };
  }

  let result;
  try {
    const a = await attemptMerge(dir, source, target, msg);
    result = a.ok ? a : await finishOrAbort(dir, source, target, msg, a, resolver);
  } catch (e) {
    await git(['-C', dir, 'merge', '--abort']);
    result = { ok: false, error: `合并失败：${(e?.message || String(e)).slice(0, 300)}` };
  }

  // pop 无条件执行：合并失败同样要把改动还给维护者，绝不能让它锁死在 stash 里
  const pop = await popStash(dir, sha, resolver, { source, target });
  if (!pop.ok) return { ...result, stashed: true, stashStranded: true, stashWarning: pop.error };
  return { ...result, stashed: true, ...(pop.llmMerged ? { stashLlmMerged: true } : {}) };
}

/**
 * 在 dir 就地执行 merge，含钩子兜底、脏工作区自动 stash、LLM 解冲突三层救援。路径 A/B 共用。
 *
 * @param {{ resolver?: {resolveConflict?:Function, mergeStash?:Function}, allowStash?: boolean }} opts
 *   resolver 缺省则跳过 LLM 兜底，只保留确定性的 stash 救援（git.js 不认识 LLM，靠注入）。
 * @returns {{ ok, conflict?, hookBypassed?, mergeCommit?, error?, stashed?, stashLlmMerged?, stashStranded?, stashWarning?, conflictResolvedBy? }}
 *   mergeCommit：合并成功时的 merge commit sha；**取不到时为空串而非缺失**，消费方要用 `if (!mergeCommit)` 而不是判字段存在。
 *   **stashStranded 必须被消费方看见**：此时合并可能已成功，但维护者的改动还压在 stash 里没回来。
 */
async function runMergeIn(dir, source, target, opts = {}) {
  const { resolver, allowStash = true } = opts;
  const msg = mergeMessage(source, target);
  // 必须在 merge 之前判脏：冲突态下 status --porcelain 恒非空，事后再判分不清
  // 「维护者的脏」和「冲突造成的脏」。
  const dirtyBefore = allowStash && !(await isClean(dir));

  const a = await attemptMerge(dir, source, target, msg);
  if (a.ok) return a;

  if (dirtyBefore) {
    await git(['-C', dir, 'merge', '--abort']); // 清掉现场才能 stash
    return mergeWithStash(dir, source, target, msg, resolver);
  }
  return finishOrAbort(dir, source, target, msg, a, resolver);
}

/**
 * 在「目标分支所在的工作区」里执行 fn，两条路径对调用方透明：
 * - 主工作区已在 target：原地执行（fn 收到 repo 本身）
 * - 主工作区在其他分支：建临时 worktree 检出 target 执行，完事即删
 *   （主工作区连同其未提交改动完全不受影响）
 *
 * 抽取自 mergeBranch —— merge 与 revert 对「在哪执行」的需求完全同构，各写一套
 * 必然在临时 worktree 的残留清理上分叉（那是最容易漏、又最难排查的一段）。
 *
 * @param {string} repo 主工作区路径
 * @param {string} target 目标分支（须已存在，调用方自行校验）
 * @param {string} suffix 临时目录后缀。同一时刻可能并存的不同操作**不得复用同一后缀**
 *   （merge 用 '.merge-tmp'，revert 用 '.revert-tmp'），否则互相 remove --force 对方的工作区
 * @param {(dir:string)=>Promise<any>} fn 在 dir 里干活，返回值原样透传
 */
export async function withBranchWorktree(repo, target, suffix, fn) {
  const current = await currentBranch(repo);

  // ── 路径 A：主工作区已在目标分支，原地执行 ──
  // 注意：不做 isClean 预检，直接让 git 决定——git 只在脏文件与本次操作内容真正冲突时才拒绝，
  // 未追踪文件和不涉及的已修改文件不会造成阻碍，过早的 isClean 检查会误伤正常开发状态。
  // 提交钩子（husky）只在这条路径生效：core.hooksPath=.husky/_ 是相对路径，新建 worktree 里
  // 没有 .husky/_（gitignored、由 husky install 生成），所以路径 B 天然不跑钩子。
  if (current === target) return fn(repo);

  // ── 路径 B：主工作区在其他分支，用临时 worktree 执行，不动主工作区 ──
  const tmpDir = String(repo).replace(/[\\/]+$/, '') + suffix;
  // 清理可能的残留注册（上次异常退出留下的）
  await git(['-C', repo, 'worktree', 'prune']);
  await git(['-C', repo, 'worktree', 'remove', '--force', tmpDir]); // 幂等：目录不存在时 git 返回非 0 但无副作用

  const add = await git(['-C', repo, 'worktree', 'add', tmpDir, target]);
  if (!add.ok) {
    return { ok: false, error: `创建临时工作区失败：${(add.err || add.msg || '').slice(0, 200)}` };
  }

  try {
    return await fn(tmpDir);
  } finally {
    // 无论成功、失败还是抛错都清理，不留垃圾目录
    //（开头的 prune + remove --force 虽能自愈，但别指望下一次调用来擦屁股）
    await git(['-C', repo, 'worktree', 'remove', '--force', tmpDir]);
  }
}

/**
 * 合并 source → target（--no-ff）。救援分三层，逐层升级：
 *   1. 提交钩子拦截 → `--no-verify` 重提（合并内容已算完，只是 commit 被挡）
 *   2. 工作区脏（预检拒绝 / 让 add -A 变危险）→ 自动 stash 后重试，合完 pop 回来
 *   3. 内容冲突 → 交注入的 resolver（LLM）解，解完由本模块提交
 * 三层都没救回来才 merge --abort，绝不留半合并状态。执行目录由 withBranchWorktree 决定。
 *
 * @param {{ resolver?: {resolveConflict?:Function, mergeStash?:Function}, allowStash?: boolean }} [opts]
 *   不传 resolver 就只有前两层（确定性救援），LLM 由调用方注入 —— 本模块是纯 git 封装，不认识模型。
 * @returns {{ ok, conflict?, hookBypassed?, mergeCommit?, error?, stashed?, stashLlmMerged?, stashStranded?, stashWarning?, conflictResolvedBy? }}
 *   mergeCommit：合并成功时的 merge commit sha；**取不到时为空串而非缺失**，消费方要用 `if (!mergeCommit)` 而不是判字段存在。
 *   **stashStranded 不许被静默丢弃**：它意味着合并可能已成功，但维护者的未提交改动还压在 stash 里。
 */
export async function mergeBranch(repo, source, target, opts = {}) {
  if (!(await branchExists(repo, source))) return { ok: false, error: `分支不存在：${source}` };
  if (!(await branchExists(repo, target))) return { ok: false, error: `目标分支不存在：${target}` };

  // 源分支相对目标没有领先提交 = 改动已经在基线分支上了（多半是维护者手工带进去的）。
  // 这种情况**不能走 merge**：git 会回「Already up to date」并退出 0 且不建 commit，
  // headSha 于是拿到一个与本次改动毫不相干的提交充当 mergeCommit，日后「放弃改动」
  // 拿它 `revert -m 1` 会撤错东西。留空锚点让 revert 走它已有的「无锚点转 LLM」路径。
  // 读不到就不拦路：让 merge 照常跑，最坏退回原来的行为。
  const ahead = await git(['-C', repo, 'rev-list', '--count', `${target}..${source}`]);
  const n = ahead.ok ? Number((ahead.out || '').trim()) : NaN;
  if (Number.isFinite(n) && n === 0) {
    logger.info('auto-dev', '源分支无领先提交，改动已在基线上', { repo, source, target });
    return { ok: true, alreadyMerged: true, mergeCommit: '' };
  }

  return withBranchWorktree(repo, target, '.merge-tmp', (dir) => runMergeIn(dir, source, target, opts));
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
 * 确保某个 worktree 目录可用：健康 → 归属校验 → 直接用；缺失 → prune 后重建；
 * 目录存在但已不是有效 worktree，或属于其他仓库 → 明确失败（绝不自动删用户目录）。
 * 抽自 `ensureAutoWorktree`（原逻辑不变，只是 dir 从写死改成入参）——
 * 供常驻 auto 工作区与 per-需求 worktree 共用同一套纪律。
 * @returns {{ ok:boolean, dir:string, created?:boolean, error?:string }}
 */
async function ensureWorktreeAt(repo, dir, label = 'auto 工作区') {
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
      // label 带上是哪种 worktree：两个调用方（auto 泵 / per-需求 agent 改码）出错时
      // 排查路径完全不同，日志只写「auto」会把人引到错误的方向
      logger.warn('auto-dev', `${label}目录存在但不属于本仓库`, { repo, dir });
      return { ok: false, dir, error: '目录已存在但不是本仓库的 worktree，请人工处理（绝不自动删除）' };
    }
    return { ok: true, dir };
  }
  await git(['-C', repo, 'worktree', 'prune']);
  const r = await git(worktreeAddArgs(repo, dir));
  if (!r.ok) {
    const error = (r.err || r.msg || 'worktree add 失败').slice(0, 300);
    logger.warn('auto-dev', `${label}创建失败`, { repo, dir, error });
    return { ok: false, dir, error };
  }
  return { ok: true, dir, created: true };
}

/**
 * 确保常驻 auto 工作区可用（纪律见 `ensureWorktreeAt`）。
 * @returns {{ ok:boolean, dir:string, created?:boolean, error?:string }}
 */
export async function ensureAutoWorktree(repo) {
  return ensureWorktreeAt(repo, autoWorktreeDir(repo));
}

/**
 * per-需求 worktree 目录（纯函数）。
 *
 * **不能复用 `<repo>.auto`**：那个目录是 auto-dev 泵的，泵按「全局串行」调度，
 * 而需求侧按「per-需求 busy 闸」调度 —— 两道闸互不知情，共用一个目录就是
 * 一方把另一方的分支 checkout 掉。
 *
 * 取 reqId 前 8 位：需求 id 形如 `r_mt8gjvxbg679`，全长做目录名太长，
 * 前 8 位（含 `r_` 前缀）在同一仓库内的活跃需求间已足够区分。
 */
export function reqWorktreeDir(repo, reqId) {
  return String(repo).replace(/[\\/]+$/, '') + '.req-' + String(reqId).slice(0, 8);
}

/**
 * 确保 per-需求 worktree 可用。三条纪律与 `ensureAutoWorktree` 完全一致：
 * 健康 → 归属校验 → 直接用；缺失 → prune 后重建；
 * **目录存在但属于其他仓库 → 明确失败，绝不自动删用户目录**。
 */
export async function ensureReqWorktree(repo, reqId) {
  return ensureWorktreeAt(repo, reqWorktreeDir(repo, reqId), `需求 ${reqId} 的 worktree`);
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

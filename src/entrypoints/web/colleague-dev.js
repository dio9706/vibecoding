/**
 * 系统任务 colleague-dev 的执行侧 —— 后端同事的消息（接口文档 / 需协作的文字）触发的自动接入。
 *
 * 独立成文件而不塞进 requirement-ops.js：那里已 1300+ 行且本仓有并行会话在改；本 kind 与
 * bug-fix 的差别（新开子会话而非 resume 主会话、完成后回飞书、标记消息条目）足够多，
 * 硬放一起只会让 dispatchSystemTask 长出第二套分支。requirement-ops 的 dispatch 只加一支调
 * dispatchColleagueDev。
 *
 * **agent 改码落在 per-需求 worktree**（`<工程>.req-<需求id前8位>`）而不是主工作区：主工作区是
 * 主机自己在用的那份，开发期他就站在需求分支上。agent 在独立目录里建 `req/<需求id>/agent-<消息id>`
 * 分支改码，收尾时提交 → 进合并队列 → 写撤销台账，主机因此能把「后端这一条消息引发的改动」整条撤回去。
 * 改造前所有子会话都在主工作区直接改、永不提交，agent 写的代码完全不可撤销。
 *
 * 依赖方向：requirement-ops → 本文件。本文件**不得** import requirement-ops（成环）。
 * （上一代四期分类器管线 `colleague-auto.js` 曾是本文件的另一个调用方，已在 P3 随管线整体下线；
 * 现在触发 `colleague-dev` 系统任务的唯一入口是 `requirement-ops.js#enqueueSystemTask`。）
 */
import { getRequirement, updateRequirement, normalizeSessions, addAgentWorktree } from '../../store/requirements.js';
import { createRun, failRun } from '../../store/runs.js';
import { appendTo, markHandled } from '../../store/colleague-messages.js';
import { getColleague } from '../../store/colleagues.js';
import { getActiveBot } from '../../store/settings.js';
import { appendAction as realAppendAction } from '../../store/agent-actions.js';
import { sendTextToUser } from '../../integrations/lark.js';
import { runScript } from '../../integrations/shell.js';
import {
  ensureReqWorktree as realEnsureReqWorktree,
  commitResidue as realCommitResidue,
  commitAll as realCommitAll,
  currentBranch as realCurrentBranch,
  checkoutNewFromBaseArgs,
} from '../../plugins/team-tools/auto-dev/git.js';
import { buildCommitMessage } from '../../plugins/team-tools/auto-dev/logic.js';
import { mergeQueue } from './merge-queue.js';
import { startClaudeRun } from './run-claude.js';
import { pickCwdAndDirs } from './req-logic.js';
import { newSubConvId, buildBrief } from './colleague-dev.logic.js';
import { logger } from '../../shared/logger.js';

export const COLLEAGUE_DEV_KIND = 'colleague-dev';

/** shell:false —— 参数直传 git.exe，分支名含中文/空格不被 cmd 拆散（与 auto-dev/git.js 同口径） */
const realGit = (args) => runScript('git', args, { shell: false });

/**
 * agent 改码分支名：`req/<需求id>/agent-<消息id>`。
 * 逐消息一分支而不是逐需求一分支 —— 撤销的粒度是「后端这一条消息引发的改动」，
 * 一条消息一个 merge commit，主机撤第二条不会连带撤掉第一条。
 */
export function agentBranchName(reqId, msgId) {
  return `req/${reqId}/agent-${msgId}`;
}

/**
 * per-worktree 串行闸。
 *
 * busy 在 onSettle 的同步段就放开（串行闸要立刻让出，否则该需求的下一条消息要等合并排完队），
 * 但那一刻改动还没提交 —— 下一条任务的 `checkout -B` 若插进来，会把上一条 agent 刚写的代码
 * 连同 HEAD 一起切到新分支，上一条的 commitAll 就提交到了别人的分支上（worktree 目录按**需求**
 * 分，不按消息分，同需求的相邻两条消息用的是同一个目录）。
 * 这条链保证同一目录上「准备(commitResidue + checkout -B)」与「收尾(commit + detach)」首尾相接。
 * **只圈碰工作区的那几步**，合并排队留在锁外 —— 圈进来等于把 busy 的等待原样搬回来。
 */
const worktreeTails = new Map();
function onWorktree(dir, fn) {
  const prev = worktreeTails.get(dir) || Promise.resolve();
  const next = prev.then(fn, fn); // 前一段失败也要接着跑，否则一次异常永久堵死这个目录
  const tail = next.then(() => {}, () => {});
  worktreeTails.set(dir, tail);
  tail.then(() => {
    if (worktreeTails.get(dir) === tail) worktreeTails.delete(dir); // 队尾空了就撤掉条目，别让 map 随需求数只增不减
  });
  return next;
}

/**
 * 以机器人身份回同事一句，并落 dir:'out' 进对话流 —— 主机在 web 端同事面板能看到 AI 替他说了什么。
 * 与 routes-requirements#handleColleagueSend 同一条路。发送失败不落消息：落了界面会显示一条其实没送达的。
 * @returns {Promise<boolean>} 是否确实送达
 */
export async function replyColleague(reqId, colleagueId, text) {
  const c = getColleague(colleagueId);
  if (!c?.feishuOpenId) {
    logger.warn('colleague-dev', '同事无 open_id，回复跳过', { reqId, colleagueId });
    return false;
  }
  const bot = getActiveBot();
  let ok = false;
  try {
    ok = await sendTextToUser({ appId: bot?.appId, appSecret: bot?.appSecret }, c.feishuOpenId, text);
  } catch (e) {
    logger.warn('colleague-dev', '回复同事失败', { reqId, colleagueId, err: e?.message || String(e) });
  }
  if (ok) appendTo(colleagueId, { dir: 'out', text, role: c.role, status: 'read', reqId });
  return ok;
}

/**
 * 收尾结局 → 主机看板上的 handledNote 前缀。
 * 「改完了但没合并」与「压根没改」对主机是两件完全不同的事，都并成「已处理」他就无从分辨。
 */
const OUTCOME_NOTE = {
  merged: '已处理 · ',
  'pending-merge': '已处理（待合并） · ',
  'merge-failed': '已处理（合并失败） · ',
  'no-change': '处理失败（无代码改动） · ',
  'run-failed': '处理失败 · ',
  'git-error': '处理失败（提交异常） · ',
  skipped: '已处理 · ',
};

/**
 * 回同事的简报（纯函数，导出供测试）。
 * 关键是 pending-merge / merge-failed 不能说成「已处理完成」就完 —— 代码还没进需求分支，
 * 同事按这句话去联调只会拿到旧接口行为。
 */
export function buildColleagueBrief(outcome, resultText) {
  if (outcome === 'run-failed' || outcome === 'no-change' || outcome === 'git-error') return buildBrief(false);
  const base = buildBrief(true, resultText);
  if (outcome === 'pending-merge') return base + '（改动已提交，待主机合并后再联调）';
  if (outcome === 'merge-failed') return base + '（改动已提交但未合并，已转主机处理）';
  return base;
}

/**
 * 提交 agent 的改动 → 入合并队列 → 写撤销台账。
 * @returns {Promise<'merged'|'pending-merge'|'merge-failed'|'no-change'>}
 */
async function commitAndMerge({ reqId, msgId, colleagueId, title }, gitCtx) {
  const commitAll = gitCtx.commitAll || realCommitAll;
  const enqueueMerge = gitCtx.enqueueMerge || ((task) => mergeQueue.enqueue(task));
  const appendAction = gitCtx.appendAction || realAppendAction;
  const git = gitCtx.runGit || realGit;
  const { workDir, repo, branch, baseBranch } = gitCtx;

  // 提交信息复用 auto-dev 的纯函数（已按 commitlint 的 `type: subject` 校准过）；
  // msgId 当任务 id —— 从一条提交能直接回溯到是后端哪句话引发的
  const message = buildCommitMessage({ type: 'feature', title, id: msgId }, true);
  const c = await onWorktree(workDir, async () => {
    const r = await commitAll(workDir, message);
    // 提交完立刻脱离到 detached HEAD：分支不再被这个 worktree 占着，撤销时才删得掉
    //（git.js#deleteBranch 对「仍被某个 worktree 检出」的分支是直接拒绝的）
    if (r?.committed) {
      const detach = await git(['-C', workDir, 'checkout', '--detach']);
      if (!detach?.ok) logger.warn('colleague-dev', 'detach HEAD 失败（不阻塞）', { reqId, workDir });
    }
    return r;
  });
  if (!c?.committed) {
    // 防谎报闸：模型说改完了但一行没动。这里写台账等于留一条撤不出任何东西的假记录，
    // 主机点撤销看到「成功」却什么都没变，比压根没有这条记录更糟
    logger.warn('colleague-dev', '无代码改动，不合并不写台账', { reqId, branch, err: (c?.err || '').slice(0, 200) });
    return 'no-change';
  }

  const r = await enqueueMerge({ repo, branch, baseBranch });
  // merged 与 pending-merge 都要写台账：前者撤销走 git revert，后者分支还在、撤销走删分支，
  // mergeSha 为 null 就是撤销侧分流的判据。合并失败同样写 —— 分支与提交都在，一样撤得回
  appendAction({
    tool: 'start_dev_task',
    reqId,
    colleagueId,
    role: getColleague(colleagueId)?.role || '',
    msgId,
    input: { branch, baseBranch, title },
    ok: r?.status !== 'failed',
    resultBrief: `${branch} → ${baseBranch}：${r?.status || 'unknown'}${r?.error ? '（' + r.error + '）' : ''}`,
    undo: { kind: 'revert-merge', repo, branch, baseBranch, mergeSha: r?.sha || null },
  });
  if (r?.status === 'merged') return 'merged';
  if (r?.status === 'pending-merge') return 'pending-merge';
  logger.warn('colleague-dev', '合并失败，改动留在分支上等人工处理', { reqId, branch, err: r?.error });
  return 'merge-failed';
}

/**
 * onSettle 的异步段：提交合并 → 标记消息 → 回同事简报。
 *
 * 简报必须排在提交合并**之后**：先说「已处理完成」、几秒后合并才失败的话，同事已经以为可以联调了。
 * 提交合并整段裹 try/catch 而不是只靠链尾那个 catch —— 台账写盘抛错也不能吞掉 markHandled 与简报，
 * 否则同事一直等、消息永远挂在未处理。
 */
async function finishColleagueDev(ok, run, ctx, gitCtx) {
  let outcome = ok ? 'skipped' : 'run-failed';
  if (ok) {
    if (!gitCtx?.workDir) {
      // 防御：生产漏传时宁可不提交，也不能默认回退到「在主工作区提交」那种更坏的行为
      logger.warn('colleague-dev', '缺 gitCtx，跳过提交合并', { reqId: ctx.reqId, msgId: ctx.msgId });
    } else {
      try {
        outcome = await commitAndMerge(ctx, gitCtx);
      } catch (e) {
        logger.warn('colleague-dev', '提交合并异常', { reqId: ctx.reqId, err: e?.message || String(e) });
        outcome = 'git-error';
      }
    }
  }
  markHandled(ctx.colleagueId, ctx.msgId, { handledBy: 'ai', handledNote: OUTCOME_NOTE[outcome] + ctx.title });
  await replyColleague(ctx.reqId, ctx.colleagueId, buildColleagueBrief(outcome, run?.result || run?.text));
}

/**
 * run 收尾回调（run-claude#settleRun 在真正终结时调，此时 run.result / run.text 已可读）。
 *
 * **必须同步返回**：settleRun 同步调 onSettle 且不 await、外层 try/catch 只接同步抛错，
 * 改成 async 的话链内 rejection 就成了 unhandled。所以这里同步做完清 busy，再把提交/合并/台账/简报
 * 串成一条**链尾自带 catch** 的 Promise 返回（生产忽略返回值，测试可 await 到链内副作用）。
 *
 * 清 busy 留在同步段：串行闸要立刻放开，否则该需求的下一个任务得干等合并排完队。
 * 清 busy 前必须确认 busy.runId 仍是本 run —— 与 requirement-ops#buildSystemTaskOnSettle 同一口径：
 * healStaleBusy 或另一条迟到的回调可能已清过并派发了下一个任务，无脑清会击穿串行闸。
 */
export function buildColleagueDevOnSettle(reqId, { msgId, colleagueId, title }, convId, gitCtx) {
  return (ok, run) => {
    const fresh = getRequirement(reqId);
    if (!fresh) return;
    const patch = {};
    if (fresh.busy?.runId === run?.id) patch.busy = null;
    // 子会话回填 sessionId：前端点开时靠它从 Claude 转录回放（跑时可能没人看着）
    if (run?.session_id) {
      patch.sessions = normalizeSessions(fresh).map((s) =>
        s.convId === convId && !s.sessionId ? { ...s, sessionId: run.session_id } : s,
      );
    }
    updateRequirement(reqId, patch, `系统任务 ${COLLEAGUE_DEV_KIND} ${ok ? '完成' : '失败'}：${title}`);
    return finishColleagueDev(ok, run, { reqId, msgId, colleagueId, title }, gitCtx).catch((e) => {
      logger.warn('colleague-dev', '收尾链异常', { reqId, err: e?.message || String(e) });
    });
  };
}

/**
 * 任务在起跑前作废（排队期间需求离开 dev / 无工程目录 / worktree 不可用）：同事已经收到过
 * 「正在接入处理」，不补一句他会一直等；消息也要标 handledBy:'ai'，否则永远是未处理。
 */
export function abandonColleagueDev(reqId, { msgId, colleagueId, title }, reason) {
  updateRequirement(reqId, {}, `系统任务 ${COLLEAGUE_DEV_KIND} 作废：${reason}`);
  markHandled(colleagueId, msgId, { handledBy: 'ai', handledNote: `作废（${reason}） · ${title}` });
  replyColleague(reqId, colleagueId, buildBrief(false)).catch(() => {});
}

/**
 * 起跑前中止：run 置错 + 清 busy + 撤掉刚建的空壳子会话，再走作废（告知同事 + markHandled）。
 * busy 是在第一个 await 之前就写下的（见 dispatchColleagueDev 的 ★），准备阶段失败必须由这里清掉，
 * 否则该需求所有系统任务排队等一个永远不会起跑的 run，直到看门狗超时才由 healStaleBusy 兜底。
 */
function abortBeforeStart(req, payload, convId, run, reason) {
  logger.warn('colleague-dev', '起跑前中止', { reqId: req.id, msgId: payload.msgId, reason });
  failRun(run, reason); // 顺带停掉 createRun 挂的看门狗
  const fresh = getRequirement(req.id);
  updateRequirement(req.id, {
    busy: null,
    sessions: normalizeSessions(fresh || req).filter((s) => s.convId !== convId),
  });
  abandonColleagueDev(req.id, payload, reason);
}

/**
 * 泵派发入口：新建子会话 + 准备 per-需求 worktree 与任务分支 + 起 run。
 * 与 dispatchSystemTask(bug-fix) 的两点差别：
 * ① 新 session 上下文、落到新建的子会话（不 resume devSession、不占主会话 —— 主会话可能正在开发中）；
 * ② busy 带 convId，前端据此把 run 接到正确的会话（req-chat mountReqChrome）。
 * @param {object} [deps] 测试注入：start / ensureWorktree / commitResidue / currentBranch / runGit
 *   起跑与 git 都是真实外部调用，无法直测；commitAll / enqueueMerge / appendAction 原样透传给 onSettle
 */
export async function dispatchColleagueDev(req, payload, deps = {}) {
  let run = null;
  let convId = null;
  try {
    await doDispatch(req, payload, deps, (r, c) => {
      run = r;
      convId = c;
    });
  } catch (e) {
    // 调用方（requirement-ops 的泵）**不 await 本函数**：函数变 async 之后，任何抛出都不再被泵那层
    // try/catch 接住，而是变成 unhandled rejection，且 busy 没人清 —— 该需求所有系统任务就此排队等死。
    const msg = e?.message || String(e);
    logger.error('colleague-dev', '派发异常', { reqId: req?.id, msgId: payload?.msgId, err: msg });
    try {
      if (run) abortBeforeStart(req, payload, convId, run, `派发异常：${msg}`);
      else abandonColleagueDev(req.id, payload, `派发异常：${msg}`);
    } catch (e2) {
      logger.error('colleague-dev', '派发异常收拾失败', { reqId: req?.id, err: e2?.message || String(e2) });
    }
  }
}

/** dispatchColleagueDev 的本体；抛错由外层统一收拾（见其 catch 注释）。onCreated 把 run/convId 交出去供收拾用 */
async function doDispatch(req, payload, deps, onCreated) {
  const {
    start = startClaudeRun,
    ensureWorktree = realEnsureReqWorktree,
    commitResidue = realCommitResidue,
    currentBranch = realCurrentBranch,
    runGit = realGit,
    commitAll,
    enqueueMerge,
    appendAction,
  } = deps;
  const { cwd: repo, addDirs } = pickCwdAndDirs(req.projects);
  if (!repo) {
    abandonColleagueDev(req.id, payload, '无可用工程目录');
    return;
  }
  const convId = newSubConvId();
  const sessions = [
    ...normalizeSessions(req),
    { convId, sessionId: null, title: payload.title, kind: 'sub', phase: req.phase, createdAt: new Date().toISOString() },
  ];
  const run = createRun();
  onCreated(run, convId); // 交给外层 catch：准备阶段抛错时要靠它把 busy 与空壳子会话收拾干净
  // ★ busy 必须写在第一个 await 之前：泵每 5 秒 tick 一次、canDispatch 只看 busy，晚一步写，
  //   同需求的下一条同事消息就会在 worktree 还在准备时被并发派发 —— 两个任务抢同一个目录
  //   （worktree 按需求分不按消息分），后者的 checkout -B 直接把前者的分支顶掉。
  updateRequirement(
    req.id,
    { sessions, busy: { kind: COLLEAGUE_DEV_KIND, runId: run.id, startedAt: Date.now(), convId } },
    `系统任务 ${COLLEAGUE_DEV_KIND} 启动：${payload.title}`,
  );

  // —— 准备 agent 的独立工作区与任务分支；失败一律明确中止，不降级回主工作区改码 ——
  const wt = await ensureWorktree(repo, req.id);
  if (!wt?.ok) {
    abortBeforeStart(req, payload, convId, run, `worktree 不可用（${wt?.error || '未知原因'}）`);
    return;
  }
  const workDir = wt.dir;
  const branch = agentBranchName(req.id, payload.msgId);
  // 登记 worktree：需求删除时要靠它回收目录（spec §5.3）。
  // 走 store 的专用口而不是「读出来拼好再 updateRequirement」—— 后者是 read-modify-write，
  // 同一需求并发派活时会互相覆盖掉对方的登记（本仓纪律见 store/CLAUDE.md）。
  addAgentWorktree(req.id, { dir: repo, worktreeDir: workDir, branch });
  // 基线取定稿时建的需求分支；取不到（老数据 / 工程后加的）退到主工作区当前分支
  const baseBranch = (req.branches || []).find((b) => b.dir === repo)?.branch || (await currentBranch(repo));
  if (!baseBranch) {
    abortBeforeStart(req, payload, convId, run, '无法确定基线分支');
    return;
  }
  const prep = await onWorktree(workDir, async () => {
    // 自愈上个任务异常中断的残留；留痕失败则中止（脏区继续跑会把残留混进本次提交，
    // 撤销时连带撤掉不属于这条消息的改动）
    const residue = await commitResidue(workDir);
    if (residue?.dirty && !residue.committed) {
      return { ok: false, reason: `工作区残留无法提交（${residue.error || '未知原因'}）` };
    }
    // -B 从基线的 commit 建/重置分支，不检出基线本身 —— 绕开「同一分支不能双 worktree 检出」
    const co = await runGit(checkoutNewFromBaseArgs(workDir, branch, baseBranch));
    return co?.ok ? { ok: true } : { ok: false, reason: `创建任务分支 ${branch} 失败` };
  });
  if (!prep.ok) {
    abortBeforeStart(req, payload, convId, run, prep.reason);
    return;
  }

  run.onSettle = buildColleagueDevOnSettle(req.id, payload, convId, {
    workDir,
    repo,
    branch,
    baseBranch,
    commitAll,
    enqueueMerge,
    appendAction,
    runGit,
  });
  try {
    // 无人值守策略（T6）：按 bot.execPolicy 解析（默认 bypass = 与改动前一致）
    start(run, {
      prompt: payload.prompt,
      cwd: workDir,
      addDirs,
      execPolicy: getActiveBot()?.execPolicy,
      unattended: true,
      convId,
    });
  } catch (e) {
    // startClaudeRun 起跑前会读盘（getUiPrefs），settings.json 损坏时会同步抛。
    // 不收拾的话 busy 一直挂着直到 healStaleBusy 兜底，期间该需求所有系统任务排队等一个死 run。
    const msg = e?.message || String(e);
    logger.warn('colleague-dev', '起跑失败', { reqId: req.id, runId: run.id, err: msg });
    run.onSettle = null; // failRun 不走 settleRun，onSettle 不会被调；显式摘掉避免误解
    failRun(run, `起跑失败：${msg}`);
    // 连同刚 push 的子会话条目一起撤掉：留着会让前端 hydrate 出一个空壳会话，用户只能翻 history 才知道它失败了
    const fresh = getRequirement(req.id);
    updateRequirement(
      req.id,
      { busy: null, sessions: normalizeSessions(fresh || req).filter((s) => s.convId !== convId) },
      `系统任务 ${COLLEAGUE_DEV_KIND} 起跑失败：${msg.slice(0, 160)}`,
    );
    replyColleague(req.id, payload.colleagueId, buildBrief(false)).catch(() => {});
  }
}

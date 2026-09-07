/**
 * 自动开发管线 —— 中度/完全托管共用：常驻 auto 工作区里建任务分支改码，完成后待人工确认合并。
 *
 * 队列模型：「任务状态即队列」——入队 = 锁内把任务置 status:'queued'（tasks.json 跨进程安全），
 * 泵（pump）只在 principal-web 进程跑（startAutoDevPump），feishu 进程只标记状态不执行，
 * 从根上避免双进程并发操作同一 git 工作区；状态落盘天然获得崩溃/重启续跑能力。
 *
 * 执行流：确保 auto 工作区（首建运行 setupScript）→ commitResidue 自愈残留
 *        → checkout -B <taskBranch> <baseBranch> → develop（在 auto 工作区改码，deferStatus）
 *        → commitAll 校验（无改动视为失败）→ 写 done → detach HEAD
 *        → 编译二维码（可选）→ 回复来源会话。
 * 主工作区自始至终不被切分支；失败任务退回 analyzed（不进合并队列，可人工重试）。
 */
import { getTask, getTasks, updateTask } from '../../../store/tasks.js';
// 入队 API 拆到 queue.js（零重依赖叶子）：它原本住在本文件里，导致
// task-notify 为了「点按钮入队」不得不 import 整个执行管线，从而与本文件成环。
// 详细理由见 queue.js 文件头。**刻意不在这里 re-export**——留一条通往本文件的旧路径，
// 只会让下一个人重新把重依赖链拖回去，环也会随之复活
import { requestAutoDevelop } from './queue.js';
import { develop } from '../task-ops.js';
import { currentBranch, commitAll, ensureAutoWorktree, commitResidue, checkoutNewFromBaseArgs } from './git.js';
import { taskBranchName, buildCommitMessage } from './logic.js';
import { notifyTaskDone } from '../task-notify.js';
import { compileDevQrcode } from './compile.js';
import { sendText, sendImageByUrl } from '../../../integrations/lark.js';
import { runScript } from '../../../integrations/shell.js';
import { systemNotify } from '../../../integrations/notify.js';
import { getActiveBot } from '../../../store/settings.js';
import { config } from '../../../shared/config.js';
import { logger } from '../../../shared/logger.js';
import { atPrefix } from '../../../shared/mention.js';
import fs from 'node:fs';
import path from 'node:path';

const POLL_MS = 5000;
let pumpTimer = null;
let running = false;

/** 仅 principal-web 进程调用：启动恢复 + 轮询泵 */
export function startAutoDevPump() {
  recoverOnBoot();
  if (pumpTimer) return;
  pumpTimer = setInterval(() => {
    tick().catch((e) => logger.error('auto-dev', 'pump 异常', { err: e?.message || String(e) }));
  }, POLL_MS);
  logger.info('auto-dev', '自动开发泵已启动');
}

/** 重启恢复：执行中断的任务退回待开发（auto 工作区自愈已接管，主工作区从未被切走） */
function recoverOnBoot() {
  for (const t of getTasks()) {
    if (t.status !== 'developing' || !t.auto) continue;
    updateTask(t.id, { status: 'analyzed' }, '进程重启，自动开发中断，退回待开发');
    logger.warn('auto-dev', '重启恢复：任务退回待开发', { id: t.id });
  }
}

async function tick() {
  if (running) return;
  const next = getTasks()
    .filter((t) => t.status === 'queued')
    .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt))[0];
  if (!next) return;
  running = true;
  try {
    await runOne(next);
  } catch (e) {
    logger.error('auto-dev', '任务执行异常', { id: next.id, err: e?.message || String(e) });
    updateTask(next.id, { status: 'analyzed' }, '自动开发异常，退回待开发');
  } finally {
    running = false;
  }
}

/** worktree 首建初始化：bot.setupScript 优先；未配置且缺依赖 → 通知 owner（不阻塞任务） */
async function runSetup(autoDir) {
  const setup = (getActiveBot()?.setupScript || '').trim();
  if (setup) {
    logger.info('auto-dev', '执行 worktree 初始化脚本', { autoDir, setup });
    const r = await runScript(setup, [], { cwd: autoDir, shell: true });
    if (!r.ok) logger.warn('auto-dev', 'setupScript 失败（不阻塞）', { err: (r.err || r.msg || '').slice(0, 300) });
    return;
  }
  if (fs.existsSync(path.join(autoDir, 'package.json')) && !fs.existsSync(path.join(autoDir, 'node_modules'))) {
    systemNotify('auto 工作区需要安装依赖', `${autoDir}\n请在该目录执行安装命令，或在机器人配置里填写初始化脚本`);
  }
}

async function runOne(task) {
  const repo = getActiveBot()?.projectDir || config.feedback.frontendDir;
  const baseBranch = await currentBranch(repo);
  if (!baseBranch || baseBranch === 'HEAD') {
    updateTask(task.id, { status: 'analyzed' }, '自动开发失败：目标工程不是 git 仓库或处于 detached HEAD');
    await replySource(task, false, null, '目标工程无法识别当前分支');
    return;
  }
  // 常驻 auto 工作区：所有自动任务在 <repo>.auto 执行，主工作区永不被切分支。
  // 创建失败明确报错转人工，不降级回主工作区（隐性降级会静默回到互相干扰的旧模型）。
  const wt = await ensureAutoWorktree(repo);
  if (!wt.ok) {
    updateTask(task.id, { status: 'analyzed' }, `自动开发失败：auto 工作区不可用（${wt.error}）`);
    systemNotify('auto 工作区创建失败', `${wt.dir}\n${wt.error}`);
    await replySource(task, false, null, '工作区准备失败');
    return;
  }
  const autoDir = wt.dir;
  if (wt.created) await runSetup(autoDir);
  // 自愈：上个任务异常中断的残留就地留痕；留痕失败则中止（脏区继续跑会把残留混进本任务提交）
  const residue = await commitResidue(autoDir);
  if (residue.dirty && !residue.committed) {
    updateTask(task.id, { status: 'analyzed' }, `自动开发失败：auto 工作区残留无法提交（${residue.error || '未知原因'}）`);
    await replySource(task, false, null, '工作区状态需人工检查');
    return;
  }

  const branch = taskBranchName(task);
  // -B 从 baseBranch 的 commit 建分支（不检出 baseBranch 本身）；幂等，崩溃重跑安全
  const co = await runScript('git', checkoutNewFromBaseArgs(autoDir, branch, baseBranch), { shell: false });
  if (!co.ok) {
    updateTask(task.id, { status: 'analyzed' }, `自动开发失败：创建任务分支 ${branch} 失败`);
    await replySource(task, false, null, '创建任务分支失败');
    return;
  }
  // repo 一并快照：合并时用任务自己的仓库（主工作区路径），不受此后切换启用机器人影响
  updateTask(task.id, { status: 'developing', auto: true, repo, branch, baseBranch, merged: false },
    `自动开发（auto 工作区，分支 ${branch}，基线 ${baseBranch}）`);

  // deferStatus=true：develop 只写 devLog，不改 status——developing→done 转移由 runOne 在 commitAll 后推进，
  // 确保「developing=执行中」不变量：仅提交成功后才写 done，recoverOnBoot 识别 developing=中断语义正确。
  // mainDir=repo：固定传入快照时的主工作区路径，消除 develop 内读 botCtx.cwd 时中途切 bot 的错配窗口。
  const r = await develop(task, { cwd: autoDir, deferStatus: true, mainDir: repo });
  const c = await commitAll(autoDir, buildCommitMessage(task, r.ok));

  if (!r.ok) {
    updateTask(task.id, { status: 'analyzed' }, '自动开发失败，退回待开发（可人工重试）');
    await replySource(task, false, null, null);
    return;
  }
  // 开发成功但 agent 未实际改码（无提交）→ 视为失败，不进合并队列
  if (!c.committed) {
    updateTask(task.id, { status: 'analyzed' }, '自动开发失败：开发过程无代码改动（agent 未实际改码）');
    await replySource(task, false, null, '开发未产生代码改动');
    return;
  }

  // developing → done：仅在改码已提交后推进，保证重启恢复不变量
  updateTask(task.id, { status: 'done' }, '自动开发完成，待确认合并');
  // 飞书私聊卡片通知（管理员本人：合并/补充/放弃）。现读盘上值传入 —— 分支/基线是上面
  // 分步写入的，卡片要靠它们判「待合并态」才给出合并按钮。fire-and-forget，失败不影响后续流程。
  notifyTaskDone(getTask(task.id), true);

  // 脱离到 detached HEAD：残留自愈提交不会落在待合并分支上
  const detach = await runScript('git', ['-C', autoDir, 'checkout', '--detach'], { shell: false });
  if (!detach.ok) logger.warn('auto-dev', 'detach HEAD 失败（不阻塞）', { id: task.id, err: (detach.err || '').slice(0, 200) });

  // 编译二维码：在 auto 工作区跑（可选能力，失败不阻塞）
  let qrUrl = null;
  try {
    const qr = await compileDevQrcode({ repo: autoDir, branch });
    qrUrl = qr.qrUrl;
  } catch (e) {
    logger.warn('auto-dev', '编译二维码失败（忽略）', { id: task.id, err: e?.message || String(e) });
  }
  await replySource(task, true, qrUrl, null, { branch, baseBranch });
}

/** 回复来源会话（仅飞书源且有 chatId）；群聊 @ 提交人；失败仅告警不阻塞 */
async function replySource(task, ok, qrUrl, failReason, branchInfo) {
  const chatId = task.source?.chatId;
  if (!chatId || task.source?.via !== 'feishu') return;
  const tag = task.type === 'bug' ? '[故障]' : '[需求]';
  // 老任务无 chatType → 前缀为空串，行为同现状（安全降级）
  const at = atPrefix(task.source?.openId, task.source?.chatType);
  try {
    if (ok) {
      await sendText(
        chatId,
        `${at}✅ ${tag}「${task.title}」已自动完成（分支 ${branchInfo?.branch}），等待管理员确认合并到 ${branchInfo?.baseBranch}。`,
      );
      if (qrUrl) await sendImageByUrl(chatId, qrUrl);
    } else {
      await sendText(chatId, `${at}❌ ${tag}「${task.title}」自动处理失败${failReason ? '：' + failReason : ''}，已转人工处理。`);
    }
  } catch (e) {
    logger.warn('auto-dev', '回复来源会话失败', { id: task.id, err: e?.message || String(e) });
  }
}

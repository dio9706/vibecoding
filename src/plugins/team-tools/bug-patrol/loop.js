/**
 * BUG 巡检循环泵 —— **仅 web 进程**常驻（与 auto-dev 泵同进程）。
 *
 * 为什么必须在 web 进程：判「本轮问题是否全修完」要读任务终态，而 auto-dev 执行泵只在
 * web 进程跑（auto-dev/index.js:39「仅 principal-web 进程调用」）。放 feishu 进程就得
 * 跨进程轮询 tasks.json，多一层无谓的竞争。飞书进程只负责收 \10001/\10004 指令并 POST 过来。
 *
 * 状态机：scanning（扫 + 等修完）→ standby（待命 20min）→ scanning → …
 * 两个出口：\10004（stopping，等已入队跑完）、12 小时到期。
 */
import { getTask } from '../../../store/tasks.js';
import { getRequirement } from '../../../store/requirements.js';
import { readLoop, updateLoop, clearLoop, markRetried } from '../../../store/patrol-loop.js';
import { requestAutoDevelop } from '../auto-dev/queue.js';
import { sendText } from '../../../integrations/lark.js';
import { atPrefix } from '../../../shared/mention.js';
import { logger } from '../../../shared/logger.js';
import { runPatrolRound } from './index.js';
import {
  TICK_MS,
  STANDBY_MS,
  QUOTA_HOLD_MS,
  allSettled,
  pickRetryable,
  isExpired,
  hasAnything,
  isQuotaError,
  buildRoundReport,
  formatDuration,
} from './loop.logic.js';

let pumpTimer = null;
let busy = false;

/** 仅 principal-web 进程调用（对齐 startAutoDevPump 范式） */
export function startPatrolLoopPump() {
  if (pumpTimer) return;
  pumpTimer = setInterval(() => {
    tick().catch((e) => logger.error('bug-patrol', 'loop pump 异常', { err: e?.message || String(e) }));
  }, TICK_MS);
  pumpTimer.unref(); // 与 auto-dev / requirement 泵一致：常驻进程不受影响，但别拖住测试进程退出
  logger.info('bug-patrol', '巡检循环泵已启动');
}

async function tick() {
  if (busy) return;
  const loop = readLoop();
  if (!loop.active) return;

  busy = true;
  try {
    // 12 小时到期优先于一切（stopping 也走这条终报路径）
    if (isExpired(loop.startedAt)) {
      await finish(loop, '已满 12 小时');
      return;
    }
    if (loop.phase === 'scanning') {
      await settleRound(loop);
      return;
    }
    // standby
    if (loop.stopping) {
      await finish(loop, '手动停止');
      return;
    }
    if (Date.now() >= loop.nextRunAt) await startRound(loop);
  } finally {
    busy = false;
  }
}

/** scanning：本轮任务是否全终结；失败的给一次重试；全完了就结算 */
async function settleRound(loop) {
  const retryable = pickRetryable(loop.cycleTaskIds, getTask, loop.retried);
  for (const id of retryable) {
    markRetried(id);
    requestAutoDevelop(id, 'BUG 巡检自动重试');
    logger.info('bug-patrol', '修复失败，自动重试一次', { taskId: id });
  }
  if (retryable.length) return; // 重试刚入队，下个 tick 再看

  if (!allSettled(loop.cycleTaskIds, getTask)) return;

  // 全终结：按任务终态一次性分流回填。
  // 入队那一刻拿不到分支名，也不知道最终成败（重试一次后才见分晓），所以 fixed/unknown
  // 在这里重建：done 的补分支名留在原类，analyzed（失败）的移进 failed。
  // failed 以 runPatrolRound 里 catch 记下的那批为基线，不能丢。
  const cur = readLoop();
  const report = { ...cur.report, fixed: [], unknown: [], failed: [...cur.report.failed] };
  for (const kind of ['fixed', 'unknown']) {
    for (const it of cur.report[kind]) {
      const t = it.taskId ? getTask(it.taskId) : null;
      if (t?.status === 'done') report[kind].push({ ...it, branch: t.branch || '' });
      else report.failed.push({ title: it.title, reason: t ? lastFailReason(t) : '任务记录已丢失' });
    }
  }

  if (cur.stopping) {
    await finish({ ...cur, report }, '手动停止');
    return;
  }

  // 空报抑制：本轮没处理过东西就不打扰人（用户拍板）
  if (hasAnything(report)) await sendReport(cur, report, 'round');
  updateLoop({
    phase: 'standby',
    nextRunAt: Date.now() + STANDBY_MS,
    cycleTaskIds: [],
    retried: {},
    report: { fixed: [], handoff: [], failed: [], unknown: [] },
  });
  logger.info('bug-patrol', '本轮结算完成，进入待命', { roundNo: cur.roundNo });
}

/** 从任务 history 里取最后一条失败原因（auto-dev 把原因写在 history 事件里，没有独立字段） */
function lastFailReason(task) {
  const h = (task?.history || []).filter((e) => /自动开发失败|异常/.test(e.event || ''));
  return h.length ? h[h.length - 1].event : '自动开发失败';
}

/** standby → scanning：跑新一轮 */
async function startRound(loop) {
  const roundNo = loop.roundNo + 1;
  updateLoop({ phase: 'scanning', roundNo, cycleTaskIds: [], retried: {} });
  logger.info('bug-patrol', '开始新一轮巡检', { roundNo });
  try {
    await runPatrolRound({
      appToken: loop.appToken,
      tableId: loop.tableId,
      url: loop.url,
      openId: loop.openId,
      chatId: loop.chatId,
      chatType: loop.chatType,
      reqId: loop.reqId,
    });
  } catch (e) {
    const msg = (e?.message || String(e)).slice(0, 200);
    logger.error('bug-patrol', '巡检轮次失败', { roundNo, err: msg });
    // 额度耗尽单独处理：20 分钟后重试只会再撞一次墙，挂起更久等 token 重置
    const quota = isQuotaError(msg);
    await say(
      loop,
      quota
        ? `⚠️ 额度已耗尽，巡检暂停 ${formatDuration(QUOTA_HOLD_MS)} 后自动重试（12 小时总时长照常计算）。`
        : `⚠️ 第 ${roundNo} 轮巡检失败：${msg}\n循环继续，${formatDuration(STANDBY_MS)} 后重试。`,
    );
    updateLoop({ phase: 'standby', nextRunAt: Date.now() + (quota ? QUOTA_HOLD_MS : STANDBY_MS) });
  }
}

/** 收尾：发最终汇报（无论 report 空否——循环结束是必须让人知道的事件）并清空状态 */
async function finish(loop, reason) {
  await sendReport(loop, loop.report, 'final', reason);
  clearLoop();
  logger.info('bug-patrol', '巡检循环结束', { reason, roundNo: loop.roundNo });
}

async function sendReport(loop, report, kind, reason) {
  const req = loop.reqId ? getRequirement(loop.reqId) : null;
  await say(
    loop,
    buildRoundReport({
      kind,
      atSelf: atPrefix(loop.openId, loop.chatType),
      reqTitle: req?.title || null,
      elapsedMs: Date.now() - loop.startedAt,
      roundNo: loop.roundNo,
      report,
      reason,
    }),
  );
}

/** 发送失败绝不能中断循环（对齐 conv-notify 的 fire-and-forget 纪律） */
async function say(loop, text) {
  try {
    await sendText(loop.chatId, text);
  } catch (e) {
    logger.error('bug-patrol', '汇报发送失败', { err: e?.message || String(e) });
  }
}

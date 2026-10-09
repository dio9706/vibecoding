/**
 * busy inbox 排空（T2-P4，spec §4.4）：run 终结 → 该 conv 有 follow-up → 从快照起下一轮。
 *
 * 为什么要有这一层：`store/runs.js` 的 inbox 只负责「存」；把「排队消息变成新 run」需要
 * 上层编排（Claude/openai 两套起跑入口）。选在 settle 监听器实现，与 conv-notify 同范式：
 * 覆盖全 provider、全终结路径（正常/异常/看门狗/手动停止/额度阻塞）的唯一收口。
 *
 * 不并发保证：起跑前先查 `findRunningRunByConv`——若该 conv 仍有 run 在跑（异常残留/多实例窄窗），
 * 不取队列，留给它的终结口排空；排空本身是「取值 → 起一个新 run」的同步序列，Node 单线程下
 * 不会被请求处理插进来，故同 conv 至多一个由 inbox 起的 run。
 *
 * 失败纪律：排空失败绝不影响 run 收尾与 SSE；起跑同步抛错时对占位新 run 走 failRun，
 * 让用户在界面上看到失败而不是一个沉默的幽灵 run。
 */
import { logger } from '../../shared/logger.js';
import {
  registerRunSettleListener,
  findRunningRunByConv,
  takeFollowUps,
  createRun,
  emitRunEvent,
  markFollowUpStarted,
  failRun,
} from '../../store/runs.js';
import { startClaudeRun } from './run-claude.js';
import { startOpenAiRun } from './run-openai.js';

let _started = false;

/** 注册排空监听器（幂等；由 server.js 在 listen 回调调用，与 startConvNotify 同范式） */
export function startConvInbox(deps) {
  if (_started) return;
  _started = true;
  registerRunSettleListener((run) => drainFollowUps(run, deps));
  logger.info('conv-inbox', 'busy inbox 排空监听器已注册');
}

/**
 * 排空某已终结 run 所在 conv 的 follow-up 队列。
 * @param {object} run 已终结的 run（读取 convId；不再依赖其其他字段）
 * @param {object} [deps] 测试注入：createRun/emitRunEvent/markFollowUpStarted/startClaudeRun/startOpenAiRun/failRun
 * @returns {{convId:string, runId:string, ids:string[]}|null} 起跑信息；无排队项/已被并发守卫拦下时为 null
 */
export function drainFollowUps(run, deps = {}) {
  const create = deps.createRun || createRun;
  const emit = deps.emitRunEvent || emitRunEvent;
  const mark = deps.markFollowUpStarted || markFollowUpStarted;
  const startClaude = deps.startClaudeRun || startClaudeRun;
  const startOpenAi = deps.startOpenAiRun || startOpenAiRun;
  const fail = deps.failRun || failRun;
  const convId = run?.convId;
  if (!convId) return null;

  let items;
  let newRun;
  try {
    // 不并发：还有 run 在跑 → 不取队列，留给它的终结口排空
    if (findRunningRunByConv(convId)) return null;
    items = takeFollowUps(convId);
    if (!items.length) return null;
    // 多条排队合并为一轮（与 steer 的 flush 语义对齐：一次终结只起一个新 run，不链式连跑）
    const first = items[0];
    const text = items.map((m) => m.text).join('\n\n');
    const ids = items.map((m) => m.id);
    newRun = create();
    newRun.convId = convId;
    mark(convId, { runId: newRun.id, ids });
    emit(newRun, 'follow_up_started', { ids, count: items.length, fromRunId: run.id, source: first.source || null });
    logger.info('conv-inbox', '排队消息已排空，起新一轮', {
      convId,
      fromRunId: run.id,
      runId: newRun.id,
      count: items.length,
    });
    try {
      if (first.provider === 'openai-compat') {
        const p = startOpenAi(newRun, {
          prompt: text,
          model: first.model || undefined,
          effort: first.effort || undefined,
          // 档位优先取「排空时刻原 run 的最新值」（用户可能在排队期间切过档；A6 起中途切档实时生效），
          // 回落排队快照。此前该字段整个丢失 → 排空轮退回 default 逐次询问（2026-10-08 用户实锤：
          // 自动档下首个 run 0 次审批，排队轮 23 次审批）
          mode: run?.mode || first.mode || undefined,
          credId: first.credId || undefined,
          cwd: first.cwd || undefined,
          convId,
        });
        // startOpenAiRun 是 async：兜底 setup 阶段的 rejection（与 routes-run 的起跑同范式）
        if (p && typeof p.catch === 'function') {
          p.catch((e) => fail(newRun, `排队消息启动失败：${e?.message || String(e)}`));
        }
      } else {
        startClaude(newRun, {
          prompt: text,
          cwd: first.cwd || undefined,
          session: first.session || undefined,
          model: first.model || undefined,
          effort: first.effort || undefined,
          mode: first.mode || undefined,
          convId,
        });
      }
    } catch (e) {
      // startClaudeRun 会在读盘（settings.json 损坏/EBUSY）时同步抛：不能把消息吞掉，
      // 让占位 run 立刻以失败终结，用户能看到「排队消息启动失败：…」
      fail(newRun, `排队消息启动失败：${e?.message || String(e)}`);
    }
    return { convId, runId: newRun.id, ids };
  } catch (e) {
    // 记账阶段失败（take/mark/emit）：不影响 run 收尾；消息已出队，只能留日志
    logger.warn('conv-inbox', '排空失败（已忽略，不影响 run 收尾）', {
      convId,
      fromRunId: run?.id || null,
      err: e?.message || String(e),
    });
    return null;
  }
}

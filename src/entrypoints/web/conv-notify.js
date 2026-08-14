/**
 * 会话飞书通知：run 终结 → 推私聊卡片；飞书补充内容 → 注入回原会话。
 *
 * 通知落点选在 store/runs.js 的终结监听器，而不是 run-claude 的 settleRun：
 * settleRun 只覆盖 Claude provider，且额度撞墙分支会提前 return；终结监听器则是
 * 全 provider、全路径（正常/异常/看门狗/手动停止/额度阻塞）的唯一收口。
 *
 * 全链路 fire-and-forget + 三层兜底（同步 try/catch + Promise catch + lark 内部不抛）：
 * 通知失败绝不能影响 run 收尾与 SSE 广播。
 */
import { createRun, registerRunSettleListener, findRunningRunByConv, holdMsg, runPulse, failRun } from '../../store/runs.js';
import { getEntry, patchConv, pushInjection } from '../../store/conv-notify.js';
import { getMyFeishuOpenId, getActiveBot } from '../../store/settings.js';
import { sendCardToUser, sendTextToUser } from '../../integrations/lark.js';
import { logger } from '../../shared/logger.js';
import { startClaudeRun } from './run-claude.js';
import { buildConvSettledCard, shouldNotifySettle, summarize } from './conv-notify.logic.js';

let _started = false;

/**
 * 注册终结监听器。由 server.js 在 listen 回调里显式调用（与 startAutoDevPump 同范式）。
 * 必须幂等：runs.js 的监听器数组只增不删、没有 unregister，
 * 重复注册会让同一条终结通知被推送多次。
 */
export function startConvNotify() {
  if (_started) return;
  _started = true;
  registerRunSettleListener(onRunSettled);
  logger.info('conv-notify', '会话飞书通知监听器已注册');
}

/**
 * run 终结回调。emitSettled 是**同步**调用且位于 SDK 流处理链内，
 * 所以这里只做廉价的准备工作，网络发送一律甩给 Promise 链后立刻返回。
 */
function onRunSettled(run) {
  try {
    if (!run?.convId) return;
    if (!shouldNotifySettle(run)) return;
    const entry = getEntry(run.convId);
    if (!entry) return; // 该会话没开通知
    const openId = getMyFeishuOpenId();
    if (!openId) {
      logger.info('conv-notify', '未配置 myFeishuOpenId，跳过通知', { convId: run.convId });
      return;
    }
    const bot = getActiveBot();
    if (!bot?.appId || !bot?.appSecret) {
      logger.info('conv-notify', '无启用中的机器人或凭证不全，跳过通知', { convId: run.convId });
      return;
    }
    const creds = { appId: bot.appId, appSecret: bot.appSecret };
    const card = buildConvSettledCard(entry, run);
    sendCardToUser(creds, openId, card)
      .then((mid) => {
        if (mid) return true;
        // 卡片发送失败（返回 null）→ 降级纯文本。此时用户点不到按钮，
        // 必须把等价的文本指令写清楚，否则这条通知就是死路一条。
        const ok = !run.is_error && run.status !== 'error';
        return sendTextToUser(
          creds,
          openId,
          `${ok ? '✅ 任务已完成' : '❌ 任务失败'}\n会话：「${entry.title || entry.convId}」\n\n${summarize(run.text)}\n\n回复「补充内容 <你的补充>」可继续该会话；回复「结束会话」则不做动作。`,
        );
      })
      .then((delivered) => {
        // 只有**确实送达**才写 lastNotifiedAt。这个时间戳会被飞书侧 pickLatestNotified
        // 当作「用户最近收到过通知的会话」来给裸发的补充内容定位目标；卡片和纯文本双双失败时
        // 还写上，等于把补充内容注入到一个用户根本没看见通知的会话里 —— 若该会话是
        // acceptEdits/bypassPermissions，就是在错误的 cwd 里直接改码。
        if (!delivered) {
          logger.warn('conv-notify', '卡片与纯文本均发送失败，不记 lastNotifiedAt', { convId: run.convId });
          return;
        }
        patchConv(run.convId, { lastNotifiedAt: new Date().toISOString() });
      })
      .catch((e) => logger.warn('conv-notify', '通知发送异常（已捕获）', { convId: run.convId, err: e?.message || String(e) }));
  } catch (e) {
    logger.warn('conv-notify', '通知准备失败（已捕获）', { err: e?.message || String(e) });
  }
}

/**
 * 把一段文本注入某会话：有运行中的 run 走插话持有，否则 resume 原 session 新起一轮。
 * @param {string} convId
 * @param {string} text
 * @returns {{ok:true, runId:string, mode:'steer'|'run'} | {ok:false, code:number, error:string}}
 */
export function injectToConv(convId, text) {
  const entry = getEntry(convId);
  if (!entry) return { ok: false, code: 404, error: '该会话未激活飞书通知' };
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return { ok: false, code: 400, error: '补充内容为空' };

  // 复用既有插话通道：run.steerHold 为真时消息进持有区，本轮 result 时统一 flush 进 SDK。
  // steerHold 为假（openai-compat 等不支持持有的 provider）则落到下面新起一轮。
  const running = findRunningRunByConv(convId);
  if (running && running.steerHold) {
    const msgId = holdMsg(running, body);
    runPulse(running); // 与 /api/run/send 保持同一范式；holdMsg 内部已 touch，这里是幂等重复调用
    pushInjection(convId, { id: msgId, text: body, runId: running.id, mode: 'steer', at: Date.now() });
    logger.info('conv-notify', '补充内容已插话', { convId, runId: running.id });
    return { ok: true, runId: running.id, mode: 'steer' };
  }

  const run = createRun();
  run.convId = convId; // 先挂上：startClaudeRun 若同步抛错，至少这个 run 还能被按会话找到
  try {
    startClaudeRun(run, {
      prompt: body,
      cwd: entry.cwd,
      session: entry.session || undefined, // 无 session 则等价开新上下文，仍照常执行
      // 'auto' 是 UI 哨兵而非真实模型 id，全仓只有 routes-run 的 classifyTier 会把它解析成
      // claude-sonnet-4-6 之类的真身；而登记表与 settings 的 model 默认值恰恰就是 'auto'，
      // 原样透传会让默认配置下的注入起跑即失败。注入路径不值得为判档多付一次分类往返，
      // 直接传 undefined 退回 SDK 默认模型（run-claude 的 `model ? {model} : {}` 会把它略去）。
      model: entry.model === 'auto' ? undefined : entry.model,
      effort: entry.effort,
      mode: entry.mode, // 不静默提权：沿用会话自己的权限模式
      convId,
    });
  } catch (e) {
    // startClaudeRun 内部会读盘（getUiPrefs），settings.json 损坏/EBUSY 时会同步抛。
    // 此时 run 已创建且 steerHold=true、status='running'，不显式终结的话，
    // 到看门狗静默上限（15min）之前所有注入都会被塞进这个死 run 的 heldMsgs 里静默丢失。
    const msg = e?.message || String(e);
    logger.warn('conv-notify', '注入起跑失败', { convId, runId: run.id, err: msg });
    failRun(run, `补充内容起跑失败：${msg}`);
    return { ok: false, code: 500, error: `起跑失败：${msg}` };
  }
  pushInjection(convId, { id: 'inj_' + run.id, text: body, runId: run.id, mode: 'run', at: Date.now() });
  logger.info('conv-notify', '补充内容已起新 run', { convId, runId: run.id, mode: entry.mode });
  return { ok: true, runId: run.id, mode: 'run' };
}

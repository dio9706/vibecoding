/**
 * 系统任务 colleague-dev 的执行侧 —— 后端同事的消息（接口文档 / 需协作的文字）触发的自动接入。
 *
 * 独立成文件而不塞进 requirement-ops.js：那里已 1300+ 行且本仓有并行会话在改；本 kind 与
 * bug-fix 的差别（新开子会话而非 resume 主会话、完成后回飞书、标记消息条目）足够多，
 * 硬放一起只会让 dispatchSystemTask 长出第二套分支。requirement-ops 的 dispatch 只加一支调
 * dispatchColleagueDev。
 *
 * 依赖方向：requirement-ops → 本文件；colleague-auto → 本文件。本文件**不得** import 这两者（成环）。
 */
import { getRequirement, updateRequirement, normalizeSessions } from '../../store/requirements.js';
import { createRun, failRun } from '../../store/runs.js';
import { appendMessage, markHandled } from '../../store/colleague-messages.js';
import { getColleague } from '../../store/colleagues.js';
import { getActiveBot } from '../../store/settings.js';
import { sendTextToUser } from '../../integrations/lark.js';
import { startClaudeRun } from './run-claude.js';
import { pickCwdAndDirs } from './req-logic.js';
import { newSubConvId, buildBrief } from './colleague-auto.logic.js';
import { logger } from '../../shared/logger.js';

export const COLLEAGUE_DEV_KIND = 'colleague-dev';

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
  if (ok) appendMessage(reqId, colleagueId, { dir: 'out', text, role: c.role, status: 'read' });
  return ok;
}

/**
 * run 收尾回调（run-claude#settleRun 在真正终结时调，此时 run.result / run.text 已可读）。
 * 清 busy 前必须确认 busy.runId 仍是本 run —— 与 requirement-ops#buildSystemTaskOnSettle 同一口径：
 * healStaleBusy 或另一条迟到的回调可能已清过并派发了下一个任务，无脑清会击穿串行闸。
 */
export function buildColleagueDevOnSettle(reqId, { msgId, colleagueId, title }, convId) {
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
    markHandled(reqId, colleagueId, msgId, { handledBy: 'ai', handledNote: (ok ? '已处理 · ' : '处理失败 · ') + title });
    // fire-and-forget：回复失败不该影响收尾其余步骤，且 onSettle 是同步回调
    replyColleague(reqId, colleagueId, buildBrief(ok, run?.result || run?.text)).catch(() => {});
  };
}

/**
 * 任务在起跑前作废（排队期间需求离开 dev / 无工程目录）：同事已经收到过「正在接入处理」，
 * 不补一句他会一直等；消息也要标 handledBy:'ai'，否则永远是未处理。
 */
export function abandonColleagueDev(reqId, { msgId, colleagueId, title }, reason) {
  updateRequirement(reqId, {}, `系统任务 ${COLLEAGUE_DEV_KIND} 作废：${reason}`);
  markHandled(reqId, colleagueId, msgId, { handledBy: 'ai', handledNote: `作废（${reason}） · ${title}` });
  replyColleague(reqId, colleagueId, buildBrief(false)).catch(() => {});
}

/**
 * 泵派发入口：新建子会话 + 起 run。与 dispatchSystemTask(bug-fix) 的两点差别：
 * ① 新 session 上下文、落到新建的子会话（不 resume devSession、不占主会话 —— 主会话可能正在开发中）；
 * ② busy 带 convId，前端据此把 run 接到正确的会话（req-chat mountReqChrome）。
 * @param {{start?: Function}} [deps] 测试注入起跑函数；本体是真实 SDK 调用，无法直测
 */
export function dispatchColleagueDev(req, payload, { start = startClaudeRun } = {}) {
  const { cwd, addDirs } = pickCwdAndDirs(req.projects);
  if (!cwd) {
    abandonColleagueDev(req.id, payload, '无可用工程目录');
    return;
  }
  const convId = newSubConvId();
  const sessions = [
    ...normalizeSessions(req),
    { convId, sessionId: null, title: payload.title, kind: 'sub', phase: req.phase, createdAt: new Date().toISOString() },
  ];
  const run = createRun();
  updateRequirement(
    req.id,
    { sessions, busy: { kind: COLLEAGUE_DEV_KIND, runId: run.id, startedAt: Date.now(), convId } },
    `系统任务 ${COLLEAGUE_DEV_KIND} 启动：${payload.title}`,
  );
  run.onSettle = buildColleagueDevOnSettle(req.id, payload, convId);
  try {
    start(run, { prompt: payload.prompt, cwd, addDirs, mode: 'bypassPermissions', convId });
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

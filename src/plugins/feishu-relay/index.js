/**
 * 飞书 → web 会话回控插件。
 *
 * order 16 是硬约束：必须抢在内核 claude-exec(20) 之前 —— 用户是 owner，
 * claude-exec 对 owner 全接，排在它后面的话「补充内容」会被当成普通对话吃掉。
 * 16 落在 status-report(14) 与 claude-exec(20) 之间，不影响既有可信人指令。
 *
 * 卡片回调只在飞书进程落地，会话注入只能在 web 进程做（run 注册表在内存）→
 * 经 http://127.0.0.1:<port> 直送。同机、无 Origin 头（origin.js 对此放行）。
 * PM2 双进程与 Tauri 一体化 sidecar 两种形态下 config.web.port 都是对的。
 */
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { registerCardKindHandler } from '../../shared/card-actions.js';
import { armSupplement, peekSupplement, takeSupplement, clearSupplement } from '../../shared/pending-supplement.js';
import { resolveTrustedOpenIds } from '../../shared/trusted-ids.js';
import { getMyFeishuOpenId, getActiveBot } from '../../store/settings.js';
import { getEntry, pickLatestNotified } from '../../store/conv-notify.js';
import { sendTextToUser, updateCard } from '../../integrations/lark.js';
import { parseConvCardAction, matchSupplementText, isEndSessionText, canOperateRelay, CONV_CARD_KIND } from './logic.js';

/** 文本兜底选目标会话的窗口：机器人重启丢了等待态时，按「最近被通知过的会话」定位 */
const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 直送超时：注入只是「登记 + 起跑」，不等 Claude 出结果，3s 足够；超时必须回执而不是干等 */
const INJECT_TIMEOUT_MS = 3000;

/** 跨进程直送：把补充内容交给 web 台 */
async function postInject(convId, text) {
  const url = `http://127.0.0.1:${config.web.port}/api/conv-notify/inject`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ convId, text }),
      signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
    });
    // 非 JSON 响应（如反代吐 HTML 错误页）不能让 .json() 抛穿：那会被外层 catch 误报成「执行台未运行」
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) return { ok: false, error: data.error || `执行台返回 ${r.status}` };
    return { ok: true, mode: data.mode, runId: data.runId };
  } catch (e) {
    logger.warn('feishu-relay', '注入执行台失败', { convId, err: e?.message || String(e) });
    return { ok: false, error: '执行台未运行或无响应，稍后再发' };
  }
}

/** 私聊回一句（卡片回调里没有 ctx.reply，只能用 open_id 私聊原语） */
async function replyToUser(openId, text) {
  const bot = getActiveBot();
  if (!bot?.appId || !bot?.appSecret) return;
  await sendTextToUser({ appId: bot.appId, appSecret: bot.appSecret }, openId, text);
}

/** 权限判定入参：每次现取，设置页改完立即生效（不缓存） */
function relayPermOpts() {
  return {
    myOpenId: getMyFeishuOpenId(),
    ownerOpenIds: config.lark.ownerOpenIds,
    trustedOpenIds: resolveTrustedOpenIds(getMyFeishuOpenId()),
  };
}

/**
 * 统一的「注入 + 回执」：卡片路径与文本路径收敛到这里，不双写。
 * 回执必须写明送到了哪个会话 —— 文本兜底是按「最近被通知的会话」猜的目标，
 * 不报出标题的话，用户没有任何机会发现自己补到了错的会话。
 */
async function doInject(convId, title, text, reply) {
  // 统一在这里剥「补充内容」前缀：用户点了按钮进等待态后，仍常习惯性再写一遍前缀，
  // 原样注入等于把这四个字当成任务内容送进模型（读起来别扭，还可能被当作指令误解）。
  // 放在收敛点而不是各调用方：文本兜底路径的正文已剥过一次，再过一道是幂等的空操作；
  // 不命中（本来就是裸文本、或只发了个光前缀）则原样用，不制造第二条分支。
  const body = matchSupplementText(text) || text;
  const r = await postInject(convId, body);
  if (!r.ok) return reply(`⚠️ ${r.error}`);
  const tail = r.mode === 'steer' ? '（已插入正在运行的任务）' : '（已续接会话开始执行）';
  return reply(`✅ 已把补充内容发到会话「${title}」${tail}`);
}

/** 卡片回调：[补充内容] / [结束会话] */
async function onConvCardAction(data) {
  const parsed = parseConvCardAction(data);
  if (!parsed) return;
  // 终态更新卡片；拿不到 messageId（报文形态异常）或更新失败只记 warn，动作本身照常执行
  const done = (text) =>
    parsed.messageId
      ? updateCard(parsed.messageId, { elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }] }).catch((e) =>
          logger.warn('feishu-relay', '卡片更新失败（动作已执行）', { convId: parsed.convId, err: e?.message || String(e) }),
        )
      : Promise.resolve();

  if (!canOperateRelay(parsed.operatorOpenId, relayPermOpts())) {
    // 不回文本：卡片虽是私聊送达，但转发后仍可能被他人点到，静默忽略避免噪音
    logger.info('feishu-relay', '非授权用户点击会话卡片，忽略', { operator: parsed.operatorOpenId });
    return;
  }

  if (parsed.action === 'end') {
    // 只结束「本次通知交互」：既不中断正在跑的 run，也不取消会话的飞书通知开关。
    // 用户点它的语义是「这条通知我看过了，不用管」，不该有任何破坏性副作用。
    clearSupplement(parsed.operatorOpenId);
    logger.info('feishu-relay', '用户结束通知交互（卡片）', { convId: parsed.convId });
    return done('🛑 已结束本次通知交互（未做任何动作）。');
  }

  // supplement：置等待态，等用户下一条消息
  const entry = getEntry(parsed.convId);
  if (!entry) return done('⚠️ 该会话已取消飞书通知，无法补充。');
  const label = entry.title || entry.convId;
  armSupplement(parsed.operatorOpenId, {
    label,
    // 闭包只捕获 convId/label：注入那一刻会话是否还激活由 web 台重新判定（未登记回 404）
    onText: (text, reply) => doInject(entry.convId, label, text, reply),
  });
  logger.info('feishu-relay', '已置等待补充态', { convId: parsed.convId, operator: parsed.operatorOpenId });
  await done(`⌛ 等待补充内容（10 分钟内有效）…\n会话：「${label}」`);
  return replyToUser(parsed.operatorOpenId, '请直接发送要补充的内容。');
}

// 模块加载即注册（feishu/web 进程都会加载插件；web 进程无卡片事件，注册无害）
registerCardKindHandler(CONV_CARD_KIND, onConvCardAction);

const feature = {
  name: 'feishu-relay',
  permission: 'any', // hasPending/match 自带门禁
  intents: [],
  /** 等待补充态：整条消息就是补充内容（只由点按钮显式置位，且一次性消费） */
  hasPending: (ctx) => !!peekSupplement(ctx.user?.id),
  handle: async (ctx) => {
    // 1. 「结束会话」放最前面：用户处在等待态时也可能改主意说「结束会话」，
    //    若排在 takeSupplement 之后，这句话会被当成补充内容注入进去。
    if (isEndSessionText(ctx.text)) {
      clearSupplement(ctx.user?.id);
      return ctx.reply('🛑 已结束本次通知交互（未做任何动作）。');
    }
    // 2. 等待态命中：整条消息就是补充内容，执行器由 arm 的一方提供（本模块对 convs 的耦合都在闭包里）
    const pendingEntry = takeSupplement(ctx.user?.id);
    if (pendingEntry) return pendingEntry.onText(String(ctx.text ?? '').trim(), ctx.reply);

    // 3. 文本兜底（match 路径）：机器人重启丢了等待态、或用户不想点按钮
    const body = matchSupplementText(ctx.text);
    if (!body) return ctx.reply('没识别到补充内容，请发「补充内容 <你的补充>」。');
    const target = pickLatestNotified(FALLBACK_WINDOW_MS);
    if (!target) return ctx.reply('近 24 小时没有收到过通知的会话，请先在网页端激活飞书通知。');
    return doInject(target.convId, target.title || target.convId, body, ctx.reply);
  },
  /**
   * 文本兜底入口。权限门禁在这里，否则群里任何人发「补充内容 xxx」都能往我的会话里塞指令。
   * 文本判定在前、权限判定在后（同 status-report 的纪律）：match 对**每条**消息都跑，
   * 而 relayPermOpts 要读两次 settings.json，绝大多数消息不该付这个盘读成本。
   * 两个操作数都是无副作用的纯谓词，换序不改语义。
   */
  match: (ctx) =>
    (isEndSessionText(ctx.text) || !!matchSupplementText(ctx.text)) &&
    canOperateRelay(ctx.user?.id, relayPermOpts()),
};

export default {
  id: 'feishu-relay',
  features: [{ order: 16, feature }],
};

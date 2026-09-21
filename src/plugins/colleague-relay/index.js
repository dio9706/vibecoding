/**
 * 同事消息中继插件。
 *
 * order=35：action-runner(30) 之后、feedback(40) 之前（理由见 feature.js 头注释）。
 * 注意本插件只覆盖**文本**入站；附件（图片/文件）在 entrypoints/feishu/index.js 的早期分支里
 * 就被接走并 return，到不了 dispatch，那条链路单独接但共用 logic.js 的判定。
 */
import { registerCardKindHandler } from '../../shared/card-actions.js';
import { logger } from '../../shared/logger.js';
import { flushPending } from '../../store/colleague-messages.js';
import { getRequirement } from '../../store/requirements.js';
import { sendTextToUser } from '../../integrations/lark.js';
import { getActiveBot } from '../../store/settings.js';
import { PICK_KIND, ACK_TEXT } from './logic.js';
import { notifyAutoHandle } from './auto-notify.js';
import { getColleague } from '../../store/colleagues.js';
import feature from './feature.js';

/** 同事在选择卡上点了某个需求 → 把缓冲里全部消息归入它 */
async function onPickCardAction(data) {
  let value = data?.action?.value ?? null;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const { openId, colleagueId, reqId } = value || {};
  if (!openId || !colleagueId || !reqId) {
    return logger.warn('colleague-relay', '选择卡回调缺少上下文', { value });
  }
  const req = getRequirement(reqId);
  const { count: n, ids } = flushPending(openId, reqId, colleagueId);
  logger.info('colleague-relay', '同事选定需求，缓冲已归入', { reqId, colleagueId, count: n });
  // 四期：flush 进来的这批一并送去判定（角色查名册；不 await，回执优先）
  if (ids.length) void notifyAutoHandle({ reqId, colleagueId, role: getColleague(colleagueId)?.role, msgIds: ids });

  // 回执走主动私聊而不是卡片回复：卡片回调里没有 ctx.reply
  const bot = getActiveBot();
  if (!bot?.appId || !bot?.appSecret) {
    return logger.warn('colleague-relay', '无启用中的飞书机器人，选定回执未发送', { openId });
  }
  const title = req?.title || '该需求';
  // n=0 说明缓冲已被消费过（重复点按钮 / 已被别的路径归入），如实告知而不是假装又归了一次
  const text = n ? `${ACK_TEXT}\n已归入需求「${title}」（${n} 条）` : '这条消息已经处理过了，无需重复选择～';
  await sendTextToUser({ appId: bot.appId, appSecret: bot.appSecret }, openId, text).catch((e) =>
    logger.warn('colleague-relay', '选定回执发送失败', { err: e?.message || String(e) }),
  );
}

// 模块加载即注册（feishu / web 进程都会加载插件；web 进程无卡片事件，注册无害）
registerCardKindHandler(PICK_KIND, onPickCardAction);

export default {
  id: 'colleague-relay',
  features: [{ order: 35, feature }],
};

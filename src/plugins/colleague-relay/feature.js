/**
 * 同事消息中继 feature（dispatch 第 ③ 段）。
 *
 * order=35：在 action-runner(30) 之后、feedback(40) 之前——同事说「帮我退款」仍该触发动作，
 * 说「接口文档给你」才归到需求对话。声明了 feedback 的那几个意图，但只在「发信人是某个
 * 开发期需求的开发人员」时接管，否则返回 PASS 让回 feedback（依赖 dispatch 的 intents 段
 * PASS 支持，见 app/dispatch.js）。
 */
import { PASS } from '../../app/signals.js';
import { logger } from '../../shared/logger.js';
import { getColleagues } from '../../store/colleagues.js';
import { getRequirements } from '../../store/requirements.js';
import { appendMessage, addPending, getPending, dropPending } from '../../store/colleague-messages.js';
import { resolveTargets, buildPickCard, ACK_TEXT } from './logic.js';
import { notifyAutoHandle } from './auto-notify.js';

/** 待归属缓冲非空 = 正在等他选需求，后续消息直接进缓冲，不重走意图识别 */
export function hasPending(ctx) {
  return !!getPending(ctx?.user?.id);
}

export async function handle(ctx) {
  const openId = ctx?.user?.id;
  const colleagues = getColleagues();
  const { colleague, reqs } = resolveTargets(openId, colleagues, getRequirements());

  // 非同事，或不在任何开发期需求中 → 让回 feedback 等后续 feature
  if (!colleague || !reqs.length) {
    // 留痕原因：dispatch 只会打一句「放弃接管（PASS）」，看不出到底为什么。
    // 排查「同事发的消息怎么被当成新需求收了」时，这一行是唯一的线索。
    logger.info('colleague-relay', '不接管，交回后续 feature', {
      openId,
      reason: !colleague ? '该 open_id 不在同事名册' : '该同事没有开发期需求',
      colleagueCount: colleagues.length,
    });
    // 已有缓冲却查不到目标（如需求中途归档 / 同事被移出指派）：必须清掉，
    // 否则 hasPending 恒为真，这位同事之后说什么都被吞进一个永远兑现不了的缓冲里
    if (getPending(openId)) {
      dropPending(openId);
      logger.warn('colleague-relay', '待归属缓冲的需求已不在开发期，缓冲已丢弃', { openId });
    }
    return PASS;
  }

  const entry = { dir: 'in', text: ctx.text || '', role: colleague.role };

  if (reqs.length === 1) {
    const saved = appendMessage(reqs[0].id, colleague.id, entry);
    logger.info('colleague-relay', '同事消息已归入需求', { reqId: reqs[0].id, colleague: colleague.name });
    // 四期：不 await —— 回执必须立刻发，自动处理的分类要几秒
    void notifyAutoHandle({ reqId: reqs[0].id, colleagueId: colleague.id, role: colleague.role, msgIds: [saved?.id] });
    return ctx.reply(ACK_TEXT);
  }

  // 多个开发期需求：先入缓冲。已在等待中就不重复发卡，否则同事连发三条会收到三张一样的卡
  const already = !!getPending(openId);
  addPending(openId, entry);
  if (already) return ctx.reply('已记下，请点上面的按钮选一下需求～');
  logger.info('colleague-relay', '同事参与多个开发期需求，发选择卡', { openId, count: reqs.length });
  return ctx.sendCard(buildPickCard(openId, colleague.id, reqs));
}

export default {
  name: 'colleague-relay',
  permission: 'any',
  intents: ['bug', 'feature', 'question', 'material', 'other'],
  hasPending,
  handle,
};

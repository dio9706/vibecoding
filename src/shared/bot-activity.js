/**
 * 机器人日志组装层 —— 埋点唯一入口。
 *
 * 职责：把埋点现场只有的 id（botId/userId）补成可展示的快照（botName/userName），
 * 截断自由文本，然后交给 store/bot-log.js 落盘。
 *
 * 放在 shared 而非 store：解析姓名要调 integrations/lark，查机器人名要读 store/settings，
 * 让 store/bot-log.js 反向依赖这两者会把存储层和业务层绑死。
 */
import { appendBotLog } from '../store/bot-log.js';
import { getBots } from '../store/settings.js';
import { getUserName } from '../integrations/lark.js';
import { logger, preview } from './logger.js';

/** detail 截断长度：面板是固定行高的单行展示，再长也会被 CSS 省略号截掉 */
const DETAIL_MAX = 60;

/** botId → 当前机器人名快照；查不到返回 null（渲染时显示「机器人 —」） */
function botNameOf(botId) {
  if (!botId) return null;
  try {
    return getBots().find((b) => b && b.id === botId)?.name || null;
  } catch {
    return null; // settings 读失败不能拖垮埋点
  }
}

/**
 * 记录一条机器人活动。**永不抛错**——埋点在用户消息处理路径上，日志失败绝不能影响主流程。
 *
 * @param {'action'|'chat'} kind 活动类型
 * @param {string} botId 机器人 id
 * @param {string} userId openId 或飞书内部 userId
 * @param {string} detail action → 动作名；chat → 用户原话
 * @param {boolean} ok 执行/处理是否成功
 * @param {number} [code] 仅 action 有意义的退出码
 */
export async function recordBotActivity({ kind, botId, userId, detail, ok, code }) {
  try {
    // 姓名解析失败返回 null，不阻断写入（渲染层回退 id 尾号）
    const userName = await getUserName(userId);
    await appendBotLog({
      botId: botId || null,
      botName: botNameOf(botId),
      userId: userId || null,
      userName,
      kind,
      detail: preview(detail, DETAIL_MAX),
      ok: !!ok,
      ...(code == null ? {} : { code }),
    });
  } catch (e) {
    logger.warn('bot-activity', '记录机器人日志失败', { kind, err: e?.message || String(e) });
  }
}

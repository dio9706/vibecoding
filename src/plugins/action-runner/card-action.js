/**
 * 快捷动作的卡片回调处理（kind = `quick-action`）。
 *
 * 为什么住在插件里：这段逻辑要调本插件的 `feature/index.js#handle`，
 * 原先它长在 `shared/card-actions.js` 内，于是形成 `shared → plugins` 的**分层倒挂**
 * —— 而那个文件本身提供的正是「按 kind 注册处理器」的解耦机制。
 * 另外三个 kind（feishu-relay 的会话卡、feedback 的评审结论、task-notify 的任务卡）
 * 一直都是各自插件自注册的，只有这一个是例外。现在对齐它们。
 *
 * 附带修正一处语义：action-runner 被停用时，本模块不会被加载，
 * `quick-action` 也就自然没有处理器 —— 这才符合「停用插件不载入业务代码」的设计。
 * 放在 shared 里时，即便插件停用，处理器仍然注册着。
 */
import { getConfig } from '../../store/action-configs.js';
import { updateCard, sendText } from '../../integrations/lark.js';
import { createInfoCard } from '../../shared/card-confirm.js';
import { logger } from '../../shared/logger.js';
import { registerCardKindHandler } from '../../shared/card-actions.js';
import { handle as runActionHandler } from './feature/index.js';

/**
 * 快捷动作执行处理（卡片按钮回调）
 * 按钮点击后直接触发动作执行流程（绕过意图识别）
 *
 * 接收原始 data 报文（与其他 kind handler 保持一致），内部自行解析所需字段：
 *   data.action.value     → { kind, actionId, actionName, botId, _timestamp }
 *   data.context.open_message_id  → messageId（v2 schema）
 *   data.context.open_chat_id     → chatId
 *   data.operator.open_id / .user_id → 操作人
 *
 * @param {object} data 飞书卡片回调原始报文
 */
export async function handleQuickAction(data) {
  // 1. 解析报文字段（与 parseVerdictCardAction / parseTaskCardAction 同款做法）
  let value = data?.action?.value ?? null;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  if (!value || value.kind !== 'quick-action') return;

  const messageId = data?.context?.open_message_id || data?.message_id || null;
  const chatId = data?.context?.open_chat_id || null;
  const operatorOpenId = data?.operator?.open_id || data?.open_id || null;
  const operatorUserId = data?.operator?.user_id || data?.user_id || null;
  const { actionId } = value;

  try {
    // 2. 获取动作配置
    const actionConfig = getConfig(actionId);
    if (!actionConfig) {
      logger.warn('card-actions', '快捷动作配置不存在', { actionId });
      if (messageId) await updateCard(messageId, createInfoCard('错误', '动作不存在或已被删除', 'error'));
      return;
    }

    // 3. 构造虚拟 context（模拟 dispatch 的 ctx 对象）
    const ctx = {
      source: 'feishu',
      user: {
        // 优先 userId（飞书内部 ID），回退 openId
        id: operatorUserId || operatorOpenId,
        role: 'member',  // 卡片回调无法确定完整角色，默认 member（canRunAction 会再判权限）
      },
      text: `执行动作: ${actionConfig.name}`,
      sessionKey: chatId,
      reply: async (msg) => {
        if (typeof msg === 'string' && chatId) {
          await sendText(chatId, msg);
        }
      },
      sendCard: async (_card) => {
        // 快捷动作的后续卡片暂不发送，以文本回复为主
      },
      meta: {
        cardMessageId: messageId,
        fromCardButton: true,
      },
    };

    // 4. 构造 intentResult（action-runner.handle 只需 actionId）
    const intentResult = { actionId };

    // 5. 执行动作（槽位填充 → 脚本执行 → 回复结果）
    await runActionHandler(ctx, intentResult);

  } catch (err) {
    logger.error('card-actions', '快捷动作执行失败', {
      actionId,
      error: err.message || String(err),
      stack: err.stack,
    });
    try {
      if (messageId) await updateCard(messageId, createInfoCard('执行失败', err.message || '未知错误', 'error'));
    } catch (updateErr) {
      logger.error('card-actions', '更新卡片状态失败', { err: updateErr.message });
    }
  }
}

// 自注册（与其余三个 kind 处理器一致：插件加载时生效，停用即不存在）
registerCardKindHandler('quick-action', handleQuickAction);

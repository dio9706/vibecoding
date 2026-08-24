/**
 * 卡片回调 kind 注册表 —— 按钮 value.kind → 处理器（如 feedback 的 review-verdict）。
 * 独立小模块而非放 feishu 入口：feedback 等插件与入口都要 import，
 * 放入口会形成 entrypoint → features → plugins → entrypoint 的环，
 * 且 web 进程 import 入口模块会误触发飞书 channel.start 等模块级副作用。
 */
import { getConfig } from '../store/action-configs.js';
import { updateCard, sendText } from '../integrations/lark.js';
import { createInfoCard } from './card-confirm.js';
import { logger } from './logger.js';
import { handle as runActionHandler } from '../plugins/action-runner/feature/index.js';

const handlers = new Map();

/** 注册 kind 处理器（插件模块加载时调用；重复注册后者覆盖前者） */
export function registerCardKindHandler(kind, handler) {
  handlers.set(kind, handler);
}

/** 取 kind 处理器；未注册返回 null（如插件被停用未加载） */
export function getCardKindHandler(kind) {
  return handlers.get(kind) || null;
}

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
async function handleQuickAction(data) {
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

// 注册 kind handler
registerCardKindHandler('quick-action', handleQuickAction);

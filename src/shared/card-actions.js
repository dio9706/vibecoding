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
 * @param {object} value 按钮 value：{ kind: 'quick-action', actionId, actionName, botId, _timestamp, ... }
 * @param {object} operator 操作人信息：{ openId, userId }
 * @param {string} messageId 卡片消息 ID
 * @param {string} chatId 群聊 ID
 */
async function handleQuickAction(value, operator, messageId, chatId) {
  const { actionId } = value;

  try {
    // 1. 获取动作配置
    const actionConfig = getConfig(actionId);
    if (!actionConfig) {
      logger.warn('card-actions', '快捷动作配置不存在', { actionId });
      await updateCard(messageId, createInfoCard('错误', '动作不存在或已被删除', 'error'));
      return;
    }

    // 2. 检查权限（简化版：暂不检查，后续可补充 canRunAction 调用）
    // const { canRunAction } = require('../plugins/action-runner/feature/permission.js');
    // if (!canRunAction(actionConfig, operator.role)) {
    //   await updateCard(messageId, createInfoCard('错误', '权限不足', 'error'));
    //   return;
    // }

    // 3. 构造虚拟 context（模拟 dispatch 的 ctx 对象）
    const ctx = {
      source: 'feishu',
      user: {
        id: operator.userId || operator.openId,
        role: 'member',  // 卡片来源无法确定完整角色，默认 member
      },
      text: `执行动作: ${actionConfig.name}`,
      sessionKey: chatId,
      reply: async (msg) => {
        // 发送追问或结果消息（卡片内的快捷动作通常不需追问）
        if (typeof msg === 'string') {
          await sendText(chatId, msg);
        }
      },
      sendCard: async (card) => {
        // 卡片内动作的后续卡片发送
        // 暂不实现，后续根据需求补充
      },
      meta: {
        cardMessageId: messageId,
        fromCardButton: true,
      },
    };

    // 4. 构造 intentResult 对象以调用 action-runner.handle()
    const intentResult = {
      actionId,
      type: 'action',
      confidence: 1.0,  // 100% 确信来自卡片，无需 LLM 识别
    };

    // 5. 执行动作（handle 会调用 proceedWithAction → executeAction）
    const result = await runActionHandler(ctx, intentResult);

    // handle 返回 PASS 表示消息未被处理，result 为其他值（如 undefined）表示已处理
    if (result !== undefined && result.toString() === 'PASS') {
      logger.warn('card-actions', '快捷动作被 PASS 返回（不应发生）', { actionId });
    }

  } catch (err) {
    logger.error('card-actions', '快捷动作执行失败', {
      actionId: value.actionId,
      error: err.message || String(err),
      stack: err.stack,
    });
    try {
      await updateCard(messageId, createInfoCard('执行失败', err.message || '未知错误', 'error'));
    } catch (updateErr) {
      logger.error('card-actions', '更新卡片状态失败', { err: updateErr.message });
    }
  }
}

// 注册 kind handler
registerCardKindHandler('quick-action', handleQuickAction);

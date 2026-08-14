/**
 * 卡片确认助手 —— 生成标准确认卡片 + 处理回调 + 更新为已确认/已取消状态。
 * 使用示例：
 *   const confirm = createConfirmCard('是否执行 git push？', 'git push origin main', { taskId: 'xxx' });
 *   const card = await channel.sendCard(chatId, confirm.card);
 *   // 用户点击按钮后，回调获得 { action: 'confirm' | 'cancel', value: { ... } }
 *   await channel.updateCard(card.message_id, confirm.confirmed());
 */

/**
 * 生成确认卡片（带确认/取消按钮）
 * @param {string} title - 卡片标题
 * @param {string} detail - 详细内容（支持 Markdown，会被包在 lark_md tag 里）
 * @param {object} [value={}] - 卡片按钮回调时的自定义数据，会回传给回调处理
 * @returns {object} { card, confirmed(), cancelled() }
 */
export function createConfirmCard(title, detail = '', value = {}) {
  const baseValue = { ...value, _timestamp: Date.now() };

  const card = {
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${title}**\n\`\`\`\n${detail}\n\`\`\``,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 确认' },
            type: 'primary',
            value: { action: 'confirm', ...baseValue },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 取消' },
            type: 'danger',
            value: { action: 'cancel', ...baseValue },
          },
        ],
      },
    ],
  };

  return {
    card,
    // 确认后的卡片（按钮改为只读文本）
    confirmed: () => ({
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `✅ **已确认** — ${title}\n\`\`\`\n${detail}\n\`\`\`\n\n正在处理中…`,
          },
        },
      ],
    }),
    // 取消后的卡片
    cancelled: () => ({
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `❌ **已取消** — ${title}`,
          },
        },
      ],
    }),
  };
}

/**
 * 生成纯信息卡片（无按钮，用于最终状态或只读展示）
 * @param {string} title - 标题
 * @param {string} [detail=''] - 内容
 * @param {string} [type='info'] - 类型: 'info' | 'success' | 'warning' | 'error'
 * @returns {object} 卡片 JSON
 */
export function createInfoCard(title, detail = '', type = 'info') {
  const emoji = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '❌',
  }[type] || 'ℹ️';

  return {
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${emoji} **${title}**\n${detail ? `\`\`\`\n${detail}\n\`\`\`` : ''}`,
        },
      },
    ],
  };
}

/**
 * 从回调事件提取用户选择的操作和自定义数据
 * @param {object} callbackData - 飞书 card.action.trigger 回调数据
 * @returns {object|null} { action: 'confirm'|'cancel', value: {...}, operator: {...} } 或 null 如果格式错误
 */
export function parseCardAction(callbackData) {
  try {
    const value = callbackData?.action?.value || {};
    const action = value.action;
    if (!action || !['confirm', 'cancel'].includes(action)) return null;
    return {
      action,
      value,
      operator: {
        openId: callbackData?.operator?.open_id,
        userId: callbackData?.operator?.user_id,
      },
      messageId: callbackData?.message_id,
      chatId: callbackData?.conversation?.chat_id,
    };
  } catch {
    return null;
  }
}

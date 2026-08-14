/**
 * 卡片端到端集成测试
 * 模拟飞书渠道、卡片发送、回调处理的完整流程
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createConfirmCard, parseCardAction } from '../src/shared/card-confirm.js';

// Mock 飞书 channel
const mockChannel = {
  sendCard: vi.fn(async (chatId, card) => ({ message_id: 'om_mock_123' })),
  updateCard: vi.fn(async (messageId, card) => ({ ok: true })),
};

// Mock 卡片回调处理器存储
const cardHandlers = new Map();

function registerCardActionHandler(messageId, handler) {
  cardHandlers.set(messageId, handler);
}

describe('Card Integration Flow', () => {
  beforeEach(() => {
    mockChannel.sendCard.mockClear();
    mockChannel.updateCard.mockClear();
    cardHandlers.clear();
  });

  it('应该完成完整的确认流程：发卡片 → 用户点击 → 更新卡片', async () => {
    // 第 1 步：生成并发送确认卡片
    const { card, confirmed } = createConfirmCard(
      '确认操作',
      'test operation',
      { opId: 'op-123', userId: 'user-456' }
    );

    const sendResult = await mockChannel.sendCard('oc_chat_id', card);
    const messageId = sendResult.message_id;

    // 验证卡片已发送
    expect(mockChannel.sendCard).toHaveBeenCalledWith('oc_chat_id', card);
    expect(messageId).toBeDefined();

    // 第 2 步：为卡片注册回调处理器
    let actionReceived = null;
    registerCardActionHandler(messageId, async (callbackData) => {
      const action = parseCardAction(callbackData);
      actionReceived = action;

      if (action?.action === 'confirm') {
        await mockChannel.updateCard(messageId, confirmed());
      }
    });

    // 验证处理器已注册
    expect(cardHandlers.has(messageId)).toBe(true);

    // 第 3 步：模拟用户点击确认按钮
    const fakeCallbackData = {
      message_id: messageId,
      conversation: { chat_id: 'oc_chat_id' },
      operator: { open_id: 'ou_user_123', user_id: 'user-456' },
      action: {
        value: {
          action: 'confirm',
          opId: 'op-123',
          userId: 'user-456',
        },
      },
    };

    // 触发回调处理器
    const handler = cardHandlers.get(messageId);
    await handler(fakeCallbackData);

    // 验证回调已收到并解析
    expect(actionReceived).not.toBeNull();
    expect(actionReceived.action).toBe('confirm');
    expect(actionReceived.value.opId).toBe('op-123');

    // 验证卡片已更新
    expect(mockChannel.updateCard).toHaveBeenCalledWith(messageId, expect.any(Object));
    const updateCall = mockChannel.updateCard.mock.calls[0][1];
    expect(updateCall.elements[0].text.content).toContain('已确认');
  });

  it('应该处理用户取消的情况', async () => {
    const { card, cancelled } = createConfirmCard(
      '危险操作',
      'delete all data',
      { dangerous: true }
    );

    const sendResult = await mockChannel.sendCard('oc_chat_id', card);
    const messageId = sendResult.message_id;

    let actionReceived = null;
    registerCardActionHandler(messageId, async (callbackData) => {
      const action = parseCardAction(callbackData);
      actionReceived = action;

      if (action?.action === 'cancel') {
        await mockChannel.updateCard(messageId, cancelled());
      }
    });

    // 用户点击取消
    const fakeCallbackData = {
      message_id: messageId,
      conversation: { chat_id: 'oc_chat_id' },
      operator: { open_id: 'ou_user_123' },
      action: {
        value: {
          action: 'cancel',
          dangerous: true,
        },
      },
    };

    const handler = cardHandlers.get(messageId);
    await handler(fakeCallbackData);

    // 验证更新为取消状态
    expect(actionReceived.action).toBe('cancel');
    const updateCall = mockChannel.updateCard.mock.calls[0][1];
    expect(updateCall.elements[0].text.content).toContain('已取消');
  });

  it('应该支持多步骤的依序确认', async () => {
    const steps = ['第一步', '第二步', '第三步'];
    let completedSteps = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const { card, confirmed } = createConfirmCard(`${i + 1}. ${step}`, '');

      const sendResult = await mockChannel.sendCard('oc_chat_id', card);
      const messageId = sendResult.message_id;

      // 为当前步骤注册回调
      await new Promise((resolve) => {
        registerCardActionHandler(messageId, async (callbackData) => {
          const action = parseCardAction(callbackData);
          if (action?.action === 'confirm') {
            completedSteps++;
            await mockChannel.updateCard(messageId, confirmed());
          }
          resolve();
        });

        // 立即模拟用户点击确认
        const handler = cardHandlers.get(messageId);
        handler({
          message_id: messageId,
          conversation: { chat_id: 'oc_chat_id' },
          operator: { open_id: 'ou_user' },
          action: {
            value: { action: 'confirm', step: i },
          },
        });
      });
    }

    // 验证所有步骤都已确认
    expect(completedSteps).toBe(3);
    expect(mockChannel.sendCard).toHaveBeenCalledTimes(3);
    expect(mockChannel.updateCard).toHaveBeenCalledTimes(3);
  });

  it('应该在回调数据无效时安全处理', async () => {
    const { card } = createConfirmCard('测试', 'test');
    const sendResult = await mockChannel.sendCard('oc_chat_id', card);
    const messageId = sendResult.message_id;

    let errorHandled = false;
    registerCardActionHandler(messageId, async (callbackData) => {
      const action = parseCardAction(callbackData);
      if (!action) {
        errorHandled = true;
        return; // 安全退出
      }
    });

    // 发送无效的回调数据
    const handler = cardHandlers.get(messageId);
    await handler({
      message_id: messageId,
      action: { value: { action: 'invalid_action' } },
    });

    expect(errorHandled).toBe(true);
    // 卡片不应该被更新
    expect(mockChannel.updateCard).not.toHaveBeenCalled();
  });

  it('应该支持自定义数据的往返传递', async () => {
    const customData = {
      projectId: 'proj-123',
      environment: 'production',
      approver: 'team-leads',
      version: 'v1.2.3',
    };

    const { card, confirmed } = createConfirmCard(
      '发布到生产',
      'version: v1.2.3',
      customData
    );

    const sendResult = await mockChannel.sendCard('oc_chat_id', card);
    const messageId = sendResult.message_id;

    let receivedData = null;
    registerCardActionHandler(messageId, async (callbackData) => {
      const action = parseCardAction(callbackData);
      if (action?.action === 'confirm') {
        // 保存接收到的自定义数据
        receivedData = {
          projectId: action.value.projectId,
          environment: action.value.environment,
          approver: action.value.approver,
          version: action.value.version,
        };
        await mockChannel.updateCard(messageId, confirmed());
      }
    });

    const handler = cardHandlers.get(messageId);
    await handler({
      message_id: messageId,
      conversation: { chat_id: 'oc_chat_id' },
      operator: { open_id: 'ou_approver' },
      action: {
        value: {
          action: 'confirm',
          ...customData,
        },
      },
    });

    // 验证自定义数据完整往返
    expect(receivedData).toEqual(customData);
  });

  it('应该能够生成有效的 JSON 供飞书使用', () => {
    const { card, confirmed, cancelled } = createConfirmCard(
      '测试标题',
      '多行内容\n第二行\n第三行',
      { test: 'data' }
    );

    // 验证都能序列化为 JSON（飞书 API 需要）
    expect(() => JSON.stringify(card)).not.toThrow();
    expect(() => JSON.stringify(confirmed())).not.toThrow();
    expect(() => JSON.stringify(cancelled())).not.toThrow();

    // 验证 JSON 内容合法
    const cardJson = JSON.stringify(card);
    expect(cardJson).toContain('elements');
    expect(cardJson).toContain('action');
    expect(cardJson).toContain('confirm');
    expect(cardJson).toContain('cancel');
  });
});

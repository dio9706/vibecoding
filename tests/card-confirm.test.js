/**
 * 卡片确认功能单元测试
 */

import { describe, it, expect } from 'vitest';
import { createConfirmCard, createInfoCard, parseCardAction } from '../src/shared/card-confirm.js';

describe('card-confirm', () => {
  describe('createConfirmCard', () => {
    it('应该生成标准的确认卡片', () => {
      const { card, confirmed, cancelled } = createConfirmCard(
        '确认执行',
        'git push origin main',
        { taskId: '123' }
      );

      // 验证卡片结构
      expect(card).toHaveProperty('elements');
      expect(card.elements.length).toBe(2); // div + action
      expect(card.elements[0].tag).toBe('div');
      expect(card.elements[1].tag).toBe('action');

      // 验证按钮
      const actions = card.elements[1].actions;
      expect(actions.length).toBe(2);
      expect(actions[0].value.action).toBe('confirm');
      expect(actions[1].value.action).toBe('cancel');

      // 验证自定义数据传递
      expect(actions[0].value.taskId).toBe('123');
      expect(actions[1].value.taskId).toBe('123');
    });

    it('应该生成确认后的卡片状态', () => {
      const { confirmed } = createConfirmCard('标题', '内容');
      const confirmedCard = confirmed();

      expect(confirmedCard).toHaveProperty('elements');
      expect(confirmedCard.elements[0].text.content).toContain('✅');
      expect(confirmedCard.elements[0].text.content).toContain('已确认');
    });

    it('应该生成取消后的卡片状态', () => {
      const { cancelled } = createConfirmCard('标题', '内容');
      const cancelledCard = cancelled();

      expect(cancelledCard).toHaveProperty('elements');
      expect(cancelledCard.elements[0].text.content).toContain('❌');
      expect(cancelledCard.elements[0].text.content).toContain('已取消');
    });

    it('应该支持多行内容', () => {
      const { card } = createConfirmCard(
        '标题',
        'line1\nline2\nline3'
      );

      const text = card.elements[0].text.content;
      expect(text).toContain('line1');
      expect(text).toContain('line2');
      expect(text).toContain('line3');
    });
  });

  describe('createInfoCard', () => {
    it('应该生成信息卡片（info 类型）', () => {
      const card = createInfoCard('提示', '这是一条提示信息');

      expect(card).toHaveProperty('elements');
      expect(card.elements[0].text.content).toContain('ℹ️');
    });

    it('应该支持不同的信息类型', () => {
      const types = {
        info: 'ℹ️',
        success: '✅',
        warning: '⚠️',
        error: '❌',
      };

      Object.entries(types).forEach(([type, emoji]) => {
        const card = createInfoCard('标题', '内容', type);
        expect(card.elements[0].text.content).toContain(emoji);
      });
    });

    it('应该生成无内容的纯标题卡片', () => {
      const card = createInfoCard('仅有标题');
      const text = card.elements[0].text.content;

      expect(text).toContain('仅有标题');
      expect(text).not.toContain('```');
    });
  });

  describe('parseCardAction', () => {
    it('应该正确解析确认操作', () => {
      const callbackData = {
        message_id: 'om_xxx',
        conversation: { chat_id: 'oc_xxx' },
        operator: { open_id: 'ou_xxx', user_id: 'u123' },
        action: {
          value: {
            action: 'confirm',
            taskId: 'task123',
            timestamp: 1000,
          },
        },
      };

      const result = parseCardAction(callbackData);

      expect(result).not.toBeNull();
      expect(result.action).toBe('confirm');
      expect(result.value.taskId).toBe('task123');
      expect(result.operator.openId).toBe('ou_xxx');
      expect(result.messageId).toBe('om_xxx');
      expect(result.chatId).toBe('oc_xxx');
    });

    it('应该正确解析取消操作', () => {
      const callbackData = {
        message_id: 'om_yyy',
        conversation: { chat_id: 'oc_yyy' },
        operator: { open_id: 'ou_yyy' },
        action: {
          value: {
            action: 'cancel',
            taskId: 'task456',
          },
        },
      };

      const result = parseCardAction(callbackData);

      expect(result).not.toBeNull();
      expect(result.action).toBe('cancel');
      expect(result.value.taskId).toBe('task456');
    });

    it('应该在无效操作时返回 null', () => {
      const callbackData = {
        action: {
          value: {
            action: 'invalid', // 无效的操作
          },
        },
      };

      const result = parseCardAction(callbackData);
      expect(result).toBeNull();
    });

    it('应该在无操作值时返回 null', () => {
      const result = parseCardAction({ action: {} });
      expect(result).toBeNull();
    });

    it('应该在格式错误时返回 null', () => {
      const result = parseCardAction(null);
      expect(result).toBeNull();

      const result2 = parseCardAction(undefined);
      expect(result2).toBeNull();

      const result3 = parseCardAction('not an object');
      expect(result3).toBeNull();
    });

    it('应该保留所有自定义数据', () => {
      const callbackData = {
        message_id: 'om_xxx',
        conversation: { chat_id: 'oc_xxx' },
        operator: { open_id: 'ou_xxx' },
        action: {
          value: {
            action: 'confirm',
            customField1: 'value1',
            customField2: 123,
            nested: { data: 'test' },
          },
        },
      };

      const result = parseCardAction(callbackData);

      expect(result.value.customField1).toBe('value1');
      expect(result.value.customField2).toBe(123);
      expect(result.value.nested.data).toBe('test');
    });
  });

  describe('集成测试', () => {
    it('应该支持完整的确认流程', () => {
      // 1. 创建卡片
      const { card, confirmed } = createConfirmCard(
        '确认操作',
        '待执行的操作描述',
        { operationId: 'op-001' }
      );

      // 验证卡片可以序列化为 JSON（飞书需要）
      const json = JSON.stringify(card);
      expect(json).toBeDefined();
      expect(json.length).toBeGreaterThan(0);

      // 2. 模拟用户点击
      const fakeCallback = {
        message_id: 'om_test',
        conversation: { chat_id: 'oc_test' },
        operator: { open_id: 'ou_test' },
        action: {
          value: {
            action: 'confirm',
            operationId: 'op-001',
          },
        },
      };

      // 3. 解析回调
      const action = parseCardAction(fakeCallback);
      expect(action).not.toBeNull();
      expect(action.action).toBe('confirm');
      expect(action.value.operationId).toBe('op-001');

      // 4. 生成确认后的卡片
      const confirmedCard = confirmed();
      const confirmedJson = JSON.stringify(confirmedCard);
      expect(confirmedJson).toBeDefined();
      expect(confirmedCard.elements[0].text.content).toContain('已确认');
    });
  });
});

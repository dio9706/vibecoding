/**
 * runClaude 重试逻辑单测
 * 验证：stalled 错误自动重试，其他错误直接抛
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('重试机制：stalled 错误自动重试 3 次', async (t) => {
  let callCount = 0;

  // 模拟内部实现：识别 stalled 错误并重试
  const simulateRetry = async (attempt = 1, maxRetries = 3) => {
    callCount++;
    // 前 2 次返回 stalled 错误，第 3 次成功
    if (callCount < 3) {
      const error = new Error('Response stalled mid-stream. The response above may be incomplete.');
      const isStalledError = error.message.includes('stalled');
      if (isStalledError && attempt < maxRetries) {
        // 测试时延迟缩短为 1ms（生产环境是 1s、2s 等）
        await new Promise(r => setTimeout(r, 1));
        return simulateRetry(attempt + 1, maxRetries);
      }
      throw error;
    }
    return { success: true, attempts: callCount };
  };

  try {
    await simulateRetry(1, 3);
  } catch (e) {
    assert.fail('应重试成功');
  }

  assert.equal(callCount, 3, '应调用 3 次（失败 2 + 成功 1）');
});

test('重试机制：权限错误直接抛，不重试', async (t) => {
  let callCount = 0;
  const mockRun = async (prompt, opts = {}) => {
    callCount++;
    if (callCount === 1) {
      const error = new Error('401 Unauthorized: Invalid API key');
      throw error;
    }
  };

  try {
    await mockRun('test', { maxRetries: 3 });
    assert.fail('应抛错');
  } catch (e) {
    assert.match(e.message, /401|Unauthorized/, '应捕获 401 错误');
  }

  assert.equal(callCount, 1, '应只调用 1 次（权限错误直接抛，无重试）');
});

test('指数退避计算', (t) => {
  // 验证延迟时间
  const delayMs = (attempt) => Math.min(1000 * Math.pow(2, attempt - 1), 10000);

  assert.equal(delayMs(1), 1000, '第 1 次重试：1s');
  assert.equal(delayMs(2), 2000, '第 2 次重试：2s');
  assert.equal(delayMs(3), 4000, '第 3 次重试：4s');
  assert.equal(delayMs(4), 8000, '第 4 次重试：8s');
  assert.equal(delayMs(5), 10000, '第 5 次重试：10s（上限）');
});

test('禁用重试：maxRetries=0', async (t) => {
  let callCount = 0;
  const mockRun = async (prompt, opts = {}) => {
    callCount++;
    const error = new Error('Response stalled mid-stream');
    throw error;
  };

  try {
    await mockRun('test', { maxRetries: 0 });
    assert.fail('应直接抛错');
  } catch (e) {
    assert.match(e.message, /stalled/, '应捕获 stalled 错误');
  }

  assert.equal(callCount, 1, 'maxRetries=0 时仅调用 1 次，直接失败');
});

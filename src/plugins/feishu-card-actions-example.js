/**
 * 飞书卡片交互示例 —— 展示如何使用卡片确认
 *
 * 这个模块演示了几个实际应用场景：
 * 1. 确认执行 Git 操作
 * 2. 批准任务状态变更
 * 3. 条件分支选择（多按钮）
 * 4. 长流程多步确认
 */

import { getChannel } from '../channels/index.js';
import { createConfirmCard, createInfoCard, parseCardAction } from '../shared/card-confirm.js';
import { registerCardActionHandler } from '../entrypoints/feishu/index.js';
import { logger } from '../shared/logger.js';

const channel = getChannel('feishu');

/**
 * 示例 1: Git 操作确认
 * 使用场景：用户请求机器人执行 git push，机器人先发卡片要求确认
 */
export async function confirmGitOperation(ctx, { branch = 'main', force = false }) {
  const branchDisplay = force ? `${branch} (--force)` : branch;
  const command = force ? `git push --force origin ${branch}` : `git push origin ${branch}`;

  const { card, confirmed, cancelled } = createConfirmCard(
    '确认执行 Git 操作',
    command,
    { operation: 'git_push', branch, force, userId: ctx.user.id }
  );

  try {
    const result = await channel.sendCard(ctx.sessionKey, card);
    if (!result?.message_id) {
      await ctx.reply('❌ 发送确认卡片失败，请重试');
      return;
    }

    registerCardActionHandler(result.message_id, async (callbackData) => {
      const action = parseCardAction(callbackData);
      if (!action) {
        logger.warn('feishu', 'Git 操作卡片回调解析失败', { data: callbackData });
        return;
      }

      if (action.action === 'confirm') {
        await channel.updateCard(result.message_id, confirmed());
        try {
          // 这里调用实际的 git 操作（示例中省略）
          await performGitPush(branch, force);
          await ctx.reply(`✅ Git push 已执行: ${branchDisplay}`);
        } catch (e) {
          await ctx.reply(`❌ Git push 失败: ${e.message}`);
        }
      } else {
        await channel.updateCard(result.message_id, cancelled());
        await ctx.reply(`❌ 已取消 Git push`);
      }
    });
  } catch (e) {
    logger.error('feishu', 'Git 操作确认失败', { err: e.message });
    await ctx.reply(`❌ 确认流程失败: ${e.message}`);
  }
}

/**
 * 示例 2: 任务状态变更批准
 * 使用场景：变更任务状态需要人工确认
 */
export async function confirmTaskStatusChange(ctx, { taskId, newStatus }) {
  // 模拟从数据库加载任务
  const task = await loadTaskMock(taskId);
  if (!task) {
    await ctx.reply(`❌ 任务不存在: ${taskId}`);
    return;
  }

  const detail = `任务 ID: ${taskId}\n标题: ${task.title}\n当前状态: ${task.status}\n新状态: ${newStatus}`;

  const { card, confirmed, cancelled } = createConfirmCard(
    '确认变更任务状态',
    detail,
    { taskId, newStatus, operator: ctx.user.id }
  );

  try {
    const result = await channel.sendCard(ctx.sessionKey, card);
    if (!result?.message_id) {
      await ctx.reply('❌ 发送确认卡片失败');
      return;
    }

    registerCardActionHandler(result.message_id, async (callbackData) => {
      const action = parseCardAction(callbackData);
      if (!action) return;

      if (action.action === 'confirm') {
        await channel.updateCard(result.message_id, confirmed());
        try {
          await updateTaskStatusMock(taskId, newStatus);
          await ctx.reply(`✅ 任务状态已更新: ${task.title} → ${newStatus}`);
        } catch (e) {
          await ctx.reply(`❌ 更新失败: ${e.message}`);
        }
      } else {
        await channel.updateCard(result.message_id, cancelled());
        await ctx.reply(`❌ 已取消变更`);
      }
    });
  } catch (e) {
    logger.error('feishu', '任务变更确认失败', { err: e.message });
    await ctx.reply(`❌ 确认流程失败: ${e.message}`);
  }
}

/**
 * 示例 3: 多选项卡片（不用 createConfirmCard，手动构造）
 * 使用场景：选择部署环境
 */
export async function selectDeploymentEnvironment(ctx, version) {
  const card = {
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**选择部署环境** (版本: ${version})\n\n将要部署以下版本，请选择目标环境：`,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📝 Dev' },
            value: { action: 'deploy', env: 'dev', version },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🧪 Staging' },
            value: { action: 'deploy', env: 'staging', version },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🚀 Production' },
            type: 'danger',
            value: { action: 'deploy', env: 'production', version },
          },
        ],
      },
    ],
  };

  try {
    const result = await channel.sendCard(ctx.sessionKey, card);
    if (!result?.message_id) {
      await ctx.reply('❌ 发送环境选择卡片失败');
      return;
    }

    registerCardActionHandler(result.message_id, async (callbackData) => {
      const action = parseCardAction(callbackData);
      if (!action || action.action !== 'deploy') return;

      const env = action.value.env;
      const deployVersion = action.value.version;

      // 更新卡片为执行中
      await channel.updateCard(
        result.message_id,
        createInfoCard('正在部署...', `环境: ${env}\n版本: ${deployVersion}`)
      );

      try {
        await deployToEnvironmentMock(env, deployVersion);
        await channel.updateCard(
          result.message_id,
          createInfoCard(
            '✅ 部署成功',
            `环境: ${env}\n版本: ${deployVersion}\n时间: ${new Date().toLocaleString()}`,
            'success'
          )
        );
        await ctx.reply(`✅ 已部署到 ${env}`);
      } catch (e) {
        await channel.updateCard(
          result.message_id,
          createInfoCard('❌ 部署失败', `${e.message}`, 'error')
        );
        await ctx.reply(`❌ 部署失败: ${e.message}`);
      }
    });
  } catch (e) {
    logger.error('feishu', '环境选择失败', { err: e.message });
    await ctx.reply(`❌ 无法发送环境选择: ${e.message}`);
  }
}

/**
 * 示例 4: 长流程 - 多步骤依次确认
 * 使用场景：发布流程需要多个确认步骤
 */
export async function multiStepReleaseApproval(ctx, { appName, version, steps }) {
  const stepsInfo = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  await ctx.reply(`📦 开始发布 ${appName} v${version}\n\n${stepsInfo}\n\n请逐步确认各项操作…`);

  let completed = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const { card, confirmed, cancelled } = createConfirmCard(
      `[${i + 1}/${steps.length}] ${step}`,
      `应用: ${appName}\n版本: ${version}`,
      { step: i, appName, version }
    );

    try {
      const result = await channel.sendCard(ctx.sessionKey, card);
      if (!result?.message_id) {
        await ctx.reply(`❌ 无法发送第 ${i + 1} 步的确认卡片`);
        break;
      }

      // 等待这一步的确认（Promise 化）
      await new Promise((resolve) => {
        registerCardActionHandler(result.message_id, async (callbackData) => {
          const action = parseCardAction(callbackData);
          if (!action) return;

          if (action.action === 'confirm') {
            await channel.updateCard(result.message_id, confirmed());
            try {
              await executeReleaseStepMock(step);
              completed++;
              resolve();
            } catch (e) {
              await ctx.reply(`❌ 第 ${i + 1} 步执行失败: ${e.message}`);
              resolve();
            }
          } else {
            await channel.updateCard(result.message_id, cancelled());
            await ctx.reply(`❌ 已取消发布（已完成 ${completed}/${steps.length} 步）`);
            resolve();
          }
        });
      });

      if (completed < i + 1) break; // 用户取消了，中止后续步骤
    } catch (e) {
      logger.error('feishu', `第 ${i + 1} 步确认失败`, { err: e.message });
      await ctx.reply(`❌ 第 ${i + 1} 步确认失败: ${e.message}`);
      break;
    }
  }

  if (completed === steps.length) {
    await ctx.reply(`✅ 发布完成！${appName} v${version} 已上线。`);
  }
}

// ===== Mock 实现（实际应用中改为真实业务逻辑） =====

async function performGitPush(branch, force) {
  // 模拟 git push 操作
  return new Promise((resolve) => setTimeout(resolve, 1000));
}

async function loadTaskMock(taskId) {
  return {
    id: taskId,
    title: '实现用户认证功能',
    status: '进行中',
  };
}

async function updateTaskStatusMock(taskId, status) {
  return new Promise((resolve) => setTimeout(resolve, 500));
}

async function deployToEnvironmentMock(env, version) {
  return new Promise((resolve) => setTimeout(resolve, 2000));
}

async function executeReleaseStepMock(step) {
  return new Promise((resolve) => setTimeout(resolve, 1000));
}

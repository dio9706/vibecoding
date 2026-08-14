/**
 * 需求/故障任务完成 → 飞书私聊卡片（发给**管理员本人**），并处理卡片上的三个操作。
 *
 * 与 auto-dev 现有「回告提交人」的纯文本通知并存、互不替代：那条是给提交人看进度，
 * 这条是给管理员本人做决策（合并 / 补充 / 放弃）。
 *
 * 全链路 fire-and-forget + 三层兜底（同步 try/catch + Promise catch + lark 内部不抛）：
 * 通知失败绝不能影响任务状态流转 —— 任务已经落 done 了，发不出一条飞书消息
 * 不该让 develop()/runOne() 抛错，更不该把已完成的任务退回。
 *
 * 权限判定与卡片编排的依赖都取自内核（shared/trusted-ids.js、shared/pending-supplement.js）：
 * 插件之间禁止互相 import（停用 feishu-relay 不能把 team-tools 一起带崩）。
 */
import { logger } from '../../shared/logger.js';
import { config } from '../../shared/config.js';
import { registerCardKindHandler } from '../../shared/card-actions.js';
import { armSupplement, matchSupplementText } from '../../shared/pending-supplement.js';
import { canOperateRelay, resolveTrustedOpenIds } from '../../shared/trusted-ids.js';
import { getTask, updateTask } from '../../store/tasks.js';
import { getUiPrefs, getMyFeishuOpenId, getActiveBot, getPluginEnabled } from '../../store/settings.js';
import { sendCardToUser, sendTextToUser, updateCard } from '../../integrations/lark.js';
import { mergeTaskById, discardTaskById, isAwaitingMerge, isDiscardable } from './task-actions.js';
import { requestAutoDevelop } from './auto-dev/index.js';
import { buildTaskDoneCard, taskResultCard, parseTaskCardAction, TASK_CARD_KIND } from './task-notify.logic.js';

/** 当前启用机器人的私聊发送凭证；不全返回 null（调用方据此跳过，不硬发） */
function creds() {
  const bot = getActiveBot();
  return bot?.appId && bot?.appSecret ? { appId: bot.appId, appSecret: bot.appSecret } : null;
}

/**
 * 任务落 done 后调用。两个 done 写入点各调一次且互不重叠
 * （task-ops.develop 只在 !deferStatus 分支调，deferStatus 路径由 auto-dev runOne 调）→ 不会双发。
 * @param {object} task 刚更新过的任务
 * @param {boolean} ok  本轮开发是否成功
 */
export function notifyTaskDone(task, ok) {
  try {
    if (!task?.id) return;
    // 守卫按「廉价判定在前」排：开关未开时连一次 open_id 读盘都不该付
    if (!getUiPrefs()?.taskNotifyFeishu) return;
    const openId = getMyFeishuOpenId();
    if (!openId) return;
    const c = creds();
    if (!c) return;
    // 现读最新盘上值：分支/合并字段可能在调用方传 task 之后才写入（auto-dev 先写 branch 再落 done）
    const fresh = getTask(task.id) || task;
    sendCardToUser(c, openId, buildTaskDoneCard(fresh, ok))
      .then((mid) => {
        if (mid) return;
        // 卡片发送失败（返回 null）→ 降级纯文本。此时用户点不到按钮，
        // 必须指明后续在哪处理，否则这条通知就是死路一条。
        const tag = fresh.type === 'bug' ? '[故障]' : '[需求]';
        return sendTextToUser(
          c,
          openId,
          `${ok ? '✅ 已处理完成' : '❌ 处理失败'}\n${tag}「${fresh.title}」\n请到网页端任务面板处理。`,
        );
      })
      .catch((e) => logger.warn('task-notify', '任务完成通知异常（已捕获）', { id: task.id, err: e?.message || String(e) }));
  } catch (e) {
    // 同步段也可能抛（settings.json 损坏时 getUiPrefs 会同步抛），一并吞掉：绝不回传给任务流程
    logger.warn('task-notify', '任务完成通知准备失败（已捕获）', { err: e?.message || String(e) });
  }
}

/** 权限判定入参：每次现取，设置页改完立即生效（不缓存） */
function permOpts() {
  return {
    myOpenId: getMyFeishuOpenId(),
    ownerOpenIds: config.lark.ownerOpenIds,
    trustedOpenIds: resolveTrustedOpenIds(getActiveBot(), config.lark.trustedOpenIds),
  };
}

/**
 * 卡片回调：[合并到主分支] / [补充] / [放弃改动]。
 * 无内存态：taskId 从按钮 value 来，任务状态从盘上读 → 机器人重启后旧卡片按钮仍有效。
 */
async function onTaskCardAction(data) {
  const parsed = parseTaskCardAction(data);
  if (!parsed) return;

  if (!canOperateRelay(parsed.operatorOpenId, permOpts())) {
    // 卡片虽是私聊送达，转发后仍可能被他人点到；静默忽略（不回文本，避免给陌生人任何反馈面）
    logger.info('task-notify', '非授权用户点击任务卡片，忽略', { operator: parsed.operatorOpenId });
    return;
  }

  // 终态更新卡片；拿不到 messageId（报文形态异常）或更新失败只记 warn，**动作本身照常执行**
  const done = (text) =>
    parsed.messageId
      ? updateCard(parsed.messageId, taskResultCard(text)).catch((e) =>
          logger.warn('task-notify', '卡片更新失败（动作已执行）', { id: parsed.taskId, err: e?.message || String(e) }),
        )
      : Promise.resolve();

  const task = getTask(parsed.taskId);
  if (!task) return done('⚠️ 任务不存在或已被清理。');

  if (parsed.action === 'supplement') {
    // 等待态的唯一消费方是 feishu-relay 的 feature（order 16）。它被停用时 arm 出去的等待态
    // 没人消费，用户那句补充会被 claude-exec 当普通对话吃掉（白烧一轮额度且补充丢失）——
    // 与其制造这个黑洞，不如当场把人引到网页端。
    if (!getPluginEnabled('feishu-relay')) {
      logger.info('task-notify', '会话回控插件已停用，不置等待补充态', { id: task.id });
      return done(`⚠️ 飞书补充功能未启用（会话回控插件已停用），请到网页端任务面板补充「${task.title}」。`);
    }
    armSupplement(parsed.operatorOpenId, {
      // 闭包只捕获 id/title：真正执行时任务是否还在、能不能排队都现判（10 分钟窗口里任务可能被删）
      label: `任务「${task.title}」`,
      onText: async (text, reply) => {
        // 剥「补充内容」前缀：用户点了按钮进等待态后仍常习惯性再写一遍，
        // 原样写进 fixNote 等于把这四个字当成方案内容带进开发提示词。
        // 不命中（裸文本）则原样用，不制造第二条分支。
        const body = matchSupplementText(text) || text;
        // 返回值必须看：任务在等待窗口里被删时 updateTask 返回 null 且不落盘，
        // 照旧回「✅ 已记录」就是假成功——用户以为补上了，实际什么都没发生。
        if (!updateTask(task.id, { fixNote: body }, '飞书补充说明')) {
          return reply(`⚠️ 任务「${task.title}」已不存在，补充未能记录，请到网页端任务面板确认。`);
        }
        // 只标记 queued，不在此进程跑：自动开发泵只在 web 进程常驻，
        // web 台没开也不丢单，起来自动接着跑。
        if (!requestAutoDevelop(task.id, '飞书补充后重新开发')) {
          return reply(`⚠️ 补充已记录，但任务「${task.title}」无法重新排队开发，请到网页端任务面板确认。`);
        }
        return reply(`✅ 已记录补充并重新排队开发：「${task.title}」`);
      },
    });
    logger.info('task-notify', '已置等待补充态', { id: task.id, operator: parsed.operatorOpenId });
    await done(`⌛ 等待补充内容（10 分钟内有效）…\n任务：「${task.title}」`);
    const c = creds();
    if (c) await sendTextToUser(c, parsed.operatorOpenId, '请直接发送要补充的内容。');
    return;
  }

  if (parsed.action === 'merge') {
    // 幂等：并发双击 / 网页端已处理过 → 只更新卡片，不重复动 git。
    // task 是权限判定之后、无任何 await 间隔读出来的盘上值，就是最新态。
    if (!isAwaitingMerge(task)) return done(`ℹ️「${task.title}」已不在待合并态。`);
    const r = await mergeTaskById(task.id);
    return done(
      r.ok
        ? `✅ 已合并 ${task.branch} → ${task.baseBranch}` + (r.hookBypassed ? '（已跳过提交钩子校验）' : '')
        : `⚠️ ${r.error}（请到网页端处理）`,
    );
  }

  // discard：与 merge 对称的幂等短路。谓词取 task-actions 的 isDiscardable（同一把尺子，
  // 不重写条件），否则只能把「任务不满足放弃条件（须为自动完成且未合并）」这种内部口径甩给用户。
  if (!isDiscardable(task)) return done(`ℹ️「${task.title}」已不在可放弃态。`);
  const r = await discardTaskById(task.id);
  return done(r.ok ? `🗑 已放弃改动并删除分支 ${task.branch}` : `⚠️ ${r.error}（请到网页端处理）`);
}

// 模块加载即注册（feishu/web 进程都会加载插件；web 进程无卡片事件，注册无害）。
// team-tools 停用时本模块不加载 → 回调自然落空（入口仅记 warn 日志）。
registerCardKindHandler(TASK_CARD_KIND, onTaskCardAction);

export { onTaskCardAction };

/**
 * feature: 待处理项交互式处理（owner 专属，飞书入口）。
 * 触发词进入 → 列分组列表并询问 → 按「故障优先+时间」逐个呈现已有方案项
 *   → owner 决策（开始/补充/放弃/跳过/退出，支持自然语言）→「开始」入后台串行队列改码。
 * 决策不阻塞；开发严格串行（避免并发改同一代码库冲突）。会话/队列均为内存态。
 */
import { getTasks, getTask, updateTask } from '../../../store/tasks.js';
import { sendText } from '../../../integrations/lark.js';
import { runClassifierOnce } from '../../../features/llm-classify.js';
import { config } from '../../../shared/config.js';
import { develop, analyze } from '../task-ops.js';
import { groupPending, sortForTriage, parseAction, parseYesNo } from './logic.js';
import { logger } from '../../../shared/logger.js';
import { getActiveBot } from '../../../store/settings.js';
import { requestAutoDevelop, isOverrideStart } from '../auto-dev/index.js';
import { recordOverride } from '../review/index.js';

// openId → 会话
const sessions = new Map();

// ---- 后台串行开发队列（模块级，纯内存）----
const devQueue = []; // 待开发任务：{ taskId, chatId }（chatId 随任务入队，避免被后到会话覆盖）
let devRunning = false;

function enqueueDevelop(taskId, chatId) {
  devQueue.push({ taskId, chatId });
  logger.info('task-triage', '入队开发', { taskId, queueLen: devQueue.length, running: devRunning });
  pumpQueue();
}

async function pumpQueue() {
  if (devRunning || !devQueue.length) return;
  devRunning = true;
  const job = devQueue.shift();
  const task = getTask(job.taskId);
  // 这里不拼 @ 前缀：triage 通知发给 owner 会话（job.chatId，通常是 owner 私聊），与任务来源会话不同，
  // 不能用 source.chatType 拼 @ —— 否则 guest 在群里提的需求，会在只有 owner 的私聊里 @ 一个非成员，
  // 飞书渲染异常且被 @ 的人根本收不到。owner 在自己的 triage 会话里也不需要被 @。
  // （对比 auto-dev 的 replySource：那里发给 task.source.chatId，source 与目标同会话，@ 是正确的。）
  // 幂等闸：start 时已把任务置为 developing；若取出时已非 developing（已被开发过/被并发改动），跳过防重复改码
  if (!task || task.status !== 'developing') {
    devRunning = false;
    return pumpQueue();
  }
  try {
    // develop 自吞内部异常并以返回值 { ok, log } 表达成败，据此区分通知
    // 通知失败必须留日志：无声丢失会让用户苦等一个已完成/已失败的任务
    const notifyFail = (e) =>
      logger.warn('task-triage', '开发结果通知发送失败', { taskId: job.taskId, err: e?.message || String(e) });
    const r = await develop(task);
    if (r?.ok) {
      await sendText(job.chatId, `✅ 已完成开发：${task.title}\n请在项目里 git diff 审查改动`).catch(notifyFail);
    } else {
      await sendText(job.chatId, `❌ 开发失败：${task.title}\n${(r?.log || '').slice(-500)}`).catch(notifyFail);
    }
  } catch (e) {
    // 防御 develop 之外的意外（理论上不可达，仍保留兜底）
    await sendText(job.chatId, `❌ 开发异常：${task.title}\n${e?.message || String(e)}`).catch((e2) =>
      logger.warn('task-triage', '开发结果通知发送失败', { taskId: job.taskId, err: e2?.message || String(e2) }),
    );
  } finally {
    devRunning = false;
    pumpQueue();
  }
}

// ---- 意图兜底：关键词未命中时用 Claude 判 action（骨架细节见 features/llm-classify）----
// 行为修正：disallowedTools 补全 Agent/Task（原缺失，历史事故来源）+ 新增额度耗尽 fail-fast（原无）
async function classifyAction(text) {
  const j = await runClassifierOnce({
    prompt: text,
    systemPrompt: {
      type: 'custom',
      custom:
        '你是待处理项处理流程的动作分类器。仅输出一行 JSON，不要任何解释。\n' +
        'action 取值：start（同意开始开发当前项）、reject（放弃当前项）、' +
        'skip（跳过当前项、暂不处理）、fix（要补充说明/重新分析）、exit（退出整个流程）、other。\n' +
        '严格输出：{"action":"start|reject|skip|fix|exit|other"}',
    },
    model: config.taskTriage.classifyModel,
    logTag: 'task-triage/action',
  });
  if (j && ['start', 'reject', 'skip', 'fix', 'exit'].includes(j.action)) return j.action;
  return 'unknown';
}

// ---- 记录补充说明 → 置回 analyzing → 后台重新分析 → 计数 ----
// task 可能为 null（并发已被 web 管理台改动），此时静默跳过。
function applyFixNote(sess, task, note) {
  if (!task) return;
  const updated = updateTask(task.id, { fixNote: note, status: 'analyzing' }, '补充修正方案，重新分析');
  analyze(updated).catch((e) => console.error('[task-triage] 重新分析失败:', e));
  sess.stats.refixed += 1;
}

// ---- 判断是否 triage owner ----
function isTriageOwner(ctx) {
  if (config.taskTriage.ownerOpenId) return ctx.user.id === config.taskTriage.ownerOpenId;
  return ctx.user.role === 'owner';
}

// ---- 呈现列表文本 ----
function renderList(ready, analyzing) {
  const lines = [`📋 待处理共 ${ready.length + analyzing.length} 项`];
  lines.push(`✅ 已有方案（${ready.length}）`);
  sortForTriage(ready).forEach((t, i) => {
    lines.push(`  ${i + 1}. ${t.type === 'bug' ? '[故障]' : '[需求]'} ${t.title}`);
  });
  if (analyzing.length) {
    lines.push(`🕒 分析中（${analyzing.length}）`);
    analyzing.forEach((t) => {
      lines.push(`  · ${t.type === 'bug' ? '[故障]' : '[需求]'} ${t.title}`);
    });
  }
  lines.push(`——— 要开始处理「已有方案」的 ${ready.length} 项吗？（开始 / 取消）`);
  return lines.join('\n');
}

// ---- 呈现当前待决策项；返回 false 表示队列已空（应结束）----
async function presentCurrent(sess, reply) {
  while (sess.cursor < sess.queue.length) {
    const task = getTask(sess.queue[sess.cursor]);
    // 双端并发：已被 web 管理台改动 → 跳过
    if (!task || task.status !== 'analyzed' || !task.analysis?.suggestion) {
      sess.cursor += 1;
      continue;
    }
    const n = sess.cursor + 1;
    const total = sess.queue.length;
    const tag = task.type === 'bug' ? '[故障]' : '[需求]';
    // 分析产出已是精简摘要（见 task-ops.analyze），通常 400 字内；这里仅留一个安全上限兜底防超长
    const fullPlan = task.analysis.suggestion || '';
    const PLAN_MAX = 2500;
    const plan = fullPlan.length > PLAN_MAX ? fullPlan.slice(0, PLAN_MAX) + '\n…（内容过长已截断）' : fullPlan;
    await reply(
      `（${n}/${total}）${tag} ${task.title}\n💡 方案：${plan}\n` +
        `——— 开始处理 / 补充<说明> / 放弃 / 跳过 / 退出`,
    );
    return true;
  }
  return false;
}

async function finish(sess, reply) {
  const s = sess.stats;
  const queued = devQueue.length + (devRunning ? 1 : 0);
  await reply(
    `✅ 本轮处理完毕：开始 ${s.started} · 放弃 ${s.rejected} · 跳过 ${s.skipped} · 重新分析 ${s.refixed}\n` +
      (queued ? `后台开发队列还有 ${queued} 个在排队，完成后我逐个告诉你。` : `没有后台开发任务。`),
  );
}

export default {
  name: 'task-triage',
  permission: 'owner',
  intents: [],
  // 有会话中：接管 owner 的任何消息
  hasPending: (ctx) => isTriageOwner(ctx) && sessions.has(ctx.user.id),
  // 无会话时：仅 owner + 触发词命中才进入（否则落到 claude-exec）
  match: (ctx) => isTriageOwner(ctx) && config.taskTriage.triggerPattern.test(ctx.text || ''),
  handle: async (ctx) => {
    const userId = ctx.user.id;
    const reply = ctx.reply;
    const text = (ctx.text || '').trim();
    const chatId = ctx.meta?.chatId || ctx.sessionKey;
    let sess = sessions.get(userId);

    // === A. 无会话（match 触发进入）→ 列表 ===
    if (!sess) {
      const { ready, analyzing } = groupPending(getTasks());
      if (!ready.length && !analyzing.length) return reply('🎉 当前没有待处理项。');
      await reply(renderList(ready, analyzing));
      if (!ready.length) {
        return reply('目前没有「已有方案」的项可处理（都还在分析中）。稍后再发「待处理」查看。');
      }
      sessions.set(userId, {
        step: 'listed',
        chatId,
        queue: sortForTriage(ready).map((t) => t.id),
        cursor: 0,
        stats: { started: 0, rejected: 0, skipped: 0, refixed: 0 },
      });
      return;
    }

    // === B. listed：是否开始 ===
    if (sess.step === 'listed') {
      let yn = parseYesNo(text);
      if (yn === 'unknown') {
        // 兜底：把 start/exit 也纳入
        const a = parseAction(text);
        yn = a === 'start' ? 'yes' : a === 'exit' ? 'no' : 'unknown';
      }
      if (yn === 'no') {
        sessions.delete(userId);
        return reply('已取消。需要时再发「待处理」。');
      }
      if (yn === 'yes') {
        sess.step = 'reviewing';
        const has = await presentCurrent(sess, reply);
        if (!has) {
          await finish(sess, reply);
          sessions.delete(userId);
        }
        return;
      }
      return reply('回复「开始」进入逐个处理，或「取消」结束。');
    }

    // === C. awaiting_fix_note：收集补充说明 ===
    if (sess.step === 'awaiting_fix_note') {
      applyFixNote(sess, getTask(sess.queue[sess.cursor]), text);
      sess.step = 'reviewing';
      sess.cursor += 1;
      await reply('已记录补充说明，正在后台重新分析。继续下一个。');
      const has = await presentCurrent(sess, reply);
      if (!has) {
        await finish(sess, reply);
        sessions.delete(userId);
      }
      return;
    }

    // === D. reviewing：对当前项决策 ===
    if (sess.step === 'reviewing') {
      const parsed = parseAction(text, { withNote: true });
      let action = parsed.action;
      if (action === 'unknown') action = await classifyAction(text);
      if (action === 'unknown') {
        return reply('没太懂～请回复：开始处理 / 补充<说明> / 放弃 / 跳过 / 退出。');
      }

      const task = getTask(sess.queue[sess.cursor]);
      logger.info('task-triage', '决策', {
        action,
        cursor: sess.cursor,
        taskId: task?.id ?? null,
        title: task?.title ?? null,
      });

      if (action === 'exit') {
        await finish(sess, reply);
        sessions.delete(userId);
        return;
      }

      if (action === 'start') {
        if (task) {
          // owner 强行开始被质疑/拒绝任务 → 记人工覆盖判例（与 web 入口判定一致）
          if (isOverrideStart(task)) recordOverride(task);
          const autonomy = getActiveBot()?.autonomy || 'light';
          if (autonomy !== 'light') {
            // 中度/完全托管：入自动开发队列（web 进程泵串行执行），完成后管线自行回复来源会话
            requestAutoDevelop(task.id, '确认开始开发（飞书 triage，自动管线）');
            sess.stats.started += 1;
            await reply(`👌 已加入自动开发队列（任务分支，完成后待确认合并）：${task.title}`);
          } else {
            updateTask(task.id, { status: 'developing' }, '确认开始开发（飞书 triage）');
            enqueueDevelop(task.id, chatId);
            sess.stats.started += 1;
            await reply(`👌 已加入后台开发队列：${task.title}`);
          }
        }
        sess.cursor += 1;
      } else if (action === 'reject') {
        if (task) {
          // rejectedBy 标记：owner 毙掉的任务不允许提交人「坚持修改」复活（见 feedback/logic.isReviewableTask）
          updateTask(task.id, { status: 'rejected', rejectedBy: 'owner' }, '放弃（飞书 triage）');
          sess.stats.rejected += 1;
          await reply(`🗑 已放弃：${task.title}`);
        }
        sess.cursor += 1;
      } else if (action === 'skip') {
        sess.stats.skipped += 1;
        await reply('⏭ 已跳过（保留方案，下次仍会出现）。');
        sess.cursor += 1;
      } else if (action === 'fix') {
        if (parsed.note) {
          // 「补充<内容>」一步到位。applyFixNote 已把该项置回 analyzing，
          // 故 cursor+=1 只是快进当前项；即便不+1，presentCurrent 也会因其非 analyzed 自动跳过（不会漏项）。
          applyFixNote(sess, task, parsed.note);
          sess.cursor += 1;
          await reply('已记录补充说明，正在后台重新分析。继续下一个。');
        } else {
          // 只说「补充」→ 追问内容，不推进 cursor
          sess.step = 'awaiting_fix_note';
          return reply('请发送要补充的说明（将据此重新分析）：');
        }
      }

      const has = await presentCurrent(sess, reply);
      if (!has) {
        await finish(sess, reply);
        sessions.delete(userId);
      }
      return;
    }

    // 兜底：异常状态 → 重置
    sessions.delete(userId);
    return reply('会话状态异常，已重置。请重新发「待处理」。');
  },
};

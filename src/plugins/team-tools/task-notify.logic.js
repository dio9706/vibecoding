/**
 * 任务完成通知卡片的构造与回调解析。
 *
 * 本模块自身的函数都是纯的（同样入参必得同样出参，不读写任何状态），可直接单测；
 * 但**加载它不是零副作用**：它 import 了 task-actions.js 的谓词，链式拉进 store/index.js，
 * 那个模块在模块级就 fs.mkdirSync 数据目录且失败即抛。要在无盘环境里用请自备 APP_DATA_DIR。
 *
 * 与 feedback/logic.js 的评审卡片同一套路数：按钮 value 自带 kind + taskId 做全局路由，
 * 不依赖任何内存注册 —— 机器人重启后躺在聊天记录里的旧卡片按钮照样有效。
 */
import { isAwaitingMerge, isDiscardable } from './task-actions.js';
import { buildVerifyLine } from './auto-dev/verify.logic.js';

export const TASK_CARD_KIND = 'task-done';

/** devLog 摘要：卡片正文不该刷屏，超长截断；空输出显式写「(无输出)」而不是留白 */
function summarize(text, max = 200) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return '(无输出)';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 合并状态判定 —— 卡片与降级纯文本**共用这一把尺子**，否则两条通道的文案迟早分叉
 * （典型后果：卡片说合并失败、发不出去降级的纯文本却只说「已处理完成」）。
 *
 * `mergeError` 优先于 `merged`：两者正常流程不会同时为真，但盘上数据可能因历史版本或
 * 并发写而不一致；此时必须报失败 —— 漏报「其实还没合上」远比多报一次严重。
 *
 * @returns {{kind:'failed'|'warned'|'merged'|'none', detail?:string}}
 */
export function mergeStatusOf(task) {
  if (task?.mergeError) return { kind: 'failed', detail: task.mergeError };
  if (!task?.merged) return { kind: 'none' };
  if (task?.mergeWarning) return { kind: 'warned', detail: task.mergeWarning };
  return { kind: 'merged' };
}

/** 一个按钮的 value：三个动作共用同一契约，parseTaskCardAction 按此校验 */
function btn(content, type, taskId, action) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content },
    type,
    value: { kind: TASK_CARD_KIND, taskId, action },
  };
}

/**
 * 卡片正文里的合并结果行。
 *
 * **这行不写才是最坏的情况**：2026-09-28 实测事故——三条任务自动合并失败后，卡片只显示
 * 「✅ 已处理完成」配一个合并按钮，收卡片的人根本看不出自动合并已经试过并失败，
 * 会以为是自己还没点；任务因此在面板上积压四天无人处理。所以失败与警告都必须上卡片正文。
 */
function mergeLine(task) {
  const s = mergeStatusOf(task);
  const base = `\n${task.autoMerged ? '已自动合并到' : '已合并到'} ${task.baseBranch || '基线分支'}`;
  if (s.kind === 'failed') return `\n⚠️ **自动合并失败**：${summarize(s.detail, 200)}`;
  // 合并成功不等于没事要管：AI 解过冲突要复核，改动没从 stash 回来更要人立刻处理
  if (s.kind === 'warned') return `${base}\n⚠️ ${summarize(s.detail, 200)}`;
  if (s.kind === 'merged') return base;
  return '';
}

/**
 * 卡片发不出去时的降级纯文本。与卡片同源（都走 mergeStatusOf），但**不能带 lark_md 标记**——
 * 纯文本通道里 `**` 会原样显示成两个星号。
 *
 * 降级态用户点不到任何按钮，所以必须指明去哪处理，否则这条通知就是死路一条。
 */
export function taskDoneFallbackText(task, ok) {
  const tag = task?.type === 'bug' ? '[故障]' : '[需求]';
  const s = mergeStatusOf(task);
  const note =
    s.kind === 'failed'
      ? `\n⚠️ 自动合并失败：${summarize(s.detail, 200)}`
      : s.kind === 'warned'
        ? `\n⚠️ ${summarize(s.detail, 200)}`
        : '';
  return `${ok ? '✅ 已处理完成' : '❌ 处理失败'}\n${tag}「${task?.title || ''}」${note}${buildVerifyLine(task?.verify, { markdown: false })}\n请到网页端任务面板处理。`;
}

/**
 * 任务完成卡片：待合并态给「合并 / 补充 / 放弃」三个按钮，其余只给「补充」。
 * 非待合并态（轻度托管无分支、已合并、已放弃）绝不给合并/放弃按钮：
 * 点了也只会被 task-actions 挡回来，白给一个必然失败的入口。
 * @param {object} task 任务（建议传盘上最新值：分支/合并字段可能刚写入）
 * @param {boolean} ok  本轮开发是否成功
 */
export function buildTaskDoneCard(task, ok) {
  const tag = task.type === 'bug' ? '[故障]' : '[需求]';
  const head = ok ? '✅ **已处理完成**' : '❌ **处理失败**';
  // 两者都有才显示：缺一个就拼出「分支：auto/x → null」这种误导性文案，不如不显示
  const branchLine = task.branch && task.baseBranch ? `\n分支：${task.branch} → ${task.baseBranch}` : '';
  const mergedLine = mergeLine(task);
  const awaiting = isAwaitingMerge(task);
  const actions = [];
  if (awaiting) actions.push(btn('✅ 合并到主分支', 'primary', task.id, 'merge'));
  actions.push(btn('📝 补充', 'default', task.id, 'supplement'));
  // 放弃按钮跟着 isDiscardable 走（合并前删分支、合并后 revert），不再与合并按钮同生共死
  if (isDiscardable(task)) actions.push(btn('🗑 放弃改动', 'danger', task.id, 'discard'));
  return {
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${head}\n${tag}「${task.title}」${branchLine}${mergedLine}${buildVerifyLine(task?.verify)}\n\n${summarize(task.devLog)}`,
        },
      },
      { tag: 'action', actions },
    ],
  };
}

/** 点击后的终态卡片：按钮消失，只留一句结果（防重复点击 + 让结果留在聊天记录里） */
export function taskResultCard(text) {
  return { elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }] };
}

/**
 * 解析 card.action.trigger 回调 → { taskId, action, operatorOpenId, messageId }；
 * 非本 kind / 缺 taskId / 未知动作 / 结构异常一律 null。
 * 兼容两种报文形态：value 为对象（常态）或 JSON 字符串；
 * messageId 取 context.open_message_id（v2 schema）优先，顶层 message_id 兜底。
 */
export function parseTaskCardAction(data) {
  let value = data?.action?.value ?? null;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  if (!value || value.kind !== TASK_CARD_KIND || !value.taskId) return null;
  if (!['merge', 'supplement', 'discard'].includes(value.action)) return null;
  return {
    taskId: value.taskId,
    action: value.action,
    operatorOpenId: data?.operator?.open_id || null,
    messageId: data?.context?.open_message_id || data?.message_id || null,
  };
}

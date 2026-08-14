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
import { isAwaitingMerge } from './task-actions.js';

export const TASK_CARD_KIND = 'task-done';

/** devLog 摘要：卡片正文不该刷屏，超长截断；空输出显式写「(无输出)」而不是留白 */
function summarize(text, max = 200) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return '(无输出)';
  return s.length > max ? s.slice(0, max) + '…' : s;
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
  const awaiting = isAwaitingMerge(task);
  const actions = [];
  if (awaiting) actions.push(btn('✅ 合并到主分支', 'primary', task.id, 'merge'));
  actions.push(btn('📝 补充', 'default', task.id, 'supplement'));
  if (awaiting) actions.push(btn('🗑 放弃改动', 'danger', task.id, 'discard'));
  return {
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${head}\n${tag}「${task.title}」${branchLine}\n\n${summarize(task.devLog)}`,
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

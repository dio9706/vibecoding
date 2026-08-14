/**
 * feedback 纯逻辑（无副作用，可单测）：评审否定任务的挽回判定 + 评审否定卡片的构造/回调解析。
 */

// 挽回窗口：30 分钟内的操作才允许「坚持修改」反悔，超时视为用户真实放弃
const REVIEW_WINDOW_MS = 30 * 60 * 1000;

/**
 * 任务是否处于「可挽回」态：被评审质疑等待应答（challenged），
 * 或被评审否定后进了 rejected（评审 reject 直接拒绝 / ask 质疑后用户「算了」——反悔也允许）。
 * owner 手动毙掉的任务带 rejectedBy:'owner' 标记 → 不匹配（评审判决会残留在 review 字段，不能只看 verdict）；
 * 无评审判决的旧放弃任务同样不匹配。
 */
export function isReviewableTask(t) {
  if (!t) return false;
  if (t.status === 'challenged') return true;
  return (
    t.status === 'rejected' &&
    ['reject', 'ask'].includes(t.review?.verdict) &&
    t.rejectedBy !== 'owner'
  );
}

/** 同人同会话、30 分钟窗口内可挽回的任务（文本「坚持修改/算了」的查找入口）；无则 null */
export function findReviewableTask(tasks, { openId, chatId, now = Date.now(), windowMs = REVIEW_WINDOW_MS }) {
  const cutoff = now - windowMs;
  return (
    (tasks || []).find(
      (t) =>
        isReviewableTask(t) &&
        t.source?.openId === openId &&
        t.source?.chatId === chatId &&
        new Date(t.updatedAt).getTime() >= cutoff,
    ) || null
  );
}

// —— 评审否定卡片（坚持修改 / 算了）——
// 按钮 value 携带 taskId 做全局 kind 路由：不依赖内存注册，机器人重启后旧卡片按钮仍有效。

const CARD_KIND = 'review-verdict';
// 与 shared/mention.js 同源的 open_id 白名单校验：防把用户可控内容拼进 <at> 标签属性
const OPEN_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 评审否定按钮卡片。
 * @param {object} task    含 id/type/title/source
 * @param {'reject'|'ask'} verdict
 * @param {string} reason  评审理由
 */
export function buildVerdictCard(task, verdict, reason) {
  const kind = task.type === 'bug' ? '故障' : '需求';
  // 卡片 lark_md 的 @ 语法是 <at id=xxx></at>（与文本消息的 <at user_id> 不同）；仅群聊拼，p2p 渲染异常
  const at =
    task.source?.chatType === 'group' && OPEN_ID_RE.test(task.source?.openId || '')
      ? `<at id=${task.source.openId}></at> `
      : '';
  const head =
    verdict === 'reject' ? `❌ **该${kind}未通过评审，暂不处理**` : `🤔 **关于这条${kind}，评审建议暂缓**`;
  return {
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `${at}${head}\n${reason || '(未给出理由)'}\n\n「${task.title}」` },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✋ 坚持修改' },
            type: 'primary',
            value: { kind: CARD_KIND, taskId: task.id, action: 'insist' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🗑 算了' },
            type: 'danger',
            value: { kind: CARD_KIND, taskId: task.id, action: 'giveup' },
          },
        ],
      },
    ],
  };
}

/** 点击后的终态卡片：按钮消失，只留一句结果 */
export function verdictResultCard(text) {
  return { elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }] };
}

/**
 * 解析 card.action.trigger 回调 → { taskId, action, operatorOpenId, messageId }；非本 kind/结构异常 → null。
 * 兼容两种报文形态：value 为对象（常态）或 JSON 字符串；message_id 取 context.open_message_id（v2 schema），
 * 顶层 message_id 兜底。
 */
export function parseVerdictCardAction(data) {
  let value = data?.action?.value ?? null;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  if (!value || value.kind !== CARD_KIND || !value.taskId) return null;
  if (!['insist', 'giveup'].includes(value.action)) return null;
  return {
    taskId: value.taskId,
    action: value.action,
    operatorOpenId: data?.operator?.open_id || null,
    messageId: data?.context?.open_message_id || data?.message_id || null,
  };
}

// 可信提交人名单解析已上移到 shared/trusted-ids.js（feishu-relay 插件也要用，而插件之间禁止互相 import）。
// 这里原样再导出：本模块既有的 importer（bug-patrol / status-report / feedback / web 的 req-inspect）
// 与测试全部零改动，迁移不产生连锁修改。
export { resolveTrustedOpenIds } from '../../../shared/trusted-ids.js';

/** 谁可以点评审卡片：提交人本人 / 可信白名单 / owner；其他人忽略（群聊卡片人人可见） */
export function canOperateVerdict(operatorOpenId, task, { trustedOpenIds = [], ownerOpenIds = [] } = {}) {
  if (!operatorOpenId || !task) return false;
  return (
    operatorOpenId === task.source?.openId ||
    trustedOpenIds.includes(operatorOpenId) ||
    ownerOpenIds.includes(operatorOpenId)
  );
}

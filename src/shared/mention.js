/**
 * 群聊 @ 前缀（纯函数）—— 飞书文本消息里 @ 某人的唯一出口。
 * 只在群聊生效：p2p 里 <at> 标签会渲染成奇怪的一串，反而干扰阅读。
 * openId 做白名单校验（飞书 open_id 形如 ou_xxx，只含字母数字下划线），防把用户内容拼进标签属性。
 */
const OPEN_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * @param {string} openId   被 @ 的人（消息发送者 / 任务提交人）
 * @param {string} chatType 'group' | 'p2p' | null
 * @returns {string} 群聊返回 `<at user_id="xxx"></at> `，否则空串
 */
export function atPrefix(openId, chatType) {
  if (chatType !== 'group') return '';
  const id = typeof openId === 'string' ? openId : '';
  if (!id || !OPEN_ID_RE.test(id)) return '';
  return `<at user_id="${id}"></at> `;
}

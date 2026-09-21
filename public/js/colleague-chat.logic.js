/** 同事对话面板的纯逻辑（零依赖，供 colleague-chat.js 与单测共用） */

/**
 * 消息列表的轻量指纹，用来判断「要不要重绘」。
 *
 * 为什么不能只看条数：store 侧 `MAX_MESSAGES = 500` 是**从头截断**的，
 * 满 500 条之后新消息进来条数依然是 500 —— 以条数为判据的话面板会永久停止刷新。
 * 末条 id 一起进指纹就能覆盖这种「条数不变、内容已变」的情况。
 *
 * 为什么不用全量内容哈希：轮询每 10s 一次、消息最多 500 条，末条 id 足够区分
 * 「追加 / 截断」这两种真实变化；而无脑重绘会打断用户正在选中的文本，这才是要避开的。
 */
export function messagesSignature(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.length + ':' + (list[list.length - 1]?.id || '');
}

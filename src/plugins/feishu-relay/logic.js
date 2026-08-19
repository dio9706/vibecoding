/**
 * 会话回控的纯函数层。卡片由 web 侧构造（entrypoints/web/conv-notify.logic.js），
 * 这里只负责**解析** value 与文本指令 —— 两侧靠 value 契约耦合，不共享构造代码。
 */
export const CONV_CARD_KIND = 'conv-settled';

const END_TEXT = '结束会话';

/** 解析 card.action.trigger 回调；非本 kind/结构异常/未知动作 → null */
export function parseConvCardAction(data) {
  let value = data?.action?.value ?? null;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  if (!value || value.kind !== CONV_CARD_KIND || !value.convId) return null;
  if (!['supplement', 'end'].includes(value.action)) return null;
  return {
    convId: value.convId,
    action: value.action,
    operatorOpenId: data?.operator?.open_id || null,
    messageId: data?.context?.open_message_id || data?.message_id || null,
  };
}

// 「补充内容 xxx」前缀剥离已上移到 shared/pending-supplement.js（与它服务的等待态同住内核：
// team-tools 的任务补充也要剥同一个前缀，而插件之间禁止互相 import，同 canOperateRelay 的处置）。
// 这里原样再导出：本模块既有的 importer（feishu-relay/index.js）与测试全部零改动。
export { matchSupplementText } from '../../shared/pending-supplement.js';

/** 「结束会话」必须整条全等：否则「帮我看看怎么结束会话」会被误吞 */
export function isEndSessionText(text) {
  return (typeof text === 'string' ? text.trim() : '') === END_TEXT;
}

/**
 * 识别「会话 <至少8位ID> <正文>」格式。
 * @param {string} text 用户输入的完整文本
 * @returns {{ shortId: string, body: string } | null}
 *
 * 例如：
 * matchSessionText('会话 a1b2c3d4 我想补充一些东西')
 * → { shortId: 'a1b2c3d4', body: '我想补充一些东西' }
 *
 * matchSessionText('会话补充内容')
 * → null
 */
export function matchSessionText(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();

  // 正则：「会话」+ 空格 + 至少8位字母/数字 + 空格 + 至少1个字符
  const match = trimmed.match(/^会话\s+([a-zA-Z0-9]{8,})\s+(.+)$/);
  if (!match) return null;

  return {
    shortId: match[1],
    body: match[2],
  };
}

// 「谁能点我的私聊卡片」判定已上移到 shared/trusted-ids.js（team-tools 的任务完成卡片也要用同一把尺子，
// 而插件之间禁止互相 import，同 resolveTrustedOpenIds 的处置）。这里原样再导出：
// 本模块既有的 importer（feishu-relay/index.js）与测试全部零改动，迁移不产生连锁修改。
export { canOperateRelay } from '../../shared/trusted-ids.js';

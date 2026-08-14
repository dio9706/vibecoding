/**
 * claude-exec 的回复组装（纯函数，可单测）。
 *
 * 修两个叠在同一行 `await reply(buf || '(无输出)')` 上的缺陷：
 *  1. 失败被当成功 —— integrations/claude.js 对非 success 的 result 一律给空串，
 *     而调用方只看 result、丢掉 is_error，于是限流终止 / error_max_turns / 权限失败
 *     这些「不抛异常但确实失败了」的情况，用户收到的是「(无输出)」。
 *  2. 长回复整条丢失 —— 无长度截断，超过飞书文本上限时 sendText 抛错，
 *     catch 里的兜底回复往往因同一原因再次失败，最终静默。
 */

/** 飞书文本消息上限约 2000 字符；留出余量给 @ 前缀和分片标记。 */
export const FEISHU_TEXT_MAX = 1800;

/** 飞书交互卡片 body 大小限制（约 30KB）；为防止溢出，保守按 28KB 计算。 */
export const FEISHU_CARD_MAX = 28000;

/** 按 subtype 给一句能让用户知道下一步该干嘛的说明 */
function reasonOf(subtype) {
  if (subtype === 'error_max_turns') return '达到单轮步数上限，任务未跑完（可以让我「继续」）';
  if (subtype === 'error_during_execution') return '执行过程中出错';
  return subtype ? `未正常完成（${subtype}）` : '未正常完成';
}

/**
 * 组装最终回复文本。
 * @param {{text?: string, isError?: boolean, subtype?: string}} [r]
 */
export function buildExecReply(r = {}) {
  const text = typeof r?.text === 'string' ? r.text.trim() : '';
  if (!r?.isError) return text || '(无输出)';
  const reason = reasonOf(r?.subtype);
  // 有部分输出时**保留**它：那往往是最有价值的线索，但必须同时说明这次没成，
  // 否则用户会把半截结果当成完整结论。
  return text ? `${text}\n\n⚠️ 本次${reason}。` : `⚠️ 执行失败：${reason}。`;
}

/**
 * 按飞书上限切分长文本。
 * 优先在换行处断开（不把一行劈两半），单行超长时才硬切。
 * 不丢任何字符：各片拼接后与原文完全一致。
 */
export function splitForFeishu(text, max = FEISHU_TEXT_MAX) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const parts = [];
  let rest = s;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // 在窗口内找最后一个换行；找不到（单行超长）就硬切，保证循环一定推进
    const nl = window.lastIndexOf('\n');
    const cut = nl > 0 ? nl + 1 : max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * 按飞书卡片大小限制切分 Markdown 文本。
 * 优先在双换行（段落分界）处断开，然后在单换行处，最后才硬切。
 * 用于 sendMarkdown 分片发送超大 Markdown 内容。
 */
export function splitForMarkdownCard(text, max = FEISHU_CARD_MAX) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const parts = [];
  let rest = s;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // 优先在双换行（\n\n）处断开
    let cut = window.lastIndexOf('\n\n');
    if (cut > 0) {
      cut += 2; // 保留双换行
    } else {
      // 退而其次在单换行处断开
      cut = window.lastIndexOf('\n');
      if (cut > 0) {
        cut += 1;
      } else {
        // 都找不到就硬切，保证循环推进
        cut = max;
      }
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * `colleague-dev.js` 的纯函数层。
 *
 * 这两个函数原本住在 `colleague-auto.logic.js`（四期分类器管线）。P3 下线四期时，
 * 它们是唯一被 `colleague-dev.js` 依赖、因而不能一起删的部分 —— 搬到这里跟着它真正的
 * 消费方走，而不是留在一个已经没有别的用途的文件里。
 */

/** 回同事的简报上限。飞书私聊里一屏能读完的量 */
export const BRIEF_MAX_CHARS = 200;

/** 按「字符」而非 UTF-16 码元截断：Claude 结果里常见 emoji，从代理对中间切开飞书会渲染成乱码 */
function clipChars(s, n) {
  const chars = Array.from(s);
  return chars.length > n ? { text: chars.slice(0, n).join(''), clipped: true } : { text: s, clipped: false };
}

/** 回同事的简报。成功时压平空白再截断；失败时不透传错误细节（那是主机该看的） */
export function buildBrief(ok, resultText) {
  if (!ok) return '接入遇到问题，已转主机处理';
  const t = String(resultText || '').replace(/\s+/g, ' ').trim();
  if (!t) return '已处理完成';
  const { text, clipped } = clipChars(t, BRIEF_MAX_CHARS);
  return '已处理完成：' + text + (clipped ? '…' : '');
}

/**
 * 服务端生成的子会话 id。前端 createReqConv 是 `'c' + Date.now()`（c + 13 位数字），
 * 这里多拖 3 位字母数字，两边天然不撞；openConv 不校验 id 格式。
 * padEnd：Math.random 的 36 进制表示偶尔不足 3 位小数，不补齐会让长度契约偶发失守。
 */
export function newSubConvId(now = Date.now()) {
  return 'c' + now + Math.random().toString(36).slice(2, 5).padEnd(3, '0');
}

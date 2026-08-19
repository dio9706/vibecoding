/**
 * 可信提交人专属指令的共用纯函数 —— bug-patrol / status-report 共用。
 * 设计铁律（用户拍板）：指令只认「指定文案严格匹配」（去首尾空白后全等），
 * 绝不做模糊/前缀/LLM 识别 —— 宁可不触发，也不要把普通消息误认成指令。
 *
 * isTrustedSubmitter 已上移内核 shared/trusted-ids.js，本文件只留一个向后兼容的出口：
 * 新代码请直接 import 内核（理由见 shared/trusted-ids.js 文件头），这里仅为不打断
 * 尚未迁移的引用方（含 trusted-trigger.test.js 对再导出链路本身的验证）。
 */
export { isTrustedSubmitter } from '../../shared/trusted-ids.js';

/**
 * 消息是否全等命中触发文案之一（去首尾空白，大小写敏感）。
 * @param {unknown} text
 * @param {string[]} triggers
 */
export function matchesExactTrigger(text, triggers) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return false;
  return (Array.isArray(triggers) ? triggers : []).includes(t);
}

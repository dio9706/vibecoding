/**
 * claude-exec 路由判定（纯函数，可单测）。
 *
 * owner 全接是本 feature 的立身之本，但「提交需求：/提交故障：」这两类强前缀必须让路给 feedback：
 * 否则 owner 永远无法立案（消息在路由第 2 步就被全量接管），且单发图片/文件入材料池后
 * 没有 drain 出口 —— 材料会在 10 分钟后静默过期（旧遗留问题 I5）。
 * question 前缀不让路：owner 问问题走完整 Claude 能力更强，且 L1 的 question 还要让路动作关键词，
 * 在这里排除会与 intent 的分层判定打架。
 */
import { matchStrongIntent } from '../../app/intent-keywords.js';

/**
 * claude-exec 是否接管这条消息。
 * @param {string} text
 * @param {string} role 'owner' | 'guest'
 */
export function shouldOwnerExec(text, role) {
  if (role !== 'owner') return false;
  const strong = matchStrongIntent(text);
  return !(strong && (strong.type === 'bug' || strong.type === 'feature'));
}

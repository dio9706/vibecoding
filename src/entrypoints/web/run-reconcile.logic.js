/**
 * 启动对账归类纯函数（T2-P5，spec §3.2/§4.5）—— interrupted run 该不该续、还是放弃。
 *
 * 判定输入只有 run-index 锚点与 journal 事实（有无 settled、有无 session/会话锚点、
 * attempts 是否超限），**不看内存残留**：进程刚重启时内存里本来就没有任何真相。
 * 三种结局：
 *   resume  —— 有锚点且未超限；Claude 写 pending 排程（发「继续」），openai 排程检查点续跑；
 *   abandon —— 熔断（attempts 超限）或无会话锚点（有 convId 可对用户提示时）；
 *   discard —— settled 残留 / 完全无处提示（连 convId 都没有）：摘掉索引即可，静默处理。
 * 熔断语义与 P5 前完全一致：attempts 计次 = resumeAttempt + 1，超过 MAX_RESUME_ATTEMPTS 即放弃
 *（shouldAbandonResume 原样保留，本函数沿用同一不等式）。
 */

/**
 * @param {object} entry run-index 条目（含 provider/session_id/convId/resumeAttempt 等锚点）
 * @param {Array} journalTail 该 run 的 journal 事件（旧→新；本函数只关心有无 settled）
 * @param {{maxAttempts?: number}} [opts] maxAttempts 缺省 3，与 MAX_RESUME_ATTEMPTS 同值
 * @returns {{action: 'resume'|'abandon'|'discard', attempt?: number, reason: string}}
 */
export function classifyInterrupted(entry, journalTail, { maxAttempts = 3 } = {}) {
  if (!entry || !entry.runId) return { action: 'discard', reason: 'empty_entry' };
  // 已存在 settled 事件的索引残留（收尾与摘索引之间崩溃、摘除失败）：任务其实已收尾，
  // 绝不能对着一条已完成的回复再续一轮——这与 P3 openai 的 settled 残留判定同源。
  const events = Array.isArray(journalTail) ? journalTail : [];
  if (events.some((e) => e && e.type === 'settled')) return { action: 'discard', reason: 'settled_residue' };
  const status = entry.status;
  if (status && status !== 'running') return { action: 'discard', reason: 'not_running' };

  const attempt = (Number(entry.resumeAttempt) || 0) + 1; // 本次将发起的续跑代次
  const hasConv = !!entry.convId;
  if (attempt > maxAttempts) {
    return hasConv
      ? { action: 'abandon', attempt, reason: `连续 ${attempt - 1} 次自动续跑仍中断，超过上限 ${maxAttempts}` }
      : { action: 'discard', reason: 'no_conv' };
  }

  const provider = entry.provider;
  if (provider && provider !== 'claude-agent' && provider !== 'openai-compat') {
    // 未知 provider（未来新增/手工脏数据）：不猜续跑方式，摘掉并留 journal 事实
    return { action: 'discard', reason: 'unknown_provider' };
  }
  if (provider === 'openai-compat') {
    // openai 的续跑锚点 = convId（检查点即 conv-messages 本身，P3）
    return hasConv ? { action: 'resume', attempt, reason: 'checkpoint' } : { action: 'discard', reason: 'no_conv' };
  }
  // Claude 的续跑锚点 = session_id（SDK session JSONL 即检查点）
  if (!entry.session_id) {
    return hasConv
      ? { action: 'abandon', attempt, reason: '中断发生时会话尚未建立（无 session 锚点），无法自动续跑' }
      : { action: 'discard', reason: 'no_session' };
  }
  return hasConv ? { action: 'resume', attempt, reason: 'session' } : { action: 'discard', reason: 'no_conv' };
}

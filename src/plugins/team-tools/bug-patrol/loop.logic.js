/**
 * 巡检循环的纯判定与文案层（零 IO，单测目标）。
 * 泵本体（loop.js）全是落盘 + 网络 + Claude 调用，没法直测，判据一律抽到这里。
 */

export const TICK_MS = 30_000; // 泵 tick 间隔
export const STANDBY_MS = 20 * 60_000; // 待命 20 分钟后复查（用户拍板）
export const MAX_LIFETIME_MS = 12 * 3600_000; // 循环 12 小时上限（用户拍板）
export const QUOTA_HOLD_MS = 30 * 60_000; // 额度耗尽后的挂起时长，比常规待命更长，等 token 重置

/**
 * 是否额度类错误。额度耗尽时 20 分钟后重试只会再撞一次墙、白烧一轮调用，
 * 所以挂起 QUOTA_HOLD_MS 并告警一次（spec §9「循环挂起不空转」）。
 */
export function isQuotaError(msg) {
  return /rate.?limit|quota|usage limit|额度|超出限制/i.test(String(msg || ''));
}

/**
 * 任务是否已终结。
 *
 * **关键契约**：auto-dev 失败时状态退回 `'analyzed'`（见 auto-dev/index.js 的 7 处失败分支：
 * 非 git 仓库 / 工作区不可用 / 残留无法提交 / 建分支失败 / 开发失败 / 无代码改动 / 进程重启），
 * 并**没有 failed 状态**。只认 done 会让泵永远等一个到不了的终态，循环静默卡死在 scanning。
 *
 * 任务查不到（被人工删了）也当终态，同理防卡死。
 */
export function isSettled(task) {
  if (!task) return true;
  return task.status === 'done' || task.status === 'analyzed';
}

/** 本轮任务是否全部终结 */
export function allSettled(taskIds, getTaskById) {
  return (Array.isArray(taskIds) ? taskIds : []).every((id) => isSettled(getTaskById(id)));
}

/** 挑出可以重试一次的任务：退回 analyzed 且本轮还没重试过（用户拍板：失败只重试一次） */
export function pickRetryable(taskIds, getTaskById, retried = {}) {
  const r = retried && typeof retried === 'object' ? retried : {};
  return (Array.isArray(taskIds) ? taskIds : []).filter((id) => {
    const t = getTaskById(id);
    return t && t.status === 'analyzed' && !r[id];
  });
}

/** 是否超过 12 小时上限。startedAt=0 视为未启动，不判到期 */
export function isExpired(startedAt, now = Date.now()) {
  if (!startedAt) return false;
  return now - startedAt > MAX_LIFETIME_MS;
}

/** 本轮是否真的处理过东西（空报抑制的判据：五类全空就不打扰人） */
export function hasAnything(report) {
  if (!report || typeof report !== 'object') return false;
  return ['fixed', 'handoff', 'failed', 'unknown', 'needHuman'].some((k) => (report[k] || []).length > 0);
}

/** 毫秒 → 人读时长（3h20m / 45m）。负数（时钟回拨）归零 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h${m}m` : `${m}m`;
}

/**
 * 汇报文案。
 *
 * @param {object} p
 * @param {'round'|'final'} p.kind round=轮次汇报（受空报抑制，调用方先过 hasAnything）；
 *   final=最终汇报（无论空否都发——循环结束是必须让人知道的事件）
 * @param {string} p.atSelf 已拼好的 @ 前缀（群聊为 <at> 标签，私聊为空串，见 shared/mention.js）
 * @param {string|null} p.reqTitle 关联需求名，空则不显示方括号标题
 * @param {string} [p.reason] final 专用：停止原因
 */
export function buildRoundReport({ kind, atSelf = '', reqTitle, elapsedMs = 0, roundNo = 0, report, reason }) {
  const tag = reqTitle ? `【${reqTitle}】` : '';
  const dur = formatDuration(elapsedMs);
  const head =
    kind === 'final'
      ? `${atSelf}${tag}巡检已停止（${reason || '已满 12 小时'}），共跑 ${roundNo} 轮，累计 ${dur}`
      : `${atSelf}${tag}本轮处理完毕，已进入待命（下次扫描 20 分钟后，累计已跑 ${dur}）`;

  const r = report && typeof report === 'object' ? report : {};
  const lines = [head];
  const section = (title, items, render) => {
    if (!items?.length) return;
    lines.push('');
    lines.push(title(items.length));
    items.forEach((it, i) => lines.push(`  ${i + 1}. ${render(it)}`));
  };

  section(
    (n) => `🔧 已修复待你 review 并提交（${n} 条）`,
    r.fixed,
    (it) => `${it.title}  → 分支 ${it.branch || '（未知）'}`,
  );
  section(
    (n) => `📮 已转后端（${n} 条）`,
    r.handoff,
    (it) =>
      `${it.to || ''}${it.title} —— ${it.advice || '（无建议）'}` +
      `${it.demoted ? '［名册未配 open_id，仅移除了你］' : ''}`,
  );
  section(
    (n) => `🙋 待你人工处理（${n} 条）`,
    r.needHuman,
    (it) => `${it.title} —— ${it.reason || '缺少图片资源'}`,
  );
  section(
    (n) => `❓ 归属判不准，已按前端修（${n} 条）`,
    r.unknown,
    (it) => `${it.title}  → 分支 ${it.branch || '（未知）'}`,
  );
  section(
    (n) => `⚠️ 修复失败（${n} 条，已重试一次）`,
    r.failed,
    (it) => `${it.title} —— ${it.reason || '未知原因'}`,
  );

  if (lines.length === 1) lines.push('本轮无新增问题。');
  return lines.join('\n');
}

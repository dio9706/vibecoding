/**
 * 任务清单（\10002）纯逻辑 —— 分组 / 状态标签 / 清单格式化（单测目标）。
 * 口径（用户拍板）：运行中对话 + 活跃任务（评审中/分析中/排队/开发中）+ 待确认合并，仅列标题和进度。
 */

/** 触发文案（全等匹配） */
export const STATUS_TRIGGERS = ['\\10002 帮我检查当前正在进行的任务'];

/** 任务活跃状态 → 进度标签（不在表内的状态不属于「正在进行」） */
export const ACTIVE_STATUS_LABELS = {
  reviewing: '评审中',
  analyzing: '分析中',
  queued: '排队待开发',
  developing: '开发中',
};

/** 每组展示上限：防止极端数据刷屏（超出计数提示） */
const GROUP_MAX = 20;

function tag(t) {
  return t.type === 'bug' ? '[故障]' : '[需求]';
}

/**
 * tasks.json → { active, merge } 两组（各自按 updatedAt 倒序）。
 * merge 组 = 自动开发完成待确认合并：status done 且 merged===false 且有分支
 * （老数据无 merged 字段 → 不属于「待合并」，避免把陈年已完结任务翻出来）。
 */
export function groupTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const byTime = (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  return {
    active: list.filter((t) => ACTIVE_STATUS_LABELS[t?.status]).sort(byTime),
    merge: list.filter((t) => t?.status === 'done' && t?.merged === false && t?.branch).sort(byTime),
  };
}

/** 运行时长（分钟，向下取整，至少 0） */
export function minutesSince(startedAt, now = Date.now()) {
  const ms = now - Number(startedAt || 0);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 60_000) : 0;
}

/**
 * 清单文本。
 * @param {{ runs: {title:string, minutes:number}[],
 *   active: object[], merge: object[] }} data runs 由 index 组装（标题已解析/兜底）
 */
export function buildStatusReport({ runs = [], active = [], merge = [] } = {}) {
  if (!runs.length && !active.length && !merge.length) return '当前没有正在进行的任务 🎉';
  const lines = ['📋 当前正在进行：'];
  const push = (arr, header, fmt) => {
    if (!arr.length) return;
    lines.push(`▶ ${header}（${arr.length}）`);
    arr.slice(0, GROUP_MAX).forEach((item, i) => lines.push(`  ${i + 1}. ${fmt(item)}`));
    if (arr.length > GROUP_MAX) lines.push(`  …其余 ${arr.length - GROUP_MAX} 条略`);
  };
  push(runs, '对话', (r) => `${r.title} — 进行中 · 已运行 ${r.minutes} 分钟`);
  push(active, '需求/故障', (t) => `${tag(t)} ${t.title} — ${ACTIVE_STATUS_LABELS[t.status]}`);
  push(merge, '待确认合并', (t) => `${tag(t)} ${t.title} — 已完成，待合并（分支 ${t.branch}）`);
  return lines.join('\n');
}

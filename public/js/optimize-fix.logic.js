// 「一键优化」按钮的纯逻辑层：可用性判定、文案、结果统计。
// 不碰 DOM，不 import 其它模块，方便单测和后续被 optimize-view 等宿主复用。

/**
 * 判断「一键优化」按钮是否可点。
 * 三个条件缺一不可：
 * - 必须已经跑出报告（否则不知道要优化什么）
 * - 必须至少勾选了一项（避免用户误触发全量操作）
 * - 不能正在跑（避免重复提交并发请求）
 * 参数按可选处理，未传时一律视为「不满足」，避免调用方漏传字段导致误判为可点。
 */
export function canFix({ hasReport, selected, running } = {}) {
  return hasReport === true && Array.isArray(selected) && selected.length > 0 && running !== true;
}

/** 按钮文案随运行状态切换，运行中要明确告知用户「正在处理」防止误以为卡死。 */
export function fixButtonLabel(running) {
  return running ? '优化中…' : '一键优化';
}

/**
 * 汇总后端返回的优化结果数组，供 UI 展示统计条。
 * results 可能是 null/undefined（比如接口异常时上游未兜底），一律按空数组处理。
 */
export function summarizeResults(results) {
  const list = Array.isArray(results) ? results : [];

  let done = 0;
  let skipped = 0;
  let failed = 0;
  let refsTotal = 0;
  const fallbackNames = [];

  for (const item of list) {
    if (!item) continue;
    if (item.status === 'done') {
      done += 1;
      refsTotal += Number(item.refsUpdated) || 0;
      // description 由「机械模板兜底」生成时质量差——它决定 skill 能否被正确唤起，
      // 所以要单独挑出来，提示用户人工复核这些 skill 的描述文案。
      if (item.descriptionSource === 'fallback') {
        fallbackNames.push(item.skillName);
      }
    } else if (item.status === 'skipped') {
      skipped += 1;
    } else if (item.status === 'failed') {
      failed += 1;
    }
  }

  const text = list.length === 0
    ? '没有可处理的项'
    : `成功 ${done} · 跳过 ${skipped} · 失败 ${failed}`;

  return { done, skipped, failed, refsTotal, fallbackCount: fallbackNames.length, fallbackNames, text };
}

/**
 * 生成优化前后分数变化的展示文案。
 * before/after 任一为 null（比如首次优化没有历史分数）时，退化为只展示已知的那个值；
 * 两者都缺失时用 '--' 占位，避免界面出现 NaN 或空白。
 */
export function scoreDelta(before, after) {
  if (before == null && after == null) return '--';
  if (before == null) return `${after}`;
  if (after == null) return `${before}`;

  const diff = after - before;
  const diffText = diff === 0 ? '无变化' : (diff > 0 ? `+${diff}` : `${diff}`);
  return `${before} → ${after}（${diffText}）`;
}

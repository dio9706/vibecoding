/**
 * 总分聚合。
 *
 * 权重不等权的理由：地图和提示词影响的是「以后每一次开发的速度」，有复利效应；
 * rules 降级是一次性配置问题；注释是代码卫生，影响可读性但不直接拖慢 AI。
 * 维度④（无用代码）v1 不做，不出现在权重表里。
 */

export const WEIGHTS = {
  map: 35,
  prompts: 30,
  rules: 15,
  comments: 20,
};

const GRADES = [
  { key: 'healthy', min: 90, label: '健康', cssVar: '--green' },
  { key: 'good', min: 70, label: '良好', cssVar: '--accent-hi' },
  { key: 'needs-work', min: 50, label: '需优化', cssVar: '--amber' },
  { key: 'poor', min: 0, label: '较差', cssVar: '--danger' },
];

export function gradeOf(total) {
  if (total === null || total === undefined) return null;
  return GRADES.find((g) => total >= g.min) || GRADES.at(-1);
}

/**
 * 只有 status === 'done' 且 score 是数字的维度参与计算。
 * na / pending / disabled / timeout / error 一律排除，权重按比例分摊给参与者——
 * 否则项目会因为「没有 .claude/rules 目录」这种无辜原因被扣分。
 */
export function aggregateScore(dims) {
  const counted = [];
  let weightSum = 0;
  let weighted = 0;

  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const d = dims[key];
    if (!d || d.status !== 'done' || typeof d.score !== 'number') continue;
    counted.push(key);
    weightSum += weight;
    weighted += d.score * weight;
  }

  if (weightSum === 0) return { total: null, countedDims: [], grade: null };

  const total = Math.round(weighted / weightSum);
  return { total, countedDims: counted, grade: gradeOf(total) };
}

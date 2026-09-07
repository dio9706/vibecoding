/**
 * 总分聚合。
 *
 * ## 权重不再写在这里
 *
 * 权重从 `dimensions/registry.js` 派生。原先这里手写一张表，而维度还要在
 * 前端 DIM_META、编排层 RUNNERS 各登记一次——四张表分开维护，加维度时漏改任一张
 * 都是静默失效（漏了这张的后果最隐蔽：维度算出了分，却不参与总分，谁都不会注意到）。
 *
 * 注册表里**省略 `weight` 即不参与加权**，这是 `holistic`（对其它维度的元评估，
 * 计入总分等于把同一批问题数两遍）和 augment 型条目（结果并进宿主维度）的表达方式。
 * `aggregateScore` 只遍历本表的 key，所以不在表里的维度天然被排除，无需额外分支。
 *
 * ## 权重的分配理由
 *
 * 按「域」分配总量，再在域内按影响面切分：
 *   AI 协作配置 25 —— 影响以后每一次开发的速度，有复利效应
 *   代码质量   24 —— 影响可读性与可修改性，问题多但单条影响小
 *   架构       12 —— 单条影响最大（依赖方向错了会持续渗透），但条数少
 *   健壮性     25 —— 测试是核心信号；错误处理与安全各自都能造成生产事故
 *   工程化     14 —— 问题明确、修起来快，影响面相对局限
 */
import { weightMap } from './dimensions/registry.js';

export const WEIGHTS = weightMap();

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

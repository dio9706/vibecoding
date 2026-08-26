/**
 * 体检编排：同步跑静态检测器（维度①③），并给两个 LLM 维度（②提示词质量 / ⑤注释合理性）
 * 留占位。LLM 维度由上层 optimize-ops 起跑后异步回填（见 recomputeReport）；
 * 维度④ 暂不做，标 disabled。
 */
import fs from 'node:fs';
import { checkMap } from './check-map.js';
import { checkRules } from './check-rules.js';
import { aggregateScore } from './score.logic.js';

/** 需要 LLM 的维度，顺序即 UI 展示顺序无关，仅用于上层遍历 */
export const LLM_DIM_KEYS = ['prompts', 'comments'];

/**
 * LLM 维度的「分析中」占位。
 *
 * status 用新值 analyzing 而不是复用 pending：aggregateScore 只让 done 参与加权，
 * 两者都会被自动排除、权重按比例分摊给静态维度，总分口径上等价；
 * 但前端要靠它区分「转圈等结果」和「这个维度压根没启动」，语义不能混。
 */
export function analyzingDim() {
  return { score: null, status: 'analyzing', issues: [], reason: 'AI 分析中…' };
}

export function runStaticCheckup(projectDir, now = Date.now()) {
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new Error('目录不存在或不可读');
  }

  const dims = {
    map: checkMap(projectDir),
    prompts: { score: null, status: 'pending', issues: [], reason: '未启动 AI 分析' },
    rules: checkRules(projectDir),
    deadcode: { score: null, status: 'disabled', issues: [], reason: '即将支持' },
    comments: { score: null, status: 'pending', issues: [], reason: '未启动 AI 分析' },
  };

  return recomputeReport({
    dir: projectDir,
    at: new Date(now).toISOString(),
    dims,
  });
}

/**
 * 按当前 dims 重算总分/等级/问题数，**原地**改写并返回同一个 report 对象。
 *
 * LLM 维度陆续落地时要反复调用它。原地改写是刻意的：同一个 report 对象既挂在 job 上
 * 又已经序列化给过前端，换成新对象会让两边指向不同副本，回填就丢了。
 */
export function recomputeReport(report) {
  const { total, countedDims, grade } = aggregateScore(report.dims);
  report.score = total;
  report.grade = grade ? grade.key : null;
  report.countedDims = countedDims;
  report.issueCount = Object.values(report.dims).reduce((n, d) => n + (d.issues?.length || 0), 0);
  return report;
}

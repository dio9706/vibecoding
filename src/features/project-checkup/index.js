/**
 * 体检编排：阶段一只跑静态检测器（维度①③）。
 * 维度②⑤ 需要 LLM，阶段二实现，此处先以 pending 占位；维度④ 阶段一不做，标 disabled。
 */
import fs from 'node:fs';
import { checkMap } from './check-map.js';
import { checkRules } from './check-rules.js';
import { aggregateScore } from './score.logic.js';

export function runStaticCheckup(projectDir, now = Date.now()) {
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new Error('目录不存在或不可读');
  }

  const dims = {
    map: checkMap(projectDir),
    prompts: { score: null, status: 'pending', issues: [], reason: '阶段二支持' },
    rules: checkRules(projectDir),
    deadcode: { score: null, status: 'disabled', issues: [], reason: '即将支持' },
    comments: { score: null, status: 'pending', issues: [], reason: '阶段二支持' },
  };

  const { total, countedDims, grade } = aggregateScore(dims);
  const issueCount = Object.values(dims).reduce((n, d) => n + (d.issues?.length || 0), 0);

  return {
    dir: projectDir,
    at: new Date(now).toISOString(),
    score: total,
    grade: grade ? grade.key : null,
    countedDims,
    issueCount,
    dims,
  };
}

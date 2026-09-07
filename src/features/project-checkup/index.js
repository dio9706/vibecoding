/**
 * 体检编排：同步跑静态检测器（map / rules），其余维度留占位、由上层 optimize-ops 异步回填。
 *
 * ## 哪些维度必须异步
 *
 * 除 map / rules 之外**全部**都是。它们各自的成本形状不同，但结论一致——
 * 放进同步的 HTTP 请求里会把体检整个挂住：
 *   - 十个 audit 维度：要分批调 LLM（本仓库实测约 49 批，逐批 60~127s）
 *   - prompts / comments：要调 LLM
 *   - tests / hygiene：要起子进程（跑测试命令 / git ls-files），tests 最长可达 120s
 *   - holistic：要跑只读 agent，且必须等其它维度都出结论才有意义
 *
 * ## 维度清单从注册表来
 *
 * 原先这里手写一个 dims 字面量，与 `score.logic.js` 的权重表、前端 DIM_META、
 * `optimize-ops.js` 的 RUNNERS 四处各写一遍。漏改任一处都是静默失效——
 * 漏了这里的后果是：该维度压根不出现在报告里，前端卡片永远空白。
 */
import fs from 'node:fs';
import { checkMap } from './check-map.js';
import { checkRules } from './check-rules.js';
import { aggregateScore } from './score.logic.js';
import { DIMENSIONS } from './dimensions/registry.js';

/**
 * 同步跑的静态维度。
 *
 * 只有这两个：它们纯 fs 遍历、毫秒级完成，放同步路径能让「点体检」立刻看到部分结果。
 * 想加第三个之前先量一下它的耗时——这条路径直接决定 HTTP 响应延迟。
 */
const STATIC_CHECKERS = {
  map: checkMap,
  rules: checkRules,
};

/**
 * 异步回填的维度 key。
 *
 * 由注册表**取补集**得出，而不是手写清单：手写的那份漏掉一个维度时，
 * `refreshStaticReport`（优化后刷新报告）就不会把它标成待重检，
 * 用户会看到一份指向已被改动文件的旧结论。
 */
export const LLM_DIM_KEYS = DIMENSIONS
  .filter((d) => !STATIC_CHECKERS[d.id] && !d.augments)
  .map((d) => d.id);

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

/** 各维度未启动时的占位文案。写清楚在等什么，避免用户以为坏了 */
const PENDING_REASON = {
  tests: '未开始执行测试',
  hygiene: '未开始检查',
  prompts: '未启动 AI 分析',
  comments: '未启动 AI 分析',
  holistic: '等其它维度出结论后再评估',
};

function pendingDim(id) {
  return {
    score: null,
    status: 'pending',
    issues: [],
    reason: PENDING_REASON[id] || '未启动 AI 分析',
  };
}

export function runStaticCheckup(projectDir, now = Date.now()) {
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new Error('目录不存在或不可读');
  }

  const dims = {};
  for (const d of DIMENSIONS) {
    // augment 型条目不占报告里的 key：它的结论会被并进宿主维度
    if (d.augments) continue;
    const checker = STATIC_CHECKERS[d.id];
    dims[d.id] = checker ? checker(projectDir) : pendingDim(d.id);
  }

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

/**
 * 修复引擎（IO 层）：按维度声明的 fix 策略分派执行，产出统一形状的结果。
 *
 * ## 它取代了什么
 *
 * 原来 `optimize-ops.js` 的 `runFix` 里，rules 和 map 各占一段手写编排，加第三个维度
 * 就要再插一段 if（违反 OCP）。现在编排层只做三件事：选材、打快照、循环调本引擎。
 * 加一个维度不需要动编排层——这是本次重构的主要目标之一。
 *
 * `map` / `rules` **刻意不接进来**：它们的专用流程（`fix-map.js` / `fix-rules.js`）
 * 有各自校准过的细节（地图并发压到 3、降级五步失败分级），套进通用引擎会把那些丢掉。
 * 边界记在 `fix-engine.logic.js` 的 `BESPOKE_DIMS`。
 *
 * 从不抛错（`fix-*` 通用纪律）：一切失败通过返回值的 status 表达。
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../shared/logger.js';
import { partitionIssues, strategiesOf } from './fix-engine.logic.js';
import { writeAdvisory, writePlan, advisoryPathFor, PLAN_PATH } from './strategies/advisory.js';
import { runDeterministic, planDeterministic } from './strategies/deterministic.js';
import { runRefactor, runRewrite, runCreateTests } from './strategies/llm-edit.js';
import { testPathFor } from './strategies/llm-edit.logic.js';

/** 文件在项目里存在与否 → 备份条目的 action。created 类条目还原时是「删掉它」 */
function actionFor(dir, rel) {
  return fs.existsSync(path.join(dir, rel)) ? 'modified' : 'created';
}

/**
 * 算出本引擎会写到哪些文件 —— **在任何写操作之前**交给 `createBackup` 打快照。
 *
 * 「计划先于动作」是这套优化流程的既有纪律（`fix-rules.js` 的 `planDemote` 就是为此设计的）：
 * 备份必须覆盖全部将被写入的路径，漏一个就等于那个文件的改动无法还原。
 *
 * 宁可多备份也不能少：`llm-refactor` 的目标文件可能因为模型判断「做不到」而根本没被改，
 * 那样只是白备份一份内容相同的快照，代价可以忽略。
 *
 * @param {string} dir
 * @param {Array<{dim:object, issues:Array}>} selected
 * @param {object} [opts]
 * @param {boolean} [opts.gateAllowed] 测试闸是否放行（决定 refactor 会不会真去改源码）
 * @returns {Array<{path:string, action:string}>}
 */
export function planEngineEntries(dir, selected, { gateAllowed = true, allowedRisks } = {}) {
  const seen = new Set();
  const entries = [];
  const add = (rel, action) => {
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    entries.push({ path: rel, action: action || actionFor(dir, rel) });
  };

  for (const { dim, issues } of selected) {
    const part = partitionIssues({ dim, issues, gateAllowed, allowedRisks });

    // 兜底清单要登记的三种情形：
    //   1. 已经有 issue 落到 advisory；
    //   2. 本次规划时就判定降级了；
    //   3. **含源码重构策略** —— 这一条最容易漏。规划时按「闸会放行」算（见上方注释），
    //      但执行时闸可能是关的，那一刻会写出一份降级清单；而它没进备份计划，
    //      就成了一个盘上多出来、「还原」却撤不掉的文件。
    if (part.advisory.length || part.degraded || strategiesOf(dim).includes('llm-refactor')) {
      add(advisoryPathFor(dim.id));
    }

    for (const { strategy, issues: mine } of part.byStrategy) {
      if (strategy === 'deterministic') {
        for (const e of planDeterministic(dir, mine)) add(e.path, e.action);
      } else if (strategy === 'llm-create') {
        for (const it of mine) add(testPathFor(it.file));
      } else {
        // refactor / rewrite 都是就地改已有文件
        for (const it of mine) add(it.file);
      }
    }
  }

  return entries;
}

/** holistic 的产出物路径。编排层要把它并进备份条目 */
export { PLAN_PATH };

/**
 * 跑一个维度的修复。
 *
 * @param {object} args
 * @param {string} args.dir
 * @param {object} args.dim 维度声明
 * @param {Array} args.issues
 * @param {object} [args.evidence] `evidence/collect.js` 的产出（llm-create 找参考测试要用）
 * @param {{allowed:boolean, reason:string}} [args.gate] 测试闸状态
 * @param {AbortSignal} [args.signal]
 * @param {(r:object)=>void} [args.onFile] 每出一个文件结果就回调（推 SSE）
 * @param {(s:object)=>void} [args.onStep] 阶段回调
 * @returns {Promise<Array<{file:string, kind:string, status:string, reason:string}>>}
 */
export async function runFixForDim({
  dir, dim, issues, evidence, gate = { allowed: true, reason: '' },
  allowedRisks, signal, onFile, onStep,
}) {
  // 修复期要注入的项目事实由**维度自己声明**（registry 的 fixContext），
  // 而不是由编排层逐维度硬传——那样编排层就要知道「哪个维度需要什么上下文」，
  // 又变成一处加维度必须同步改的地方
  let sharedContext = '';
  try {
    sharedContext = dim.fixContext ? dim.fixContext(evidence) || '' : '';
  } catch (e) {
    logger.warn('fix-engine', 'fixContext 求值失败，本维度改写将缺少项目事实', {
      dim: dim.id, err: e?.message || String(e),
    });
  }
  const part = partitionIssues({
    dim,
    issues,
    gateAllowed: gate.allowed,
    gateReason: gate.reason,
    allowedRisks,
  });

  const results = [];

  if (part.degraded) {
    // 降级必须在进度流里说出来，不能只写进文件——用户正看着进度条，
    // 事后在 .claude/optimize/ 里发现「原来没改」是最糟的告知方式
    onStep?.({
      phase: 'degrade',
      dim: dim.id,
      text: `${dim.label}：${gate.reason}`,
    });
  }

  for (const { strategy, issues: mine } of part.byStrategy) {
    if (signal?.aborted) break;
    onStep?.({ phase: strategy, dim: dim.id, text: `${dim.label}：${mine.length} 项走「${strategy}」` });

    try {
      if (strategy === 'deterministic') {
        // 确定性策略不逐个回调，跑完统一补推。用「跑之前的长度」定位新增部分——
        // 它返回的条数**不等于** issue 条数（1 条 .gitignore 结果 + 每个文件 1 条 untrack 结果），
        // 按 mine.length 倒着切会切错、把上一个策略的结果重复推给前端
        const before = results.length;
        results.push(...await runDeterministic(dir, mine));
        for (const r of results.slice(before)) onFile?.(r);
      } else if (strategy === 'llm-refactor') {
        // 三个 LLM 策略内部已逐个回调 onFile（它们每个文件要跑几十秒，
        // 必须一出结果就推，不能等整批结束）
        results.push(...await runRefactor({ dir, dim, issues: mine, signal, onFile }));
      } else if (strategy === 'llm-rewrite') {
        results.push(...await runRewrite({ dir, dim, issues: mine, sharedContext, signal, onFile }));
      } else if (strategy === 'llm-create') {
        results.push(...await runCreateTests({
          dir, issues: mine, files: evidence?.files || [], signal, onFile,
        }));
      }
    } catch (e) {
      // 策略承诺不抛（各自内部 try 到底），这里是防御性兜底：
      // 一个策略炸了不该让同一维度的其它策略、更不该让别的维度停下
      logger.warn('fix-engine', '策略执行异常', { dim: dim.id, strategy, err: e?.message || String(e) });
      const r = { file: dim.id, kind: strategy, status: 'failed', reason: e?.message || String(e) };
      results.push(r);
      onFile?.(r);
    }
  }

  // 兜底清单：没被任何策略认领的、以及降级掉的，全部写进整改清单。
  // 这是「没有 issue 会被静默丢掉」这条规则的落点（见 fix-engine.logic.js 头注释）
  if (part.advisory.length || part.degraded) {
    const r = writeAdvisory(dir, dim, part.advisory, {
      degradeReason: part.degradeReason,
      // 被风险档位挡下的要写进清单：用户点了「低风险优化」、看到清单里有源码问题，
      // 如果不说明，他会以为这个工具没能力修，而其实只是本轮没被授权
      riskSkipped: part.skippedByRisk,
    });
    results.push(r);
    onFile?.(r);
  }

  return results;
}

/**
 * 写整体行动计划（holistic 维度的修复动作）。
 *
 * 单独一个函数而不是塞进 `runFixForDim`：它的输入不是 issue 列表而是 `plan` 对象，
 * 硬要套统一签名就得给 runFixForDim 加一个只有一个维度会用的参数。
 *
 * @param {string} dir
 * @param {object} report 体检报告（取 holistic 的 plan 与各维度得分）
 * @param {Array} dimensions 注册表
 */
export function writeHolisticPlan(dir, report, dimensions) {
  const plan = report?.dims?.holistic?.plan || null;

  const dimSummaries = dimensions
    .filter((d) => !d.augments && d.id !== 'holistic')
    .map((d) => ({
      label: d.label,
      score: report?.dims?.[d.id]?.score ?? null,
      issueCount: report?.dims?.[d.id]?.issues?.length || 0,
      source: d.source,
    }))
    .filter((d) => d.score !== null || d.issueCount > 0);

  return writePlan(dir, plan, dimSummaries);
}

/** 供编排层判断某维度是否需要开测试闸 */
export { strategiesOf };

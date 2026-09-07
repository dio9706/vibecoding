/**
 * advisory 策略的落盘层：把整改清单与行动计划写进 `.claude/optimize/`。
 *
 * ## 产出物都放一个目录
 *
 * `.claude/optimize/PLAN.md`（整体行动计划）+ `.claude/optimize/<维度id>.md`（逐维度清单）。
 * 集中在一个目录的三个理由：用户想整体 gitignore 或整体 review 都是一条路径；
 * 备份 / 还原按条目处理，同目录不影响正确性但便于人肉核对；
 * 以及最实际的一条——不往项目根和 `.claude/` 根上撒文件。
 *
 * 从不抛错：与 `fix-map.js` 同一条纪律（那里的开头写着「所有 fix-* 从不抛异常」），
 * 一切失败通过返回值的 status 表达，否则一次写盘失败会把整批修复停在半路。
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../../shared/logger.js';
import { renderAdvisory, renderPlan } from './advisory.logic.js';

/** 产出目录（相对项目根）。备份条目、还原、gitignore 建议都引用这个常量 */
export const ADVISORY_DIR = '.claude/optimize';

export function advisoryPathFor(dimId) {
  return `${ADVISORY_DIR}/${dimId}.md`;
}

export const PLAN_PATH = `${ADVISORY_DIR}/PLAN.md`;

function writeUnder(dir, rel, body) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
}

/**
 * 写一个维度的整改清单。
 *
 * @param {string} dir 项目根
 * @param {object} dim 维度声明
 * @param {Array} issues
 * @param {object} [opts]
 * @param {string} [opts.degradeReason] 非空表示本维度本可自动修但被降级
 * @returns {{file:string, kind:'advisory', status:'done'|'failed'|'skipped', reason:string}}
 */
export function writeAdvisory(dir, dim, issues, { degradeReason = '', riskSkipped = [] } = {}) {
  const rel = advisoryPathFor(dim.id);

  // 没有问题也没有降级说明时不写文件：留一份「本维度没有问题」的空清单
  // 只会让 .claude/optimize/ 堆满噪声，用户还得逐个点开才知道是空的
  if (!issues.length && !degradeReason) {
    return { file: rel, kind: 'advisory', status: 'skipped', reason: '没有需要处理的问题，未生成清单' };
  }

  try {
    writeUnder(dir, rel, renderAdvisory({
      dim, issues, degradeReason, riskSkipped, at: new Date().toISOString(),
    }));
    return {
      file: rel,
      kind: 'advisory',
      status: 'done',
      reason: degradeReason
        ? `已生成 ${issues.length} 项整改清单（未改动代码）`
        : `已生成 ${issues.length} 项整改清单`,
    };
  } catch (e) {
    logger.warn('advisory', '写整改清单失败', { dir, rel, err: e?.message || String(e) });
    return { file: rel, kind: 'advisory', status: 'failed', reason: e?.message || String(e) };
  }
}

/**
 * 写整体行动计划。
 *
 * @param {string} dir
 * @param {object} plan check-holistic 的 plan
 * @param {Array<{label:string, score:number|null, issueCount:number, source:string}>} dimSummaries
 */
export function writePlan(dir, plan, dimSummaries = []) {
  if (!plan) {
    return { file: PLAN_PATH, kind: 'advisory', status: 'skipped', reason: '整体评估未产出计划，未生成 PLAN.md' };
  }
  try {
    writeUnder(dir, PLAN_PATH, renderPlan({ plan, at: new Date().toISOString(), dimSummaries }));
    return {
      file: PLAN_PATH,
      kind: 'advisory',
      status: 'done',
      reason: `已生成行动计划（${plan.topActions.length} 件事）`,
    };
  } catch (e) {
    logger.warn('advisory', '写行动计划失败', { dir, err: e?.message || String(e) });
    return { file: PLAN_PATH, kind: 'advisory', status: 'failed', reason: e?.message || String(e) };
  }
}

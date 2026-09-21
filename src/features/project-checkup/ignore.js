/**
 * 体检豁免的 IO 层（与本目录 `check-X.js` + `check-X.logic.js` 成对出现的纪律一致）。
 *
 * 三件事都在这里收口，调用方（routes-optimize / optimize-ops）不必知道其中任何一件：
 *   1. 读写 `checkup-ignores.json`（真相源）；
 *   2. 重渲染 `.claude/optimize/IGNORED.md`（给人和 AI 读的副本）；
 *   3. 作废该维度的指纹缓存（不作废就会出现「缓存命中与否两个分数」）。
 *
 * 为什么不复用 `project-optimize/strategies/advisory.js` 里那个同形状的 `writeUnder`：
 * 它是那个模块的私有函数，导出后会造成 `project-checkup → project-optimize` 的反向依赖
 * （当前方向是 optimize 依赖 checkup，反过来即成环）。为三行 mkdir + write 制造一个环，
 * 或者把三行下沉到 shared，代价都比在这里重写高。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readIgnores, addIgnore as addToStore, removeIgnore as removeFromStore } from '../../store/checkup-ignores.js';
import { dropLlmCache } from '../../store/optimize.js';
import { DIMENSIONS } from './dimensions/registry.js';
import { renderIgnoredMd, normalizeFile } from './ignore.logic.js';
import { logger } from '../../shared/logger.js';

/** 与 advisory 策略的产出同目录：用户对 `.claude/optimize/` 已经有预期，不再新开一处 */
export const IGNORED_PATH = '.claude/optimize/IGNORED.md';

/**
 * 某项目的全部豁免记录。
 *
 * **读失败一律降级为空清单**，而不是把异常抛给调用方。store 基座的纪律是
 * 「损坏即抛、拒绝写盘」——那条纪律是为了防止用 fallback 覆盖真实数据，针对的是**写**路径。
 * 这里是读路径，而且调用点在体检主链路上：让一次 JSON 损坏把整轮体检打挂，
 * 代价远大于「这一轮豁免不生效」。告警留痕，照常跑。
 */
export function getIgnores(dir) {
  try {
    return readIgnores(dir);
  } catch (e) {
    logger.warn('checkup-ignore', '豁免清单读取失败，本轮按无豁免处理', {
      dir, err: e?.message || String(e),
    });
    return [];
  }
}

/**
 * 重渲染 md 副本。
 *
 * 失败只告警不抛：真相源已经落盘了，md 写不出去（目录只读、磁盘满）不该让整个请求失败——
 * 那会让用户以为豁免没记上，于是再点一次。
 */
function renderSideCar(dir) {
  try {
    const full = path.join(dir, IGNORED_PATH);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, renderIgnoredMd(getIgnores(dir), DIMENSIONS), 'utf8');
  } catch (e) {
    logger.warn('checkup-ignore', 'IGNORED.md 写入失败（豁免已落盘，仅副本缺失）', {
      dir, err: e?.message || String(e),
    });
  }
}

/**
 * 记一条豁免。
 *
 * @param {string} dir 项目根
 * @param {{dim:string, code:string, file:string, message?:string, note:string}} input
 * @returns {number} 该项目当前的豁免条数
 */
export function addIgnore(dir, input) {
  const rule = {
    dim: String(input.dim),
    code: String(input.code),
    file: normalizeFile(input.file),
    message: String(input.message || ''),
    note: String(input.note || '').trim(),
    at: new Date().toISOString(),
  };
  addToStore(dir, rule);
  dropLlmCache(dir, rule.dim);
  renderSideCar(dir);
  logger.info('checkup-ignore', '记录豁免', { dir, dim: rule.dim, code: rule.code, file: rule.file });
  return getIgnores(dir).length;
}

/**
 * 撤销一条豁免。缓存同样要作废——撤销后这条问题应当在下次体检重新出现。
 *
 * @param {string} dir
 * @param {{dim:string, code:string, file:string}} key
 * @returns {number} 该项目剩余的豁免条数
 */
export function removeIgnore(dir, key) {
  const dim = String(key.dim);
  removeFromStore(dir, { dim, code: String(key.code), file: normalizeFile(key.file) });
  dropLlmCache(dir, dim);
  renderSideCar(dir);
  logger.info('checkup-ignore', '撤销豁免', { dir, dim, code: key.code, file: key.file });
  return getIgnores(dir).length;
}

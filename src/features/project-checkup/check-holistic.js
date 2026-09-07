/**
 * 维度「整体智能评估」的 IO 层。
 *
 * 与其它维度的两点不同：
 * 1. **必须最后跑**。它读的是其它维度的结论，早跑就只能看到一堆 pending。
 *    调度顺序由 `entrypoints/web/optimize-ops.js` 保证。
 * 2. **走只读多轮 agent 而不是单轮分类器**。它要判「这几件事哪个先做」，
 *    而这个判断经常需要实地看一眼代码才下得准（例如某个「反向依赖」到底牵动多少调用点）。
 *    `llm-readonly-agent` 的三层只读防线保证它只能读、不能写。
 *
 * 不缓存。指纹该怎么算是个伪问题：它的输入是**其它维度的结论**，而那些结论各自已有缓存，
 * 任何一维刷新都应让整体评估重算——那等于「基本不命中」。与其造一个几乎永不命中的缓存，
 * 不如坦白：这一维每次体检都重跑一次。
 */
import { runReadonlyAgent, READONLY_AGENT_TIMEOUT_MS } from '../../capabilities/llm-readonly-agent.js';
import { logger } from '../../shared/logger.js';
import { DIMENSIONS } from './dimensions/registry.js';
import {
  outlineOf, summarizeDims, buildHolisticPrompt, buildBusinessContext,
  validatePlan, evaluateHolistic, SYSTEM_PROMPT,
} from './check-holistic.logic.js';

/** 失败原因 → 给用户看的话。与 llm-readonly-agent 的 reason 词表对齐 */
const REASON_TEXT = {
  exhausted: '账号额度已耗尽，整体评估未执行',
  cancelled: '已按你的要求停止',
  timeout: 'AI 整体评估超时未返回',
  unparsable: 'AI 返回的内容无法解析成行动计划',
};

/**
 * @param {string} dir 项目根
 * @param {object} report 当前体检报告（其它维度已落地）
 * @param {object} evidence `evidence/collect.js` 的产出
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{score, status, issues, verdictLog, reason, plan}>}
 */
export async function checkHolistic(dir, report, evidence, { signal } = {}) {
  const dimsSummary = summarizeDims(report?.dims || {}, DIMENSIONS);

  // 其它维度一条结论都没有时不发请求：模型手上没有可比较的东西，
  // 只能凭空编一份行动计划——那比没有计划更糟
  if (!dimsSummary.trim()) {
    return {
      score: null,
      status: 'na',
      issues: [],
      verdictLog: [],
      reason: '其它维度尚无结论，无法做整体评估',
      plan: null,
    };
  }

  const prompt = buildHolisticPrompt({
    dimsSummary,
    outline: outlineOf(evidence?.files || []),
    dir,
    // 业务语境是这一维能给出「个性化」而非「通用」建议的唯一依据，
    // 详见 check-holistic.logic.js 的 buildBusinessContext 注释
    business: buildBusinessContext(evidence),
  });

  const { data, reason, denied } = await runReadonlyAgent({
    prompt,
    systemPrompt: SYSTEM_PROMPT,
    cwd: dir,
    logTag: 'checkup/holistic',
    timeoutMs: READONLY_AGENT_TIMEOUT_MS,
    signal,
    // 必须指名要 topActions：这是多轮工具调用，模型探索期引用的代码片段也是配平的 JSON。
    // 实测踩过——抓到中途那个对象，reason 是 null（解析成功）但 validatePlan 不认，
    // 6.3 分钟白跑且日志里看不出为什么
    requireKeys: ['topActions'],
  });

  if (denied?.length) {
    // 只读防线拦下过写操作 —— 结论仍然可用（没写成），但要留痕：
    // 它意味着提示词里「你只能读」这件事没说清，是提示词的缺陷而不是模型的
    logger.warn('check-holistic', '整体评估尝试调用非只读工具（已拦下）', { dir, denied });
  }

  const plan = validatePlan(data);
  if (!plan) {
    // 把模型实际返回的形状打出来。实测踩过一次：日志只有 `reason: null`
    // ——那表示**调用成功、JSON 也解析出来了**，只是 validatePlan 不认（topActions 为空或缺 title）。
    // 光看 reason 完全无法区分「模型没返回」和「模型返回了但字段没对上」，
    // 而这两者的修法一个是调超时、一个是改 prompt，方向完全相反。
    logger.warn('check-holistic', '整体评估未产出可用计划', {
      dir,
      reason,
      gotKeys: data && typeof data === 'object' ? Object.keys(data).join(',') : null,
      actionCount: Array.isArray(data?.topActions) ? data.topActions.length : null,
      got: data ? JSON.stringify(data).slice(0, 600) : null,
    });
    return evaluateHolistic(null, REASON_TEXT[reason] || 'AI 整体评估未完成');
  }

  logger.info('check-holistic', '整体评估产出计划', {
    dir,
    score: plan.score,
    actions: plan.topActions.length,
    businessRisks: plan.businessRisks.length,
    hasBusinessRead: !!plan.businessRead,
  });

  return evaluateHolistic(plan);
}

/**
 * 项目地图生成入口 —— 协调完整链路
 *
 * 核心职责：调度 collectProjectFacts → buildMapGenPrompt → runReadonlyAgent →
 * parseMapGenResponse + mergeSupplements → validateProjectMap
 *
 * 设计要点：
 * - 可中止：支持 AbortSignal，任何阶段若 signal.aborted 则抛错
 * - 降级方案：LLM 补语义失败时，仍返回完整地图（modules + edges），只是没有 description
 * - 错误诊断：抛错时附加原因，便于排查
 * - 日志规范：用 logTag 标记日志来源
 */

import { collectProjectFacts } from './collect-facts.js';
import {
  buildMapGenPrompt,
  mergeSupplements,
  validateProjectMap,
  splitByFingerprint,
} from './gen-map.logic.js';
import { runReadonlyAgent, READONLY_AGENT_TIMEOUT_MS } from '../../capabilities/llm-readonly-agent.js';
import { logger } from '../../shared/logger.js';

/**
 * 适配 collectProjectFacts 的输出格式以满足 buildMapGenPrompt 的期望
 * collectProjectFacts 返回的模块结构与 buildMapGenPrompt 期望的不完全一致
 * 本函数进行格式转换
 */
function adaptFactsPackForPrompt(factsPack) {
  return {
    ...factsPack,
    modules: factsPack.modules.map(m => ({
      ...m,
      // buildMapGenPrompt 期望 files 是对象数组，但我们只有文件路径字符串
      // 由于 collectProjectFacts 已收集所有导出，我们汇总为单一导出列表
      // 调整 files 格式让 buildMapGenPrompt 能正常工作
      files: [
        {
          path: m.path, // 模块整体的路径
          exports: m.exports, // 模块汇总的导出
        },
      ],
      // buildMapGenPrompt 期望 imports，但 collectProjectFacts 返回 dependsOn
      imports: m.dependsOn || [],
    })),
  };
}


/**
 * 生成项目地图的完整入口
 *
 * @param {object} opts
 * @param {string} opts.projectId 项目标识
 * @param {string} opts.projectPath 项目根路径
 * @param {AbortSignal} [opts.signal] 中止信号
 * @param {Function} [opts.onProgress] 进度回调：(stage, detail) => void
 * @param {string} [opts.model] LLM 模型（null = 跟随默认）
 * @param {string} [opts.logTag] 日志标识
 *
 * @returns {Promise<object>} 完整地图 JSON：
 *   {
 *     projectId,
 *     modules: [{id, name, path, files, exports, description, keyFunctions, ...}],
 *     edges: [{from, to, type}],
 *     externalDeps: [],
 *     summary: {}
 *   }
 *
 * @throws {Error} 任何阶段抛错时，附加原因诊断
 */
export async function generateProjectMap(opts = {}) {
  const {
    projectId,
    projectPath,
    signal,
    onProgress,
    model = null,
    logTag = 'gen-map',
    previous = null, // 上一版地图；指纹一致的模块直接复用描述，只有改动过的才送 LLM
  } = opts;

  // 验证必填参数
  if (!projectId || !projectPath) {
    throw new Error('缺少必填参数：projectId 和 projectPath');
  }

  // 检查初始中止信号
  if (signal?.aborted) {
    throw new Error('Generation aborted before start');
  }

  let factsPack = null;
  let mapData = null;

  try {
    // ========== 阶段 1: scanning 确定性扫描 ==========
    logger.info(logTag, '开始扫描项目结构', { projectId, projectPath });
    onProgress?.({ stage: 'scanning', detail: '正在扫描项目目录...' });

    if (signal?.aborted) {
      throw new Error('Generation aborted during scanning');
    }

    factsPack = await collectProjectFacts(projectPath);

    logger.info(logTag, '扫描完成', {
      projectId,
      totalModules: factsPack.modules.length,
      totalFiles: factsPack.summary.totalFiles,
    });

    // ========== 阶段 2: llm 补语义 ==========
    if (signal?.aborted) {
      throw new Error('Generation aborted before LLM call');
    }

    // 增量：指纹与上一版一致、且上一版已有真实描述的模块直接复用，不送进 LLM。
    // 扫描本身是零成本的，贵的只有补语义这一步——所以省 token 的关键是缩小送模范围，
    // 而不是跳过扫描（跳过扫描会让依赖边和文件清单一起过期）。
    const { reused, stale } = splitByFingerprint(factsPack.modules, previous);
    let supplements = reused;

    if (!stale.length) {
      logger.info(logTag, '全部模块指纹未变，跳过 LLM', { projectId, reused: reused.length });
      onProgress?.({ stage: 'llm', detail: '无改动模块，跳过语义补充' });
    } else {
      logger.info(logTag, '开始调用 LLM 补语义', { projectId, stale: stale.length, reused: reused.length });
      onProgress?.({
        stage: 'llm',
        detail: reused.length
          ? `正在补充 ${stale.length} 个改动模块的语义（复用 ${reused.length} 个）...`
          : '正在调用 LLM 补充语义信息...',
      });

      // 只把待描述的模块喂给模型；其余模块不进 prompt，token 随之下降
      const prompt = buildMapGenPrompt(adaptFactsPackForPrompt({ ...factsPack, modules: stale }));

      // 调用只读 agent（超时 600s）
      const llmResult = await runReadonlyAgent({
        prompt,
        cwd: projectPath,
        model,
        logTag,
        timeoutMs: READONLY_AGENT_TIMEOUT_MS,
        signal,
        maxTurns: 30,
      });

      // 降级方案：LLM 失败不抛错，仍继续（modules + edges 仍可用，复用的描述也还在）
      if (llmResult.data) {
        logger.info(logTag, 'LLM 返回有效数据', { projectId });
        supplements = [...reused, ...(llmResult.data.supplements || [])];
      } else {
        logger.warn(logTag, 'LLM 补语义失败，进行降级', {
          projectId,
          reason: llmResult.reason,
          denied: llmResult.denied,
        });
      }
    }

    // ========== 阶段 3: merge 合并补语义 ==========
    logger.info(logTag, '合并补语义信息', { projectId, supplements: supplements.length });
    onProgress?.({ stage: 'merge', detail: '合并 LLM 补充的信息...' });

    if (signal?.aborted) {
      throw new Error('Generation aborted during merge');
    }

    const mergedModules = mergeSupplements(factsPack.modules, supplements);

    mapData = {
      projectId,
      // 前端要展示「哪个项目、何时生成」；projectId 是哈希过的文件名，人读不出路径，所以原样带上。
      projectPath,
      generatedAt: new Date().toISOString(),
      modules: mergedModules,
      edges: factsPack.edges,
      externalDeps: factsPack.externalDeps,
      summary: factsPack.summary,
    };

    // ========== 阶段 4: validate 校验 ==========
    logger.info(logTag, '校验地图结构', { projectId });
    onProgress?.({ stage: 'validate', detail: '验证地图数据有效性...' });

    if (signal?.aborted) {
      throw new Error('Generation aborted during validation');
    }

    validateProjectMap(mapData);

    logger.info(logTag, '地图生成完成', {
      projectId,
      modules: mapData.modules.length,
      edges: mapData.edges.length,
    });

    onProgress?.({ stage: 'complete', detail: '地图生成成功' });

    return mapData;
  } catch (err) {
    logger.error(logTag, '地图生成失败', {
      projectId,
      error: err.message,
      stack: err.stack,
    });
    throw err;
  }
}

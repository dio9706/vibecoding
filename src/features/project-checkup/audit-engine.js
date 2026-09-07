/**
 * 通用审计引擎（IO 层）：召回 → 指纹缓存 → 分批调 LLM → 校验 → 落成维度结果。
 *
 * 判定文案与判据全部来自 `dimensions/registry.js` 的声明，纯计算全部在 `audit-engine.logic.js`。
 * 本文件只负责三件 IO 的事：调模型、限并发、把缓存进出。
 *
 * ## 并发预算必须是全局的
 *
 * `check-prompts.js` 内部限并发 4，理由是「每批都会拉起一个独立的 Claude CLI 子进程，
 * 10 批全并发本机内存和 API 并发都吃不消」。但本引擎要服务**十个维度**，
 * 而编排层会把它们一起点起来——各维度各自限 4，实际就是 40 个子进程同时在跑。
 *
 * 所以闸放在模块级：所有维度的所有批共用一个信号量。这样既保住「谁空了谁取下一个」的
 * 吞吐（不必让维度串行），又把子进程数钉死在预算内。
 *
 * ## 从不抛异常
 *
 * 与 `fix-*` 同一条纪律：调用方（体检编排）是循环，一次抛错会把整批维度停在半路。
 * 一切失败都通过返回值的 status（partial / na）表达。
 */
import { runClassifierOnce } from '../../capabilities/llm-classify.js';
import { logger } from '../../shared/logger.js';
import { isCacheValid } from './fingerprint.logic.js';
import {
  normalizeRecall, buildSystemPrompt, buildPrompt, validateVerdicts,
  reanchor, evaluateAudit, chunk,
} from './audit-engine.logic.js';

/**
 * 单批候选数。
 *
 * 沿用 check-prompts 实测出的 12：取 20 时有批次连续两次报
 * `Reached maximum number of turns (1)`——批量越大、清单越杂，模型越容易动
 * 「先去读一下原文件」的念头，而工具全被禁、一轮就用光了。
 */
const DEFAULT_BATCH_SIZE = 12;

/**
 * 全局判定并发。见文件头「并发预算必须是全局的」。
 *
 * 4 是 check-prompts 校准过的单机上限；本引擎跨维度共用这一个额度，
 * 所以维度数量增加不会把子进程数推高。
 */
const GLOBAL_JUDGE_CONCURRENCY = 4;

/**
 * 单批超时预算。
 *
 * 沿用 check-prompts 的 300s，且**不要往下调**：那边记录过 122s 预算下的事故——
 * 模型实测每批 60~127s，race 在 122s 就放弃，`out` 只拿到半截流，
 * JSON 配不平大括号 → null → 重试再超 → 整批废 → 整个维度 partial。
 * 而 partial 的维度会被 aggregateScore 踢出总分，等于这个维度没有。
 *
 * 本引擎的候选比那边大得多（complexity 的单条证据含最多 45 行正文），
 * 输出侧也更长（每条都要 reason + suggestion），长尾只会更长。
 */
const BATCH_TIMEOUT_MS = 300_000;

/**
 * 判定模型：null = 跟随会话默认模型。
 *
 * 不要换成 haiku。check-prompts 实测证伪过「这类判定不需要推理深度」的假设：
 * 同一输入连跑三次 over-broad 为 4/8/6，三次并集 9 条里只有 1 条三次都命中；
 * 抽象判据学不会（只会照抄 few-shot 里的句式）；指令遵循度差（要求必给 suggestion，6 条里 3 条没给）。
 * 本引擎的判据比那边更抽象（「这几处是否表达同一条知识」），对档位更敏感。
 */
const JUDGE_MODEL = null;

/** 极简异步信号量。够用就好——需要的全部语义只有「拿一个、用完还」 */
function createSemaphore(limit) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  return async function withPermit(fn) {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

const withPermit = createSemaphore(GLOBAL_JUDGE_CONCURRENCY);

/**
 * 判定一批（失败重试一次）。
 *
 * 为什么要重试：实测同一份 prompt 连跑两次，第一次模型返回空文本（SDK 报 success、也计了费，
 * 但 onText/onResult 都没拿到内容），第二次完全正常。这种瞬时空响应本身不可控，
 * 但它撞上「任何一批失败 → 整体 partial」的全有或全无策略后果会被放大：
 * N 批并行时单批失败率 p 会放成 1-(1-p)^N。重试一次把它压回可接受范围。
 *
 * 只重试一次：真正的失败原因（额度耗尽、限流）重试也不会好转，多试只是让用户多等。
 */
async function judgeBatch({ dim, batch, sharedContext, index, total, signal }) {
  if (signal?.aborted) return null;

  const prompt = buildPrompt({ dim, batch, sharedContext });
  const systemPrompt = buildSystemPrompt(dim.rubric);
  const names = Object.keys(dim.verdicts);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (signal?.aborted) return null;
    // 逐批留痕。**这是排障的唯一抓手**：实测过一次「用户以为任务死了」的误判——
    // 当时 deadcode 有 19 批、每批约 55s，而维度要全部批次跑完才落地，
    // 界面二十多分钟零变化；日志里也只有失败批次有记录，成功的一声不响，
    // 于是「跑得慢」和「已经死了」在外部完全无法区分。
    const t0 = Date.now();
    logger.info('audit-engine', '判定批次开始', {
      dim: dim.id, batch: `${index}/${total}`, attempt, size: batch.length,
    });

    const raw = await runClassifierOnce({
      prompt,
      systemPrompt,
      model: JUDGE_MODEL,
      logTag: `audit/${dim.id}#${index}`,
      timeoutMs: BATCH_TIMEOUT_MS,
    });
    const list = raw ? validateVerdicts(raw, batch.length, names) : null;

    if (list) {
      logger.info('audit-engine', '判定批次完成', {
        dim: dim.id, batch: `${index}/${total}`, attempt, ms: Date.now() - t0,
      });
      return list;
    }
    logger.warn('audit-engine', 'LLM 判定失败（无输出或结构不合法）', {
      dim: dim.id,
      batch: `${index}/${total}`,
      attempt,
      ms: Date.now() - t0,
      size: batch.length,
      got: raw ? JSON.stringify(raw).slice(0, 200) : null,
      // 一次失败要花掉整个超时预算（实测 complexity#6 两次尝试共烧 10 分钟），
      // 把耗时打出来才能看出「是判错了」还是「是卡住了」
      hint: Date.now() - t0 >= BATCH_TIMEOUT_MS ? '耗尽超时预算，判定为卡住' : '模型返回了但结构不合法',
    });
  }
  return null;
}

/**
 * 跑一个 audit 维度。
 *
 * @param {object} dim 注册表里的维度声明（engine: 'audit'）
 * @param {object} evidence `evidence/collect.js` 的产出
 * @param {object} [opts]
 * @param {{fingerprint:string, result:object}|null} [opts.cache] 上次缓存（由上层持久化后传入）
 * @param {boolean} [opts.force] 忽略缓存强制重跑
 * @param {AbortSignal} [opts.signal]
 * @param {(p:{dim:string,done:number,total:number,ok:boolean})=>void} [opts.onProgress]
 *   每跑完一批回调一次。维度要全部批次跑完才落地，没有它界面就只能干转圈
 * @returns {Promise<{score:number|null, status:string, issues:Array, verdictLog:Array,
 *   reason:string, cached:boolean, cacheEntry:object|null, fingerprint:string,
 *   candidateCount:number, batchCount:number}>}
 */
export async function runAudit(dim, evidence, { cache = null, force = false, signal, onProgress } = {}) {
  const fingerprint = evidence.fingerprints?.[dim.fingerprintScope] || '';

  if (!force && isCacheValid(cache, fingerprint)) {
    logger.info('audit-engine', '维度命中指纹缓存，跳过判定', { dim: dim.id, fingerprint });
    return { ...cache.result, cached: true, cacheEntry: cache, fingerprint };
  }

  // 通用 na 兜底：吃源码指纹的维度在「一个源文件都没有」时无从判断。
  // 放在引擎里而不是各召回器里——十个召回器各写一遍这个判断必然写出十种措辞
  if (dim.fingerprintScope === 'sources' && !evidence.files.length) {
    return finish(
      { score: null, status: 'na', issues: [], verdictLog: [], reason: '项目里没有可分析的源码文件' },
      fingerprint, 0, 0,
    );
  }

  let recalled;
  try {
    recalled = normalizeRecall(dim.recall(evidence));
  } catch (e) {
    // 召回器是纯函数，抛错说明遇到了没预料的输入形状。记下来当本维度失败，
    // 不要让它掀翻整轮体检——十个维度里一个坏了，另外九个的结论仍然有效
    logger.warn('audit-engine', '召回器异常', { dim: dim.id, err: e?.message || String(e) });
    return finish(
      { score: null, status: 'error', issues: [], verdictLog: [], reason: `取材失败：${e?.message || e}` },
      fingerprint, 0, 0,
    );
  }

  const { candidates, sharedContext, na } = recalled;

  if (na || !candidates.length) {
    logger.info('audit-engine', na ? '维度无法判断（na）' : '维度零候选，直接满分', {
      dim: dim.id, reason: na || '',
    });
    return finish(
      evaluateAudit({ dim, candidates, verdicts: null, fileCount: evidence.files.length, na }),
      fingerprint, candidates.length, 0,
    );
  }

  const batches = chunk(candidates, dim.batchSize || DEFAULT_BATCH_SIZE);
  logger.info('audit-engine', '维度开始判定', {
    dim: dim.id, candidates: candidates.length, batches: batches.length,
  });

  // 批级进度回调。**这不是可选的观测糖**：一个维度要等全部批次跑完才落地，
  // 19 批的维度会让界面转圈二十多分钟。没有这个回调，用户无法区分「在跑」和「死了」
  let finished = 0;
  const results = await Promise.all(batches.map((batch, i) => withPermit(
    async () => {
      const r = await judgeBatch({
        dim, batch, sharedContext, index: i + 1, total: batches.length, signal,
      });
      finished += 1;
      onProgress?.({ dim: dim.id, done: finished, total: batches.length, ok: r !== null });
      return r;
    },
  )));

  // 任何一批失败 → 整体 partial。不做「部分判定 + 部分未判定」的混合态：
  // 没判过的候选会被静默当成「可接受」，凭空抬高分数（见 audit-engine.logic.js 的 validateVerdicts 注释）
  const failed = results.some((r) => r === null);
  const verdicts = failed ? null : reanchor(results.flat(), candidates);

  const out = evaluateAudit({ dim, candidates, verdicts, fileCount: evidence.files.length });
  logger.info('audit-engine', '维度判定结束', {
    dim: dim.id,
    status: out.status,
    score: out.score,
    issues: out.issues.length,
    batches: batches.length,
    failedBatches: results.filter((r) => r === null).length,
  });
  return finish(out, fingerprint, candidates.length, batches.length);
}

/**
 * 收尾：附上缓存条目与统计。
 *
 * 只有 status === 'done' 才产出 cacheEntry。partial / error 意味着这次没跑成，
 * 把它缓存下来会让用户下次点体检拿到同一个错误结论且**再也不会重试**
 * （指纹没变 → 永久命中），失败就被固化了。
 */
function finish(result, fingerprint, candidateCount, batchCount) {
  const cacheEntry = result.status === 'done' ? { fingerprint, result } : null;
  return { ...result, cached: false, cacheEntry, fingerprint, candidateCount, batchCount };
}

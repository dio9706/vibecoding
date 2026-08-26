/**
 * 体检编排层：静态维度同步出结果，两个 LLM 维度后台**并行**跑、经 SSE 回填。
 *
 * 为什么并行：提示词质量和注释合理性都是只读分析、互不依赖，串行会白等一倍时间
 * （两者各自内部已经限并发分批，外层再叠一层并发不会把请求量放大到失控）。
 *
 * 为什么不复用 store/runs.js 的 run 注册表：那套是给 Claude 对话设计的
 * （session / todos / askUser / 额度续跑 / 看门狗），体检一条都用不上，接进来反而要
 * 处理一堆无关状态。这里只借它的 sendTo 做 SSE 发送。
 */
import { sendTo } from '../../store/runs.js';
import { logger } from '../../shared/logger.js';
import { checkPrompts } from '../../features/project-checkup/check-prompts.js';
import { checkComments } from '../../features/project-checkup/check-comments.js';
import { runStaticCheckup, recomputeReport, analyzingDim } from '../../features/project-checkup/index.js';
import { getLlmCache, saveLlmCache, saveCheckup } from '../../store/optimize.js';

const RUNNERS = { prompts: checkPrompts, comments: checkComments };

const jobs = new Map(); // checkupId -> job
let seq = 0;
const KEEP_MS = 30 * 60 * 1000; // 完成的 job 保留时长，供晚接入/重连的前端读取
const MAX_DONE = 50;

/** race 用的哨兵：拿到它表示该维度这一拍还没出结果（即冷跑，要走 SSE） */
const TICK = Symbol('tick');
const tick = () => new Promise((r) => setTimeout(r, 0, TICK));

/**
 * 从 checkXxx 的返回里挑出「维度结果」那部分。
 * cacheEntry / fingerprint / candidateCount 这些是编排层的账，不该混进报告落盘给前端。
 */
function toDim(result) {
  return {
    score: result.score ?? null,
    status: result.status,
    issues: result.issues || [],
    verdictLog: result.verdictLog || [],
    reason: result.reason || '',
    cached: !!result.cached,
  };
}

/** 单个维度炸了只影响它自己：status 非 done → aggregateScore 自动排除，另一维和总分都不受牵连 */
function failedDim(message) {
  return { score: null, status: 'error', issues: [], verdictLog: [], reason: `分析失败：${message}` };
}

function emit(job, event, data) {
  for (const res of [...job.subs]) {
    if (!sendTo(res, event, data)) job.subs.delete(res);
  }
}

export function getCheckupJob(id) {
  return id ? jobs.get(id) || null : null;
}

/**
 * 订阅某次体检的维度回填。
 *
 * 必须先补 replay：POST 返回到前端把 EventSource 建起来之间有个窗口，
 * 跑得快的维度（比如注释维度抽不到样本直接 na）可能正好落在这个窗口里，
 * 不补历史这个 dim 事件就永远丢了，卡片会一直转圈。
 */
export function attachCheckupJob(job, res) {
  sendTo(res, 'replay', { status: job.status, dims: job.landed, done: job.done });
  // 已终结的 job：replay 里已经包含全部结果，没有后续事件可推了，直接收尾。
  // 不能挂进 subs 干等——finishJob 早就跑完，这条连接再没人会去 end 它，
  // 每次「体检完成后刷新页面」都会永久占住一个连接。
  if (job.status !== 'running') return res.end();
  job.subs.add(res);
  res.on('close', () => job.subs.delete(res));
}

/**
 * 跑一次体检。
 *
 * @returns {Promise<{report:object, checkupId:string|null}>}
 *   checkupId 为 null 表示两个 LLM 维度都已在同步返回里落定（缓存全命中 / 无需调 LLM），
 *   前端不用开 SSE。
 */
export async function startCheckup(dir, { force = false } = {}) {
  // 先跑静态维度：目录非法会在这里抛，早于任何 LLM 调用 —— 不会为一个打错的路径白烧额度
  const report = runStaticCheckup(dir);
  const cache = getLlmCache(dir);

  const runners = Object.entries(RUNNERS).map(([key, run]) => ({
    key,
    // 先把 rejection 收进结果对象。下面的 race 只 await 两个分支之一，
    // 没被 await 到的那次 rejection 会升级成 unhandledRejection —— Node 默认把它当致命错误，
    // 一次 LLM 调用失败就能打挂整个 web 服务。
    p: Promise.resolve()
      .then(() => run(dir, { cache: cache[key] || null, force }))
      .then((r) => ({ ok: true, r }), (e) => ({ ok: false, message: e?.message || String(e) })),
  }));

  // 抢一拍，把「缓存命中」和「冷跑」分流。
  // 命中指纹缓存时 checkXxx 全程同步（只做 fs stat + 指纹比对就 return），promise 在调用当刻
  // 就已 resolve，必然先于 setTimeout(0) 到达 → 直接把最终结果并进同步返回，省掉一次 SSE 往返，
  // 前端点体检就是秒回带分数。冷跑时 promise 还挂在 LLM 请求上 → 拿到 TICK → 标 analyzing 走 SSE。
  // 万一将来 checkXxx 的缓存判定改成异步，这里只会退化成「缓存命中也走一次 SSE」，不会出错。
  const raced = await Promise.all(runners.map((x) => Promise.race([x.p, tick()])));

  const pending = [];
  raced.forEach((out, i) => {
    const { key } = runners[i];
    if (out === TICK) {
      report.dims[key] = analyzingDim();
      pending.push(runners[i]);
      return;
    }
    report.dims[key] = settleDim(dir, key, out);
  });

  recomputeReport(report);
  saveCheckup(dir, report);

  if (!pending.length) return { report, checkupId: null };

  gc();
  const job = {
    id: `ckup_${Date.now().toString(36)}_${++seq}`,
    dir,
    status: 'running',
    report,
    landed: {}, // 已回填的维度：{key: dimResult}，供新订阅者 replay
    done: null, // 终局汇总：{score, grade, issueCount}
    subs: new Set(),
    updatedAt: Date.now(),
  };
  jobs.set(job.id, job);

  // 不 await：立刻把 checkupId 还给前端去接 SSE
  runPending(job, pending).catch((e) => {
    logger.warn('optimize', '体检 LLM 维度编排异常', { dir, err: e?.message || String(e) });
    finishJob(job);
  });

  return { report, checkupId: job.id };
}

/** 落定一个维度：写回指纹缓存并转成报告里的 dim 结构 */
function settleDim(dir, key, out) {
  if (!out.ok) {
    logger.warn('optimize', '维度分析失败', { dir, dim: key, err: out.message });
    return failedDim(out.message);
  }
  // cacheEntry 只在 status === 'done' 时非空（检测器自己把关：partial 不进缓存，
  // 否则一次失败会被指纹永久固化，用户再点体检也只会拿到同一个错误结论）
  saveLlmCache(dir, key, out.r.cacheEntry);
  return toDim(out.r);
}

/** 逐个维度落地就推一次，全部落地后重算总分收尾 */
async function runPending(job, pending) {
  await Promise.all(pending.map(async ({ key, p }) => {
    const dim = settleDim(job.dir, key, await p);
    job.report.dims[key] = dim;
    job.landed[key] = dim;
    // 每落一个维度就重算并落盘：中途刷新页面的用户能看到已出的那一半，而不是空报告
    recomputeReport(job.report);
    saveCheckup(job.dir, job.report);
    job.updatedAt = Date.now();
    emit(job, 'dim', { key, result: dim });
  }));
  finishJob(job);
}

function finishJob(job) {
  if (job.status !== 'running') return;
  recomputeReport(job.report);
  saveCheckup(job.dir, job.report);
  job.status = 'done';
  job.done = { score: job.report.score, grade: job.report.grade, issueCount: job.report.issueCount };
  job.updatedAt = Date.now();
  emit(job, 'done', job.done);
  for (const res of [...job.subs]) {
    try { res.end(); } catch { /* 连接已断，忽略 */ }
  }
  job.subs.clear();
}

/** 淘汰过期/超量的已完成 job，避免内存无限增长（照搬 store/runs.js 的 gc 口径） */
function gc() {
  const now = Date.now();
  const done = [];
  for (const job of jobs.values()) {
    if (job.status === 'running') continue;
    if (now - job.updatedAt > KEEP_MS) jobs.delete(job.id);
    else done.push(job);
  }
  if (done.length > MAX_DONE) {
    done.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const job of done.slice(0, done.length - MAX_DONE)) jobs.delete(job.id);
  }
}

/**
 * 项目地图编排层：起跑生成任务（串行闸 + SSE）、查询已生成的地图、语义搜模块。
 *
 * 不复用 store/optimize.js 的 busy 机制：那把闸是体检/优化共用的，把地图生成也接进去
 * 会导致「体检中」把「生成地图」也一起挡下，两件事本无关联。这里用独立的、纯内存的
 * projectId 维度串行闸，job 结构对齐 optimize-ops.js 的 fix job（有序事件流 + replay），
 * 只借 store/runs.js 的 sendTo 发 SSE（原因同 optimize-ops 顶部注释：那套 run 注册表是
 * 给 Claude 对话设计的，地图生成一条都用不上）。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { sendTo } from '../../store/runs.js';
import { logger } from '../../shared/logger.js';
import { generateProjectMap } from '../../features/project-map/gen-map.js';
import { saveProjectMap, loadProjectMap } from '../../features/project-map/persist.js';
import { runClassifierOnce } from '../../capabilities/llm-classify.js';

const jobs = new Map(); // jobId -> job
const busyByProject = new Map(); // projectId -> 正在跑的 jobId（串行闸）
let seq = 0;
const KEEP_MS = 30 * 60 * 1000; // 完成的 job 保留时长，供晚接入/重连的前端读取
const MAX_DONE = 50;

/** 目录必须存在且是目录；文案对齐 optimize-ops.js 的 assertValidProjectDir，前端已按它显示 */
function assertValidProjectDir(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error('目录不存在或不可读');
  }
}

/**
 * dir → projectId 的唯一口径：非法文件名字符换成 `_`，并追加 dir 的短哈希。
 *
 * 单纯替换字符会在长路径或「仅大小写/少量字符不同」的目录间发生截断碰撞
 * （Windows 路径常超 80 字符，替换后一截就更容易撞车）；追加哈希把「确定性」
 * 和「抗碰撞」两个要求都占住——同一个 dir 字符串永远得到同一个 id。
 * 注意这里不做大小写/斜杠归一化：调用方（路由层）一律透传前端传来的原始 dir 字符串，
 * 同一个项目只要前端传法不变，id 就稳定。
 */
export function safeProjectId(dir) {
  const raw = String(dir);
  const base = raw.replace(/[^a-zA-Z0-9]/g, '_').slice(-80); // 取尾部：盘符前缀同质化严重，尾部差异度更高
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return `${base}_${hash}`;
}

/** 向订阅者广播；写失败的连接自动退订（对齐 optimize-ops.js 的 emit） */
function emit(job, event, data) {
  for (const res of [...job.subs]) {
    if (!sendTo(res, event, data)) job.subs.delete(res);
  }
}

/** 记进事件流再推送：晚接入的订阅者靠这份记录补齐前面的进度 */
function pushEvent(job, event, data) {
  job.events.push({ event, data });
  job.updatedAt = Date.now();
  emit(job, event, data);
}

function closeSubs(job) {
  for (const res of [...job.subs]) {
    try { res.end(); } catch { /* 连接已断，忽略 */ }
  }
  job.subs.clear();
}

function finishJob(job, done) {
  if (job.status !== 'running') return;
  job.status = 'done';
  job.done = done;
  job.updatedAt = Date.now();
  emit(job, 'done', done);
  closeSubs(job);
  // 闸一定要放：漏放的话这个项目要一直卡在「生成中」，直到进程重启
  busyByProject.delete(job.projectId);
}

export function getMapGenJob(id) {
  return id ? jobs.get(id) : null;
}

/**
 * 订阅某次地图生成的进度。
 *
 * 必须先补 replay：POST 返回到前端把 EventSource 建起来之间有个窗口，
 * 期间产生的 step 事件不补就永远丢了（同 optimize-ops.js 的 attachFixJob）。
 */
export function attachMapGenJob(job, res) {
  sendTo(res, 'replay', { status: job.status, events: job.events, done: job.done });
  if (job.status !== 'running') return res.end();
  job.subs.add(res);
  res.on('close', () => job.subs.delete(res));
}

/**
 * 发起一次项目地图生成（带串行闸，不 await）。
 *
 * @param {string} dir 项目根目录
 * @returns {{jobId:string, status:'queued'} | {busy:{jobId:string}}}
 * @throws {Error} dir 非法时抛错，调用方（路由层）转 400
 */
export function startMapGen(dir) {
  assertValidProjectDir(dir);
  const projectId = safeProjectId(dir);

  const runningId = busyByProject.get(projectId);
  if (runningId) return { busy: { jobId: runningId } };

  gc();
  const jobId = `mapgen_${Date.now().toString(36)}_${++seq}`;
  busyByProject.set(projectId, jobId);
  const job = {
    id: jobId,
    projectId,
    dir,
    status: 'running',
    events: [],
    done: null,
    subs: new Set(),
    updatedAt: Date.now(),
  };
  jobs.set(jobId, job);

  // 不 await：立刻把 jobId 还给前端去接 SSE
  runMapGen(job).catch((e) => {
    logger.warn('project-map', '地图生成编排异常', { dir, err: e?.message || String(e) });
    finishJob(job, { error: e?.message || String(e) });
  });

  return { jobId, status: 'queued' };
}

/** 生成主流程：跑完整链路 → 落盘 → 收尾。LLM 补语义失败时 generateProjectMap 内部已自行降级，不会走到这里的 catch */
async function runMapGen(job) {
  try {
    const mapData = await generateProjectMap({
      projectId: job.projectId,
      projectPath: job.dir,
      logTag: 'project-map',
      onProgress: ({ stage, detail }) => pushEvent(job, 'step', { stage, detail }),
    });
    await saveProjectMap(job.projectId, mapData);
    finishJob(job, { ok: true, summary: mapData.summary });
  } catch (e) {
    logger.warn('project-map', '地图生成失败', { dir: job.dir, err: e?.message || String(e) });
    finishJob(job, { error: e?.message || String(e) });
  }
}

/** 读取已生成的地图；不存在返回 null（不抛错） */
export function getProjectMap(dir) {
  return loadProjectMap(safeProjectId(dir));
}

/**
 * 在已生成的地图里，用 LLM 找出与 query 最相关的模块。
 *
 * 抛错分两类，路由层据此区分状态码：
 *  - 地图不存在（loadProjectMap 返回 null）：抛带 `notFound` 标记的错误 → 路由转 404。
 *  - 地图文件损坏（loadProjectMap 抛非 ENOENT 的 SyntaxError 等）：原样上抛 → 路由转 500。
 * 用标记而非文案区分，避免路由层靠 message 猜类型（脆弱）。
 * LLM 调用失败/返回不出合法 JSON 时**不**抛错，返回空数组——搜索是个辅助功能，
 * 不该因为一次 LLM 抖动就让整个请求报错。
 *
 * @returns {Promise<Array<{id:string, name:string, score:number, reason:string}>>}
 */
export async function searchModules(dir, query) {
  const projectId = safeProjectId(dir);
  const map = await loadProjectMap(projectId); // 文件损坏时在此抛 SyntaxError，直接冒泡给路由（500）
  if (!map) {
    const err = new Error('地图不存在，请先生成');
    err.notFound = true;
    throw err;
  }

  // 最多前 50 个：控制 prompt 体积，超大项目也不至于把 token 预算全烧在清单上
  const modules = (map.modules || []).slice(0, 50);
  const brief = modules
    .map((m) => `- id=${m.id} name=${m.name} path=${m.path} desc=${m.description || '(无描述)'}`)
    .join('\n');
  const prompt = [
    '以下是一个项目的模块清单：',
    brief,
    '',
    `用户的搜索词是：${query}`,
    '',
    '请找出与搜索词最相关的模块（可以不是字面匹配，允许语义相关），按相关性从高到低排列。',
    '只返回 JSON，格式：{"matches":[{"id":"模块id","name":"模块名","score":0到1之间的数字,"reason":"一句话说明为什么相关"}]}',
    '没有相关模块时返回 {"matches":[]}。',
  ].join('\n');

  const result = await runClassifierOnce({
    prompt, model: null, logTag: 'project-map/search-modules', timeoutMs: 30000,
  });
  if (!result || !Array.isArray(result.matches)) {
    logger.warn('project-map', '模块搜索无结果或解析失败', { dir, query });
    return [];
  }
  return [...result.matches].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** 淘汰过期/超量的已完成 job，避免内存无限增长（照搬 optimize-ops.js 的 gc 口径） */
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

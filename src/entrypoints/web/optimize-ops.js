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
import fs from 'node:fs';
import path from 'node:path';
import { sendTo } from '../../store/runs.js';
import { logger } from '../../shared/logger.js';
import { checkPrompts } from '../../features/project-checkup/check-prompts.js';
import { checkComments } from '../../features/project-checkup/check-comments.js';
import { checkTests } from '../../features/project-checkup/check-tests.js';
import { checkHygiene } from '../../features/project-checkup/check-hygiene.js';
import {
  runStaticCheckup, recomputeReport, analyzingDim, LLM_DIM_KEYS,
} from '../../features/project-checkup/index.js';
import { planDemote, demoteOne } from '../../features/project-optimize/fix-rules.js';
import { createBackup, recordPostState, listBackups, restoreBackup } from '../../features/project-optimize/backup.js';
import { checkWorkspace } from '../../features/project-optimize/git-guard.js';
import { selectFixableRules, buildFixNotes } from '../../features/project-optimize/fix-plan.logic.js';
import { checkMap } from '../../features/project-checkup/check-map.js';
import { fixDeadLinks, writeGeneratedMap, writeStaleAudit } from '../../features/project-optimize/fix-map.js';
import { selectFixableMap, planMapFix } from '../../features/project-optimize/fix-map.logic.js';
import { generateRootMap, generateModuleMap } from '../../features/project-optimize/gen-map.js';
import {
  getLlmCache, saveLlmCache, saveCheckup,
  acquireBusy, releaseBusy, saveFixResult, getProjectRecord,
} from '../../store/optimize.js';

/**
 * 异步回填的维度表 —— 编排层的唯一驱动来源（新增维度只需在这里登记）。
 * prompts/comments 走 LLM；tests/hygiene 起子进程（跑测试命令 / git ls-files）。
 * 四者都不能放进同步的 runStaticCheckup：tests 最长可达 120s，会把体检请求整个挂住。
 */
const RUNNERS = {
  prompts: checkPrompts,
  comments: checkComments,
  tests: checkTests,
  hygiene: checkHygiene,
};

const jobs = new Map(); // jobId -> job（体检和优化共用一张表，靠 job.kind 区分）
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

function getJob(id, kind) {
  const job = id ? jobs.get(id) : null;
  return job && job.kind === kind ? job : null;
}

export function getCheckupJob(id) {
  return getJob(id, 'checkup');
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
 * 跑一次体检（带串行闸）。
 *
 * 闸的必要性：同一目录并发体检会把两个 LLM 维度各跑两遍，白烧一倍额度而结果完全相同。
 * 用户开两个标签页、或点完没反应又点一次，都会撞上。
 *
 * 释放时机分两种：LLM 维度全部命中缓存时体检是同步完成的，当场释放；
 * 需要冷跑时交给 finishJob 在 SSE 收尾时释放（job.ownsBusy 标记归属，
 * 免得优化流程内部触发的体检去释放优化自己持有的那把闸）。
 *
 * @returns {Promise<{report:object, checkupId:string|null} | {busy:object}>}
 *   busy 非空表示该项目正被占用（体检或优化），调用方转成 409。
 */

/** 目录必须存在且是目录。错误文案与 runStaticCheckup 保持一致——前端已按它显示 */
function assertValidProjectDir(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error('目录不存在或不可读');
  }
}

export async function startCheckup(dir, { force = false } = {}) {
  // 目录合法性必须先于 acquireBusy：占闸会写 optimize.json，而非法路径最终只返回 400，
  // 垃圾条目却已经落盘。实测残留过一条 key 为 'C:UsersDELLDesktop…'（反斜杠被吞）的项目条目。
  assertValidProjectDir(dir);

  const gate = acquireBusy(dir, 'checkup');
  if (!gate.ok) return { busy: gate.busy };
  try {
    const out = await runCheckup(dir, { force, ownsBusy: true });
    // 没有 checkupId = 没起后台 job，没人会替我们释放
    if (!out.checkupId) releaseBusy(dir);
    return out;
  } catch (e) {
    releaseBusy(dir);
    throw e;
  }
}

/**
 * 体检内核，不含闸。
 *
 * 单独拆出来是因为优化结束后要重跑体检，而那时优化自己正持着闸——
 * 走 startCheckup 会被自己挡在门外。
 *
 * @param {object} opts
 * @param {boolean} [opts.ownsBusy] 起了后台 job 时，是否由该 job 负责释放闸
 */
async function runCheckup(dir, { force = false, ownsBusy = false } = {}) {
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
    kind: 'checkup',
    dir,
    status: 'running',
    ownsBusy,
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
  closeSubs(job);
  if (job.ownsBusy) releaseBusy(job.dir);
}

function closeSubs(job) {
  for (const res of [...job.subs]) {
    try { res.end(); } catch { /* 连接已断，忽略 */ }
  }
  job.subs.clear();
}

// ==================== 一键优化 ====================

/**
 * 地图生成的并发度。
 *
 * 不能更高：describe-skill.js 的 DESCRIBE_TIMEOUT_MS 注释记录了实测数据——同一次跑里
 * 四个调用耗时 34.9s / 35.3s / 91.6s / 127.1s，波动近 4 倍，原因是连续调用赶上限流排队。
 * 并发拉高只会加剧排队，把长尾推得更长，甚至触发更严格的限流。
 * 3 是「明显快于串行」和「不额外招惹限流」之间的折中。
 */
const MAP_CONCURRENCY = 3;

/**
 * 受限并发池：thunks 逐个取、最多 n 个同时在跑，每完成一个立刻回调（用于推 SSE）。
 *
 * 不用 Promise.all 分批：分批的话每批要等最慢的那个（长尾 127s vs 35s），
 * 白白浪费快的那几个的时间。这里是「谁空了谁取下一个」。
 *
 * 单个任务抛错不会掀翻整池——执行层承诺不抛（fix-map.js 开头纪律 2），
 * 这里的 catch 是防御性的，真抛了就当一条失败记下来继续。
 */
async function runPool(thunks, n, onDone, job) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < thunks.length) {
      if (job?.signal?.aborted) return;
      const mine = thunks[cursor++];
      let r;
      try {
        r = await mine();
      } catch (e) {
        r = { file: '(未知)', kind: 'gen-map', status: 'failed', reason: e?.message || String(e) };
      }
      onDone(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, thunks.length) }, worker));
}

export function getFixJob(id) {
  return getJob(id, 'fix');
}

/**
 * 请求停止一次优化。
 *
 * 只发信号、不等它停：正在跑的 LLM 调用会被 abortController 打断，
 * 已经落盘的改动一律保留（备份还在，用户可以还原）。
 * 「停止」不等于「回滚」——把两者绑在一起会让用户在想中止时被迫接受回滚。
 *
 * @returns {boolean} 是否受理（job 不存在或已结束时为 false）
 */
export function cancelFixJob(id) {
  const job = getJob(id, 'fix');
  if (!job || job.status !== 'running') return false;
  job.abort();
  pushEvent(job, 'step', { phase: 'cancelling', text: '正在停止……已完成的改动会保留' });
  return true;
}

/**
 * 订阅优化进度。
 *
 * 与体检的 replay 用同一个理由：POST 返回到前端把 EventSource 建起来之间有个窗口，
 * 期间产生的 step 事件不补就永远丢了。优化的事件序列有先后语义（第几步在做什么），
 * 所以这里存的是**有序事件流**而不是体检那样的「按维度覆盖」。
 */
export function attachFixJob(job, res) {
  sendTo(res, 'replay', { status: job.status, events: job.events, done: job.done });
  if (job.status !== 'running') return res.end();
  job.subs.add(res);
  res.on('close', () => job.subs.delete(res));
}

/** 记进事件流再推送：晚接入的订阅者靠这份记录补齐前面的进度 */
function pushEvent(job, event, data) {
  job.events.push({ event, data });
  job.updatedAt = Date.now();
  emit(job, event, data);
}

/**
 * 发起一次优化。
 *
 * @param {string} dir
 * @param {object} opts
 * @param {string[]} [opts.dimensions] 用户勾选的维度（v1 只有 rules 会被处理）
 * @param {boolean} [opts.force] 跳过脏工作区确认
 * @returns {Promise<{jobId:string, backupPending:true}
 *   | {needsConfirm:true, dirtyCount:number, isRepo:boolean, files:string[]}
 *   | {nothing:true, blocked:Array}
 *   | {busy:object}>}
 */
export async function startFix(dir, { dimensions = [], force = false } = {}) {
  const report = getProjectRecord(dir)?.lastCheckup;
  if (!report) throw new Error('请先跑一次体检，再执行优化');

  // 维度勾选是**筛子**而不是摆设：用户只勾了 map 却把 rules 也改了，
  // 等于在没得到同意的情况下删文件。空数组视为「全都要」——那是老前端的行为，
  // 改成静默不做会让旧页面点了优化后毫无反应
  const want = (d) => !dimensions.length || dimensions.includes(d);
  const rules = want('rules') ? selectFixableRules(report) : { files: [], blocked: [] };
  const map = want('map')
    ? selectFixableMap(report)
    : { rootMap: false, modules: [], stale: [], deadLinks: [], blocked: [] };

  const mapTaskCount = (map.rootMap ? 1 : 0) + map.modules.length + map.stale.length + map.deadLinks.length;
  const blocked = [...rules.blocked, ...map.blocked];
  if (!rules.files.length && !mapTaskCount) return { nothing: true, blocked };

  // job id 先生成再抢闸：生成本身没有副作用，但把它写进占用记录后，
  // 被挡下的那个请求就能拿着 jobId 去接同一条 SSE，而不是只被告知「有人在跑」。
  const jobId = `fix_${Date.now().toString(36)}_${++seq}`;

  // 闸必须抢在 checkWorkspace 之前：那一步要起 git 子进程（几十毫秒起步），
  // 等它期间足够第二个请求把前面的只读检查整个跑完，两边就都进来了。
  const gate = acquireBusy(dir, 'fix', jobId);
  if (!gate.ok) return { busy: gate.busy };

  try {
    const ws = await checkWorkspace(dir);
    if (ws.dirty && !force) {
      // 只是要用户确认，不是失败，闸得先放掉——否则用户点「确认」重发时会被自己挡住
      releaseBusy(dir);
      return { needsConfirm: true, dirtyCount: ws.count, isRepo: ws.isRepo, files: ws.files.slice(0, 20) };
    }

    gc();
    const ac = new AbortController();
    const job = {
      id: jobId,
      kind: 'fix',
      dir,
      status: 'running',
      events: [],
      done: null,
      subs: new Set(),
      // 中断句柄：地图维度是全量生成，10+ 个模块可能跑十几分钟，
      // 没有取消点等于把人锁在进度条前面
      abort: () => ac.abort(),
      signal: ac.signal,
      updatedAt: Date.now(),
    };
    jobs.set(job.id, job);

    // 不 await：立刻把 jobId 还给前端去接 SSE
    runFix(job, {
      rules,
      map,
      blocked,
      dimensions,
      rulesBefore: report.dims?.rules?.score ?? null,
      mapBefore: report.dims?.map?.score ?? null,
    }).catch((e) => {
      logger.warn('optimize', '优化编排异常', { dir, err: e?.message || String(e) });
      finishFixJob(job, { error: e?.message || String(e) });
    });

    return { jobId: job.id };
  } catch (e) {
    releaseBusy(dir);
    throw e;
  }
}

/**
 * 优化主流程：规划 → 快照 → 逐个降级 → 记录优化后状态 → 重算静态分。
 *
 * 顺序不能动：快照必须在任何写操作之前（planDemote 无副作用，专为此设计），
 * recordPostState 必须在全部写完之后（它记的是「优化后的内容哈希」，
 * 还原时靠它区分「用户事后又手工改过」和「优化本身造成的差异」）。
 */
async function runFix(job, { rules, map, blocked, dimensions, rulesBefore, mapBefore }) {
  const dir = job.dir;
  const results = [];
  let backupDir = null;

  try {
    // ---- M1 前置：没有根地图时，报告里 M2/M3/M4 根本不存在 ----
    // check-map.logic.js 的 evaluateMap 在 !hasRootMap 时 early-return，只产出 M1 一条 issue。
    // 所以根地图必须先生成、再重扫，否则一个 map=0 的项目优化完只会多出一份根地图，
    // 用户还得再点一次才能补上模块地图。
    let mapPlan = map;
    if (map.rootMap) {
      pushEvent(job, 'step', { phase: 'gen-map', text: '生成根项目地图（之后会重新扫描以发现模块级问题）' });
      const rootRes = await writeGeneratedMap(dir, 'CLAUDE.md', () => generateRootMap(dir, { signal: job.signal }));
      results.push(rootRes);
      pushEvent(job, 'file', rootRes);

      if (rootRes.status === 'done') {
        // 重扫拿真实的 M2/M3/M4。只有根地图写成功才有意义——失败时重扫结果仍是 M1
        const rescanned = selectFixableMap({ dims: { map: checkMap(dir) } });
        mapPlan = { ...rescanned, rootMap: false };
        pushEvent(job, 'step', {
          phase: 'plan',
          text: `重新扫描：发现 ${rescanned.modules.length} 个缺地图的模块、`
            + `${rescanned.stale.length} 份过期地图、${rescanned.deadLinks.length} 条死链`,
        });
      } else {
        mapPlan = { ...map, rootMap: false };
      }
    }

    const mapEntries = planMapFix(mapPlan);
    const rulePlan = rules.files.length ? planDemote(dir, rules.files) : [];
    pushEvent(job, 'step', {
      phase: 'plan',
      text: `规划 ${rulePlan.length} 个规则文件、${mapEntries.length} 个地图文件的改动`,
    });

    // 根地图那份 created 条目要一并登记：它已经写下去了，还原时必须能把它删掉。
    //
    // 这里有一个已知且可接受的时序窗口：根地图先于 createBackup 落盘。
    // 之所以能接受——created 类条目在 backup.logic.js 里被标 backed:false（不备份内容），
    // 还原动作就是「删掉它」，所以备份时机不影响还原的正确性，只要最终 manifest 里有这条记录。
    // 真正的风险窗口只有「根地图已写、createBackup 还没跑」这两行代码之间的崩溃，
    // 后果也仅仅是盘上多一个 CLAUDE.md 需要手删。
    // 为消除它而把备份拆成两次代价大得多：会产生两个备份目录、还原要按序还两次，
    // 而 backup.js 没有「向已有快照追加条目」的 API。
    const allEntries = [...rulePlan, ...mapEntries];
    if (map.rootMap) allEntries.unshift({ path: 'CLAUDE.md', action: 'created' });

    const backup = createBackup(dir, allEntries, { dimensions });
    backupDir = backup.dirName;
    pushEvent(job, 'step', { phase: 'backup', text: `已快照 ${allEntries.length} 个文件`, backupDir });

    // ---- 死链修复：确定性、最快，先做完 ----
    if (mapPlan.deadLinks.length) {
      pushEvent(job, 'step', { phase: 'dead-link', text: `修复 ${mapPlan.deadLinks.length} 条死链` });
      const dl = fixDeadLinks(dir, mapPlan.deadLinks);
      for (const u of dl.updated) {
        const r = { file: u.file, kind: 'dead-link', status: 'done', reason: `${u.from} → ${u.to}` };
        results.push(r);
        pushEvent(job, 'file', r);
      }
      for (const s of dl.skipped) {
        const r = { file: s.file, kind: 'dead-link', status: 'skipped', reason: `${s.ref}：${s.reason}` };
        results.push(r);
        pushEvent(job, 'file', r);
      }
    }

    // ---- 模块地图与过期核对：独立的单文件 LLM 任务 → 受限并发 ----
    const mapJobs = [
      ...mapPlan.modules.map((mod) => () =>
        writeGeneratedMap(dir, `${mod}/CLAUDE.md`, () => generateModuleMap(dir, mod, { signal: job.signal }))),
      ...mapPlan.stale.map((st) => () =>
        writeStaleAudit(dir, st.file, st.staleDays, { signal: job.signal })),
    ];
    if (mapJobs.length) {
      pushEvent(job, 'step', { phase: 'gen-map', text: `生成/核对 ${mapJobs.length} 份地图（并发 ${MAP_CONCURRENCY}）` });
      await runPool(mapJobs, MAP_CONCURRENCY, (r) => {
        results.push(r);
        pushEvent(job, 'file', r);
      }, job);
    }

    // ---- rules 降级（原有流程，语义一字未动）----
    for (const f of rules.files) {
      if (job.signal?.aborted) break;
      const r = await demoteOne(dir, f, {
        onStep: (s) => pushEvent(job, 'step', { phase: s.step, file: s.file, skillName: s.skillName }),
      });
      results.push(r);
      pushEvent(job, 'file', r);
      if (r.fatal) {
        // 核心失败：文件系统处于半完成状态，继续处理只会越错越多
        pushEvent(job, 'step', {
          phase: 'abort',
          text: `${r.file} 失败且改动已写到一半，已停止处理剩余规则文件`,
        });
        break;
      }
    }

    if (job.signal?.aborted) {
      pushEvent(job, 'step', { phase: 'abort', text: '已按你的要求停止；已完成的改动保留，可用「还原」撤销' });
    }

    // 中途 abort 也要记：记的是**实际落盘的状态**，部分完成的状态一样能当还原基准。
    // 记不上不会坏事，只是还原退化成无条件覆盖，所以失败仅告警不中断。
    try {
      recordPostState(dir, backupDir);
    } catch (e) {
      logger.warn('optimize', 'recordPostState 失败，还原将退化为无条件覆盖', { dir, err: e?.message || String(e) });
    }

    const report = refreshStaticReport(dir);
    const notes = buildFixNotes({ requested: dimensions, results, rootClaudeMd: readRootClaudeMd(dir) });

    const summary = {
      results,
      blocked,
      notes,
      backupDir,
      cancelled: !!job.signal?.aborted,
      rules: { before: rulesBefore, after: report.dims?.rules?.score ?? null },
      map: { before: mapBefore, after: report.dims?.map?.score ?? null },
      report,
    };
    saveFixResult(dir, {
      at: new Date().toISOString(),
      backupDir,
      dimensions,
      results,
      notes,
      rules: summary.rules,
      map: summary.map,
    });
    finishFixJob(job, summary);
  } catch (e) {
    // 已经动过盘就不能装作没发生：把已有结果和备份目录一起交出去，用户才知道能还原
    logger.warn('optimize', '优化执行失败', { dir, err: e?.message || String(e) });
    finishFixJob(job, { error: e?.message || String(e), results, backupDir });
  }
}

/**
 * 改过盘之后刷新体检报告（优化和还原都用）。
 *
 * 只重算静态维度，**不自动重跑 LLM 维度**：那要好几分钟、约 $0.9，而用户此刻只想看降级结果。
 * 但也不能把上一轮的 LLM 结论原样留着——那些 issue 指向的文件可能已经被移走了，
 * 展示出来就是在报不存在的问题。所以标成待分析，由用户自己决定要不要点「重新体检」。
 * 指纹缓存不受影响：注释维度的源码没动，重新体检时会直接命中缓存，不会重复计费。
 */
function refreshStaticReport(dir) {
  const report = runStaticCheckup(dir);
  for (const key of LLM_DIM_KEYS) {
    if (report.dims[key]) report.dims[key].reason = '规则已变动，请重新体检以刷新 AI 分析';
  }
  recomputeReport(report);
  saveCheckup(dir, report);
  return report;
}

/** 根 CLAUDE.md 内容，供 buildFixNotes 检查索引表残留；读不到返回 null（不是错误） */
function readRootClaudeMd(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 还原一次优化。
 *
 * **必须走串行闸**：优化跑到一半时还原，两边会交错写同一批文件——
 * 还原把文件写回旧版，紧接着降级又把它删掉，最终状态既不是优化后也不是优化前。
 * 这比「不让还原」糟糕得多，所以宁可回 409 让用户等。
 *
 * @returns {{restored:number, skipped:Array, overwritten:string[], report:object} | {busy:object}}
 */
export function runRollback(dir, dirName) {
  // dirName 来自请求体，会拼进 path.join —— 不校验就是任意路径读写：
  // 只要目标位置恰好有个 manifest.json，还原动作就会照着它往仓库外写文件。
  // 用「必须是本项目已有的快照之一」来卡，比过滤 ../ 之类的黑名单可靠。
  const known = listBackups(dir).some((b) => b.dirName === dirName);
  if (!known) throw new Error('备份不存在');

  const gate = acquireBusy(dir, 'rollback');
  if (!gate.ok) return { busy: gate.busy };
  try {
    const out = restoreBackup(dir, dirName);
    return { ...out, report: refreshStaticReport(dir) };
  } finally {
    releaseBusy(dir);
  }
}

function finishFixJob(job, done) {
  if (job.status !== 'running') return;
  job.status = 'done';
  job.done = done;
  job.updatedAt = Date.now();
  emit(job, 'done', done);
  closeSubs(job);
  // 闸一定要放：漏放的话这个项目要等一小时才解锁（见 store/optimize.js 的 BUSY_STALE_MS）
  releaseBusy(job.dir);
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

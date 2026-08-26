/**
 * 需求工作流编排 —— docgen / 系统任务串行闸 / 崩溃恢复（bitable 巡检在后续任务追加）。
 * 串行闸（spec §5.3）：内存队列单泵（仅 claude-web 进程），出队条件 = busy 空 且 conv 无活跃 run；
 * busy 落盘镜像供崩溃恢复：启动时清残留并记 history，不自动重跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getRequirement, getRequirements, updateRequirement, canTransition } from '../../store/requirements.js';
import { hasActiveRunForConv, createRun, getRun } from '../../store/runs.js';
import { getPending } from '../../store/pending-resume.js';
import { startClaudeRun } from './run-claude.js';
import { runClaude } from '../../integrations/claude.js';
import { claudeAuthOpts } from '../../features/token-rotation.js';
import { runScript } from '../../integrations/shell.js';
import { appDataPath } from '../../shared/app-paths.js';
import { logger } from '../../shared/logger.js';
import { sendTextToUser } from '../../integrations/lark.js';
import { getMyFeishuOpenId, getBots } from '../../store/settings.js';
import { currentBranch, ensureBranch, isClean } from '../../plugins/team-tools/auto-dev/git.js';
import {
  pickCwdAndDirs,
  buildDocgenPrompt,
  buildRevisePrompt,
  extractSummary,
  nextDocVersion,
  buildDevelopPrompt,
  buildApiFixPrompt,
  buildBugFixPrompt,
  reqBranchName,
  buildArchiveSummary,
  parseFeatureTag,
} from './req-logic.js';
import { listFeatureTags, harvestFiles } from '../../store/feature-index.js';
import {
  parseJsonLoose,
  normalizeMap,
  nextMapVersion,
  buildMapgenPrompt,
  buildMapFixPrompt,
  buildMapChangePrompt,
  buildImpactPrompt,
  parseImpact,
  markFreshPoints,
} from './req-map.logic.js';
import { buildQuizPrompt, parseQuiz, answersToPromptPart } from './req-quiz.logic.js';

export const DOCGEN_TIMEOUT_MS = 15 * 60_000; // spec §5.3：docgen race 上限

// ============================================================
// docgen 生成状态管理：去超时 + 用户停止 + 实时日志
// ============================================================
// （纯内存结构，服务重启时自动清空，无需持久化；生成期异常退出由启动时 busy 恢复逻辑处理）

/** 活跃生成的 AbortController 映射：key=reqId, value=AbortController
 *  runDocgen 起始时写入，完成/失败/用户停止时删除 */
export const docgenAborts = new Map();

/** 用户主动停止的集合：标记该 reqId 的生成是由用户触发 abort() 的
 *  POST /api/req/docgen/stop 时添加，cleanup 时删除 */
export const userStoppedSet = new Set();

/** 实时日志缓存：key=reqId, value=最后一行文本（≤200 字）
 *  onText 回调时更新，GET /api/req/get 返回给前端，生成完成后删除 */
export const docgenLiveLine = new Map();

const POLL_MS = 5000;

/** docgen 前置条件缺失时的引导文案：runDocgen 内部守卫与 routes-requirements.js 的路由层预检共用同一句 */
export const DOCGEN_GUIDE = '生成开发文档需要至少配置一个工程目录，并先录入需求文档';

/** 需求私有目录/文件路径（惰性建目录）；rest 末段视为文件名，无 rest 时返回目录本身。 */
export function reqDir(id, ...rest) {
  const dir = appDataPath('requirements', id, ...rest.slice(0, -1));
  fs.mkdirSync(dir, { recursive: true });
  return rest.length ? path.join(dir, rest[rest.length - 1]) : dir;
}

/** 出队条件（纯函数，测试注入 hasActive）：无 req 或 busy 中 → 拒绝；有 conv 且该 conv 有活跃 run → 拒绝（用户对话中）。 */
export function canDispatch(req, hasActive = hasActiveRunForConv) {
  if (!req || req.busy) return false;
  return !(req.convId && hasActive(req.convId));
}

/**
 * 纯函数（测试注入 getRunStatus/hasPendingResume）：判定某需求当前的 busy 是否已「泄漏」——
 * 对应的 run 已不在跑（不存在或非 running）且没有待续跑登记，说明不是额度阻塞期间的正常等待，
 * 大概率是 run 经额度耗尽自动续跑链路（doResume 生成的新 run 未重新挂 onSettle）收尾时没能回调到，
 * busy 从此再也没人清。docgen 的 busy 没有 runId（其失败路径已在进程内自行清理，
 * 崩溃由 recoverBusyOnBoot 兜底），不参与本判定。
 */
export function isBusyStale({ busy, convId }, { getRunStatus, hasPendingResume }) {
  if (!busy?.runId) return false;
  if (getRunStatus(busy.runId) === 'running') return false;
  return !hasPendingResume(convId);
}

function defaultGetRunStatus(runId) {
  const run = getRun(runId);
  return run ? run.status : null;
}

/** 该 conv 是否存在未终结的待续跑登记（额度阻塞正常等待中） */
function defaultHasPendingResume(convId) {
  if (!convId) return false;
  return getPending().some((e) => e.convId === convId && e.status !== 'done' && e.status !== 'abandoned');
}

/**
 * 扫描全部需求，自愈已泄漏的 busy（不影响正常额度阻塞等待中的需求）。导出供测试
 * （用真实 getRun/getPending 当默认依赖：不存在的 runId 天然判定为「不在跑」，无需 mock）。
 * bug-fix 泄漏时顺带把该需求 status==='fixing' 的 bug 全部退回 'failed'——run 都没了，
 * 那条 bug 不可能被继续修，让它继续挂在 'fixing' 会导致前端一直转圈、也没法重试。
 */
export function healStaleBusy() {
  for (const r of getRequirements()) {
    if (!r.busy?.runId) continue;
    if (!isBusyStale(r, { getRunStatus: defaultGetRunStatus, hasPendingResume: defaultHasPendingResume })) continue;
    logger.warn('req-ops', 'stale busy 自愈', { reqId: r.id, kind: r.busy.kind, runId: r.busy.runId });
    updateRequirement(r.id, { busy: null }, `任务 ${r.busy.kind} 的运行已结束但未回调，自动清理（续跑链泄漏自愈）`);
    if (r.busy.kind === 'bug-fix' && r.bugs.some((b) => b.status === 'fixing')) {
      updateRequirement(
        r.id,
        { bugs: r.bugs.map((b) => (b.status === 'fixing' ? { ...b, status: 'failed' } : b)) },
        '续跑链中断，BUG 置失败可重试',
      );
    }
  }
}

// —— 系统任务队列（develop / api-fix / bug-fix / docgen）：内存队列，仅 web 进程单泵消费 ——
const queue = []; // [{ reqId, kind, payload }]

/** 去重判别键：区分同一 kind 下指向不同对象的任务（不同 API 文档 / 不同 BUG / 不同变动），避免误合并成一条丢工作项 */
function taskDiscriminator(payload) {
  return payload?.bug?.id || payload?.doc?.id || payload?.changeId || '';
}

/**
 * 合并 docgen 待排队的补充说明：把「即将被移除的旧排队任务已携带的 supplements」与
 * 「本次新提交的一条 supplement」拼成新数组——用于队列合并同 reqId 连续多条 docgen 时不丢正文
 * （旧 payload 可能是首次排队的单条 {supplement}，也可能是上一轮已合并过的 {supplements} 多条）。
 */
export function combineSupplements(oldPayload, newSupplement) {
  const prior = oldPayload?.supplements || (oldPayload?.supplement ? [oldPayload.supplement] : []);
  return newSupplement ? [...prior, newSupplement] : prior;
}

/**
 * 系统任务入队：同 reqId+kind（+ 同一 API 文档/BUG）已在队列则 **last-writer-wins**——
 * 用新 payload 原地替换排队中那条的 payload（队列位置不变），而不是跳过或重复堆积。
 * 典型场景：用户对同一篇 API 文档连续点了两次「更新」，第二次的 doc 内容才是最新的，
 * 若简单跳过会让派发时执行的还是第一次点击时的旧文档快照。
 * docgen 例外：不做「同键替换」，而是合并——同 reqId 连续多条 docgen 只保留最后一条，
 * 但正文用 combineSupplements 累积进 payload.supplements（用户连续提交多次补充说明时，
 * 每一条都要喂给 AI，不能因为合并只剩最后一条排队任务就丢了前面几条的正文）。
 */
export function enqueueSystemTask(reqId, kind, payload = {}) {
  if (kind === 'docgen') {
    let priorPayload = null;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].reqId === reqId && queue[i].kind === 'docgen') {
        if (!priorPayload) priorPayload = queue[i].payload; // 队列从后往前找，先碰到的是最新排队的那条
        queue.splice(i, 1);
      }
    }
    const merged = combineSupplements(priorPayload, payload.supplement);
    payload = merged.length ? { ...payload, supplements: merged } : payload;
  } else {
    const idx = queue.findIndex(
      (t) => t.reqId === reqId && t.kind === kind && taskDiscriminator(t.payload) === taskDiscriminator(payload),
    );
    if (idx >= 0) {
      queue[idx] = { reqId, kind, payload };
      logger.info('req-ops', '替换排队中的同类任务', { reqId, kind });
      return;
    }
  }
  queue.push({ reqId, kind, payload });
  logger.info('req-ops', '系统任务入队', { reqId, kind, queueLen: queue.length });
}

/** 该需求当前排队中的系统任务只读浅拷贝（供测试与 finalize 定稿前置检查复用；不暴露队列本体，防止被误改） */
export function queuedTasks(reqId) {
  return queue.filter((t) => t.reqId === reqId).map((t) => ({ kind: t.kind, payload: t.payload }));
}

/** 该需求是否还有待派发（尚未出队）的系统任务 */
export function hasQueuedTasks(reqId) {
  return queuedTasks(reqId).length > 0;
}

let pumpStarted = false; // 双泵防呆：一体化入口可能被误调用两次（如根 server.js + sidecar 各起一次）

/** 仅 claude-web 进程调用：启动恢复 + 轮询泵（定时器 unref，避免拖住测试进程退出）。重复调用是安全的空操作。 */
export function startRequirementPump() {
  if (pumpStarted) return;
  pumpStarted = true;
  recoverBusyOnBoot();
  const timer = setInterval(pump, POLL_MS);
  timer.unref();
}

/** 崩溃恢复：busy 残留 = 上个进程死在任务中途 → 清标记记档，不自动重跑（用户可从面板重新触发） */
function recoverBusyOnBoot() {
  for (const r of getRequirements()) {
    if (r.busy) updateRequirement(r.id, { busy: null }, `任务 ${r.busy.kind} 因进程重启中断`);
  }
}

/**
 * 每 tick 只出队一个可派发任务；docgen/系统任务的 dispatch 本身启动即返回，不阻塞下一 tick。
 * 全函数体裹 try/catch：healStaleBusy/getRequirement 走的是同步读盘（Windows 上可能因杀毒/
 * 索引服务占用而 EBUSY 抛错），这里是 setInterval 回调，异常逃逸会变成 uncaughtException 打死进程。
 */
function pump() {
  try {
    healStaleBusy(); // 先自愈泄漏的 busy，再决定本 tick 能派发哪个任务
    if (!queue.length) return;
    const i = queue.findIndex((t) => canDispatch(getRequirement(t.reqId)));
    if (i < 0) return;
    const task = queue.splice(i, 1)[0];
    try {
      dispatch(task);
    } catch (e) {
      logger.error('req-ops', '系统任务派发异常', { reqId: task.reqId, kind: task.kind, err: e?.message || String(e) });
    }
  } catch (e) {
    logger.error('req-ops', '泵异常（本轮跳过）', { err: e?.message || String(e) });
  }
}

/** 导出供测试：验证「需求已离开评审期」时排队中的 docgen 被作废而非误推进版本 */
export function dispatch({ reqId, kind, payload }) {
  const req = getRequirement(reqId);
  if (!req) return;
  if (kind === 'docgen') {
    // 双保险第二道：finalize 入口已挡过「队列有待派发任务」，但仍存在极窄窗口——
    // docgen 在 finalize 检查队列之后、phase 真正落盘之前被派发。此处兜底：一旦需求已不在
    // 评审期，作废该 docgen，不再推进开发文档版本（避免版本号在开发期继续跳）。
    if (req.phase !== 'review') {
      try {
        updateRequirement(reqId, {}, 'docgen 作废：需求已离开评审期');
      } catch (e) {
        logger.error('req-ops', 'updateRequirement 失败', { reqId, kind, err: e?.message || String(e) });
      }
      return;
    }
    // fire-and-forget：runDocgen 内部在第一个 await 之前同步写 busy，防止下个 tick 重复出队
    runDocgen(req, payload).catch((e) =>
      logger.error('req-ops', 'docgen 任务异常（history 已记录失败原因）', { reqId, err: e?.message || String(e) }),
    );
    return;
  }
  // 需求 v2 的三类只读任务（问卷 / 地图生成 / 地图修订）：与 docgen 同形态——直连 runClaude、
  // 不占 conv、只在评审期有意义。mapchange 例外，它由开发期的「需求变动」驱动，见下。
  if (kind === 'quizgen' || kind === 'mapgen' || kind === 'mapfix') {
    if (req.phase !== 'review') {
      try {
        updateRequirement(reqId, {}, `${kind} 作废：需求已离开评审期`);
      } catch (e) {
        logger.error('req-ops', 'updateRequirement 失败', { reqId, kind, err: e?.message || String(e) });
      }
      return;
    }
    const runner = { quizgen: runQuizGen, mapgen: runMapGen, mapfix: runMapFix }[kind];
    runner(req, payload).catch((e) =>
      logger.error('req-ops', `${kind} 任务异常（history 已记录失败原因）`, { reqId, err: e?.message || String(e) }),
    );
    return;
  }
  // 需求变动改地图：评审期之后才有意义（评审期直接改需求文档/补充说明即可）
  if (kind === 'mapchange') {
    if (req.phase !== 'dev' && req.phase !== 'test') {
      try {
        updateRequirement(reqId, {}, 'mapchange 作废：需求已离开开发/测试期');
      } catch (e) {
        logger.error('req-ops', 'updateRequirement 失败', { reqId, kind, err: e?.message || String(e) });
      }
      return;
    }
    runMapChange(req, payload).catch((e) =>
      logger.error('req-ops', 'mapchange 任务异常（history 已记录失败原因）', { reqId, err: e?.message || String(e) }),
    );
    return;
  }
  // develop/api-fix 已改为客户端会话驱动（sendMessageProgrammatically），
  // 不再经服务端系统任务队列。万一因旧版本残留数据入队，直接废弃不派发。
  if (kind === 'develop' || kind === 'api-fix') {
    try {
      updateRequirement(reqId, {}, `系统任务 ${kind} 废弃：已改为客户端会话驱动`);
    } catch (e) {
      logger.error('req-ops', 'updateRequirement 失败', { reqId, kind, err: e?.message || String(e) });
    }
    return;
  }
  // phase 守卫（bug-fix 仅在开发/测试期执行；其他 phase 包括 undefined 都拒绝）
  if (req.phase !== 'dev' && req.phase !== 'test') {
    try {
      updateRequirement(reqId, {}, `系统任务 ${kind} 作废：需求已离开开发/测试期`);
    } catch (e) {
      logger.error('req-ops', 'updateRequirement 失败', { reqId, kind, err: e?.message || String(e) });
    }
    return;
  }
  dispatchSystemTask(req, kind, payload);
}

/**
 * 构造系统任务的 run 收尾回调（导出供测试）。
 * 归属校验：healStaleBusy 或另一条迟到的 onSettle 都可能先一步清过 busy 并派发了下一个任务——
 * 例如看门狗/stopRun 先把 run 置终态，settleRun 的回调迟迟才轮到；这期间 healStaleBusy 已判定
 * 泄漏并清了 busy，队列泵又派发了同需求的下一个任务写入了新 busy。此时这条回调若无脑清 busy，
 * 会把新任务的 busy 一并清掉，击穿串行闸。因此清 busy 前必须确认「当前 busy.runId 仍是本次收尾
 * 的这个 run」，不是则说明 busy 早已不是本回调该管的那份，什么都不做。
 * bug 状态与 devSession 回填不受此校验影响——它们是「这次任务本身跑没跑成功」的记录，
 * 与「busy 该不该被清」是两件事，照常执行。
 */
export function buildSystemTaskOnSettle(req, kind, payload) {
  return (ok, settledRun) => {
    const fresh = getRequirement(req.id);
    if (fresh?.busy?.runId === settledRun?.id) {
      updateRequirement(req.id, { busy: null }, `系统任务 ${kind} ${ok ? '完成' : '失败'}`);
    }
    if (kind === 'bug-fix') setBugStatus(req.id, payload.bug.id, ok ? 'fixed' : 'failed');
    if (settledRun?.session_id && fresh && !fresh.devSession) {
      updateRequirement(req.id, { devSession: settledRun.session_id }); // 首次系统任务的 session 回填开发会话锚点
    }
  };
}

/** bug-fix：走 startClaudeRun（conv 流可见），启动即返回，收尾由 onSettle 回调清 busy */
function dispatchSystemTask(req, kind, payload) {
  // 防御性校验：仅处理 bug-fix（develop/api-fix 应在 dispatch 中被拦截）
  if (kind !== 'bug-fix') {
    updateRequirement(req.id, {}, `系统任务 ${kind} 不支持此派发路径`);
    return;
  }
  const { cwd, addDirs } = pickCwdAndDirs(req.projects);
  if (!cwd) {
    // 防御：正常流程（定稿守卫）已保证有开发工程，这里只兜底避免任务卡死在队列里
    updateRequirement(req.id, {}, `系统任务 ${kind} 作废：无可用工程目录`);
    return;
  }
  const prompt = buildBugFixPrompt(payload);
  const run = createRun();
  updateRequirement(req.id, { busy: { kind, runId: run.id, startedAt: Date.now() } }, `系统任务 ${kind} 启动`);
  if (kind === 'bug-fix') setBugStatus(req.id, payload.bug.id, 'fixing');
  run.onSettle = buildSystemTaskOnSettle(req, kind, payload); // run-claude.js 的 settleRun 在 run 真正终结时回调
  startClaudeRun(run, {
    prompt,
    cwd,
    addDirs,
    session: req.devSession || undefined,
    mode: 'bypassPermissions',
    convId: req.convId || undefined,
  });
}

/** 锁内替换单条 bug 状态（bug-fix 任务生命周期用；后续任务的确认/忽略/重试复用） */
export function setBugStatus(reqId, bugId, status) {
  const req = getRequirement(reqId);
  if (!req) return;
  updateRequirement(reqId, { bugs: req.bugs.map((b) => (b.id === bugId ? { ...b, status } : b)) });
}

/**
 * 把多条待合成的补充说明拼成 buildRevisePrompt 需要的单条 {text, files}（导出供测试）：
 * text 编号拼接「1. …\n2. …」，files 按 path 去重取并集（同一附件在多条补充里重复出现时不重复列出）。
 */
export function composeSupplementsForRevise(supplements) {
  const text = supplements.map((s, i) => `${i + 1}. ${s.text}`).join('\n');
  const seen = new Set();
  const files = [];
  for (const s of supplements) {
    for (const f of s.files || []) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      files.push(f);
    }
  }
  return { text, files };
}

/**
 * 两个 promise 赛跑：timeoutPromise 先落定则返回 true（超时），否则返回 false（导出供测试）。
 * 用 Symbol 哨兵而非「undefined/超时都长得一样」去判断胜负，避免 callPromise 本身也 resolve
 * 出 undefined 时被误判为超时。抽成纯函数是为了不必等真实 15 分钟：测试注入受控 promise
 * （如 `new Promise(() => {})` 永不 resolve 模拟仍在跑、`Promise.resolve()` 模拟已到点）即可覆盖两条分支。
 */
export async function raceWithTimeoutFlag(callPromise, timeoutPromise) {
  const TIMED_OUT = Symbol('req-ops-docgen-race-timed-out');
  const raced = await Promise.race([callPromise, timeoutPromise.then(() => TIMED_OUT)]);
  return raced === TIMED_OUT;
}

/**
 * 评审期开发文档生成/修订。**只应经队列派发**（`enqueueSystemTask(id,'docgen',...)` → 泵 → `dispatch`），
 * 路由层不得直接调用——busy 占用与串行闸的判定职责在 `canDispatch`/队列这一层，直调会绕过它，
 * 多次直调可能并发写同一份 dev-doc 版本号。守卫：至少一个工程目录 + 需求文档已录入，否则 throw
 * （业务错误；调用方——即队列 dispatch 的 fire-and-forget catch——负责落日志，本函数自己也记一条 history）。
 *
 * 补充说明来源契约（Task 6 路由接线必读）：首版走 `buildDocgenPrompt` 时读的是**落盘的**
 * `req.supplements`（store 里的全量历史），修订走 `buildRevisePrompt` 时读的是**入队时传入的**
 * `payload.supplements`（本轮排队合并的增量）。路由层提交补充说明时必须先
 * `updateRequirement(id, { supplements: [...] })` 落盘、再 `enqueueSystemTask(id,'docgen',{supplement})`——
 * 顺序反了的话，若这条补充恰好触发的是「首版」路径（比如 docSession 缺失退化重新生成），
 * `req.supplements` 里会读不到刚提交的这一条，白白丢正文。
 */
export async function runDocgen(req, payload = {}) {
  const { cwd, addDirs } = pickCwdAndDirs(req?.projects);
  if (!cwd || !req?.reqDoc) {
    if (req) updateRequirement(req.id, {}, `开发文档生成被拒：${DOCGEN_GUIDE}`); // 不写 busy，只留痕给前端看见
    throw new Error(DOCGEN_GUIDE);
  }
  const t0 = Date.now();
  let capturedTokens = { inputTokens: 0, outputTokens: 0 };
  // 同步写 busy（在第一个 await 之前）：队列 fire-and-forget 派发后，下个 tick 立刻能看见 busy 已占用
  updateRequirement(req.id, { busy: { kind: 'docgen', startedAt: Date.now() } }, '开始生成开发文档');
  try {
    // 队列合并多条补充说明后 payload.supplements 是数组；单条直传（或历史遗留）时 payload.supplement 是单个对象
    const supplements = payload.supplements?.length ? payload.supplements : payload.supplement ? [payload.supplement] : [];
    // 修订但 docSession 缺失（如上一版异常未捕获到 session）时退化为全量重新生成，属自愈路径
    const canRevise = !!(supplements.length && req.docSession);
    const existingTags = listFeatureTags();
    const prompt = canRevise
      ? buildRevisePrompt({
          supplement: composeSupplementsForRevise(supplements),
          existingTags,
          currentTag: req.featureTag ?? null,
        })
      : buildDocgenPrompt({
          reqDocText: fs.readFileSync(req.reqDoc.path, 'utf8'),
          prime: req.prime ?? null,
          supplements: req.supplements,
          projects: req.projects,
          existingTags,
          quizPart: answersToPromptPart(req.quiz),
        });
    // 关键节点日志：docgen 真正起跑（模式/工程目录/参考目录/prompt 规模）——排查「一直生成中」时
    // 先看这条是否出现、随后 claude.js 的 ▶runClaude / init / result 三条是否跟上、耗时多少。
    logger.info('req-ops', 'docgen 开始', {
      reqId: req.id,
      mode: canRevise ? 'revise' : 'full',
      cwd,
      addDirs,
      supplements: supplements.length,
      promptChars: prompt.length,
    });

    let capturedSession = null;
    let resultText = '';
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), DOCGEN_TIMEOUT_MS);
    let raceTimer;
    try {
      const call = runClaude(prompt, {
        ...claudeAuthOpts(),
        cwd,
        ...(addDirs.length ? { additionalDirectories: addDirs } : {}),
        // dontAsk：文档生成只需读代码，未列出的工具直接拒绝。
        // allowedTools 单用只是免确认，挡不住 Write/Edit/Bash（见 team-tools/review/index.js 注释）。
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Grep', 'Glob'],
        ...(canRevise ? { resume: req.docSession } : {}),
        abortController: abort,
        onInit: (i) => {
          capturedSession = i.session_id;
        },
        onText: (t) => {
          resultText += t;
        },
        onResult: (info) => {
          if (!resultText && info.result) resultText = info.result;
          // 捕获 token 数和成本（来自 claude.js 的 onResult 回调）
          if (info.inputTokens) capturedTokens.inputTokens = info.inputTokens;
          if (info.outputTokens) capturedTokens.outputTokens = info.outputTokens;
        },
      });
      // abort 走 SDK 优雅关闭，可能迟迟不结束 → race 兜底到点不管流死活直接往下走；
      // race 放弃后该 promise 仍可能 reject，预挂 catch 防 unhandled（对齐 llm-classify 的手法）
      call.catch((e) => logger.warn('req-ops', 'docgen 调用异常（已落兜底）', { reqId: req.id, err: e?.message || String(e) }));
      const timeoutPromise = new Promise((resolve) => {
        raceTimer = setTimeout(resolve, DOCGEN_TIMEOUT_MS + 2_000);
      });
      // 兜底分支（race 挂死）不得落版：call 迟迟不 settle（SDK 优雅关闭卡住）时，raceWithTimeoutFlag
      // 返回 true，即便此刻 resultText 已经攒够了 ≥50 字也必须判失败——那只是 abort 前收到的部分内容，
      // 底层调用其实还没真正结束（甚至可能仍在继续写 resultText，构造版本落盘存在竞态）。
      if (await raceWithTimeoutFlag(call, timeoutPromise)) {
        throw new Error('生成超时（流未结束），版本未推进');
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(raceTimer); // 兜底 race 计时器也要清，否则 call 提前完成时它仍会挂到 15min+2s 后才触发
    }

    if (!resultText || resultText.trim().length < 50) {
      throw new Error('输出为空或内容过短（可能超时或调用失败），判定生成失败');
    }

    const elapsed = Date.now() - t0;
    const v = nextDocVersion(req.devDoc);
    const docPath = reqDir(req.id, `dev-doc-v${v}.md`);
    fs.writeFileSync(docPath, resultText, 'utf8');
    const versions = [
      ...(req.devDoc?.versions || []),
      {
        v,
        path: docPath,
        summary: extractSummary(resultText),
        at: new Date().toISOString(),
        ms: elapsed,                               // 耗时毫秒
        inputTokens: capturedTokens.inputTokens,
        outputTokens: capturedTokens.outputTokens,
      },
    ];
    const featureTag = parseFeatureTag(resultText);
    const updatePayload = {
      devDoc: { versions },
      docSession: capturedSession || req.docSession,
      busy: null,
      ...(featureTag ? { featureTag } : {}), // 仅解析到标签时才写入，不覆盖用户手动设置
    };
    const eventMsg = `开发文档 v${v} 生成完成${featureTag ? `（功能模块：${featureTag}）` : ''}`;
    updateRequirement(req.id, updatePayload, eventMsg);
    logger.info('req-ops', 'docgen 生成完成', { reqId: req.id, v, ms: elapsed, featureTag: featureTag || '无' });
    // 双报告（spec §3.4）：文档一落版就续跑地图。resume 同一 docSession，既省 token
    // 又保证两份报告同源；地图失败不回滚文档（各自独立留痕）。
    enqueueSystemTask(req.id, 'mapgen', {});
    // 异步发送通知（不阻塞主流程）
    sendDocgenNotify(req, elapsed, capturedTokens.inputTokens, capturedTokens.outputTokens).catch((e) =>
      logger.warn('req-ops', 'docgen 通知异常（已捕获，不影响主流程）', { reqId: req.id, err: e?.message || String(e) }),
    );
  } catch (e) {
    const reason = (e?.message || String(e)).slice(0, 200);
    updateRequirement(req.id, { busy: null }, `开发文档生成失败：${reason}`);
    logger.error('req-ops', 'docgen 失败', { reqId: req.id, ms: Date.now() - t0, reason });
    throw e;
  }
}

/**
 * docgen 完成后的通知逻辑：异步 fire-and-forget，不阻塞主流程。
 */
async function sendDocgenNotify(reqSnapshot, ms, inputTokens, outputTokens) {
  // 现取最新记录，不能用 docgen 起跑时的 req 快照：评审期首版文档正在生成（可长达 15min）时，
  // 用户往往这会儿才勾选「机器人通知」并保存 notifyBotId；直接读旧快照会看到 notifyBotId=null
  // → 静默跳过，正是「勾了却收不到通知」的根因。落库到读取之间用最新盘上值兜住这段时间差。
  const req = getRequirement(reqSnapshot.id) || reqSnapshot;
  const myOpenId = getMyFeishuOpenId();
  if (!myOpenId) {
    logger.info('req-ops', 'docgen 通知：用户未配置 myFeishuOpenId，跳过', { reqId: req.id });
    return;
  }
  if (!req.notifyBotId) {
    return; // 不配置则静默不通知
  }
  try {
    const bots = getBots();
    const bot = bots.find((b) => b.id === req.notifyBotId);
    if (!bot || !bot.appId || !bot.appSecret) {
      logger.warn('req-ops', 'docgen 通知：机器人不存在或凭证不完整', { reqId: req.id, botId: req.notifyBotId });
      return;
    }
    // 格式化耗时和 token 数
    const timeStr = formatDuration(ms);
    const inputKStr = (inputTokens / 1000).toFixed(1);
    const outputKStr = (outputTokens / 1000).toFixed(1);
    const text = `需求「${req.title}」，开发文档已生成\n耗时：${timeStr}\nToken 消耗：输入 ${inputKStr}k · 输出 ${outputKStr}k`;

    // 发送通知（异步 fire-and-forget）
    sendTextToUser({ appId: bot.appId, appSecret: bot.appSecret }, myOpenId, text).catch((e) =>
      logger.warn('req-ops', 'docgen 通知发送异常', { reqId: req.id, err: e?.message || String(e) }),
    );
  } catch (e) {
    logger.warn('req-ops', 'docgen 通知准备失败', { reqId: req.id, err: e?.message || String(e) });
  }
}

/**
 * 格式化耗时为人类可读的字符串（毫秒 → "2m 35s"）
 */
function formatDuration(ms) {
  const totalSecs = Math.round(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

// —— 定稿（评审期 → 开发期）——

const finalizing = new Set(); // 双击护栏：同一需求的 finalize 并发调用时挡住后来者（模块级，仅本进程内存，不落盘）

/** 定稿守卫（纯函数）：评审期 + 无任务进行中 + 有开发文档 + ≥1 开发工程 */
export function finalizeGuard(req) {
  if (!req || req.phase !== 'review') return { ok: false, error: '仅评审设计期可定稿' };
  if (req.busy) return { ok: false, error: '有任务正在进行（如文档生成），请稍候再定稿' };
  if (!req.devDoc?.versions?.length) return { ok: false, error: '请先生成开发文档' };
  const devProjects = [req.projects?.frontend, req.projects?.backend].filter((p) => p?.dir && p.dev);
  if (!devProjects.length) return { ok: false, error: '至少需要一个「开发工程」' };
  return { ok: true, devProjects };
}

/**
 * 决定某开发工程本轮定稿应使用的 baseBranch（纯函数，供 finalizeRequirement 复用/单测）。
 * 优先复用该工程此前定稿留下的历史记录（重试场景）：一旦重试，工作区当前分支可能已经是
 * 需求分支本身，此时再读 currentBranch 只会把「需求分支」自己错记成 baseBranch，导致归档阶段
 * `git log base..branch` 算出空提交、摘要静默丢失。无历史记录时才看 currentBranch；若它恰好
 * 就是需求分支，说明工作区已就绪，直接以 reqBranch 自身作为 baseBranch（归档摘要为空，可接受）。
 * @returns {{ baseBranch: string } | { error: 'not-git' }}
 */
export function resolveBaseBranch({ prevRecord, currentBranch, reqBranch }) {
  if (prevRecord) return { baseBranch: prevRecord.baseBranch };
  if (!currentBranch || currentBranch === 'HEAD') return { error: 'not-git' };
  if (currentBranch === reqBranch) return { baseBranch: reqBranch }; // 已在目标分支，直接复用
  return { baseBranch: currentBranch };
}

/**
 * 定稿：脏区检查（force 可越）→ 逐开发工程建/切需求分支 → phase=dev → 自动首轮开发入队。
 * 多工程共用同一 branch 字符串（前后端各自仓库里建同名分支）。
 *
 * 双保险第一道：guard 通过后还要查队列（hasQueuedTasks）——guard 只看 `req.busy`（已在跑的任务），
 * 但队列里可能还躺着一条尚未出队的 docgen（如用户刚提交补充说明，泵还没到下一 tick），此时 busy
 * 为空、guard 会放行，若不查队列就会带着「即将被派发的 docgen」一起进入开发期。第二道兜底见 dispatch
 * （极窄窗口：本函数查完队列到 phase 真正落盘之间，docgen 被派发）。
 *
 * 双击护栏：finalizing Set 挡住同一 id 的并发重入（用户手抖连点两次「定稿」按钮）。
 *
 * 部分进度落盘：每个工程分支就绪后立即把 {dir,branch,baseBranch} 并入 branches 写盘（phase
 * 暂不推进），这样某个工程中途失败时前面已成功的工程留下历史记录——重试时 resolveBaseBranch
 * 能从记录里找回真实基线，不必依赖（此时已不可信的）当前工作区分支状态。已建成功的分支本身
 * 不做回滚（KISS，不做回滚魔法），错误信息里指明哪个目录失败，用户可用 force 重试
 * （ensureBranch 对已存在的目标分支是幂等切换，重试安全）。
 */
export async function finalizeRequirement(id, { force = false } = {}) {
  if (finalizing.has(id)) return { ok: false, status: 409, error: '定稿正在进行中' };
  finalizing.add(id);
  try {
    const req = getRequirement(id);
    const guard = finalizeGuard(req);
    if (!guard.ok) return { ok: false, status: 409, error: guard.error };
    if (hasQueuedTasks(id)) return { ok: false, status: 409, error: '有任务排队待执行（如文档修订），请稍候再定稿' };

    if (!force) {
      const dirtyDirs = [];
      for (const p of guard.devProjects) {
        if (!(await isClean(p.dir))) dirtyDirs.push(p.dir);
      }
      if (dirtyDirs.length) return { ok: false, status: 409, warn: 'dirty', dirs: dirtyDirs };
    }

    const branch = reqBranchName(req);
    const branches = [];
    for (const p of guard.devProjects) {
      const prevRecord = (req.branches || []).find((b) => b.dir === p.dir);
      const cur = prevRecord ? null : await currentBranch(p.dir); // 有历史记录时无需再读，见 resolveBaseBranch
      const resolved = resolveBaseBranch({ prevRecord, currentBranch: cur, reqBranch: branch });
      // 先统一拦截任意错误码再按码转译：未知码也会在此被拦下走兜底文案，不会静默滑进成功路径
      if (resolved.error) {
        const msg =
          resolved.error === 'not-git'
            ? `${p.dir} 不是 git 仓库或处于 detached HEAD`
            : `${p.dir} 无法确定基线分支（${resolved.error}）`;
        return { ok: false, status: 400, error: msg };
      }
      const r = await ensureBranch(p.dir, branch);
      if (!r.ok) return { ok: false, status: 500, error: `创建/切换分支失败（${p.dir}，分支 ${branch}）` };
      branches.push({ dir: p.dir, branch, baseBranch: resolved.baseBranch });
      updateRequirement(id, { branches: [...branches] }, `定稿进度：${p.dir} 分支就绪`); // 部分进度落盘，供重试自愈
    }

    updateRequirement(id, { phase: 'dev', branches }, `定稿：建分支 ${branch}，进入开发期`);
    logger.info('req-ops', '需求定稿，进入开发期（develop 由客户端会话驱动）', { reqId: id, branch, dirs: branches.map((b) => b.dir) });
    return { ok: true, branch };
  } finally {
    finalizing.delete(id);
  }
}

// —— 归档（测试通过 → 归档中 → 已归档）——

/** 默认 git 日志读取实现（单测经 { runGit } 注入桩替换，绕开真实子进程）。 */
function defaultRunGit(dir, baseBranch, branch) {
  return runScript('git', ['-C', dir, 'log', `${baseBranch}..${branch}`, '--oneline'], { shell: false });
}

/** 默认 git diff 实现（单测经 { runGitDiff } 注入桩替换，对齐 runGit 先例）。 */
function defaultRunGitDiff(dir, baseBranch, branch) {
  return runScript('git', ['-C', dir, 'diff', `${baseBranch}..${branch}`, '--name-only'], {
    shell: false,
  });
}

const archiving = new Set(); // 双击护栏：同一需求的 archive 并发调用时挡住后来者（对齐 finalizeRequirement 的 finalizing 先例）

/**
 * 归档：逐分支读取提交概览拼档案 markdown → 写盘 → phase=archived。
 *
 * 守卫与路由层 phaseGuard（dev-done/test-pass 用）同准则——canTransition 卡相邻推进，
 * busy/排队中任务/conv 活跃 run 任一命中即拒。之所以自成一道完整守卫而不依赖路由层，
 * 是对齐 finalizeRequirement 的做法：本函数就该防得住被绕过路由的直调。
 *
 * runGit 可注入（供单测替真实 git 调用）：对每条 req.branches 读 `baseBranch..branch` 的
 * `--oneline` 概览。调用失败 → log=null（buildArchiveSummary 契约：null/falsy 渲染成
 * 「无法读取提交摘要」）；调用成功但输出为空（该分支相对基线确实无新提交，如只读工程
 * 全程未被自动开发碰过）→ 必须落一个非空占位字符串，不能落 null，否则会被
 * buildArchiveSummary 误判成「读取失败」。
 *
 * branchLogs 每条同时带 dir：多工程定稿时共用同一 branch 字符串（前后端各自仓库里建同名
 * 分支），buildArchiveSummary 按 dir（而非 branch）索引，避免双工程档案互相覆盖。
 */
export async function archiveRequirement(id, note, { runGit = defaultRunGit, runGitDiff = defaultRunGitDiff } = {}) {
  if (archiving.has(id)) return { ok: false, status: 409, error: '归档正在进行中' };
  archiving.add(id);
  try {
    const req = getRequirement(id);
    if (!req) return { ok: false, status: 404, error: '需求不存在' };
    const t = canTransition(req.phase, 'archived');
    if (!t.ok) return { ok: false, status: 409, error: t.error };
    if (req.busy || hasQueuedTasks(id) || hasActiveRunForConv(req.convId)) {
      return { ok: false, status: 409, error: '有任务进行中/排队，请先等待完成或停止' };
    }

    const branchLogs = [];
    for (const b of req.branches || []) {
      const r = await runGit(b.dir, b.baseBranch, b.branch);
      const out = (r?.out || '').trim();
      branchLogs.push({ dir: b.dir, log: !r?.ok ? null : out || '（该分支相对基线无新提交）' });
    }

    // 收割改动文件至功能账本（有 featureTag 才执行；失败降级静默跳过，不阻塞归档）
    if (req.featureTag) {
      try {
        const allFiles = [];
        for (const b of req.branches || []) {
          const r = await runGitDiff(b.dir, b.baseBranch, b.branch);
          if (r?.ok && r.out?.trim()) {
            allFiles.push(...r.out.trim().split('\n').filter(Boolean));
          }
        }
        if (allFiles.length) {
          harvestFiles(req.featureTag, allFiles);
          logger.info('req-ops', '功能账本收割完成', {
            reqId: id,
            tag: req.featureTag,
            fileCount: allFiles.length,
          });
        }
      } catch (e) {
        logger.warn('req-ops', '功能账本收割异常（已跳过，不影响归档）', {
          reqId: id,
          err: e?.message || String(e),
        });
      }
    }

    // fail-closed：note 非字符串（如前端传了对象）一律归空串，不落 [object Object]（同 handleGuidelines 的处理方式）
    const cleanNote = (typeof note === 'string' ? note : '').slice(0, 2000);
    const summary = buildArchiveSummary({ req, note: cleanNote, branchLogs });
    fs.writeFileSync(reqDir(id, 'archive.md'), summary, 'utf8');
    updateRequirement(
      id,
      { phase: 'archived', archive: { note: cleanNote, summary, archivedAt: new Date().toISOString() } },
      '确认归档',
    );
    logger.info('req-ops', '需求归档完成', { reqId: id, branches: branchLogs.length });
    return { ok: true };
  } finally {
    archiving.delete(id);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 需求 v2：问卷 / 需求地图 / 需求变动（spec docs/superpowers/specs/2026-08-25-req-v2-design.md）
// ═══════════════════════════════════════════════════════════════════════════

/** 影响预估是用户在弹框里等的同步调用，不能用 docgen 那 15 分钟的上限 */
export const IMPACT_TIMEOUT_MS = 90_000;

/**
 * 评审期只读 Claude 调用的公共外壳（quizgen / mapgen / mapfix / mapchange 共用）。
 *
 * 与 runDocgen 的 race+abort 骨架同源。**没有顺手把 runDocgen 也改成调它**：那条路径承载了
 * 补充说明合并、版本落盘、功能标签、飞书通知等一堆分支，注释里还记着多次事故的成因，
 * 为了 DRY 去动它风险明显大于收益。新任务共用本函数即可，后续要合并再一起做。
 *
 * busy 在**第一个 await 之前**同步写入（防下个 tick 重复出队）；成功由调用方清、失败在这里清。
 */
async function runReadonlyClaude(req, kind, { prompt, resume = null, startEvent, timeoutMs = DOCGEN_TIMEOUT_MS }) {
  const { cwd, addDirs } = pickCwdAndDirs(req?.projects);
  if (!cwd) throw new Error('未配置任何工程目录');
  updateRequirement(req.id, { busy: { kind, startedAt: Date.now() } }, startEvent);

  const t0 = Date.now();
  try {
    let capturedSession = null;
    let text = '';
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let raceTimer;
    try {
      const call = runClaude(prompt, {
        ...claudeAuthOpts(),
        cwd,
        ...(addDirs.length ? { additionalDirectories: addDirs } : {}),
        // dontAsk + allowedTools 双保险：只读任务不该有任何写能力（见 runDocgen 同款注释）
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Grep', 'Glob'],
        ...(resume ? { resume } : {}),
        abortController: abort,
        onInit: (i) => {
          capturedSession = i.session_id;
        },
        onText: (t) => {
          text += t;
        },
        onResult: (info) => {
          if (!text && info.result) text = info.result;
        },
      });
      call.catch((e) =>
        logger.warn('req-ops', kind + ' 调用异常（已落兜底）', { reqId: req.id, err: e?.message || String(e) }),
      );
      const timeoutPromise = new Promise((resolve) => {
        raceTimer = setTimeout(resolve, timeoutMs + 2_000);
      });
      if (await raceWithTimeoutFlag(call, timeoutPromise)) throw new Error('生成超时（流未结束）');
    } finally {
      clearTimeout(timer);
      clearTimeout(raceTimer);
    }
    if (!text || text.trim().length < 20) throw new Error('输出为空或过短，判定生成失败');
    logger.info('req-ops', kind + ' 调用完成', { reqId: req.id, ms: Date.now() - t0, chars: text.length });
    return { text, sessionId: capturedSession };
  } catch (e) {
    const reason = (e?.message || String(e)).slice(0, 200);
    updateRequirement(req.id, { busy: null }, kind + ' 失败：' + reason);
    logger.error('req-ops', kind + ' 失败', { reqId: req.id, ms: Date.now() - t0, reason });
    throw e;
  }
}

/** 某需求某版地图 JSON；v 省略取最新。无地图/读失败返回 null（调用方据此走降级）。 */
export function readMapVersion(req, v = null) {
  const versions = req?.reqMap?.versions || [];
  if (!versions.length) return null;
  const target = v == null ? versions[versions.length - 1] : versions.find((x) => x.v === Number(v));
  if (!target) return null;
  try {
    return JSON.parse(fs.readFileSync(target.path, 'utf8'));
  } catch (e) {
    logger.warn('req-ops', '地图读取失败', { reqId: req.id, v: target.v, err: e?.message || String(e) });
    return null;
  }
}

/** 就地覆盖写当前版地图（挂设计稿 / 存标注这类不产生新版本的改动走这里）。 */
export function writeMapVersion(req, map, v = null) {
  const versions = req?.reqMap?.versions || [];
  const target = v == null ? versions[versions.length - 1] : versions.find((x) => x.v === Number(v));
  if (!target) throw new Error('该版本地图不存在');
  fs.writeFileSync(target.path, JSON.stringify(map, null, 2), 'utf8');
  return target.v;
}

/** 地图落盘 + 版本登记（四条产地图的链路共用，保证 markFreshPoints / 回迁设计稿不会漏做）。 */
function persistMap(req, rawText, { prev, event }) {
  const map = normalizeMap(parseJsonLoose(rawText), { prev });
  if (!map.pages.length) throw new Error('地图为空（模型未产出任何页面）');
  markFreshPoints(prev, map);
  const v = nextMapVersion(req.reqMap);
  const p = reqDir(req.id, 'map-v' + v + '.json');
  fs.writeFileSync(p, JSON.stringify({ v, ...map }, null, 2), 'utf8');
  const versions = [...(req.reqMap?.versions || []), { v, path: p, at: new Date().toISOString() }];
  updateRequirement(
    req.id,
    { reqMap: { versions }, busy: null },
    event + '（v' + v + '，' + map.pages.length + ' 个页面）',
  );
  logger.info('req-ops', '地图落版', { reqId: req.id, v, pages: map.pages.length });
  return { v, map };
}

/**
 * 问卷生成。失败**不阻塞主流程**（spec §3.3）：路由层收到失败会引导用户直接走 docgen，
 * 所以这里只把状态写回、留痕，不做任何补偿动作。
 */
export async function runQuizGen(req) {
  const { cwd } = pickCwdAndDirs(req?.projects);
  if (!cwd || !req?.reqDoc) {
    updateRequirement(req.id, {}, '问卷生成被拒：' + DOCGEN_GUIDE);
    throw new Error(DOCGEN_GUIDE);
  }
  const { text, sessionId } = await runReadonlyClaude(req, 'quizgen', {
    prompt: buildQuizPrompt({
      reqDocText: fs.readFileSync(req.reqDoc.path, 'utf8'),
      projects: req.projects,
      // 背景也要喂给出题环节：界面上承诺了「你说清楚的地方就不会再问」，
      // 只喂 docgen 不喂这里，用户写了半页背景还被问同样的问题
      primeText: req.prime?.text || '',
    }),
    startEvent: '开始生成不确定点问卷',
  });
  let questions;
  try {
    questions = parseQuiz(text);
  } catch (e) {
    // 解析失败与「没找出歧义」是同一种结局：这次不出问卷，直接让用户去生成开发文档
    updateRequirement(req.id, { busy: null, quiz: null }, '问卷未生成：' + (e?.message || String(e)).slice(0, 120));
    throw e;
  }
  updateRequirement(
    req.id,
    {
      quiz: { status: 'ready', questions, answers: {}, at: new Date().toISOString() },
      docSession: sessionId || req.docSession,
      busy: null,
    },
    '问卷已生成（' + questions.length + ' 题）',
  );
  return questions;
}

/** 地图首次生成：紧跟在 docgen 之后，resume 同一 docSession。 */
export async function runMapGen(req) {
  const docPath = req.devDoc?.versions?.at(-1)?.path || '';
  if (!docPath) throw new Error('尚无开发文档，无法生成需求地图');
  // docSession 丢了就没上下文可续，降级为「现读开发文档」——比直接失败强
  const resume = req.docSession || null;
  const { text } = await runReadonlyClaude(req, 'mapgen', {
    prompt: buildMapgenPrompt(resume ? {} : { docPath }),
    resume,
    startEvent: '开始生成需求地图',
  });
  try {
    return persistMap(req, text, { prev: readMapVersion(req), event: '需求地图生成完成' });
  } catch (e) {
    updateRequirement(req.id, { busy: null }, '需求地图生成失败：' + (e?.message || String(e)).slice(0, 160));
    throw e;
  }
}

/** 标注 → 一轮修订，出 v+1。标注随旧版留在旧文件里，新版天然是空的。 */
export async function runMapFix(req) {
  const prev = readMapVersion(req);
  if (!prev) throw new Error('尚无需求地图可修订');
  // 无有效标注会在这里抛，不白跑一次 LLM，也不会凭空多出一个版本
  const prompt = buildMapFixPrompt({ map: prev, annots: prev.annots || {} });
  const { text } = await runReadonlyClaude(req, 'mapfix', {
    prompt,
    resume: req.docSession || null,
    startEvent: '开始按标注修订需求地图',
  });
  try {
    return persistMap(req, text, { prev, event: '需求地图按标注修订完成' });
  } catch (e) {
    updateRequirement(req.id, { busy: null }, '需求地图修订失败：' + (e?.message || String(e)).slice(0, 160));
    throw e;
  }
}

/** 开发期「需求变动」→ 更新地图，出 v+1。 */
export async function runMapChange(req, payload = {}) {
  const prev = readMapVersion(req);
  if (!prev) throw new Error('尚无需求地图可更新');
  const { text } = await runReadonlyClaude(req, 'mapchange', {
    prompt: buildMapChangePrompt({ map: prev, text: payload.text }),
    resume: req.docSession || null,
    startEvent: '开始按需求变动更新地图',
  });
  try {
    return persistMap(req, text, { prev, event: '需求地图按变动更新完成' });
  } catch (e) {
    updateRequirement(req.id, { busy: null }, '需求地图更新失败：' + (e?.message || String(e)).slice(0, 160));
    throw e;
  }
}

/**
 * 需求变动影响预估：**同步**返回（用户在弹框里等），故不占 busy、不进队列、不给任何工具。
 * 地图缺失或推理失败一律降级为空数组——预估只是锦上添花，不能挡住用户提交变动。
 */
export async function computeChangeImpact(req, text) {
  const map = readMapVersion(req);
  if (!map) return [];
  let prompt;
  try {
    prompt = buildImpactPrompt({ map, text });
  } catch {
    return []; // 正文为空 / 地图没有逻辑点：没什么可预估的
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), IMPACT_TIMEOUT_MS);
  try {
    let out = '';
    const call = runClaude(prompt, {
      ...claudeAuthOpts(),
      cwd: pickCwdAndDirs(req.projects).cwd || undefined,
      permissionMode: 'dontAsk',
      allowedTools: [], // 纯推理：给了工具它就会跑去读代码，把 90 秒耗光
      abortController: abort,
      onText: (t) => {
        out += t;
      },
      onResult: (info) => {
        if (!out && info.result) out = info.result;
      },
    });
    call.catch(() => {}); // race 放弃后仍可能 reject，预挂 catch 防 unhandled
    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, IMPACT_TIMEOUT_MS + 2_000));
    if (await raceWithTimeoutFlag(call, timeoutPromise)) return [];
    return parseImpact(out, map);
  } catch (e) {
    logger.warn('req-ops', '影响预估失败（降级为空）', { reqId: req.id, err: e?.message || String(e) });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

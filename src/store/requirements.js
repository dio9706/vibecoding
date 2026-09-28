/**
 * 需求（Requirement）存储 —— 「新需求」全生命周期工作流的数据模型。
 * 状态机：review → dev → test → archiving → archived（只允许相邻推进，守卫见 canTransition + ops 层）。
 * 与对话体系完全隔离：需求 conv 由前端 localStorage 持有，这里只记 convId/devSession 锚点。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'requirements.json';

/** 阶段推进表：key → 唯一合法的下一阶段 */
export const PHASE_FLOW = { review: 'dev', dev: 'test', test: 'archiving', archiving: 'archived' };

export function getRequirements() {
  // 倒序：列表/徽标都按最近更新展示
  return readJson(FILE, []).slice().sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export function getRequirement(id) {
  return readJson(FILE, []).find((r) => r.id === id) || null;
}

// ---- 需求主体 ----
// sessions[] 渐进迁移：新建需求 sessions 为空数组；旧需求读侧用 normalizeSessions 合成。
// 任何一次真实写入（sessionId 回填 / 新建子会话）都会顺带把合成结果落盘，完成迁移。
// phase 字段同批迁移：存量会话补「需求当前阶段」——缺 phase 说明这个需求从没经历过阶段拆分
// （老流程 dev-done 只改 phase、convId 原样延续），那根会话一路服务到了现在这个阶段。

/**
 * 工程槽位归一：只认 `dir` / `dev` 两个字段，其余一律丢弃。
 *
 * createRequirement 的 projects 入参多半是从另一条需求上整条读来的（沿用上一个需求的配置），
 * 直接塞进去会把那条记录日后新增的字段一并带过来，形状悄悄发散。
 */
function normalizeProjectSlot(p) {
  if (!p || typeof p !== 'object' || !p.dir) return null;
  return { dir: String(p.dir), dev: !!p.dev };
}

/**
 * @param {object} args
 * @param {string} args.title 需求标题
 * @param {object} [args.projects] 工程配置初值 `{frontend, backend}`，缺省为两侧皆空。
 *   「沿用上一个需求」的选源策略是业务判断，收在 `web/routes-requirements.js#inheritProjects`，
 *   store 只负责把调用方给的值归一落盘。
 */
export function createRequirement({ title, projects }) {
  const now = new Date().toISOString();
  const req = {
    id: 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: String(title || '').slice(0, 60),
    phase: 'review',
    // { dir, dev:boolean } | null
    projects: {
      frontend: normalizeProjectSlot(projects?.frontend),
      backend: normalizeProjectSlot(projects?.backend),
    },
    assignees: [], // 开发人员：同事 id 数组（src/store/colleagues.js）。存 id 不存姓名快照，
    // 改名/换 open_id 自动同步；同事被删产生的悬空 id 由读侧标 missing，不回头清理历史需求
    reqDoc: null, // { name, path }
    // 生成前的背景补充：需求文档之外用户已知的信息（历史坑/约束/优先级）。
    // 不并入 supplements —— 那是 append-only 的修订历史，而这是一份可反复
    // 编辑、只有一份的草稿，且不该触发 docgen（见 PUT /api/req/prime）。
    prime: null, // { text, files:[{name,path}], at } | null
    supplements: [], // [{ id, text, files:[{name,path}], at }]
    devDoc: { versions: [] }, // [{ v, path, summary, at }]
    docSession: null, // 评审期 docgen 的 Claude session（增量修订）
    convId: null, // 开发/测试期聊天 conv（前端回填）
    devSession: null, // 开发会话 session_id（onInit 回填，换浏览器重建 conv 续接）
    sessions: [], // [{convId, sessionId, title, kind, phase, createdAt}]
    // kind: 'main'|'sub'|'retro'
    // phase: 会话诞生时的需求阶段。正常只会是 'dev'|'test'（只有这两个阶段有建会话的入口）；
    //   存量会话由 normalizeSessions 回填，取的是该需求彼时的 phase，故可能是任意阶段值。
    branches: [], // 定稿时逐开发工程 [{ dir, branch, baseBranch }]
    apiDocs: [], // [{ id, name, path, updatedAt }]
    designGuidelines: '',
    featureTag: null, // 功能模块标签（docgen 自动推断或用户手改）
    // ---- 需求 v2（问卷 / 需求地图 / 需求变动）；老需求读侧一律降级为 null/[] ----
    // answers 在 ready 态是**草稿**（用户答一题存一次，中途离开不丢），answered 态才是定稿
    quiz: null, // { status:'ready'|'answered', questions:[{id,title,hint,why,opts}], answers:{[qid]:{v,note}}, at }
    reqMap: null, // { versions:[{ v, path, at }] }；地图正文落 requirements/<id>/map-v<n>.json，不塞进本记录
    changes: [], // 开发期需求变动 [{ id, text, scope:'both'|'map', hits:[pointId], at }]
    bitable: null, // { url, appToken, tableId }
    bugs: [], // [{ id, recordId, title, detail, verdict:'sure'|'doubt', reason, status, at }]
    busy: null, // { kind, runId, startedAt, convId? } —— 串行闸落盘镜像；convId 仅系统任务落在非主会话时有（colleague-dev 子会话），前端接流与 healStaleBusy 判泄漏都靠它
    // agent 派活时建的 per-需求 worktree 登记（spec §5.3）。记它只为一件事：
    // 需求被删除时要 `git worktree remove` 掉这些目录，否则每个需求留下一份完整
    // 工作区拷贝、无人回收。写入走 addAgentWorktree（锁内去重），不要在外面读改写。
    agentWorktrees: [], // [{ dir, worktreeDir, branch }]
    archive: null, // { note, summary, archivedAt }
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, event: '创建' }],
  };
  updateJson(FILE, [], (list) => {
    list.unshift(req);
    return list;
  });
  return req;
}

/**
 * 纯函数：合成老数据的主会话记录，并补齐缺失的 phase
 * @param {object} req - 需求对象
 * @returns {object[]} 合成或原有的 sessions 数组（每条保证有 phase）
 *
 * 三个路径：
 * 1. sessions 已非空 → 逐条补 phase 后返回（优先级最高，说明已迁移或手工设置）
 * 2. sessions 空但 convId 非空 → 合成一条主会话（同样补 phase）
 * 3. sessions 空且 convId 空 → 返回空数组（全新需求或完全未初始化）
 *
 * 缺 phase 补的是 req.phase（需求当前阶段）而非字面量 'dev'：一条会话没有 phase，
 * 只可能是它诞生于阶段隔离功能上线之前，也就意味着这个需求从没经历过阶段拆分——
 * 老流程的 dev-done 只改 phase、convId 原样延续，那根会话一路服务到了现在这个阶段。
 * 若按 'dev' 补，一个已在测试期的存量需求会被侧栏过滤判成「没有当前阶段的会话」，
 * 会话树整棵消失（且 convId 非空，走不到「清锚点自动建新主会话」的补救路径），
 * 阶段流转守卫也会遍历到空集、真空通过。
 *
 * 走新流程的需求不受影响：dev-done 的物化发生在 phase 改写之前（读的是旧 req），
 * 开发期会话照样被钉成 'dev' 落盘，此后再不触发回填。
 */
export function normalizeSessions(req) {
  const fallbackPhase = req.phase || 'dev'; // 极老数据可能连 phase 都没有，退到开发期
  // 路径 1：sessions 已非空，逐条补 phase
  if (req.sessions && req.sessions.length > 0) {
    return req.sessions.map((s) => (s.phase ? s : { ...s, phase: fallbackPhase }));
  }

  // 路径 2：sessions 空但 convId 非空 → 合成主会话
  if (req.convId) {
    return [
      {
        convId: req.convId,
        sessionId: req.devSession,
        title: req.title,
        kind: 'main',
        phase: fallbackPhase,
        createdAt: req.createdAt,
      },
    ];
  }

  // 路径 3：sessions 空且 convId 空 → 返回空数组
  return [];
}

export function updateRequirement(id, patch = {}, event) {
  let updated = null;
  updateJson(FILE, [], (list) => {
    const i = list.findIndex((r) => r.id === id);
    if (i < 0) return undefined; // 无此需求：不写盘
    const now = new Date().toISOString();
    list[i] = { ...list[i], ...patch, updatedAt: now };
    if (event) list[i].history.push({ at: now, event });
    updated = list[i];
    return list;
  });
  return updated;
}

/**
 * 登记一个 agent worktree。**整个去重过程都在 `updateJson` 回调内完成** ——
 * 这是本仓 `action-configs.js#appendAutoKeyword` 立下的纪律：调用方在锁外读到的是快照，
 * 在外面读改写会被另一进程/另一个并发任务覆盖。同一需求可能同时有两个 agent 任务在派活。
 *
 * 按 `worktreeDir` 去重且**先登记的保留**：`ensureReqWorktree` 对同一需求是幂等的
 * （返回同一个目录），重复登记只会让列表越堆越长，而 dir/branch 以首次为准即可 ——
 * 回收时只用 `worktreeDir` 和 `dir`，branch 只是给人看的。
 *
 * @param {string} reqId
 * @param {{dir?:string, worktreeDir:string, branch?:string}} wt
 * @returns {object|null} 更新后的需求；需求不存在或入参非法时返回 null（不写盘）
 */
export function addAgentWorktree(reqId, wt) {
  // worktreeDir 是唯一必需字段 —— 它就是将来要删的那个目录，缺了这条登记毫无意义
  if (!reqId || !wt || typeof wt !== 'object') return null;
  const worktreeDir = typeof wt.worktreeDir === 'string' ? wt.worktreeDir : '';
  if (!worktreeDir) return null;

  let updated = null;
  updateJson(FILE, [], (list) => {
    const i = list.findIndex((r) => r.id === reqId);
    if (i < 0) return undefined; // 无此需求：不写盘
    // 存量需求盘上没有这个字段，兜底成空数组（getRequirement 是裸读、无归一）
    const cur = Array.isArray(list[i].agentWorktrees) ? list[i].agentWorktrees : [];
    if (cur.some((x) => x?.worktreeDir === worktreeDir)) {
      updated = list[i];
      return undefined; // 已登记过：不写盘，保持首次登记的 dir/branch
    }
    list[i] = {
      ...list[i],
      agentWorktrees: [
        ...cur,
        {
          dir: typeof wt.dir === 'string' ? wt.dir : '',
          worktreeDir,
          branch: typeof wt.branch === 'string' ? wt.branch : '',
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    updated = list[i];
    return list;
  });
  return updated;
}

/**
 * 物理删除一条需求（不可恢复）。返回被删的记录，无此需求返回 null。
 *
 * 与 phase='discarded' 的区别：废弃只是状态位，记录仍在盘上、仍能回看历史；这里是真删。
 * 磁盘产物（requirements/<id>/ 下的开发文档与需求地图）不归 store 管，由调用方 ops 层清理——
 * store 只认 JSON，不持有 appDataPath 的目录语义（分层纪律，见本目录 CLAUDE.md）。
 */
export function deleteRequirement(id) {
  let removed = null;
  updateJson(FILE, [], (list) => {
    const i = list.findIndex((r) => r.id === id);
    if (i < 0) return undefined; // 无此需求：不写盘
    removed = list[i];
    list.splice(i, 1);
    return list;
  });
  return removed;
}

/** 阶段流转守卫（纯函数）：只查相邻推进；busy/活跃 run 守卫在 ops 层（需要 runs 注册表） */
export function canTransition(from, to) {
  if (PHASE_FLOW[from] === to) return { ok: true };
  return { ok: false, error: `不允许从「${from}」流转到「${to}」` };
}

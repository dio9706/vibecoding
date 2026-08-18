/** web 入口：需求工作流 HTTP 路由 —— 单入口 handleRequirementRoutes 按 pathname+method 分发 */
import fs from 'node:fs';
import { getRequirement, getRequirements, updateRequirement, createRequirement, canTransition, normalizeSessions } from '../../store/requirements.js';
import { enqueueSystemTask, finalizeRequirement, archiveRequirement, hasQueuedTasks, reqDir, DOCGEN_GUIDE } from './requirement-ops.js';
import { pickCwdAndDirs, buildSeedPrompt } from './req-logic.js';
import { writePitfalls, ensureClaudeMdRef } from './req-pitfalls.js';
import { inspectBitable, confirmBug, ignoreBug, retryBug, currentInspectIdentity } from './req-inspect.js';
import { parseBitableLink } from '../../plugins/team-tools/bug-patrol/logic.js';
import { hasActiveRunForConv } from '../../store/runs.js';
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';
import { logger } from '../../shared/logger.js';

// ==== POST /api/req/create ====
function handleCreate(req, res) {
  return withJsonBody(req, res, (data) => {
    const title = str(data.title);
    if (!title) return sendJson(res, 400, { error: 'title 不能为空' });
    if (title.length > 60) return sendJson(res, 400, { error: 'title 不能超过 60 字符' });
    const created = createRequirement({ title });
    sendJson(res, 201, created);
  });
}

// ==== GET /api/req/list ====
function handleList(res) {
  const requirements = getRequirements().map((r) => ({
    id: r.id,
    title: r.title,
    phase: r.phase,
    updatedAt: r.updatedAt,
    // 排队中（泵尚未派发、busy 未写入）也算 busy：否则 docgen 202 后的短窗口里列表看不到任何进行中迹象
    busy: !!r.busy || hasQueuedTasks(r.id),
    // 会话树要靠它渲染。前端 refreshReqList 用本接口返回值整体替换 lastList，
    // 少了这个字段，30s 轮询一到开发/测试期的子会话行就全部消失（看起来像「下拉自动收起」）。
    sessions: normalizeSessions(r),
  }));
  sendJson(res, 200, { requirements });
}

// ==== GET /api/req/get?id= ====
function handleGet(url, res) {
  const id = str(url.searchParams.get('id'));
  const r = getRequirement(id);
  if (!r) return sendJson(res, 404, { error: '需求不存在' });
  const latest = r.devDoc?.versions?.at(-1);
  let devDocLatest = null;
  if (latest) {
    try {
      devDocLatest = fs.readFileSync(latest.path, 'utf8');
    } catch {
      devDocLatest = null; // 文件被移动/删除等读取失败不炸接口，前端按「暂无」处理
    }
  }
  // queued：任务已入队但泵（5s tick）还没派发、busy 尚未写入的窗口期。前端把它视同 busy，
  // 否则 docgen 202 后立即刷新会拿到 busy=null——既不显示生成中，也不会启动 busy 轮询。
  // devCwd：开发/系统任务所在的工程目录（pickCwdAndDirs 取第一个工程，与 dispatchSystemTask/runDocgen 同源）。
  // 前端据此按 cwd 定位 Claude 磁盘会话（~/.claude/projects/<encode(cwd)>/<devSession>.jsonl），
  // 用于「开发已完成、过程没进 localStorage」时从 session 转录回放开发过程。
  sendJson(res, 200, {
    ...r,
    devDocLatest,
    queued: hasQueuedTasks(id),
    devCwd: pickCwdAndDirs(r.projects).cwd,
    sessions: normalizeSessions(r),
    seed: r.phase === 'dev' || r.phase === 'test' ? buildSeedPrompt(r) : null,
  });
}

// ==== GET /api/req/doc?id=&v= ====
function handleDoc(url, res) {
  const id = str(url.searchParams.get('id'));
  const r = getRequirement(id);
  if (!r) return sendJson(res, 404, { error: '需求不存在' });
  const v = Number(url.searchParams.get('v'));
  const entry = (r.devDoc?.versions || []).find((x) => x.v === v);
  if (!entry) return sendJson(res, 404, { error: '版本不存在' });
  try {
    const content = fs.readFileSync(entry.path, 'utf8');
    sendJson(res, 200, { content });
  } catch (e) {
    sendJson(res, 500, { error: '读取失败：' + (e?.message || e) });
  }
}

/** 单个工程配置校验：null 直接放行；否则须 {dir:非空字符串, dev:boolean} */
function validateProjectEntry(p, key) {
  if (p === null) return { value: null };
  if (typeof p !== 'object') return { error: `${key} 工程配置格式不正确` };
  const dir = str(p.dir);
  if (!dir) return { error: `${key} 工程目录不能为空` };
  if (typeof p.dev !== 'boolean') return { error: `${key} 工程 dev 标记必须为 boolean` };
  return { value: { dir, dev: p.dev } };
}

/**
 * projects 补丁：只重写请求里出现的 key，未出现的沿用既有值——
 * updateRequirement 是浅合并，patch.projects 会整体替换掉旧的 projects 对象，
 * 若只带一侧字段会把另一侧静默清空，因此这里以 existing 兜底拼出完整对象。
 */
function buildProjectsPatch(input, existing) {
  const out = { frontend: existing?.frontend ?? null, backend: existing?.backend ?? null };
  for (const key of ['frontend', 'backend']) {
    if (!(key in input)) continue;
    const r = validateProjectEntry(input[key], key);
    if (r.error) return { error: r.error };
    out[key] = r.value;
  }
  return { value: out };
}

/** reqDoc 补丁：{name,text} 落盘写入 req-doc.md；{name,path} 登记已上传文件（校验存在性） */
function buildReqDocPatch(id, reqDoc) {
  if (reqDoc === null) return { value: null };
  if (typeof reqDoc !== 'object') return { error: 'reqDoc 格式不正确' };
  const name = str(reqDoc.name);
  if (!name) return { error: 'reqDoc.name 不能为空' };
  if (typeof reqDoc.text === 'string') {
    const p = reqDir(id, 'req-doc.md');
    fs.writeFileSync(p, reqDoc.text, 'utf8');
    return { value: { name, path: p } };
  }
  if (typeof reqDoc.path === 'string') {
    const p = str(reqDoc.path);
    if (!p || !fs.existsSync(p)) return { error: 'reqDoc.path 指向的文件不存在' };
    return { value: { name, path: p } };
  }
  return { error: 'reqDoc 需提供 text 或 path' };
}

// ==== PUT /api/req/config {id,projects,reqDoc} ====
function handleConfig(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (r.phase !== 'review') return sendJson(res, 409, { error: '仅评审设计期可修改配置' });

    const patch = {}; // 注意：title 不在允许字段之列，分支名依赖它，config 路由绝不接受修改

    if (data.projects !== undefined) {
      if (typeof data.projects !== 'object' || data.projects === null || Array.isArray(data.projects)) {
        return sendJson(res, 400, { error: 'projects 格式不正确' });
      }
      const pr = buildProjectsPatch(data.projects, r.projects);
      if (pr.error) return sendJson(res, 400, { error: pr.error });
      patch.projects = pr.value;
    }

    if (data.reqDoc !== undefined) {
      const dr = buildReqDocPatch(id, data.reqDoc);
      if (dr.error) return sendJson(res, 400, { error: dr.error });
      patch.reqDoc = dr.value;
    }

    if (data.notifyBotId !== undefined) {
      patch.notifyBotId = typeof data.notifyBotId === 'string' && data.notifyBotId
        ? data.notifyBotId
        : null;
    }

    const updated = updateRequirement(id, patch, '更新需求配置');
    logger.info('req-routes', '更新需求配置', {
      reqId: id,
      frontend: updated.projects?.frontend?.dir || null,
      backend: updated.projects?.backend?.dir || null,
      reqDoc: updated.reqDoc?.name || null,
    });
    sendJson(res, 200, updated);
  });
}

// ==== POST /api/req/docgen {id} ====
function handleDocgen(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (r.phase !== 'review') return sendJson(res, 409, { error: '仅评审设计期可生成开发文档' });
    const { cwd } = pickCwdAndDirs(r.projects);
    if (!cwd || !r.reqDoc) return sendJson(res, 400, { error: DOCGEN_GUIDE });
    if (r.busy || hasQueuedTasks(id)) return sendJson(res, 409, { error: '文档生成已在进行或排队' });
    logger.info('req-routes', '收到生成开发文档请求', { reqId: id, cwd, reqDoc: r.reqDoc?.name });
    enqueueSystemTask(id, 'docgen', {});
    sendJson(res, 202, { ok: true });
  });
}

// ==== POST /api/req/supplement {id,text,files} ====
function handleSupplement(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (r.phase !== 'review') return sendJson(res, 409, { error: '仅评审设计期可提交补充说明' });

    const text = str(data.text);
    const files = (Array.isArray(data.files) ? data.files : [])
      .map((f) => ({ name: str(f?.name), path: str(f?.path) }))
      .filter((f) => f.name || f.path); // 剔除 name/path 均空的占位条目，避免 files:[{}] 误判为「有附件」
    if (!text && !files.length) return sendJson(res, 400, { error: 'text 或 files 至少需要一项' });

    const supplement = {
      id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text,
      files,
      at: new Date().toISOString(),
    };
    // 先落盘再入队：runDocgen 首版路径读的是落盘的 req.supplements，顺序反了会丢正文（见 requirement-ops.js 头注释）
    updateRequirement(id, { supplements: [...r.supplements, supplement] }, '提交补充说明');

    const { cwd } = pickCwdAndDirs(r.projects);
    if (!cwd || !r.reqDoc) {
      logger.info('req-routes', '补充说明已记录（配置未齐，暂不生成）', { reqId: id, chars: text.length, files: files.length });
      return sendJson(res, 200, { ok: true, note: '已记录，配置齐全并生成初版后将自动纳入' });
    }
    logger.info('req-routes', '收到补充说明，入队修订文档', { reqId: id, chars: text.length, files: files.length });
    enqueueSystemTask(id, 'docgen', { supplement });
    sendJson(res, 202, { ok: true });
  });
}

// ==== POST /api/req/finalize {id,force} ====
function handleFinalize(req, res) {
  return withJsonBody(req, res, async (data) => {
    const id = str(data.id);
    if (!getRequirement(id)) return sendJson(res, 404, { error: '需求不存在' }); // 先 404，不让 finalizeGuard 对 null 回误导性 409
    const result = await finalizeRequirement(id, { force: !!data.force });
    if (!result.ok) {
      const body = { error: result.error };
      if (result.warn) {
        body.warn = result.warn;
        body.dirs = result.dirs; // 字段名须为 dirs，原样透传 ops 返回值
      }
      return sendJson(res, result.status, body);
    }
    sendJson(res, 200, { ok: true, branch: result.branch });
  });
}

// ==== POST /api/req/apidoc {id,name,path} / DELETE /api/req/apidoc {id,docId} ====
function newApiDocId() {
  return 'ad_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function handleApidocPost(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (r.phase !== 'dev') return sendJson(res, 409, { error: '仅开发期可维护 API 文档' });
    const name = str(data.name);
    const p = str(data.path);
    if (!name || !p) return sendJson(res, 400, { error: 'name/path 均必填' });
    if (!fs.existsSync(p)) return sendJson(res, 400, { error: '文件不存在：' + p });

    const apiDocs = r.apiDocs || [];
    const idx = apiDocs.findIndex((d) => d.name === name);
    const now = new Date().toISOString();
    let doc, action, nextApiDocs;
    if (idx >= 0) {
      doc = { ...apiDocs[idx], path: p, updatedAt: now };
      nextApiDocs = apiDocs.map((d, i) => (i === idx ? doc : d));
      action = '更新';
    } else {
      doc = { id: newApiDocId(), name, path: p, updatedAt: now };
      nextApiDocs = [...apiDocs, doc];
      action = '新增';
    }
    updateRequirement(id, { apiDocs: nextApiDocs }, `API 文档${action}：${name}`);
    sendJson(res, 202, { ok: true, action, doc });
  });
}

function handleApidocDelete(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (r.phase !== 'dev') return sendJson(res, 409, { error: '仅开发期可维护 API 文档' });
    const docId = str(data.docId);
    const apiDocs = r.apiDocs || [];
    const idx = apiDocs.findIndex((d) => d.id === docId);
    if (idx < 0) return sendJson(res, 404, { error: 'API 文档不存在' });
    const doc = apiDocs[idx];
    const nextApiDocs = apiDocs.filter((d) => d.id !== docId);
    updateRequirement(id, { apiDocs: nextApiDocs }, `API 文档删除：${doc.name}`);
    sendJson(res, 202, { ok: true, action: '删除', doc });
  });
}

// ==== PUT /api/req/guidelines {id,text} ====
function handleGuidelines(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (r.phase !== 'dev' && r.phase !== 'test') return sendJson(res, 409, { error: '仅开发/测试期可编辑设计准则' });
    // fail-closed：非字符串一律归空串，避免 `[object Object]` 落盘；保留多行原样（不 trim）
    const designGuidelines = (typeof data.text === 'string' ? data.text : '').slice(0, 5000);
    updateRequirement(id, { designGuidelines }, '更新设计准则');
    sendJson(res, 200, { ok: true, designGuidelines });
  });
}

// ==== POST /api/req/conv {id,convId} ====
function handleConv(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    const convId = str(data.convId);
    if (!convId) return sendJson(res, 400, { error: 'convId 不能为空' });
    updateRequirement(id, { convId }, '绑定会话');
    sendJson(res, 200, { ok: true, convId });
  });
}

/** dev-done / test-pass 共用的阶段流转守卫：404 → canTransition 不过 409 → 有任务进行中/排队 409 */
function phaseGuard(id, toPhase) {
  const r = getRequirement(id);
  if (!r) return { ok: false, status: 404, error: '需求不存在' };
  const t = canTransition(r.phase, toPhase);
  if (!t.ok) return { ok: false, status: 409, error: t.error };
  if (r.busy || hasQueuedTasks(id) || hasActiveRunForConv(r.convId)) {
    return { ok: false, status: 409, error: '有任务进行中/排队，请先等待完成或停止' };
  }
  return { ok: true };
}

// ==== POST /api/req/dev-done {id} ====
function handleDevDone(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const g = phaseGuard(id, 'test');
    if (!g.ok) return sendJson(res, g.status, { error: g.error });
    const updated = updateRequirement(id, { phase: 'test' }, '开发完成，进入测试期');
    logger.info('req-routes', '阶段流转：开发→测试', { reqId: id });
    sendJson(res, 200, { ok: true, phase: updated.phase });
  });
}

// ==== POST /api/req/test-pass {id} ====
function handleTestPass(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const g = phaseGuard(id, 'archiving');
    if (!g.ok) return sendJson(res, g.status, { error: g.error });
    const updated = updateRequirement(id, { phase: 'archiving' }, '测试通过，进入归档期');
    logger.info('req-routes', '阶段流转：测试→归档', { reqId: id });
    sendJson(res, 200, { ok: true, phase: updated.phase });
  });
}

// ==== POST /api/req/archive {id,note} ====
function handleArchive(req, res) {
  return withJsonBody(req, res, async (data) => {
    const id = str(data.id);
    if (!getRequirement(id)) return sendJson(res, 404, { error: '需求不存在' }); // 先 404，不让 archiveRequirement 对 null 回误导性 409
    const result = await archiveRequirement(id, data.note);
    if (!result.ok) return sendJson(res, result.status, { error: result.error });
    sendJson(res, 200, { ok: true });
  });
}

// ==== POST /api/req/discard {id} ====
function handleDiscard(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { error: 'id 不能为空' });
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (r.phase === 'discarded') return sendJson(res, 409, { error: '需求已是废弃状态' });
    if (r.phase === 'archived') return sendJson(res, 409, { error: '已归档需求无法废弃' });
    updateRequirement(id, { phase: 'discarded', discardedAt: Date.now() }, '需求已废弃');
    logger.info('req-routes', '废弃需求', { reqId: id, fromPhase: r.phase });
    sendJson(res, 200, { ok: true });
  });
}

// ==== POST /api/req/bitable {id,url} ====
function handleBitable(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (r.phase !== 'test') return sendJson(res, 409, { error: '仅测试期可进行表格巡检' });
    if (r.busy || hasQueuedTasks(id)) return sendJson(res, 409, { error: '有任务进行中或排队，请稍候' });
    // 身份预检（N2）：受理前先挡住，避免用户等半天才在 history 里发现「被拒」
    if (!currentInspectIdentity()) {
      return sendJson(res, 400, { error: '请先在设置页填写「我的飞书 open_id」（基础设置 → 我的飞书身份）' });
    }
    const url = str(data.url);
    if (!url || !parseBitableLink(url)) return sendJson(res, 400, { error: '未识别出多维表格链接' });
    sendJson(res, 202, { ok: true });
    // 巡检自己管 busy（同步写在第一个 await 之前）；路由不 await，失败原因由 inspectBitable 自行落 history
    inspectBitable(id, url).catch((e) =>
      logger.error('req-routes', '表格巡检任务异常', { reqId: id, err: e?.message || String(e) }),
    );
  });
}

// ==== POST /api/req/session {id, convId, sessionId?, title?, kind?} ====
function handleSession(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });

    const convId = str(data.convId);
    const sessionId = data.sessionId ? str(data.sessionId) : null;
    // title 缺省必须是 null 而非 '新会话'：本接口既是「登记」也是「run 启动后回填 sessionId」的入口，
    // 回填方（chat.js 的 session 事件）不关心标题也就不会传 title。若在此兜底成默认名，
    // 下面的「有变化就覆盖」会把用户改过的标题一路打回「新会话」——跑一次 run 就丢一次。
    // 兜底改到「新建」分支里做：只有没有既有记录可保时才需要默认名。
    const title = data.title ? str(data.title) : null;
    const kind = data.kind ? str(data.kind) : 'sub';

    // 幂等 upsert
    const sessions = normalizeSessions(r);
    const idx = sessions.findIndex((s) => s.convId === convId);

    let updated = false;
    let devSessionPatch = null;

    if (idx >= 0) {
      // ★ 保护：kind 若被传入，必须与既有一致
      if (data.kind && str(data.kind) !== sessions[idx].kind) {
        return sendJson(res, 409, { error: '不能改变已有会话的 kind' });
      }
      // 更新：补齐 sessionId / 更新 title，但不改 kind
      const existing = sessions[idx];
      if (sessionId && !existing.sessionId) {
        existing.sessionId = sessionId;
        updated = true;
      }
      if (title && title !== existing.title) {
        existing.title = title;
        updated = true;
      }
    } else {
      // 新增：此时没有既有标题可保，才用默认名兜底
      sessions.push({ convId, sessionId, title: title || '新会话', kind, createdAt: new Date().toISOString() });
      updated = true;
    }

    // devSession 回写认「既有记录的 kind」而不是请求传入的 kind：
    // 回填方不传 kind 时上面会默认成 'sub'，用它判断的话主会话的 devSession 永远回填不了。
    const effectiveKind = idx >= 0 ? sessions[idx].kind : kind;
    if (effectiveKind === 'main' && sessionId) {
      devSessionPatch = sessionId;
    }

    // 只在有更新时落盘
    if (updated || !r.sessions || r.sessions.length === 0) {
      const patch = { sessions };
      if (devSessionPatch) {
        patch.devSession = devSessionPatch;
      }
      const event =
        effectiveKind === 'main' ? '主会话 sessionId 回填' : `会话登记 ${title || sessions[idx >= 0 ? idx : sessions.length - 1].title}`;
      updateRequirement(id, patch, event);
    }

    sendJson(res, 200, { ok: true });
  });
}

// ==== DELETE /api/req/session {id, convId} ====
function handleSessionDelete(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });

    const convId = str(data.convId);
    const sessions = normalizeSessions(r);

    const idx = sessions.findIndex((s) => s.convId === convId);
    if (idx < 0) return sendJson(res, 404, { error: '会话不存在' });

    if (sessions[idx].kind === 'main') {
      return sendJson(res, 409, { error: '不能删除主会话（bug-fix 落点）' });
    }

    const title = sessions[idx]?.title || convId;
    sessions.splice(idx, 1);
    updateRequirement(id, { sessions }, `删除会话 ${title}`);

    sendJson(res, 200, { ok: true });
  });
}

// ==== GET /api/req/pitfalls/get?dir=<projectDir> ====
/** 拉取指定工程目录的现有避坑清单内容 */
async function handlePitfallsGet(url, res) {
  try {
    const dir = str(url.searchParams.get('dir'));
    if (!dir) return sendJson(res, 400, { error: 'dir 参数不能为空' });

    const { readFile } = await import('./req-pitfalls.js');
    const { ensurePitfallsPath } = await import('./req-pitfalls.js');
    const filePath = ensurePitfallsPath(dir);
    const content = await readFile(filePath);

    sendJson(res, 200, { ok: true, content: content || '' });
  } catch (e) {
    logger.error('req-pitfalls-get', '读取避坑清单失败', { err: e?.message || String(e) });
    sendJson(res, 500, { ok: false, error: '读取失败' });
  }
}

// ==== POST /api/req/pitfalls {id, frontend: [], backend: []} ====
function handlePitfalls(req, res) {
  return withJsonBody(req, res, async (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });

    const frontend = Array.isArray(data.frontend) ? data.frontend : [];
    const backend = Array.isArray(data.backend) ? data.backend : [];

    const written = { frontend: 0, backend: 0 };
    const skipped = [];

    if (frontend.length > 0 && r.projects?.frontend?.dir && r.projects.frontend.dev) {
      // 与后端一致：有数据 + 配置 + dev=true → 写
      try {
        await writePitfalls(r.projects.frontend.dir, frontend);
        await ensureClaudeMdRef(r.projects.frontend.dir);
        written.frontend = frontend.length;
      } catch (e) {
        skipped.push({ side: 'frontend', error: e.message });
      }
    } else if (frontend.length > 0) {
      // 无数据或无配置或非开发工程 → 跳过
      if (!r.projects?.frontend?.dir) {
        skipped.push({ side: 'frontend', error: '前端工程未配置' });
      } else if (!r.projects.frontend.dev) {
        skipped.push({ side: 'frontend', error: '前端为只读工程，不写入' });
      }
    }

    if (backend.length > 0 && r.projects?.backend?.dir && r.projects.backend.dev) {
      // 只写 dev=true 的工程
      try {
        await writePitfalls(r.projects.backend.dir, backend);
        await ensureClaudeMdRef(r.projects.backend.dir);
        written.backend = backend.length;
      } catch (e) {
        skipped.push({ side: 'backend', error: e.message });
      }
    } else if (backend.length > 0) {
      if (!r.projects?.backend?.dir) {
        skipped.push({ side: 'backend', error: '后端工程未配置' });
      } else if (!r.projects.backend.dev) {
        skipped.push({ side: 'backend', error: '后端为只读工程，不写入' });
      }
    }

    sendJson(res, 200, { ok: true, written, skipped });
  });
}

/** confirm/ignore/retry 三个 BUG 操作路由共用的接线：404 前置校验需求存在，其余状态判定交给 fn */
function handleBugAction(fn) {
  return (req, res) =>
    withJsonBody(req, res, async (data) => {
      const id = str(data.id);
      if (!getRequirement(id)) return sendJson(res, 404, { error: '需求不存在' });
      const bugId = str(data.bugId);
      if (!bugId) return sendJson(res, 400, { error: 'bugId 不能为空' });
      const result = await fn(id, bugId);
      if (!result.ok) return sendJson(res, result.status, { error: result.error });
      sendJson(res, 200, { ok: true });
    });
}

const handleBugConfirm = handleBugAction(confirmBug);
const handleBugIgnore = handleBugAction(ignoreBug);
const handleBugRetry = handleBugAction(retryBug);

/** 需求工作流路由单入口：按 pathname + method 分发 */
export function handleRequirementRoutes(req, res, url) {
  const { pathname } = url;
  const { method } = req;
  if (pathname === '/api/req/create' && method === 'POST') return handleCreate(req, res);
  if (pathname === '/api/req/list' && method === 'GET') return handleList(res);
  if (pathname === '/api/req/get' && method === 'GET') return handleGet(url, res);
  if (pathname === '/api/req/doc' && method === 'GET') return handleDoc(url, res);
  if (pathname === '/api/req/config' && method === 'PUT') return handleConfig(req, res);
  if (pathname === '/api/req/docgen' && method === 'POST') return handleDocgen(req, res);
  if (pathname === '/api/req/supplement' && method === 'POST') return handleSupplement(req, res);
  if (pathname === '/api/req/finalize' && method === 'POST') return handleFinalize(req, res);
  if (pathname === '/api/req/apidoc' && method === 'POST') return handleApidocPost(req, res);
  if (pathname === '/api/req/apidoc' && method === 'DELETE') return handleApidocDelete(req, res);
  if (pathname === '/api/req/guidelines' && method === 'PUT') return handleGuidelines(req, res);
  if (pathname === '/api/req/conv' && method === 'POST') return handleConv(req, res);
  if (pathname === '/api/req/session' && method === 'POST') return handleSession(req, res);
  if (pathname === '/api/req/session' && method === 'DELETE') return handleSessionDelete(req, res);
  if (pathname === '/api/req/pitfalls' && method === 'GET') return handlePitfallsGet(url, res);
  if (pathname === '/api/req/pitfalls' && method === 'POST') return handlePitfalls(req, res);
  if (pathname === '/api/req/dev-done' && method === 'POST') return handleDevDone(req, res);
  if (pathname === '/api/req/test-pass' && method === 'POST') return handleTestPass(req, res);
  if (pathname === '/api/req/archive' && method === 'POST') return handleArchive(req, res);
  if (pathname === '/api/req/discard' && method === 'POST') return handleDiscard(req, res);
  if (pathname === '/api/req/bitable' && method === 'POST') return handleBitable(req, res);
  if (pathname === '/api/req/bug/confirm' && method === 'POST') return handleBugConfirm(req, res);
  if (pathname === '/api/req/bug/ignore' && method === 'POST') return handleBugIgnore(req, res);
  if (pathname === '/api/req/bug/retry' && method === 'POST') return handleBugRetry(req, res);
  return sendJson(res, 404, { error: 'not found' });
}

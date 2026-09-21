/** web 入口：需求工作流 HTTP 路由 —— 单入口 handleRequirementRoutes 按 pathname+method 分发 */
import fs from 'node:fs';
import { getRequirement, getRequirements, updateRequirement, createRequirement, deleteRequirement, canTransition, normalizeSessions } from '../../store/requirements.js';
import { enqueueSystemTask, finalizeRequirement, finalizePrecheck, archiveRequirement, resolveAssigneeList, hasQueuedTasks, queuedTasks, reqDir, readMapVersion, DOCGEN_GUIDE, docgenAborts, userStoppedSet, docgenLiveLine, registerApiDoc } from './requirement-ops.js';
import { pickCwdAndDirs, buildSeedPrompt, buildFeatureSnapshot } from './req-logic.js';
import { getTopFiles, getFeatureIndex } from '../../store/feature-index.js';
import { getColleague } from '../../store/colleagues.js';
import { getThread, markRead, appendMessage, dropReqThreads } from '../../store/colleague-messages.js';
import { getActiveBot, getPluginEnabled } from '../../store/settings.js';
import { sendTextToUser } from '../../integrations/lark.js';
import { writePitfalls, ensureClaudeMdRef } from './req-pitfalls.js';
import { inspectBitable, confirmBug, ignoreBug, retryBug, currentInspectIdentity } from './req-inspect.js';
import { parseBitableLink } from '../../plugins/team-tools/bug-patrol/logic.js';
import { extractDocLinks } from '../../channels/feishu-normalize.js';
import { fetchDocRawContent, resolveWikiNodeObj } from '../../integrations/lark.js';
import { hasActiveRunForConv } from '../../store/runs.js';
import { handleReqV2Routes } from './routes-req-v2.js';
import { autoHandleMessages } from './colleague-auto.js';
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
  const featureSnapshot = buildFeatureSnapshot(r, getTopFiles);
  // 开发人员 join：名册在另一个文件，前端两处（评审卡 / 开发右栏）都要显示姓名。
  // 在这里 join 一次，省掉前端「拿到需求再拉一次名册」的第二跳——
  // 开发期右栏每 3s 轮询一次本接口，多一跳就是多一倍请求（同 mapLatest 的理由）。
  // join 规则本身收在 ops 层，与定稿通知、归档快照共用同一份（见 resolveAssigneeList 注释）。
  const assigneeList = resolveAssigneeList(r.assignees, { reqId: id });
  sendJson(res, 200, {
    ...r,
    devDocLatest,
    assigneeList,
    // 地图一并带回，省掉前端「拿到需求再拉一次地图」的第二跳（busy 轮询每 3s 一次，多一跳就是多一倍请求）
    mapLatest: readMapVersion(r),
    queued: hasQueuedTasks(id),
    // 排队窗口期前端要合成一个 busy 来显示进度，而「分析中」与「生成中」的文案和时长口径
    // 完全不同，光有 queued 布尔值会把 quizgen 显示成「开发文档生成中」
    queuedKind: queuedTasks(id)[0]?.kind ?? null,
    devCwd: pickCwdAndDirs(r.projects).cwd,
    sessions: normalizeSessions(r),
    seed: r.phase === 'dev' || r.phase === 'test' ? buildSeedPrompt(r, { featureSnapshot }) : null,
    featureTag: r.featureTag ?? null,
    liveLog: docgenLiveLine.get(id) || null,
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

/**
 * reqDoc 补丁：{name,text} 落盘写入 req-doc.md；{name,path} 登记已上传文件（校验存在性）。
 *
 * url/fetchedAt 是在线来源（飞书文档）的溯源信息，只在提供时附带：下游读的始终是落盘快照，
 * 这两个字段仅供界面显示来源、判断要不要给「刷新」按钮——粘贴与上传两种来源没有可刷新的源头。
 */
function buildReqDocPatch(id, reqDoc) {
  if (reqDoc === null) return { value: null };
  if (typeof reqDoc !== 'object') return { error: 'reqDoc 格式不正确' };
  const name = str(reqDoc.name);
  if (!name) return { error: 'reqDoc.name 不能为空' };
  const origin = {};
  if (str(reqDoc.url)) origin.url = str(reqDoc.url);
  if (str(reqDoc.fetchedAt)) origin.fetchedAt = str(reqDoc.fetchedAt);
  if (typeof reqDoc.text === 'string') {
    const p = reqDir(id, 'req-doc.md');
    fs.writeFileSync(p, reqDoc.text, 'utf8');
    return { value: { name, path: p, ...origin } };
  }
  if (typeof reqDoc.path === 'string') {
    const p = str(reqDoc.path);
    if (!p || !fs.existsSync(p)) return { error: 'reqDoc.path 指向的文件不存在' };
    return { value: { name, path: p, ...origin } };
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

/**
 * PUT /api/req/assignees {id, assignees:[colleagueId]} —— 指派 / 修改开发人员。
 *
 * 刻意**不**并入 handleConfig：那条路由有「仅评审设计期可修改配置」的整体守卫，
 * 而开发人员在开发期也要能改。往 handleConfig 里加字段级豁免，会让那句守卫文案变成谎言——
 * 下一个读 handleConfig 的人必然误判「这里所有字段都只能评审期改」。
 */
function handleAssignees(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (r.phase !== 'review' && r.phase !== 'dev') {
      return sendJson(res, 409, { error: '仅评审期与开发期可修改开发人员' });
    }
    if (!Array.isArray(data.assignees)) return sendJson(res, 400, { error: 'assignees 必须是数组' });
    const ids = [...new Set(data.assignees.filter((x) => typeof x === 'string' && x))];
    // 存在性校验：允许写入悬空 id 等于让「已移除的同事」凭空长出来，
    // 而这里的悬空只该由「先指派、后删同事」产生
    for (const cid of ids) {
      if (!getColleague(cid)) return sendJson(res, 400, { error: `同事不存在：${cid}` });
    }
    const updated = updateRequirement(id, { assignees: ids }, '更新开发人员');
    logger.info('req-routes', '更新开发人员', { reqId: id, count: ids.length });
    sendJson(res, 200, { assignees: updated.assignees });
  });
}

// ==== GET /api/req/colleague-messages?reqId=&colleagueId= ====
function handleColleagueMessages(url, res) {
  const reqId = str(url.searchParams.get('reqId'));
  const colleagueId = str(url.searchParams.get('colleagueId'));
  if (!reqId || !colleagueId) return sendJson(res, 400, { error: 'reqId / colleagueId 均必填' });
  if (!getRequirement(reqId)) return sendJson(res, 404, { error: '需求不存在' });
  const t = getThread(reqId, colleagueId);
  sendJson(res, 200, { messages: t.messages, lastInboundAt: t.lastInboundAt });
}

// ==== POST /api/req/colleague-messages/read {reqId, colleagueId} ====
function handleColleagueRead(req, res) {
  return withJsonBody(req, res, (data) => {
    const reqId = str(data.reqId);
    const colleagueId = str(data.colleagueId);
    if (!reqId || !colleagueId) return sendJson(res, 400, { error: 'reqId / colleagueId 均必填' });
    // 与同组另外三个端点一致地校验需求存在：markRead 对未知会话本就不写盘，
    // 但少这一句会让「需求已删」和「已读成功」回同一个 200，前端无从区分
    if (!getRequirement(reqId)) return sendJson(res, 404, { error: '需求不存在' });
    markRead(reqId, colleagueId);
    sendJson(res, 200, { ok: true });
  });
}

// ==== POST /api/req/colleague-messages/send {reqId, colleagueId, text} ====
function handleColleagueSend(req, res) {
  return withJsonBody(req, res, async (data) => {
    const reqId = str(data.reqId);
    const colleagueId = str(data.colleagueId);
    const text = str(data.text);
    if (!text) return sendJson(res, 400, { error: '消息内容不能为空' });
    const r = getRequirement(reqId);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (!(r.assignees || []).includes(colleagueId)) {
      return sendJson(res, 400, { error: '该同事不在本需求的开发人员里' });
    }
    const c = getColleague(colleagueId);
    if (!c) return sendJson(res, 400, { error: '同事不存在' });
    if (!c.feishuOpenId) return sendJson(res, 400, { error: `${c.name} 未填飞书 open_id，无法发送` });

    // 与二期同一硬约束：名册 open_id 是用启用机器人的凭证取的，open_id 是应用维度的，
    // 换个应用发根本对不上人
    const bot = getActiveBot();
    if (!bot?.appId || !bot?.appSecret) {
      return sendJson(res, 502, { error: '请先在「托管配置」里启用一个飞书机器人并填全凭证' });
    }
    let ok = false;
    try {
      ok = await sendTextToUser({ appId: bot.appId, appSecret: bot.appSecret }, c.feishuOpenId, text);
    } catch (e) {
      return sendJson(res, 502, { error: '发送失败：' + (e?.message || String(e)) });
    }
    // 发送失败不落消息：落了界面会显示一条其实没送达的消息，比不显示更糟
    if (!ok) return sendJson(res, 502, { error: '飞书发送失败，请检查机器人权限与 open_id' });
    const entry = appendMessage(reqId, colleagueId, { dir: 'out', text, status: 'read', role: c.role });
    logger.info('req-routes', '向同事发送消息', { reqId, colleagueId });
    sendJson(res, 200, { ok: true, message: entry });
  });
}

// ==== POST /api/req/colleague-messages/auto {reqId, colleagueId, msgIds} ====
// 飞书进程在消息归属确定后跨进程触发（四期）。路由只做四道校验就 202 交给 colleague-auto，
// 分类是 LLM 调用（秒级），不能让飞书侧的 3s 超时等它。
// handledBy 过滤在这里和 autoHandleMessages 内部各有一份，不要二选一删掉：路由这层是为了「一个 id 都不合法」
// 能直接 400 给飞书侧留痕；内部那层是因为 autoHandleMessages 是可独立调用的契约、不该信任调用方。
// 两层都只认 handledBy，而它在 run 收尾（onSettle）才写 —— 入队到收尾之间同 msgId 的重复触发两层都挡不住；
// 排队中的重复靠 enqueueSystemTask 按 msgId 去重，运行中的重复是已知限制（调用方 notifyAutoHandle 不重试）。
function handleColleagueAuto(req, res) {
  return withJsonBody(req, res, (data) => {
    const reqId = str(data.reqId);
    const colleagueId = str(data.colleagueId);
    // 去重：飞书侧偶发重复上报同一 msgId 时，若不去重 accepted 计数会虚高（[m,m] 报 2 实际只处理 1 条）
    const msgIds = [...new Set((Array.isArray(data.msgIds) ? data.msgIds : []).map((x) => str(x)).filter(Boolean))];
    // 拍板 #7：自动处理跟随 colleague-relay 插件启停。飞书侧附件链路（relayColleagueAttachment）是刻意绕过
    // 插件开关的（三期决定：不该因插件停用就让同事发的文档变成「不支持的消息类型」），所以开关只能在这里认——
    // 否则停用后文字不再中继、文件却仍会烧一次 Haiku 并起 bypassPermissions 的 run
    if (!getPluginEnabled('colleague-relay')) return sendJson(res, 409, { error: '同事消息中继插件已停用，不自动处理' });
    const r = getRequirement(reqId);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (r.phase !== 'dev') return sendJson(res, 409, { error: '仅开发期自动处理同事消息' });
    const c = getColleague(colleagueId);
    if (!c) return sendJson(res, 400, { error: '同事不存在' });
    if (c.role !== 'backend') return sendJson(res, 400, { error: '仅后端同事的消息自动处理' });
    if (!msgIds.length) return sendJson(res, 400, { error: 'msgIds 为空' });
    // 只认该线程里 dir=in 且尚未处理的：防重复触发与跨线程串号
    const known = new Set(getThread(reqId, colleagueId).messages.filter((m) => m.dir === 'in' && !m.handledBy).map((m) => m.id));
    const valid = msgIds.filter((id) => known.has(id));
    if (!valid.length) return sendJson(res, 400, { error: 'msgIds 不属于该线程或已处理' });
    // 路由级留痕：访问日志只有 method/path/status，看不到「传了 3 个 id 只受理 1 个」这种部分丢弃
    logger.info('req-routes', '同事消息自动处理已受理', { reqId, colleagueId, accepted: valid.length, rejected: msgIds.length - valid.length });
    sendJson(res, 202, { ok: true, accepted: valid.length });
    autoHandleMessages(r, colleagueId, valid).catch((e) =>
      logger.error('req-routes', '同事消息自动处理异常', { reqId, colleagueId, err: e?.message || String(e) }),
    );
  });
}

// ==== POST /api/req/doc-from-link {id,url?} ====
/**
 * 飞书云文档 → 需求文档快照。
 *
 * 首次拉取与「刷新」共用一个入口：url 省略时取 reqDoc.url 重拉，落盘覆盖同一份 req-doc.md。
 * 存快照而不是每次生成时实时取，有两个原因：下游 runDocgen/runQuizGen 读的是落盘文件（同步读），
 * 改实时取要把整条链路改成异步、且每次生成都多一个网络与权限失败点；更重要的是同一份需求的
 * 多次生成（首版 + 若干次修订）必须基于同一份正文，否则文档中途被人改过会导致问题无法复现。
 *
 * 代价是文档在飞书改了不会自动同步，靠界面上的拉取时间与「刷新」按钮兜住。
 */
function handleDocFromLink(req, res) {
  return withJsonBody(req, res, async (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (r.phase !== 'review') return sendJson(res, 409, { error: '仅评审设计期可修改配置' });

    const url = str(data.url) || str(r.reqDoc?.url); // 省略 url = 刷新当前来源
    if (!url) return sendJson(res, 400, { error: '缺少文档链接' });
    const link = extractDocLinks(url)[0];
    if (!link) return sendJson(res, 400, { error: '不是飞书云文档链接，只支持 /docx/ 与 /wiki/ 两种地址' });

    let content;
    try {
      let docToken = link.token;
      if (link.kind === 'wiki') {
        // wiki 链接指向的是节点不是文档，多维表格/画板同样用 wiki 地址分享，必须先问清类型，
        // 否则会拿一个 bitable token 去调 docx 接口，报错信息与真实原因对不上
        const node = await resolveWikiNodeObj(link.token);
        if (!node) return sendJson(res, 400, { error: 'wiki 节点不存在，或对机器人不可见' });
        if (node.objType !== 'docx') {
          return sendJson(res, 400, { error: `该 wiki 节点是「${node.objType}」而不是文档，不能作为需求文档` });
        }
        docToken = node.objToken;
      }
      content = await fetchDocRawContent(docToken);
    } catch (e) {
      const msg = e?.message || String(e);
      logger.warn('req-routes', '拉取飞书文档失败', { reqId: id, url, err: msg });
      // 最高频的失败原因是机器人不是该文档的协作者，错误里必须直接给出解法，
      // 否则用户只看到一句飞书原文的 permission denied，不知道该去哪儿点什么
      return sendJson(res, 502, {
        error: `拉取飞书文档失败：${msg}。请确认已把机器人加为该文档的协作者，且应用已开通云文档读取权限。`,
      });
    }

    if (!content.trim()) return sendJson(res, 400, { error: '文档内容为空，请确认链接指向的是需求正文' });
    const title = content.split('\n')[0]?.trim().slice(0, 30) || '飞书需求文档';
    const dr = buildReqDocPatch(id, {
      name: `${title}.md`,
      text: content,
      url,
      fetchedAt: new Date().toISOString(),
    });
    if (dr.error) return sendJson(res, 400, { error: dr.error });
    const updated = updateRequirement(id, { reqDoc: dr.value }, `拉取飞书需求文档「${title}」`);
    logger.info('req-routes', '飞书需求文档已落地', { reqId: id, title, chars: content.length });
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

// ==== GET /api/req/finalize-precheck?id= ====
// 定稿分支弹框的取数口：列出会建分支的开发工程、各自当前分支与本地分支清单。
// 单独一个端点而不是并进 /api/req/get：它要跑几条 git 子进程，而 get 是 3s 轮询的热路径
async function handleFinalizePrecheck(url, res) {
  const id = str(url.searchParams.get('id'));
  if (!getRequirement(id)) return sendJson(res, 404, { error: '需求不存在' });
  const r = await finalizePrecheck(id);
  if (!r.ok) return sendJson(res, r.status, { error: r.error });
  sendJson(res, 200, { ok: true, suggested: r.suggested, projects: r.projects });
}

// ==== POST /api/req/finalize {id,force,branchMode,branch} ====
function handleFinalize(req, res) {
  return withJsonBody(req, res, async (data) => {
    const id = str(data.id);
    if (!getRequirement(id)) return sendJson(res, 404, { error: '需求不存在' }); // 先 404，不让 finalizeGuard 对 null 回误导性 409
    // branchMode 白名单收口在这里：透传任意字符串的话 resolveTargetBranch 会走兜底自动命名，
    // 用户点了「沿用当前分支」却被静默开了新分支——比报错糟得多
    const rawMode = str(data.branchMode);
    const branchMode = rawMode === 'current' || rawMode === 'new' ? rawMode : '';
    const result = await finalizeRequirement(id, {
      force: !!data.force,
      branchMode,
      branch: str(data.branch),
    });
    if (!result.ok) {
      const body = { error: result.error };
      if (result.warn) {
        body.warn = result.warn;
        body.dirs = result.dirs; // 字段名须为 dirs，原样透传 ops 返回值
      }
      return sendJson(res, result.status, body);
    }
    // notified 原样透传：定稿是重要操作，「哪几位同事没收到、为什么」必须让用户看见，
    // 否则他会以为消息都送达了、等着对方回复
    sendJson(res, 200, { ok: true, branch: result.branch, notified: result.notified || null });
  });
}

// ==== POST /api/req/apidoc {id,name,path} / DELETE /api/req/apidoc {id,docId} ====
// 登记逻辑在 requirement-ops#registerApiDoc（与同事消息自动处理共用），路由只做 body 归一与状态码映射
function handleApidocPost(req, res) {
  return withJsonBody(req, res, (data) => {
    const result = registerApiDoc(getRequirement(str(data.id)), { name: str(data.name), path: str(data.path) });
    if (!result.ok) return sendJson(res, result.status, { error: result.error });
    sendJson(res, 202, { ok: true, action: result.action, doc: result.doc });
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

// ==== POST /api/req/delete {id} ====
// 物理移除已废弃的需求。只开放给 discarded：活跃需求的入口是「废弃」，已归档需求是存档不该删，
// 侧栏右键菜单也只对废弃行给「移除」——这里把同一条契约在服务端再钉一遍，防 API 直调绕过。
function handleDelete(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { error: 'id 不能为空' });
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (r.phase !== 'discarded') return sendJson(res, 409, { error: '仅已废弃的需求可移除' });
    if (r.busy || hasQueuedTasks(id)) return sendJson(res, 409, { error: '有任务进行中或排队，请稍候' });

    // 会话 id 必须在删记录之前取：删完就再也查不到它绑过哪些 conv，
    // 前端 localStorage 里的聊天记录就会变成永远清不掉的孤儿。
    const convIds = [...new Set(normalizeSessions(r).map((s) => s.convId).filter(Boolean))];

    deleteRequirement(id);
    // 磁盘产物与同事对话紧随其后。两者失败都不回滚记录——记录已删是用户看得见的结果，
    // 为残留文件把需求变回来只会更费解；留 warn 供事后清理。
    try {
      fs.rmSync(reqDir(id), { recursive: true, force: true });
    } catch (e) {
      logger.warn('req-routes', '移除需求目录失败', { reqId: id, err: e?.message || String(e) });
    }
    try {
      dropReqThreads(id);
    } catch (e) {
      logger.warn('req-routes', '移除同事对话失败', { reqId: id, err: e?.message || String(e) });
    }
    logger.info('req-routes', '移除需求', { reqId: id, convIds: convIds.length });
    sendJson(res, 200, { ok: true, convIds });
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

// ==== PUT /api/req/feature-tag ====
function handleFeatureTag(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { error: 'id 不能为空' });
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    // tag 为空字符串视为清除
    const tag = str(data.tag) || null;
    if (tag && tag.length > 20) return sendJson(res, 400, { error: 'tag 不能超过 20 字符' });
    updateRequirement(id, { featureTag: tag }, tag ? `手动设置功能模块标签：${tag}` : '清除功能模块标签');
    sendJson(res, 200, { ok: true, featureTag: tag });
  });
}

// ==== POST /api/req/docgen/stop ====
function handleDocgenStop(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { error: 'id 不能为空' });

    const abort = docgenAborts.get(id);
    if (!abort) return sendJson(res, 404, { error: '无进行中的生成任务' });

    // 标记用户主动停止，runDocgen 的 catch 里据此区分事件类型
    userStoppedSet.add(id);
    try {
      abort.abort(new Error('用户停止'));
    } catch (e) {
      logger.warn('req-routes', 'docgenStop abort 调用异常', { reqId: id, err: e?.message });
    }
    logger.info('req-routes', 'docgen 停止已请求', { reqId: id });
    return sendJson(res, 200, { ok: true });
  });
}

// ==== GET /api/feature-index ====
function handleFeatureIndex(res) {
  sendJson(res, 200, { index: getFeatureIndex() });
}

/** 需求工作流路由单入口：按 pathname + method 分发 */
export function handleRequirementRoutes(req, res, url) {
  const { pathname } = url;
  const { method } = req;
  // 需求 v2（问卷/地图/变动/UI 规范）单独成文件，命中即返回；未命中落回下面的原分发表
  if (handleReqV2Routes(req, res, url, pathname, method)) return;
  if (pathname === '/api/req/create' && method === 'POST') return handleCreate(req, res);
  if (pathname === '/api/req/list' && method === 'GET') return handleList(res);
  if (pathname === '/api/req/get' && method === 'GET') return handleGet(url, res);
  if (pathname === '/api/req/doc' && method === 'GET') return handleDoc(url, res);
  if (pathname === '/api/req/config' && method === 'PUT') return handleConfig(req, res);
  if (pathname === '/api/req/assignees' && method === 'PUT') return handleAssignees(req, res);
  if (pathname === '/api/req/colleague-messages' && method === 'GET') return handleColleagueMessages(url, res);
  if (pathname === '/api/req/colleague-messages/read' && method === 'POST') return handleColleagueRead(req, res);
  if (pathname === '/api/req/colleague-messages/send' && method === 'POST') return handleColleagueSend(req, res);
  if (pathname === '/api/req/colleague-messages/auto' && method === 'POST') return handleColleagueAuto(req, res);
  if (pathname === '/api/req/doc-from-link' && method === 'POST') return handleDocFromLink(req, res);
  if (pathname === '/api/req/docgen' && method === 'POST') return handleDocgen(req, res);
  if (pathname === '/api/req/docgen/stop' && method === 'POST') return handleDocgenStop(req, res);
  if (pathname === '/api/req/supplement' && method === 'POST') return handleSupplement(req, res);
  if (pathname === '/api/req/finalize-precheck' && method === 'GET') return handleFinalizePrecheck(url, res);
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
  if (pathname === '/api/req/delete' && method === 'POST') return handleDelete(req, res);
  if (pathname === '/api/req/bitable' && method === 'POST') return handleBitable(req, res);
  if (pathname === '/api/req/bug/confirm' && method === 'POST') return handleBugConfirm(req, res);
  if (pathname === '/api/req/bug/ignore' && method === 'POST') return handleBugIgnore(req, res);
  if (pathname === '/api/req/bug/retry' && method === 'POST') return handleBugRetry(req, res);
  if (pathname === '/api/req/feature-tag' && method === 'PUT') return handleFeatureTag(req, res);
  if (pathname === '/api/feature-index' && method === 'GET') return handleFeatureIndex(res);
  return sendJson(res, 404, { error: 'not found' });
}

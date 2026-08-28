/**
 * web 入口：需求 v2 路由（问卷 / 需求地图 / 需求变动 / UI 规范）。
 *
 * 单独成文件而不是继续往 routes-requirements.js 里堆——那个文件已经 640+ 行、承载 22 条路由。
 * 分发入口 handleReqV2Routes 由 routes-requirements.js 在自身分发表之前调用。
 *
 * 路由层职责只有三件：鉴权/存在性校验、body 归一、把活交给 ops。任何 prompt 拼装、
 * LLM 输出解析都不在这里（在 *.logic.js），任何 busy/队列判定都不在这里（在 requirement-ops.js）。
 */
import { getRequirement, updateRequirement } from '../../store/requirements.js';
import {
  enqueueSystemTask,
  hasQueuedTasks,
  readMapVersion,
  writeMapVersion,
  computeChangeImpact,
  DOCGEN_GUIDE,
} from './requirement-ops.js';
import { pickCwdAndDirs } from './req-logic.js';
import { UNSURE_VALUE } from './req-quiz.logic.js';
import { collectAnnotLines } from './req-map.logic.js';
import { buildRestorePrompt, buildSpecDraftPrompt } from './req-uispec.logic.js';
import { readUiSpec, writeUiSpec } from '../../store/ui-specs.js';
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';
import { logger } from '../../shared/logger.js';

const ANNOT_TEXT_MAX = 2000;
const CHANGE_TEXT_MAX = 5000;
const PRIME_TEXT_MAX = 5000; // 背景补充比单条标注宽松：用户可能贴一整段历史复盘

/** 取需求；不存在时直接回 404 并返回 null，让调用方 `if (!r) return;` 收尾。 */
function mustGet(res, id) {
  const r = getRequirement(id);
  if (!r) {
    sendJson(res, 404, { error: '需求不存在' });
    return null;
  }
  return r;
}

/** 取需求 + 当前版地图；任一缺失即回错并返回 null。 */
function mustGetMap(res, id) {
  const r = mustGet(res, id);
  if (!r) return null;
  const map = readMapVersion(r);
  if (!map) {
    sendJson(res, 409, { error: '该需求尚无需求地图' });
    return null;
  }
  return { r, map };
}

// ==== POST /api/req/quiz {id} —— 生成不确定点问卷 ====
function handleQuizGen(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = mustGet(res, id);
    if (!r) return;
    if (r.phase !== 'review') return sendJson(res, 409, { error: '仅评审设计期可生成问卷' });
    const { cwd } = pickCwdAndDirs(r.projects);
    if (!cwd || !r.reqDoc) return sendJson(res, 400, { error: DOCGEN_GUIDE });
    if (r.busy || hasQueuedTasks(id)) return sendJson(res, 409, { error: '已有任务在进行或排队' });
    logger.info('req-v2', '收到生成问卷请求', { reqId: id });
    enqueueSystemTask(id, 'quizgen', {});
    sendJson(res, 202, { ok: true });
  });
}

// ==== PUT /api/req/prime {id, text, files} —— 存生成前背景（只落盘，不触发生成）====
// 与 POST /api/req/supplement 的区别：后者是「对已有文档提调整」，每次提交都入队 docgen；
// prime 是一份可反复编辑的草稿，随下一次生成一并生效，所以这里绝不 enqueue。
// 前端按防抖自动保存，故必须允许清空（text 与 files 都空 = 用户删干净了）。
function handlePrimePut(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = mustGet(res, id);
    if (!r) return;
    if (r.phase !== 'review') return sendJson(res, 409, { error: '仅评审设计期可编辑背景补充' });

    const text = str(data.text).slice(0, PRIME_TEXT_MAX);
    const files = (Array.isArray(data.files) ? data.files : [])
      .map((f) => ({ name: str(f?.name), path: str(f?.path) }))
      .filter((f) => f.name || f.path); // 剔除 name/path 均空的占位条目
    const prime = text || files.length ? { text, files, at: new Date().toISOString() } : null;

    // 自动保存会高频调用，逐次写 history 会把时间线冲爆 —— 省略 event 即不留痕
    updateRequirement(id, { prime });
    sendJson(res, 200, { ok: true, chars: text.length, files: files.length });
  });
}

// ==== PUT /api/req/quiz {id, answers} —— 存答案并触发 docgen ====
function handleQuizAnswers(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = mustGet(res, id);
    if (!r) return;
    if (r.phase !== 'review') return sendJson(res, 409, { error: '仅评审设计期可提交问卷' });
    if (!r.quiz?.questions?.length) return sendJson(res, 409, { error: '当前没有待答问卷' });
    if (r.busy || hasQueuedTasks(id)) return sendJson(res, 409, { error: '已有任务在进行或排队' });

    // 只认问卷里真实存在的题与选项：前端传错/脏数据不该污染 docgen prompt。
    // UNSURE_VALUE 是前端注入的「不确定」，不在 LLM 出的 opts 里，需显式放行。
    const valid = new Map(r.quiz.questions.map((q) => [q.id, new Set(q.opts.map((o) => o.v))]));
    const incoming = data.answers && typeof data.answers === 'object' ? data.answers : {};
    const answers = {};
    for (const [qid, a] of Object.entries(incoming)) {
      const opts = valid.get(qid);
      if (!opts) continue;
      const v = str(a?.v);
      // 必答规则下「只写补充不选项」不再算作答：逃生口是每题的「不确定」，
      // 而不是留空。否则前端的必答校验形同虚设，绕过接口就能提交半份问卷。
      if (!opts.has(v) && v !== UNSURE_VALUE) continue;
      answers[qid] = { v, note: str(a?.note).slice(0, ANNOT_TEXT_MAX) };
    }

    const total = r.quiz.questions.length;
    const done = Object.keys(answers).length;
    if (done < total) {
      return sendJson(res, 400, {
        error: `还有 ${total - done} 题未作答。不确定的题可以选「不确定」，但不能留空。`,
      });
    }

    updateRequirement(id, { quiz: { ...r.quiz, answers, status: 'answered' } }, '问卷已作答（' + done + '/' + total + '）');
    enqueueSystemTask(id, 'docgen', {}); // docgen 成功后会自行续跑 mapgen，产出双报告
    sendJson(res, 202, { ok: true, answered: done });
  });
}

// ==== GET /api/req/map?id=&v= —— 地图 JSON 原文 ====
function handleMapGet(url, res) {
  const id = str(url.searchParams.get('id'));
  const r = mustGet(res, id);
  if (!r) return;
  const vRaw = str(url.searchParams.get('v'));
  const map = readMapVersion(r, vRaw ? Number(vRaw) : null);
  if (!map) return sendJson(res, 404, { error: '该版本地图不存在' });
  sendJson(res, 200, { map, versions: (r.reqMap?.versions || []).map((x) => ({ v: x.v, at: x.at })) });
}

// ==== PUT /api/req/map/figma {id, pageId, url, node} —— 挂/解绑设计稿（就地改当前版，不升版本）====
function handleMapFigma(req, res) {
  return withJsonBody(req, res, (data) => {
    const got = mustGetMap(res, str(data.id));
    if (!got) return;
    const { r, map } = got;
    const page = map.pages.find((p) => p.id === str(data.pageId));
    if (!page) return sendJson(res, 404, { error: '页面不存在' });

    const url = str(data.url);
    if (url) {
      page.figma = { url, node: str(data.node) };
    } else {
      // 解绑连带清掉还原时间：设计稿都换了，"已还原"这个状态不再成立
      page.figma = null;
      page.restoredAt = null;
    }
    writeMapVersion(r, map);
    updateRequirement(r.id, {}, (url ? '挂载' : '解绑') + '设计稿：' + page.name);
    sendJson(res, 200, { ok: true, page });
  });
}

// ==== POST /api/req/map/restore {id, pageId} —— 按 UI 规范还原 ====
// 服务端只负责「记状态 + 拼 prompt」，真正的发送由前端 sendMessageProgrammatically 完成
//（与 API 文档上传后自动发对照修正消息同款范式，见 req-chat.js）。
function handleMapRestore(req, res) {
  return withJsonBody(req, res, (data) => {
    const got = mustGetMap(res, str(data.id));
    if (!got) return;
    const { r, map } = got;
    const page = map.pages.find((p) => p.id === str(data.pageId));
    if (!page) return sendJson(res, 404, { error: '页面不存在' });

    // UI 规范按「第一个工程」归属，与 docgen/开发任务的 cwd 同源
    const { cwd } = pickCwdAndDirs(r.projects);
    let prompt;
    try {
      prompt = buildRestorePrompt({ page, specText: readUiSpec(cwd) });
    } catch (e) {
      return sendJson(res, 400, { error: e?.message || '无法生成还原任务' });
    }
    page.restoredAt = new Date().toISOString();
    writeMapVersion(r, map);
    updateRequirement(r.id, {}, '触发 UI 还原：' + page.name);
    sendJson(res, 200, { ok: true, prompt, hasSpec: !!readUiSpec(cwd).trim() });
  });
}

// ==== PUT /api/req/map/annots {id, annots} —— 保存标注（就地改当前版，不升版本）====
function handleMapAnnots(req, res) {
  return withJsonBody(req, res, (data) => {
    const got = mustGetMap(res, str(data.id));
    if (!got) return;
    const { r, map } = got;

    const known = new Set();
    for (const p of map.pages) for (const pt of p.points || []) known.add(pt.id);
    const incoming = data.annots && typeof data.annots === 'object' ? data.annots : {};
    const annots = {};
    for (const [pointId, a] of Object.entries(incoming)) {
      if (!known.has(pointId)) continue; // 指向已不存在的逻辑点：丢弃
      const verdict = str(a?.verdict);
      if (verdict !== 'wrong' && verdict !== 'ok') continue;
      const text = str(a?.text).slice(0, ANNOT_TEXT_MAX);
      if (verdict === 'wrong' && !text) continue; // 「有误」必须写理由，否则修订时没东西可依据
      annots[pointId] = { verdict, text, at: new Date().toISOString() };
    }
    map.annots = annots;
    writeMapVersion(r, map);
    sendJson(res, 200, { ok: true, count: Object.keys(annots).length });
  });
}

// ==== POST /api/req/map/annotate {id} —— 提交标注，入队一轮修订 ====
function handleMapAnnotate(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const got = mustGetMap(res, id);
    if (!got) return;
    const { r, map } = got;
    if (r.phase !== 'review') return sendJson(res, 409, { error: '仅评审设计期可提交标注修订' });
    if (r.busy || hasQueuedTasks(id)) return sendJson(res, 409, { error: '已有任务在进行或排队' });
    // 与 buildMapFixPrompt 用同一个判据，避免「这里放行、派发时才抛」的空跑
    if (!collectAnnotLines(map, map.annots || {}).length) {
      return sendJson(res, 400, { error: '至少标记一处「有误」并写明理由才能提交修订' });
    }
    enqueueSystemTask(id, 'mapfix', {});
    sendJson(res, 202, { ok: true });
  });
}

// ==== POST /api/req/map/regen {id} —— 以当前代码为准重新生成地图 ====
// 与 mapfix/mapchange 的区别：那两条是「拿上一版改」，这条是全量重扫（开发途中改了逻辑，
// 旧地图已经对不上代码了）。刻意**不要求已有地图**——地图从没生成成功过时（如 docgen 后的
// mapgen 挂了），这里是唯一的重试入口。
function handleMapRegen(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = mustGet(res, id);
    if (!r) return;
    if (r.phase !== 'review' && r.phase !== 'dev' && r.phase !== 'test') {
      return sendJson(res, 409, { error: '仅评审/开发/测试期可重新生成需求地图' });
    }
    if (!r.devDoc?.versions?.length) return sendJson(res, 409, { error: '请先生成开发文档' });
    const { cwd } = pickCwdAndDirs(r.projects);
    if (!cwd) return sendJson(res, 400, { error: DOCGEN_GUIDE });
    if (r.busy || hasQueuedTasks(id)) return sendJson(res, 409, { error: '已有任务在进行或排队' });
    logger.info('req-v2', '收到重新生成地图请求', { reqId: id, phase: r.phase });
    enqueueSystemTask(id, 'mapregen', {});
    sendJson(res, 202, { ok: true });
  });
}

// ==== POST /api/req/change/impact {id, text} —— 影响预估（同步，用户在弹框里等）====
async function handleChangeImpact(req, res) {
  return withJsonBody(req, res, async (data) => {
    const r = mustGet(res, str(data.id));
    if (!r) return;
    const text = str(data.text).slice(0, CHANGE_TEXT_MAX);
    if (!text) return sendJson(res, 400, { error: '请先描述变动内容' });
    try {
      const hits = await computeChangeImpact(r, text);
      sendJson(res, 200, { hits });
    } catch (e) {
      // 预估失败不该挡住提交，前端拿到空数组照常走
      logger.warn('req-v2', '影响预估异常（降级为空）', { reqId: r.id, err: e?.message || String(e) });
      sendJson(res, 200, { hits: [] });
    }
  });
}

// ==== POST /api/req/change {id, text, scope} —— 提交需求变动 ====
function handleChange(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = mustGet(res, id);
    if (!r) return;
    if (r.phase !== 'dev' && r.phase !== 'test') {
      return sendJson(res, 409, { error: '仅开发/测试期可提交需求变动（评审期请改需求文档或提补充说明）' });
    }
    const text = str(data.text).slice(0, CHANGE_TEXT_MAX);
    if (!text) return sendJson(res, 400, { error: '请先描述变动内容' });
    // 非法值归 'both'：它是弹框里的默认选中项，与用户不改任何设置直接提交的预期一致
    const scope = data.scope === 'map' ? 'map' : 'both';

    const hits = Array.isArray(data.hits)
      ? data.hits.map((h) => str(h?.pointId)).filter(Boolean)
      : [];
    const change = {
      id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text,
      scope,
      hits,
      at: new Date().toISOString(),
    };
    updateRequirement(id, { changes: [...(r.changes || []), change] }, '需求变动：' + text.slice(0, 30));

    // 有地图才值得跑一轮更新；没有就只留记录，用户照样能把变动发进会话
    const hasMap = !!(r.reqMap?.versions || []).length;
    if (hasMap) enqueueSystemTask(id, 'mapchange', { changeId: change.id, text });

    sendJson(res, 200, {
      ok: true,
      change,
      mapQueued: hasMap,
      // scope=both 时前端把这段发进需求会话让 Claude 改代码；scope=map 时不发
      prompt: scope === 'both' ? buildChangeMessage(text, data.hits) : null,
    });
  });
}

/** 需求变动 → 发进需求会话的消息正文（带上影响预估，省得 Claude 再自己找一遍）。 */
function buildChangeMessage(text, hits) {
  const lines = (Array.isArray(hits) ? hits : [])
    .map((h) => '- ' + str(h?.pageName) + ' · ' + str(h?.title) + '（' + str(h?.action) + '）' + (str(h?.why) ? '：' + str(h.why) : ''))
    .filter((l) => l.length > 6);
  return (
    '【需求变动】\n' + text + '\n\n' +
    (lines.length ? '已比对需求地图，命中以下逻辑点：\n' + lines.join('\n') + '\n\n' : '') +
    '请据此调整已实现的代码；与本次变动无关的部分不要动。'
  );
}

// ==== GET /api/req/uispec?dir= —— 读项目 UI 规范 ====
function handleUiSpecGet(url, res) {
  const dir = str(url.searchParams.get('dir'));
  if (!dir) return sendJson(res, 400, { error: '缺少 dir' });
  sendJson(res, 200, { dir, text: readUiSpec(dir) });
}

// ==== PUT /api/req/uispec {dir, text} —— 保存项目 UI 规范 ====
function handleUiSpecPut(req, res) {
  return withJsonBody(req, res, (data) => {
    const dir = str(data.dir);
    if (!dir) return sendJson(res, 400, { error: '缺少 dir' });
    // text 允许为空串（清空规范是合法操作），但必须是字符串
    const text = typeof data.text === 'string' ? data.text : '';
    try {
      writeUiSpec(dir, text);
    } catch (e) {
      return sendJson(res, 500, { error: '保存失败：' + (e?.message || String(e)) });
    }
    logger.info('req-v2', 'UI 规范已保存', { dir, chars: text.length });
    sendJson(res, 200, { ok: true, chars: text.length });
  });
}

// ==== POST /api/req/uispec/draft {dir} —— 返回抽草稿的 prompt（由前端发进会话）====
function handleUiSpecDraft(req, res) {
  return withJsonBody(req, res, (data) => {
    const dir = str(data.dir);
    if (!dir) return sendJson(res, 400, { error: '缺少 dir' });
    sendJson(res, 200, { ok: true, prompt: buildSpecDraftPrompt({ dir }) });
  });
}

// ==== POST /api/req/dev-prompt-claim {id} —— develop 首轮提示词领票 ====
/**
 * granted:true 表示「本次由你负责发」，同时落 devPromptSentAt。
 *
 * 为什么是「先领票再发」而不是「发完再标记」：前端原判据（localStorage 里会话有没有内容）
 * 在多窗口下会同时为 false，两边各发一遍。领票把并发挡在 updateJson 的文件锁里；
 * 反过来「发完再标记」挡不住——两个窗口都会先通过判断。
 */
function handleDevPromptClaim(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { error: '缺少 id' });
    const r = getRequirement(id);
    if (!r) return sendJson(res, 400, { error: '需求不存在' });
    if (r.devPromptSentAt) return sendJson(res, 200, { ok: true, granted: false });
    // 存量兜底：上线前进入过开发期的需求没有本字段，但 devSession 非空即说明系统任务跑过。
    // 不兜的话所有历史需求在首次打开时都会被补发一次提示词 —— 那正是本次要修的 bug。
    // 回填用当前时间：它只是「已发过」的标记位，不谎称是历史时间。
    const already = !!r.devSession;
    updateRequirement(id, { devPromptSentAt: new Date().toISOString() });
    return sendJson(res, 200, { ok: true, granted: !already });
  });
}

/** 分发入口：命中返回 true（已处理），未命中返回 false 交回原分发表。 */
export function handleReqV2Routes(req, res, url, pathname, method) {
  if (pathname === '/api/req/quiz' && method === 'POST') return handleQuizGen(req, res), true;
  if (pathname === '/api/req/quiz' && method === 'PUT') return handleQuizAnswers(req, res), true;
  if (pathname === '/api/req/prime' && method === 'PUT') return handlePrimePut(req, res), true;
  if (pathname === '/api/req/map' && method === 'GET') return handleMapGet(url, res), true;
  if (pathname === '/api/req/map/figma' && method === 'PUT') return handleMapFigma(req, res), true;
  if (pathname === '/api/req/map/restore' && method === 'POST') return handleMapRestore(req, res), true;
  if (pathname === '/api/req/map/annots' && method === 'PUT') return handleMapAnnots(req, res), true;
  if (pathname === '/api/req/map/annotate' && method === 'POST') return handleMapAnnotate(req, res), true;
  if (pathname === '/api/req/map/regen' && method === 'POST') return handleMapRegen(req, res), true;
  if (pathname === '/api/req/change/impact' && method === 'POST') return handleChangeImpact(req, res), true;
  if (pathname === '/api/req/change' && method === 'POST') return handleChange(req, res), true;
  if (pathname === '/api/req/uispec' && method === 'GET') return handleUiSpecGet(url, res), true;
  if (pathname === '/api/req/uispec' && method === 'PUT') return handleUiSpecPut(req, res), true;
  if (pathname === '/api/req/uispec/draft' && method === 'POST') return handleUiSpecDraft(req, res), true;
  if (pathname === '/api/req/dev-prompt-claim' && method === 'POST') return handleDevPromptClaim(req, res), true;
  return false;
}

/**
 * 同事名册 HTTP 接口。沿用本项目单入口子路由范式（对齐 routes-memory.js）。
 * 单条 prefix 同时覆盖 /api/colleagues 与 /api/colleagues/:id，不必在 ROUTES 表登记两行，
 * 也就不存在前缀遮蔽精确路由的问题。
 */
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { safeDecodeId, str } from './input.js';
import { logger } from '../../shared/logger.js';
import {
  ROLES,
  getColleagues,
  addColleague,
  addColleaguesBatch,
  updateColleague,
  removeColleague,
  validateColleagueInput,
} from '../../store/colleagues.js';
import { getActiveBot } from '../../store/settings.js';
import { listBotChats, listChatMembers } from '../../integrations/lark.js';

// ==== GET /api/colleagues ====
function handleList(res) {
  sendJson(res, 200, { roles: ROLES, colleagues: getColleagues() });
}

// ==== POST /api/colleagues {role,name,note,feishuOpenId} ====
function handleCreate(req, res) {
  return withJsonBody(req, res, (data) => {
    const v = validateColleagueInput(data);
    if (v.error) return sendJson(res, 400, { error: v.error });
    const colleague = addColleague(v.value);
    logger.info('web', '[POST /api/colleagues] 新增同事', { id: colleague.id, role: colleague.role });
    sendJson(res, 201, { colleague });
  });
}

// ==== PUT /api/colleagues/:id ====
function handleUpdate(req, res, id) {
  return withJsonBody(req, res, (data) => {
    const v = validateColleagueInput(data);
    if (v.error) return sendJson(res, 400, { error: v.error });
    const colleague = updateColleague(id, v.value);
    if (!colleague) return sendJson(res, 404, { error: '同事不存在' });
    sendJson(res, 200, { colleague });
  });
}

// ==== DELETE /api/colleagues/:id ====
function handleDelete(res, id) {
  if (!removeColleague(id)) return sendJson(res, 404, { error: '同事不存在' });
  logger.info('web', '[DELETE /api/colleagues] 删除同事', { id });
  sendJson(res, 200, { ok: true });
}

// ==== POST /api/colleagues/batch {colleagues:[{role,name,note,feishuOpenId}]} ====
function handleBatch(req, res) {
  return withJsonBody(req, res, (data) => {
    if (!Array.isArray(data.colleagues)) return sendJson(res, 400, { error: 'colleagues 必须是数组' });
    let r;
    try {
      // store 的整批原子校验会对非法条目抛错，此处转成 400（半批写入的危害见 addColleaguesBatch 注释）
      r = addColleaguesBatch(data.colleagues);
    } catch (e) {
      return sendJson(res, 400, { error: e?.message || String(e) });
    }
    logger.info('web', '[POST /api/colleagues/batch] 批量导入同事', { added: r.added.length, skipped: r.skipped.length });
    sendJson(res, 200, { added: r.added.length, skipped: r.skipped.length, colleagues: r.added });
  });
}

/** 取当前生效的飞书机器人凭证；未配置则返回 null（调用方回 502 + 指路文案） */
function activeFeishuCreds() {
  const bot = getActiveBot();
  if (!bot || bot.platform !== 'feishu' || !bot.appId || !bot.appSecret) return null;
  return { appId: bot.appId, appSecret: bot.appSecret };
}

// ==== GET /api/colleagues/feishu/chats ====
async function handleFeishuChats(res) {
  const creds = activeFeishuCreds();
  if (!creds) return sendJson(res, 502, { error: '请先在「托管配置」里启用一个飞书机器人并填全凭证' });
  const { chats, error } = await listBotChats(creds);
  if (error) return sendJson(res, 502, { error: '拉取群列表失败：' + error });
  sendJson(res, 200, { chats });
}

// ==== GET /api/colleagues/feishu/members?chatId=xxx ====
async function handleFeishuMembers(res, url) {
  const chatId = str(url.searchParams.get('chatId'));
  if (!chatId) return sendJson(res, 400, { error: 'chatId 不能为空' });
  const creds = activeFeishuCreds();
  if (!creds) return sendJson(res, 502, { error: '请先在「托管配置」里启用一个飞书机器人并填全凭证' });
  const { members, error } = await listChatMembers(creds, chatId);
  if (error) return sendJson(res, 502, { error: '拉取群成员失败：' + error });
  // 标出已在名册里的人：前端据此置灰，用户不必自己比对 22 个 open_id
  const known = new Set(getColleagues().map((c) => c.feishuOpenId).filter(Boolean));
  sendJson(res, 200, { members: members.map((m) => ({ ...m, exists: known.has(m.openId) })) });
}

/**
 * 同事名册路由单入口：按 pathname + method 分发。
 *
 * ⚠️ 顺序契约：`/batch` 与 `/feishu/*` 这些**子路径必须排在 `startsWith` 的 :id 分支之前**。
 * 否则它们会被当成 id=「batch」/「feishu/chats」的条目去操作，症状是静默 404「同事不存在」，
 * 而不是任何一眼看得出是路由问题的报错。routes-colleagues.test.js 有专门用例钉住这条。
 */
export function handleColleagueRoutes(req, res, url) {
  const { pathname } = url;
  const { method } = req;
  if (pathname === '/api/colleagues' && method === 'GET') return handleList(res);
  if (pathname === '/api/colleagues' && method === 'POST') return handleCreate(req, res);
  if (pathname === '/api/colleagues/batch' && method === 'POST') return handleBatch(req, res);
  if (pathname === '/api/colleagues/feishu/chats' && method === 'GET') return handleFeishuChats(res);
  if (pathname === '/api/colleagues/feishu/members' && method === 'GET') return handleFeishuMembers(res, url);
  // 子路径已在上面收口，剩下的才可能是 :id。多段路径（含 /）一律不是合法 id，落 404
  if (pathname.startsWith('/api/colleagues/') && !pathname.slice('/api/colleagues/'.length).includes('/')) {
    // safeDecodeId 而非裸 decodeURIComponent：`DELETE /api/colleagues/%` 会抛 URIError，
    // 抛在 request 监听器主体里 → uncaughtException → 进程退出（见 input.js 注释）
    const id = safeDecodeId(pathname.slice('/api/colleagues/'.length));
    if (!id) return sendJson(res, 400, { error: '无效的 id' });
    if (method === 'PUT') return handleUpdate(req, res, id);
    if (method === 'DELETE') return handleDelete(res, id);
  }
  return sendJson(res, 404, { error: 'not found' });
}

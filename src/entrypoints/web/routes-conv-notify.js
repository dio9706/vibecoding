/**
 * 会话飞书通知路由。
 *
 * /on /off /sync /inbox /claim 由前端调用；/inject 由**飞书进程**跨进程调用
 * （同机回环 127.0.0.1，无 Origin 头 —— origin.js 的 checkOrigin 对无 Origin 放行，
 * 与 /internal/notify 同一条豁免路径，见 origin.js 注释）。
 *
 * 单入口分发范式对齐 routes-memory.js / routes-requirements.js，唯一区别：
 * 未命中时 return false 而不是直接 404，让 server.js 继续往后匹配（详见文件末尾）。
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str, normalizeMode } from './input.js';
import { getEntry, enableConv, disableConv, patchConv, claimInjections } from '../../store/conv-notify.js';
import { getMyFeishuOpenId, getActiveBot } from '../../store/settings.js';
import { injectToConv } from './conv-notify.js';

/**
 * /sync 可覆盖的快照字段。
 * convId 不在内：它是主键，不允许被 patch 改掉。
 * mode 也不在内：它必须过 normalizeMode，在下面单独处理。
 */
const SYNC_FIELDS = ['title', 'session', 'cwd', 'model', 'effort'];

const notAllowed = (res) => sendJson(res, 405, { error: 'method not allowed' });

// ==== POST /api/conv-notify/on {convId, title, session, cwd, model, effort, mode} ====
function handleOn(req, res) {
  if (req.method !== 'POST') return notAllowed(res);
  return withJsonBody(req, res, (data) => {
    const convId = str(data.convId);
    if (!convId) return sendJson(res, 400, { error: 'convId 不能为空' });

    // 前置校验故意回 **200 + ok:false** 而不是 4xx：前端要据此弹 toast 说明原因
    // 并且**不点亮**通知按钮。若回 4xx，前端的通用错误处理只会报一句「网络错误」，
    // 用户既看不到「去设置页填 open_id」这个可执行的下一步，也无从判断按钮该不该亮。
    if (!getMyFeishuOpenId()) {
      return sendJson(res, 200, { ok: false, error: '请先到设置页填写「我的飞书 open_id」' });
    }
    const bot = getActiveBot();
    if (!bot?.appId || !bot?.appSecret) {
      return sendJson(res, 200, { ok: false, error: '请先在设置页启用一个飞书机器人并填全凭证' });
    }

    const entry = enableConv({
      convId,
      title: str(data.title),
      session: str(data.session),
      cwd: str(data.cwd),
      model: str(data.model), // 'auto' 是合法存储值（UI 哨兵），透传给 SDK 前才在 conv-notify.js 归一，此处不得过滤
      effort: str(data.effort),
      // mode 会原样落到 SDK 的 permissionMode（其中 bypassPermissions = 免审批执行任意工具），
      // 绝不能透传请求体字符串 —— 非法值 fail-closed 降级 'default'，同 routes-run.js 的 /api/run/start。
      mode: normalizeMode(data.mode),
    });
    return sendJson(res, 200, { ok: true, entry });
  });
}

// ==== POST /api/conv-notify/off {convId} ====
function handleOff(req, res) {
  if (req.method !== 'POST') return notAllowed(res);
  return withJsonBody(req, res, (data) => {
    const convId = str(data.convId);
    if (!convId) return sendJson(res, 400, { error: 'convId 不能为空' });
    disableConv(convId);
    return sendJson(res, 200, { ok: true });
  });
}

// ==== POST /api/conv-notify/sync {convId, title?, session?, cwd?, model?, effort?, mode?} ====
function handleSync(req, res) {
  if (req.method !== 'POST') return notAllowed(res);
  return withJsonBody(req, res, (data) => {
    const convId = str(data.convId);
    if (!convId) return sendJson(res, 400, { error: 'convId 不能为空' });
    // 只并入非空字符串：前端心跳式上报常带 undefined/''（如还没拿到 session id），
    // 原样 patch 会把已存的好值抹成空，导致飞书侧 resume 不回原会话。
    const patch = {};
    for (const k of SYNC_FIELDS) {
      const v = str(data[k]);
      if (v) patch[k] = v;
    }
    // mode 必须「先判空、再归一」，两步不能合并成 patch.mode = normalizeMode(data.mode)：
    // normalizeMode('') 返回 'default'，而心跳常常不带 mode，合并后会把已存的
    // bypassPermissions 悄悄降级。判空在前 → 缺字段不动存量，真传了非法值才 fail-closed。
    const rawMode = str(data.mode);
    if (rawMode) patch.mode = normalizeMode(rawMode);
    // 无字段可更新时走只读的 getEntry：patchConv 哪怕空 patch 也会落盘一次，
    // 而 /sync 是高频心跳，白写盘纯属浪费（还会跟 store 的文件锁抢）。
    const entry = Object.keys(patch).length ? patchConv(convId, patch) : getEntry(convId);
    // 未激活会话 patchConv 是 no-op 返回 null → active:false，前端据此把按钮灭掉
    return sendJson(res, 200, { ok: true, active: !!entry });
  });
}

// ==== GET /api/conv-notify/inbox?convId= ====
function handleInbox(res, url) {
  const convId = str(url.searchParams.get('convId'));
  const entry = convId ? getEntry(convId) : null;
  return sendJson(res, 200, { active: !!entry, items: entry?.inbox || [] });
}

// ==== POST /api/conv-notify/claim {convId, ids:[]} ====
function handleClaim(req, res) {
  if (req.method !== 'POST') return notAllowed(res);
  return withJsonBody(req, res, (data) => {
    const convId = str(data.convId);
    if (!convId) return sendJson(res, 400, { error: 'convId 不能为空' });
    claimInjections(convId, data.ids); // ids 非数组时 store 内部按空集处理，无需在此校验
    return sendJson(res, 200, { ok: true });
  });
}

// ==== POST /api/conv-notify/inject {convId, text} —— 飞书进程跨进程调用 ====
function handleInject(req, res) {
  if (req.method !== 'POST') return notAllowed(res);
  return withJsonBody(req, res, (data) => {
    const convId = str(data.convId);
    if (!convId) return sendJson(res, 400, { error: 'convId 不能为空' });

    // cwd 目录已被删/改名/挪盘时提前拦截，与 /api/run/start 的校验对齐。
    // 不拦的话 injectToConv 会照常起一个必然失败的 run，而用户此刻人在飞书侧，
    // 只会收到一条没头没尾的失败卡片，根本看不出是工作目录没了。
    const entry = getEntry(convId);
    if (entry?.cwd && !fs.existsSync(entry.cwd)) {
      return sendJson(res, 400, { ok: false, error: `会话工作目录不存在：${entry.cwd}` });
    }

    const r = injectToConv(convId, data.text);
    if (!r.ok) return sendJson(res, r.code || 400, { ok: false, error: r.error });
    return sendJson(res, 200, { ok: true, runId: r.runId, mode: r.mode });
  });
}

// ==== POST /api/conv-notify/new —— 飞书进程跨进程调用，创建新会话 ====
function handleNew(req, res) {
  if (req.method !== 'POST') return notAllowed(res);
  return withJsonBody(req, res, (data) => {
    try {
      // 1. 生成 UUID 作为 convId
      const convId = randomUUID();

      // 2. 在 conv-notify.json 中注册会话
      const entry = enableConv({
        convId,
        title: str(data.title) || '飞书新建会话',
        session: '', // 初始为空，前端打开时会同步
        cwd: str(data.cwd) || '',
        model: str(data.model) || 'auto',
        effort: str(data.effort) || 'medium',
        mode: normalizeMode(data.mode) || 'default',
      });

      if (!entry) {
        return sendJson(res, 500, { ok: false, error: '会话注册失败' });
      }

      // 3. 返回 convId 给飞书侧
      return sendJson(res, 200, { ok: true, convId });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: '服务异常: ' + (e?.message || String(e)) });
    }
  });
}

/**
 * 会话通知路由单入口：按 pathname 分发。
 * @returns {false|any} 未命中返回 false，由 server.js 继续往后匹配（而非在此 404）——
 *   /api/conv-notify/ 前缀下未来可能挂静态或其他前缀路由，这里不越权拍板。
 */
export function handleConvNotifyRoutes(req, res, url) {
  const p = url.pathname;
  if (p === '/api/conv-notify/on') return handleOn(req, res);
  if (p === '/api/conv-notify/off') return handleOff(req, res);
  if (p === '/api/conv-notify/sync') return handleSync(req, res);
  if (p === '/api/conv-notify/inbox') return handleInbox(res, url);
  if (p === '/api/conv-notify/claim') return handleClaim(req, res);
  if (p === '/api/conv-notify/inject') return handleInject(req, res);
  if (p === '/api/conv-notify/new') return handleNew(req, res);
  return false;
}

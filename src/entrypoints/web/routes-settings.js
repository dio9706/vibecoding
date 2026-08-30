/** web 入口：设置 / 导入导出 / token / openai-compat 凭证 / MCP server 路由 handler */
import { logger } from '../../shared/logger.js';
import { DEFAULT_PROVIDER_ID } from '../../shared/provider-ids.js';
import {
  getBots,
  addBot,
  updateBot,
  removeBot,
  AUTONOMY_LEVELS,
  addToken,
  updateTokenMeta,
  removeToken,
  reorderTokens,
  getUiPrefs,
  setUiPrefs,
  getMyFeishuOpenId,
  setMyFeishuOpenId,
  getActiveBot,
  getMemoryBankSettings,
  setMemoryBankSettings,
  getMcpServers,
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
  ensureMcpServerIds,
  getPluginEnabled,
  setPluginEnabled,
  getSettings,
  replaceSettings,
} from '../../store/settings.js';
import { PLUGIN_MANIFEST } from '../../plugins/index.js';
import { listBotMessages, sanitizeMessages, MAX_LEN } from '../../shared/messages.js';
import { deleteConfigsByBot, getConfigs, saveConfigs } from '../../store/action-configs.js';
import { migrateToBots } from '../../store/bots-migration.js';
import { buildExport, parseImport } from '../../store/config-transfer.js';
import { readJson } from '../../store/index.js';
import {
  getStatus,
  consumeNotice,
  scheduleAllSwitchBacks,
  getTokens,
  getActiveTokenId,
  getTokenById,
  maskToken,
} from '../../capabilities/token-rotation.js';
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str, safeDecodeId } from './input.js';

/** GET /api/plugins —— 插件清单 + 启用状态。注意：features 装配发生在进程启动时，启停重启后生效 */
export function handlePluginsList(res) {
  sendJson(res, 200, {
    plugins: PLUGIN_MANIFEST.map((p) => ({
      id: p.id,
      description: p.description,
      enabled: getPluginEnabled(p.id),
    })),
  });
}

/** PUT /api/plugins/:id —— { enabled: boolean } */
export function handlePluginsUpdate(req, res, url) {
  const id = safeDecodeId(url.pathname.slice('/api/plugins/'.length));
  if (!id) return sendJson(res, 400, { error: '无效的 id' });
  if (!PLUGIN_MANIFEST.some((p) => p.id === id)) return sendJson(res, 404, { error: 'plugin not found' });
  return withJsonBody(req, res, (data) => {
    if (typeof data.enabled !== 'boolean') return sendJson(res, 400, { error: 'enabled 必须为 boolean' });
    try {
      setPluginEnabled(id, data.enabled);
    } catch (e) {
      return sendJson(res, 500, { error: '保存失败：' + (e?.message || e) });
    }
    logger.info('web', '[PUT /api/plugins] 插件启停', { id, enabled: data.enabled });
    sendJson(res, 200, { ok: true, note: '重启进程后生效（features 装配发生在启动时）' });
  });
}

/**
 * 任务飞书通知的「开启」前置条件：缺一不可，否则开关开了也一条卡片发不出去。
 * 判定与文案刻意与 /api/conv-notify/on 保持一致——两个开关最终走的是同一条私聊发送链路，
 * 用户看到两套说法只会更懵。齐全返回 null，否则返回可直接展示的指路文案。
 */
function taskNotifyPrereqError() {
  if (!getMyFeishuOpenId()) return '请先到设置页填写「我的飞书 open_id」';
  const bot = getActiveBot();
  if (!bot?.appId || !bot?.appSecret) return '请先在设置页启用一个飞书机器人并填全凭证';
  return null;
}

/** 设置读写：GET 一次性加载（飞书连接状态 + token 掩码列表 + UI 偏好）；POST 分区保存 */
export function handleSettings(req, res) {
  if (req.method === 'GET') {
    const feishu = readJson('feishu-status.json', { state: 'idle', at: null, error: null });
    const status = getStatus();
    return sendJson(res, 200, {
      feishu,
      tokens: status.tokens, // 已掩码
      active: status.active,
      uiPrefs: getUiPrefs(), // Web UI 偏好：工作目录 / 模型 / 强度 / 模式
      myFeishuOpenId: getMyFeishuOpenId(), // 我的飞书 open_id：测试期筛「属于我的 BUG」用
      memoryBank: getMemoryBankSettings(), // 记忆库：功能开关 / 凌晨窗口 / 预算 / 阈值配置
    });
  }
  if (req.method === 'POST') {
    return withJsonBody(req, res, (data) => {
      if (data.section === 'tokens') {
        try {
          switch (data.action) {
            case 'add':
              if (!str(data.token)) return sendJson(res, 400, { error: 'token 不能为空' });
              addToken(str(data.label), str(data.token));
              break;
            case 'update':
              updateTokenMeta(data.id, cleanTokenPatch(data));
              break;
            case 'remove':
              removeToken(data.id);
              break;
            case 'reorder':
              reorderTokens(Array.isArray(data.ids) ? data.ids : []);
              break;
            default:
              return sendJson(res, 400, { error: '未知 token action' });
          }
        } catch (e) {
          return sendJson(res, 500, { error: '保存失败：' + (e?.message || e) });
        }
        return sendJson(res, 200, { ok: true, tokens: getStatus().tokens });
      }
      if (data.section === 'ui-prefs') {
        const allowed = ['defaultCwd', 'model', 'effort', 'mode', 'defaultModel', 'defaultEffort', 'defaultMode'];
        const patch = {};
        for (const k of allowed) {
          if (typeof data[k] === 'string') patch[k] = data[k].trim();
        }
        // disabledTools：字符串数组，工具 ID 白名单之外表示禁用
        if (Array.isArray(data.disabledTools)) {
          patch.disabledTools = data.disabledTools
            .filter((t) => typeof t === 'string')
            .map((t) => t.trim())
            .filter(Boolean);
        }
        // taskNotifyFeishu：布尔开关必须单独判——上面的 allowed 循环只认字符串（还会 .trim()），
        // 把它塞进那个数组会被 typeof 检查直接丢掉，开关永远存不下去
        let notifyBlocked = null;
        if (typeof data.taskNotifyFeishu === 'boolean') {
          // 只校验「开启」方向：关闭必须在任何配置状态下都能生效，否则飞书配置一旦被清空/机器人被停用，
          // 开关就永久卡在「开着」——用户想关都关不掉
          notifyBlocked = data.taskNotifyFeishu ? taskNotifyPrereqError() : null;
          if (!notifyBlocked) patch.taskNotifyFeishu = data.taskNotifyFeishu;
        }
        try {
          setUiPrefs(patch);
        } catch (e) {
          return sendJson(res, 500, { error: '保存失败：' + (e?.message || e) });
        }
        // 前置不齐时回 200 + ok:false（同 /api/conv-notify/on 的处置）：前端据此弹 toast 指路且不点亮开关。
        // 注意此处是「只跳过 taskNotifyFeishu 一个字段」而非拦下整个请求——同一次 POST 可能顺带在改
        // model/effort/disabledTools，不能因为飞书没配好就把无关的偏好一起挡掉（它们上面已照常写盘）。
        if (notifyBlocked) return sendJson(res, 200, { ok: false, error: notifyBlocked, uiPrefs: getUiPrefs() });
        return sendJson(res, 200, { ok: true, uiPrefs: getUiPrefs() });
      }
      if (data.section === 'profile') {
        const openId = str(data.myFeishuOpenId);
        if (openId.length > 128) return sendJson(res, 400, { error: '我的飞书 open_id 超过 128 字符' });
        try {
          setMyFeishuOpenId(openId);
        } catch (e) {
          return sendJson(res, 500, { error: '保存失败：' + (e?.message || e) });
        }
        return sendJson(res, 200, { ok: true, myFeishuOpenId: getMyFeishuOpenId() });
      }
      if (data.section === 'memory-bank') {
        // 局部合并：只收入前端实际传的字段，其余沿用 setMemoryBankSettings 内部的 {...s.memoryBank, ...patch}，
        // 避免前端只传一个字段（如仅切换 enabled）时把其余配置整段替换丢失
        const strFields = ['nightStart', 'nightEnd', 'model'];
        const numFields = ['minIntervalHours', 'maxItems', 'maxChars', 'dormantDays', 'minEvidence', 'minSessions'];
        const patch = {};
        if (typeof data.enabled === 'boolean') patch.enabled = data.enabled;
        for (const k of strFields) {
          if (typeof data[k] === 'string') patch[k] = data[k].trim();
        }
        for (const k of numFields) {
          if (typeof data[k] === 'number' && Number.isFinite(data[k])) patch[k] = data[k];
        }
        try {
          setMemoryBankSettings(patch);
        } catch (e) {
          return sendJson(res, 500, { error: '保存失败：' + (e?.message || e) });
        }
        return sendJson(res, 200, { ok: true, memoryBank: getMemoryBankSettings() });
      }
      return sendJson(res, 400, { error: '未知 section' });
    });
  }
  sendJson(res, 405, { error: 'method not allowed' });
}

// ==== 机器人（bots）CRUD：单启用互斥；删除级联删其动作 ====

/** 机器人 → 前端形态：appSecret 掩码；messages 展开为 [{key,label,defaultText,value}] 供表单渲染 */
function botView(b) {
  return {
    id: b.id,
    name: b.name || '',
    platform: b.platform || 'feishu',
    appId: b.appId || '',
    appSecretMasked: b.appSecret ? maskToken(b.appSecret) : '', // 复用 token 掩码（短串全掩，防泄露）
    persona: b.persona || '',
    messages: listBotMessages(b.messages),
    projectDir: b.projectDir || '',
    projectNotes: b.projectNotes || '',
    setupScript: b.setupScript || '',
    autonomy: AUTONOMY_LEVELS.includes(b.autonomy) ? b.autonomy : 'light',
    enabled: !!b.enabled,
  };
}

/** 校验并提取 bot 字段；hasSecret=false 时留空 appSecret 表示不改。失败返回 { error } */
function cleanBotInput(data, { requireCreds = false } = {}) {
  const out = {};
  if (typeof data.name === 'string') out.name = data.name.trim();
  if (typeof data.platform === 'string') {
    if (data.platform !== 'feishu') return { error: '暂仅支持飞书平台' };
    out.platform = data.platform;
  }
  if (typeof data.appId === 'string') {
    const appId = data.appId.trim();
    if (appId && !/^cli_[0-9a-fA-F]{16}$/.test(appId)) return { error: 'App ID 格式应为 cli_ 加 16 位十六进制' };
    out.appId = appId;
  }
  if (typeof data.appSecret === 'string' && data.appSecret.trim()) out.appSecret = data.appSecret.trim();
  if (typeof data.persona === 'string') {
    const persona = data.persona.trim();
    if (persona.length > MAX_LEN) return { error: `角色描述超过 ${MAX_LEN} 字符` };
    out.persona = persona;
  }
  if (typeof data.projectDir === 'string') out.projectDir = data.projectDir.trim();
  if (typeof data.projectNotes === 'string') {
    const notes = data.projectNotes.trim();
    if (notes.length > MAX_LEN) return { error: `工程说明超过 ${MAX_LEN} 字符` };
    out.projectNotes = notes;
  }
  if (typeof data.setupScript === 'string') {
    const setup = data.setupScript.trim();
    if (setup.length > MAX_LEN) return { error: `初始化脚本超过 ${MAX_LEN} 字符` };
    out.setupScript = setup;
  }
  if (data.autonomy !== undefined) {
    if (!AUTONOMY_LEVELS.includes(data.autonomy)) return { error: '托管程度取值无效' };
    out.autonomy = data.autonomy;
  }
  if (data.messages !== undefined) {
    const r = sanitizeMessages(data.messages);
    if (!r.ok) return { error: r.error };
    out.messages = r.values;
  }
  if (typeof data.enabled === 'boolean') out.enabled = data.enabled;
  if (requireCreds && out.appId && !out.appSecret) return { error: '首次配置 App Secret 必填' };
  return { value: out };
}

/** GET /api/bots —— 机器人列表（secret 掩码）+ 可配文案元数据（新增表单渲染用） */
export function handleBotsList(res) {
  sendJson(res, 200, { bots: getBots().map(botView), messagesMeta: listBotMessages() });
}

/** POST /api/bots —— 新增机器人 */
export function handleBotsAdd(req, res) {
  return withJsonBody(req, res, (data) => {
    const r = cleanBotInput(data, { requireCreds: true });
    if (r.error) return sendJson(res, 400, { error: r.error });
    try {
      const created = addBot(r.value);
      logger.info('web', '[POST /api/bots] 新增机器人', { id: created.id, name: created.name });
      sendJson(res, 200, { ok: true, bot: botView(created) });
    } catch (e) {
      sendJson(res, 500, { error: '保存失败：' + (e?.message || e) });
    }
  });
}

/** PUT /api/bots/:id —— 局部更新；appSecret 留空不改；enabled:true 互斥禁用其他机器人 */
export function handleBotsUpdate(req, res, url) {
  const id = safeDecodeId(url.pathname.slice('/api/bots/'.length));
  if (!id) return sendJson(res, 400, { error: '无效的 id' });
  if (!getBots().some((b) => b && b.id === id)) return sendJson(res, 404, { error: 'bot not found' });
  return withJsonBody(req, res, (data) => {
    const r = cleanBotInput(data);
    if (r.error) return sendJson(res, 400, { error: r.error });
    try {
      const updated = updateBot(id, r.value);
      sendJson(res, 200, { ok: true, bot: updated ? botView(updated) : null });
    } catch (e) {
      sendJson(res, 500, { error: '更新失败：' + (e?.message || e) });
    }
  });
}

/** DELETE /api/bots/:id —— 删除机器人并级联删除其全部动作 */
export function handleBotsDelete(req, res, url) {
  const id = safeDecodeId(url.pathname.slice('/api/bots/'.length));
  if (!id) return sendJson(res, 400, { error: '无效的 id' });
  if (!getBots().some((b) => b && b.id === id)) return sendJson(res, 404, { error: 'bot not found' });
  try {
    removeBot(id);
    const removedActions = deleteConfigsByBot(id);
    logger.info('web', '[DELETE /api/bots] 删除机器人', { id, removedActions });
    sendJson(res, 200, { ok: true, removedActions });
  } catch (e) {
    sendJson(res, 500, { error: '删除失败：' + (e?.message || e) });
  }
}

/** 导出全部配置（原始明文，含 token 值与 App Secret）。
 *  含托管配置（action-configs.json）：它与 bots 有 botId 引用关系，
 *  只导 bots 不导动作，换机导入后关联会断、托管配置整块丢失。 */
export function handleSettingsExport(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  const payload = buildExport(getSettings(), getConfigs(), new Date().toISOString());
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="claude-agent-config-${date}.json"`);
  res.writeHead(200);
  res.end(JSON.stringify(payload, null, 2));
}

/** 导入配置：校验类型/版本后整体覆盖写盘，重排 token 定时器。 */
export function handleSettingsImport(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (raw) => {
    const parsed = parseImport(raw);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
    try {
      replaceSettings(parsed.settings);
      // 托管配置必须在 migrateToBots 之前落盘：后者内部的 adoptOrphanConfigs 会读
      // action-configs.json 做「孤儿动作收养」，顺序反了就是拿导入前的旧动作去收养，
      // 新导入的动作永远认不到 bot。
      // null 表示本次不涉及托管配置（v1 旧包）——跳过而不是写空数组，否则清空用户现有动作。
      if (parsed.actionConfigs !== null) saveConfigs(parsed.actionConfigs);
      migrateToBots(); // 旧版配置文件（无 bots）→ 自动升级为机器人实体 + 动作收养
      // 导入的 token 可能带 rateLimited 的 resetsAt → 重排到点恢复定时器
      scheduleAllSwitchBacks();
    } catch (e) {
      return sendJson(res, 500, { error: '导入失败：' + (e?.message || e) });
    }
    logger.info('web', '配置已导入', {
      tokens: (parsed.settings.tokens || []).length,
      actionConfigs: parsed.actionConfigs === null ? '(旧版包，未包含)' : parsed.actionConfigs.length,
    });
    // actionConfigsImported 供前端区分提示文案：旧版包要告诉用户托管配置没带过来，
    // 否则他会以为配齐了，直到某天发现动作全没了
    return sendJson(res, 200, { ok: true, actionConfigsImported: parsed.actionConfigs !== null });
  });
}

/** 仅取 update 允许的字段（label / token），避免前端塞入 status 等被篡改 */
function cleanTokenPatch(data) {
  const patch = {};
  if (typeof data.label === 'string') patch.label = data.label.trim();
  if (typeof data.token === 'string' && data.token.trim()) patch.token = data.token.trim();
  return patch;
}

/** token 状态轻量轮询（前端横幅 / 徽标） */
export function handleTokensStatus(res) {
  sendJson(res, 200, getStatus());
}

/** 消费切换通知（前端点「知道了」） */
export function handleTokensDismiss(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  consumeNotice();
  sendJson(res, 200, { ok: true });
}

/** GET /api/tokens/list - 获取所有账号列表 + 当前活跃账号 */
export function handleTokensList(res) {
  try {
    const allTokens = getTokens();
    const activeTokenId = getActiveTokenId();

    const tokenList = allTokens.map((t) => ({
      id: t.id,
      label: t.label,
      isActive: t.id === activeTokenId,
    }));

    sendJson(res, 200, {
      tokens: tokenList,
      activeId: activeTokenId,
    });
  } catch (error) {
    logger.error('web', '[GET /api/tokens/list] Error', { error: error?.message || String(error) });
    sendJson(res, 500, { error: 'Failed to fetch tokens' });
  }
}

/** POST /api/tokens/switch - 切换活跃账号 */
export function handleTokensSwitch(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

  return withJsonBody(req, res, (data) => {
    try {
      const { id } = data;

      if (!id) {
        return sendJson(res, 400, { error: 'Token ID is required' });
      }

      // 检查 token 是否存在
      const token = getTokenById(id);
      if (!token) {
        return sendJson(res, 404, { error: 'Token not found' });
      }

      // 验证 token 状态（必须是 healthy 或 warning，不能是 exhausted）
      if (token.status !== 'healthy' && token.status !== 'warning') {
        return sendJson(res, 400, { error: `Token is not available for switching (status: ${token.status})` });
      }

      // 通过重排优先级把该 token 移到首位来使其成为活跃账号
      const allTokens = getTokens();
      const otherTokens = allTokens.filter(t => t.id !== id);
      const newOrder = [id, ...otherTokens.map(t => t.id)];
      reorderTokens(newOrder);

      logger.info('web', '[POST /api/tokens/switch] Success', { tokenId: id, label: token.label });

      sendJson(res, 200, {
        success: true,
        label: token.label,
        message: `已切换到账号 ${token.label}`,
      });
    } catch (error) {
      logger.error('web', '[POST /api/tokens/switch] Error', { error: error?.message || String(error) });
      sendJson(res, 500, { error: error?.message || 'Failed to switch token' });
    }
  });
}

/** 仅取凭证 update 允许字段，防前端塞入 status 等 */
function cleanCredentialPatch(data) {
  const patch = {};
  if (typeof data.label === 'string' && data.label.trim()) patch.label = data.label.trim();
  if (typeof data.apiKey === 'string' && data.apiKey.trim()) patch.token = data.apiKey.trim();
  if (typeof data.baseURL === 'string' && data.baseURL.trim()) patch.baseURL = data.baseURL.trim();
  if (typeof data.model === 'string' && data.model.trim()) patch.model = data.model.trim();
  // vendor 不做值域白名单：它是纯展示元数据，不参与执行路径；校验会让「新增厂商」
  // 变成前后端两处改动，而前端已有 VENDOR_PRESETS[v]?.label || v 的兜底（未知值原样显示）
  if (typeof data.vendor === 'string' && data.vendor.trim()) patch.vendor = data.vendor.trim();
  return patch;
}

/** GET /api/credentials —— 列出 openai-compat 凭证（apiKey 掩码） */
export function handleCredentialsList(res) {
  const creds = getTokens()
    .filter((t) => (t.providerId || DEFAULT_PROVIDER_ID) === 'openai-compat')
    .map((t) => ({
      id: t.id,
      label: t.label,
      vendor: t.vendor || '', // 存量凭证无此字段 → 前端按 baseURL 反查兜底
      baseURL: t.baseURL || '',
      model: t.model || '',
      masked: maskToken(t.token),
      status: t.status,
    }));
  sendJson(res, 200, { credentials: creds });
}

/** POST /api/credentials —— 新增 openai-compat 凭证 { label, apiKey, baseURL, model } */
export function handleCredentialsAdd(req, res) {
  return withJsonBody(req, res, (data) => {
    const apiKey = str(data.apiKey);
    const baseURL = str(data.baseURL);
    const model = str(data.model);
    if (!apiKey || !baseURL || !model) return sendJson(res, 400, { error: 'apiKey / baseURL / model 均必填' });
    const label = str(data.label);
    // 展示用元数据，不必填（手写 API 调用可不传）。空串归一为 undefined：
    // makeTokenEntry 按 != null 条件展开，否则会落一个空的 vendor 字段
    const vendor = str(data.vendor) || undefined;
    try {
      addToken(label, apiKey, 'openai-compat', { baseURL, model, vendor });
    } catch (e) {
      return sendJson(res, 500, { error: '保存凭证失败：' + (e?.message || e) });
    }
    logger.info('web', '[POST /api/credentials] 新增自定义模型凭证', { label: label || '(默认)', vendor, baseURL, model });
    sendJson(res, 200, { ok: true });
  });
}

/** PUT /api/credentials/:id —— 局部更新 */
export function handleCredentialsUpdate(req, res, url) {
  const id = safeDecodeId(url.pathname.slice('/api/credentials/'.length));
  if (!id) return sendJson(res, 400, { error: '无效的 id' });
  const cred = id && getTokenById(id);
  if (!cred || (cred.providerId || DEFAULT_PROVIDER_ID) !== 'openai-compat') return sendJson(res, 404, { error: 'credential not found' });
  return withJsonBody(req, res, (data) => {
    try {
      updateTokenMeta(id, cleanCredentialPatch(data));
    } catch (e) {
      return sendJson(res, 500, { error: '更新凭证失败：' + (e?.message || e) });
    }
    sendJson(res, 200, { ok: true });
  });
}

/** DELETE /api/credentials/:id */
export function handleCredentialsDelete(req, res, url) {
  const id = safeDecodeId(url.pathname.slice('/api/credentials/'.length));
  if (!id) return sendJson(res, 400, { error: '无效的 id' });
  const cred = id && getTokenById(id);
  if (!cred || (cred.providerId || DEFAULT_PROVIDER_ID) !== 'openai-compat') return sendJson(res, 404, { error: 'credential not found' });
  try {
    removeToken(id);
  } catch (e) {
    return sendJson(res, 500, { error: '删除凭证失败：' + (e?.message || e) });
  }
  logger.info('web', '[DELETE /api/credentials] 删除凭证', { id });
  sendJson(res, 200, { ok: true });
}

/** MCP server 条目 → 前端形态。env 可能含密钥，不透出网页（UI 不编辑 env，手改 settings.json 的原样保留） */
function mcpServerView(m) {
  return {
    id: m.id,
    label: m.label || m.command || '',
    command: m.command || '',
    args: Array.isArray(m.args) ? m.args : [],
    cwd: m.cwd || '',
    autoAllow: Array.isArray(m.autoAllow) ? m.autoAllow : [],
    enabled: m.enabled !== false,
    hasEnv: !!(m.env && typeof m.env === 'object' && Object.keys(m.env).length),
  };
}

/** 仅取 MCP server 允许的编辑字段（防塞入 env 等） */
function cleanMcpPatch(data) {
  const patch = {};
  if (typeof data.label === 'string') patch.label = data.label.trim();
  if (typeof data.command === 'string' && data.command.trim()) patch.command = data.command.trim();
  if (Array.isArray(data.args)) patch.args = data.args.map((a) => String(a).trim()).filter(Boolean);
  if (typeof data.cwd === 'string') patch.cwd = data.cwd.trim();
  if (Array.isArray(data.autoAllow)) patch.autoAllow = data.autoAllow.map((a) => String(a).trim()).filter(Boolean);
  if (typeof data.enabled === 'boolean') patch.enabled = data.enabled;
  return patch;
}

/** GET /api/mcp-servers —— 列出 stdio MCP server 配置 */
export function handleMcpServersList(res) {
  ensureMcpServerIds(); // 手改 settings.json 的存量条目补 id，才能被 UI 编辑/删除
  sendJson(res, 200, { servers: getMcpServers().filter((m) => m && m.id).map(mcpServerView) });
}

/** POST /api/mcp-servers —— 新增 { label?, command, args?, cwd? } */
export function handleMcpServersAdd(req, res) {
  return withJsonBody(req, res, (data) => {
    const command = str(data.command);
    if (!command) return sendJson(res, 400, { error: 'command 必填' });
    try {
      addMcpServer({
        label: str(data.label),
        command,
        args: Array.isArray(data.args) ? data.args : [],
        cwd: str(data.cwd),
        autoAllow: Array.isArray(data.autoAllow) ? data.autoAllow : [],
      });
    } catch (e) {
      return sendJson(res, 500, { error: '保存失败：' + (e?.message || e) });
    }
    logger.info('web', '[POST /api/mcp-servers] 新增 MCP 服务器', { label: str(data.label) || command, command });
    sendJson(res, 200, { ok: true });
  });
}

/** PUT /api/mcp-servers/:id —— 局部更新（label/command/args/cwd/enabled） */
export function handleMcpServersUpdate(req, res, url) {
  const id = safeDecodeId(url.pathname.slice('/api/mcp-servers/'.length));
  if (!id) return sendJson(res, 400, { error: '无效的 id' });
  const cur = getMcpServers().find((m) => m && m.id === id);
  if (!cur) return sendJson(res, 404, { error: 'mcp server not found' });
  return withJsonBody(req, res, (data) => {
    try {
      updateMcpServer(id, cleanMcpPatch(data));
    } catch (e) {
      return sendJson(res, 500, { error: '更新失败：' + (e?.message || e) });
    }
    sendJson(res, 200, { ok: true });
  });
}

/** DELETE /api/mcp-servers/:id */
export function handleMcpServersDelete(req, res, url) {
  const id = safeDecodeId(url.pathname.slice('/api/mcp-servers/'.length));
  if (!id) return sendJson(res, 400, { error: '无效的 id' });
  const cur = getMcpServers().find((m) => m && m.id === id);
  if (!cur) return sendJson(res, 404, { error: 'mcp server not found' });
  try {
    removeMcpServer(id);
  } catch (e) {
    return sendJson(res, 500, { error: '删除失败：' + (e?.message || e) });
  }
  logger.info('web', '[DELETE /api/mcp-servers] 删除 MCP 服务器', { id });
  sendJson(res, 200, { ok: true });
}

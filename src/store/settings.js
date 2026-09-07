/**
 * 设置持久化 —— 唯一入口（settings.json）：飞书凭证 + 备用 token 池 + 文案 + UI 偏好。
 * web 与 feishu 两个进程都会写（feishu 经 claudeAuthOpts→noteRateLimit 更新 token 状态），
 * 所有变更走 updateSettings（跨进程文件锁内读-改-写）。含明文密钥 → 已 gitignore。
 */
import { readJson, updateJson } from './index.js';
import { DEFAULT_PROVIDER_ID } from '../shared/provider-ids.js';

const FILE = 'settings.json';
const DEFAULTS = {
  lark: { appId: '', appSecret: '' }, // 旧版单凭证：已迁移到 bots，仅作 getLarkCredentials 兜底
  bots: [], // 机器人实体列表：{ id, name, platform, appId, appSecret, persona, messages, enabled }
  tokens: [],
  mcpServers: [],
  plugins: {}, // 插件启停：{ [pluginId]: bool }；缺省视为启用（向后兼容）
  messages: {},
  persona: '', // 角色描述：飞书机器人的角色/性格/语气，注入飞书侧 Claude 对话的 system prompt
  // Web UI 偏好：工作目录 / 模型 / 强度 / 权限模式（跨重启、跨浏览器持久化）
  // taskProjectDir 已迁移为机器人的 projectDir（migrateLegacySettingsToBot）
  // taskNotifyFeishu：任务处理完成后推飞书私聊卡片的总开关。默认关——通知会主动打扰用户，
  // 且依赖 myFeishuOpenId / 启用中的机器人，必须由用户显式开启（task-notify 的第一道守卫读它）
  uiPrefs: { defaultCwd: '', model: 'auto', effort: 'medium', mode: 'default', defaultModel: '', defaultEffort: '', defaultMode: '', disabledTools: [], taskNotifyFeishu: false, projectMapIdleRefresh: false },
  myFeishuOpenId: '', // 我的飞书 open_id：全局身份标识，测试期筛多维表格「属于我的 BUG」用
  // 记忆库：从会话转录提炼用户偏好的调度/预算配置
  memoryBank: {
    enabled: false,        // 默认关闭：提炼要花额度，必须用户显式开启
    nightStart: '00:00',   // 默认不限时段（nightStart === nightEnd 视为随时可跑）
    nightEnd: '00:00',
    minIntervalHours: 1,   // 空闲提炼默认 1 小时冷却，避免频繁重复
    model: '',             // 空 = 用 config 的分类模型（便宜档）
    maxItems: 40,
    maxChars: 3000,
    dormantDays: 90,
    minEvidence: 3,
    minSessions: 2,
  },
};

export function normalizeSettings(s) {
  s = s && typeof s === 'object' ? s : {};
  return {
    lark: { ...DEFAULTS.lark, ...(s.lark || {}) },
    bots: Array.isArray(s.bots) ? s.bots : [],
    // 回填 providerId（幂等）：旧 token 无此字段 → 归属 claude-agent；已有值不覆盖
    tokens: (Array.isArray(s.tokens) ? s.tokens : []).map((t) => ({ providerId: DEFAULT_PROVIDER_ID, ...t })),
    // 必须透传：各 setter 走「整份读-改一字段-整体回写」，漏了会丢文案
    mcpServers: Array.isArray(s.mcpServers) ? s.mcpServers : [],
    plugins: s.plugins && typeof s.plugins === 'object' && !Array.isArray(s.plugins) ? s.plugins : {},
    messages: s.messages && typeof s.messages === 'object' && !Array.isArray(s.messages) ? s.messages : {},
    persona: typeof s.persona === 'string' ? s.persona : '',
    uiPrefs: s.uiPrefs && typeof s.uiPrefs === 'object' && !Array.isArray(s.uiPrefs)
      ? { ...DEFAULTS.uiPrefs, ...s.uiPrefs }
      : { ...DEFAULTS.uiPrefs },
    myFeishuOpenId: typeof s.myFeishuOpenId === 'string' ? s.myFeishuOpenId.trim() : '',
    memoryBank: s.memoryBank && typeof s.memoryBank === 'object' && !Array.isArray(s.memoryBank)
      ? { ...DEFAULTS.memoryBank, ...s.memoryBank }
      : { ...DEFAULTS.memoryBank },
  };
}

export function getSettings() {
  return normalizeSettings(readJson(FILE, DEFAULTS));
}

/** 锁内读-改-写整份设置：fn(s) 就地修改；fn 显式返回 false 则放弃写盘（无变更） */
function updateSettings(fn) {
  return updateJson(FILE, DEFAULTS, (raw) => {
    const s = normalizeSettings(raw);
    if (fn(s) === false) return undefined;
    return s;
  });
}

/** 旧版单凭证读取：仅供 getLarkCredentials 兜底（未迁移/裸 env 场景）；新配置一律走 bots */
export function getLark() {
  return getSettings().lark;
}

// ==== 机器人实体（bots）：单启用互斥，启用者的凭证/人设/文案/动作生效 ====

/** 托管程度：light 轻度（人工确认开发）/ medium 中度（评审门+BUG 自动修）/ full 完全（需求也自动+项目问答） */
export const AUTONOMY_LEVELS = ['light', 'medium', 'full'];

export function normalizeAutonomy(v) {
  return AUTONOMY_LEVELS.includes(v) ? v : 'light';
}

/** 纯函数：构造一个机器人条目。显式传 id/index/now 保持可测。 */
export function makeBotEntry({ id, name, platform, appId, appSecret, persona, messages, projectDir, projectNotes, setupScript, autonomy, enabled, index = 0, now }) {
  return {
    id,
    name: (name || '').trim() || `机器人 ${index + 1}`,
    platform: platform || 'feishu',
    appId: appId || '',
    appSecret: appSecret || '',
    persona: typeof persona === 'string' ? persona : '',
    messages: messages && typeof messages === 'object' && !Array.isArray(messages) ? messages : {},
    projectDir: typeof projectDir === 'string' ? projectDir : '', // 事务仅限此工程目录；其他目录只读参考
    projectNotes: typeof projectNotes === 'string' ? projectNotes : '', // 工程说明（后端/前端/figma 等参考信息）
    setupScript: typeof setupScript === 'string' ? setupScript : '', // auto 工作区首建初始化脚本（如 npm install）
    autonomy: normalizeAutonomy(autonomy), // 托管程度
    // 注：曾有 per-bot 的 trustedOpenIds（可信提交人白名单），已删除。
    // 它从未接通过任何一端：routes-settings 的 cleanBotInput/botView 不收不吐、设置页没有输入框、
    // 业务侧也早已改成只认基础设置的「我的飞书 open_id」。留一个只写不读的字段，
    // 就是给下一个人埋「配置看起来在工作、实际没有」的坑。
    enabled: !!enabled,
    updatedAt: now,
  };
}

/** 纯函数：取第一个 enabled 的机器人；无则 null */
export function pickActiveBot(bots) {
  if (!Array.isArray(bots)) return null;
  return bots.find((b) => b && b.enabled) || null;
}

export function getBots() {
  return getSettings().bots;
}

/** 当前生效机器人（本期单机器人生效）；每次读盘，保存后下一条消息生效 */
export function getActiveBot() {
  return pickActiveBot(getBots());
}

/** 新增机器人；enabled=true 时互斥禁用其他机器人 */
export function addBot({ name, platform, appId, appSecret, persona, messages, projectDir, projectNotes, setupScript, autonomy, enabled }) {
  let created = null;
  updateSettings((s) => {
    created = makeBotEntry({
      id: genId('bot_'),
      name, platform, appId, appSecret, persona, messages, projectDir, projectNotes, setupScript, autonomy, enabled,
      index: s.bots.length,
      now: new Date().toISOString(),
    });
    if (created.enabled) s.bots = s.bots.map((b) => ({ ...b, enabled: false }));
    s.bots.push(created);
  });
  return created;
}

/** 局部更新机器人；patch.enabled=true 时互斥禁用其他机器人；未知 id 无变化 */
export function updateBot(id, patch) {
  return updateSettings((s) => {
    if (!s.bots.some((b) => b && b.id === id)) return false;
    s.bots = s.bots.map((b) => {
      if (!b) return b;
      if (b.id === id) return { ...b, ...patch, id, updatedAt: new Date().toISOString() };
      return patch.enabled === true ? { ...b, enabled: false } : b;
    });
  }).bots.find((b) => b && b.id === id) || null;
}

export function removeBot(id) {
  return updateSettings((s) => {
    s.bots = s.bots.filter((b) => b && b.id !== id);
  }).bots;
}

/** 一次性迁移（锁内）：旧 lark/persona/messages → 启用的「机器人 1」；bots 非空或无旧配置则 no-op 返回 null。
 *  messageKeys：可迁移的文案 key 白名单（调用方注入，避免 settings↔messages 循环依赖）。 */
export function migrateLegacySettingsToBot({ messageKeys = [] } = {}) {
  let created = null;
  updateSettings((s) => {
    if (s.bots.length > 0) return false;
    const legacyProjectDir = typeof s.uiPrefs.taskProjectDir === 'string' ? s.uiPrefs.taskProjectDir : '';
    const hasLegacy = s.lark.appId || s.lark.appSecret || s.persona || Object.keys(s.messages).length > 0 || legacyProjectDir;
    if (!hasLegacy) return false;
    const messages = {};
    for (const k of messageKeys) {
      if (typeof s.messages[k] === 'string' && s.messages[k].trim()) messages[k] = s.messages[k];
    }
    created = makeBotEntry({
      id: genId('bot_'),
      platform: 'feishu',
      appId: s.lark.appId,
      appSecret: s.lark.appSecret,
      persona: s.persona,
      messages,
      projectDir: legacyProjectDir, // 原「基础设置-项目目录」随迁
      enabled: true,
      index: 0,
      now: new Date().toISOString(),
    });
    s.bots = [created];
    s.lark = { appId: '', appSecret: '' };
    s.persona = '';
    s.messages = {};
    delete s.uiPrefs.taskProjectDir;
  });
  return created;
}

/** 读取已配置的 MCP server 列表（stdio）：[{ id, label, command, args, cwd?, env?, enabled }] */
export function getMcpServers() {
  return getSettings().mcpServers;
}

/** 插件是否启用：未显式设 false 即启用（缺省全开=向后兼容） */
export function getPluginEnabled(id) {
  return getSettings().plugins[id] !== false;
}

export function setPluginEnabled(id, enabled) {
  return updateSettings((s) => {
    s.plugins = { ...s.plugins, [id]: !!enabled };
  }).plugins;
}

export function getTokens() {
  return getSettings().tokens;
}

export function setTokens(tokens) {
  return updateSettings((s) => {
    s.tokens = Array.isArray(tokens) ? tokens : [];
  }).tokens;
}

/** 锁内整体变换 token 池：fn(tokens)=>新数组，返回 false 放弃写盘。
 *  供 token-rotation 的限流归因/到点恢复使用——读与写之间不允许其他进程插入。 */
export function mutateTokens(fn) {
  return updateSettings((s) => {
    const next = fn(s.tokens);
    if (next === false) return false;
    s.tokens = Array.isArray(next) ? next : [];
  });
}

function genId(prefix = 'tk_') {
  return prefix + Math.random().toString(36).slice(2, 8);
}

/** 纯函数：构造一个 token/凭证条目。openai 条目额外带 baseURL/model/vendor；claude 条目不含此三字段。
 *  vendor 是**纯展示元数据**（录入时选的厂商预设，用于设置页列表显示「DeepSeek」而非「—」），
 *  不参与任何运行时逻辑——路由靠 providerId，请求参数靠 baseURL/model。
 *  三者一律条件展开：claude 条目不该凭空多出空字段，保持两类条目形状干净。
 *  显式传 id/index/now 以保持纯粹可测（无 random/时间副作用）。 */
export function makeTokenEntry({ id, label, token, providerId = DEFAULT_PROVIDER_ID, baseURL, model, vendor, index = 0, now }) {
  return {
    id,
    providerId,
    label: label || `账号${index + 1}`,
    token: token || '',
    ...(baseURL != null ? { baseURL } : {}),
    ...(model != null ? { model } : {}),
    ...(vendor != null ? { vendor } : {}),
    status: 'healthy',
    resetsAt: null,
    rateLimitType: null,
    utilization: null,
    updatedAt: now,
  };
}

/** 新增一个备用账号（追加到偏好末尾） */
export function addToken(label, token, providerId = DEFAULT_PROVIDER_ID, extra = {}) {
  return updateSettings((s) => {
    s.tokens.push(
      makeTokenEntry({
        id: genId(),
        label,
        token,
        providerId,
        baseURL: extra.baseURL,
        model: extra.model,
        vendor: extra.vendor,
        index: s.tokens.length,
        now: new Date().toISOString(),
      }),
    );
  }).tokens;
}

/** 局部更新某账号（改名 patch={label}；换 token patch={token}） */
export function updateTokenMeta(id, patch) {
  return updateSettings((s) => {
    s.tokens = s.tokens.map((t) =>
      t.id === id ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t,
    );
  }).tokens;
}

export function removeToken(id) {
  return updateSettings((s) => {
    s.tokens = s.tokens.filter((t) => t.id !== id);
  }).tokens;
}

/** 按 id 数组重排偏好顺序；未列出的账号补到末尾（防丢） */
export function reorderTokens(ids) {
  return updateSettings((s) => {
    const byId = new Map(s.tokens.map((t) => [t.id, t]));
    const seen = new Set();
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((t) => t && !seen.has(t.id) && seen.add(t.id));
    for (const t of byId.values()) if (!seen.has(t.id)) ordered.push(t);
    s.tokens = ordered;
  }).tokens;
}

/** 纯函数：构造一个 MCP server 条目（stdio）。args/autoAllow 归一为非空字符串数组；enabled 默认开。 */
export function makeMcpServerEntry({ id, label, command, args, cwd, autoAllow, now }) {
  const strList = (v) => (Array.isArray(v) ? v.map((a) => String(a).trim()).filter(Boolean) : []);
  return {
    id,
    label: (label || '').trim() || command,
    command,
    args: strList(args),
    ...(cwd ? { cwd } : {}),
    autoAllow: strList(autoAllow), // 免审批工具名白名单（canUseTool 命中直接放行）
    enabled: true,
    updatedAt: now,
  };
}

/** 新增一个 MCP server 配置 */
export function addMcpServer({ label, command, args, cwd, autoAllow }) {
  return updateSettings((s) => {
    s.mcpServers.push(
      makeMcpServerEntry({ id: genId('mcp_'), label, command, args, cwd, autoAllow, now: new Date().toISOString() }),
    );
  }).mcpServers;
}

/** 局部更新 MCP server（label/command/args/cwd/enabled）；未知 id 无变化。env 等未列字段原样保留。 */
export function updateMcpServer(id, patch) {
  return updateSettings((s) => {
    s.mcpServers = s.mcpServers.map((m) =>
      m && m.id === id ? { ...m, ...patch, id, updatedAt: new Date().toISOString() } : m,
    );
  }).mcpServers;
}

export function removeMcpServer(id) {
  return updateSettings((s) => {
    s.mcpServers = s.mcpServers.filter((m) => m && m.id !== id);
  }).mcpServers;
}

/** 给缺 id 的 mcpServers 条目补 id（手改 settings.json 的存量条目也能被 UI 编辑/删除）；无变更不写盘 */
export function ensureMcpServerIds() {
  return updateSettings((s) => {
    let changed = false;
    s.mcpServers = s.mcpServers.map((m) => {
      if (m && typeof m === 'object' && m.command && !m.id) {
        changed = true;
        return { id: genId('mcp_'), ...m };
      }
      return m;
    });
    if (!changed) return false;
  }).mcpServers;
}

/** 读取 Web UI 偏好（工作目录 / 模型 / 强度 / 权限模式） */
export function getUiPrefs() {
  return getSettings().uiPrefs;
}

/** 局部更新 UI 偏好；patch 可包含 defaultCwd / model / effort / mode 中的任意字段 */
export function setUiPrefs(patch) {
  return updateSettings((s) => {
    s.uiPrefs = { ...s.uiPrefs, ...patch };
  }).uiPrefs;
}

/** 我的飞书 open_id：全局身份标识，测试期用于筛多维表格「属于我的 BUG」记录 */
export function getMyFeishuOpenId() {
  return getSettings().myFeishuOpenId;
}

export function setMyFeishuOpenId(v) {
  return updateSettings((s) => {
    s.myFeishuOpenId = typeof v === 'string' ? v.trim() : '';
  }).myFeishuOpenId;
}

/** 记忆库配置：功能开关 / 凌晨窗口 / 最小提炼间隔 / 模型 / 注入预算 / 休眠天数 / 晋升阈值 */
export function getMemoryBankSettings() {
  return getSettings().memoryBank;
}

/** 局部更新记忆库配置；patch 可包含 DEFAULTS.memoryBank 的任意字段子集，其余字段保留原值 */
export function setMemoryBankSettings(patch) {
  return updateSettings((s) => {
    s.memoryBank = { ...s.memoryBank, ...(patch && typeof patch === 'object' ? patch : {}) };
  }).memoryBank;
}

/** 整体替换设置（导入用）：对传入对象做 normalize 后单次锁内整体写盘。
 *  一次写盘 → 一次 fs.watch 触发飞书热重载，避免多 setter 的中间态。 */
export function replaceSettings(next) {
  return updateSettings((s) => {
    const n = normalizeSettings(next);
    s.lark = n.lark;
    s.bots = n.bots;
    s.tokens = n.tokens;
    s.mcpServers = n.mcpServers;
    s.plugins = n.plugins;
    s.messages = n.messages;
    s.persona = n.persona;
    s.uiPrefs = n.uiPrefs;
    s.myFeishuOpenId = n.myFeishuOpenId;
    s.memoryBank = n.memoryBank;
  });
}

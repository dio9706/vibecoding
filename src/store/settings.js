/**
 * 设置持久化 —— 唯一入口（settings.json）：飞书凭证 + 备用 token 池 + 文案 + UI 偏好。
 * web 与 feishu 两个进程都会写（feishu 经 claudeAuthOpts→noteRateLimit 更新 token 状态），
 * 所有变更走 updateSettings（跨进程文件锁内读-改-写）。含明文密钥 → 已 gitignore。
 */
import { readJson, updateJson } from './index.js';
import { DEFAULT_PROVIDER_ID } from '../shared/provider-ids.js';
import { BUILTIN_MCP_IDS, BUILTIN_SKILL_IDS, SUPERPOWERS_SKILL_IDS } from '../shared/builtin-ids.js';
import { EXEC_POLICIES } from '../capabilities/tool-policy.logic.js';
import { SEARCH_PROVIDERS } from '../capabilities/web-tools.logic.js';

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
  uiPrefs: { defaultCwd: '', model: 'auto', effort: 'medium', mode: 'default', defaultModel: '', defaultEffort: '', defaultMode: '', disabledTools: [], taskNotifyFeishu: false, projectMapIdleRefresh: false, openaiMaxSteps: 0 },
  myFeishuOpenId: '', // 我的飞书 open_id：全局身份标识，测试期筛多维表格「属于我的 BUG」用
  // 内置 MCP 开关：{ [id]: { enabled?, apiKey? } }；缺省值以 capabilities/builtin-mcp 注册表的
  // defaultEnabled 为准（老 settings 无需迁移，未显式写过就是注册表默认）。未知 id 由 normalize 剔除。
  builtinMcp: {},
  // 内置 Skills 开关：{ [id]: { enabled? } }（superpowers 的装载在 Phase 2）
  builtinSkills: {},
  // Repo map（代码地图）：给自定义模型会话注入确定性代码索引（文件 + 导出符号），默认开
  repoMap: { enabled: true },
  // Bash 执行后端（T6，仅 openai 路径）：local=宿主直接执行（现状）；container=docker/podman 内执行。
  // backend=container 且引擎不可用时 fail-closed（Bash 报错，不静默退回本地）；network=false 容器无网。
  exec: { backend: 'local', image: 'node:22-bookworm', network: false },
  // 联网搜索（仅 openai 路径的 WebSearch 工具）：provider 三选一（tavily/brave/bocha）+ apiKey。
  // 默认空 = 未配置（工具返回指引文案，不发请求）。
  search: { provider: '', apiKey: '' },
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
    builtinMcp: normalizeBuiltinState(s.builtinMcp, BUILTIN_MCP_IDS),
    builtinSkills: normalizeBuiltinState(s.builtinSkills, BUILTIN_SKILL_IDS, { skillIds: SUPERPOWERS_SKILL_IDS }),
    repoMap: { enabled: typeof s.repoMap?.enabled === 'boolean' ? s.repoMap.enabled : DEFAULTS.repoMap.enabled },
    exec: normalizeExec(s.exec),
    search: normalizeSearch(s.search),
    memoryBank: s.memoryBank && typeof s.memoryBank === 'object' && !Array.isArray(s.memoryBank)
      ? { ...DEFAULTS.memoryBank, ...s.memoryBank }
      : { ...DEFAULTS.memoryBank },
  };
}

/**
 * 内置能力状态归一（纯函数）：只保留白名单 id 的对象条目，enabled 取布尔、apiKey 取非空字符串。
 * skillIds 传入时额外收录 disabledSkills（技能项白名单过滤 + 去重 + 稳定排序）——只有 Skills 包用。
 * 未知 id 直接剔除——否则删掉的内置项会在 settings 里留下永不再读的僵尸键。
 */
function normalizeBuiltinState(raw, ids, { skillIds = null } = {}) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const id of ids) {
    const v = raw[id];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const entry = {};
    if (typeof v.enabled === 'boolean') entry.enabled = v.enabled;
    if (typeof v.apiKey === 'string' && v.apiKey.trim()) entry.apiKey = v.apiKey.trim();
    if (skillIds && Array.isArray(v.disabledSkills)) {
      const disabled = [...new Set(skillIds.filter((sid) => v.disabledSkills.includes(sid)))].sort();
      if (disabled.length) entry.disabledSkills = disabled;
    }
    out[id] = entry;
  }
  return out;
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

/**
 * 无人值守执行档位（T6）：bypass=全放行（默认，与改动前一致）/ standard / trusted。
 * 枚举本体收在 capabilities/tool-policy.logic.js（规则表＋映射的唯一来源）。
 */
export function normalizeExecPolicy(v) {
  return EXEC_POLICIES.includes(v) ? v : 'bypass';
}

/** Exec 配置归一（纯函数）：后端白名单 + 镜像名 + network 布尔；非法值 fail-closed 回默认 */
export function normalizeExec(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    backend: r.backend === 'container' ? 'container' : 'local',
    image: typeof r.image === 'string' && r.image.trim() ? r.image.trim() : DEFAULTS.exec.image,
    network: typeof r.network === 'boolean' ? r.network : DEFAULTS.exec.network,
  };
}

/** 联网搜索配置归一（纯函数）：provider 三选一白名单 + apiKey trim；非法值回空（未配置） */
export function normalizeSearch(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    provider: SEARCH_PROVIDERS.includes(r.provider) ? r.provider : '',
    apiKey: typeof r.apiKey === 'string' ? r.apiKey.trim() : '',
  };
}

/** 纯函数：构造一个机器人条目。显式传 id/index/now 保持可测。 */
export function makeBotEntry({ id, name, platform, appId, appSecret, persona, messages, projectDir, projectNotes, setupScript, verifyScript, autonomy, execPolicy, enabled, index = 0, now }) {
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
    verifyScript: typeof verifyScript === 'string' ? verifyScript.trim() : '', // 自检命令（空=不验证；只来自 owner 配置）
    autonomy: normalizeAutonomy(autonomy), // 托管程度
    execPolicy: normalizeExecPolicy(execPolicy), // 无人值守执行档位（T6；默认 bypass=与改动前一致）
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
export function addBot({ name, platform, appId, appSecret, persona, messages, projectDir, projectNotes, setupScript, verifyScript, autonomy, execPolicy, enabled }) {
  let created = null;
  updateSettings((s) => {
    created = makeBotEntry({
      id: genId('bot_'),
      name, platform, appId, appSecret, persona, messages, projectDir, projectNotes, setupScript, verifyScript, autonomy, execPolicy, enabled,
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

// ==== 内置能力（MCP / Skills）开关：只存状态，注册表与默认值在 capabilities 侧 ====

/** 内置 MCP 状态：{ [id]: { enabled?, apiKey? } }；缺省项由注册表 defaultEnabled 兜底 */
export function getBuiltinMcp() {
  return getSettings().builtinMcp;
}

/**
 * 局部更新内置 MCP 状态。apiKey 传空串 = 清除（不保留空值，防「有 key」判定被空串骗过）。
 * 未知 id 抛错（白名单在 shared/builtin-ids，与注册表严格一致）。
 */
export function setBuiltinMcp(id, patch = {}) {
  if (!BUILTIN_MCP_IDS.includes(id)) throw new Error(`未知的内置 MCP：${id}`);
  return updateSettings((s) => {
    const cur = s.builtinMcp[id] && typeof s.builtinMcp[id] === 'object' ? s.builtinMcp[id] : {};
    const next = { ...cur };
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch.apiKey === 'string') {
      const key = patch.apiKey.trim();
      if (key) next.apiKey = key;
      else delete next.apiKey;
    }
    s.builtinMcp = { ...s.builtinMcp, [id]: next };
  }).builtinMcp;
}

/** 内置 Skills 状态：{ [id]: { enabled?, disabledSkills? } }；disabledSkills 只存「被停用的技能项」 */
export function getBuiltinSkills() {
  return getSettings().builtinSkills;
}

export function setBuiltinSkill(id, enabled) {
  if (!BUILTIN_SKILL_IDS.includes(id)) throw new Error(`未知的内置 Skill：${id}`);
  return updateSettings((s) => {
    const cur = s.builtinSkills[id] && typeof s.builtinSkills[id] === 'object' ? s.builtinSkills[id] : {};
    s.builtinSkills = { ...s.builtinSkills, [id]: { ...cur, enabled: !!enabled } };
  }).builtinSkills;
}

/** 各内置技能包支持 per-skill 开关的项白名单（新增包在这里登记；未登记 = 没有 per-skill 维度） */
const BUILTIN_SKILL_ITEM_IDS = { superpowers: SUPERPOWERS_SKILL_IDS };

/**
 * per-skill 开关：只维护「被停用项」清单（新增/改名的上游技能默认保持启用，不会因存量配置被静默关掉）。
 * 技能项全恢复启用时删除空数组，保持 settings 干净。
 */
export function setBuiltinSkillItem(pkgId, skillId, enabled) {
  if (!BUILTIN_SKILL_IDS.includes(pkgId) || !BUILTIN_SKILL_ITEM_IDS[pkgId]) throw new Error(`未知的内置 Skill：${pkgId}`);
  if (!BUILTIN_SKILL_ITEM_IDS[pkgId].includes(skillId)) throw new Error(`未知的技能项：${skillId}`);
  return updateSettings((s) => {
    const cur = s.builtinSkills[pkgId] && typeof s.builtinSkills[pkgId] === 'object' ? s.builtinSkills[pkgId] : {};
    const disabled = new Set(Array.isArray(cur.disabledSkills) ? cur.disabledSkills : []);
    if (enabled) disabled.delete(skillId);
    else disabled.add(skillId);
    const next = { ...cur };
    const rest = [...disabled].sort();
    if (rest.length) next.disabledSkills = rest;
    else delete next.disabledSkills;
    s.builtinSkills = { ...s.builtinSkills, [pkgId]: next };
  }).builtinSkills;
}

// ==== Repo map（代码地图）开关：仅影响自定义模型会话的 system prompt 注入 ====

export function getRepoMapSettings() {
  return getSettings().repoMap;
}

// ==== Bash 执行后端（T6，仅 openai 路径）====

export function getExecSettings() {
  return getSettings().exec;
}

// ==== 联网搜索（openai 路径 WebSearch 工具）====

export function getSearchSettings() {
  return getSettings().search;
}

export function setSearchSettings(patch) {
  return updateSettings((s) => {
    s.search = normalizeSearch({ ...s.search, ...(patch && typeof patch === 'object' ? patch : {}) });
  }).search;
}

export function setExecSettings(patch) {
  return updateSettings((s) => {
    s.exec = normalizeExec({ ...s.exec, ...(patch && typeof patch === 'object' ? patch : {}) });
  }).exec;
}

export function setRepoMapEnabled(enabled) {
  return updateSettings((s) => {
    s.repoMap = { ...s.repoMap, enabled: !!enabled };
  }).repoMap;
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

/** 纯函数：构造一个 token/凭证条目。openai 条目额外带 baseURL/model/vendor/models；claude 条目不含。
 *  vendor 是**纯展示元数据**（录入时选的厂商预设，用于设置页列表显示「DeepSeek」而非「—」），
 *  不参与任何运行时逻辑——路由靠 providerId，请求参数靠 baseURL/model。
 *  `models` = 从服务商 /models 发现到的可用模型（OpenCode 式多模型，T 见 spec
 *  `docs/superpowers/specs/2026-10-08-credential-multi-model-design.md`）；`model` 是 legacy
 *  单模型字段（老凭证/curl 手传仍在，新链路不再写入）。
 *  各可选字段一律条件展开：claude 条目不该凭空多出空字段，保持两类条目形状干净。
 *  显式传 id/index/now 以保持纯粹可测（无 random/时间副作用）。 */
export function makeTokenEntry({ id, label, token, providerId = DEFAULT_PROVIDER_ID, baseURL, model, vendor, models, modelsUpdatedAt, index = 0, now }) {
  return {
    id,
    providerId,
    label: label || `账号${index + 1}`,
    token: token || '',
    ...(baseURL != null ? { baseURL } : {}),
    ...(model != null ? { model } : {}),
    ...(vendor != null ? { vendor } : {}),
    ...(Array.isArray(models) && models.length ? { models: normalizeModelList(models) } : {}),
    ...(modelsUpdatedAt != null ? { modelsUpdatedAt } : {}),
    status: 'healthy',
    resetsAt: null,
    rateLimitType: null,
    utilization: null,
    updatedAt: now,
  };
}

/** 纯函数：归一模型列表 [{id, name?, efforts?, defaultEffort?}]（跳过空 id、去重保序、name 与 id 相同则省略）。
 *  efforts/defaultEffort 来自 `/models` 的 effort 元数据（自定义模型强度档位，见 composer-bar spec）。 */
export function normalizeModelList(list) {
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(list) ? list : []) {
    const id = typeof m === 'string' ? m.trim() : String(m?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof m?.name === 'string' ? m.name.trim() : '';
    const efforts = Array.isArray(m?.efforts)
      ? [...new Set(m.efforts.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean))]
      : [];
    const defaultEffort = typeof m?.defaultEffort === 'string' ? m.defaultEffort.trim() : '';
    out.push({
      id,
      ...(name && name !== id ? { name } : {}),
      ...(efforts.length ? { efforts } : {}),
      ...(defaultEffort && efforts.includes(defaultEffort) ? { defaultEffort } : {}),
    });
  }
  return out;
}

/**
 * 纯函数：凭证可用的模型列表 —— 读侧**单一事实源**。
 * `models`（发现结果）优先；否则回落 legacy `model` 单值；否则空。
 * `GET /api/credentials`、`resolveCredential`、聊天弹层全部经此归一，老凭证无感兼容。
 */
export function credentialModels(t) {
  const list = normalizeModelList(t?.models);
  if (list.length) return list;
  const legacy = typeof t?.model === 'string' ? t.model.trim() : '';
  return legacy ? [{ id: legacy }] : [];
}

/** 新增凭证/账号并返回**新建条目**（添加端点要把 id 回给前端接着刷新模型列表） */
export function addTokenEntry(label, token, providerId = DEFAULT_PROVIDER_ID, extra = {}) {
  let created = null;
  updateSettings((s) => {
    created = makeTokenEntry({
      id: genId(),
      label,
      token,
      providerId,
      baseURL: extra.baseURL,
      model: extra.model,
      vendor: extra.vendor,
      models: extra.models,
      modelsUpdatedAt: extra.modelsUpdatedAt,
      index: s.tokens.length,
      now: new Date().toISOString(),
    });
    s.tokens.push(created);
  });
  return created;
}

/** 新增一个备用账号（追加到偏好末尾） */
export function addToken(label, token, providerId = DEFAULT_PROVIDER_ID, extra = {}) {
  addTokenEntry(label, token, providerId, extra);
  return getSettings().tokens;
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

/** web 入口：日志 / 任务 / 历史 / 动作配置 / 脚本 / 启动初始化 / 运维路由 handler */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { getEvents, clearEvents } from '../../store/event-log.js';
import { getBotLogs, clearBotLogs } from '../../store/bot-log.js';
import { getTasks, getTask, updateTask } from '../../store/tasks.js';
import { getPluginEnabled, getActiveBot } from '../../store/settings.js';
import { analyze, develop } from '../../plugins/team-tools/task-ops.js';
// 只引入队 API（queue.js 是零重依赖叶子）。从 auto-dev/index.js 引会把 git / 编译 /
// 飞书回发 / Claude 调用整条执行链拖进这个 HTTP 路由模块
import { requestAutoDevelop, isOverrideStart } from '../../plugins/team-tools/auto-dev/queue.js';
import { mergeTaskById, discardTaskById } from '../../plugins/team-tools/task-actions.js';
import { recordOverride } from '../../plugins/team-tools/review/index.js';
import {
  listHistorySessions,
  getHistorySession,
  searchHistorySessions,
} from '../../store/history.js';
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';

/** 统一日志：事件日志，按时间倒序排列 */
export function handleLogs(res) {
  const events = getEvents();
  sendJson(res, 200, { logs: events.slice(0, 1000) });
}

/** 清空全部访问日志 */
export function handleLogsClear(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  try {
    clearEvents();
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

/** 机器人端业务日志（面板数据源），最新在前。条数已在 store 内封顶，此处不再 slice */
export function handleBotLogs(res) {
  sendJson(res, 200, { logs: getBotLogs() });
}

/** 清空全部机器人日志 */
export function handleBotLogsClear(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  try {
    clearBotLogs();
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

/** 需求/故障任务列表（team-tools 插件的 web 侧路由，插件停用即 404） */
export function handleTasks(res) {
  if (!getPluginEnabled('team-tools')) return sendJson(res, 404, { error: '团队工具插件未启用' });
  sendJson(res, 200, { tasks: getTasks() });
}

/** 任务操作：开始进行 / 修正（补方案重新分析）/ 放弃 / 合并到主分支 / 放弃改动（删任务分支） */
export function handleTaskAction(req, res) {
  if (!getPluginEnabled('team-tools')) return sendJson(res, 404, { error: '团队工具插件未启用' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  // withJsonBody 兜住回调内的一切异常（如 updateTask 写盘 EPERM/ENOSPC）：
  // 原来的裸 req.on('end', async …) 无 catch，一抛即 uncaughtException + 请求永久挂死。
  return withJsonBody(req, res, async (data) => {
    const task = getTask(data.id);
    if (!task) return sendJson(res, 404, { error: '任务不存在' });

    if (data.action === 'start') {
      // 排队/执行/已完成的任务不允许重复开始（防重复改码）
      if (['queued', 'developing', 'done'].includes(task.status)) {
        return sendJson(res, 400, { error: `任务当前状态（${task.status}）不允许开始开发` });
      }
      // 被评审质疑/拒绝的任务由 owner 强行开始 → 记人工覆盖判例（校准后续评审）
      if (isOverrideStart(task)) recordOverride(task);
      const autonomy = getActiveBot()?.autonomy || 'light';
      if (autonomy !== 'light') {
        // 中度/完全托管：入自动开发队列（任务分支 + 待确认合并；泵在本进程串行执行）
        const t = requestAutoDevelop(task.id, '确认开始开发（自动管线）');
        return sendJson(res, 200, { task: t });
      }
      const t = updateTask(task.id, { status: 'developing' }, '确认开始开发');
      develop(t).catch((e) => logger.error('web', 'develop 失败', { id: t.id, err: e?.message || String(e) })); // 异步开发
      return sendJson(res, 200, { task: t });
    }
    if (data.action === 'fix') {
      const t = updateTask(
        task.id,
        { fixNote: data.fixNote || '', status: 'analyzing' },
        '补充修正方案，重新分析',
      );
      analyze(t).catch((e) => logger.error('web', 'analyze 失败', { id: t.id, err: e?.message || String(e) })); // 异步重新分析
      return sendJson(res, 200, { task: t });
    }
    if (data.action === 'reject') {
      // rejectedBy 标记：owner 明确毙掉的任务，评审否定判决（review.verdict）虽残留也不允许提交人「坚持修改」复活
      const t = updateTask(task.id, { status: 'rejected', rejectedBy: 'owner' }, '放弃');
      return sendJson(res, 200, { task: t });
    }
    // merge / discard 的编排下沉到 team-tools/task-actions（飞书卡片按钮共用同一份），
    // 这里只做状态码与响应体形状的映射：成功 { task }，失败 { error, task? }。
    if (data.action === 'merge') {
      const r = await mergeTaskById(task.id);
      return sendJson(res, r.code, r.ok ? { task: r.task } : { error: r.error, task: r.task });
    }
    if (data.action === 'discard') {
      const r = await discardTaskById(task.id);
      return sendJson(res, r.code, r.ok ? { task: r.task } : { error: r.error, task: r.task });
    }
    return sendJson(res, 400, { error: '未知操作' });
  });
}

/**
 * GET /api/history?q=search_query
 * 返回历史会话列表
 * 参数：
 *   - q: 搜索关键词（可选）
 *   - limit: 返回结果数量限制，默认 100
 *   - offset: 分页偏移，默认 0
 */
export async function handleHistory(url, res) {
  try {
    const searchQuery = url.searchParams.get('q') || '';
    const cwd = url.searchParams.get('cwd') || ''; // 按工作目录定位对应 project 历史，空=服务目录
    // limit 钳制到 [1,1000]、offset 钳制到 >=0，避免 ?offset=-5 让 slice 返回尾部意外数据
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(url.searchParams.get('offset'), 10) || 0, 0);

    let sessions;
    if (searchQuery) {
      sessions = await searchHistorySessions(searchQuery, limit, cwd);
    } else {
      sessions = await listHistorySessions(limit, offset, cwd);
    }

    sendJson(res, 200, { ok: true, data: sessions });
  } catch (e) {
    // 完整错误只打本地日志，避免向客户端泄露绝对路径/用户输入回显
    logger.error('web', 'History API 异常', { err: e?.message || String(e) });
    sendJson(res, 500, { ok: false, error: '读取历史失败' });
  }
}

/**
 * GET /api/history/:sessionId
 * 返回单个会话的完整记录（用于续接）
 */
export async function handleHistoryDetail(url, res) {
  try {
    // 取 /api/history/ 之后的完整剩余段：split('/').pop() 会把
    // /api/history/AAA/BBB 读成 BBB（读错了会话），剩余段含 / 一律 404。
    const sessionId = url.pathname.slice('/api/history/'.length);
    if (!sessionId || sessionId.includes('/')) {
      sendJson(res, 404, { ok: false, error: 'Session not found' });
      return;
    }
    const cwd = url.searchParams.get('cwd') || ''; // 与列表一致：按工作目录定位对应 project

    const session = await getHistorySession(sessionId, cwd);

    if (!session) {
      sendJson(res, 404, { ok: false, error: 'Session not found' });
      return;
    }

    sendJson(res, 200, { ok: true, data: session });
  } catch (e) {
    // 完整错误只打本地日志，避免向客户端泄露绝对路径/用户输入回显
    logger.error('web', 'History detail API 异常', { err: e?.message || String(e) });
    sendJson(res, 500, { ok: false, error: '读取历史失败' });
  }
}

/** GET /api/actions?botId= — 列出动作配置（botId 必传：动作 per-bot 独享） */
export async function handleActionsGet(res, url) {
  try {
    const { getConfigs } = await import('../../store/action-configs.js');
    const botId = url?.searchParams?.get('botId') || '';
    const configs = getConfigs().filter((c) => !botId || c.botId === botId);
    sendJson(res, 200, configs);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

/** POST /api/actions — 新建动作配置（必填 botId，归属机器人） */
export async function handleActionsPost(req, res) {
  return withJsonBody(req, res, async (data) => {
    try {
      const { getBots } = await import('../../store/settings.js');
      if (!data.botId || !getBots().some((b) => b && b.id === data.botId)) {
        return sendJson(res, 400, { error: 'botId 无效：动作必须归属一个机器人' });
      }
      const varErr = await checkVariables(data);
      if (varErr) return sendJson(res, 422, { error: varErr });
      const { v4: uuidv4 } = await import('uuid');
      const { addConfig } = await import('../../store/action-configs.js');
      const config = {
        ...data,
        id: uuidv4(),
      };
      const added = addConfig(config);
      sendJson(res, 200, added);
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
  });
}

/**
 * GET /api/action-presets — 变量预置表（只读）。
 *
 * 存在的唯一理由是**防分叉**：设置页要让用户看见「选了 env preset 到底继承了什么」，
 * 若前端自己抄一份别名表，那就又多了一份真相 —— 而这次改造正是为了消灭
 * 「Node 侧与 get_qrcode.py 各存一份 ENV_ALIASES 且已经分叉」这个问题。
 */
export async function handleActionPresetsGet(res) {
  try {
    const { PRESETS } = await import('../../plugins/action-runner/feature/var-presets.js');
    sendJson(res, 200, PRESETS);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

/**
 * 变量声明校验 —— 保存时拦，运行时不再校验。
 *
 * 返回中文错误串直接给用户看；**不做静默修正**：静默丢弃非法字段会让用户以为配置生效了，
 * 而机器人行为却对不上（enum 写错一个字母就退化成自由文本走 LLM，从表象根本看不出来）。
 *
 * 动态 import 是本文件既有风格（handler 都在函数内按需 import，避免启动期拉起整条插件链）。
 * @returns {Promise<string|null>} 错误说明；null = 合法或本次未涉及 variables
 */
async function checkVariables(data) {
  if (!data || data.variables === undefined) return null;
  const { validateActionVariables } = await import(
    '../../plugins/action-runner/feature/var-contract.js'
  );
  return validateActionVariables(data);
}

/**
 * 取 /api/actions/ 之后的完整剩余段作为 id。
 * 原先用 split('/').pop()：PUT /api/actions/AAA/BBB 会落到 BBB 上，改错资源。
 * 剩余段仍含 '/' 说明不是单个资源路径 → 交由调用方 404。
 */
function actionIdFromPath(url) {
  const rest = url.pathname.slice('/api/actions/'.length);
  return rest.includes('/') ? null : rest;
}

/** PUT /api/actions/:id — 更新动作配置（botId 归属不可改，剥离） */
export async function handleActionsPut(req, res, url) {
  const id = actionIdFromPath(url);
  if (id === null) return sendJson(res, 404, { error: 'not found' });
  return withJsonBody(req, res, async (payload) => {
    try {
      const { botId: _ignored, ...data } = payload;
      const varErr = await checkVariables(data);
      if (varErr) return sendJson(res, 422, { error: varErr });
      const { updateConfig } = await import('../../store/action-configs.js');
      const updated = updateConfig(id, data);
      if (!updated) {
        return sendJson(res, 404, { error: '配置不存在' });
      }
      sendJson(res, 200, updated);
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
  });
}

/** DELETE /api/actions/:id — 删除动作配置 */
export async function handleActionsDelete(req, res, url) {
  try {
    const id = actionIdFromPath(url);
    if (id === null) return sendJson(res, 404, { error: 'not found' });
    const { deleteConfig, getConfig } = await import('../../store/action-configs.js');
    const config = getConfig(id);
    if (!config) {
      return sendJson(res, 404, { error: '配置不存在' });
    }
    deleteConfig(id);
    sendJson(res, 200, { success: true });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

/** 纯函数：列出目录下的 .py/.js 文件名；目录不存在或异常返回 [] */
export function listScriptFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && /\.(py|js)$/.test(f.name))
      .map((f) => f.name);
  } catch {
    return [];
  }
}

/** GET /api/scripts — 列出脚本目录（绝对，见 config.scripts.dir）下的脚本文件 */
export function handleScripts(res) {
  sendJson(res, 200, listScriptFiles(config.scripts.dir));
}

/** 首次启动初始化：bots 迁移 → 默认动作配置 → bindings→user-vars 迁移（均幂等） */
export async function initializeDefaults() {
  const { readJson, writeJson } = await import('../../store/index.js');
  const { getConfigs, addConfig } = await import('../../store/action-configs.js');

  // 0. 旧「单凭证 + 全局 persona/文案」→ 机器人实体 + 动作收养（必须先于默认动作创建）
  try {
    const { migrateToBots } = await import('../../store/bots-migration.js');
    const r = migrateToBots();
    if (r.migrated) console.log(`✓ 旧配置已迁移为机器人实体（收养动作 ${r.adopted} 条）`);
  } catch (e) {
    logger.warn('initialization', 'bots 迁移失败', { err: e?.message });
  }

  // 0.5 变量抽取契约迁移：给存量 env/phone 变量补上 preset 声明。
  // 不迁移不会坏（未声明的变量退化为「走 LLM」，行为仍正确），但会白丢本地快路的收益。
  // 幂等靠动作条目上的 _varContractMigrated 标记，不是每次按变量名重扫 ——
  // 后者会让用户手动删掉的 preset 一重启就被加回来（详见该模块文件头）。
  try {
    const { migrateVarContract } = await import('../../store/var-contract-migration.js');
    const r = migrateVarContract();
    if (r.migrated) console.log(`✓ 动作变量契约已迁移（${r.migrated}/${r.scanned} 条动作）`);
  } catch (e) {
    logger.warn('initialization', '变量契约迁移失败', { err: e?.message });
  }

  // 1. 创建默认清理配置（如果不存在；动作 per-bot 独享 → 无启用机器人时跳过）
  const { getActiveBot } = await import('../../store/settings.js');
  const activeBot = getActiveBot();
  const configs = getConfigs();
  const hasCleanupAction = configs.some((c) => c.scriptName === 'reset_onboarding.py');

  if (!hasCleanupAction && activeBot) {
    const { v4: uuidv4 } = await import('uuid');
    const defaultConfig = {
      id: uuidv4(),
      botId: activeBot.id,
      name: '清理账号数据',
      description: '通过后台接口清理指定用户在 dev/test 环境的 onboarding 初始化数据',
      keywords: ['清理', '清一下', '清空', '清数据', '重置', 'cleanup', 'reset'],
      scriptType: 'python',
      scriptName: 'reset_onboarding.py',
      // 破坏性动作（删 dev/test 环境用户数据）默认收窄到 owner。
      // 权限现由 action-runner/feature/permission.js 真正执行（此前该字段是死字段）；
      // 若确需对全员开放，在设置页把它改成 Guest。
      permission: 'owner',
      enabled: true,
      variables: [
        {
          name: 'env',
          label: '环境',
          prompt: '要清理哪个环境？开发版（dev）或 体验版（test）',
          required: true,
          persistent: false,
          // preset 让这个变量走本地词表抽取（零 LLM）。不写也能用，但每次都要花 8~17s
          // 调模型做查表 —— 契约见 plugins/action-runner/feature/var-presets.js
          preset: 'env',
        },
        {
          name: 'phone',
          label: '手机号',
          prompt: '请提供要清理的用户手机号（11 位数字）',
          required: true,
          persistent: true,
          preset: 'phone',
        },
      ],
    };
    addConfig(defaultConfig);
    console.log('✓ 默认清理动作已创建（reset_onboarding.py）');
  }

  // 2. 迁移 bindings → user-vars
  try {
    const bindings = readJson('bindings.json', null);
    const userVars = readJson('user-vars.json', null);
    if (bindings && !userVars) {
      const migrated = {};
      for (const [userId, phone] of Object.entries(bindings)) {
        migrated[userId] = { phone };
      }
      writeJson('user-vars.json', migrated);
      console.log('✓ 用户变量已从 bindings.json 迁移');
    }
  } catch (e) {
    logger.warn('initialization', '迁移用户数据失败', { err: e?.message });
  }
}

/**
 * 编辑器白名单。
 *
 * 为什么必须有：`editor` 来自请求体且直接进 `execFile(editor, [path])`。
 * execFile 不走 shell，所以没有命令拼接注入的问题，但它照样能启动
 * **PATH 里的任意程序** —— 不限制的话这个接口的真实语义是「执行任意程序」，
 * 而它的本意只是「打开编辑器」。本地服务无鉴权，攻击面不该白送。
 */
const ALLOWED_EDITORS = new Set(['windsurf', 'cursor', 'code']);

/**
 * 文件管理器命令按平台映射。
 *
 * 前端传语义值 `'filemanager'`，具体命令由后端决定 —— **平台判断只能在后端做**：
 * 前端是浏览器环境，没有 `process`。此前 dir-popover.js 里直接写了
 * `process.platform === 'win32' ? 'explorer' : 'open'`，运行时抛
 * ReferenceError 并被外层空 catch 吞掉，「在文件管理器中打开」这个菜单项
 * 从上线起就没工作过，且没有任何报错痕迹。
 */
const FILE_MANAGER_BY_PLATFORM = { win32: 'explorer', darwin: 'open' };

/** 用外部 AI 编辑器打开指定目录（Windsurf / Cursor / VS Code 依次尝试）。
 *  函数名与路由里的 "vibe" 是改名前的历史标识符，非产品名 Principal，勿混淆。 */
export function handleOpenInVibe(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const targetPath = str(data.path);
    if (!targetPath) return sendJson(res, 400, { error: 'path 不能为空' });

    const want = str(data.editor);
    let editors;
    let asFileManager = false;
    if (want === 'filemanager') {
      asFileManager = true;
      // 兜底 xdg-open：Linux 桌面的通用打开器
      editors = [FILE_MANAGER_BY_PLATFORM[process.platform] || 'xdg-open'];
    } else if (want) {
      if (!ALLOWED_EDITORS.has(want)) {
        return sendJson(res, 400, {
          error: `不支持的 editor：${want}（可选 ${[...ALLOWED_EDITORS].join(' / ')} 或 filemanager）`,
        });
      }
      editors = [want];
    } else {
      // 编辑器优先级：windsurf → cursor → code（VS Code）
      editors = ['windsurf', 'cursor', 'code'];
    }
    let idx = 0;

    function tryNext() {
      if (idx >= editors.length) {
        return sendJson(res, 500, { error: `未找到可用的编辑器（尝试了 ${editors.join(', ')}），请确认已安装并加入 PATH` });
      }
      const editor = editors[idx++];
      execFile(editor, [targetPath], { timeout: 8000, windowsHide: true }, (err) => {
        // Windows 的 explorer.exe 打开成功时退出码就是 1（系统怪癖，不是失败）。
        // 不特判的话文件管理器每次都会被报成「启动失败」。
        if (asFileManager && editor === 'explorer' && err && err.code === 1) {
          sendJson(res, 200, { ok: true, editor });
        } else if (err && (err.code === 'ENOENT' || err.code === 127 || err.message?.includes('not found'))) {
          tryNext(); // 该编辑器不存在，试下一个
        } else if (err && err.killed) {
          // 超时但进程已启动，视为成功（部分编辑器启动慢）
          sendJson(res, 200, { ok: true, editor });
        } else if (err) {
          sendJson(res, 500, { error: `${editor} 启动失败：${err.message}` });
        } else {
          sendJson(res, 200, { ok: true, editor });
        }
      });
    }
    tryNext();
  });
}

/** 健康检查端点（Tauri 启动时用来检查后端是否就绪） */
export function handlePing(res) {
  sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
}

/** 内部 IPC 通知端点（仅 127.0.0.1 可调，Tauri 主进程用于触发系统通知） */
export function handleNotify(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  // 64KB 上限交给 withJsonBody（按字节计，且 destroy 后不会二次 writeHead），
  // 原手写限流用的是 body.length 字符数，与注释的 64KB 并不等价。
  return withJsonBody(req, res, (data) => {
    const { body: notifyBody } = data;
    const title = str(data.title);

    // 验证必需字段
    if (!title) {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'title is required' }));
      return;
    }

    logger.info('notify', title, notifyBody);
    // Tauri 主进程会通过 IPC 调用此端点
    // 这里只是记录日志，实际通知由 Tauri 弹出
    sendJson(res, 200, { success: true });
  }, { maxBytes: 64 * 1024 });
}

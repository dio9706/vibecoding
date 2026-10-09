/**
 * openai-compat 的内置文件/命令工具集 —— 对标 OpenCode 的「宿主持有工具运行时」。
 *
 * 背景：Claude 路径的工具（Read/Write/Edit/Bash…）全由 Claude Agent SDK 白送；
 * 自定义模型（DeepSeek/Qwen/…）此前只能靠用户在设置页手配 MCP server 才有工具，
 * 没配就是纯聊天。本模块让 harness 自己实现一套基础工具，任何支持 Function Calling
 * 的 OpenAI 兼容模型接上 openai-compat 后开箱即具备「主动处理文件」的能力。
 *
 * 设计约束：
 * - 工具名/入参沿用 Claude Code 约定（Read/Write/Edit 用 file_path、Bash 用 command、
 *   Glob/Grep 用 pattern），tool-summary.js 的 summarizeTool 与前端审批卡零改动复用；
 * - 不 import `ai`：工具定义就是 plain `{ description, inputSchema: zod }`，
 *   转成模型请求是 openai-compat-model.js 里 streamText 的事（AI SDK 细节只封一处）；
 * - 所有路径先 resolve 再操作；读类工具在「工作目录内」自动放行，目录外读取与一切
 *   改动类调用交回入口弹审批卡（对齐 OpenCode 的 external_directory 语义）；
 * - 输出统一截断（条数/字节/字符），防止一次把模型上下文撑爆。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { resolveWorkspace, resolveToolPath, displayPath } from '../shared/workspace-paths.js';
import { makeBashSpawn } from './exec-backends.logic.js';

/** 内置工具名单。Read/Glob/Grep 只读；Write/Edit/Bash 有副作用（需审批）；RepoMap 只读、按需装配 */
export const BUILTIN_TOOL_NAMES = Object.freeze(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'RepoMap']);

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;
const MAX_LIST_ENTRIES = 200;
const DEFAULT_GLOB_RESULTS = 100;
const MAX_GLOB_RESULTS = 500;
const DEFAULT_GREP_MATCHES = 100;
const MAX_GREP_MATCHES = 500;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
/** 遍历类工具的软超时：防超大目录树把一步工具调用拖到看门狗（15min 静默）误杀 */
const WALK_TIMEOUT_MS = 30_000;
/** 遍历时永远跳过的目录：.git 几十万对象、node_modules 是噪音重灾区 */
const ALWAYS_IGNORED_DIRS = new Set(['.git', 'node_modules']);
const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
const MAX_BASH_OUTPUT = 30_000;

// ---------- 纯函数（可单测，不碰磁盘） ----------
// （工作目录路径工具已抽到 shared/workspace-paths.js：审批策略（capabilities/tool-policy）与
//  本文件共用同一份「区内/越界」判定，避免两处各写一份分叉。）

/**
 * glob → 正则（纯函数）。支持 `**`（跨目录）、`*`、`?`、`{a,b}`（不支持嵌套大括号）。
 * 刻意不让 `*` 跨 `/`：`*.js` 只匹配根层，跨层请写 `**\/*.js` —— 与 Claude Code 的 Glob 语义一致。
 */
export function globToRegExp(glob) {
  const s = String(glob);
  let re = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*' && s[i + 1] === '*') {
      i++;
      if (s[i + 1] === '/') {
        i++;
        re += '(?:[^/]+/)*'; // `**/` 匹配零或多级目录
      } else {
        re += '.*';
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = s.indexOf('}', i + 1);
      if (end === -1) re += '\\{';
      else {
        const parts = s
          .slice(i + 1, end)
          .split(',')
          .map((p) => p.replace(/[.+^${}()|[\]\\*?]/g, '\\$&'));
        re += '(?:' + parts.join('|') + ')';
        i = end;
      }
    } else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

/** 前 8KB 出现 NUL 视为二进制（与 git/ripgrep 的启发式一致） */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function clip(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function capText(s, n) {
  return s.length > n ? s.slice(0, n) + `\n…（输出过长，已截断到 ${n} 字符）` : s;
}

// ---------- 文件遍历 ----------

/**
 * 深度优先产出 root 下所有普通文件（不跟随 symlink：防环 + 防借链接越出工作目录）。
 * 循环内检查 deadline/signal，超大仓库不会拖到超时兜底。
 */
async function* walkFiles(root, ctx) {
  const deadline = Date.now() + WALK_TIMEOUT_MS;
  const stack = [root];
  while (stack.length) {
    if (ctx.signal?.aborted || Date.now() > deadline) return;
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 权限/竞态删除等：跳过该目录，不因一棵子树失败整体失败
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!ALWAYS_IGNORED_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        yield full;
      }
    }
  }
}

// ---------- 各工具实现 ----------

async function readTool({ file_path, offset, limit }, ctx) {
  const abs = resolveToolPath(file_path, ctx.workspace);
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    throw new Error(`文件或目录不存在：${displayPath(abs, ctx.workspace)}`);
  }
  if (st.isDirectory()) {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const list = entries
      .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
      .sort()
      .slice(0, MAX_LIST_ENTRIES);
    const more = entries.length > MAX_LIST_ENTRIES ? `\n…（共 ${entries.length} 项，已截断）` : '';
    return `目录 ${displayPath(abs, ctx.workspace)}：\n` + (list.join('\n') || '（空目录）') + more;
  }
  const buf = await fs.readFile(abs);
  if (looksBinary(buf)) throw new Error(`二进制文件不支持文本读取：${displayPath(abs, ctx.workspace)}`);
  if (buf.length === 0) return `（空文件：${displayPath(abs, ctx.workspace)}）`;

  const lines = buf.toString('utf8').split(/\r?\n/);
  const start = Math.max((offset || 1) - 1, 0);
  const maxLines = Math.min(Math.max(limit || MAX_READ_LINES, 1), MAX_READ_LINES);
  const picked = [];
  let bytes = 0;
  for (let i = start; i < lines.length && picked.length < maxLines; i++) {
    const line = clip(lines[i], 2000);
    const size = Buffer.byteLength(line, 'utf8') + 8;
    if (bytes + size > MAX_READ_BYTES) break;
    bytes += size;
    picked.push(`${i + 1}: ${line}`);
  }
  if (!picked.length) return `（文件共 ${lines.length} 行，起始行 ${start + 1} 已超出）`;

  const lastShown = start + picked.length;
  const footer = lastShown < lines.length ? `\n…（共 ${lines.length} 行，已显示到第 ${lastShown} 行；可用 offset=${lastShown + 1} 继续读）` : '';
  return picked.join('\n') + footer;
}

async function writeTool({ file_path, content }, ctx) {
  const abs = resolveToolPath(file_path, ctx.workspace);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  const bytes = Buffer.byteLength(content, 'utf8');
  const lines = content === '' ? 0 : content.split(/\r?\n/).length;
  return `已写入 ${displayPath(abs, ctx.workspace)}（${bytes} 字节，${lines} 行）`;
}

async function editTool({ file_path, old_string, new_string, replace_all }, ctx) {
  if (!old_string) throw new Error('old_string 不能为空；新建文件请用 Write');
  if (old_string === new_string) throw new Error('old_string 与 new_string 相同，无需编辑');
  const abs = resolveToolPath(file_path, ctx.workspace);
  let text;
  try {
    text = await fs.readFile(abs, 'utf8');
  } catch {
    throw new Error(`文件不存在或不可读：${displayPath(abs, ctx.workspace)}`);
  }
  const count = text.split(old_string).length - 1;
  if (count === 0) throw new Error(`未在 ${displayPath(abs, ctx.workspace)} 中找到 old_string（空白与换行必须精确匹配）`);
  if (count > 1 && !replace_all) {
    throw new Error(`old_string 在文件中匹配到 ${count} 处；请补充上下文使其唯一，或传 replace_all=true 全部替换`);
  }
  const at = text.indexOf(old_string);
  const next = replace_all
    ? text.split(old_string).join(new_string)
    : text.slice(0, at) + new_string + text.slice(at + old_string.length);
  await fs.writeFile(abs, next, 'utf8');
  return `已编辑 ${displayPath(abs, ctx.workspace)}（替换 ${replace_all ? count : 1} 处）`;
}

async function globTool({ pattern, path: base, limit }, ctx) {
  const root = base ? resolveToolPath(base, ctx.workspace) : ctx.workspace;
  const re = globToRegExp(pattern);
  const cap = Math.min(Math.max(limit || DEFAULT_GLOB_RESULTS, 1), MAX_GLOB_RESULTS);
  const out = [];
  let truncated = false;
  for await (const file of walkFiles(root, ctx)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (!re.test(rel)) continue;
    out.push(displayPath(file, ctx.workspace));
    if (out.length >= cap) {
      truncated = true;
      break;
    }
  }
  out.sort();
  if (!out.length) return `没有匹配 ${pattern} 的文件（搜索根：${displayPath(root, ctx.workspace)}）`;
  return out.join('\n') + (truncated ? `\n…（已截断到 ${cap} 条，可用更精确的 pattern 或 limit 继续）` : '');
}

async function grepTool({ pattern, path: base, include, literal, case_sensitive, limit }, ctx) {
  const root = base ? resolveToolPath(base, ctx.workspace) : ctx.workspace;
  const cap = Math.min(Math.max(limit || DEFAULT_GREP_MATCHES, 1), MAX_GREP_MATCHES);
  // 智能大小写（ripgrep 惯例）：显式传 case_sensitive 就听它；否则模式全小写时忽略大小写
  const sensitive = typeof case_sensitive === 'boolean' ? case_sensitive : /[A-Z]/.test(pattern);
  const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
  let re;
  try {
    re = new RegExp(source, sensitive ? '' : 'i');
  } catch (e) {
    throw new Error(`正则无效：${e.message}`);
  }
  const includeRe = include ? globToRegExp(include) : null;
  const out = [];
  let skipped = 0;
  let truncated = false;
  for await (const file of walkFiles(root, ctx)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (includeRe && !includeRe.test(rel)) continue;
    let buf;
    try {
      buf = await fs.readFile(file);
    } catch {
      continue;
    }
    if (looksBinary(buf) || buf.length > MAX_GREP_FILE_BYTES) {
      skipped++;
      continue;
    }
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      out.push(`${displayPath(file, ctx.workspace)}:${i + 1}: ${clip(lines[i].trim(), 200)}`);
      if (out.length >= cap) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }
  out.sort(); // 按路径分组，输出稳定（遍历顺序随文件系统而异）
  if (!out.length) {
    const note = skipped ? `\n…（另跳过 ${skipped} 个二进制或超过 2MiB 的文件）` : '';
    return `没有匹配 /${pattern}/ 的内容（搜索根：${displayPath(root, ctx.workspace)}）${note}`;
  }
  let footer = truncated ? `\n…（已截断到 ${cap} 条）` : '';
  if (skipped) footer += `\n…（另有 ${skipped} 个二进制或超过 2MiB 的文件未搜索）`;
  return out.join('\n') + footer;
}

/** 杀子进程。Windows 用 taskkill /T 连子孙一起杀（命令常派生 node/python 等） */
function killTree(child) {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      return;
    } catch {
      /* 落回 kill */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
}

function formatBashResult(outChunks, errChunks, note) {
  const stdout = Buffer.concat(outChunks).toString('utf8').trim();
  const stderr = Buffer.concat(errChunks).toString('utf8').trim();
  let text = note ? `⚠️ ${note}\n` : '';
  if (stdout) text += stdout + '\n';
  if (stderr) text += `[stderr]\n${stderr}\n`;
  if (!stdout && !stderr) text += '（无输出）';
  return capText(text.trim(), MAX_BASH_OUTPUT);
}

function bashTool({ command, timeout }, ctx) {
  return new Promise((resolve) => {
    const ms = Math.min(Math.max(timeout || BASH_DEFAULT_TIMEOUT_MS, 100), BASH_MAX_TIMEOUT_MS);
    // 执行后端（T6）：local（缺省，与旧行为逐字一致）/ container（docker|podman）/ unavailable（fail-closed）
    if (ctx.bashBackend?.kind === 'unavailable') {
      resolve(`Bash 当前不可用：${ctx.bashBackend.reason}`);
      return;
    }
    const plan = makeBashSpawn(ctx.bashBackend, command, ctx.workspace);
    let child;
    try {
      child = spawn(plan.bin, plan.args, { shell: plan.shell, cwd: ctx.workspace, env: process.env, windowsHide: true });
    } catch (e) {
      resolve(`无法启动命令：${e.message}`);
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    let timer = null;
    let killFallbackTimer = null;
    let pendingNote = null; // 已决定终止原因（abort/超时），close 到达时据此回报而非退出码
    const finish = (note) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killFallbackTimer);
      ctx.signal?.removeEventListener('abort', onAbort);
      resolve(formatBashResult(out, err, note));
    };
    /**
     * 杀进程后**等 close 再回报**：kill 只保证信号/指令发出，进程真正退出可能还要几百毫秒，
     * 提前 resolve 会让「已停止」的回报名不副实（测试里还会表现为目录被未死透的子进程占着）。
     * close 一直不来（罕见的孙进程持管道）时用兜底计时器放行，不让 Promise 悬空。
     */
    const killAndWait = (note) => {
      if (settled) return;
      pendingNote = note;
      killTree(child);
      killFallbackTimer = setTimeout(() => finish(pendingNote), 2000);
    };
    const onAbort = () => killAndWait('命令已被用户停止');
    if (ctx.signal?.aborted) {
      killTree(child);
      resolve('命令未执行：运行已被停止');
      return;
    }
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => finish(`命令启动失败：${e.message}`));
    child.on('close', (code) => finish(pendingNote ?? (code === 0 ? null : `退出码 ${code}`)));
    timer = setTimeout(() => killAndWait(`命令超时（${Math.round(ms / 1000)}s），已强制结束`), ms);
  });
}

// ---------- 工具定义与装配 ----------

/** TodoWrite 清单归一（纯函数）：只留 {content,status,activeForm?}，status 白名单，最多 50 项 */
export function normalizeTodos(list) {
  const STATUS = new Set(['pending', 'in_progress', 'completed']);
  return (Array.isArray(list) ? list : [])
    .map((t) => {
      const content = typeof t?.content === 'string' ? t.content.trim() : '';
      if (!content) return null;
      const status = STATUS.has(t?.status) ? t.status : 'pending';
      const activeForm = typeof t?.activeForm === 'string' && t.activeForm.trim() ? t.activeForm.trim() : '';
      return { content, status, ...(activeForm ? { activeForm } : {}) };
    })
    .filter(Boolean)
    .slice(0, 50);
}

/** TodoWrite：清单快照由调用方（run 的 onActivity 钩子）落 run；执行器只做校验与确认文案 */
async function todoWriteTool(input) {
  const list = normalizeTodos(input?.todos);
  const done = list.filter((t) => t.status === 'completed').length;
  const doing = list.filter((t) => t.status === 'in_progress').length;
  return `清单已更新：${list.length} 项（完成 ${done}，进行中 ${doing}）`;
}

const TOOL_DEFS = Object.freeze({
  Read: {
    description: '读取文件内容（带行号）或列出目录。用 offset/limit 分段读大文件。相对路径基于工作目录解析。',
    inputSchema: z.object({
      file_path: z.string().describe('文件或目录路径（相对工作目录或绝对路径）'),
      offset: z.number().int().positive().optional().describe('起始行号（1 起），仅文件有效'),
      limit: z.number().int().positive().optional().describe(`最多读取行数（默认 ${MAX_READ_LINES}）`),
    }),
  },
  Write: {
    description: '创建或整体覆盖一个文本文件（自动创建父目录）。只改文件中一段内容请用 Edit。',
    inputSchema: z.object({
      file_path: z.string().describe('文件路径（相对工作目录或绝对路径）'),
      content: z.string().describe('完整文件内容'),
    }),
  },
  Edit: {
    description: '在文件中做精确字符串替换。old_string 必须在文件中唯一匹配；replace_all=true 时全部替换。',
    inputSchema: z.object({
      file_path: z.string().describe('文件路径（相对工作目录或绝对路径）'),
      old_string: z.string().describe('被替换的原文（空白与换行必须精确匹配）'),
      new_string: z.string().describe('替换后的内容'),
      replace_all: z.boolean().optional().describe('为 true 时替换所有匹配（默认要求唯一匹配）'),
    }),
  },
  Glob: {
    description: '按 glob 模式查找文件路径，支持 **、*、?、{a,b}。例：src/**/*.js。默认排除 .git 与 node_modules。',
    inputSchema: z.object({
      pattern: z.string().describe('glob 模式（相对于搜索根）'),
      path: z.string().optional().describe('搜索根目录（默认工作目录）'),
      limit: z.number().int().positive().optional().describe(`最多返回条数（默认 ${DEFAULT_GLOB_RESULTS}）`),
    }),
  },
  Grep: {
    description:
      '按正则搜索文件内容，返回 文件:行号:内容。include 可限定文件名模式（如 *.js），literal=true 关闭正则，' +
      '默认智能大小写（模式含大写时区分）。默认排除 .git 与 node_modules。',
    inputSchema: z.object({
      pattern: z.string().describe('搜索模式（正则；literal=true 时为纯文本）'),
      path: z.string().optional().describe('搜索根目录（默认工作目录）'),
      include: z.string().optional().describe('文件名 glob 过滤，如 *.js'),
      literal: z.boolean().optional().describe('为 true 时按纯文本搜索'),
      case_sensitive: z.boolean().optional().describe('显式指定是否区分大小写'),
      limit: z.number().int().positive().optional().describe(`最多返回匹配行数（默认 ${DEFAULT_GREP_MATCHES}）`),
    }),
  },
  Bash: {
    description: '在工作目录执行 shell 命令（Windows 为 cmd.exe）。用于运行测试、构建、git 等。timeout 单位毫秒，默认 120000。',
    inputSchema: z.object({
      command: z.string().describe('要执行的完整命令'),
      timeout: z.number().int().positive().optional().describe('超时毫秒数（默认 120000，上限 600000）'),
    }),
  },
  TodoWrite: {
    description:
      '更新本任务的任务清单（覆盖式）：每次传入完整 todos 数组。status: pending | in_progress | completed；' +
      '同一时间最多一项 in_progress。清单会显示在界面右侧任务面板。',
    inputSchema: z.object({
      todos: z
        .array(
          z.object({
            content: z.string().describe('任务描述（祈使句，如「修复登录按钮」）'),
            status: z.enum(['pending', 'in_progress', 'completed']).describe('状态'),
            activeForm: z.string().optional().describe('进行中时的描述（可选）'),
          }),
        )
        .describe('完整清单（覆盖旧值）'),
    }),
  },
});

const EXECUTORS = Object.freeze({
  Read: readTool,
  Write: writeTool,
  Edit: editTool,
  Glob: globTool,
  Grep: grepTool,
  Bash: bashTool,
  TodoWrite: todoWriteTool,
});

/** RepoMap 的工具定义：仅在调用方注入 loadRepoMap 时装配（providers 不 import features，走注入） */
const REPO_MAP_DEF = Object.freeze({
  description:
    '查询仓库代码地图（文件名 + 关键导出/类方法符号，按引用重要度排序）。不传 query 按整体重要度；' +
    '传 query（任务关键词）加权相关文件；refresh=true 强制重建（冷启动或大改后地图过旧时用，较慢）。',
  inputSchema: z.object({
    query: z.string().optional().describe('任务关键词（空格分隔），用于加权相关文件'),
    refresh: z.boolean().optional().describe('true 时强制重建地图（默认复用增量缓存）'),
  }),
});

async function repoMapTool({ query, refresh }, ctx) {
  try {
    const map = await ctx.loadRepoMap({ query: typeof query === 'string' ? query : '', refresh: !!refresh });
    if (!map) return '（没有可用的仓库地图：该目录不是 git 仓库，或没有可索引的源文件）';
    return `以下是当前仓库地图${refresh ? '（已强制重建）' : ''}：\n\n${map}`;
  } catch (e) {
    return `仓库地图加载失败：${e?.message || String(e)}`;
  }
}

/**
 * 造一套绑定到具体工作目录的内置工具。
 * @param {{ cwd?: string, signal?: AbortSignal, loadRepoMap?: Function, bashBackend?: object }} [opts]
 *   signal 传 run 的 abortController.signal：用户点「停止」能中断 Bash 子进程与遍历
 *   loadRepoMap({query, refresh}) => Promise<string>：由调用方注入（entrypoint 接 features/repo-map），
 *   注入时才装配 RepoMap 工具——保证 providers 层不向上依赖 features。
 *   bashBackend：Bash 执行后端（T6；exec-backends.js#resolveBashBackend 的产物）；
 *   缺省 local = 与旧行为逐字一致。
 * @returns {{ toolDefs: object, executeTool: (name:string, input:any)=>Promise<string>, workspace: string }}
 */
export function createBuiltinTools({ cwd, signal, loadRepoMap, bashBackend = { kind: 'local' } } = {}) {
  const workspace = resolveWorkspace(cwd);
  const ctx = { workspace, signal, loadRepoMap, bashBackend };
  const withRepoMap = typeof loadRepoMap === 'function';
  const toolDefs = withRepoMap ? { ...TOOL_DEFS, RepoMap: REPO_MAP_DEF } : TOOL_DEFS;
  const executors = withRepoMap ? { ...EXECUTORS, RepoMap: repoMapTool } : EXECUTORS;
  async function executeTool(name, input) {
    const fn = executors[name];
    if (!fn) throw new Error(`未知的内置工具：${name}`);
    return fn(input || {}, ctx);
  }
  return { toolDefs, executeTool, workspace };
}

/** 配套系统提示词：告诉模型「你有工具、工作目录在哪、先看再改」；有仓库地图时附在末尾。每轮注入、不落盘 */
export function buildAgentSystemPrompt({ cwd, platform, repoMap } = {}) {
  const workspace = resolveWorkspace(cwd);
  const osName = { win32: 'Windows', darwin: 'macOS' }[platform || process.platform] || 'Linux';
  const lines = [
    `你是运行在「Principal」中的编码代理，工作目录：${workspace}（操作系统：${osName}）。`,
    '',
    '你可以直接调用工具完成工作，不要只描述你打算做什么：',
    '- Read：读文件或目录；Write：创建或覆盖文件；Edit：精确替换文件中的一段内容；',
    '- Glob：按文件名模式找文件；Grep：按内容搜索；Bash：执行命令（测试、构建、git 等）。',
    '相对路径都基于工作目录解析。先看再改：修改前先用 Read 确认现状，不要猜文件内容。',
    '改动类（Write/Edit/Bash）与目录外读取会先请求用户批准；被拒绝时改用其他方案或询问用户。',
  ];
  if (repoMap) {
    lines.push(
      '',
      '## 仓库地图（自动生成：文件 + 关键导出/类方法符号，按引用重要度排序）',
      '先用它定位线索，再用 Read/Grep 深入；地图可能略旧，以实际文件为准。',
      '地图不够用时可用 RepoMap 工具按任务关键词再查（refresh=true 会强制重建）。',
      '',
      String(repoMap),
    );
  }
  return lines.join('\n');
}

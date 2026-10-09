/**
 * 工具策略引擎（纯函数层）—— 两条 provider 路径与无人值守路径共用的**唯一规则表**。
 *
 * 背景（T6 spec）：审批逻辑此前散在 run-claude 与 run-openai 两处（只读清单各一份、
 * 越界判定各一份），无人值守路径则写死 bypassPermissions 全放行。本模块把
 * 「什么操作×什么档位→放行/审批/拒绝」收敛成可单测的纯矩阵 + 两张命令名单：
 *
 *   - 危险命令 deny 名单（`detectDangerousCommand`）：独立于档位，宁漏勿误杀；
 *   - 安全命令表（`isSafeCommand`）：无人值守 standard 档放行的「开发例行命令」，只认单段命令。
 *
 * 层级：零 IO、零 store 依赖（路径工具在 shared/workspace-paths），运行时门（计次/熔断/
 * 无人值守翻译）在 capabilities/tool-policy.js。
 */
import { resolveWorkspace, isInsideWorkspace, resolveToolPath } from '../shared/workspace-paths.js';

/** 全部档位（含无人值守两档）。交互路径用前四个（= SDK permissionMode 白名单）。 */
export const POLICY_LEVELS = Object.freeze([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'unattended-standard',
  'unattended-trusted',
]);

/** 无人值守策略拦截的熔断阈值：与 MAX_RESUME_ATTEMPTS 同值（3），量级一致便于排查 */
export const MAX_POLICY_BLOCKS = 3;

/**
 * 档位矩阵：每档对各类动作的裁决。
 *   readInside/readOutside/writeInside/writeOutside：文件类
 *   execute：一般命令；executeSafe：安全命令表命中时（`isSafeCommand`）
 *   network：网络类工具（WebFetch/WebSearch）
 *   other：未知/第三方工具（MCP 未白名单等）
 * 注：`bypassPermissions` 下 Claude SDK 不调用 canUseTool（deny 名单拦不到），openai 路径可拦——
 * 该不对称性记在 T6 spec §4.1。
 */
const LEVEL_CAPS = Object.freeze({
  default: Object.freeze({
    readInside: 'allow', readOutside: 'ask',
    writeInside: 'ask', writeOutside: 'ask',
    execute: 'ask', executeSafe: 'ask', network: 'ask', other: 'ask',
  }),
  acceptEdits: Object.freeze({
    readInside: 'allow', readOutside: 'ask',
    writeInside: 'allow', writeOutside: 'ask',
    execute: 'ask', executeSafe: 'ask', network: 'ask', other: 'ask',
  }),
  plan: Object.freeze({
    readInside: 'allow', readOutside: 'ask',
    writeInside: 'deny', writeOutside: 'deny',
    execute: 'deny', executeSafe: 'deny', network: 'deny', other: 'deny',
  }),
  bypassPermissions: Object.freeze({
    readInside: 'allow', readOutside: 'allow',
    writeInside: 'allow', writeOutside: 'allow',
    execute: 'allow', executeSafe: 'allow', network: 'allow', other: 'allow',
  }),
  'unattended-standard': Object.freeze({
    readInside: 'allow', readOutside: 'ask',
    writeInside: 'allow', writeOutside: 'ask',
    execute: 'ask', executeSafe: 'allow', network: 'ask', other: 'ask',
  }),
  'unattended-trusted': Object.freeze({
    readInside: 'allow', readOutside: 'allow',
    writeInside: 'allow', writeOutside: 'allow',
    execute: 'allow', executeSafe: 'allow', network: 'allow', other: 'allow',
  }),
});

/** 工具类别 → 矩阵键（按路径内外细分由 decideToolAction 完成） */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'TodoWrite', 'RepoMap']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const EXEC_TOOLS = new Set(['Bash']);
const NET_TOOLS = new Set(['WebFetch', 'WebSearch']);
/** 子代理：放行（其内部改动类工具会逐个走审批）；Workflow 类编排工具刻意不入表（默认 ask）——
 *  一轮能拉起十几个子代理，风险在烧额度不在改文件（沿用 tool-summary 时代的先例，见 T6 spec） */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/**
 * 工具名 → 类别：read | write | execute | network | agent | other。
 * `other` 涵盖未知工具与未白名单的 MCP 工具（裁决等同「需要用户确认」）。
 */
export function classifyTool(toolName) {
  const name = String(toolName || '');
  if (READ_TOOLS.has(name)) return 'read';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (EXEC_TOOLS.has(name)) return 'execute';
  if (NET_TOOLS.has(name)) return 'network';
  if (AGENT_TOOLS.has(name)) return 'agent';
  return 'other';
}

/**
 * 从工具入参里取出会被访问的路径（区内/越界判定的输入）。
 * 覆盖 Claude 与 openai 两套内置工具的字段：file_path / notebook_path / path / edits[].file_path。
 */
export function extractTargetPaths(toolName, input = {}) {
  const name = String(toolName || '');
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v) out.push(v);
  };
  if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit') {
    push(input.file_path);
    for (const e of Array.isArray(input.edits) ? input.edits : []) push(e?.file_path);
  } else if (name === 'NotebookEdit') {
    push(input.notebook_path);
  } else if (name === 'Glob' || name === 'Grep') {
    push(input.path);
  }
  return out;
}

// ---------- 危险命令 deny 名单 ----------
// 原则：只拦**明确灾难性**的命令（删根/毁盘/关停/炸弹/全盘改权限）；宁漏勿误杀——
// 误杀开发例行命令会逼用户切 bypass，反而丢掉整张表。每条给可读 reason 进拒绝消息与日志。

const DANGEROUS_RULES = Object.freeze([
  {
    id: 'rm_root',
    reason: '递归删除根目录/家目录',
    re: /(?:^|[;&|]\s*|\bsudo\s+)rm\s+(?:-[a-z-]+\s+)*(?:\/(?:\s|\*|$)|\/?~\/?(?:\s|$)|\$HOME\/?(?:\s|$)|[a-zA-Z]:[\\/](?:\s|\*|$))/i,
  },
  {
    id: 'windows_wipe',
    reason: '清空磁盘根目录',
    re: /(?:^|[;&|]\s*)(?:rd|rmdir)\s+\/s\s+\/q\s+[a-zA-Z]:[\\/](?:\s|$)|(?:^|[;&|]\s*)del\s+\/f\s+\/s\s+\/q\s+[a-zA-Z]:[\\/]\*?/i,
  },
  {
    id: 'disk',
    reason: '磁盘/分区破坏性操作',
    re: /(?:^|[;&|]\s*)(?:mkfs(?:\.\w+)?\b|diskpart\b|dd\s+[^\r\n]*of=\/dev\/(?:sd|nvme|hd|vd|disk)|format\s+[a-zA-Z]:)/i,
  },
  {
    id: 'power',
    reason: '关机/重启/停机',
    re: /(?:^|[;&|]\s*)(?:shutdown\b|reboot\b|halt\b|poweroff\b)/i,
  },
  {
    // 2026-10-08 事故：agent 为清理自己的探针服务器跑了 `taskkill /f /im node.exe`，
    // 按镜像名杀光本机 node——把承载它自己的后端 sidecar 一起杀了（静默崩溃、无 WER）。
    // 进程击杀类命令一律拒绝（全档位含自动/无人值守），避免误杀其它程序与本服务自身。
    id: 'kill_process',
    reason: '批量结束本机进程（taskkill / pkill / killall / Stop-Process）可能杀死其它程序（含本服务自身）；如需清理自己启动的进程，请在脚本内自行退出或记录 PID 精准处理',
    re: /(?:^|[;&|]\s*)(?:taskkill\b|pkill\b|killall\b|stop-process\b)/i,
  },
  {
    id: 'kill_signal',
    reason: '向进程发信号（kill -N）可能误杀其它程序',
    re: /(?:^|[;&|]\s*)kill\s+-[0-9a-z]/i,
  },
  {
    id: 'fork_bomb',
    reason: 'fork 炸弹',
    re: /:\s*\(\s*\)\s*\{[^\r\n]*\|[^\r\n]*:&?\s*\}/,
  },
  {
    id: 'recursive_perm',
    reason: '全盘递归改权限',
    re: /(?:^|[;&|]\s*|\bsudo\s+)(?:chmod|chown)\s+(?:-[a-z]+\s+)*[^\s]+\s+\/(?:\s|$)/i,
  },
]);

/**
 * 危险命令检测。
 * @param {string} command
 * @returns {{id:string, reason:string}|null} 命中返回规则，否则 null
 */
export function detectDangerousCommand(command) {
  const cmd = String(command ?? '');
  if (!cmd.trim()) return null;
  for (const r of DANGEROUS_RULES) if (r.re.test(cmd)) return { id: r.id, reason: r.reason };
  return null;
}

// ---------- 安全命令表（无人值守 standard 档的放行面） ----------

/** 只读系统命令（单段；含重定向/管道/子命令时不适用，见 isSafeCommand 前置检查） */
const SAFE_HEADS = new Set(['ls', 'dir', 'pwd', 'where', 'whoami', 'echo', 'cat', 'type', 'head', 'tail', 'wc']);
/** git 只读子命令（刻意不含 branch/stash：带删除/写盘参数的分支无法只靠子命令名安全放行） */
const GIT_SAFE_SUBS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog']);
/** npm run 的例行脚本名（构建/测试/检查类；publish/install 等有外发/写盘副作用，不在内） */
const SAFE_NPM_SCRIPTS = new Set(['test', 'build', 'lint', 'typecheck', 'check', 'verify']);

/**
 * 安全命令判定（保守）：**只认单段命令**——出现 管道/链式/重定向/子命令/变量/换行 一律不放行。
 * 命令语义无法完整解析（引号嵌套、alias 等），所以这里只给「明确认识的形状」背书：
 * 开发例行命令（跑测试/构建/git 只读），拿不准的交给档位矩阵（ask/deny）由人决定。
 */
export function isSafeCommand(command) {
  const cmd = String(command ?? '').trim();
  if (!cmd) return false;
  if (/[|&;<>`$()\r\n]/.test(cmd)) return false;
  const toks = cmd.split(/\s+/);
  const head = toks[0];
  const second = toks[1] || '';
  if (SAFE_HEADS.has(head)) return true;
  if (head === 'git') return GIT_SAFE_SUBS.has(second);
  if (head === 'npm') {
    if (second === 'test') return true;
    return second === 'run' && SAFE_NPM_SCRIPTS.has(toks[2] || '');
  }
  if (head === 'node') return second === '--test' || second === '--check';
  if (head === 'npx') return second === '--no-install';
  return false;
}

// ---------- 主裁决 ----------

/**
 * 单次工具调用的策略裁决（纯函数）。
 *
 * @param {object} p
 * @param {string} p.toolName
 * @param {object} [p.input]
 * @param {string} [p.level] 档位（未知值按 default 兜底，fail-closed）
 * @param {string} [p.workspace] 工作目录（区内/越界判定）
 * @param {Set<string>} [p.disabledTools] 用户显式关闭的工具（逻辑名）
 * @param {Set<string>} [p.autoAllow] MCP 只读白名单（命中即放行）
 * @param {Set<string>} [p.readOnlyExtra] 额外只读白名单（如 Feishu 等待工具）
 * @returns {{action:'allow'|'ask'|'deny', klass:string, ruleId:string, reason:string}}
 */
export function decideToolAction({
  toolName,
  input,
  level = 'default',
  workspace,
  disabledTools = null,
  autoAllow = null,
  readOnlyExtra = null,
} = {}) {
  const name = String(toolName || '');
  const caps = LEVEL_CAPS[level] || LEVEL_CAPS.default;
  const lvl = LEVEL_CAPS[level] ? level : 'default';

  if (disabledTools && typeof disabledTools.has === 'function' && disabledTools.has(name)) {
    return { action: 'deny', klass: 'disabled', ruleId: 'disabled_tool', reason: `工具「${name}」已被用户关闭，可在右下角模型选择器中重新开启` };
  }
  if (autoAllow && typeof autoAllow.has === 'function' && autoAllow.has(name)) {
    return { action: 'allow', klass: 'read', ruleId: 'mcp_auto_allow', reason: `「${name}」在 MCP 只读白名单中` };
  }
  if (readOnlyExtra && typeof readOnlyExtra.has === 'function' && readOnlyExtra.has(name)) {
    return { action: 'allow', klass: 'read', ruleId: 'readonly_extra', reason: `「${name}」属于只读工具` };
  }

  const klass = classifyTool(name);
  if (klass === 'agent') {
    return { action: caps.other === 'deny' ? 'deny' : 'allow', klass, ruleId: `level:${lvl}:agent`, reason: '子代理放行（其内部工具逐个走审批）' };
  }
  if (klass === 'other') {
    return { action: caps.other, klass, ruleId: `level:${lvl}:other`, reason: `「${name}」需人工确认（${lvl} 档）` };
  }
  if (klass === 'network') {
    return { action: caps.network, klass, ruleId: `level:${lvl}:network`, reason: `网络访问需人工审批（${lvl} 档）` };
  }
  if (klass === 'execute') {
    const dangerous = detectDangerousCommand(input?.command);
    if (dangerous) {
      return { action: 'deny', klass, ruleId: `dangerous:${dangerous.id}`, reason: `命令被安全策略拒绝：${dangerous.reason}` };
    }
    const safe = isSafeCommand(input?.command);
    const action = safe ? caps.executeSafe : caps.execute;
    return { action, klass, ruleId: `level:${lvl}:${safe ? 'execute_safe' : 'execute'}`, reason: safe ? `安全命令（${lvl} 档放行）` : `命令执行需人工审批（${lvl} 档）` };
  }
  // read / write：按目标路径是否越出工作目录细分
  const ws = resolveWorkspace(workspace);
  const paths = extractTargetPaths(name, input || {});
  const outside = paths.length
    ? paths.some((p) => !isInsideWorkspace(ws, resolveToolPath(p, ws)))
    : klass === 'write'; // 写操作拿不到路径时 fail-closed：当作越界处理
  const key = klass === 'read' ? (outside ? 'readOutside' : 'readInside') : outside ? 'writeOutside' : 'writeInside';
  return {
    action: caps[key],
    klass,
    ruleId: `level:${lvl}:${key}`,
    reason: outside ? `${klass === 'read' ? '读取' : '写入'}工作目录外路径需人工审批（${lvl} 档）` : `${klass === 'read' ? '读取' : '写入'}在工作目录内（${lvl} 档）`,
  };
}

// ---------- 无人值守映射 ----------

/** execPolicy（bot 级配置）→ 无人值守档位与 SDK mode */
const UNATTENDED_MAP = Object.freeze({
  bypass: { policyLevel: 'bypassPermissions', sdkMode: 'bypassPermissions' },
  standard: { policyLevel: 'unattended-standard', sdkMode: 'default' },
  trusted: { policyLevel: 'unattended-trusted', sdkMode: 'default' },
});

export const EXEC_POLICIES = Object.freeze(Object.keys(UNATTENDED_MAP));

/**
 * 解析无人值守执行策略（默认 bypass = 与改动前完全一致）。
 * @param {'bypass'|'standard'|'trusted'|undefined} execPolicy
 * @returns {{execPolicy:string, unattended:true, policyLevel:string, sdkMode:string}}
 */
export function resolveUnattendedPolicy(execPolicy) {
  const key = Object.hasOwn(UNATTENDED_MAP, execPolicy) ? execPolicy : 'bypass';
  return { execPolicy: key, unattended: true, ...UNATTENDED_MAP[key] };
}

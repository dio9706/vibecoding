/**
 * 多轮**受限写**LLM 调用骨架 —— 与 `llm-readonly-agent.js` 同构的第三种调用形态。
 *
 * 三者分工：
 *   `llm-classify`        单轮 + 零工具       —— 判定已经给定的文本
 *   `llm-readonly-agent`  多轮 + 只读工具     —— 必须实地读代码才能作答
 *   本模块                多轮 + **白名单路径内**可写 —— 必须实地改代码才能完成
 *
 * ## 「受限写」的闸和只读的闸是同一套机制，只是白名单不同
 *
 * `llm-readonly-agent.js` 的文件头记录了三条用学费换来的教训，它们对本模块**同样成立**，
 * 而且后果更严重（那边越权只是读到了不该读的，这边越权是改了不该改的文件）：
 *
 *   1. `allowedTools` 不是白名单，官方原文「This does not restrict Claude to only these tools」；
 *   2. 列名黑名单补不全——实测模型调 ToolSearch 把被禁的工具重新捞了出来；
 *   3. 光传 `canUseTool` 会被架空——用户 settings.json 把 Write/Edit 整体 allow 时，
 *      allow 规则优先于 canUseTool，回调根本不会被调用。
 *
 * 所以本模块的防线与只读版完全一致，只在第 2 层把「工具名白名单」换成
 * 「工具名 + **目标路径**双重白名单」：
 *
 *   第 1 层 hooks.PreToolUse → 'ask'：夺回裁决权，让 canUseTool 一定被调用
 *   第 2 层 canUseTool：读类工具放行；写类工具**逐次校验 file_path 是否落在允许清单内**
 *   第 3 层 disallowedTools：挡不住 ToolSearch，但能少让模型做无用尝试
 *
 * `permissionMode` 必须是 `'default'`；`'bypassPermissions'` 会把第 1、2 层一起绕过。
 *
 * ## 为什么必须限定到「单个文件」而不是「项目目录内」
 *
 * 调用方（fix-engine 的 llm-refactor 策略）的安全模型是「改一个文件 → 跑测试 → 红了就回滚这个文件」。
 * 这个模型只在**改动范围等于回滚范围**时成立。如果放开成「项目目录内可写」，
 * 模型顺手改了第二个文件，测试红了我们只回滚第一个，就会留下一个既没备份记录、
 * 也没被回滚的改动——比不做修复糟糕得多。
 */
import path from 'node:path';
import { runClaude } from '../integrations/claude.js';
import { claudeAuthOpts, getTokens, isPoolExhausted } from './token-rotation.js';
import { pickJsonObject } from './llm-classify.js';
import { logger } from '../shared/logger.js';

/** 无条件放行的读类工具。与 llm-readonly-agent 的 READONLY_TOOLS 一致，理由见那边的注释 */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'ToolSearch']);

/** 需要逐次校验目标路径的写类工具 */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** 第 3 层静态黑名单。补不全（见文件头教训 2），只当减少尝试用 */
const DENIED_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'Task', 'WebFetch', 'WebSearch', 'SlashCommand'];

/** 第 1 层：把裁决权从 settings.json 的 allow 规则手里夺回来 */
const FORCE_ASK_HOOKS = {
  PreToolUse: [{
    hooks: [async () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    })],
  }],
};

/**
 * 单次调用超时。
 *
 * 比只读版（600s）短：改单个文件的任务范围是收敛的（读这个文件 → 改它），
 * 不像生成项目地图那样需要遍历全仓。300s 已是实测长尾（127s）的 2.4 倍余量。
 * 更长的预算只会让一次卡住的调用把整批修复拖住——而修复是逐文件循环的。
 */
export const WRITE_AGENT_TIMEOUT_MS = 300_000;

/** 探索深度上限：够走完「读文件 → 改几处 → 自查」 */
const DEFAULT_MAX_TURNS = 40;

/**
 * 路径是否落在允许清单内。
 *
 * 必须先 `path.resolve` 再比：模型给的 `file_path` 可能是相对路径、可能含 `..`、
 * 可能混用分隔符。拿原始字符串做前缀匹配，`src/../../etc/passwd` 这种就能绕过去。
 *
 * Windows 上大小写不敏感，所以比较前统一小写——否则模型把盘符写成小写 `c:\...`
 * 就会被误判为越权，修复静默失败而日志里只有一句「拦截」。
 */
export function isPathAllowed(cwd, filePath, allowSet) {
  if (!filePath) return false;
  const abs = path.resolve(cwd, String(filePath));
  const norm = process.platform === 'win32' ? abs.toLowerCase() : abs;
  return allowSet.has(norm);
}

/** 把允许清单（相对路径）归一成可直接比对的绝对路径集合 */
function buildAllowSet(cwd, allowPaths) {
  const set = new Set();
  for (const p of allowPaths || []) {
    const abs = path.resolve(cwd, p);
    set.add(process.platform === 'win32' ? abs.toLowerCase() : abs);
  }
  return set;
}

/**
 * 跑一次受限写调用。
 *
 * 从不抛错：调用方处在修复循环中途，抛异常会把整批停在半路
 * （与 `fix-map.js` 开头的纪律 2 同一条理由）。一切失败通过返回值表达。
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {object} [opts.systemPrompt] runClaude 透传格式
 * @param {string} opts.cwd 项目目录
 * @param {string[]} opts.allowPaths **允许写入的文件**（相对 cwd）。空数组 = 纯只读
 * @param {string} opts.logTag
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxTurns]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{data:object|null, wrote:string[], denied:string[],
 *   reason:'exhausted'|'cancelled'|'timeout'|'unparsable'|null}>}
 *   `wrote` 是**实际被放行的写入目标**（去重）——它才是「改了哪些文件」的权威记录，
 *   而不是模型自己在 JSON 里声称改了什么。回滚要按它来。
 */
export async function runScopedEditAgent({
  prompt, systemPrompt, cwd, allowPaths = [], logTag,
  timeoutMs, maxTurns = DEFAULT_MAX_TURNS, signal, requireKeys = ['changed'],
} = {}) {
  // 额度耗尽 fail-fast：同 llm-classify.js 的理由——五小时限流窗口内 SDK 流可能永不结束，
  // 不发起注定失败的调用
  if (isPoolExhausted(getTokens())) {
    logger.warn('llm-write-agent', 'token 池全部耗尽，跳过调用（fail-fast）', { logTag });
    return { data: null, wrote: [], denied: [], reason: 'exhausted' };
  }
  if (signal?.aborted) return { data: null, wrote: [], denied: [], reason: 'cancelled' };

  const allowSet = buildAllowSet(cwd, allowPaths);
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : WRITE_AGENT_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), budget);
  const relayAbort = () => abort.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });

  let out = '';
  const denied = [];
  const wrote = new Set();

  try {
    const call = runClaude(prompt, {
      ...claudeAuthOpts(), // 跟随备用账号轮换，别烧主账号额度
      ...(systemPrompt ? { systemPrompt } : {}),
      cwd,
      persistSession: false, // 内部一次性调用，不污染磁盘历史列表
      permissionMode: 'default', // 不能用 bypassPermissions：会绕过下面两层
      maxTurns,
      disallowedTools: DENIED_TOOLS,
      hooks: FORCE_ASK_HOOKS,
      canUseTool: async (toolName, input) => {
        if (READ_TOOLS.has(toolName)) return { behavior: 'allow' };

        if (WRITE_TOOLS.has(toolName)) {
          const target = input?.file_path || input?.notebook_path;
          if (isPathAllowed(cwd, target, allowSet)) {
            wrote.add(path.resolve(cwd, String(target)));
            return { behavior: 'allow' };
          }
          denied.push(`${toolName}:${target || '(未给路径)'}`);
          logger.warn('llm-write-agent', '拦截了范围外的写入', { logTag, tool: toolName, target });
          return {
            behavior: 'deny',
            message: `只允许修改这些文件：${allowPaths.join('、')}。`
              + '请不要创建或修改其它文件；如果任务无法在这个范围内完成，就直接说明原因。',
          };
        }

        denied.push(toolName);
        logger.warn('llm-write-agent', '拦截了白名单外的工具', { logTag, tool: toolName });
        return {
          behavior: 'deny',
          message: '本次调用只允许 Read/Grep/Glob 与对指定文件的 Write/Edit。禁止执行命令或访问网络。',
        };
      },
      abortController: abort,
      onText: (t) => (out += t),
      onResult: (info) => { if (!out && info.result) out = info.result; },
    });
    // race 放弃后该 promise 仍可能 reject，预挂 catch 防 unhandled（同 llm-classify.js）
    call.catch((e) => logger.warn('llm-write-agent', '调用异常（已落兜底）', { logTag, err: e?.message || String(e) }));
    await Promise.race([call, new Promise((resolve) => setTimeout(resolve, budget + 2_000))]);
  } catch {
    /* 超时 abort 或调用异常 → 落兜底 */
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }

  const relWrote = [...wrote].map((abs) => path.relative(cwd, abs).replace(/\\/g, '/'));

  // 先尝试解析、再看是否超时：顺序同 llm-classify.js 的 classifyOutcome。
  // abort 只说明「流没按时结束」，模型常常早把答案吐完了而 SDK 流迟迟不收尾——
  // 对本模块尤其要紧：**文件可能已经改好了**，此时报失败会让调用方白白回滚一次成功的修复
  // requireKeys 默认要求 `changed`：写 agent 也是多轮工具调用，
  // 它在改文件前后都会叙述，中途引用的代码片段同样是配平的 JSON
  const data = pickJsonObject(out, requireKeys);
  if (data) return { data, wrote: relWrote, denied, reason: null };
  // cancelled 要先于 timeout 判：两者都表现为 abort，但对用户是完全不同的两件事
  if (signal?.aborted) return { data: null, wrote: relWrote, denied, reason: 'cancelled' };
  return { data: null, wrote: relWrote, denied, reason: abort.signal.aborted ? 'timeout' : 'unparsable' };
}

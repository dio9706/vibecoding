/**
 * 多轮**只读** LLM 调用骨架 —— 与 llm-classify.js 平级的另一种调用形态。
 *
 * 两者的分工：llm-classify 是「单轮 + 零工具」，处理已经给定的文本；
 * 本模块是「多轮 + 只读工具」，用于必须实地读代码才能作答的任务（生成项目地图）。
 *
 * ## 只读保证为什么需要三层
 *
 * 本仓库为这件事交过三次学费，三条教训方向各不相同，少任何一条防线都会漏：
 *
 * 1. **`allowedTools` 不是白名单**（describe-skill.js 开头）。官方原文
 *    「This does not restrict Claude to only these tools」——它只是免确认列表。
 *    `allowedTools: ['Read']` 的真实效果是「全部工具可用，其中 Read 免确认」。
 * 2. **列名黑名单补不全**（llm-classify.js 的 disallowedTools 注释）。2026-08-24 实测中
 *    模型调用 ToolSearch 把被禁的 Read 重新捞了出来。SDK 每加一个新工具，黑名单就多一个洞。
 * 3. **光传 canUseTool 会被架空**（run-claude.js 的「询问」模式注释）。用户全局 settings.json
 *    把 Bash/Edit/Write 整体 allow 时，**allow 规则优先于 canUseTool，回调根本不会被调用**。
 *
 * 前两条合起来说明：静态工具名单无论正列反列都给不了只读保证，唯一可靠的是运行时逐次裁决。
 * 第三条说明：运行时裁决还得先把裁决权夺回来。于是有了下面这三层，顺序不能少：
 *
 *   第 1 层 hooks.PreToolUse → 'ask'：夺回裁决权，让 canUseTool 一定会被调用
 *   第 2 层 canUseTool 白名单：无论工具怎么被捞回来，执行前都要过这一关
 *   第 3 层 disallowedTools：挡不住 ToolSearch，但能少让模型做无用尝试，省轮次和 token
 *
 * permissionMode 必须是 'default'。用 'bypassPermissions' 会把第 1、2 层一起绕过。
 */
import { runClaude } from '../integrations/claude.js';
import { claudeAuthOpts, getTokens, isPoolExhausted } from './token-rotation.js';
import { extractFirstJsonObject } from './llm-classify.js';
import { logger } from '../shared/logger.js';

/**
 * 运行时白名单。
 *
 * ToolSearch 放行是刻意的：它只返回工具的 schema 文本、不产生任何副作用，
 * 而模型被禁掉工具后的第一反应就是去搜。拦它只会白白吃掉轮次并让模型陷入重试循环；
 * 真正的闸是本白名单本身——它就算把 Write 捞回来，执行前照样在这里被拒。
 */
export const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'ToolSearch']);

/**
 * 默认超时。
 *
 * describe-skill.js 的 DESCRIBE_TIMEOUT_MS 注释记录了单轮无工具调用的实测长尾已达 127s
 * （预算 122s 时答案晚到 5 秒、整条落了兜底）。本模块是**多轮 + 每轮夹着工具调用**，
 * 长尾只会更长，所以起步给到 10 分钟。
 *
 * **2026-08-27 实测回填**：本仓库（约 200 个源文件）生成根地图单次
 * `runClaude ms=160005`，即 160.1s，成功产出 47 行地图。600s 对它有 3.7 倍余量。
 * 注意这只是**单发**数据——describe-skill 那边记录过连续调用赶上限流排队时长尾达
 * 单跑的 4 倍，按那个倍率 160s × 4 ≈ 640s 就会顶破预算。所以并发压到 3
 * （见 optimize-ops.js 的 MAP_CONCURRENCY），别再往上调。
 *
 * 多等的代价很小（一键优化是低频操作），超时的代价很大：地图生成不出来，
 * 而用户看到的是「优化完成」。宁可等。
 */
export const READONLY_AGENT_TIMEOUT_MS = 600_000;

/** 探索深度上限：够走完「列目录 → 读入口 → 抽查几个文件」，也兜住失控 */
const DEFAULT_MAX_TURNS = 30;

/** 第 3 层：静态黑名单。补不全（见文件头教训 2），只当减少尝试用 */
const DENIED_TOOLS = [
  'Write', 'Edit', 'NotebookEdit', 'Bash', 'BashOutput', 'KillShell',
  'Task', 'WebFetch', 'WebSearch', 'SlashCommand',
];

/** 第 1 层：把每次工具调用的裁决权从 settings.json 的 allow 规则手里夺回来 */
const FORCE_ASK_HOOKS = {
  PreToolUse: [{
    hooks: [async () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    })],
  }],
};

/**
 * 跑一次只读的多轮调用，返回模型输出里的首个 JSON 对象。
 *
 * 从不抛错：调用方（地图生成）处在优化流程中途，抛异常会把整批停在半路。
 * 一切失败都通过 `{data:null, reason}` 表达。
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {object} [opts.systemPrompt] runClaude 透传格式
 * @param {string} opts.cwd 项目目录 —— 模型的读取范围
 * @param {string|null} [opts.model] null = 跟随会话默认模型
 * @param {string} opts.logTag 日志标识
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxTurns]
 * @param {AbortSignal} [opts.signal] 外部取消（用户点「停止优化」）
 * @returns {Promise<{data:object|null, reason:'exhausted'|'cancelled'|'timeout'|'unparsable'|null,
 *   denied:string[]}>} denied 是被白名单拦下的工具名，用于排查模型是否在试图越权
 */
export async function runReadonlyAgent({
  prompt, systemPrompt, cwd, model = null, logTag,
  timeoutMs, maxTurns = DEFAULT_MAX_TURNS, signal,
} = {}) {
  // 额度耗尽 fail-fast：同 llm-classify.js 的理由——五小时限流窗口内
  // SDK 流可能永不结束，不发起注定失败的调用
  if (isPoolExhausted(getTokens())) {
    logger.warn('llm-readonly-agent', 'token 池全部耗尽，跳过调用（fail-fast）', { logTag });
    return { data: null, reason: 'exhausted', denied: [] };
  }
  if (signal?.aborted) return { data: null, reason: 'cancelled', denied: [] };

  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : READONLY_AGENT_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), budget);
  const relayAbort = () => abort.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });

  let out = '';
  const denied = [];

  try {
    const call = runClaude(prompt, {
      ...claudeAuthOpts(), // 跟随备用账号轮换，别烧主账号额度
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      persistSession: false, // 内部一次性调用，不污染磁盘历史列表
      permissionMode: 'default', // 不能用 bypassPermissions：会绕过下面两层
      maxTurns,
      disallowedTools: DENIED_TOOLS,
      hooks: FORCE_ASK_HOOKS,
      canUseTool: async (toolName) => {
        if (READONLY_TOOLS.has(toolName)) return { behavior: 'allow' };
        denied.push(toolName);
        logger.warn('llm-readonly-agent', '拦截了非只读工具调用', { logTag, tool: toolName });
        return {
          behavior: 'deny',
          message: '本次调用只允许读取（Read/Grep/Glob）。请不要尝试写入或执行，仅基于读到的内容作答。',
        };
      },
      abortController: abort,
      onText: (t) => (out += t),
      onResult: (info) => { if (!out && info.result) out = info.result; },
    });
    // race 放弃后该 promise 仍可能 reject，预挂 catch 防 unhandled（同 llm-classify.js）
    call.catch((e) => logger.warn('llm-readonly-agent', '调用异常（已落兜底）', { logTag, err: e?.message || String(e) }));
    await Promise.race([call, new Promise((resolve) => setTimeout(resolve, budget + 2_000))]);
  } catch {
    /* 超时 abort 或调用异常 → 落兜底 */
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }

  // 先尝试解析、再看是否超时：顺序同 llm-classify.js 的 classifyOutcome。
  // abort 只说明「流没按时结束」，模型常常早把答案吐完了而 SDK 流迟迟不收尾。
  // 此时手里已有完整结果还回一句失败，是白烧一次额度又骗了用户。
  const block = extractFirstJsonObject(out);
  if (block) {
    try { return { data: JSON.parse(block), reason: null, denied }; } catch { /* 归因到下面 */ }
  }
  // cancelled 要先于 timeout 判：两者都表现为 abort，但对用户是完全不同的两件事
  // （「你点了停止」vs「跑太久了」），归错会让人以为系统出故障
  if (signal?.aborted) return { data: null, reason: 'cancelled', denied };
  return { data: null, reason: abort.signal.aborted ? 'timeout' : 'unparsable', denied };
}

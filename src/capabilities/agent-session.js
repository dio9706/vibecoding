/**
 * 对话型 Agent 骨架 —— 与**人**多轮对话，不是跑一个任务。
 *
 * 与本层另外三个 LLM 骨架的分工：
 *   llm-classify.js       单轮零工具，出一行 JSON
 *   llm-readonly-agent.js 多轮只读**文件**，出一个 JSON 结论
 *   llm-sql-agent.js      多轮只读**数据库**，出一段分析
 *   本模块                多轮**带业务工具**、**跨消息续跑**，出一句给人看的回复
 *
 * 唯一的形态差别是 `resume`：上面三个都是一次性调用（`persistSession:false`），
 * 本模块要靠 SDK 的 session 维持「这个人跟我聊过什么」，所以**不设** persistSession。
 *
 * 本模块**不含业务语义** —— 不知道什么是需求、什么是同事，工具与提示词全由调用方注入。
 *
 * ## 两个用错就静默失效的坑（照抄 llm-sql-agent 的结论，勿改回去）
 *
 * 1. **不能用 `disallowedTools: ['*']` 收窄工具面。** 该字段语义是「removed from the
 *    model's context and cannot be used, **even if they would otherwise be allowed**」——
 *    通配符连我们自己的 MCP 工具一起删掉。实测表现为工具全部 Permission denied，
 *    而日志里只有一句含糊的权限拒绝。收窄工具面的正确字段是 `tools`。
 * 2. **不能把工具名列进 `allowedTools`。** 那是「auto-allowed without prompting」的免审批
 *    名单，**会让 `canUseTool` 整个不被调用**（SDK 打印 `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]`）。
 *    危险级判定、撤销台账、限流计数全挂在 canUseTool 上，设了它等于整套审计静默失效。
 *
 * `permissionMode` 必须是 `'default'`：`bypassPermissions` 会绕过 `canUseTool`。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeAuthOpts, getTokens, isPoolExhausted } from './token-rotation.js';
import { MCP_SERVER_NAME } from './agent-tools.js';
import { logger } from '../shared/logger.js';

/**
 * 单轮对话的超时预算。
 * 比 llm-readonly-agent 的 10 分钟短得多 —— 对面是个活人在等回复，
 * 超过两分钟这轮已经没有对话价值了，宁可落兜底让他重说一句。
 */
export const AGENT_TURN_TIMEOUT_MS = 120_000;

/**
 * 组装 `query()` 的 options —— **抽成纯函数只为可测**（文件头那两个坑都是静默失效型的）。
 *
 * @param {object} a
 * @param {object} a.server        buildAgentMcpServer 产出的 server
 * @param {Set<string>} a.allowed  全名白名单
 * @param {string} a.systemPrompt
 * @param {string} [a.sessionId]   有则 resume，维持长期 thread
 * @param {string} [a.cwd]
 * @param {string} [a.model]
 * @param {AbortController} [a.abort]
 */
export function buildTurnOptions({ server, allowed, systemPrompt, sessionId, cwd, model, abort }) {
  return {
    ...claudeAuthOpts(), // 跟随备用账号轮换，别烧主账号额度
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(sessionId ? { resume: sessionId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    permissionMode: 'default', // bypassPermissions 会绕过 canUseTool，绝不能用
    mcpServers: { [MCP_SERVER_NAME]: server },
    // 第 1 层：禁掉全部内置工具（Read/Bash/Write/…）。MCP 工具不在此列，仍可用。
    // 刻意**不用** disallowedTools:['*'] —— 那会连 MCP 工具一起删（见文件头「坑一」）。
    tools: [],
    // 第 2 层：运行时复核，每次工具调用都过。
    // 刻意**不设** allowedTools —— 设了会让本回调整个不被调用（见文件头「坑二」）。
    canUseTool: async (name, input) =>
      allowed.has(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: `本环境不提供 ${name}，请改用已有的业务工具` },
    ...(abort ? { abortController: abort } : {}),
  };
}

/**
 * 解析 SDK 消息流（抽出来是为了能不碰真实 SDK 就测到全部分支）。
 *
 * @param {AsyncIterable} stream
 * @returns {Promise<{ text: string, sessionId: string|null, toolTrace: Array }>}
 */
export async function parseTurnStream(stream) {
  let text = '';
  let sessionId = null;
  let fallback = '';
  const toolTrace = [];
  const prefix = `mcp__${MCP_SERVER_NAME}__`;

  for await (const m of stream) {
    if (m.type === 'system' && m.subtype === 'init') {
      sessionId = m.session_id || sessionId;
    } else if (m.type === 'assistant') {
      for (const b of m.message?.content || []) {
        if (b.type === 'text') text += b.text;
        // 轨迹里存短名：给主机看的审计信息，mcp__colleague__ 前缀是噪音
        else if (b.type === 'tool_use')
          toolTrace.push({ name: String(b.name || '').replace(prefix, ''), input: b.input });
      }
    } else if (m.type === 'result') {
      // 以 result 上的为准：SDK 在压缩等场景下可能换 session
      if (m.session_id) sessionId = m.session_id;
      if (m.result) fallback = m.result;
    }
  }
  return { text: text || fallback, sessionId, toolTrace };
}

/**
 * 跑一轮对话。
 *
 * @param {object} opts
 * @param {string} opts.userText      这个人说的话
 * @param {string} opts.systemPrompt
 * @param {object} opts.server        buildAgentMcpServer 的 server
 * @param {Set<string>} opts.allowed  全名白名单
 * @param {string} [opts.sessionId]   上一轮的 session，维持长期 thread
 * @param {string} [opts.cwd]
 * @param {string} [opts.model]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.logTag]
 * @returns {Promise<{ text, sessionId, toolTrace, reason }>}
 *   reason: null=正常 / 'exhausted'=额度耗尽 / 'timeout' / 'error'
 */
export async function runAgentTurn(opts) {
  const { userText, systemPrompt, server, allowed, sessionId, cwd, model, signal, logTag = 'agent' } = opts;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : AGENT_TURN_TIMEOUT_MS;

  // 额度耗尽 fail-fast：同 llm-classify / llm-sql-agent —— 五小时限流窗口内
  // SDK 流可能永不结束，不发起注定失败的调用
  if (isPoolExhausted(getTokens())) {
    logger.warn('agent-session', 'token 池全部耗尽，跳过本轮（fail-fast）', { logTag });
    return { text: '', sessionId: sessionId || null, toolTrace: [], reason: 'exhausted' };
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const relay = () => abort.abort();
  signal?.addEventListener?.('abort', relay, { once: true });

  try {
    const q = query({
      prompt: userText,
      options: buildTurnOptions({ server, allowed, systemPrompt, sessionId, cwd, model, abort }),
    });
    const r = await parseTurnStream(q);
    logger.info('agent-session', '一轮完成', { logTag, tools: r.toolTrace.length, chars: r.text.length });
    // sessionId 可能为 null（SDK 未回 init/result）——此时保留旧值，别把已有 thread 弄丢
    return { ...r, sessionId: r.sessionId || sessionId || null, reason: abort.signal.aborted ? 'timeout' : null };
  } catch (e) {
    logger.warn('agent-session', '本轮调用异常（已落兜底）', { logTag, err: e?.message || String(e) });
    return {
      text: '',
      sessionId: sessionId || null,
      toolTrace: [],
      reason: abort.signal.aborted ? 'timeout' : 'error',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', relay);
  }
}

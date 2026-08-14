/**
 * OpenAI 兼容 provider：流式对话 + 经 MCP 的 agentic 工具（工具定义/执行由 startOpenAiRun 注入）。
 * 无 MCP 配置时 input.tools 为空 → 自然降级为纯对话。凭证/路由见 server.js startOpenAiRun。
 */
import { runAgentLoop } from './agent-loop.js';
import { createOpenAiCompatModelRun } from './openai-compat-model.js';

export const OPENAI_COMPAT_CAPABILITIES = Object.freeze({
  agentic: true, tools: true, fileIO: true, permissions: true,
  stream: true, resume: false, rateLimitAware: false, compaction: false,
});

/**
 * @param {object} [deps]
 * @param {(input:object)=>Function} [deps.buildModelRun]  注入点（测试用）；默认按 input 造真实 adapter
 */
export function createOpenAiCompatProvider(deps = {}) {
  const buildModelRun =
    deps.buildModelRun ||
    ((input) =>
      createOpenAiCompatModelRun({
        apiKey: input.apiKey,
        baseURL: input.baseURL,
        model: input.model,
        tools: input.tools,
        abortSignal: input.abortController?.signal,
      }));
  return {
    id: 'openai-compat',
    capabilities: OPENAI_COMPAT_CAPABILITIES,
    /** @returns {{ done: Promise, abort: ()=>void }} */
    run(input = {}, hooks = {}) {
      const modelRun = buildModelRun(input);
      const executeTool = input.executeTool || (async () => { throw new Error('openai-compat v1 暂未接入工具执行'); });
      const done = runAgentLoop(
        { messages: input.messages || [], modelRun, executeTool, maxSteps: input.maxSteps, signal: input.abortController?.signal },
        hooks,
      );
      return { done, abort: () => input.abortController?.abort?.() };
    },
  };
}

export const openaiCompatProvider = createOpenAiCompatProvider();

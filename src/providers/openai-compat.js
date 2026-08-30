/**
 * OpenAI 兼容 provider：流式对话 + 经 MCP 的 agentic 工具（工具定义/执行由 startOpenAiRun 注入）。
 * 无 MCP 配置时 input.tools 为空 → 自然降级为纯对话。凭证/路由见 server.js startOpenAiRun。
 */
import { runAgentLoop } from './agent-loop.js';
// `openai-compat-model.js` 不在此静态 import —— 它拉进 `ai` + `@ai-sdk/openai-compatible`，
// 实测合计约 8.5MB heap。而本模块被 providers/index.js 无条件注册（进而被 run-claude 拉进
// web 启动链），默认 provider 却是 claude-agent：只用 Claude 的用户从头到尾碰不到这段代码。
// 改为真正跑 openai-compat 时才加载，见下方 buildModelRun。

export const OPENAI_COMPAT_CAPABILITIES = Object.freeze({
  agentic: true, tools: true, fileIO: true, permissions: true,
  stream: true, resume: false, rateLimitAware: false, compaction: false,
});

/**
 * @param {object} [deps]
 * @param {(input:object)=>Function|Promise<Function>} [deps.buildModelRun]
 *   注入点（测试用）；默认按 input 造真实 adapter。可同步可异步 —— 下方一律 await，
 *   而 await 一个非 Promise 值会立即 resolve，所以现有的同步注入照常工作。
 */
export function createOpenAiCompatProvider(deps = {}) {
  const buildModelRun =
    deps.buildModelRun ||
    (async (input) => {
      const { createOpenAiCompatModelRun } = await import('./openai-compat-model.js');
      return createOpenAiCompatModelRun({
        apiKey: input.apiKey,
        baseURL: input.baseURL,
        model: input.model,
        tools: input.tools,
        abortSignal: input.abortController?.signal,
      });
    });
  return {
    id: 'openai-compat',
    capabilities: OPENAI_COMPAT_CAPABILITIES,
    /** @returns {{ done: Promise, abort: ()=>void }} */
    run(input = {}, hooks = {}) {
      const executeTool = input.executeTool || (async () => { throw new Error('openai-compat v1 暂未接入工具执行'); });
      // run() 仍**同步**返回 { done, abort } —— 调用方拿到 abort 的时机不变。
      // 模型层的按需加载挪进 done 这条 Promise 链里，对调用方透明。
      const done = (async () => {
        const modelRun = await buildModelRun(input);
        return runAgentLoop(
          { messages: input.messages || [], modelRun, executeTool, maxSteps: input.maxSteps, signal: input.abortController?.signal },
          hooks,
        );
      })();
      return { done, abort: () => input.abortController?.abort?.() };
    },
  };
}

export const openaiCompatProvider = createOpenAiCompatProvider();

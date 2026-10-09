/**
 * OpenAI 兼容模型 adapter —— 唯一封装 AI SDK 版本细节的地方。
 * 把 streamText 的 fullStream/result 映射成 agent-loop 期望的规范化 modelRun。
 * 已核对 ai@7.0.35：text-delta 的 part.text；tool-call part 含 toolCallId/toolName/input；
 * result.finishReason(str)/toolCalls/responseMessages（response 已废弃，改用 responseMessages）。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';
import { logger } from '../shared/logger.js';

/** 用一个已构造的 languageModel 生成 modelRun（生产=openai-compatible；测试=MockLanguageModelV4）。
 *  tools 省略即纯对话；abortSignal 透传给 streamText 以支持真实中断；
 *  reasoningEffort 经 providerOptions 透传成请求里的 `reasoning_effort`（DeepSeek none/low/high/max 等）。
 *  modelRun(messages, opts)：opts.disableTools=true 时不带 tools（强制收尾轮；历史 tool 消息保留为上下文）。 */
export function streamTextToModelRun(languageModel, tools, abortSignal, reasoningEffort) {
  return (messages, opts = {}) => {
    // ai@7 的硬约束：system 不允许混在 messages 里（InvalidPromptError: Use the instructions option instead）。
    // 生产路径（run-openai 的 modelMessages）一直把 system 放在首条 → 真实调用必失败；
    // 单测用 mock 且从未带 system 形态，漏网（2026-10-08 P3 真端点冒烟实锤）。这里统一拆出。
    const instructions = [];
    const chat = [];
    for (const m of Array.isArray(messages) ? messages : []) {
      if (m && m.role === 'system') {
        const c = m.content;
        instructions.push(
          typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c.map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : '')).join('')
              : String(c ?? ''),
        );
      } else {
        chat.push(m);
      }
    }
    const result = streamText({
      model: languageModel,
      ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}),
      messages: chat,
      ...(tools && !opts.disableTools ? { tools } : {}),
      ...(abortSignal ? { abortSignal } : {}),
      ...(reasoningEffort ? { providerOptions: { openaiCompat: { reasoningEffort } } } : {}),
    });
    async function* stream() {
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') yield { type: 'text', text: part.text };
        else if (part.type === 'tool-call') {
          // invalid 是 AI SDK 的校验结论（zod schema 不匹配 / JSON 解析失败 / 未知工具）：
          // 下游 agent-loop 据此**跳过执行**——且不能再追加 tool-result，因为 AI SDK
          // 已把 error 结果放进了 responseMessages（重复同 id 结果会让下一轮请求畸形）。
          // 注意：该校验只认 zod 形态的 inputSchema；MCP 的 JSON Schema 参数类型不被校验
          //（2026-09-30 实测：Read 的 {path:123} 在 jsonSchema 形态下直接放行），那条路径
          //  目前依赖 MCP server 自身校验与工具实现兜底。
          yield {
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            invalid: part.invalid === true,
            ...(part.invalid
              ? { errorText: String(part.error?.message || part.error || '工具参数无效').slice(0, 500) }
              : {}),
          };
        } else if (part.type === 'error') {
          const err = part.error instanceof Error ? part.error : new Error(String(part.error?.message || part.error || '模型流错误'));
          // HTTP 细节（状态码/响应体摘要）在 err.message 里，落盘供事后排查（2026-10-08 空输出事故的观测缺口）
          logger.warn('openai-compat', '模型流错误', { err: err.message });
          throw err;
        }
      }
    }
    const finished = (async () => {
      const finishReason = await result.finishReason;
      const toolCalls = await result.toolCalls;
      const responseMessages = await result.responseMessages;
      // usage 透传给 agent-loop（journal 的 tokens 从此不再是恒 0）；abort 时可能拒绝，容错为 null
      let usage = null;
      try {
        usage = await result.usage;
      } catch {
        usage = null;
      }
      return { finishReason, toolCalls, responseMessages, usage };
    })();
    finished.catch(() => {}); // 防悬空：流抛错/abort 时 finished 可能未被 await，避免未处理 rejection 崩进程
    return { stream: stream(), finished };
  };
}

/** 生产用：按凭证造 openai-compatible 模型再包成 modelRun。reasoningEffort 可空（模型无强度档位时不带）。 */
export function createOpenAiCompatModelRun({ apiKey, baseURL, model, tools, abortSignal, reasoningEffort }) {
  const provider = createOpenAICompatible({ name: 'openai-compat', apiKey, baseURL });
  return streamTextToModelRun(provider(model), tools, abortSignal, reasoningEffort);
}

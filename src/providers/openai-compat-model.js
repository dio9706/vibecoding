/**
 * OpenAI 兼容模型 adapter —— 唯一封装 AI SDK 版本细节的地方。
 * 把 streamText 的 fullStream/result 映射成 agent-loop 期望的规范化 modelRun。
 * 已核对 ai@7.0.35：text-delta 的 part.text；tool-call part 含 toolCallId/toolName/input；
 * result.finishReason(str)/toolCalls/responseMessages（response 已废弃，改用 responseMessages）。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';

/** 用一个已构造的 languageModel 生成 modelRun（生产=openai-compatible；测试=MockLanguageModelV4）。
 *  tools 省略即纯对话；abortSignal 透传给 streamText 以支持真实中断。 */
export function streamTextToModelRun(languageModel, tools, abortSignal) {
  return (messages) => {
    const result = streamText({
      model: languageModel,
      messages,
      ...(tools ? { tools } : {}),
      ...(abortSignal ? { abortSignal } : {}),
    });
    async function* stream() {
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') yield { type: 'text', text: part.text };
        else if (part.type === 'tool-call') yield { type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input };
        else if (part.type === 'error') throw part.error instanceof Error ? part.error : new Error(String(part.error?.message || part.error || '模型流错误'));
      }
    }
    const finished = (async () => ({
      finishReason: await result.finishReason,
      toolCalls: await result.toolCalls,
      responseMessages: await result.responseMessages,
    }))();
    finished.catch(() => {}); // 防悬空：流抛错/abort 时 finished 可能未被 await，避免未处理 rejection 崩进程
    return { stream: stream(), finished };
  };
}

/** 生产用：按凭证造 openai-compatible 模型再包成 modelRun。 */
export function createOpenAiCompatModelRun({ apiKey, baseURL, model, tools, abortSignal }) {
  const provider = createOpenAICompatible({ name: 'openai-compat', apiKey, baseURL });
  return streamTextToModelRun(provider(model), tools, abortSignal);
}

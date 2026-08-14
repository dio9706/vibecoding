/**
 * Provider/SDK 无关的手动 agent loop。依赖注入便于离线单测，不碰真实 AI SDK。
 *   modelRun(messages) -> { stream, finished }
 *     stream: AsyncIterable，产出 { type:'text', text } | { type:'tool-call', toolCallId, toolName, input }
 *     finished: Promise<{ finishReason:string, toolCalls:Array<{toolCallId,toolName,input}>, responseMessages:Array }>
 *   executeTool(toolName, input) -> Promise<any>（真实实现由 MCP 提供；v1 无工具时不会被调用）
 * hooks: { onText(t), onActivity({name,input}), onResult({subtype,result,is_error}),
 *          canUseTool(name,input) -> Promise<{behavior:'allow'|'deny', message?}> }
 */
export async function runAgentLoop({ messages, modelRun, executeTool, maxSteps = 8, signal }, hooks = {}) {
  const convo = Array.isArray(messages) ? messages.slice() : [];
  let lastText = '';
  try {
    for (let step = 0; step < maxSteps; step++) {
      if (signal?.aborted) break; // 用户中断：不再起新一步
      const { stream, finished } = modelRun(convo);
      let stepText = '';
      for await (const ev of stream) {
        if (ev.type === 'text') {
          stepText += ev.text;
          hooks.onText?.(ev.text);
        } else if (ev.type === 'tool-call') {
          hooks.onActivity?.({ name: ev.toolName, input: ev.input });
        }
      }
      const done = (await finished) || {};
      // 心跳：告诉看门狗「还活着」。没有它的话，工具执行超过静默阈值（15min）且期间无文本增量时，
      // lastProgressAt 不刷新 → run 被当成卡死而 abortRun，把正在正常干活的任务误杀。
      // 这个钩子 run-openai.js 一直有传，但此前全文没人调用。
      hooks.onPulse?.();
      if (stepText) lastText = stepText;
      if (Array.isArray(done.responseMessages)) convo.push(...done.responseMessages);
      if (done.finishReason !== 'tool-calls') break;
      for (const call of done.toolCalls || []) {
        // 中断检查必须在**内层**也做：一轮可能返回多个 tool-call，用户在第 1 个执行中途点停止时，
        // 若不检查，后续 call 会 ① 命中 autoAllow 就真的执行（停止后的幽灵副作用），或
        // ② 走 canUseTool → askUser 新建 pending Promise，而 drainAsks 已经跑完且不会再跑
        //    → 该 Promise 永不 resolve → 本函数永不返回 → 上层 .finally(mcp.close) 永不执行
        //    → MCP stdio 子进程成孤儿。
        // 用 continue 而非 break：带 tool_calls 的 assistant 消息后，每个 toolCallId 都必须有
        // 对应结果，否则续跑时请求直接 400。中断也不能留半截。
        if (signal?.aborted) {
          convo.push(toToolResultMessage(call, { error: '已被用户停止' }));
          continue;
        }
        const decision = hooks.canUseTool ? await hooks.canUseTool(call.toolName, call.input) : { behavior: 'allow' };
        let output;
        if (decision?.behavior === 'allow') {
          try {
            output = await executeTool(call.toolName, call.input);
          } catch (e) {
            output = { error: String(e?.message || e) };
          }
        } else {
          output = { error: decision?.message || '用户拒绝了该操作' };
        }
        convo.push(toToolResultMessage(call, output));
        hooks.onPulse?.(); // 每个工具执行完也打一次：单个工具就可能跑很久
      }
    }
  } catch (e) {
    // 用户中断（abort）走静默收尾——终结由上层 stopRun 负责，不当失败上报
    if (signal?.aborted) return { result: lastText, messages: convo, aborted: true };
    hooks.onResult?.({ subtype: 'error', is_error: true, result: lastText, error: String(e?.message || e) });
    throw e; // 让上层 .done.catch → failRun 广播失败（带消息）
  }
  if (signal?.aborted) return { result: lastText, messages: convo, aborted: true };
  hooks.onResult?.({ subtype: 'success', result: lastText, is_error: false });
  return { result: lastText, messages: convo };
}

/** 组一条 AI SDK 期望的 tool 结果消息（字符串→text，其余→json；对 ai@7 ToolResultPart 已核） */
export function toToolResultMessage(call, output) {
  const part = typeof output === 'string' ? { type: 'text', value: output } : { type: 'json', value: output };
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: part }] };
}

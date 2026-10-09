import { logger } from '../shared/logger.js';

/**
 * Provider/SDK 无关的手动 agent loop。依赖注入便于离线单测，不碰真实 AI SDK。
 *   modelRun(messages, opts?) -> { stream, finished }
 *     opts.disableTools=true 时不向模型暴露任何工具（强制收尾轮用；历史 tool 消息保留为上下文）
 *     stream: AsyncIterable，产出 { type:'text', text } | { type:'tool-call', toolCallId, toolName, input }
 *     finished: Promise<{ finishReason:string, toolCalls:Array<{toolCallId,toolName,input}>, responseMessages:Array, usage? }>
 *   executeTool(toolName, input) -> Promise<any>（真实实现由 MCP 提供；v1 无工具时不会被调用）
 * hooks: { onText(t), onActivity({name,input}), onResult({subtype,result,is_error,...}),
 *          canUseTool(name,input) -> Promise<{behavior:'allow'|'deny', message?}> }
 *
 * 预算（maxSteps）：默认 **无上限（Infinity）**——对齐 Claude Code / OpenCode 的默认口径；
 * 0/空/非法值同样视为 ∞。设了有限上限且用尽时走 **强制收尾**（OpenCode 式）：注入
 * 「工具已禁用、只能文字总结」指令再要一轮，绝不静默截断（2026-10-08 事故：
 * docs/superpowers/specs/2026-10-08-openai-run-empty-output-fix.md；收尾设计：
 * docs/superpowers/specs/2026-10-08-unlimited-steps-and-forced-wrapup.md）。
 *
 * 返回 { result, messages, steps?, exhausted?, wrappedUp?, inputTokens?, outputTokens? }。
 */
const WRAP_UP_PROMPT =
  '系统提示：已到达工具调用步数上限，工具已禁用。只能输出文字，不得再调用任何工具。' +
  '请在回复中：1) 说明已达到步数上限；2) 汇总已完成的工作；3) 列出未完成的事项；4) 给出建议的下一步。';

export async function runAgentLoop({ messages, modelRun, executeTool, maxSteps = Infinity, signal }, hooks = {}) {
  const budget = Number.isFinite(Number(maxSteps)) && Number(maxSteps) > 0 ? Math.floor(Number(maxSteps)) : Infinity;
  const convo = Array.isArray(messages) ? messages.slice() : [];
  let lastText = '';
  let steps = 0;
  let lastFinishReason = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let wrappedUp = false;
  try {
    for (let step = 0; step < budget; step++) {
      if (signal?.aborted) break; // 用户中断：不再起新一步
      steps = step + 1;
      const { stream, finished } = modelRun(convo);
      let stepText = '';
      for await (const ev of stream) {
        if (ev.type === 'text') {
          stepText += ev.text;
          hooks.onText?.(ev.text);
        } else if (ev.type === 'tool-call') {
          // invalid 调用照样上报 activity（带标记），由上层提示「参数无效」；
          // 执行侧必须跳过（见下方 toolCalls 循环）。
          hooks.onActivity?.({ name: ev.toolName, input: ev.input, ...(ev.invalid ? { invalid: true } : {}) });
        }
      }
      const done = (await finished) || {};
      lastFinishReason = done.finishReason || '';
      if (done.usage && typeof done.usage === 'object') {
        inputTokens += Number(done.usage.inputTokens) || 0;
        outputTokens += Number(done.usage.outputTokens) || 0;
      }
      // 每步留痕（排障用）：空回复、截断、工具风暴都能从这里还原
      logger.info('agent-loop', '模型步完成', {
        step: steps,
        finishReason: lastFinishReason,
        textLen: stepText.length,
        toolCalls: Array.isArray(done.toolCalls) ? done.toolCalls.length : 0,
        inputTokens: done.usage?.inputTokens ?? null,
        outputTokens: done.usage?.outputTokens ?? null,
      });
      if (stepText) lastText = stepText; // 先落账再判错：error 收尾时已产出的文本也要如实带上
      // finishReason=error：没有 error part 但 provider 明确以错误收尾——不当成功吞掉
      if (done.finishReason === 'error') throw new Error('模型以错误结束（finishReason=error）');
      // 心跳：告诉看门狗「还活着」。没有它的话，工具执行超过静默阈值（15min）且期间无文本增量时，
      // lastProgressAt 不刷新 → run 被当成卡死而 abortRun，把正在正常干活的任务误杀。
      // 这个钩子 run-openai.js 一直有传，但此前全文没人调用。
      hooks.onPulse?.();
      if (Array.isArray(done.responseMessages)) {
        convo.push(...done.responseMessages);
        // 检查点钩子（P3）：把本步新增的消息批量交出去落盘——进程崩溃后从这里续，而不是从零重来
        hooks.onMessages?.(done.responseMessages);
      }
      if (done.finishReason !== 'tool-calls') break;
      for (const call of done.toolCalls || []) {
        // AI SDK 已判定参数无效的调用（zod 不匹配 / JSON 解析失败 / 未知工具）：
        // 不执行、不追加结果——responseMessages 里 AI SDK 已自动放了 error 结果，
        // 再追加一条同 toolCallId 的结果会让下一轮请求因重复 tool-result 而畸形（或 400）。
        // 也不能走 canUseTool：为一个注定不执行的调用弹审批卡是纯噪音。
        if (call.invalid) continue;
        // 中断检查必须在**内层**也做：一轮可能返回多个 tool-call，用户在第 1 个执行中途点停止时，
        // 若不检查，后续 call 会 ① 命中 autoAllow 就真的执行（停止后的幽灵副作用），或
        // ② 走 canUseTool → askUser 新建 pending Promise，而 drainAsks 已经跑完且不会再跑
        //    → 该 Promise 永不 resolve → 本函数永不返回 → 上层 .finally(mcp.close) 永不执行
        //    → MCP stdio 子进程成孤儿。
        // 用 continue 而非 break：带 tool_calls 的 assistant 消息后，每个 toolCallId 都必须有
        // 对应结果，否则续跑时请求直接 400。中断也不能留半截。
        if (signal?.aborted) {
          const stoppedMsg = toToolResultMessage(call, { error: '已被用户停止' });
          convo.push(stoppedMsg);
          hooks.onMessages?.([stoppedMsg]); // 检查点：被跳过的调用也要落盘，会话保持良构
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
        const resultMsg = toToolResultMessage(call, output);
        convo.push(resultMsg);
        hooks.onMessages?.([resultMsg]); // 检查点：每条 tool 结果立即交出去落盘
        hooks.onPulse?.(); // 每个工具执行完也打一次：单个工具就可能跑很久
      }
    }
  } catch (e) {
    // 用户中断（abort）走静默收尾——终结由上层 stopRun 负责，不当失败上报
    if (signal?.aborted) return { result: lastText, messages: convo, aborted: true, steps, inputTokens, outputTokens };
    hooks.onResult?.({ subtype: 'error', is_error: true, result: lastText, error: String(e?.message || e), inputTokens, outputTokens, steps });
    throw e; // 让上层 .done.catch → failRun 广播失败（带消息）
  }
  if (signal?.aborted) return { result: lastText, messages: convo, aborted: true, steps, inputTokens, outputTokens };
  // 预算用尽且最后一步仍在要工具 → 强制收尾（OpenCode 式）：注入收尾指令再要一轮文字总结，
  // 不再静默截断（默认无上限时此分支不会走到）。
  const exhausted = steps >= budget && lastFinishReason === 'tool-calls';
  if (exhausted) {
    logger.warn('agent-loop', '工具步数上限已用尽，启动强制收尾', { maxSteps: budget, steps });
    try {
      const wrapConvo = [...convo, { role: 'system', content: WRAP_UP_PROMPT }];
      const { stream, finished } = modelRun(wrapConvo, { disableTools: true });
      let wrapText = '';
      for await (const ev of stream) {
        // 收尾轮工具已禁用：即便模型仍返回 tool-call 也一律忽略，绝不执行
        if (ev.type === 'text') {
          wrapText += ev.text;
          hooks.onText?.(ev.text);
        }
        if (signal?.aborted) break;
      }
      const done = (await finished) || {};
      if (done.usage && typeof done.usage === 'object') {
        inputTokens += Number(done.usage.inputTokens) || 0;
        outputTokens += Number(done.usage.outputTokens) || 0;
      }
      logger.info('agent-loop', '强制收尾完成', {
        finishReason: done.finishReason || '',
        textLen: wrapText.length,
        inputTokens: done.usage?.inputTokens ?? null,
        outputTokens: done.usage?.outputTokens ?? null,
      });
      if (Array.isArray(done.responseMessages)) {
        convo.push(...done.responseMessages);
        hooks.onMessages?.(done.responseMessages); // 收尾总结落检查点：历史不再停在半截 tool 结果
      }
      if (wrapText) lastText = wrapText;
      wrappedUp = true;
    } catch (e) {
      logger.warn('agent-loop', '强制收尾调用失败（按原状结束）', { err: e?.message || String(e) });
    }
  }
  hooks.onResult?.({ subtype: 'success', result: lastText, is_error: false, inputTokens, outputTokens, steps, exhausted, wrappedUp });
  return { result: lastText, messages: convo, steps, exhausted, wrappedUp, inputTokens, outputTokens };
}

/** 组一条 AI SDK 期望的 tool 结果消息（字符串→text，其余→json；对 ai@7 ToolResultPart 已核） */
export function toToolResultMessage(call, output) {
  const part = typeof output === 'string' ? { type: 'text', value: output } : { type: 'json', value: output };
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: part }] };
}

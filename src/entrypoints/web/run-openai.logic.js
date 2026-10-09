/**
 * web 入口 openai run 编排的纯函数层（无 I/O，可单测）。
 * run-openai.js 本体全是 SDK/网络/落盘，无法直测，判定与修复逻辑收在这里。
 * 孤儿对账归类（原 classifyOpenAiOrphan）已随 P5 统一迁至 `run-reconcile.logic.js#classifyInterrupted`。
 */

/**
 * 修复消息序列里的「悬空工具调用」。
 *
 * 崩溃可能停在「assistant 带 tool-call、结果未落盘」处（检查点步边界之间）。此时直接续跑，
 * 下一轮请求会因 tool-call/tool-result 不配对而畸形或 400。修复：对每个缺结果的调用，
 * 按其后紧跟的位置补一条合成 tool-result（「进程中断，该工具未执行」）：
 *   - 悬空调用在新 assistant / user / system 消息之前出现时，补在**那条消息之前**（保持消息序合法）；
 *   - 尾部悬空补在末尾。
 * 语义取舍：合成结果是「未执行」的事实陈述，模型看到后会自行决定是否重试该工具——
 * 不假装执行过、也不静默丢弃调用记录（T2 spec §4.3 拍板：步边界 + 悬空修复）。
 *
 * @param {Array} messages ModelMessage 数组（不动原数组；无悬空时原样返回）
 * @param {{note?: string}} [opts] note = 合成结果文案
 * @returns {{messages: Array, added: Array}} added = 本次补写的合成 tool-result 消息（供落盘；空数组=无需修复）
 */
export function repairDanglingToolCalls(messages, { note = '进程中断，该工具未执行' } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return { messages, added: [] };
  const out = [];
  const added = [];
  let pending = []; // [{ toolCallId, toolName }] 尚未配到结果的调用
  const flushPending = () => {
    for (const c of pending) {
      const msg = {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: c.toolCallId, toolName: c.toolName, output: { type: 'text', value: note } },
        ],
      };
      out.push(msg);
      added.push(msg);
    }
    pending = [];
  };
  for (const m of messages) {
    if (m && m.role === 'assistant') {
      flushPending(); // 进入新 assistant 前，上一批未配对的调用必须先补结果
      out.push(m);
      for (const p of Array.isArray(m.content) ? m.content : []) {
        if (p && p.type === 'tool-call' && p.toolCallId) pending.push({ toolCallId: p.toolCallId, toolName: p.toolName });
      }
    } else if (m && m.role === 'tool') {
      out.push(m);
      for (const p of Array.isArray(m.content) ? m.content : []) {
        if (p && p.type === 'tool-result' && p.toolCallId) pending = pending.filter((c) => c.toolCallId !== p.toolCallId);
      }
    } else {
      flushPending(); // user/system 等消息之前同理
      out.push(m);
    }
  }
  flushPending();
  return added.length ? { messages: out, added } : { messages, added };
}

/**
 * 工具循环步数上限归一（composer/基础设置的 `uiPrefs.openaiMaxSteps`）。
 * 正整数 → 该值（取整）；**0 / 空 / 非法 → Infinity（无上限）**——对齐 Claude Code / OpenCode
 * 的默认口径（spec `2026-10-08-unlimited-steps-and-forced-wrapup.md`）。
 */
export function resolveMaxSteps(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
}

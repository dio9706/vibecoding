/**
 * SDK task_* 系统事件 → onActivity 载荷（纯函数，零 IO）。
 *
 * 为什么抽出来：runClaude 的消费循环全是 SDK 流与回调，无法直测；而「工作流还是子代理」的标签
 * 判定正是会出错的地方 —— 只有 task_started 带 workflow_name（progress 带 subagent_type，
 * notification 两者都不带），所以 started 时按 task_id 记下类型，后续事件查表。
 * kinds 由调用方持有，生命周期是 runClaude 的一次 attempt：重试 = 新 query 新流，旧 task_id 不该跨越。
 */

const FALLBACK_LABEL = '子代理'; // 查表与消息自身都给不出类型时的回落（progress 早于 started 到达 / 跨 attempt 丢表），与改前文案一致

const clipText = (s, n) => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n) + '…' : str;
};

/** task_started 的类型：name 给 onActivity.name（沿用 tool-summary 的工具词汇），label 给展示；工作流 > 子代理 > 后台任务 */
function taskKind(message) {
  if (message.workflow_name) return { name: 'Workflow', label: `工作流(${message.workflow_name})` };
  if (message.subagent_type) return { name: 'Agent', label: `子代理(${message.subagent_type})` };
  return { name: 'Agent', label: '后台任务' };
}

/** 展示标签（供测试直取；运行时走 describeTaskEvent） */
export function taskKindLabel(message) {
  return taskKind(message).label;
}

/** claude.js 用它决定哪些 system 消息交给 describeTaskEvent，避免两处各持一份 subtype 清单；不认识的 task_* 子类型由 describeTaskEvent 返回 null */
export function isTaskEvent(message) {
  return message?.type === 'system' && typeof message.subtype === 'string' && message.subtype.startsWith('task_');
}

// 查表未命中时的回落：progress 自带 subagent_type 就别浪费；真没有信息才退到 FALLBACK_LABEL（不退到「后台任务」，保持改前文案）
const fallbackKind = (message) =>
  message.subagent_type ? { name: 'Agent', label: `子代理(${message.subagent_type})` } : { name: 'Agent', label: FALLBACK_LABEL };

/**
 * @param {object} message  SDK system 消息（subtype 以 task_ 开头）
 * @param {Map<string,{name:string,label:string,skip:boolean}>} kinds  task_id → 类型记录，调用方按 attempt 持有
 * @returns {{ name: 'Workflow'|'Agent', input: {}, sub: true, text: string } | null}  null = 不进转录
 */
export function describeTaskEvent(message, kinds) {
  if (message.subtype === 'task_started') {
    const rec = { ...taskKind(message), skip: !!message.skip_transcript };
    kinds.set(message.task_id, rec); // 常驻任务也要记：它的 progress 不带 skip_transcript，得靠这条记录把它们一起压掉
    if (rec.skip) return null;
    return { name: rec.name, input: {}, sub: true, text: `${rec.label}启动：${clipText(message.description, 40)}` };
  }
  if (message.subtype === 'task_progress') {
    const rec = kinds.get(message.task_id) || fallbackKind(message);
    if (rec.skip) return null; // SDK 约定：ambient 任务 consumers should hide this from the inline transcript
    const u = message.usage || {};
    const tool = message.last_tool_name ? `正在 ${message.last_tool_name}` : '执行中';
    const secs = u.duration_ms ? ` ${Math.round(u.duration_ms / 1000)}s` : ''; // 0/缺失都省略（0s 无意义）；空格并入，避免模板里留孤立空格
    return {
      name: rec.name,
      input: {},
      sub: true,
      text: `${rec.label}${tool} · 已 ${u.tool_uses ?? '?'} 次工具${secs}：${clipText(message.description, 30)}`,
    };
  }
  if (message.subtype === 'task_notification') {
    const rec = kinds.get(message.task_id) || fallbackKind(message);
    kinds.delete(message.task_id); // 终态：不清会让 Map 随 attempt 无限增长
    if (message.skip_transcript || rec.skip) return null;
    const status = { completed: '完成', failed: '失败', stopped: '已停止' }[message.status] || message.status;
    return { name: rec.name, input: {}, sub: true, text: `${rec.label}${status}：${clipText(message.summary || '', 60)}` };
  }
  return null; // task_updated 等：不进转录
}

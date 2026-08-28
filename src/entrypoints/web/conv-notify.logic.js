/**
 * 会话通知的纯函数层（无 I/O，可单测）。
 * 卡片**只在 web 侧构造**，飞书侧只解析按钮 value —— 两侧靠 value 契约耦合，
 * 不共享构造代码（web 进程不 import 插件模块，插件也不 import web 入口模块）。
 */
export const CONV_CARD_KIND = 'conv-settled';

/**
 * 该 run 的终结要不要推飞书。
 * 按「排除法」写而不是白名单：finishRun 路径下 subtype 可能是空串/undefined，
 * 白名单会把正常完成的任务漏掉。
 * - stopped：用户自己刚点的停止，再推一条纯属噪音
 * - quota_blocked：额度撞墙会自动续跑，任务逻辑上没结束（续跑真终结时才推）
 * - exception_retry：异常后会自动重试，任务逻辑上没结束（重试真终结或熔断时才推）
 */
export function shouldNotifySettle(run) {
  if (!run || run.status === 'running') return false;
  return !['stopped', 'quota_blocked', 'exception_retry'].includes(run.subtype);
}

export function summarize(text, max = 500) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return '(无输出)';
  return s.length > max ? '…' + s.slice(-max) : s;
}

export function formatDuration(ms) {
  const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

/** 会话终结通知卡片：标题 + 结果 + 耗时 + 摘要 + 会话ID提示 */
export function buildConvSettledCard(entry, run) {
  const ok = !run.is_error && run.status !== 'error';
  const head = ok ? '✅ **任务已完成**' : '❌ **任务失败**';
  const dur = formatDuration((run.updatedAt || Date.now()) - (run.startedAt || Date.now()));
  // 询问模式下注入的补充内容会卡在权限审批上等人 —— 提前说清楚，别让用户在飞书干等
  const askHint =
    entry.mode === 'default'
      ? '\n\n⚠️ 该会话为「询问模式」，补充内容若触发改码工具会等待网页端审批。'
      : '';

  // 会话 ID 防守：确保 convId 总是有效，取前 8 位作为短 ID
  const id = (entry.convId || '').slice(0, 8);
  const sessionHint = `\n\n---\n会话ID：\`${id}\`\n如需继续对话，向我发送：会话 ${id} 你的内容`;

  return {
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${head}\n会话：「${entry.title || entry.convId}」 · 耗时 ${dur}\n\n${summarize(run.text)}${askHint}${sessionHint}`,
        },
      },
    ],
  };
}

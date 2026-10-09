/**
 * 自动开发验证门的纯函数：prompt 片段、卡片文案、重试上限。零 IO，单测主战场。
 */
import { formatDuration } from '../../../capabilities/verifier.logic.js';

/** 首次 + 1 次重试。刻意不做配置（YAGNI）：多一次就多烧一轮额度，失败交人工 */
export const MAX_VERIFY_ATTEMPTS = 2;

/** 首次开发的 prompt 段：先告诉模型「完成标准」，再让它动手 */
export function buildVerifySection(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return '';
  return (
    `\n\n【完成标准】本次改动完成后，必须让以下命令通过：\n  ${cmd}\n` +
    `你可以自行运行它以检查；系统会在提交前复跑判定，未通过会要求你修复。\n` +
    `禁止通过删除/改写测试、修改验证配置来绕过验证。`
  );
}

/** 重试开发的 prompt 段：带上失败输出，明确修复目标与反绕过纪律 */
export function buildVerifyRetrySection(verify) {
  if (!verify || !verify.command) return '';
  const code = verify.timedOut ? '超时' : `退出码 ${verify.exitCode ?? '-'}`;
  const out = String(verify.output || '').trim();
  const clip = out.length > 4000 ? out.slice(0, 2000) + '\n…（略）\n' + out.slice(-2000) : out;
  return (
    `\n\n【上一次未通过自检】命令：${verify.command}（${code}，用时 ${formatDuration(verify.durationMs)}）\n` +
    `输出（截断）：\n${clip || '(无输出)'}\n\n` +
    `请修复到通过。禁止通过删除/改写测试、修改验证配置来绕过验证。`
  );
}

/**
 * 卡片/面板用的自检行。markdown 与纯文本两条通道共用同一取数逻辑（只差加粗标记），
 * 防「卡片说通过、降级文本什么都没说」的分叉。
 */
export function buildVerifyLine(v, { markdown = true } = {}) {
  if (!v) return '';
  if (v.skipped) {
    return v.reason === '未配置验证命令'
      ? '\n🔍 未配置自检命令（可在设置页补充）'
      : `\n🔍 自检已跳过：${v.reason || '未执行'}`;
  }
  if (v.ok) return `\n🔍 自检通过：${v.command}（${formatDuration(v.durationMs)}）`;
  const bold = (s) => (markdown ? `**${s}**` : s);
  const retry = v.attempts > 1 ? `（已重试 ${v.attempts - 1} 次）` : '';
  return `\n⚠️ ${bold('自检未通过')}：${v.command} 退出码 ${v.exitCode ?? '-'}${retry}`;
}

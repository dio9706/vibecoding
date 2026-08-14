/** 自动开发纯逻辑（无副作用，可单测）。原 unattended/logic.js 精简迁入（批量模式相关函数随开关退役）。 */

/** 任务分支名：auto/<taskId> —— 每任务一分支，支持单任务合并 */
export function taskBranchName(task) {
  return `auto/${task.id}`;
}

/** git commit message（清洗 title 里的 shell 敏感字符，防命令注入） */
export function buildCommitMessage(task, ok) {
  const kind = task.type === 'bug' ? 'fix' : 'feat';
  const flag = ok ? '' : ' [failed]';
  const safe = String(task.title || '').replace(/[\r\n]+/g, ' ').replace(/["'`$&|;<>^%!()\\]/g, '').trim();
  return `${kind}: ${safe}${flag} (task ${task.id})`;
}

/** 从脚本 stdout 提取最后一个图片直链（png/jpg/jpeg/webp，允许 ?t= 尾参） */
export function parseQrUrl(stdout) {
  const re = /https?:\/\/\S+\.(?:png|jpg|jpeg|webp)(?:\?\S*)?/gi;
  const matches = (stdout || '').match(re);
  return matches && matches.length ? matches[matches.length - 1] : null;
}

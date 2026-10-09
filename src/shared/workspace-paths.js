/**
 * 工作目录路径工具 —— 纯函数（零 IO），供内置工具（providers/builtin-tools）与策略引擎
 * （capabilities/tool-policy）共用。
 *
 * 为什么抽到 shared：「目标路径在不在工作目录内」是审批/策略判定的共同事实，
 * 两处各写一份 `path.relative` 判定必然分叉——而它是「区内自动 / 越界审批」的分界线。
 */
import path from 'node:path';

/** 工作目录归一：没传就退到服务进程 cwd（与 Claude 路径 SDK 默认一致） */
export function resolveWorkspace(cwd) {
  return path.resolve(cwd || process.cwd());
}

/**
 * target 是否在 workspace 树内（含 workspace 自身）。
 * 跨盘符在 Windows 上 path.relative 会给出绝对路径，天然判为外。
 */
export function isInsideWorkspace(workspace, target) {
  const rel = path.relative(workspace, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** 相对路径按 workspace 解析；绝对路径原样。两种都先 normalize（消灭 ../ 绕行） */
export function resolveToolPath(p, workspace) {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(workspace, p);
}

/** 显示的相对路径：工作目录内显示相对路径（正斜杠），目录外保留绝对路径（审批卡/模型都看得懂） */
export function displayPath(absolute, workspace) {
  const rel = path.relative(workspace, absolute);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return absolute;
  return rel.split(path.sep).join('/');
}

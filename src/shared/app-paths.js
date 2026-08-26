/**
 * 可写目录解析 —— 全项目唯一来源。
 *
 * 打包后 __dirname 指向**只读**的安装目录（如 C:\Program Files\vibe-coding-desktop\resources\...），
 * 往那里写东西一律 EPERM/EACCES。Tauri 会注入 APP_DATA_DIR 指向用户可写目录，必须优先使用。
 *
 * 这条规则原本被复制了五份，其中三份漏了 APP_DATA_DIR，且失败都被 try/catch 静默吞掉：
 *   - shared/logger.js              → 打包版**零日志**（排障直接失明）
 *   - integrations/lark.js          → 飞书图片/文件/文档下载全链路失效
 *   - plugins/team-tools/material-pool.js → 同上
 * 收敛到这里后，新增落盘目录只需 appDataPath('xxx')，不会再各写各的。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件在 src/shared/ 下）——仅开发态使用 */
const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * 应用可写根目录：打包态取 APP_DATA_DIR，开发态回退仓库根。
 * 刻意在**调用时**读环境变量而不是模块求值时固化：既便于测试注入，
 * 也避免「启动早期才设置 env」的场景静默拿到错误值。
 */
export function appDataDir() {
  const fromEnv = process.env.APP_DATA_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv;
  return REPO_ROOT;
}

/** 是否为打包态（由 APP_DATA_DIR 是否注入判定） */
export function isPackaged() {
  const v = process.env.APP_DATA_DIR;
  return typeof v === 'string' && v.trim().length > 0;
}

/** 拼接可写目录下的子路径 */
export function appDataPath(...segments) {
  return segments.length ? path.join(appDataDir(), ...segments) : appDataDir();
}

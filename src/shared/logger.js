/**
 * 统一日志 —— 全项目排查用（写入 logs/app-YYYY-MM-DD.log + 控制台镜像）。
 * 仅供开发者/AI 排查异常，不面向前端展示（与 store/event-log 各司其职）。
 * 设计约束：永不抛错（日志失败绝不影响主流程）；无第三方依赖；同步写，量级可控。
 */
import fs from 'node:fs';
import path from 'node:path';
import { appDataPath } from './app-paths.js';

// 必须走 appDataPath：此前用 __dirname 拼「项目根 logs/」，打包后 __dirname 指向只读安装目录，
// mkdir 与后续 append 全部 EPERM，而这两处都是 try/catch 静默吞掉的
// —— 结果是**打包版一条日志都写不出来，且毫无征兆**。
const LOG_DIR = appDataPath('logs');

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {
  /* ignore：目录创建失败则退化为仅控制台 */
}

function fileForToday() {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `app-${d}.log`);
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  } catch {
    return '[unserializable]';
  }
}

function fmt(level, tag, msg, extra) {
  const time = new Date().toISOString();
  let line = `[${time}] [${level}] [${tag}] ${msg}`;
  if (extra && typeof extra === 'object' && Object.keys(extra).length) {
    line += ' | ' + safeStringify(extra);
  }
  return line;
}

function write(level, tag, msg, extra) {
  const line = fmt(level, tag, msg, extra);
  // 控制台镜像（error 走 stderr）
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  // 落文件（失败静默）
  try {
    fs.appendFileSync(fileForToday(), line + '\n');
  } catch {
    /* ignore */
  }
}

export const logger = {
  debug: (tag, msg, extra) => write('DEBUG', tag, msg, extra),
  info: (tag, msg, extra) => write('INFO', tag, msg, extra),
  warn: (tag, msg, extra) => write('WARN', tag, msg, extra),
  error: (tag, msg, extra) => write('ERROR', tag, msg, extra),
};

/**
 * 包裹一个异步调用，自动记录 开始/结束/耗时/错误（带 ▶ ✔ ✖ 前缀）。
 * 用于把「卡住/失败」变可见：只见 ▶ 不见 ✔/✖ = 仍在跑或已挂死。
 * @returns 被包裹函数的返回值（异常会原样抛出，但已记录）
 */
export async function logSpan(tag, label, fn, extra = {}) {
  const t0 = Date.now();
  logger.info(tag, `▶ ${label}`, extra);
  try {
    const r = await fn();
    logger.info(tag, `✔ ${label}`, { ...extra, ms: Date.now() - t0 });
    return r;
  } catch (e) {
    logger.error(tag, `✖ ${label}`, { ...extra, ms: Date.now() - t0, err: e?.message || String(e) });
    throw e;
  }
}

/** 截断长文本用于日志预览（去多余空白） */
export function preview(text, n = 120) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

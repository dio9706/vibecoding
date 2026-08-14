/**
 * 材料暂存池 —— 「先发文件/文档，再发需求描述」的归并机制。
 * 附件/文档/纯材料消息挂不上近期任务时先入池；下一条文字立案时 drain 吸附进 detail。
 * 内存态 + TTL 10 分钟 + 单 key 上限 10 条（与 channels/feishu.js 的 seen 去重同一哲学：
 * 短暂临时态不落盘，进程重启丢失的代价只是用户重发一次）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { appDataPath } from '../../shared/app-paths.js';

// 与 lark.js 的 RESOURCE_DIR 同根：.uploads/feishu 下不被 web 入口顶层清理。
// 同样必须走 appDataPath —— 打包后 __dirname 是只读安装目录（详见 shared/app-paths.js）。
const MATERIAL_DIR = appDataPath('.uploads', 'feishu', 'materials');

const TTL_MS = 10 * 60 * 1000;
const MAX_PER_KEY = 10;

// key = `${openId}:${chatId}` → [{ kind:'image'|'file'|'doc'|'text', path, title?, at }]
const pool = new Map();

const keyOf = (openId, chatId) => `${openId}:${chatId}`;

/** 取 key 下未过期材料（懒清理：顺手把过期的剔掉） */
function alive(key, now) {
  const list = pool.get(key) || [];
  const fresh = list.filter((m) => now - m.at <= TTL_MS);
  if (fresh.length) pool.set(key, fresh);
  else pool.delete(key);
  return fresh;
}

/** 入池；超上限丢最旧 */
export function addMaterial(openId, chatId, material, now = Date.now()) {
  const key = keyOf(openId, chatId);
  const list = alive(key, now);
  list.push({ ...material, at: now });
  while (list.length > MAX_PER_KEY) list.shift();
  pool.set(key, list);
}

export function hasMaterials(openId, chatId, now = Date.now()) {
  return alive(keyOf(openId, chatId), now).length > 0;
}

/** 取出并清空该 key 的全部未过期材料 */
export function drainMaterials(openId, chatId, now = Date.now()) {
  const key = keyOf(openId, chatId);
  const list = alive(key, now);
  pool.delete(key);
  return list;
}

/** 纯格式化：材料 → detail 追加行（image 沿用「补充截图」标签，保持 analyze prompt 兼容） */
export function materialDetailLine(m) {
  if (m.kind === 'image') return `[补充截图] ${m.path}`;
  if (m.kind === 'file') return m.title ? `[附件] ${m.title}：${m.path}` : `[附件] ${m.path}`;
  if (m.kind === 'doc') return `[参考文档] ${m.title || '飞书文档'}：${m.path}`;
  return `[参考材料] ${m.path}`;
}

/** 长文本材料落盘为 md，返回绝对路径（供入池/挂任务；Claude 可 Read） */
export function saveTextMaterial(title, content) {
  fs.mkdirSync(MATERIAL_DIR, { recursive: true });
  const file = path.join(MATERIAL_DIR, Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + '.md');
  fs.writeFileSync(file, `# ${title}\n\n${content}`, 'utf8');
  return file;
}

/** 仅测试用：清空池 */
export function clearPool() {
  pool.clear();
}

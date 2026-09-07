/**
 * 历史会话管理 —— 从 ~/.claude/projects/<project>/ 目录扫描并解析历史 JSONL 文件
 * 每个 .jsonl 是一次完整 session，由行分隔的事件组成
 */

import fs from 'node:fs';
import { readFirstLines } from './read-first-lines.js';
import path from 'node:path';
import os from 'node:os';

const PROJECT_ID = process.env.CLAUDE_PROJECT_ID || 'C--Users-DELL-Desktop-claude-p-web-demo';

// 常量定义
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const SESSION_METADATA_SCAN_LINES = 50; // 扫描前 50 行来提取元数据
const MAX_PREVIEW_LENGTH = 50; // 标题预览最大长度
const MAX_QUERY_LENGTH = 500; // 查询字符串最大长度

/**
 * 把工作目录绝对路径编码为 Claude Code 的 project 目录名。
 * 规则（与 CLI 一致）：把 : \ / . 全部替换为 -，例如
 *   C:\Users\DELL\Desktop\claude-p-web-demo → C--Users-DELL-Desktop-claude-p-web-demo
 * 附带安全性：. 与 / \ 均被替换，天然杜绝 ..、绝对路径穿越（结果不含路径分隔符）。
 * @param {string} cwd 绝对工作目录
 * @returns {string} project 目录名
 */
function encodeProjectId(cwd) {
  return cwd.replace(/[:\\/.]/g, '-');
}

/**
 * 获取历史目录路径（按工作目录定位对应 project，空 cwd = 服务目录）
 * @param {string} [cwd] 工作目录绝对路径；为空用默认 PROJECT_ID（web 服务自身目录）
 * @returns {string} ~/.claude/projects/<projectId>/
 */
export function getHistoryDir(cwd = '') {
  const projectId = cwd ? encodeProjectId(cwd) : PROJECT_ID;
  return path.join(os.homedir(), '.claude', 'projects', projectId);
}

/**
 * 会话元数据缓存：`fullPath → { mtimeMs, meta }`。
 *
 * 为什么需要：列表接口会被前端反复请求，而它对目录下**每个** jsonl 都要开一次文件、
 * 解析前 N 行。实测 98 个会话时单次 108ms / 0.57MB 临时对象 —— 但这些文件里
 * 只有**当前正在写的那个**会变，其余 97 份每次都在重复解析出完全相同的结果。
 *
 * mtime 没变就直接复用：磁盘上的内容没动，解析结果必然相同（parseSessionMetadata
 * 是纯函数，只依赖文件内容）。变了才重新解析，语义与原来完全一致。
 *
 * 不会无限增长：每次扫描结束后用「本次实际见到的路径」重建缓存，
 * 已删除的会话文件自然被淘汰，缓存大小恒等于目录下的文件数。
 */
const metaCache = new Map();

/**
 * 列出所有历史会话（按修改时间倒序）
 * @param {number} [limit=100] 返回结果数量限制
 * @param {number} [offset=0] 分页偏移
 * @param {string} [cwd] 工作目录（定位对应 project，空=服务目录）
 * @returns {Promise<Array<{ sessionId, title, createdAt, updatedAt, messageCount }>>}
 */
export async function listHistorySessions(limit = 100, offset = 0, cwd = '') {
  const dir = getHistoryDir(cwd);
  try {
    const files = await fs.promises.readdir(dir, { withFileTypes: true });
    const sessions = [];
    const seen = new Map(); // 本轮见到的 fullPath → 缓存项，用于结束时重建 metaCache
    let parsed = 0; // 本轮真正重新解析的文件数（缓存未命中）

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const sessionId = file.name.replace('.jsonl', '');
      const fullPath = path.join(dir, file.name);

      try {
        const stat = await fs.promises.stat(fullPath);
        const hit = metaCache.get(fullPath);
        let meta;
        if (hit && hit.mtimeMs === stat.mtimeMs) {
          meta = hit.meta; // 文件没动过，解析结果必然相同
        } else {
          meta = await parseSessionMetadata(fullPath);
          parsed++;
        }
        seen.set(fullPath, { mtimeMs: stat.mtimeMs, meta });

        sessions.push({
          sessionId,
          title: meta.title || meta.firstUserMessage || '未命名对话',
          // 统一用毫秒数字，避免 birthtimeMs(number)/mtime(Date) 混用导致前端排序踩坑
          createdAt: stat.birthtimeMs || stat.mtimeMs,
          updatedAt: stat.mtimeMs,
          messageCount: meta.messageCount,
        });
      } catch (e) {
        console.warn(`Failed to parse session ${sessionId}:`, e.message);
      }
    }

    // 用本轮结果整体替换：已删除的文件不会留在缓存里
    metaCache.clear();
    for (const [k, v] of seen) metaCache.set(k, v);

    // 只在真正解析了文件时记一行（原来每次请求都打印，前端一轮询就刷屏，
    // 而它本身还要拼一次字符串）。稳态下 parsed 为 0 或 1，日志因此变得有信息量：
    // 它现在表示「有几个会话发生了变化」。
    if (parsed) {
      console.log(`[history] ${dir}：${sessions.length} 个会话，本次重新解析 ${parsed} 个`);
    }

    // 按 updatedAt 倒序（最近在前），然后应用分页
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(offset, offset + limit);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log(`[history] 目录不存在（首次运行正常）: ${dir}`);
      return [];
    }
    throw e;
  }
}

/**
 * 从一条消息记录的 content 字段中提取可展示的纯文本
 * 真实 JSONL schema：content 可能是字符串，也可能是内容块数组
 *   - 字符串：直接就是文本，原样 trim 返回
 *   - 数组：元素形如 { type:'text', text }、{ type:'thinking', ... }、{ type:'tool_use', ... }、
 *           { type:'tool_result', ... }，仅取 type==='text' 块的 .text 拼接，跳过 thinking/tool_* 等非文本块；
 *           若元素本身是纯字符串也一并纳入（加固兼容）
 *   - 其它（null/undefined/对象）：返回空串
 * @param {*} content obj.message.content
 * @returns {string}
 */
function extractText(content) {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

/**
 * 从 JSONL 文件的前几行提取元数据（避免读取整个大文件）
 * 每行靠 obj.type 区分：user / assistant 计入消息，ai-title 提供标题，其余类型忽略
 * 注意：仅扫描前 SESSION_METADATA_SCAN_LINES 行，messageCount 为近似值（刻意不读全文件以避免大文件开销）
 */
async function parseSessionMetadata(filePath) {
  // 流式只读前 N 行：此前是 readFile 整个文件再 slice(0,50)，而本函数会对目录下
  // 每个 jsonl 各调一次——实测某目录 325 个文件共 2.1GB，一次列表请求就要全读一遍。
  // 改成流式后不再需要 MAX_FILE_SIZE 闸门：读多大的文件都只碰开头那几 KB，
  // 顺带修好了「超过 50MB 的会话直接从列表里消失」的问题。
  const lines = await readFirstLines(filePath, SESSION_METADATA_SCAN_LINES);

  let messageCount = 0;
  let firstUserMessage = '';
  let title = '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);

      if (obj.type === 'user') {
        // 用户消息：计数，并记录首条文本作为回退标题/预览
        messageCount++;
        if (!firstUserMessage) {
          const text = extractText(obj.message?.content);
          if (text) firstUserMessage = text.slice(0, MAX_PREVIEW_LENGTH);
        }
      } else if (obj.type === 'assistant') {
        // 助手消息：计数
        messageCount++;
      } else if (obj.type === 'ai-title' && obj.aiTitle) {
        // AI 生成的会话标题；一个文件里可能出现多次（标题被反复精炼），取扫描窗口内最后一个最准
        title = obj.aiTitle;
      }
      // 其它类型（last-prompt/mode/permission-mode/attachment/file-history-snapshot/
      // queue-operation/system 等）忽略，不计入消息、不作标题
    } catch {
      // 跳过解析失败的行
    }
  }

  // 标题优先用 ai-title，无则回退到首条 user 消息文本
  return { title, messageCount, firstUserMessage };
}

/**
 * 读取单个会话的完整记录
 * @param {string} sessionId
 * @param {string} [cwd] 工作目录（定位对应 project，空=服务目录）
 * @returns {Promise<{ sessionId, messages: Array, messageCount, model, permissionMode }|null>}
 */
export async function getHistorySession(sessionId, cwd = '') {
  // 验证 sessionId 格式（仅允许字母数字、下划线、连字符）
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Invalid sessionId format: ${sessionId}`);
  }

  const dir = getHistoryDir(cwd);
  const filePath = path.join(dir, `${sessionId}.jsonl`);

  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${(stat.size / 1024 / 1024).toFixed(2)}MB, max is 50MB`);
    }

    const content = await fs.promises.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    const messages = [];
    let model = ''; // 最后一条 assistant 消息所用模型
    let permissionMode = ''; // 最后一次询问模式（permission-mode 行）

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        // 刻意不再累积原始 events：它把整份 JSONL 解析成对象数组常驻内存（堆占用通常是文本的
        // 5-10 倍），然后又被 routes-ops 整个 JSON.stringify 回去。40MB 的会话足以让 RSS 飙升，
        // 极端情况直接 RangeError: Invalid string length。而全项目**没有任何消费者**读这个字段。
        // 提取消息流：靠 obj.type 区分 user / assistant，文本由 extractText 从 message.content 提取
        if (obj.type === 'user') {
          const text = extractText(obj.message?.content);
          if (text) {
            messages.push({ role: 'user', content: text, timestamp: obj.timestamp });
          }
        } else if (obj.type === 'assistant') {
          // model 在 push 判断之前采纳：纯 tool_use/thinking 的 assistant 行也带模型信息
          if (typeof obj.message?.model === 'string') model = obj.message.model;
          const text = extractText(obj.message?.content);
          // 跳过只有 thinking/tool_use 而无文本的助手记录，避免大量空气泡
          if (text) {
            messages.push({ role: 'assistant', content: text, timestamp: obj.timestamp });
          }
        } else if (obj.type === 'permission-mode' && typeof obj.permissionMode === 'string') {
          permissionMode = obj.permissionMode;
        }
        // 其它类型忽略，不计入 messages
      } catch {
        // 跳过损坏的 JSON 行
      }
    }

    return { sessionId, messages, messageCount: messages.length, model, permissionMode };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * 搜索会话（按标题/首条消息内容）
 * @param {string} query
 * @param {number} [limit=100] 返回结果数量限制
 * @param {string} [cwd] 工作目录（定位对应 project，空=服务目录）
 * @returns {Promise<Array<{ sessionId, title, ... }>>}
 */
export async function searchHistorySessions(query, limit = 100, cwd = '') {
  if (!query || query.trim().length === 0) {
    return listHistorySessions(limit, 0, cwd); // 空查询返回全列表
  }

  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`Query string too long: ${query.length} characters, max is ${MAX_QUERY_LENGTH}`);
  }

  const all = await listHistorySessions(1000, 0, cwd); // 获取更多结果用于搜索
  const q = query.toLowerCase();

  return all.filter(session =>
    session.title.toLowerCase().includes(q) ||
    session.sessionId.toLowerCase().includes(q)
  ).slice(0, limit);
}

// ============================================================================
// 会话清理（按时间范围物理删除历史 jsonl）—— 设计见
// docs/superpowers/specs/2026-09-04-session-cleanup-design.md
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_PRESETS = new Set([7, 14, 30, 90]); // 快捷选项允许的天数

/**
 * 解析并校验清理时间窗（纯函数，供预览 / 删除共用，便于单测）。
 * 两种互斥口径，range 优先于自定义日期：
 *   - range（快捷）：删除「N 天前就没再动过」的旧会话
 *   - fromDate/toDate（自定义）：删除 mtime 落在 [fromDate 00:00, toDate 23:59:59.999] 闭区间内的会话
 * 自定义日期按本机时区解释（用户填的是日历日，mtime 也是本机文件时间）。
 * @param {{range?:number|string, fromDate?:string, toDate?:string}} [opts]
 * @returns {{range:number}|{fromMs:number|null, toMs:number|null}|null} 无效条件返回 null
 */
export function parseCleanupWindow({ range, fromDate, toDate } = {}) {
  const r = Number(range);
  if (CLEANUP_PRESETS.has(r)) return { range: r };
  // 自定义日期：显式拼时间，避免 'YYYY-MM-DD' 被当成 UTC 零点导致跨时区偏移一天
  const fromMs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null;
  const toMs = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null;
  if (fromMs === null && toMs === null) return null; // 既非预设也无自定义日期
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return null; // 日期串非法
  if (fromMs !== null && toMs !== null && fromMs > toMs) return null; // 起晚于止，无意义
  return { fromMs, toMs };
}

/**
 * 判定会话文件是否落入清理窗（纯函数）。
 * @param {number} mtimeMs 会话文件修改时间
 * @param {number} now 当前时间戳（注入便于测试）
 * @param {{range:number}|{fromMs:number|null, toMs:number|null}} win parseCleanupWindow 的结果
 * @returns {boolean}
 */
export function inCleanupWindow(mtimeMs, now, win) {
  if (!win) return false;
  if (typeof win.range === 'number') return mtimeMs < now - win.range * DAY_MS;
  if (win.fromMs !== null && mtimeMs < win.fromMs) return false;
  if (win.toMs !== null && mtimeMs > win.toMs) return false;
  return true;
}

/**
 * 扫描历史目录，对每个会话 jsonl 取 stat（只 stat 不解析内容，远比 listHistorySessions 轻）。
 * @param {string} [cwd]
 * @returns {Promise<Array<{ sessionId, fullPath, mtimeMs, size }>>} 目录不存在 → []
 */
async function statSessions(cwd = '') {
  const dir = getHistoryDir(cwd);
  let files;
  try {
    files = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
    const fullPath = path.join(dir, file.name);
    try {
      const st = await fs.promises.stat(fullPath);
      out.push({
        sessionId: file.name.replace(/\.jsonl$/, ''),
        fullPath,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    } catch {
      // 扫描与 stat 之间文件被删/占用：跳过，不影响其余
    }
  }
  return out;
}

/**
 * 统计当前目录的会话总数（只数文件，不解析内容）。
 * @param {string} [cwd]
 * @returns {Promise<number>}
 */
export async function countHistorySessions(cwd = '') {
  return (await statSessions(cwd)).length;
}

/**
 * 预计算待删会话（无副作用）。
 * @param {string} [cwd] 工作目录（定位对应 project，空=服务目录）
 * @param {{range?:number, fromDate?:string, toDate?:string}} [opts]
 * @returns {Promise<{ willDeleteCount:number, oldestSession:string|null, newestSession:string|null }>}
 */
export async function previewCleanup(cwd = '', opts = {}) {
  const win = parseCleanupWindow(opts);
  if (!win) return { willDeleteCount: 0, oldestSession: null, newestSession: null };
  const now = Date.now();
  const hit = (await statSessions(cwd)).filter((s) => inCleanupWindow(s.mtimeMs, now, win));
  if (hit.length === 0) return { willDeleteCount: 0, oldestSession: null, newestSession: null };
  let oldest = Infinity;
  let newest = -Infinity;
  for (const s of hit) {
    if (s.mtimeMs < oldest) oldest = s.mtimeMs;
    if (s.mtimeMs > newest) newest = s.mtimeMs;
  }
  return {
    willDeleteCount: hit.length,
    oldestSession: new Date(oldest).toISOString(),
    newestSession: new Date(newest).toISOString(),
  };
}

/**
 * 物理删除命中时间窗的会话文件。幂等（先判存在再删，ENOENT 视为已删）；
 * 单个文件被占用（EPERM/EBUSY）时跳过并继续删其余，最后汇总。
 * @param {string} [cwd]
 * @param {{range?:number, fromDate?:string, toDate?:string, protectedIds?:string[]}} [opts]
 *        protectedIds：不删的 sessionId（如正在运行的 run 对应 session），安全兜底
 * @returns {Promise<{ deletedCount:number, freedBytes:number, skippedCount:number }>}
 */
export async function deleteHistorySessions(cwd = '', opts = {}) {
  const win = parseCleanupWindow(opts);
  if (!win) return { deletedCount: 0, freedBytes: 0, skippedCount: 0 };
  const now = Date.now();
  const protectedIds = new Set(opts.protectedIds || []);
  const hit = (await statSessions(cwd)).filter(
    (s) => inCleanupWindow(s.mtimeMs, now, win) && !protectedIds.has(s.sessionId),
  );
  let deletedCount = 0;
  let freedBytes = 0;
  let skippedCount = 0;
  for (const s of hit) {
    try {
      await fs.promises.unlink(s.fullPath);
      deletedCount++;
      freedBytes += s.size;
    } catch (e) {
      if (e.code === 'ENOENT') continue; // 并发已删：幂等，不计入
      skippedCount++; // 占用/无权限：跳过，保证其余照删
      console.warn(`[history] 删除会话失败（跳过）${s.sessionId}:`, e.message);
    }
  }
  return { deletedCount, freedBytes, skippedCount };
}

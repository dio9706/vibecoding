/**
 * 机器人端业务日志（bot-log.jsonl）—— 前端「访问日志」面板展示的数据源。
 *
 * 为什么独立于 event-log：event-log 的 MAX 是 1000，而 server.js 对每个 HTTP 请求都写一条
 * access，前端 5 秒一轮的轮询几十分钟就能把机器人日志全部挤出上限——放同一个环形缓冲
 * 等于自动删除。
 * 为什么独立于 action-log：那份是审计用途（结构化 vars + maskDeep 脱敏），脱敏逻辑套不到
 * 对话自由文本上，两类日志的字段需求会互相拖累。
 *
 * 条目形状：{ time, botId, botName, userId, userName, kind:'action'|'chat', detail, ok, code }
 * botName/userName 是**写入时快照**：机器人改名或飞书权限回收后，历史记录仍显示当时的名字，
 * 这符合审计语义。
 *
 * 本模块只做存储，不查机器人名、不解析用户姓名（见 shared/bot-activity.js），
 * 以免 store 层反向依赖 integrations/settings。
 */
import fs from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { logger } from '../shared/logger.js';
import { dataPath } from './index.js';
import { readJsonl, compactJsonl } from './jsonl.js';

const FILE = 'bot-log.jsonl';
// 业务审计日志且低频（一天几条到几十条）→ 不设时间窗，按时间删只会白丢历史。
// 条数上限只作为文件无限增长的安全阀。
const MAX = 2000;
const COMPACT_EVERY = Math.floor(MAX / 2);

let _appends = 0;

function compact() {
  compactJsonl(FILE, { max: MAX });
}

/** 追加一条机器人日志。写失败只 warn，绝不影响主流程（埋点在用户消息处理路径上）。 */
export async function appendBotLog(entry) {
  try {
    await appendFile(
      dataPath(FILE),
      JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n',
    );
  } catch (err) {
    logger.warn('bot-log', '写入机器人日志失败', { error: err?.message || String(err) });
  }
  if (++_appends >= COMPACT_EVERY) {
    _appends = 0;
    compact();
  }
}

/** 最新在前，封顶 MAX 条 */
export function getBotLogs() {
  return readJsonl(FILE).reverse().slice(0, MAX);
}

/** 清空全部机器人日志 */
export function clearBotLogs() {
  fs.writeFileSync(dataPath(FILE), '');
}

// 模块加载即压缩一次（跨重启兜底），延后到事件循环空闲，unref 保证不阻止进程退出。
setTimeout(compact, 3000).unref();

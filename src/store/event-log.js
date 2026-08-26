/**
 * 通用事件日志（API 访问 / 任务操作 / 错误等），最新在前，最多 1000 条。
 * 追加写 JSONL（每行一条）：旧版「每条事件全读全写 1000 条 JSON」在每个 API 请求上
 * 都是一次全量磁盘往返，且被 git 追踪导致工作区永远脏。
 * 追加单行远小于 4KB 近似原子，无需文件锁（极端并发下日志丢一行可接受）。
 * 旧 event-log.json 只读兼容合并，不再写入。
 *
 * 读取与压缩下沉到 store/jsonl.js（三个 JSONL store 共用），此处只保留本日志特有的策略：
 * 3 天保留窗口、遗留 JSON 合并、1000 条上限。
 */
import fs from 'node:fs';
import { dataPath, readJson } from './index.js';
import { readJsonl, compactJsonl, withinRetention } from './jsonl.js';

const FILE = 'event-log.jsonl';
const LEGACY = 'event-log.json';
const MAX = 1000;
const RETAIN_MS = 3 * 24 * 60 * 60 * 1000; // 访问日志仅保留最近 3 天
// 每多少次 append 触发一次压缩。必须**小于** MAX：此前写死 2000，而 MAX 是 1000，
// 文件因此常态维持在上限的 2~3 倍。取 MAX/2 后峰值约 1.5×MAX，且压缩频率仍然可接受。
const COMPACT_EVERY = Math.floor(MAX / 2);

let _appends = 0;

export function appendEvent(entry) {
  try {
    fs.appendFileSync(
      dataPath(FILE),
      JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n',
    );
  } catch {
    /* 日志写失败不影响主流程 */
  }
  if (++_appends >= COMPACT_EVERY) {
    _appends = 0;
    compact(); // 常驻进程（pm2）防文件无限增长
  }
}

function compact() {
  compactJsonl(FILE, { max: MAX, retainMs: RETAIN_MS });
}

/** 最新在前；合并旧版 event-log.json（只读遗留），封顶 MAX 条 */
export function getEvents() {
  const now = Date.now();
  const cur = readJsonl(FILE).reverse();
  const legacy = readJson(LEGACY, []); // 旧文件本就最新在前
  return [...cur, ...legacy].filter((e) => withinRetention(e, now, RETAIN_MS)).slice(0, MAX);
}

/** 清空全部访问日志：截空 JSONL，并删除只读遗留 event-log.json，保证清空彻底。 */
export function clearEvents() {
  fs.writeFileSync(dataPath(FILE), '');
  try {
    fs.rmSync(dataPath(LEGACY), { force: true });
  } catch {
    /* 遗留文件删除失败可忽略（时间过滤也会滤除其旧条目） */
  }
}
// 模块加载即压缩一次（跨重启兜底）。**必须延后到事件循环空闲**：
// 直接同步调用会在启动关键路径上做一次全量读+写，明显拖慢冷启动
//（桌面版有 40s 健康检查窗口，web 就绪越早越好）。unref 保证它不阻止进程退出。
setTimeout(compact, 3000).unref();

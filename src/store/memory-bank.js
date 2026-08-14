/**
 * 记忆库持久化 —— memory-bank.json 是偏好条目的唯一真相源。
 * Markdown 与导出包都是它的渲染产物，不反向写回。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'memory-bank.json';

/**
 * 两个扫描游标并存，语义不同，绝不可互相顶替：
 * - `userLogOffset` —— store/user-log.js 的**字节偏移**，默认提炼链路用（埋点采集的用户真实输入）。
 * - `lastScannedAt` —— 会话转录（~/.claude/projects）的 **mtime**，留给历史回填与终端场景
 *   （用户在终端直接敲 claude 时不经过本项目后端，埋点拿不到，只有 JSONL 有记录）。
 * 复用同一个字段会让「4096」既可能是字节数又可能是时间戳，一次误读就把整段历史跳过去。
 */
export const EMPTY_BANK = () => ({
  version: 1, lastScannedAt: 0, userLogOffset: 0, lastExtractAt: 0, items: [], blacklist: [],
});

export function readBank() {
  const raw = readJson(FILE, EMPTY_BANK());
  const b = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    lastScannedAt: Number(b.lastScannedAt) || 0,
    // 旧版文件没有这个字段 → 归 0，从 user-log 开头扫一遍。日志是切数据源后才开始写的，
    // 量小，重扫一遍的代价远小于「漏掉开头那批证据」。
    userLogOffset: Number(b.userLogOffset) || 0,
    lastExtractAt: Number(b.lastExtractAt) || 0,
    items: Array.isArray(b.items) ? b.items : [],
    blacklist: Array.isArray(b.blacklist) ? b.blacklist : [],
  };
}

export function writeBank(bank) {
  return updateJson(FILE, EMPTY_BANK(), () => bank);
}

/** 局部更新一条；找不到则不写盘（updateJson 的 fn 返回 undefined = 放弃） */
export function patchItem(id, patch) {
  return updateJson(FILE, EMPTY_BANK(), (cur) => {
    const items = Array.isArray(cur?.items) ? cur.items : [];
    const i = items.findIndex((it) => it.id === id);
    if (i < 0) return undefined;
    items[i] = { ...items[i], ...patch };
    return { ...cur, items };
  });
}

/** 否掉：移出 items，fingerprint 入黑名单（去重），此后同 fingerprint 的候选一律丢弃 */
export function rejectItem(id, now) {
  return updateJson(FILE, EMPTY_BANK(), (cur) => {
    const items = Array.isArray(cur?.items) ? cur.items : [];
    const blacklist = Array.isArray(cur?.blacklist) ? cur.blacklist : [];
    const i = items.findIndex((it) => it.id === id);
    if (i < 0) return undefined;
    const [gone] = items.splice(i, 1);
    if (gone.fingerprint && !blacklist.some((b) => b.fingerprint === gone.fingerprint)) {
      blacklist.push({ fingerprint: gone.fingerprint, statement: gone.statement || '', rejectedAt: now });
    }
    return { ...cur, items, blacklist };
  });
}

/** 清红点。ids 为 null / 空 → 全部标记已读 */
export function ackItems(ids) {
  const set = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  return updateJson(FILE, EMPTY_BANK(), (cur) => {
    const items = Array.isArray(cur?.items) ? cur.items : [];
    let changed = false;
    const next = items.map((it) => {
      if (it.acked || (set && !set.has(it.id))) return it;
      changed = true;
      return { ...it, acked: true };
    });
    if (!changed) return undefined;
    return { ...cur, items: next };
  });
}

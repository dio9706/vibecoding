/**
 * 存储基座 —— 全项目唯一的持久化入口（见 ARCHITECTURE §3 store）。
 * 现以 JSON 文件落在项目根（与既有 *.json 兼容，不丢数据），
 * 之后可无痛替换为 sqlite：只需改这里的 readJson/writeJson/updateJson。
 *
 * 并发模型：PM2 同时跑 principal-web 与 principal-feishu 两个进程，共享同一批 JSON
 * （settings.json 的 token 池、tasks.json 等双进程都写）。进程内同步 I/O 天然串行；
 * 跨进程的读-改-写必须走 updateJson（<file>.lock 文件锁保护），
 * 落盘一律 tmp+rename 原子替换，防进程中途崩溃留下半截 JSON（settings.json 含全部凭证）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, releaseLock, isLockOwned } from './lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 数据目录：优先 APP_DATA_DIR（打包后由 Tauri 注入的可写目录）；否则回退项目根（开发态）
const DATA_DIR = process.env.APP_DATA_DIR
  ? process.env.APP_DATA_DIR
  : path.join(__dirname, '..', '..');
// 打包首启时该目录可能不存在，确保创建
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  throw new Error(`无法创建数据目录 ${DATA_DIR}: ${e.message}`);
}

/** 数据文件绝对路径（供需要直接 append 的 store 使用，如 event-log 的 JSONL） */
export function dataPath(name) {
  return path.join(DATA_DIR, name);
}

/**
 * 把损坏的文件另存一份供人工恢复。只保留**第一次**损坏的快照 ——
 * 后续每次读都覆盖的话，最有价值的那份原始数据反而会被后来的坏数据顶掉。
 */
function backupCorrupt(file, raw) {
  const bak = file + '.corrupt.bak';
  try {
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, raw);
  } catch {
    /* 备份失败不能掩盖主错误，忽略 */
  }
  return bak;
}

/**
 * 读取并解析。返回 { value }。
 *
 * 关键语义：**只有 ENOENT 才允许退回 fallback**。
 * 此前这里是裸 catch 吞一切异常 → `return fallback`，配合调用方「读出来 normalize 再整份写回」
 * 的模式，造成过实测的数据全损：settings.json 被截断后，一次无关的写入就把
 * token 池 / 飞书 appId+appSecret / bots / mcpServers 全部清零，无报错无备份。
 * 触发面不止断电——Windows 上杀毒/索引服务持句柄造成的 EBUSY/EPERM 同样会走到这里。
 */
function parseFileOrThrow(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback; // 首次启动：文件还没建，正常
    // 其余（EBUSY/EPERM/EMFILE…）都是**暂时性**故障，绝不能当成「没有数据」
    throw new Error(
      `读取 ${path.basename(file)} 失败（${e.code || 'UNKNOWN'}），已拒绝继续以免覆盖数据：${e.message}`,
    );
  }
  // 空文件是断电的常见形态（rename 元数据已落盘、数据块未落），不是「空对象」
  if (!raw.trim()) {
    const bak = backupCorrupt(file, raw);
    throw new Error(`${path.basename(file)} 已损坏（内容为空），原文件已备份到 ${path.basename(bak)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const bak = backupCorrupt(file, raw);
    throw new Error(
      `${path.basename(file)} 已损坏（JSON 解析失败：${e.message}），原文件已备份到 ${path.basename(bak)}`,
    );
  }
}

export function readJson(name, fallback) {
  return parseFileOrThrow(dataPath(name), fallback);
}

/** 同步睡眠（writeFileAtomic 的 rename 重试用） */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 原子写：先写 tmp（含 fsync）再 rename 替换；tmp 名含 pid 防跨进程互踩。
 *
 * 两处与旧版的关键差异：
 *  1. **加 fsync**：只 writeFileSync 不刷盘时，断电可能出现「rename 的元数据已落盘、
 *     tmp 的数据块还没落」→ 目标文件变成 0 字节或垃圾字节，正好触发上面的损坏路径。
 *  2. **删掉 rename 失败后直写的回退分支**：那条路径先截断再写，本身就是非原子的，
 *     中途被杀即留下半截 JSON —— 它恰恰是「凭证被清空」事故的源头。
 *     改为重试若干次；始终失败就抛错，宁可这次写不进去，也不能把好文件写坏。
 */
function writeFileAtomic(file, body) {
  const tmp = file + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e; // Windows 上目标被杀毒/索引服务短暂占用会 EBUSY/EPERM，让一让通常就好
      sleepMs(20);
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  throw new Error(
    `写入 ${path.basename(file)} 失败（${lastErr?.code || 'UNKNOWN'}）：${lastErr?.message || '未知错误'}`,
  );
}

export function writeJson(name, data) {
  writeFileAtomic(dataPath(name), JSON.stringify(data, null, 2));
}

/**
 * 跨进程原子读-改-写：文件锁内执行 fn(cur) 并落盘，返回写入后的数据。
 * fn 返回 undefined 表示放弃写盘（无变更），此时返回读到的当前值。
 * 所有「读出来改一改再写回」的 store 操作都必须走这里，
 * 否则 web / feishu 两个进程会互相覆盖（丢 token 状态、丢任务更新）。
 */
export function updateJson(name, fallback, fn) {
  const file = dataPath(name);
  const lock = file + '.lock';
  const token = acquireLock(lock);
  try {
    // 损坏/读取失败一律抛错并**拒绝写盘**（详见 parseFileOrThrow）。
    // 这里是数据全损事故的关键闸门：绝不能把 fallback 当成「当前值」写回去。
    const cur = parseFileOrThrow(file, fallback);
    const next = fn(cur);
    if (next === undefined) return cur;
    // 写盘前复核锁归属：本进程若在 fn 执行期间被挂起超过陈旧阈值，锁可能已被他人接管，
    // 此时我们读到的 cur 已经过期，继续写就是覆盖别人的更新。宁可失败重来，不可静默丢数据。
    if (!isLockOwned(lock, token)) {
      throw new Error(`写入 ${name} 时发现文件锁已被其他进程接管（本进程可能被长时间挂起），已放弃本次写入`);
    }
    writeFileAtomic(file, JSON.stringify(next, null, 2));
    return next;
  } finally {
    releaseLock(lock, token);
  }
}

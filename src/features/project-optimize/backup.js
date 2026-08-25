/**
 * 快照备份与还原的执行层。
 *
 * 破坏性操作的安全底座，两条底线：
 * 1. 写之前一定先留下快照；
 * 2. 还原时绝不悄悄吞掉用户在优化之后做的手工修改。
 *
 * 第 2 条靠 postHash 机制实现：优化写入完成后由调用方回填「优化后内容哈希」，
 * 还原时拿当前内容哈希跟它比——不一致才说明是用户二次改的。
 * 光比对「当前内容 vs 备份内容」是判不出来的，因为对 modified 的文件，
 * 优化本身就会让两者不同。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildManifest, restoreActionsOf, backupDirName } from './backup.logic.js';

const BACKUP_ROOT = '.claude/optimize-backup';
const KEEP = 5;

/** 文件内容哈希；文件不存在返回 null（null 本身也是一种有效的「优化后状态」） */
function hashFile(abs) {
  try {
    if (!fs.existsSync(abs)) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * 在任何写操作之前调用：把将要改动的文件快照下来。
 * @param {string} projectDir
 * @param {Array<{path:string,action:'deleted'|'modified'|'created'}>} entries 相对路径
 */
export function createBackup(projectDir, entries, { at, dimensions } = {}) {
  const stamp = at || new Date().toISOString();
  const relDir = `${BACKUP_ROOT}/${backupDirName(stamp)}`;
  const absDir = path.join(projectDir, relDir);
  fs.mkdirSync(path.join(absDir, 'files'), { recursive: true });

  const manifest = buildManifest({ at: stamp, dir: projectDir, dimensions, entries });
  // 还没记录优化后状态，还原时据此判断能不能做二次修改检测
  manifest.postRecordedAt = null;

  for (const e of manifest.entries) {
    if (!e.backed) continue;
    const src = path.join(projectDir, e.path);
    // 声称要改但实际不存在的文件：标成未备份，还原时会跳过
    if (!fs.existsSync(src)) { e.backed = false; continue; }
    const dst = path.join(absDir, 'files', e.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  writeManifest(absDir, manifest);
  pruneOld(projectDir);
  return { dir: absDir, relDir, dirName: backupDirName(stamp), manifest };
}

/**
 * 优化写入全部完成后调用：把每个文件此刻的哈希回填进 manifest。
 *
 * 必须在优化写完之后、把控制权交还给用户之前调用。中途失败提前退出也应该调用——
 * 记录的是「实际落盘的状态」，部分完成的状态一样能作为二次修改检测的基准。
 * 不调用不会坏事，只是退化成无条件覆盖（还原时会在 overwritten 里如实告知）。
 *
 * @returns {{dirName:string, recorded:number}}
 */
export function recordPostState(projectDir, dirName) {
  const absDir = path.join(projectDir, BACKUP_ROOT, dirName);
  const manifest = readManifest(absDir);
  if (!manifest) throw new Error('备份不存在');

  let recorded = 0;
  for (const e of manifest.entries || []) {
    e.postHash = hashFile(path.join(projectDir, e.path));
    recorded += 1;
  }
  manifest.postRecordedAt = new Date().toISOString();
  writeManifest(absDir, manifest);
  return { dirName, recorded };
}

/** 保留最近 KEEP 次，其余按时间从旧到新删除（目录名字典序 == 时间序） */
function pruneOld(projectDir) {
  const root = path.join(projectDir, BACKUP_ROOT);
  if (!fs.existsSync(root)) return;
  const dirs = fs.readdirSync(root)
    .filter((n) => { try { return fs.statSync(path.join(root, n)).isDirectory(); } catch { return false; } })
    .sort();
  for (const n of dirs.slice(0, Math.max(0, dirs.length - KEEP))) {
    fs.rmSync(path.join(root, n), { recursive: true, force: true });
  }
}

function readManifest(absDir) {
  const f = path.join(absDir, 'manifest.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function writeManifest(absDir, manifest) {
  fs.writeFileSync(path.join(absDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

export function listBackups(projectDir) {
  const root = path.join(projectDir, BACKUP_ROOT);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((n) => fs.existsSync(path.join(root, n, 'manifest.json')))
    .map((n) => {
      const m = readManifest(path.join(root, n));
      if (!m) return null;
      return {
        at: m.at,
        dirName: n,
        fileCount: (m.entries || []).length,
        dimensions: m.dimensions || [],
        // 前端可以据此提示「这次备份没有二次修改保护」
        postRecorded: Boolean(m.postRecordedAt),
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * 按 manifest 还原。
 *
 * @returns {{restored:number, skipped:Array<{path:string,reason:string}>, overwritten:string[]}}
 *   skipped     — 没动的文件及原因
 *   overwritten — 没做二次修改校验就直接覆盖/删除的文件（manifest 缺 postHash 时的退化路径）
 */
export function restoreBackup(projectDir, dirName) {
  const absDir = path.join(projectDir, BACKUP_ROOT, dirName);
  const manifest = readManifest(absDir);
  if (!manifest) throw new Error('备份不存在');

  const entryByPath = new Map((manifest.entries || []).map((e) => [e.path, e]));
  const canVerify = Boolean(manifest.postRecordedAt);

  let restored = 0;
  const skipped = [];
  const overwritten = [];

  for (const act of restoreActionsOf(manifest)) {
    const target = path.join(projectDir, act.path);
    const entry = entryByPath.get(act.path);
    const targetExists = fs.existsSync(target);
    const verifiable = canVerify && entry && Object.hasOwn(entry, 'postHash');

    if (act.op === 'remove') {
      // 已经不在了就没什么可删的，先判这个——比「被改过」更贴近事实
      if (!targetExists) { skipped.push({ path: act.path, reason: '文件已不存在' }); continue; }
      if (verifiable && hashFile(target) !== entry.postHash) {
        skipped.push({ path: act.path, reason: '优化后又被修改过，跳过以免删掉手工改动' });
        continue;
      }
      if (!verifiable) overwritten.push(act.path);
      fs.rmSync(target, { force: true });
      removeEmptyDir(projectDir, path.dirname(target));
      restored += 1;
      continue;
    }

    // 先排除「压根没东西可还原」的情况，免得误报成覆盖或被改过
    if (entry && entry.backed === false) {
      skipped.push({ path: act.path, reason: '备份时源文件不存在' });
      continue;
    }
    const src = path.join(absDir, 'files', act.path);
    if (!fs.existsSync(src)) { skipped.push({ path: act.path, reason: '备份内容缺失' }); continue; }

    // 二次修改检测：当前内容 != 优化后内容，说明优化之后用户又手工改过，
    // 这时候覆盖会吞掉用户的修改——宁可跳过并告知。
    // 注意不能拿「当前内容 vs 备份内容」来判：对 modified 的文件，
    // 优化本身就会让两者不同，那个差异是正常的。
    if (verifiable && hashFile(target) !== entry.postHash) {
      skipped.push({ path: act.path, reason: '优化后又被修改过，跳过以免覆盖手工改动' });
      continue;
    }
    // 没有 postHash 基准，判不出用户有没有二次改过，只能照做并如实上报
    if (!verifiable && targetExists) overwritten.push(act.path);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(src, target);
    restored += 1;
  }

  return { restored, skipped, overwritten };
}

/** 目录随文件删除而变空就一并删掉，避免留下空壳目录；不越界到 projectDir 之上 */
function removeEmptyDir(projectDir, dir) {
  const root = path.resolve(projectDir);
  const d = path.resolve(dir);
  if (d === root || !d.startsWith(root + path.sep)) return;
  try { if (fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch { /* 删不掉就算了 */ }
}

/**
 * deterministic 策略的执行层：写 .gitignore、从 git 索引移除、删重复条目。
 *
 * 从不抛错（`fix-*` 通用纪律）：一切失败通过返回值的 status 表达。
 *
 * ## 一处必须如实告知用户的局限
 *
 * `git rm --cached` 改的是 **git 索引**，而本功能的备份 / 还原机制只管**文件内容**。
 * 所以「还原」能把 .gitignore 恢复原样，却**不会**把文件重新加回索引——
 * 用户需要自己 `git add <path>`。这不是能顺手补上的：备份层没有「索引快照」这个概念，
 * 加进去要动 backup.js 的 manifest 格式与还原流程。所以这里选择在结果文案里写清楚，
 * 让 fix notes 把它带给用户，而不是留一个用户以为能还原、实际还不了的坑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../../shared/logger.js';
import {
  mergeGitignore, dropDuplicateLines, IGNORE_CODES, HANDLED_CODES,
} from './deterministic.logic.js';

const exec = promisify(execFile);

/** 索引操作的超时。`git rm --cached` 是本地纯索引操作，秒级足够；卡住多半是仓库锁 */
const GIT_TIMEOUT_MS = 20_000;

export { HANDLED_CODES };

/** 本策略会写到哪些文件 —— 供 createBackup 提前打快照（计划先于动作） */
export function planDeterministic(dir, issues) {
  const entries = [];
  const files = new Set();

  if (issues.some((it) => IGNORE_CODES.has(it.code))) {
    const rel = '.gitignore';
    entries.push({ path: rel, action: fs.existsSync(path.join(dir, rel)) ? 'modified' : 'created' });
    files.add(rel);
  }
  for (const it of issues) {
    if (it.code !== 'P4_DUPLICATE') continue;
    if (files.has(it.file)) continue;
    files.add(it.file);
    entries.push({ path: it.file, action: 'modified' });
  }
  return entries;
}

/**
 * 把可忽略的文件加进 .gitignore 并从 git 索引移除。
 *
 * 顺序是刻意的：**先写 .gitignore，再动索引**。反过来的话，如果写 .gitignore 失败，
 * 文件已经脱离索引却又没被忽略，`git status` 会把它显示成「未跟踪」——
 * 用户下一次 `git add .` 就又把它加回来了，等于什么都没做还制造了一次困惑。
 *
 * @returns {Promise<Array>} 逐条结果
 */
async function applyIgnore(dir, issues) {
  const rels = [...new Set(issues.filter((it) => IGNORE_CODES.has(it.code)).map((it) => it.file))];
  if (!rels.length) return [];

  const ignorePath = path.join(dir, '.gitignore');
  let existing = '';
  try { existing = fs.readFileSync(ignorePath, 'utf8'); } catch { /* 没有 .gitignore 是常态 */ }

  const { text, added, alreadyCovered } = mergeGitignore(existing, rels);

  if (added.length) {
    try {
      fs.writeFileSync(ignorePath, text, 'utf8');
    } catch (e) {
      logger.warn('deterministic', '写 .gitignore 失败', { dir, err: e?.message || String(e) });
      return [{ file: '.gitignore', kind: 'ignore', status: 'failed', reason: e?.message || String(e) }];
    }
  }

  const results = [{
    file: '.gitignore',
    kind: 'ignore',
    status: added.length ? 'done' : 'skipped',
    reason: added.length
      ? `新增 ${added.length} 条忽略规则${alreadyCovered.length ? `（另有 ${alreadyCovered.length} 条已被现有规则覆盖）` : ''}`
      : '全部目标已被现有规则覆盖，未改动',
  }];

  // 逐个 untrack。一个失败不影响其它——它们互相独立，
  // 而部分成功比整批放弃有用（用户看到哪几条没成，可以手工补）
  for (const rel of rels) {
    try {
      await exec('git', ['rm', '--cached', '--quiet', '--', rel], {
        cwd: dir, windowsHide: true, timeout: GIT_TIMEOUT_MS,
      });
      results.push({
        file: rel,
        kind: 'untrack',
        status: 'done',
        reason: '已从 git 索引移除（文件仍在磁盘上）；「还原」不会把它加回索引，需要时请手工 git add',
      });
    } catch (e) {
      // 已经不在索引里时 git 会报错，这不算失败——目标状态已经达成
      const msg = String(e?.stderr || e?.message || e);
      const already = /did not match any files|pathspec/i.test(msg);
      results.push({
        file: rel,
        kind: 'untrack',
        status: already ? 'skipped' : 'failed',
        reason: already ? '本来就不在 git 索引里' : msg.slice(0, 200),
      });
    }
  }

  return results;
}

/** 删重复条目。逐文件处理，同一文件的多组重复合在一次读写里完成 */
function applyDedupe(dir, issues) {
  const byFile = new Map();
  for (const it of issues) {
    if (it.code !== 'P4_DUPLICATE') continue;
    if (!byFile.has(it.file)) byFile.set(it.file, []);
    byFile.get(it.file).push(it);
  }

  const results = [];
  for (const [rel, list] of byFile) {
    const full = path.join(dir, rel);
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch (e) {
      results.push({ file: rel, kind: 'dedupe', status: 'failed', reason: `读取失败：${e?.message || e}` });
      continue;
    }

    // 一个文件里的多组重复必须**按行号从大到小依次处理**：
    // 处理完一组会让后面的行号前移，从小到大做第二组就删错行了
    const sorted = [...list].sort((a, b) => (b.meta?.lines?.[0] || b.line) - (a.meta?.lines?.[0] || a.line));
    let removedTotal = 0;
    let mismatchedTotal = 0;

    for (const it of sorted) {
      const lines = Array.isArray(it.meta?.lines) ? it.meta.lines : [];
      if (lines.length < 2) continue;
      const r = dropDuplicateLines(text, lines, it.meta?.text || '');
      text = r.text;
      removedTotal += r.removed.length;
      mismatchedTotal += r.mismatched.length;
    }

    if (!removedTotal) {
      results.push({
        file: rel,
        kind: 'dedupe',
        status: 'skipped',
        reason: mismatchedTotal
          ? `${mismatchedTotal} 处行号与当前内容对不上（文件在上次体检后被改过），未改动`
          : '没有可删除的重复条目',
      });
      continue;
    }

    try {
      fs.writeFileSync(full, text, 'utf8');
      results.push({
        file: rel,
        kind: 'dedupe',
        status: 'done',
        reason: `删除 ${removedTotal} 处重复条目（保留第一处）`
          + (mismatchedTotal ? `；另有 ${mismatchedTotal} 处行号对不上已跳过` : ''),
      });
    } catch (e) {
      results.push({ file: rel, kind: 'dedupe', status: 'failed', reason: `写入失败：${e?.message || e}` });
    }
  }

  return results;
}

/**
 * 执行确定性修复。
 *
 * @param {string} dir
 * @param {Array} issues 已由调用方筛成本策略认领的那些
 * @returns {Promise<Array<{file, kind, status, reason}>>}
 */
export async function runDeterministic(dir, issues) {
  const mine = issues.filter((it) => HANDLED_CODES.has(it.code));
  if (!mine.length) return [];
  return [...(await applyIgnore(dir, mine)), ...applyDedupe(dir, mine)];
}

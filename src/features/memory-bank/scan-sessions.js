import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/**
 * 纯函数。判定是否应重新分析会话文件。
 * @param {{mtime:number, analyzedAt?:number}} session 已记录的会话信息
 * @param {number} now 当前时间戳（ms）
 * @returns {boolean}
 */
export function shouldReanalyzePath(session, now) {
  if (!session || !session.mtime) return false;
  // 从未分析过
  if (!session.analyzedAt || session.analyzedAt === 0) return true;
  // 文件修改时间比最后分析时间更新
  return session.mtime > session.analyzedAt;
}

/**
 * 扫描 ~/.claude/projects 下所有 .jsonl 文件，返回未分析或需重新分析的。
 * @param {object} bank readBank() 的返回值（含 sessions[]）
 * @returns {Array<{path:string, mtime:number}>}
 */
export function scanForUnanalyzedSessions(bank) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(projectsDir)) {
    return [];
  }

  const now = Date.now();
  const unanalyzed = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 权限问题等，跳过
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.jsonl')) {
        let mtime;
        try {
          mtime = fs.statSync(fullPath).mtimeMs;
        } catch {
          continue; // 文件已删除，跳过
        }

        // 检查是否已分析且文件未变更
        const existing = (bank.sessions || []).find(
          (s) => s.path === fullPath && !shouldReanalyzePath({ mtime, analyzedAt: s.analyzedAt }, now)
        );

        if (!existing) {
          unanalyzed.push({ path: fullPath, mtime });
        }
      }
    }
  }

  walk(projectsDir);
  return unanalyzed;
}

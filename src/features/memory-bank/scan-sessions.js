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
 * `analyzing` 状态的过期阈值。单次会话分析走 runClassifierOnce（30s 预算），
 * 一小时足够宽裕到不会误判「正在跑的那一条」。
 */
export const ANALYZING_STALE_MS = 60 * 60 * 1000;

/**
 * 纯函数。判定一条 `analyzing` 记录是否已经陈旧（可以重新分析）。
 *
 * 为什么需要它：扫描会无条件跳过 `analyzing` 的会话，好让同一条不被两轮同时处理。
 * 但这个状态是**进程内**的活性标记，落在磁盘上却没人负责清 —— 桌面版关窗、进程被杀、
 * 机器休眠，都会把某条会话永久钉在 `analyzing`，此后每一轮扫描都跳过它，静默漏掉。
 * 实测生产库里就卡着这么一条。
 *
 * @param {{status?:string, analyzingAt?:number}} session
 * @param {number} now
 * @returns {boolean}
 */
export function isStaleAnalyzing(session, now) {
  if (!session || session.status !== 'analyzing') return false;
  // 缺 analyzingAt：本次改动之前写下的存量记录，判不出起始时刻。宁可重分析一次（幂等、
  // 代价是一次 LLM 调用），也不能让它永远躺在那儿不被处理。
  return now - (Number(session.analyzingAt) || 0) > ANALYZING_STALE_MS;
}

/**
 * 纯函数。判定一个路径是否属于**子代理转录**（`.../subagents/agent-*.jsonl`，也可能再嵌一层
 * `subagents/workflows/wf_xxx/`）。目录路径同样适用，扫描时据此整棵剪枝。
 *
 * 为什么必须排除（2026-09-18 实测）：生产库 1530 条会话索引里 1082 条（71%）是子代理转录。
 * 记忆库提炼的是**用户偏好**，而子代理的 prompt 由主代理生成、对话里根本没有用户的话 ——
 * 这 71% 既产不出有效偏好，又实打实吃掉 71% 的分析耗时与额度（单次约 70s / $0.04），
 * 还会把「子代理在执行什么任务」这类无长期价值的条目稀释进合成结果。
 *
 * 判据是**完整路径段**而非子串：`my-subagents-backup/` 这类名字不该被误伤。
 *
 * @param {string} p 文件或目录的完整路径
 * @returns {boolean}
 */
export function isSubagentTranscript(p) {
  return /(^|[\\/])subagents([\\/]|$)/.test(String(p || ''));
}

/**
 * 扫描 ~/.claude/projects 下所有 .jsonl 文件，返回未分析或需重新分析的。
 * @param {object} bank readBank() 的返回值（含 sessions[]）
 * @returns {Array<{path:string, mtime:number}>}
 */
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export function scanForUnanalyzedSessions(bank) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  if (!fs.existsSync(projectsDir)) {
    return [];
  }

  const now = Date.now();
  const cutoff = now - MONTH_MS; // 只处理近 30 天的会话
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
        // 整棵剪枝：子代理转录目录连同其中嵌套的 workflows 一并跳过，不进递归
        if (isSubagentTranscript(fullPath)) continue;
        walk(fullPath);
      } else if (entry.name.endsWith('.jsonl')) {
        let mtime;
        try {
          mtime = fs.statSync(fullPath).mtimeMs;
        } catch {
          continue; // 文件已删除，跳过
        }

        // 只处理近 30 天内有活动的会话
        if (mtime < cutoff) continue;

        // 跳过正在分析中或已分析且未变更的；`analyzing` 陈旧了（进程中途被杀）则放行重试
        const existing = (bank.sessions || []).find((s) => s.path === fullPath);
        if (existing && existing.status === 'analyzing' && !isStaleAnalyzing(existing, now)) continue;
        if (existing && existing.status !== 'analyzing'
            && !shouldReanalyzePath({ mtime, analyzedAt: existing.analyzedAt }, now)) continue;

        unanalyzed.push({ path: fullPath, mtime });
      }
    }
  }

  walk(projectsDir);
  return unanalyzed;
}

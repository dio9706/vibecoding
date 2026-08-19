/**
 * 埋点索引快照的加载与缓存。
 *
 * 进程内缓存一份：约 1200 个条目、百来 KB，每条消息都读盘没必要。
 * 快照更新后需重启机器人生效 —— 可接受，因为同步本身就是个手工动作。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../shared/logger.js';
import { indexDict } from './logic.js';

/** 超过这个天数未同步就告警：新埋点查不到时，日志里要有线索 */
const STALE_DAYS = 30;

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let cached = null;

/**
 * 快照文件路径（项目根 data/event-dict.json）。
 *
 * 优先按模块自身位置反推仓库根，cwd 只作兜底：config.js 的 scriptsDirFor 已经踩过这个坑
 * （「打包后 cwd=AppData 会找不到脚本」）。两者在 `npm start` 场景下同值，
 * 但由别处拉起进程时 cwd 是什么完全不由我们决定。
 */
function dictPath() {
  const byModule = path.join(REPO_ROOT, 'data', 'event-dict.json');
  if (fs.existsSync(byModule)) return byModule;
  return path.join(process.cwd(), 'data', 'event-dict.json');
}

/**
 * 读取并索引快照。文件缺失或损坏时返回 null（调用方回告用户去跑同步脚本），
 * 不抛错 —— 索引问题不该表现为一个没头没尾的堆栈。
 * @returns {ReturnType<typeof indexDict>|null}
 */
export function loadDict() {
  if (cached) return cached;
  const p = dictPath();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(raw?.events) || !Array.isArray(raw?.pages)) {
      // 结构不对多半是快照还是旧版的 Record<name,label> 形态，提示重新同步而不是硬塞
      logger.error('tracking-stats', '索引快照结构不符（events/pages 应为数组），请重新同步', { path: p });
      return null;
    }

    const dict = indexDict(raw);
    const live = dict.events.filter((e) => e.live).length;
    const named = dict.events.filter((e) => e.live && e.named).length;

    const ageDays = (Date.now() - new Date(raw.syncedAt).getTime()) / 86400000;
    if (Number.isFinite(ageDays) && ageDays > STALE_DAYS) {
      logger.warn('tracking-stats', '索引快照已过期，新埋点可能查不到', {
        syncedAt: raw.syncedAt,
        ageDays: Math.round(ageDays),
        hint: 'node scripts/sync-event-dict.mjs <compass-agent 目录>',
      });
    }

    cached = dict;
    logger.info('tracking-stats', '埋点索引已加载', {
      liveEvents: live,
      // namedRate 是「字典维护缺口」的度量，值得每次启动都打出来：
      // 它若突然逼近 100%，多半是双源合并写反了（只剩字典单源），而不是同事们突然勤快了
      namedRate: live ? `${Math.round((named / live) * 100)}%` : 'n/a',
      livePages: dict.pages.filter((p) => p.live).length,
      total: dict.events.length,
      syncedAt: raw.syncedAt,
    });
    return cached;
  } catch (e) {
    logger.error('tracking-stats', '索引快照读取失败', { path: p, err: e?.message || String(e) });
    return null;
  }
}

/** 测试用：清空缓存 */
export function resetDictCache() {
  cached = null;
}

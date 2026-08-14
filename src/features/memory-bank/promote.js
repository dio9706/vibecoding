/**
 * 记忆库状态机 —— 候选合并、证据累计、晋升、冲突、失效。
 * 纯函数：无 IO、无 Date.now、无 random。时间与 id 生成由调用方注入（now / makeId），便于单测。
 *
 * 核心不变量：晋升要求「evidenceCount 达标 **且** 跨 >=2 个不同 session」。
 * 只数 evidenceCount 会把「一次会话里连说三遍」误判成三份独立证据。
 */

export const DEFAULT_THRESHOLD = { minEvidence: 3, minSessions: 2 };
export const MAX_EVIDENCE = 5;
export const DEFAULT_DORMANT_DAYS = 90;

/** 注入组：这三类渲染进 CLAUDE.md；dialogue / tech-pref 仅记录 */
const INJECT_CATEGORIES = new Set(['code-style', 'collaboration', 'writing']);

const DAY_MS = 86400000;

function makeEvidence(c) {
  return { sessionId: c.sessionId || '', at: c.at || '', quote: c.quote || '', kind: c.kind || 'correction' };
}

/** 够格晋升？显式偏好走例外通道：用户直说的规矩不该等三次 */
function shouldPromote(item, threshold) {
  if (item.source === 'explicit') return item.evidenceCount >= 1;
  return item.evidenceCount >= threshold.minEvidence
    && item.evidenceSessions.length >= threshold.minSessions;
}

function newItem(c, id, now) {
  return {
    id,
    category: c.category,
    scope: c.scope === 'project' ? 'project' : 'global',
    projectDir: c.scope === 'project' ? c.projectDir || '' : '',
    statement: c.statement,
    fingerprint: c.fingerprint,
    status: 'candidate',
    inject: INJECT_CATEGORIES.has(c.category),
    source: c.source === 'explicit' ? 'explicit' : 'inferred',
    evidenceCount: 1,
    evidenceSessions: c.sessionId ? [c.sessionId] : [],
    evidence: [makeEvidence(c)],
    promotedBy: null,
    acked: true,
    conflictWith: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
}

/**
 * 合并一批候选进现有状态。
 * @param {{items:Array, blacklist:Array}} state
 * @param {Array} candidates 含 fingerprint / statement / category / sessionId / quote / source / contradicts?
 * @param {{now:number, makeId:function, threshold?:object}} ctx
 * @returns {{items:Array, blacklist:Array, promoted:string[]}} promoted = 本轮自动晋升的 id
 */
export function mergeCandidates(state, candidates, { now, makeId, threshold = DEFAULT_THRESHOLD }) {
  const items = (state?.items || []).map((it) => ({ ...it }));
  const blacklist = (state?.blacklist || []).slice();
  const banned = new Set(blacklist.map((b) => b.fingerprint));
  const promoted = [];

  for (const c of candidates || []) {
    if (!c?.fingerprint || !c?.statement || !c?.category) continue;
    if (banned.has(c.fingerprint)) continue; // 用户否过的，永不复活

    const idx = items.findIndex((it) => it.fingerprint === c.fingerprint && it.status !== 'conflict');
    if (idx < 0) {
      const fresh = newItem(c, makeId(), now);
      if (shouldPromote(fresh, threshold)) {
        fresh.status = 'active';
        fresh.promotedBy = 'auto';
        fresh.acked = false;
        promoted.push(fresh.id);
      }
      items.push(fresh);
      continue;
    }

    const it = items[idx];

    // 冲突：与已生效条目对立 —— 不覆盖，两边停注入交用户裁决
    if (it.status === 'active' && c.contradicts && c.statement.trim() !== it.statement.trim()) {
      const rival = newItem(c, makeId(), now);
      rival.status = 'conflict';
      rival.conflictWith = it.id;
      rival.acked = false;
      it.status = 'conflict';
      it.conflictWith = rival.id;
      it.acked = false;
      it.updatedAt = now;
      items.push(rival);
      continue;
    }

    // 常规累计。statement 不覆盖：用户可能已手工编辑过
    it.evidenceCount += 1;
    // 重新赋值而非 .push()：浅拷贝只新建了 item 对象本身，evidenceSessions 仍是调用方传入的原数组引用，
    // 原地 push 会污染调用方手里的旧 state —— 与 evidence 字段的处理方式（concat 重新赋值）保持一致
    if (c.sessionId && !it.evidenceSessions.includes(c.sessionId)) {
      it.evidenceSessions = it.evidenceSessions.concat(c.sessionId);
    }
    it.evidence = it.evidence.concat(makeEvidence(c)).slice(-MAX_EVIDENCE);
    if (c.source === 'explicit') it.source = 'explicit';
    it.lastSeenAt = now;
    it.updatedAt = now;

    if ((it.status === 'candidate' || it.status === 'dormant') && shouldPromote(it, threshold)) {
      it.status = 'active';
      it.promotedBy = it.promotedBy || 'auto';
      it.acked = false;
      promoted.push(it.id);
    }
  }

  return { items, blacklist, promoted };
}

/** 超期无新证据 → dormant：停注入但保留全部数据（导出与数字分身仍需要） */
export function applyDormancy(items, { now, dormantDays = DEFAULT_DORMANT_DAYS }) {
  const limit = dormantDays * DAY_MS;
  return (items || []).map((it) =>
    it.status === 'active' && now - (it.lastSeenAt || 0) > limit ? { ...it, status: 'dormant' } : it,
  );
}

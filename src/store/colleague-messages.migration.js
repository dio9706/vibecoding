/**
 * `colleague-messages.json` 锚点迁移（破坏性，一次性）。
 *
 *   旧：{ "<reqId>": { "<colleagueId>": { messages, lastInboundAt } }, _pending: {...} }
 *   新：{ "<colleagueId>": { agentSessionId, messages: [...每条带 reqId...], lastInboundAt } }
 *
 * 为什么要换锚点：2.0 的对话锚在**人**身上（一个同事一条长期 thread，靠 SDK session 续跑），
 * 需求归属降级成每条消息上的 `reqId` 标签，由 agent 自己判定。旧结构按需求分组，
 * 同一个人在三个需求里就有三条互不相通的对话线，agent 没法「记得他上周说过什么」。
 *
 * **纯函数**（参照 `bots-migration.js`）：不碰文件系统，调用方在 `updateJson` 的锁内调它。
 * 幂等靠「新形状原样返回」而非标记位 —— 标记位会在用户手工编辑过 JSON 后骗过自己。
 */

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** 待归属缓冲的旧命名空间。迁移时整节丢弃 */
const PENDING_KEY = '_pending';

/**
 * 顶层键看起来是 reqId 吗。
 *
 * 判据是 `r_` 前缀 + 值是「{colleagueId: thread}」形状，**不看有没有 `_pending`** ——
 * 缓冲经常是空的，拿它当判据会让有真实旧数据的库被判成「已迁移」而静默跳过。
 */
export function isLegacyShape(raw) {
  if (!isPlainObject(raw)) return false;
  for (const [k, v] of Object.entries(raw)) {
    if (k === PENDING_KEY) continue;
    if (!isPlainObject(v)) continue;
    // 新结构的值自带 messages 数组；旧结构的值是「一层 colleagueId → thread」
    if (Array.isArray(v.messages)) continue;
    if (k.startsWith('r_')) return true;
  }
  return false;
}

/** 取一条线程里最晚的 lastInboundAt（两边都可能缺） */
function laterOf(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

function emptyThread() {
  return { agentSessionId: null, messages: [], lastInboundAt: null };
}

/**
 * 数一下 `_pending` 里攒了多少条消息，供调用方打日志留痕。
 *
 * 两条分支（已是新形状 / legacy）都会剥掉 `_pending`，计数逻辑抽到这一处共用 ——
 * 曾经两边各写一遍，其中一边（新形状分支）恒为 0，是这次审查抓出的 bug 根源。
 */
function countPendingMessages(pending) {
  if (!isPlainObject(pending)) return 0;
  let n = 0;
  for (const v of Object.values(pending)) n += Array.isArray(v?.messages) ? v.messages.length : 0;
  return n;
}

/**
 * @param {object} raw 盘上原值
 * @returns {{data: object, droppedPending: number}} data 的字段本身不做裁剪（含未知字段原样保留），
 *   但 `_pending` 无论输入是新是旧都会被剥掉 —— 它是旧命名空间的残留，不属于新形状；
 *   droppedPending 是被丢弃的 `_pending` 条数，供调用方留痕，两条分支都必须如实报告
 */
export function migrateColleagueMessagesDetailed(raw) {
  if (!isPlainObject(raw)) return { data: {}, droppedPending: 0 };
  if (!isLegacyShape(raw)) {
    // 已是新形状：字段整体原样返回。刻意不 normalize —— 那是 store 读路径的职责，
    // 迁移只管换形状，多做一步就多一个「迁移把字段洗没了」的风险面。
    // 但 `_pending` 是例外：它是旧命名空间的残留，就算数据整体已迁移过，
    // 它也可能还没清空（比如迁移中途重启），必须剥掉且如实计数
    const { [PENDING_KEY]: pending, ...rest } = raw;
    return { data: rest, droppedPending: countPendingMessages(pending) };
  }

  const out = {};
  /** 先把已经是新形状的人原样收下（混合结构） */
  for (const [k, v] of Object.entries(raw)) {
    if (k === PENDING_KEY || !isPlainObject(v)) continue;
    if (Array.isArray(v.messages)) out[k] = { ...emptyThread(), ...v, messages: [...v.messages] };
  }

  let dropped = 0;
  for (const [reqId, byColleague] of Object.entries(raw)) {
    if (reqId === PENDING_KEY) {
      // 未归属且选择卡已下线，补不回来。数一下条数留给日志，别静默
      dropped += countPendingMessages(byColleague);
      continue;
    }
    if (!isPlainObject(byColleague) || Array.isArray(byColleague.messages)) continue; // 后者是已迁移的人，上面收过了

    for (const [colleagueId, thread] of Object.entries(byColleague)) {
      if (!isPlainObject(thread)) continue;
      const cur = out[colleagueId] || emptyThread();
      const msgs = Array.isArray(thread.messages) ? thread.messages : [];
      // reqId 从「分组键」降级成「消息标签」——这是整个迁移的核心动作
      for (const m of msgs) if (isPlainObject(m)) cur.messages.push({ ...m, reqId });
      cur.lastInboundAt = laterOf(cur.lastInboundAt, thread.lastInboundAt);
      out[colleagueId] = cur;
    }
  }

  // 合并多个需求的消息后顺序会乱，必须按时间重排：对话读起来的顺序就是它的全部意义。
  // 缺 `at` 的消息排到最后而非最前——空串当排序键会把「没记录时间」伪装成「最早」，
  // 篡改出根本不存在的先后关系；排最后至少不影响其余有时间戳消息之间的真实顺序
  for (const t of Object.values(out)) {
    t.messages.sort((a, b) => {
      if (!a.at && !b.at) return 0;
      if (!a.at) return 1;
      if (!b.at) return -1;
      return String(a.at).localeCompare(String(b.at));
    });
  }

  // 丢弃计数**绝不塞进 out**：out 会被整份写回盘，多一个内部字段就是永久污染。
  // 走第二返回值，由调用方按自己的上下文打日志（迁移是纯函数，不 import logger）。
  return { data: out, droppedPending: dropped };
}

/** 薄包装：绝大多数调用方只要数据 */
export function migrateColleagueMessages(raw) {
  return migrateColleagueMessagesDetailed(raw).data;
}

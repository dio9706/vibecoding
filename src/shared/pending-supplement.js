/**
 * 「等待补充内容」瞬态 —— 点了卡片上的「补充内容/补充」后，等用户下一条消息。
 *
 * 为什么可以是内存态：卡片本身无状态（按钮 value 自带 convId/taskId，重启后仍有效），
 * 这里只存「现在在等谁的下一句话、拿到后干什么」。进程重启丢失的后果由两条路兜住：
 * 会话域有文本兜底（「补充内容 xxx」），任务域重新点一次按钮即可。
 *
 * 为什么放内核（shared/）而不是插件里：会话域（feishu-relay）与任务域（team-tools）
 * 都要用它，插件之间禁止互相 import（同 card-actions.js 的处置）。
 * 执行器以闭包（onText）由 arm 的一方提供 → 消费方对 convs/tasks 一无所知。
 */
const pending = new Map(); // openId -> { openId, label, onText, expiresAt }

export const SUPPLEMENT_TTL_MS = 10 * 60 * 1000;

/** 文本兜底前缀：沿用 intent-keywords 的纪律 —— 只匹配开头、正则不加 g */
const SUPPLEMENT_RE = /^[\s\p{P}\p{S}]*补充内容[\s:：,，、\-—]*/u;

/**
 * 「补充内容 xxx」→ 返回正文；不命中返回 null。
 * 只发前缀不带正文**不命中**：那种情况该走「点卡片按钮」的等待态，
 * 硬当成补充会把一句空话注入会话白烧一轮额度。
 *
 * 为什么与等待态同住内核：两个域（会话 feishu-relay / 任务 team-tools）都要在拿到
 * 用户那句话之后剥前缀 —— 用户点了按钮进等待态后仍常习惯性再写一遍「补充内容」，
 * 不剥就会把这四个字当正文写进 fixNote/注入进会话。插件之间禁止互相 import，故上移。
 */
export function matchSupplementText(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s.trim()) return null;
  const m = SUPPLEMENT_RE.exec(s);
  if (!m || m.index !== 0) return null;
  const body = s.slice(m[0].length).trim();
  return body || null;
}

/** 登记等待态；同一 openId 单槽，后来者覆盖（用户连点两张卡片时以最后一次为准） */
export function armSupplement(openId, { label, onText, ttlMs = SUPPLEMENT_TTL_MS }) {
  if (!openId || typeof onText !== 'function') return null;
  const entry = { openId, label: label || '', onText, expiresAt: Date.now() + ttlMs };
  pending.set(openId, entry);
  return entry;
}

/** 只看不取（dispatch 的 hasPending 用）；过期顺手清理 */
export function peekSupplement(openId) {
  const e = pending.get(openId);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) {
    pending.delete(openId);
    return null;
  }
  return e;
}

/** 取走并清空（handle 用）：必须一次性，否则用户下一句闲聊会被再次当成补充内容 */
export function takeSupplement(openId) {
  const e = peekSupplement(openId);
  if (e) pending.delete(openId);
  return e;
}

export function clearSupplement(openId) {
  pending.delete(openId);
}

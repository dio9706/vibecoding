/**
 * 记忆库预筛器 —— 把 store/user-log.js 的用户输入条目组织成提炼输入。纯函数、零 IO、零 LLM。
 *
 * 与上一版（扫 JSONL 转录 + 正则捞纠正片段，见 prefilter-transcript.js）的根本差别有两条：
 *
 * 1. **数据源已纯净**，不必再猜「这句是不是人打的」。埋点只记发送框里的东西，
 *    没有 skill 注入、没有 <system-reminder>、没有工具结果。
 * 2. **信号模型换了**。旧假设是「偏好只在用户纠正 AI 时暴露」，被真实数据证伪：
 *    用户实际是决断式表达 —— 「让 AI 越用越懂我，并且可以导出」「B. 人工确认 + C」
 *    「仅在额度重置前 30 分钟跑」全是高价值偏好，却一句纠正措辞都不带，旧正则一条都捞不到。
 *    加词表救不了，问题在模型本身。
 *
 * 所以这里**不再做去留判断**：用户真人发言总量本就极小（实测 20 个会话约 5000 字符 ≈ 3000 token），
 * 全量喂 LLM 由它判断。正则退化为「高置信度标记」——
 * 命中显式规矩措辞的标 explicit（下游 promote.js 单条证据即晋升），未命中的走常规阈值。
 */

/** 显式偏好声明：用户直接下规矩，几乎不会误判 → 下游单条证据即可晋升。
 *  词表刻意保守：误标一条 explicit 就等于跳过「3 条证据跨 2 个会话」的全部把关，
 *  一条错规则会被注入进此后每一次对话。宁可漏标，让它走常规阈值。 */
export const EXPLICIT_RE = /记住|以后|每次|下次|不许|一律|统一用|都要|别再|不要再|从现在起|今后/;

/** 预算上限。用户发言量本就小，这些数字是**兜底**而非常态约束 ——
 *  真正要防的是「用户某次往输入框里粘了一整份日志」，那种情形先被 maxEntryChars 削平。 */
export const DEFAULT_LIMITS = {
  maxEntries: 120,
  maxChars: 20000,
  maxEntryChars: 1200,
};

/** 无会话标识的条目落到这个组。不能用空串：promote.js 的 evidenceSessions 会跳过假值，
 *  跨会话计数会把这些证据整条丢掉，条目永远晋升不了。 */
const UNKNOWN_SESSION = '(未标记会话)';

/** 归位匹配的最短 quote 长度（去空白后）。太短的片段（「以后」「好的」）在任何一段话里都找得到，
 *  认错会话比不认更糟 —— 证据会记到别的会话头上，凑出根本不存在的「跨会话」。 */
const MIN_ATTRIBUTE_CHARS = 4;

/** 是否命中显式下规矩的措辞 */
export function hasExplicitPhrasing(text) {
  return EXPLICIT_RE.test(String(text || ''));
}

/** 挑选优先级（越小越先留）：显式规矩 > 插话打断 > 普通发送。
 *  插话排在普通发送之前，是因为用户中途叫停说明 AI 走偏了，紧跟着那句通常直指真实要求。 */
function priority(t) {
  if (t.explicit) return 0;
  if (t.kind === 'steer') return 1;
  return 2;
}

/**
 * user-log 条目 → 按会话分组的提炼输入。
 *
 * @param {Array<object>} entries store/user-log.js 的 readUserLog().entries（按时间升序）
 * @param {{maxEntries?:number, maxChars?:number, maxEntryChars?:number}} [opts]
 * @returns {{
 *   sessions: Array<{id:string, cwd:string, turns:Array<{at:number, kind:string, explicit:boolean, text:string, truncated:boolean}>}>,
 *   used:number, dropped:number, chars:number
 * }}
 *   `dropped` 只统计「本该喂给 LLM、却因预算被挤掉」的条数 —— 空白行、非字符串这类根本不是
 *   用户发言的东西不计入，否则告警会天天喊狼来了。调用方必须把 dropped>0 记进日志：
 *   游标是按字节推进的，被挤掉的条目下一轮不会再读到，静默丢等于永久丢证据。
 */
export function buildExtractionInput(entries, opts = {}) {
  const { maxEntries, maxChars, maxEntryChars } = { ...DEFAULT_LIMITS, ...opts };
  const list = Array.isArray(entries) ? entries : [];

  // 第一遍：清洗 + 截断 + 打标。不改原对象（提炼算法要能拿老数据反复重跑，原始层必须无损）
  const turns = [];
  for (const raw of list) {
    const text = typeof raw?.text === 'string' ? raw.text.trim() : '';
    if (!text) continue;
    const clipped = text.length > maxEntryChars ? text.slice(0, maxEntryChars) : text;
    turns.push({
      key: String(raw.convId || raw.sessionId || UNKNOWN_SESSION),
      cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
      at: Number.isFinite(raw.at) ? raw.at : 0,
      kind: raw.kind === 'steer' ? 'steer' : 'send',
      explicit: hasExplicitPhrasing(clipped),
      text: clipped,
      truncated: clipped.length < text.length,
      seq: turns.length, // 记住原始次序，挑完还要还原成时间顺序
    });
  }

  // 第二遍：按优先级挑选到预算内。此处用 continue 而非 break —— 一条超长的挤不进去时，
  // 后面短的仍应尽量填满预算，白留空档等于白丢证据。
  const order = turns.map((t, i) => i).sort((a, b) => priority(turns[a]) - priority(turns[b]) || a - b);
  const picked = new Set();
  let chars = 0;
  for (const i of order) {
    if (picked.size >= maxEntries) break;
    const cost = turns[i].text.length;
    if (chars + cost > maxChars) continue;
    picked.add(i);
    chars += cost;
  }

  // 第三遍：还原时间顺序后分组。优先级只用于「挑谁」，绝不能把对话顺序打乱 ——
  // 分组的全部意义就是让 LLM 看到同一次对话里的连续表达。
  const byKey = new Map();
  for (const t of turns) {
    if (!picked.has(t.seq)) continue;
    let s = byKey.get(t.key);
    if (!s) {
      s = { id: t.key, cwd: '', turns: [] };
      byKey.set(t.key, s);
    }
    if (t.cwd) s.cwd = t.cwd; // 取最后一条非空：会话中途换目录时以最新的为准
    s.turns.push({ at: t.at, kind: t.kind, explicit: t.explicit, text: t.text, truncated: t.truncated });
  }

  return {
    sessions: [...byKey.values()],
    used: picked.size,
    dropped: turns.length - picked.size,
    chars,
  };
}

/** 去空白后比对：LLM 回吐 quote 时常吞掉换行与多余空格，逐字比对会大面积失配 */
function squash(s) {
  return String(s || '').replace(/\s+/g, '');
}

/**
 * 把 LLM 回吐的 quote 归位到它出自的那次会话。
 *
 * 为什么需要：一次提炼跨多个会话，而 promote.js 的核心不变量是「跨 >=2 个不同 session」。
 * 若整批候选共用一个 sessionId，用户在同一天两次独立对话里说的同一条偏好会被算成一次证据，
 * 永远晋升不了。这里借 EXTRACT_SYSTEM_PROMPT 已有的硬约束（quote 必须逐字来自输入）反查归属，
 * 比再让模型多吐一个「会话编号」字段可靠 —— 那种字段模型说错了没法验。
 *
 * @returns {{sessionId:string, cwd:string, explicit:boolean, kind:string}|null} 对不上返回 null
 */
export function attributeTurn(quote, sessions) {
  const q = squash(quote);
  if (q.length < MIN_ATTRIBUTE_CHARS) return null;
  for (const s of sessions || []) {
    for (const t of s?.turns || []) {
      if (squash(t.text).includes(q)) {
        return { sessionId: s.id, cwd: s.cwd || '', explicit: t.explicit === true, kind: t.kind };
      }
    }
  }
  return null;
}

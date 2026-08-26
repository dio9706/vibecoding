/**
 * 埋点统计的纯函数集合 —— 触发解析、召回、区间收敛、QuerySpec 校验、摘要文案。
 * 全部无副作用、无 IO，便于单测覆盖到每条分支。
 */

/** 触发前缀（回归锚点：改动此值等于改变用户契约，必须同步改文档与提示语） */
export const TRACKING_PREFIX = '帮我统计埋点';

/**
 * 前缀必须在**消息开头**。
 * 沿用 src/app/intent-keywords.js 的铁律：只匹配开头 ——
 * 历史事故是整篇接口文档被贴进来，全文命中关键词而误判意图。
 * 分隔符（冒号/空白）可有可无，正文不做任何限制。
 */
const CMD_RE = new RegExp(`^\\s*${TRACKING_PREFIX}\\s*[:：]?\\s*([\\s\\S]*)$`);

/**
 * 解析触发指令。
 * @param {unknown} text
 * @returns {{ hit: boolean, body: string }} hit=命中前缀；body=正文（只发前缀时为空串，调用方据此追问）
 */
export function parseTrackingCommand(text) {
  const t = typeof text === 'string' ? text : '';
  if (!t.trim()) return { hit: false, body: '' };
  const m = CMD_RE.exec(t);
  if (!m) return { hit: false, body: '' };
  return { hit: true, body: (m[1] || '').trim() };
}

/**
 * 给索引快照建 O(1) 查找表。
 *
 * 快照里 events/pages 是数组（要携带 count/live/named，字符串映射装不下），
 * 但校验环节要按标识名精确查 —— 每次线性扫 600+ 条不合适，这里一次性建 Map。
 * 纯函数：dict.js 加载时调用并缓存，测试里也能直接构造。
 */
export function indexDict(raw) {
  const events = Array.isArray(raw?.events) ? raw.events : [];
  const pages = Array.isArray(raw?.pages) ? raw.pages : [];
  return {
    events,
    pages,
    categories: Array.isArray(raw?.categories) ? raw.categories : [],
    eventIndex: new Map(events.map((e) => [e.name, e])),
    pageIndex: new Map(pages.map((p) => [p.path, p])),
    syncedAt: raw?.syncedAt || null,
  };
}

/** 召回上限：事件与页面**合计**取前 N 条（不是各 N 条）—— 精选阶段的 prompt 装不下更多 */
const RECALL_LIMIT = 30;

/** 字面匹配强度：标识名精确 > 中文名精确 > 标识名子串 > 中文名子串 > 同族扩展 */
const SCORE = { idExact: 100, labelExact: 90, idPart: 60, labelPart: 50, family: 20 };
/** 已下线条目的降权幅度 —— 降权而非丢弃：用户可能就是要查历史数据 */
const OFFLINE_PENALTY = 30;

/** 单条目对一组关键词的最高字面得分；0 表示未命中 */
function scoreEntry(id, label, keywords) {
  let best = 0;
  const lowerId = String(id).toLowerCase();
  for (const raw of keywords) {
    const kw = String(raw || '').trim();
    if (!kw) continue;
    const lowerKw = kw.toLowerCase();
    if (lowerId === lowerKw) best = Math.max(best, SCORE.idExact);
    else if (label === kw) best = Math.max(best, SCORE.labelExact);
    else if (lowerId.includes(lowerKw)) best = Math.max(best, SCORE.idPart);
    else if (label.includes(kw)) best = Math.max(best, SCORE.labelPart);
  }
  return best;
}

/**
 * 频次加成：用 log 缩放并封顶 25。
 *
 * 为什么不线性：触发次数跨 4-5 个数量级（个位数到十万级），线性加权会让
 * 一个高频但字面只是勉强沾边的事件，压过字面精确命中的低频事件。
 * log + 封顶保证「字面精确(100)」始终赢过「字面泛化(50)+ 最高频次加成(25)」。
 */
function freqBonus(count) {
  const n = Number(count) || 0;
  return n <= 0 ? 0 : Math.min(25, Math.round(Math.log10(n + 1) * 6));
}

/**
 * 三路召回后合并去重：中文名子串 / 标识名子串 / 同族前缀扩展。
 *
 * 同族扩展的意义：用户说「保存分享图片」只会字面命中一条，但他八成想看整个分享功能。
 * 命中 dish_share_save_photo 就把 dish_share_* 一族拉进候选，交给精选阶段去挑。
 *
 * @param {string[]} keywords 理解阶段产出的检索词（已做同义词扩展）
 * @param {ReturnType<typeof indexDict>} dict
 * @param {'event'|'page'|'both'} target
 * @returns {{ events: {name,label,count}[], pages: {path,label,count}[] }}
 */
export function recallCandidates(keywords, dict, target = 'both') {
  const kws = Array.isArray(keywords) ? keywords.filter((k) => String(k || '').trim()) : [];
  const events = Array.isArray(dict?.events) ? dict.events : [];
  const pages = Array.isArray(dict?.pages) ? dict.pages : [];
  if (!kws.length) return { events: [], pages: [] };

  const wantEvent = target === 'event' || target === 'both';
  const wantPage = target === 'page' || target === 'both';

  const hits = new Map(); // 标识 → { entry, kind, base }

  if (wantEvent) {
    for (const e of events) {
      const s = scoreEntry(e.name, e.label, kws);
      if (s > 0) hits.set(`e:${e.name}`, { entry: e, kind: 'event', base: s });
    }
    // 同族前缀扩展：对已命中的事件取前两段前缀，把同前缀的兄弟补进来（低分，排在直接命中之后）
    const families = new Set(
      [...hits.values()]
        .filter((h) => h.kind === 'event' && !h.entry.name.startsWith('$'))
        .map((h) => h.entry.name.split('_').slice(0, 2).join('_')),
    );
    for (const e of events) {
      if (hits.has(`e:${e.name}`) || e.name.startsWith('$')) continue;
      if (families.has(e.name.split('_').slice(0, 2).join('_'))) {
        hits.set(`e:${e.name}`, { entry: e, kind: 'event', base: SCORE.family });
      }
    }
  }

  if (wantPage) {
    for (const p of pages) {
      // 页面同时用 path 和归一化 key 参与匹配：用户可能带斜杠也可能不带
      const s = Math.max(scoreEntry(p.path, p.label, kws), scoreEntry(p.key || '', p.label, kws));
      if (s > 0) hits.set(`p:${p.path}`, { entry: p, kind: 'page', base: s });
    }
  }

  // 合并排序后统一截断：事件与页面竞争同一个 30 条预算
  const ranked = [...hits.values()]
    .map((h) => ({
      ...h,
      score: h.base + freqBonus(h.entry.count) - (h.entry.live === false ? OFFLINE_PENALTY : 0),
    }))
    .sort((a, b) => b.score - a.score || String(a.entry.name || a.entry.path).localeCompare(String(b.entry.name || b.entry.path)))
    .slice(0, RECALL_LIMIT);

  return {
    events: ranked
      .filter((h) => h.kind === 'event')
      .map((h) => ({ name: h.entry.name, label: h.entry.label, count: h.entry.count })),
    // path 必须是库内原始值（带前导斜杠）—— SQL 直接拿它去查，少个斜杠就是 0 命中且不报错
    pages: ranked
      .filter((h) => h.kind === 'page')
      .map((h) => ({ path: h.entry.path, label: h.entry.label, count: h.entry.count })),
  };
}

/** 未提及时间时的默认跨度（天，含今天） */
export const DEFAULT_RANGE_DAYS = 7;
/** 单次查询跨度上限（天）—— 超过会让 SQL 扫描量和 HTML 体积一起失控 */
export const MAX_RANGE_DAYS = 90;
/**
 * 埋点数据保留期（天）。
 *
 * 180 这个数字来自实测（2026-08-19：生产库 statistics_data 实际数据跨度
 * 2026-02-16 ~ 2026-08-19，共 184 天），取 180 作保守值。
 * 不要照抄 compass-agent 里「保留约 2.5 个月」那句注释 —— 它已被数据推翻，
 * 按 75 天设计会让用户查三个月前的数据时被无声截断。
 *
 * 必须大于 MAX_RANGE_DAYS：否则跨度上限永远够不着，那条分支就是死代码。
 */
export const RETENTION_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' → UTC 零点毫秒（只做日期算术，不涉时区换算，故用 UTC 避免本机时区干扰） */
function dayToMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** UTC 毫秒 → 'YYYY-MM-DD' */
function msToDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * 把阶段 A 产出的区间收敛到可执行范围，并记录每一次调整。
 *
 * notes 不是可选装饰：区间被静默改写而报告上不写，用户会拿着一份「我以为查了半年」
 * 的报告去开会。任何调整都必须能在报告脚注里被看到。
 *
 * @param {{start?:string,end?:string}|null} range 阶段 A 的产出
 * @param {string} today 'YYYY-MM-DD'，北京时区的今天（由调用方注入，便于测试）
 * @returns {{ start:string, end:string, days:number, includesToday:boolean, notes:string[], outOfRetention:boolean }}
 *   outOfRetention=true 表示整个区间都在保留期之外，调用方必须**直接回话、不要查库**；
 *   此时 start/end/days 保持用户原始请求值，便于回话时原样复述他要的那段时间。
 */
export function normalizeRange(range, today) {
  const notes = [];
  const todayMs = dayToMs(today);
  let startMs = dayToMs(range?.start);
  let endMs = dayToMs(range?.end);

  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    endMs = todayMs;
    startMs = todayMs - (DEFAULT_RANGE_DAYS - 1) * DAY_MS;
    notes.push(`未识别到时间范围，默认统计最近 ${DEFAULT_RANGE_DAYS} 天`);
  }

  if (startMs > endMs) {
    [startMs, endMs] = [endMs, startMs];
    notes.push('起止时间顺序有误，已自动互换');
  }

  if (endMs > todayMs) {
    endMs = todayMs;
    notes.push('结束时间晚于今天，已收敛到今天');
  }

  const earliestMs = todayMs - RETENTION_DAYS * DAY_MS;

  // 连**结束**时间都早于保留期起点 —— 整个区间一天数据都没有。
  // 不能只抬 start：那会产出 start > end 的倒挂区间，SQL 查出 0 行且不报错，
  // 报告照常生成写着「该时段无数据」，用户会当成「那几天真没人用」。
  // 这里返回明确信号，让调用方直接回话拒答，区间原样保留以便复述用户的诉求。
  if (endMs < earliestMs) {
    notes.push(
      `埋点数据仅保留约 ${RETENTION_DAYS} 天（最早 ${msToDay(earliestMs)}），所查时间范围已整体超出保留期，无法取到数据`,
    );
    return {
      start: msToDay(startMs),
      end: msToDay(endMs),
      days: Math.round((endMs - startMs) / DAY_MS) + 1,
      includesToday: endMs === todayMs,
      notes,
      outOfRetention: true,
    };
  }

  if (startMs < earliestMs) {
    startMs = earliestMs;
    // 这条脚注刻意**不写具体日期**：抬到的这个值随后还可能被 90 天跨度上限进一步收窄，
    // 写死中间态日期会让用户以为报告覆盖到那一天。跨度上限那条是最后一道收敛，
    // 它的值就是最终值，才可以带日期。
    notes.push(`埋点数据仅保留约 ${RETENTION_DAYS} 天，起始时间早于保留期，已自动抬高`);
  }

  const days = Math.round((endMs - startMs) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    startMs = endMs - (MAX_RANGE_DAYS - 1) * DAY_MS;
    notes.push(`单次查询最多 ${MAX_RANGE_DAYS} 天，起始时间已收敛到 ${msToDay(startMs)}`);
  }

  return {
    start: msToDay(startMs),
    end: msToDay(endMs),
    days: Math.round((endMs - startMs) / DAY_MS) + 1,
    includesToday: endMs === todayMs,
    notes,
    // 恒为布尔值而非 undefined：调用方一律 `if (r.outOfRetention)` 判断，字段稳定存在更不易出错
    outOfRetention: false,
  };
}

/**
 * groupBy 由跨度推导，不交给模型 —— 这一项没有歧义空间，交出去只会平白多一个出错面。
 * @returns {'day'|'none'}
 */
export function inferGroupBy(range) {
  return range?.start && range?.end && range.start !== range.end ? 'day' : 'none';
}

/** 单次查询的事件+页面合计上限 —— 防止模型一激动把整个分类全选上 */
export const MAX_TARGETS = 20;

/**
 * 精选阶段产出的硬校验：**只有索引里真实存在的标识才被采纳**。
 *
 * 这是整条链路上唯一挡住「模型编造标识」的闸门。编造出的事件名查不到数据，
 * 呈现出来是一张「该事件 0 次」的表 —— 比报错危险得多，因为它看着像个有效结论。
 *
 * label 一律以索引为准：模型写的中文名可能似是而非，报告上必须显示真名。
 * 页面必须完全匹配库内原始 path（带前导斜杠）—— 归一化形式拿去查是 0 命中且不报错。
 *
 * @param {{events?:{name:string}[], pages?:{path:string}[]}} picked 精选阶段原始产出
 * @param {ReturnType<typeof indexDict>} dict
 * @returns {{ events:{name,label}[], pages:{path,label}[], dropped:string[], truncated:boolean, empty:boolean }}
 */
export function validateSelection(picked, dict) {
  const eventIndex = dict?.eventIndex instanceof Map ? dict.eventIndex : new Map();
  const pageIndex = dict?.pageIndex instanceof Map ? dict.pageIndex : new Map();
  const dropped = [];

  const rawEvents = Array.isArray(picked?.events) ? picked.events : [];
  const rawPages = Array.isArray(picked?.pages) ? picked.pages : [];

  const seen = new Set();
  const events = [];
  for (const e of rawEvents) {
    const name = String(e?.name || '').trim();
    if (!name || seen.has(`e:${name}`)) continue;
    const entry = eventIndex.get(name);
    if (!entry) { dropped.push(name); continue; }
    seen.add(`e:${name}`);
    events.push({ name, label: entry.label || name });
  }

  const pages = [];
  for (const p of rawPages) {
    const path = String(p?.path || '').trim();
    if (!path || seen.has(`p:${path}`)) continue;
    const entry = pageIndex.get(path);
    if (!entry) { dropped.push(path); continue; }
    seen.add(`p:${path}`);
    pages.push({ path, label: entry.label || path });
  }

  // 合计截断：事件优先（业务事件的信息量通常高于页面 PV）
  let truncated = false;
  const outEvents = events.slice(0, MAX_TARGETS);
  const outPages = pages.slice(0, Math.max(0, MAX_TARGETS - outEvents.length));
  if (outEvents.length < events.length || outPages.length < pages.length) truncated = true;

  return {
    events: outEvents,
    pages: outPages,
    dropped,
    truncated,
    empty: outEvents.length === 0 && outPages.length === 0,
  };
}

/**
 * 阶段 A 失败原因 → 用户可见回话。
 *
 * 为什么非要分开写（2026-08-26 事故）：用户发「统计从 2026 年 8 月 1 日至今，
 * 所有付费用户的行为轨迹」，机器人回「没听懂这个统计需求，换个说法试试」。
 * 而日志显示模型 52.2s 就把结果算出来了，只是超过了 47s 预算被丢弃 ——
 * 需求表述毫无问题。这句错误归因的代价是：用户会反复改写一句本来就正确的话，
 * 而真正该做的是等一分钟重发。回话必须说出真实原因，否则就是在指挥用户做无用功。
 *
 * 只有 unparsable 这一条分支，「换个说法」才是有效建议。
 *
 * @param {'timeout'|'exhausted'|'unparsable'|string|null|undefined} reason
 */
export function buildUnderstandFailureReply(reason) {
  if (reason === 'timeout') {
    return [
      '⏳ 需求我收到了，但理解阶段等模型响应超时了 —— 不是你说得不清楚，别改说法。',
      '通常是账号额度受限或网络拥塞，隔一两分钟原样再发一次就行。',
    ].join('\n');
  }
  if (reason === 'exhausted') {
    return [
      '⏳ Claude 额度暂时用尽，埋点统计要靠它理解需求，现在走不下去。',
      '需求本身没问题，等额度恢复后原样再发一次即可。',
    ].join('\n');
  }
  // 兜底也走这条：新增 reason 却忘了加分支时，回一句能用的话总比 undefined 好
  return '没听懂这个统计需求，换个说法试试～例如「帮我统计埋点: 最近7天分享功能的点击」';
}

/**
 * 越界时报告使用的固定标题。
 *
 * 为什么是固定值、而不是让模型重写一个：用户拍板「报告附件不加边界声明」，
 * title 因此成为报告**脱离对话后唯一的防线**。让这条防线依赖模型是自相矛盾的 ——
 * 模型正是越界 title（如「付费用户行为轨迹统计」）的来源。
 *
 * 也不能在原 title 前面加前缀：「PV/UV 口径 · 付费用户行为轨迹统计」被截图转发出去
 * 照样是错的。必须整体替换。损失掉的信息（到底统计了哪些事件）报告表格里本来就有。
 *
 * 刻意不以「埋点统计」开头：buildReportFileName 已经加了 `埋点统计_` 前缀，
 * 重复一遍会得到「埋点统计_埋点统计 · …」这种文件名。
 */
export const SCOPE_SAFE_TITLE = '事件与页面 PV/UV 汇总';

/** 能做的口径 —— 回话里必须说清楚，否则用户不知道手里这份数据算的是什么 */
const SUPPORTED_DESC =
  '事件/页面在某段时间内的触发次数（PV）与去重人数（UV），可按天看趋势、跟上一周期环比';

/**
 * 阶段 A 的 scope 字段形状兜底。
 *
 * **默认 supported=true 是本守卫最重要的安全属性**：模型漏字段或给错类型时，
 * 行为退回「今天的样子」（照常统计），而不是把所有需求都判成越界。
 * 反过来设计的话，模型一次抽风就能让整个功能对所有人失灵。
 *
 * 「声明了越界却说不出是哪一项」同样归为支持：拿一个讲不出理由的判定去打标签，
 * 用户会收到一句既无法理解、也无法据此修改需求的说明 —— 那比直接给数据更糟。
 *
 * @param {unknown} raw 阶段 A 的 scope 原始产出
 * @returns {{supported: boolean, unsupported: string[]}}
 */
export function normalizeScope(raw) {
  const fallback = { supported: true, unsupported: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const unsupported = Array.isArray(raw.unsupported)
    ? raw.unsupported.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  // 只有显式 false 才算越界：非布尔的真值（比如字符串 'yes'）不该被读成越界信号
  if (raw.supported !== false || !unsupported.length) return fallback;
  return { supported: false, unsupported };
}

/**
 * 越界声明 —— 拼在摘要**前面**一起发出（不是脚注：脚注会被跳过）。
 *
 * 三件事必须说到：越界在哪、替代口径是什么、真正的出路是什么。
 * 少了最后一条，用户只会反复改写措辞去试探边界。原设计 §6 的结论是
 * 「真遇到复杂需求，人工写 SQL 反而更快」—— 这句话得传达给用户，而不是躺在文档里。
 *
 * @param {string[]} unsupported 命中的禁区名
 */
export function buildScopeNotice(unsupported) {
  const items = Array.isArray(unsupported)
    ? unsupported.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  // 兜底措辞：调用方已由 normalizeScope 保证非空，这里只防被单独调用时印出 undefined
  const what = items.length ? items.join('、') : '这个需求里的部分诉求';
  return [
    `⚠️ ${what} 这类分析做不到 —— 埋点统计只能给：${SUPPORTED_DESC}。`,
    '下面是最接近的替代口径，别把它当成你要的那个结论；真要做这类分析，人工写 SQL 会快得多。',
  ].join('\n');
}

/** 千分位 */
function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/**
 * 聊天内的文字摘要。
 *
 * 为什么附件之外还要发这段：飞书对 .html 不做在线预览，对方得下载后用浏览器打开。
 * 多发一段文字，对方在聊天里就能看到结论，想细看再点附件 —— 成本几乎为零。
 *
 * 量纲不合并：dimension='both' 时事件触发次数与页面浏览量分开写。
 * 二者相加得到的「总触发」是苹果加橘子 —— 既不能回答「功能被用了多少次」，
 * 也不能回答「页面被看了多少次」，而摘要是最容易被直接截图转发的那一段。
 * 独立用户数不拆：一个人可能既点了按钮又访问了页面，分维度相加会把他数两遍，
 * Python 侧给的是跨维度一次去重的精确值。
 *
 * @param {{title:string, range:string, dimension?:'event'|'page'|'both',
 *   totalPv:number, eventPv?:number, pagePv?:number, totalUv:number,
 *   compareRate:number|null, eventCompareRate?:number|null, pageCompareRate?:number|null,
 *   top:{label:string,pv:number}[]}} s
 */
export function buildSummaryText(s) {
  const lines = [`📊 ${s?.title || '埋点统计'}`, `📅 ${s?.range || ''}`];
  const pv = Number(s?.totalPv || 0);
  const uv = Number(s?.totalUv || 0);
  // dimension 缺省按事件口径：老版 summary（无该字段）落到这里时仍按原文案渲染，
  // 而不是掉进 both 分支去读两个不存在的字段、印出一串 0
  const dim = s?.dimension === 'page' || s?.dimension === 'both' ? s.dimension : 'event';

  if (pv === 0 && uv === 0) {
    lines.push('', '该时段无数据。');
    return lines.join('\n');
  }

  if (dim === 'both') {
    lines.push(
      '',
      `事件触发 ${fmtNum(s?.eventPv)} 次 · 页面浏览 ${fmtNum(s?.pagePv)} 次 · 独立用户 ${fmtNum(uv)} 人`,
    );
  } else if (dim === 'page') {
    lines.push('', `总浏览 ${fmtNum(pv)} 次 · 独立用户 ${fmtNum(uv)} 人`);
  } else {
    lines.push('', `总触发 ${fmtNum(pv)} 次 · 独立用户 ${fmtNum(uv)} 人`);
  }

  // 环比同样分维度：合成一个总环比，分子分母都是两种量纲相加的产物，
  // 涨跌还无法归因到是点击变多还是页面被看得多
  const pushCompare = (rate, prefix) => {
    if (typeof rate !== 'number' || !Number.isFinite(rate)) return;
    const arrow = rate >= 0 ? '↑' : '↓';
    lines.push(`${prefix}较上一周期 ${arrow}${(Math.abs(rate) * 100).toFixed(1)}%`);
  };
  if (dim === 'both') {
    pushCompare(s?.eventCompareRate, '事件触发 ');
    pushCompare(s?.pageCompareRate, '页面浏览 ');
  } else {
    pushCompare(s?.compareRate, '');
  }

  const top = Array.isArray(s?.top) ? s.top.slice(0, 3) : [];
  if (top.length) {
    lines.push('', 'Top：');
    for (const t of top) lines.push(`  · ${t.label} ${fmtNum(t.pv)}`);
  }

  lines.push('', '详细报告见附件 👇');
  return lines.join('\n');
}

/**
 * 报告文件名。
 * @param {string} title
 * @param {Date} now
 * @param {number} tzOffsetMinutes 目标时区相对 UTC 的分钟偏移（北京 = 480）
 */
export function buildReportFileName(title, now, tzOffsetMinutes = 480) {
  // 文件名里的非法字符会让飞书上传或对方本地保存失败，统一替换成下划线
  const safe = String(title || '埋点统计').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 30);
  const t = new Date(now.getTime() + tzOffsetMinutes * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}_${p(t.getUTCHours())}${p(t.getUTCMinutes())}`;
  return `埋点统计_${safe}_${stamp}.html`;
}

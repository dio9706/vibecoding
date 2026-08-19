/**
 * 两阶段 Haiku 推理：口语 → 检索词 → 具体事件/页面。
 *
 * 为什么必须两阶段：纯关键词召回撑不住不专业的表述。用户说「小孩吃饭那块」，
 * 字面召回直接归零 —— 而召回不到的事件，后续模型再聪明也选不出来。
 * 阶段 A 先把口语转成规范检索词，阶段 B 再从召回结果里挑。
 */
import { runClassifierOnce } from '../../features/llm-classify.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

/**
 * 两阶段的分类超时：45s。
 *
 * 为什么不跟 intent.js 的 10s：那是一句话的短分类 prompt，而这里阶段 A 要塞进 40 组业务模块
 * 目录（每组还带 3 条样例事件），阶段 B 要塞进上百条候选埋点，量级完全不是一回事。
 * 2026-08-19 端到端冒烟实测阶段 A 真实耗时 22~28s，10s 必然超时 —— 表现为「LLM 调用成功、
 * 阶段 A 却无输出」。45s 是在实测上限之上留了约 60% 余量，同时不至于让用户干等到怀疑卡死。
 *
 * 注意别顺手把 intent.js 的 10s 也改了：那条路径每条消息都要走，拖长就是全局变慢。
 */
const TIMEOUT_MS = 45_000;
/** 阶段 A 塞进 prompt 的分类目录条数上限 —— 再多 prompt 就开始膨胀，收益却在递减 */
const CATEGORY_MAX = 40;
/** 每个分类附带的样例事件条数上限 */
const CATEGORY_SAMPLE_MAX = 3;

/**
 * 北京时区的今天 'YYYY-MM-DD' 与时刻 'HH:mm'。
 *
 * 为什么不用本机时区：机器人可能跑在任意时区的机器/容器上，而埋点库的口径是北京时间。
 * 这里用「UTC 时刻 + 480 分钟后再读 UTC 字段」而不是 toLocaleString：
 * 前者是纯算术，结果不受宿主 ICU 数据与 locale 影响。
 */
export function beijingNow(now = new Date()) {
  const t = new Date(now.getTime() + 480 * 60 * 1000); // UTC+8
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`,
    time: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`,
  };
}

/** 与同步脚本一致的分类前缀口径：事件名前两段 */
function prefixOf(name) {
  return String(name || '').split('_').slice(0, 2).join('_');
}

/**
 * 渲染业务模块目录，供理解阶段做「口语 → 检索词」的锚点。
 *
 * 为什么要带样例事件：上游字典里没有模块级中文名 ——「宝宝辅食」这个词只以子串形式
 * 活在具体事件名里，categories[].label 只能从叶子动作里挑一个（如 baby_food 挑出
 * 「介绍页下一步」），单看它反而误导；65 个分类里更有 31 个的 label 直接等于 prefix
 * 本身（该模块下没有任何事件有人工中文名）。多给三条高频样例，让模型自己归纳这个
 * 模块是干嘛的，比我们在这里用规则硬猜一个模块名靠谱。
 *
 * 样例取「有中文名的高频事件优先，不足再拿机器名补齐」：机器名信息量低但不为零
 * （baby_food_paywall_pay_success 至少告诉模型这个模块有付费墙），而中文名才是
 * 用户口语能对得上的东西，必须排在前面。
 *
 * 注意 label 不单独渲染：它按定义就是组内「有中文名且频次最高」那条，
 * 天然等于第一条样例，再印一遍纯属重复占 token。
 *
 * @param {ReturnType<typeof import('./logic.js').indexDict>} dict
 * @param {number} [limit] 最多渲染多少组
 * @returns {string} 每行一组：`prefix：样例1 / 样例2 / 样例3`
 */
export function renderCategoryCatalog(dict, limit = CATEGORY_MAX) {
  const categories = Array.isArray(dict?.categories) ? dict.categories : [];
  const events = Array.isArray(dict?.events) ? dict.events : [];
  if (!categories.length) return '';

  // 先按前缀把活跃事件归一次堆，避免每个分类都全表扫一遍（600+ 事件 × 40 组）
  const byPrefix = new Map();
  for (const e of events) {
    if (!e?.live || !e?.name || String(e.name).startsWith('$')) continue; // 神策系统事件不参与业务分类
    const p = prefixOf(e.name);
    if (!byPrefix.has(p)) byPrefix.set(p, []);
    byPrefix.get(p).push(e);
  }

  const lines = [];
  for (const c of categories) {
    if (lines.length >= limit) break;
    const group = byPrefix.get(c?.prefix);
    // 组内一条活跃事件都没有 = 这个模块已经不在跑了，喂给模型只会引它往历史埋点上靠
    if (!group?.length) continue;

    const byCount = (a, b) => (Number(b.count) || 0) - (Number(a.count) || 0);
    const named = group.filter((e) => e.named).sort(byCount);
    const unnamed = group.filter((e) => !e.named).sort(byCount);
    const samples = [];
    for (const e of [...named, ...unnamed]) {
      if (samples.length >= CATEGORY_SAMPLE_MAX) break;
      const s = String(e.label || e.name).trim();
      if (s && !samples.includes(s)) samples.push(s);
    }

    lines.push(samples.length ? `${c.prefix}：${samples.join(' / ')}` : String(c.prefix));
  }
  return lines.join('\n');
}

/** 阶段 A prompt */
export function buildUnderstandPrompt(body, dict, todayDate) {
  const catalog = renderCategoryCatalog(dict) || '（暂无模块目录）';
  return `你在帮团队把一句口语化的埋点统计需求，翻译成结构化的检索条件。

今天是 ${todayDate}（北京时间）。所有相对时间都以此为基准计算。

可用的业务模块目录（格式为「事件名前缀：该模块内高频事件举例」，举例只是帮你判断这个模块是干什么的，不要直接把举例当成检索词）：
${catalog}

用户的需求原文：
${body}

请输出一个 JSON 对象，不要输出任何其它内容：
{
  "range": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "target": "event" 或 "page" 或 "both",
  "keywords": ["检索词1", "检索词2"],
  "title": "报告标题"
}

规则：
1. range 用绝对日期，且必须基于上面给出的今天（${todayDate}）推算，不要用你记忆里的日期。「最近一个月」=今天往前推 29 天到今天；「上个月」「7月」=该自然月的完整区间；「昨天」=昨天单日。用户没提时间就给最近 7 天。
2. target：用户明确说「页面」「访问」「浏览」用 page；说「点击」「按钮」「操作」用 event；说不清用 both。
3. keywords：把口语转成能在事件名和中文名里检索到的词，做同义词扩展，中英文都给。例如「小孩吃饭那块」应扩展为 ["宝宝辅食","baby_food","辅食","儿童"]。给 2-6 个词。
4. title：一句话概括这份报告统计的是什么。`;
}

/** 阶段 A：理解 */
export async function understandRequest(body, dict, now = new Date()) {
  const { date } = beijingNow(now);
  const out = await runClassifierOnce({
    prompt: buildUnderstandPrompt(body, dict, date),
    model: config.intent.classifyModel,
    logTag: 'tracking-stats/understand',
    timeoutMs: TIMEOUT_MS,
  });
  if (!out) {
    logger.warn('tracking-stats', '阶段 A 无输出（超时或解析失败）');
    return null;
  }
  // 只做形状兜底：模型可能吐回缺字段或类型不对的 JSON，先保证下游拿到的字段类型稳定；
  // 语义校验（区间是否可查、标识是否真实存在）一律交给 logic.js 的纯函数
  return {
    range: out.range && typeof out.range === 'object' ? out.range : null,
    target: ['event', 'page', 'both'].includes(out.target) ? out.target : 'both',
    keywords: Array.isArray(out.keywords) ? out.keywords.map((k) => String(k || '').trim()).filter(Boolean) : [],
    title: String(out.title || '').trim() || '埋点统计',
  };
}

/** 阶段 B prompt */
export function buildPickPrompt(body, candidates) {
  const evs = Array.isArray(candidates?.events) ? candidates.events : [];
  const pgs = Array.isArray(candidates?.pages) ? candidates.pages : [];
  // 候选为空时必须落到「（无）」这个显式占位：空字符串会让 prompt 里出现一段空白，
  // 模型极易把它读成「这里被截断了」而自行编造标识补上
  const evLines = evs.map((e) => `- ${e.name} : ${e.label}`).join('\n') || '（无）';
  const pgLines = pgs.map((p) => `- ${p.path} : ${p.label}`).join('\n') || '（无）';
  return `用户的埋点统计需求：
${body}

以下是检索出的候选埋点。请只从候选里挑出真正符合需求的。

候选事件：
${evLines}

候选页面：
${pgLines}

请输出一个 JSON 对象，不要输出任何其它内容：
{
  "events": [{ "name": "候选里的事件名" }],
  "pages": [{ "path": "候选里的页面路径" }]
}

规则：
1. **绝对不要发明候选列表之外的标识**。events[].name 必须逐字复制自上面「候选事件」，pages[].path 必须逐字复制自「候选页面」（含前导斜杠，一个字符都不能改）。任何不在候选里的标识都会被丢弃，而且会让这次统计变成一份看似有效实则空白的报告。
2. 宁可少选几个精准的，也不要把候选列表照抄一遍 —— 候选是机器粗筛出来的，本来就掺着不相关的条目，你的价值在于挑，不在于全收。
3. 用户只关心页面就让 events 为空数组，反之亦然。
4. 某一侧候选为「（无）」时，对应数组直接给空数组。
5. 两个数组合计不要超过 20 条。`;
}

/** 阶段 B：精选。返回原始选择，硬校验由 logic.validateSelection 负责 */
export async function pickTargets(body, candidates) {
  const out = await runClassifierOnce({
    prompt: buildPickPrompt(body, candidates),
    model: config.intent.classifyModel,
    logTag: 'tracking-stats/pick',
    timeoutMs: TIMEOUT_MS,
  });
  if (!out) {
    logger.warn('tracking-stats', '阶段 B 无输出（超时或解析失败）');
    return null;
  }
  // 同样只做形状兜底：非数组一律归零，交给 validateSelection 做白名单硬校验
  return {
    events: Array.isArray(out.events) ? out.events : [],
    pages: Array.isArray(out.pages) ? out.pages : [],
  };
}

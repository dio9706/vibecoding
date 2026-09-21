/**
 * Phase 2 合成器 —— 把多个会话的 findings 批量提炼为 memories（长期记忆）。
 * 复用 runClassifierOnce 骨架（额度耗尽 fail-fast / 30s 超时 / 单轮禁工具）。
 * findings 由 analyze.js（Phase 1）产出；memories 写入 src/store/memory-bank.js。
 */
import { runClassifierOnce } from '../../capabilities/llm-classify.js';
import { addMemory } from '../../store/memory-bank.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { classifyCwd } from './sandbox.js';

/**
 * 单批合成的超时预算。
 *
 * 定值依据（2026-09-18 事故）：本调用一直吃 `llm-classify` 的 30s 默认，而一批 4.4 万字符的
 * findings 合成**实测需要 51.5s** —— 也就是每一次调用都注定在到达终点前被 abort。
 * 日志逐日印证：9/10 起 83 次调用、成功 0 次，「调用次数」与「无结果次数」每天完全相等，
 * 生产库 `memories: 0`、`synthesizedAt` 无一条打标、6156 条 findings 一条都没被消化。
 * 把预算放宽后，同一批一次就产出 20 条有效 memories。
 * 180s 是 51.5s 的三倍余量：批预算 `BATCH_MAX_CHARS` 若日后调大，耗时会跟着涨。
 */
export const SYNTHESIS_TIMEOUT_MS = 180_000;

/** 合法的 memory 分类。调用方可用来验证产出。 */
export const MEMORY_CATEGORIES = ['collaboration', 'code-style', 'writing', 'dialogue', 'tech-pref'];

const MAX_STATEMENT = 300;
const MAX_REASONING = 300;

/**
 * strength → evidenceCount 的映射。
 * 用离散两档而非让模型直接报数字：模型报「这条基于 7 条 findings」是编出来的，
 * 报「强/弱」才是它真能判断的。
 */
const STRENGTH_WEIGHT = { strong: 3, normal: 1 };

/**
 * 单批 findings 的字符预算。
 *
 * 定值依据（2026-09-09 事故实测）：Phase 2 原本把 bank 里**历史全量** findings 一次送出，
 * 攒到 6081 条时正文 108 万字符 → 请求 ~71.5 万 token，而上限是 20 万。日志里每一轮
 * 都固定报 `Prompt is too long`，`synthesizeMemories` 返回 null，记忆库从此再没长过一条。
 * 更要命的是这个故障单调恶化：findings 只增不减，越跑越没救。
 * 4 万字符约合 3 万 token，叠加 existingStatements 与 system prompt 后仍留足余量。
 */
export const BATCH_MAX_CHARS = 40_000;

/**
 * 单轮最多合成几批。闲时提炼是后台任务，一口气跑几十次 LLM 调用会把用户额度吃光，
 * 而记忆本来就不急着一次提完 —— 存量按批消化，剩下的留给下一个闲时窗口。
 */
export const MAX_BATCHES_PER_RUN = 3;

/** 塞进 prompt 的已有记忆条数上限。超出部分不影响去重效果，却会实打实挤占批预算。 */
const MAX_EXISTING_STATEMENTS = 100;

/** 单条 finding 在 prompt 里的固定开销（`[n] type=xxx\n  summary: ` 这层壳），计入批预算 */
const FINDING_OVERHEAD_CHARS = 30;

/** 一个 session 的 findings 渲染进 prompt 后约占多少字符 */
function sessionChars(session) {
  return (session.findings || []).reduce(
    (a, f) => a + String(f?.summary || '').length + String(f?.detail || '').length + FINDING_OVERHEAD_CHARS,
    0
  );
}

/**
 * 纯函数。把「尚未合成过的会话」按字符预算切成批。
 *
 * 为什么以 session 而非单条 finding 为最小单位：合成成功后要按 session 打 `synthesizedAt`
 * 标记来推进游标，findings 一旦跨批，某批失败就会让该 session 处于「一半已合成」的状态 ——
 * 标记打了会丢数据，不打会重复合成。以 session 为粒度，标记与批次天然一一对应。
 *
 * @param {Array} sessions bank.sessions
 * @param {{maxChars?:number, maxBatches?:number}} [opts]
 * @returns {Array<{sessionIds:string[], findings:Array}>}
 */
export function batchSessionsForSynthesis(sessions, opts = {}) {
  if (!Array.isArray(sessions)) return [];
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : BATCH_MAX_CHARS;
  const maxBatches = Number(opts.maxBatches) > 0 ? Number(opts.maxBatches) : MAX_BATCHES_PER_RUN;

  const pending = sessions.filter(
    (s) => s && Array.isArray(s.findings) && s.findings.length > 0 && !s.synthesizedAt
  );

  const batches = [];
  let cur = { sessionIds: [], findings: [] };
  let curChars = 0;

  for (const s of pending) {
    const size = sessionChars(s);
    // 当前批已有内容且再塞就超预算 → 先收口。批为空时无论多大都收下，
    // 否则单个超预算的 session 会被反复跳过、永远合成不了。
    if (cur.findings.length > 0 && curChars + size > maxChars) {
      batches.push(cur);
      if (batches.length >= maxBatches) return batches;
      cur = { sessionIds: [], findings: [] };
      curChars = 0;
    }
    cur.sessionIds.push(s.id);
    cur.findings.push(...s.findings);
    curChars += size;
  }

  if (cur.findings.length > 0) batches.push(cur);
  return batches.slice(0, maxBatches);
}

/**
 * 纯函数。把 findings 数组构建为合成 prompt。
 * @param {Array<{type:string, summary:string, detail?:string, sessionPath?:string}>} findings
 * @param {{existingStatements?:string[]}} [opts] 已有记忆的 statement 列表 —— 不给的话模型无从知道
 *   自己上一批产出过什么，会把同一条偏好一轮一轮重复写进 bank（`addMemory` 按随机 id 去重，拦不住）。
 * @returns {string}
 */
export function buildSynthesisPrompt(findings, opts = {}) {
  const list = Array.isArray(findings) ? findings : [];

  const items = list
    .map((f, i) => {
      const type = String(f?.type || '');
      const summary = String(f?.summary || '').trim();
      const detail = String(f?.detail || '').trim();
      return `[${i + 1}] type=${type}\n  summary: ${summary}${detail ? `\n  detail: ${detail}` : ''}`;
    })
    .join('\n\n');

  const existing = (Array.isArray(opts.existingStatements) ? opts.existingStatements : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(-MAX_EXISTING_STATEMENTS);

  const existingBlock = existing.length
    ? ['', '已经记住的条目（不要重复产出这些，也不要换个说法重说一遍）：',
       ...existing.map((s) => `- ${s}`), '']
    : [];

  return [
    '你是一个用户偏好提炼器。下面是从多个开发对话会话中提炼的发现（findings）。',
    '请从中识别出值得长期记住的偏好、模式或规则，并合成为记忆条目（memories）。',
    '',
    '重要原则：',
    '1. 不是每个 finding 都需要变成 memory，要有选择性。只保留真正具有长期价值的条目。',
    '2. statement 必须是具体可执行的规则，不能是模糊描述。',
    '3. category 必须从以下值中选一个：collaboration / code-style / writing / dialogue / tech-pref',
    '   - collaboration：协作方式、沟通风格、工作流程偏好',
    '   - code-style：代码风格、命名规范、格式习惯',
    '   - writing：文档、注释、提交信息的写作风格',
    '   - dialogue：对话风格、反馈偏好、交互习惯',
    '   - tech-pref：技术选型、框架/库偏好、工具链选择',
    '',
    // ── 门槛：整个提炼质量的闸门 ──
    // 定值依据（2026-09-18 实测）：生产库 56 条产出里，约 4 条是业界通识（DRY/KISS/极简主义）、
    // 37 条是项目专属技术细节。通识零信息量却照样吃注入预算（总量 3949 字符 vs 预算 3000），
    // 把真正能改变行为的条目挤出截断线。没有负面清单，模型会把「看着像偏好」的都收进来。
    '判据（最重要）：只收「一个不认识这位用户的资深工程师，默认不会这么做」的条目。',
    '一条记忆的价值 = 它能改变行为的程度。写下来却不改变任何行为的，就是纯粹的 token 浪费。',
    '',
    '不要产出以下几类（它们看着像偏好，实际没有价值）：',
    '- 业界通识：DRY、KISS、SOLID、单一职责、「避免过度设计」、「代码要简洁」。',
    '  任何模型默认就会遵守，写进记忆只占预算不改变行为。',
    '- 一次性决策：「本次版本清理时移除已升级字段」这类做完就过期的事，不是长期偏好。',
    '- 复述现象而非规则：「用户很关注性能」太模糊，「要求先测出耗时再优化，禁止凭感觉调」才可执行。',
    '- 从单次对话推断的巧合：只出现过一次、又没被用户明确要求的做法。',
    '',
    '优先产出以下几类：',
    '- 用户明确说过的规矩（「以后都…」「不要再…」「记住…」）。',
    '- 反直觉的约束：与常规做法相反、不写下来下次一定会做错的。',
    '- 踩过坑换来的判据：某个做法失败过，用户纠正过。',
    '',
    '仅输出一个 JSON 对象，不要任何解释文字。格式：',
    '{"memories":[{"category":"tech-pref","statement":"具体规则描述",'
      + '"reasoning":"为什么值得记住（可选）","explicit":true,"strength":"strong"}]}',
    '',
    '字段说明：',
    '- explicit：true 表示用户明确说过这条规矩；false 表示从行为推断。',
    '  这个字段决定注入优先级 —— 判错会让真正的硬性要求被推断出来的条目挤掉，务必如实填。',
    '- strength："strong" 表示跨多个会话反复出现；"normal" 表示证据较少。',
    '',
    '硬约束：',
    '1. 无值得记录的内容时，memories 返回空数组（{"memories":[]}）。宁缺毋滥 —— ',
    '   一轮产出 0 条是完全正常且可接受的结果，凑数比漏掉更有害。',
    '2. statement 不超过 300 字符，必须简洁具体。',
    '3. reasoning 可选，不超过 300 字符。',
    '4. category 必须是上述五个值之一，否则该条目无效。',
    '5. explicit 必须是布尔值，strength 必须是 "strong" 或 "normal"。',
    ...existingBlock,
    '',
    `共 ${list.length} 条 findings：`,
    '',
    items || '（无 findings 内容）',
  ].join('\n');
}

/**
 * 校验归一化 LLM 返回的 memories。任何非法输入返回空数组，不抛错。
 * @param {object} json
 * @returns {Array<{category:string, statement:string, reasoning:string}>}
 */
export function sanitizeMemories(json) {
  if (!json || !Array.isArray(json.memories)) return [];
  const out = [];
  for (const item of json.memories) {
    if (!item || typeof item !== 'object') continue;
    const category = String(item.category || '').trim();
    if (!MEMORY_CATEGORIES.includes(category)) continue;
    const statement = String(item.statement || '').trim();
    if (!statement) continue;
    const reasoning = String(item.reasoning || '').slice(0, MAX_REASONING);
    // 非布尔一律当 false：模型偶尔会回 "yes"/"true" 字符串，宽松解析会把推断出来的
    // 条目误升成「用户明说的」，进而在排序时把真正的硬性要求挤出注入预算。
    const explicit = item.explicit === true;
    const evidenceCount = STRENGTH_WEIGHT[String(item.strength || '').trim()] || 1;
    out.push({
      category,
      statement: statement.slice(0, MAX_STATEMENT),
      reasoning,
      explicit,
      evidenceCount,
    });
  }
  return out;
}

/**
 * Phase 2 主函数：把 findings 合成为 memories，写入 memory-bank。
 *
 * 返回值契约（与 analyze.js 保持一致）：
 * - `null`   —— LLM 调用失败（超时/额度耗尽/解析失败）。
 * - `[]`     —— 调用成功，但无值得记录的 memory。
 * - `[...]`  —— 调用成功且有新 memory 写入。
 *
 * @param {Array} findings 来自多个会话的 findings（**一批**，调用方先经 batchSessionsForSynthesis 切好）
 * @param {{model?:string, _runner?:Function, existingStatements?:string[]}} opts
 *   `_runner` 仅供测试注入替换 `runClassifierOnce`，避免单测烧用户额度。
 * @returns {Promise<Array|null>} 新增的 memory 对象数组；null 表示 LLM 调用失败
 */
export async function synthesizeMemories(findings, opts = {}) {
  if (!Array.isArray(findings) || findings.length === 0) return [];

  const { model, _runner = runClassifierOnce, existingStatements } = opts;

  const json = await _runner({
    prompt: buildSynthesisPrompt(findings, { existingStatements }),
    model: model || config.intent.classifyModel,
    logTag: 'memory-bank/synthesize',
    timeoutMs: SYNTHESIS_TIMEOUT_MS,
    cwd: classifyCwd(), // 空目录：本调用不读任何文件，项目上下文只会拖慢并带偏输出
  });

  if (!json) {
    logger.warn('memory-bank', '合成调用无结果（超时/额度/解析失败）');
    return null;
  }

  const candidates = sanitizeMemories(json);
  const written = [];

  for (const c of candidates) {
    const at = Date.now();
    const memory = {
      id: `mem_${at}_${Math.random().toString(36).slice(2, 7)}`,
      category: c.category,
      statement: c.statement,
      reasoning: c.reasoning,
      createdAt: at,
      source: 'synthesized',
      // 注入排序依据。缺了这两个字段，render 的 weight() 对所有条目算出同一个值，
      // 「哪 40 条进 CLAUDE.md」就退化成数组下标顺序（2026-09-18 实测缺陷）。
      explicit: c.explicit,
      evidenceCount: c.evidenceCount,
      lastSeenAt: at,
      status: 'active',
      inject: true,
    };
    try {
      addMemory(memory);
      written.push(memory);
    } catch (e) {
      logger.warn('memory-bank', '写入 memory 失败', { id: memory.id, err: e?.message });
    }
  }

  return written;
}

/**
 * 提炼输入（按会话分组的用户原话）→ 候选偏好条目。LLM 层。
 * 复用 runClassifierOnce（额度耗尽 fail-fast / 30s 超时 / 单轮禁工具 / 首个 JSON 块提取）。
 */
import { runClassifierOnce } from '../../capabilities/llm-classify.js';
import { attributeTurn } from './prefilter.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

export const CATEGORIES = ['code-style', 'collaboration', 'writing', 'dialogue', 'tech-pref'];
const MAX_STATEMENT = 200;

/**
 * 为什么这版提示词要重写：上一版假设输入是「用户纠正 AI 的片段」，被真实数据证伪 ——
 * 用户的高价值偏好大量以决断式表达出现（「B. 人工确认 + C」「仅在额度重置前 30 分钟跑」），
 * 一句纠正措辞都不带。现在输入换成了「用户说过的全部原话」，模型必须自己从中挑，
 * 因此提示词的重点从「读懂纠正」变成两件事：**认得出非纠正形态的偏好** + **忍得住不去凑数**。
 */
export const EXTRACT_SYSTEM_PROMPT = {
  type: 'custom',
  custom: [
    '你是用户偏好提炼器。输入是用户在若干次对话里**亲手输入的全部原话**（已剔除系统注入与工具输出，',
    '按会话分组、组内按时间先后排列），你要从中找出可复用的稳定偏好。',
    '仅输出一个 JSON 对象，不要任何解释文字。格式：',
    '{"items":[{"category":"code-style|collaboration|writing|dialogue|tech-pref",',
    '"scope":"global|project","statement":"...","fingerprint":"...","source":"explicit|inferred",',
    '"quote":"...","contradicts":false}]}',
    '',
    '类别定义：',
    '- code-style 代码怎么写（语言、命名、注释、文件大小、测试写法）',
    '- collaboration 怎么和 AI 配合（先给方案再动手、改动前请示、不许自动提交）',
    '- writing 怎么写字（commit 措辞、文档语言、格式约定）',
    '- dialogue 对话风格（回复长度、语气、是否要 emoji）',
    '- tech-pref 技术选型倾向',
    '',
    '偏好长什么样 —— **不限于「纠正 AI」这一种形态**，下面几类同样是高价值信号：',
    '- 下规矩：「以后注释一律用中文」「不许自动提交」',
    '- 做决策、定方案：「B. 人工确认 + C」「只注入这三类，别的仅记录」',
    '- 划边界、给约束：「仅在额度重置前 30 分钟跑」「单文件别超过 300 行」',
    '- 表达期望：「让 AI 越用越懂我，并且可以导出」',
    '- 打断纠偏：标了 [插话] 的行是用户中途打断 AI 说的，说明 AI 当时走偏了，',
    '  这类话往往直指用户真正想要的东西，要重点看。',
    '语气平静的陈述句、甚至只是选了个选项，都可能是偏好；不要只盯着批评和否定。',
    '',
    '必须忽略的（输入里大部分内容都属于这几类）：',
    '- 推进对话的应答：「继续」「好的」「行」「嗯」「A」「1」「可以」',
    '- **一次性**的任务指令：「把这个函数改成 async」「看下 3 号文件」「先跑一下测试」——',
    '  它们是活儿，不是偏好。判据：换一个工程、换一件事，这条规则还成立吗？不成立就别提。',
    '- 事实陈述、粘贴的报错、单纯的提问。',
    '**提炼不出就返回空数组，绝不允许为了凑数把任务指令包装成偏好。**',
    '',
    '硬约束：',
    '1. statement 必须是可执行的具体规则。禁止「用户喜欢清晰的代码」这类无操作性的空话。',
    '2. 提炼不出确定偏好时 items 返回空数组（{"items":[]}）。宁缺毋滥 —— 错误的规则比没有规则伤害更大。',
    '3. quote 必须逐字来自输入里的某一行用户原话，不得改写、不得跨行拼接，',
    '   也不要带上 [插话] / [明示] 这类行首标记。',
    '4. fingerprint 是该偏好的语义键，形如 "code-style:注释语言"，同一主题必须产出相同 fingerprint。',
    '5. scope：规则只对某一个工程成立填 project，跨工程通用填 global。每个会话都标了自己的工程目录。',
    '6. source：quote 所在行带 [明示] 标记的填 explicit，其余填 inferred。',
    '7. 若该偏好与常见默认做法相反、疑似推翻用户过去的规则，contradicts 填 true。',
  ].join('\n'),
};

/** 行首标记：告诉模型这行的来路。含义写在正文里而不是 system prompt，
 *  是为了让「标记」和「带标记的数据」贴在一起，模型不必跨段回忆词义。 */
function turnLine(t) {
  const tags = [];
  if (t?.kind === 'steer') tags.push('插话');
  if (t?.explicit) tags.push('明示');
  const prefix = tags.length ? `[${tags.join('|')}] ` : '';
  return `${prefix}${t?.text || ''}${t?.truncated ? ' …（原文过长已截断）' : ''}`;
}

/**
 * @param {Array<{id:string, cwd:string, turns:Array}>} sessions prefilter.buildExtractionInput 的产出
 * @param {{cwd:string}} ctx cwd = 本次提炼进程的工作目录（会话自身没记 cwd 时的兜底参照）
 */
export function buildPrompt(sessions, { cwd }) {
  const head = [
    `当前工程目录：${cwd}`,
    '',
    '以下是用户亲手输入的原话，按会话分组、组内按时间先后排列。',
    '行首标记：[插话] = 用户中途打断了 AI（AI 当时走偏了）；[明示] = 这行出现了「记住/以后/每次/一律」等下规矩的措辞。',
  ].join('\n');

  const blocks = (sessions || []).map((s, i) => {
    const lines = [`# 会话 ${i + 1}${s?.cwd ? `（工程目录：${s.cwd}）` : ''}`];
    for (const t of s?.turns || []) lines.push(turnLine(t));
    return lines.join('\n');
  });
  return [head, ...blocks].join('\n\n');
}

/**
 * 校验并归一化 LLM 产出。任何非法输入都得到空数组，绝不抛错。
 *
 * @param {object} json 模型返回
 * @param {{cwd:string, sessionId:string, sessions?:Array}} ctx
 *   传了 sessions 就按 quote 反查归属（见 prefilter.attributeTurn）：证据要落到它真正出自的那次会话，
 *   否则一批候选共用一个 sessionId，promote.js 的「跨 >=2 个会话」就永远凑不齐。
 */
export function sanitizeCandidates(json, { cwd, sessionId, sessions }) {
  const items = json && Array.isArray(json.items) ? json.items : [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const category = String(it.category || '');
    const statement = String(it.statement || '').trim();
    const fingerprint = String(it.fingerprint || '').trim();
    if (!CATEGORIES.includes(category) || !statement || !fingerprint) continue;
    const scope = it.scope === 'project' ? 'project' : 'global';
    const quote = String(it.quote || '').slice(0, 500);

    const hit = sessions?.length ? attributeTurn(quote, sessions) : null;
    // 归位成功时 explicit 以**正则标记**为准，不采信模型的 source：explicit 会跳过
    // 「3 条证据跨 2 个会话」的全部把关（promote.js 单条即晋升），误标一条就等于放一条错规则
    // 进此后每一次对话。归位失败（模型改写了 quote）才退回模型给的值。
    const source = hit ? (hit.explicit ? 'explicit' : 'inferred') : (it.source === 'explicit' ? 'explicit' : 'inferred');

    out.push({
      category,
      scope,
      // project scope 的落点是「那次对话所在的工程」，不是提炼进程的 cwd ——
      // user-log 是全局日志，一批里混着好几个工程的对话。
      projectDir: scope === 'project' ? hit?.cwd || cwd : '',
      statement: statement.slice(0, MAX_STATEMENT),
      fingerprint,
      source,
      quote,
      contradicts: it.contradicts === true,
      sessionId: hit?.sessionId || sessionId,
      at: new Date().toISOString(),
      kind: source,
    });
  }
  return out;
}

/**
 * 跑一次提炼。
 *
 * 返回值契约（调用方 index.js 的 runOnce 据此决定是否推进扫描游标，两者含义截然不同，不可混同）：
 * - `null`   —— 底层调用失败（超时 / 额度耗尽 fail-fast / 解析不出 JSON）。调用方不应推进游标，
 *   否则一次超时会让这批用户输入被永久跳过、证据静默丢失。
 * - `[]`     —— 调用成功，但模型判定这批原话确实提炼不出确定偏好（EXTRACT_SYSTEM_PROMPT 里
 *   「宁缺毋滥」的正常产出）。属正常完成，调用方可以推进游标。
 * - `[...]`  —— 调用成功且有产出。
 *
 * @param {Array} sessions prefilter.buildExtractionInput 的 sessions
 * @param {{cwd:string, sessionId:string, model?:string, _runner?:Function}} opts
 *   `sessionId` 是归位失败时的兜底会话标识（一般填本批次的标签）。
 *   `_runner` 仅供测试注入替换 `runClassifierOnce`，避免单测发起真实 LLM 调用（会烧用户额度）；
 *   默认使用真实实现，生产路径行为不变。
 * @returns {Promise<Array|null>} 候选条目数组；`null` 表示底层调用失败
 */
export async function extractFromSessions(sessions, { cwd, sessionId, model, _runner = runClassifierOnce } = {}) {
  // 不能只判 sessions.length：一个 turns 为空的会话同样没话可提炼，照发就是白烧一次额度
  const hasTurns = (sessions || []).some((s) => s?.turns?.length);
  if (!hasTurns) return [];
  const json = await _runner({
    prompt: buildPrompt(sessions, { cwd }),
    systemPrompt: EXTRACT_SYSTEM_PROMPT,
    model: model || config.intent.classifyModel,
    logTag: 'memory-bank/extract',
  });
  if (!json) {
    logger.warn('memory-bank', '提炼调用无结果（超时/额度/解析失败）', { sessionId });
    return null;
  }
  return sanitizeCandidates(json, { cwd, sessionId, sessions });
}

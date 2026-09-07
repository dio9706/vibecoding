/**
 * 通用审计引擎的纯判定层：prompt 组装、返回值校验、重锚定、判分。
 *
 * ## 这一层是从 check-prompts.js 里长出来的
 *
 * `check-prompts.js` 有 530 行，其中提示词质量**特有**的只有约 80 行（候选召回规则与判据文案），
 * 剩下 450 行——分批、限并发、失败重试、全有或全无校验、指纹缓存、判定重锚定——
 * 是**每个 LLM 维度都要重写一遍的同构逻辑**。`check-comments.js` 已经是它的一份近似拷贝。
 * 再加十个维度就是十份拷贝，而每份都会独立漂移（批大小、超时预算、重试次数各不相同）。
 *
 * 所以这里把同构部分抽成一份，维度特有部分由 `dimensions/registry.js` 的声明注入。
 * **既有的 check-prompts / check-comments 刻意不改**：它们的参数是多次实测校准出来的
 * （模型档位、超时预算都有事故记录），换引擎会把那些校准丢掉。
 *
 * 本模块不做 IO、不调 LLM，因此可以整段直测。
 */

/**
 * 候选原文在 prompt 里的截断长度。
 *
 * 比 check-prompts 的 400 宽得多：那边的候选是单行规则，这边是整段函数体
 * （complexity 的证据含最多 45 行正文）。截太短会让模型看不到函数的后半段就下判断。
 */
const TEXT_CLIP = 2400;

/** verdictLog 里留档的原文与理由长度上限：防止把 optimize.json 撑爆 */
const LOG_TEXT_CLIP = 300;
const LOG_REASON_CLIP = 400;

/**
 * 把召回器的返回归一成 `{candidates, sharedContext, na}`。
 *
 * 允许召回器返回裸数组，是因为代码级召回器全都不需要共享上下文，
 * 强制它们包一层 `{candidates: [...]}` 只是噪声。
 */
export function normalizeRecall(result) {
  if (Array.isArray(result)) return { candidates: result, sharedContext: '', na: null };
  return {
    candidates: Array.isArray(result?.candidates) ? result.candidates : [],
    sharedContext: typeof result?.sharedContext === 'string' ? result.sharedContext : '',
    na: result?.na || null,
  };
}

/**
 * 组装 system prompt。
 *
 * 「你没有任何工具」那段是实测逼出来的，不是保险话术——`check-prompts.js` 记录过：
 * 模型看到脱离上下文的片段时会先说「让我读取源文件」，然后调 ToolSearch 把 Read 捞回来，
 * 一轮就用光 `maxTurns=1`，SDK 报 error_max_turns、result 为空串，整批判定作废。
 * 必须在提示词层面掐掉「去读文件」这个念头本身，而不是指望工具黑名单拦得住。
 */
export function buildSystemPrompt(rubric) {
  return {
    type: 'custom',
    custom: [
      rubric.role,
      '你没有任何工具，也没有文件系统访问权限。禁止调用工具、禁止尝试读取文件、禁止搜索工具——',
      '任何一次工具调用都会让整批判定作废。你能看到的全部信息就是用户消息里给出的文本。',
      '只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码围栏。',
    ].join('\n'),
  };
}

/**
 * 组装判定 prompt。
 *
 * 三个刻意的设计（全部来自 check-prompts.js 的实测）：
 * 1. **要求返回 `{"verdicts":[...]}` 对象包数组，而不是裸数组**。JSON 提取靠大括号计数，
 *    模型若吐 `[{...}]` 会被截成第一个元素，等于整批判定丢失。
 * 2. **明写「写成别的 verdict 会让整批作废」**。校验是全有或全无的，模型必须知道代价。
 * 3. **明写哪些 verdict 不扣分**。不说的话模型会为了「显得在认真干活」而倾向报问题；
 *    告诉它「判可接受没有任何副作用」才能拿到真实分布。
 */
export function buildPrompt({ dim, batch, sharedContext = '' }) {
  const names = Object.keys(dim.verdicts);
  const scored = names.filter((n) => dim.verdicts[n].weight > 0);
  const free = names.filter((n) => !dim.verdicts[n].weight);

  const list = batch
    .map((c, i) => `[${i + 1}] file=${c.file} line=${c.line}\n${String(c.text).slice(0, TEXT_CLIP)}`)
    .join('\n\n');

  const parts = [dim.rubric.intro, ''];

  if (sharedContext) parts.push(sharedContext, '');

  parts.push(
    '## 判定口径',
    '',
    dim.rubric.criteria,
    '',
    '## 示例',
    '',
    dim.rubric.examples,
    '',
    '## 输出格式',
    '',
    '严格输出一个 JSON 对象（注意 verdicts 是对象的字段，不要直接输出数组）：',
    `{"verdicts":[{"file":"src/a.js","line":12,"verdict":"${names[0]}","reason":"...","suggestion":"..."}]}`,
    '',
    `- 必须为下面**每一条**候选各输出一条判定，一条不漏；\`file\` 与 \`line\` 按候选原样回填。`,
    `- \`verdict\` 只能是 ${names.map((n) => `\`${n}\``).join(' / ')} 之一，`,
    '  写成别的值会让这一整批判定全部作废。',
    dim.rubric.outputRule,
    '',
    `只有 ${scored.map((n) => `\`${n}\``).join(' / ')} 会被计入扣分并展示给用户；`,
    `${free.map((n) => `\`${n}\``).join(' / ')} 不扣分、也不会出现在问题清单里——`,
    '所以碰到「像是问题但其实合理」的条目，放心判可接受，不会有任何副作用。',
    '',
    `## 候选清单（共 ${batch.length} 条）`,
    '',
    list,
  );

  return parts.join('\n');
}

/**
 * 校验模型返回的一批判定。全有或全无。
 *
 * 为什么不修补：这一层的输出会直接变成给用户看的「你的代码有问题」结论，
 * 一条结构都对不上说明模型这次没按格式走，剩下那些「看起来合法」的条目同样不可信；
 * 挑着用等于把噪声当结论展示，比老老实实报 partial 危险得多。
 *
 * 条数必须相等这一条尤其重要：模型只判 12 条里的 3 条也能通过大括号计数
 * （JSON 对象本身是完整的，只是条目不全），剩下 9 条会被**静默当成可接受**而 status 仍是 done。
 * 后果是「0 个问题」这种结果无法区分「都合格」和「模型漏判了大半」。
 *
 * @returns {Array|null}
 */
export function validateVerdicts(raw, expectedCount, verdictNames) {
  if (!raw || !Array.isArray(raw.verdicts)) return null;
  const list = raw.verdicts;
  if (list.length !== expectedCount) return null;
  for (const v of list) {
    if (!v || typeof v !== 'object') return null;
    if (!verdictNames.includes(v.verdict)) return null;
    if (typeof v.line !== 'number' || !Number.isFinite(v.line)) return null;
  }
  return list;
}

/**
 * 把模型返回的判定重新锚定到真实候选上。
 *
 * 模型回填的 `file` 可能拼错或省略，而多文件场景下同一个行号会在不同文件里重复出现，
 * 光靠 line 无法区分。这里用 (file, line) 精确匹配，匹配上就以**我们自己的候选表**为准
 * ——展示给用户的定位信息必须来自磁盘事实，而不是模型记忆。
 *
 * 按索引兜底是最后一道：候选清单是有序发出去的，模型也被要求逐条对应，
 * 所以位置本身携带信息。没有它的话，模型把 file/line 一起写错的那条会彻底丢掉配对。
 */
export function reanchor(verdicts, candidates) {
  const exact = new Map(candidates.map((c) => [`${c.file}#${c.line}`, c]));
  const byLine = new Map();
  for (const c of candidates) if (!byLine.has(c.line)) byLine.set(c.line, c);

  return verdicts.map((v, i) => {
    const hit = exact.get(`${v.file}#${v.line}`) || byLine.get(v.line) || candidates[i];
    return {
      verdict: v.verdict,
      file: hit?.file ?? v.file ?? null,
      line: hit?.line ?? v.line,
      reason: typeof v.reason === 'string' ? v.reason : '',
      suggestion: typeof v.suggestion === 'string' ? v.suggestion : '',
      candidate: hit || null,
    };
  });
}

/** 按维度声明的判分口径算分。两种模式的理由见 registry.js 的头注释 */
export function scoreOf(dim, verdicts, fileCount) {
  const { mode = 'absolute', factor = 100, maxDeduct = 100 } = dim.scoring || {};
  let weightSum = 0;
  for (const v of verdicts) weightSum += dim.verdicts[v.verdict]?.weight || 0;

  const raw = mode === 'density'
    ? (weightSum / Math.max(1, fileCount)) * factor
    : weightSum;

  return Math.max(0, Math.min(100, Math.round(100 - Math.min(maxDeduct, raw))));
}

/**
 * 全量判定留档。
 *
 * 为什么必须留（`check-prompts.js` 的教训）：只有扣分档会变成 issue，其余判定连同模型给的
 * reason 一起被丢弃。于是出现「0 个问题」这种结果时，无法区分「模型认真判了且都合格」和
 * 「模型摆烂 / 漏判了大半」。留档后任何一轮结果都能逐条回溯与横向对比——
 * 这也是本功能十份未经校准的新判据唯一的可观测手段。
 */
function buildVerdictLog(verdicts) {
  return verdicts.map((v) => ({
    file: v.file,
    line: v.line,
    verdict: v.verdict,
    text: String(v.candidate?.text ?? '').slice(0, LOG_TEXT_CLIP),
    reason: String(v.reason ?? '').slice(0, LOG_REASON_CLIP),
  }));
}

/**
 * 把判定结果落成维度结果。
 *
 * @param {object} args
 * @param {object} args.dim 维度声明
 * @param {Array} args.candidates 候选
 * @param {Array|null} args.verdicts 重锚定后的判定；null = 本轮判定没跑成
 * @param {number} args.fileCount 源文件数（density 判分的分母）
 * @param {string|null} [args.na] 召回器给出的「无法判断」理由
 * @returns {{score:number|null, status:string, issues:Array, verdictLog:Array, reason:string}}
 */
export function evaluateAudit({ dim, candidates = [], verdicts = null, fileCount = 0, na = null } = {}) {
  if (na) {
    return { score: null, status: 'na', issues: [], verdictLog: [], reason: na };
  }

  // 候选为 0 → 不调 LLM，结论已经确定（本维度满分）。发请求纯属烧额度。
  // 注意这与 na 是两件事：na 是「没法判断」，这里是「查过了，没有可疑项」
  if (!candidates.length) {
    return { score: 100, status: 'done', issues: [], verdictLog: [], reason: '' };
  }

  if (!verdicts) {
    // partial：手上没有可信判定，分数留空而不是给个保守估计。
    // 一个未经分析的「80 分」和一个真分析出来的「80 分」在用户眼里毫无区别，
    // 会把「没查」伪装成「查过没问题」。宁可让这一维不计入总分，也不制造假确定性
    return {
      score: null,
      status: 'partial',
      issues: [],
      verdictLog: [],
      reason: `AI 判定未完成（${candidates.length} 条候选未判），本维度不计入总分`,
    };
  }

  const issues = [];
  for (const v of verdicts) {
    const spec = dim.verdicts[v.verdict];
    if (!spec || !spec.weight) continue;
    issues.push({
      code: spec.code,
      severity: spec.severity,
      file: v.file,
      line: v.line,
      message: v.reason || '（模型未给出理由）',
      // 自动修复能力由维度的 fix 策略决定，不由单条 issue 决定——
      // 与 rules/map 维度的 `fixable` 语义不同，那边是逐条判定的
      fixable: dim.fix !== 'advisory',
      fixHint: v.suggestion || '',
      meta: { verdict: v.verdict, ...(v.candidate?.meta || {}) },
    });
  }

  return {
    score: scoreOf(dim, verdicts, fileCount),
    status: 'done',
    issues,
    verdictLog: buildVerdictLog(verdicts),
    reason: '',
  };
}

/**
 * 把 augment 型条目的结果并进宿主维度。
 *
 * ## 为什么需要「两层一维度」这个机制
 *
 * `hygiene` 的确定性规则刻意做成**零误报**（只认 `.jsonl`/`.log` 与 `tmp-|temp-|debug-` 前缀），
 * 代价是召回极低——`cobe-probe.tmp.mjs` 这类命名完全抓不到。但那层的零误报保证不能放宽：
 * 它没有 LLM 兜底，放宽就会直接误报给用户。
 *
 * 于是分成两层：确定性层保下限，LLM 层补召回，两者的结论合并展示。
 * 拆成两个独立维度会让 UI 出现两张几乎同名的卡片，用户不知道该看哪个；
 * 合并才是用户心里的那一个维度。
 *
 * ## 合并口径
 *
 * - **issues 直接拼接**：两层认的是不同的文件，不会重复（LLM 层的召回器
 *   已排除确定性层覆盖的形状，见 `recallSuspiciousTracked` 的 DETERMINISTIC_COVERED）。
 * - **扣分累加**：LLM 层的 score 是从 100 起扣的，所以它的扣分量是 `100 - score`。
 *   把这个扣分量再从宿主分数上扣掉，等于两层的问题都计了分。
 * - **augment 没跑成时宿主原样保留**：它是「补充」而不是「前提」，
 *   不该因为补充层失败就让宿主维度也失去结论。但要在 reason 里说明召回可能不全，
 *   否则用户会以为这个满分是完整检查过的。
 *
 * @param {object} host 宿主维度结果（可能是 na / done）
 * @param {object} aug augment 条目的结果
 * @returns {object} 合并后的新对象（不原地改写 host，调用方可能还持有它）
 */
export function mergeAugmentDim(host, aug) {
  if (!host) return aug || null;
  if (!aug || aug.status !== 'done') {
    return {
      ...host,
      reason: host.reason
        || (aug ? 'AI 深化检查未完成，本维度的召回可能不完整' : host.reason),
    };
  }

  // 宿主自己没跑出分（非 git 仓库等）时，补充层的分数也没有意义可加——
  // 直接沿用宿主的 na 状态，但把补充层的 issue 带上（如果有）
  if (host.status !== 'done' || typeof host.score !== 'number') {
    return { ...host, issues: [...(host.issues || []), ...(aug.issues || [])] };
  }

  const augDeduct = 100 - (typeof aug.score === 'number' ? aug.score : 100);

  return {
    ...host,
    score: Math.max(0, Math.min(100, host.score - augDeduct)),
    issues: [...(host.issues || []), ...(aug.issues || [])],
    verdictLog: [...(host.verdictLog || []), ...(aug.verdictLog || [])],
  };
}

/** 按固定大小切批。批之间互不依赖，引擎会限并发跑 */
export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

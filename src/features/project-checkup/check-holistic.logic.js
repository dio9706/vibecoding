/**
 * 维度「整体智能评估」的纯逻辑层：输入组装、模型输出校验、落成维度结果。
 *
 * ## 它和其它维度形状不同
 *
 * 其它十六个维度都是「静态召回 → 逐条判定」。这一维没有候选清单——
 * 它的输入是**其它维度的结论 + 项目结构轮廓**，要回答的是单个维度回答不了的问题：
 *
 *   - 这些问题里，哪几件**现在**最该做？（优先级需要横向比较才能得出）
 *   - 有没有两个维度的建议互相矛盾？（例：prompts 要求补充边界说明，docs 判定文档已过载）
 *   - 这个项目哪些地方做得好？（只报问题会让用户失去判断基准，也无从知道哪些约定该保持）
 *
 * ## 为什么它不参与总分
 *
 * 它评价的就是其它维度报出来的那批问题。计入总分等于把同一批问题数两遍，
 * 一个 map 分低的项目会因为 holistic 也提到地图问题而被扣第二次。
 * 注册表里刻意不给它 `weight`（见 registry.js 的注释）。
 */

/** topActions 的优先级 → issue 的严重度。名字与模型输出词表一致，两处必须对齐 */
const PRIORITY_SEVERITY = { now: 'error', next: 'warn', later: 'info' };

/** 每个维度在 prompt 里最多带几条 issue：够模型看出问题形状，不必整张清单喂进去 */
const ISSUES_PER_DIM = 4;

/** 单条 issue 摘要的截断长度 */
const MSG_CLIP = 180;

/**
 * 把项目结构摊成目录轮廓。
 *
 * 只给「前两段路径 + 文件数」而不是完整文件树：模型需要的是「这个项目大致怎么分模块」，
 * 而完整文件树对一个几百文件的项目会占掉几千 token，还会把注意力从维度结论上引开。
 * 真要看细节，它有只读工具可以自己去读。
 */
export function outlineOf(files = []) {
  const byDir = new Map();
  for (const f of files) {
    const parts = String(f.rel).split('/');
    const key = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    byDir.set(key, (byDir.get(key) || 0) + 1);
  }
  return [...byDir.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([dir, n]) => `- ${dir}（${n} 个源文件）`)
    .join('\n');
}

/**
 * 把各维度结论摘成模型能横向比较的形式。
 *
 * 带上 `source`（判据出处）是刻意的：模型据此知道每条结论的依据强度不同
 * ——OWASP 的判据和「本项目自己的约定」不是一个量级，排优先级时该有区别。
 */
export function summarizeDims(dims = {}, registry = []) {
  const lines = [];
  for (const dim of registry) {
    if (dim.id === 'holistic' || dim.augments) continue;
    const d = dims[dim.id];
    if (!d) continue;

    const score = typeof d.score === 'number' ? `${d.score} 分` : `无分（${d.status}）`;
    const head = `### ${dim.label}（${dim.id}）— ${score}，${d.issues?.length || 0} 个问题`;
    const meta = `判据出处：${dim.source}${typeof dim.weight === 'number' ? `；总分权重 ${dim.weight}` : ''}`;

    const issues = (d.issues || []).slice(0, ISSUES_PER_DIM)
      .map((it) => `  - [${it.severity}] ${it.file}:${it.line} ${String(it.message || '').slice(0, MSG_CLIP)}`);
    const more = (d.issues?.length || 0) > ISSUES_PER_DIM
      ? [`  - …还有 ${d.issues.length - ISSUES_PER_DIM} 条同类问题`] : [];

    lines.push([head, meta, ...issues, ...more].join('\n'));
  }
  return lines.join('\n\n');
}

/** 送进 prompt 的各段业务材料上限。够读懂做什么，不至于把维度结论挤出注意力 */
const README_CLIP = 2000;
const CONVENTIONS_CLIP = 2500;
const DEPS_LIMIT = 24;

/**
 * 组装「这个项目是做什么的」。
 *
 * ## 为什么这一段是整个维度的关键
 *
 * 没有它，模型手上只有目录名和一堆通用维度的扣分项，能给出的必然是通用建议
 * （「补测试」「拆长函数」）——而那些话另外十六个维度已经各自说过一遍了，
 * 这一维不该只是把它们重复一次并排个序。
 *
 * 有了业务语境，它才能给出**只对这个项目成立**的判断。举个具体差别：
 *   通用建议：「`run-claude.js` 有个 111 行的函数，建议拆分。」
 *   业务建议：「这是个长时任务执行台，用户会关着窗口等十几分钟。
 *             `settleRun` 里额度续跑与异常重试两条自愈路径挤在一个函数里，
 *             一旦续跑判断出错，用户看到的是任务静默消失——这是本产品最致命的失败形态。」
 * 后者才值得单独跑一次只读 agent。
 *
 * 四段材料各有分工：README 说「对外是什么」，约定文档说「内部怎么分工」，
 * 脚本说「实际怎么跑起来」，依赖说「技术域与外部集成」（`@larksuiteoapi` 一出现，
 * 模型就知道这东西要对接飞书，而那是目录名看不出来的）。
 */
export function buildBusinessContext(evidence) {
  const parts = ['## 先读懂这个项目是做什么的'];

  const readme = String(evidence?.readme?.text || '').trim();
  if (readme) {
    parts.push('', `### 项目自述（${evidence.readme.rel} 开头）`, '', readme.slice(0, README_CLIP));
  }

  const conventions = String(evidence?.conventions || '').trim();
  if (conventions) {
    parts.push('', '### 项目约定文档开头（通常含项目定位与模块职责）', '', conventions.slice(0, CONVENTIONS_CLIP));
  }

  const scripts = Object.entries(evidence?.manifest?.scripts || {});
  if (scripts.length) {
    parts.push('', '### 实际运行方式', '', scripts.map(([k, v]) => `- ${k} → ${v}`).join('\n'));
  }

  const deps = Object.keys(evidence?.manifest?.deps || {});
  if (deps.length) {
    parts.push(
      '',
      '### 关键依赖（透露技术域与外部集成）',
      '',
      deps.slice(0, DEPS_LIMIT).map((d) => `- ${d}`).join('\n')
        + (deps.length > DEPS_LIMIT ? `\n- …另有 ${deps.length - DEPS_LIMIT} 个` : ''),
    );
  }

  if (parts.length === 1) {
    // 一份材料都没有时如实说明，而不是让模型在空白上编一套业务理解
    parts.push('', '（这个项目没有 README、约定文档和依赖清单，请用 Read / Glob 自行探明它做什么。）');
  }

  return parts.join('\n');
}

/** 系统角色。允许它读代码，但明确「不要重做别人已经做过的判定」 */
export const SYSTEM_PROMPT = {
  type: 'custom',
  custom: [
    '你是这个项目的技术负责人，正在做整体评估并给出**针对本项目业务的**行动计划。',
    '',
    '你的产出必须建立在「这个项目是做什么的、它最怕什么」之上。',
    '各维度的通用扫描结论已经在用户消息里了——**把它们重复一遍排个序没有价值**，',
    '那些话每个维度自己都说过。你的价值在于：结合业务判断哪些问题在**这个项目里**真的致命，',
    '以及指出通用维度扫不出来、只有理解了业务才看得见的风险。',
    '',
    '你可以用 Read / Grep / Glob 读项目文件。**建议先读入口文件与核心模块**来确认你对业务的理解，',
    '再下判断；但不要重跑各维度的逐条判定。',
    '',
    '## 输出纪律（违反会让整次评估作废）',
    '',
    '探索过程中**不要输出任何 JSON 对象**，也不要贴带花括号的代码片段——',
    '答案是从你的全部输出里按结构抽取的，中途出现的对象会干扰抽取。',
    '想记录中间想法就用纯文本。最后一条消息只包含那一个 JSON 对象，',
    '不要解释文字，不要 markdown 代码围栏。',
  ].join('\n'),
};

/**
 * 组装 prompt。
 *
 * 「完成判据」这一项是刻意要求的：没有它，行动计划会退化成一堆「优化 X」「改进 Y」，
 * 用户做完也不知道算不算做完。要求写出可验证的完成条件，等于逼模型把建议具体到可执行。
 */
export function buildHolisticPrompt({ dimsSummary, outline, dir, business = '' }) {
  return [
    `项目路径：${dir}`,
    '',
    business,
    '',
    '## 项目结构轮廓',
    '',
    outline || '（没有可识别的源码目录）',
    '',
    '## 各维度的通用扫描结论（供参考，不要照抄）',
    '',
    dimsSummary || '（各维度都没有产出结论）',
    '',
    '## 你要产出什么',
    '',
    '1. `businessRead`：2-4 句话说出**这个项目是做什么的、它最怕什么**。',
    '   放在第一项是刻意的——后面每一条建议都要能追溯到它。',
    '   要具体到这个产品：「它把长时 AI 任务搬到网页执行，用户会关掉窗口等十几分钟，',
    '   所以最怕任务静默消失而界面显示正常」这样；而不是「它是个 Node 项目，最怕代码质量下降」。',
    '2. `score`：0-100 的整体健康分。**不要**简单平均各维度分数——那个平均分已经算好了。',
    '   你要给的是「作为这个项目的负责人，我对它的整体信心」，并在 `verdict` 里说明你为什么',
    '   高于或低于各维度的平均水平（例如：分散的小问题很多但核心链路清晰，我给的分会高于平均）。',
    '3. `verdict`：3-5 句话的总体判断。说清**结合这个项目的业务**，当前最大的风险是什么。',
    '4. `businessRisks`：**通用维度扫不出来、只有理解了业务才看得见的风险**（数组，1-4 条，可为空）。',
    '   这是本次评估最独特的产出，请认真想。它的形状是「这个项目的业务性质决定了某类问题特别致命，',
    '   而静态扫描看不见」，例如：跨进程共享状态却只有单进程的锁、长时任务没有中断点、',
    '   外部额度耗尽时没有降级路径、关键状态只存内存而进程会重启。',
    '   每条给 `what`（风险是什么、为什么在这个业务里致命）与 `evidence`（你在哪个文件里看到的）。',
    '5. `topActions`：3-5 件最该做的事，按优先级排序。每条必须给全五个字段：',
    '   - `title`：一句话说清做什么',
    '   - `why`：**为什么是现在做**，且必须落到**业务后果**——用户会遇到什么、哪条业务链路会断、',
    '     或「先做它能让后面几件事变简单」这类时序理由。',
    '     ⛔ 禁止写「提高可维护性」「代码更清晰」「符合最佳实践」这类放在任何项目上都成立的话。',
    '   - `files`：预计要动的文件或目录（数组，必须是上文出现过或你实际读过的真实路径）',
    '   - `done`：**可验证的完成判据**。「代码更清晰」不算，「`npm test` 全绿且',
    '     `src/store` 不再出现指向 `src/features` 的 import」才算',
    '   - `priority`：`now` / `next` / `later` 三档之一',
    '6. `contradictions`：跨维度互相矛盾的建议（数组，可为空）。每条给 `what` 与 `resolution`。',
    '7. `strengths`：这个项目做得好、应当**保持**的地方（数组，2-4 条，可为空）。',
    '   只报问题会让用户失去判断基准，也不知道哪些现有约定不该被后续改动破坏。',
    '',
    '## 输出格式',
    '',
    '严格输出一个 JSON 对象：',
    '{"businessRead":"...","score":72,"verdict":"...",'
      + '"businessRisks":[{"what":"...","evidence":"src/a.js"}],'
      + '"topActions":[{"title":"...","why":"...","files":["src/a.js"],'
      + '"done":"...","priority":"now"}],"contradictions":[{"what":"...","resolution":"..."}],'
      + '"strengths":["..."]}',
    '',
    '- `topActions` 至少 1 条、至多 5 条；`priority` 只能是 now / next / later。',
    '- 所有路径必须是本项目里真实存在的（拿不准就用 Read/Glob 核实，别编）。',
    '- 不要把「跑一次体检」「继续观察」这类元动作写进 topActions——用户要的是对代码做什么。',
    '- **自检标准**：如果你的某条建议换个项目也照样成立，那它就不该出现在这里',
    '  ——通用建议各维度已经给过了，这一维只输出「因为这个项目是做这个的，所以……」。',
  ].join('\n');
}

const PRIORITIES = new Set(['now', 'next', 'later']);

function cleanAction(a) {
  if (!a || typeof a !== 'object') return null;
  const title = String(a.title || '').trim();
  if (!title) return null;
  return {
    title,
    why: String(a.why || '').trim(),
    done: String(a.done || '').trim(),
    priority: PRIORITIES.has(a.priority) ? a.priority : 'next',
    files: Array.isArray(a.files) ? a.files.map((f) => String(f)).filter(Boolean).slice(0, 12) : [],
  };
}

/**
 * 校验并归一模型输出。
 *
 * 这里**不是**全有或全无：与逐条判定不同，行动计划的价值是可分的——
 * 5 条建议里有 1 条字段不全，另外 4 条依然可用。全批作废只会让用户什么都拿不到。
 * 但底线是「至少要有一条完整的 action」，否则这个维度没产出任何东西，判 partial 更诚实。
 *
 * @returns {object|null}
 */
export function validatePlan(data) {
  if (!data || typeof data !== 'object') return null;

  const topActions = (Array.isArray(data.topActions) ? data.topActions : [])
    .map(cleanAction).filter(Boolean).slice(0, 5);
  if (!topActions.length) return null;

  const score = Number(data.score);

  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null,
    verdict: String(data.verdict || '').trim(),
    // 业务理解与业务风险是这一维区别于「另外十六个维度的加权平均」的全部价值，
    // 但**不设为必填**：模型偶尔漏字段时，已有的 topActions 仍然可用，
    // 整条作废只会让用户什么都拿不到（与 topActions 至少一条的底线不同）
    businessRead: String(data.businessRead || '').trim(),
    businessRisks: (Array.isArray(data.businessRisks) ? data.businessRisks : [])
      .map((r) => ({ what: String(r?.what || '').trim(), evidence: String(r?.evidence || '').trim() }))
      .filter((r) => r.what).slice(0, 6),
    topActions,
    contradictions: (Array.isArray(data.contradictions) ? data.contradictions : [])
      .map((c) => ({ what: String(c?.what || '').trim(), resolution: String(c?.resolution || '').trim() }))
      .filter((c) => c.what).slice(0, 6),
    strengths: (Array.isArray(data.strengths) ? data.strengths : [])
      .map((s) => String(s).trim()).filter(Boolean).slice(0, 6),
  };
}

/**
 * 落成维度结果。
 *
 * topActions 与 contradictions 都变成 issue，这样它们会出现在 UI 的问题清单里
 * ——holistic 卡片如果只有一个分数和一段文字，用户不会去点开它，而这一维恰恰是
 * 「先看哪儿」的答案。issue 的 file 取 action 的第一个文件，让它可以被点开定位。
 *
 * @param {object|null} plan validatePlan 的产出；null = 调用失败
 * @param {string} [reason] 失败原因
 */
export function evaluateHolistic(plan, reason = '') {
  if (!plan) {
    return {
      score: null,
      status: 'partial',
      issues: [],
      verdictLog: [],
      reason: reason || 'AI 整体评估未完成，本维度不产出结论',
      plan: null,
    };
  }

  // 业务风险单独成 issue：它们是通用维度扫不出来的那一类，
  // 混在 action 里会被当成「第 N 件待办」，而它更像「你得知道这件事」
  // 用 || [] 兜住：validatePlan 一定会给这个字段，但本函数也被直接调用
  // （测试、以及将来可能的其它产出路径），拿一个手工构造的 plan 就会在这里炸
  const issues = (plan.businessRisks || []).map((r, i) => ({
    code: `G${i + 1}_BUSINESS_RISK`,
    severity: 'warn',
    file: r.evidence || '.',
    line: 1,
    message: `业务风险：${r.what}`,
    // 业务风险的处置是设计决策，不是机械修复
    fixable: false,
    fixHint: '',
    meta: { kind: 'business-risk' },
  }));

  issues.push(...plan.topActions.map((a, i) => ({
    code: `G${i + 1}_ACTION`,
    severity: PRIORITY_SEVERITY[a.priority] || 'info',
    file: a.files[0] || '.',
    line: 1,
    message: `[${a.priority}] ${a.title}｜为什么现在做：${a.why}`,
    // 这一维的修复动作是「把计划写成文件」，不是逐条改代码
    fixable: true,
    fixHint: a.done ? `完成判据：${a.done}` : '',
    meta: { kind: 'action', priority: a.priority, files: a.files, done: a.done },
  })));

  for (const [i, c] of plan.contradictions.entries()) {
    issues.push({
      code: `G${i + 1}_CONTRADICTION`,
      severity: 'warn',
      file: '.',
      line: 1,
      message: `跨维度矛盾：${c.what}`,
      fixable: false,
      fixHint: c.resolution,
      meta: { kind: 'contradiction' },
    });
  }

  return {
    score: plan.score,
    status: 'done',
    issues,
    verdictLog: [],
    // 业务理解放在 reason 最前：卡片的副标题就是它，用户第一眼该看到
    // 「这个工具真的读懂了我的项目」，而不是又一句通用点评
    reason: [plan.businessRead, plan.verdict].filter(Boolean).join(' '),
    plan,
  };
}

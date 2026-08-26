/**
 * 维度②：提示词质量——文件系统层 + LLM 判定层。
 *
 * 静态层（check-prompts.logic.js）只负责**召回**：把「措辞绝对且没写明适用边界」的条目全捞出来。
 * 这一层负责**判定**：把候选交给 LLM，区分「真的会诱发多余劳动」和「只是措辞绝对但判据客观」。
 *
 * 为什么这一步非 LLM 不可（事故背景）：
 *   「⛔ 禁止做出假设——具体结论必须给出 `文件:行号` 依据」
 * 和
 *   「禁止提交无法编译的代码（type-check 必须全绿）」
 * 在正则眼里长得一模一样——都是绝对化措辞、都没有范围限定词。但前者害死过人：它没区分
 * 「代码事实」与「需求输入」，AI 把用户在需求里直接给定的 agent code 也当成待验证假设，
 * 跑到另一个后端仓库翻数据库实体定义，一个定点改动跑了 20 分钟；后者完全合理——判据客观、
 * 可机器验证、没有解释空间。两者的差别是语义的，只有理解了语义才判得出来。
 *
 * 本模块不落盘：缓存通过入参 `cache` 传入、通过返回值 `cacheEntry` 传出，
 * 由上层编排决定要不要写进 optimize.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runClassifierOnce } from '../llm-classify.js';
import { logger } from '../../shared/logger.js';
import { findCandidates, evaluatePrompts, splitBlocks } from './check-prompts.logic.js';
import { computeFingerprint, isCacheValid } from './fingerprint.logic.js';

/**
 * 遍历时跳过的目录。
 *
 * 除了常规的构建产物/依赖目录，这里刻意加上 `worktrees`：`.claude/worktrees/` 下是 git worktree
 * 的完整签出副本，每个副本都带一整套 CLAUDE.md。实测 kxmall-app-ui 有 3 个 worktree，
 * 不排除的话 CLAUDE.md 数量从 20 涨到 22+（副本还会随分支增长）。这些副本的内容与主干高度重复，
 * 收进来只会产生指向临时分支的重复条目、白烧 LLM 额度，而用户根本不会去改临时分支里的提示词。
 */
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.expo', 'worktrees']);

/** 超过这个行数视为提示词文件过长（与 logic 层的 OVERSIZE_LINES 对齐） */
const OVERSIZE_LINES = 200;

/**
 * 重复条目的最短长度。太短的段落（「- 是」「必须」）在不同语境下重复出现是正常的，
 * 报出来只是噪声；只有成句的规则重复才值得提醒作者去重。
 */
const MIN_DUPLICATE_LEN = 12;

/**
 * 判定模型。null = 跟随会话默认模型（claude.js 对 falsy 的 model 会整个跳过该参数）。
 *
 * 原本选 haiku，理由是「难点不在推理深度而在判据是否说清楚，prompt 里口径和 few-shot 都给死了，
 * 剩下的是模式匹配」。**2026-08-24 实测证伪，已换回默认模型。** 三个症状同源于模型档位：
 *
 *   1. 判定不稳：同一输入连跑三次，over-broad 为 4/8/6；更要命的是条目层面——
 *      三次并集 9 条里只有 1 条三次都命中，A 和 C 两次基本「整批换人」。
 *      用户跑两次体检会看到两份几乎不相交的整改清单，比分数摆动更伤信任。
 *   2. 抽象判据学不会：加了 not-a-rule 这一档后，模型只会照抄 few-shot 里给的那条，
 *      换一条没见过的纯描述性条目（`✅ 整体风格关键词：深紫渐变主调…`）仍判 over-broad。
 *      即它没抓住「主语是代码还是作者」这条抽象判据，只学到了句式。
 *   3. 指令遵循度差：prompt 明确要求 over-broad 必须给 suggestion，6 条里 3 条没给。
 *
 * 对照组：同一次跑里非 LLM 路径的 P3_OVERSIZED_RULE 恒定 7 条，波动全部来自判定层。
 *
 * 成本：候选收窄到 39 条后单次约 4 批。haiku 单次 ~$0.15，默认模型约 10 倍。
 * 体检是低频操作且有指纹缓存（文件没变直接复用结果），这个代价可接受。
 */
const JUDGE_MODEL = null;

/**
 * 单批候选数上限。
 *
 * 为什么要分批：kxmall-app-ui 实测捞出 111 条候选，远超设计时预估的二十几条。
 * 一次性喂给模型，输出侧要生成上百条带 reason + suggestion 的判定，极易触发长度截断——
 * 而截断的 JSON 在 extractFirstJsonObject 里配不平大括号，整批直接返回 null（全军覆没）。
 * 分批把「一次截断毁全场」的风险切成小块，也让每批的输入上下文更短、判定更聚焦。
 *
 * 取 12 而不是 20：实测 20 条一批时，有一批连续两次都报 `Reached maximum number of turns (1)`
 * ——批量越大、清单越杂，模型越容易动「先去读一下原文件」的念头，而工具全被禁、一轮就用光了。
 */
const BATCH_SIZE = 12;

/**
 * 并发批数上限。
 *
 * 每批都会拉起一个独立的 Claude CLI 子进程，111 条候选 = 10 批全并发意味着同时 10 个进程，
 * 本机内存和 API 并发都吃不消。限到 4 路：10 批分 3 波跑完，总耗时仍在可接受范围。
 */
const MAX_CONCURRENCY = 4;

/**
 * 单批超时预算。
 *
 * 默认的 30s 是给「一句话分类」设计的；这里每批要读 20 条规则并各写一段具体的 reason，
 * 输出 token 量高一到两个数量级，30s 必然不够。
 *
 * 2026-08-25 从 120s 提到 300s。原值是按 haiku 校准的，换成默认模型后每批实测
 * 60/94/114/127/127/127 秒——日志里三批赫然是 `✔ runClaude {"ms":127093}`，
 * 即**模型成功返回了，但 race 在 122s（budget+2s）就放弃**，`out` 只拿到半截流，
 * extractFirstJsonObject 配不平大括号 → null → 重试再超 → 整批废 → 整个维度 partial。
 * 而 partial 的维度会被 aggregateScore 踢出总分，等于功能没有。
 *
 * 教训：超时预算是**模型速度的依赖变量**，换模型档位必须同步重校准，
 * 否则测到的是超时扛不住，而不是模型判定质量。
 */
const BATCH_TIMEOUT_MS = 300_000;

/**
 * 合法 verdict 白名单。
 *
 * `not-a-rule` 是 2026-08-25 加的第四种：静态层原理上分不出「描述代码已有行为」和「要求作者的行为」——
 * `sid 归属校验必须先确认 uid 已就绪`（描述 canVerifyOwnership 的既有实现）和
 * `v-show 必须套在原生 <view> 上`（要求作者这么写）在任何静态特征上都完全同构：
 * 同一节、同为列表项、同为粗体开头祈使、义务词位置几乎相同。差别纯在语义，只能让 LLM 自己认出来。
 *
 * 注意这个 Set 是**全有或全无**校验的一部分：模型吐出不在表里的 verdict 会让整批判定作废，
 * 所以新增 verdict 必须同时改提示词和这里，漏一处就是整批失败。
 * 下游 evaluatePrompts 只对 over-broad / conflicting 扣分建 issue，其余 verdict 天然被忽略。
 */
const VALID_VERDICTS = new Set(['over-broad', 'acceptable', 'conflicting', 'not-a-rule']);

/** 候选原文在 prompt 里的截断长度：够判定语义即可，续行里的长代码块没必要整段喂进去 */
const TEXT_CLIP = 400;

/**
 * 收集扫描范围内的提示词文件。
 *
 * 范围口径：
 * - 各级 `CLAUDE.md` / `CLAUDE.local.md`：递归找，因为模块级地图散落在各子目录
 * - `.claude/rules/*.md`、`.claude/skills/*\/SKILL.md`：只认项目根下这两处约定位置，不递归
 *
 * @param {string} projectDir
 * @returns {Array<{full:string, rel:string}>} rel 统一用正斜杠，供回报定位
 */
function collectPromptFiles(projectDir) {
  const out = [];
  const seen = new Set();
  const add = (full, rel) => {
    const key = path.resolve(full);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ full, rel: rel.replace(/\\/g, '/') });
  };

  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIR.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(full, r); continue; }
      if (e.name === 'CLAUDE.md' || e.name === 'CLAUDE.local.md') add(full, r);
    }
  };
  walk(projectDir, '');

  // .claude/rules/*.md
  const rulesDir = path.join(projectDir, '.claude', 'rules');
  try {
    for (const n of fs.readdirSync(rulesDir)) {
      if (n.toLowerCase().endsWith('.md')) add(path.join(rulesDir, n), `.claude/rules/${n}`);
    }
  } catch { /* 没有 rules 目录是常态 */ }

  // .claude/skills/*/SKILL.md
  const skillsDir = path.join(projectDir, '.claude', 'skills');
  try {
    for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const full = path.join(skillsDir, e.name, 'SKILL.md');
      if (fs.existsSync(full)) add(full, `.claude/skills/${e.name}/SKILL.md`);
    }
  } catch { /* 没有 skills 目录是常态 */ }

  return out;
}

/** 读 stat 供指纹计算；读不到的文件直接排除（它也进不了后续分析） */
function statFiles(files) {
  const stats = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f.full);
      stats.push({ path: f.rel, mtime: st.mtimeMs, size: st.size });
    } catch { /* 竞态删除等，跳过 */ }
  }
  return stats;
}

/** 归一化用于重复检测：吃掉列表标记、空白差异和 emoji 级别标记的影响 */
function normalizeForDup(text) {
  return String(text ?? '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 找出同一文件内重复出现的条目。
 *
 * 只在文件内部比对、不跨文件：跨文件的「重复」往往是模块地图刻意复述根规则，是设计而非缺陷；
 * 而同一文件里同一句话出现两次，基本可以断定是复制粘贴留下的。
 *
 * @returns {Array<{file:string, text:string, lines:number[]}>}
 */
function findDuplicateGroups(md, rel) {
  const byText = new Map();
  for (const b of splitBlocks(md)) {
    const key = normalizeForDup(b.text);
    if (key.length < MIN_DUPLICATE_LEN) continue;
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push(b.line);
  }
  const groups = [];
  for (const [text, lines] of byText) {
    if (lines.length > 1) groups.push({ file: rel, text, lines });
  }
  return groups;
}

/**
 * 判定角色设定。
 *
 * 「你没有任何工具」这段是实测逼出来的，不是保险话术：
 * 跑 kxmall-app-ui 时，某批候选（`- 切换操作: 必须包含 \`is_selecting\` / \`new_state\`` 这类
 * 脱离上下文看不懂的片段）让 haiku 先输出「让我读取源文件以获取完整上下文」，
 * 然后调 `ToolSearch` 去把 `Read` 捞出来 —— runClassifierOnce 的 disallowedTools 列了
 * Read/Grep/Bash 却没列 ToolSearch，这次调用畅通无阻地消耗掉了 maxTurns=1 的唯一一轮，
 * SDK 报 `error_max_turns`、result 为空串，整批判定作废（连试两次都一样）。
 *
 * 所以必须在提示词层面掐掉「去读文件」这个念头本身，而不是指望工具黑名单拦得住。
 * 同时告诉模型「上下文不足时怎么办」——不给出路，它就还是会想去找上下文。
 */
const SYSTEM_PROMPT = {
  type: 'custom',
  custom:
    '你是 AI 协作提示词（CLAUDE.md / 规则文件 / SKILL.md）的规则审查员。\n' +
    '你唯一关心的问题是：这条规则会不会让 AI 在真实任务里做出「与当前任务无关的多余劳动」。\n' +
    '你没有任何工具，也没有文件系统访问权限。禁止调用工具、禁止尝试读取文件、禁止搜索工具——\n' +
    '任何一次工具调用都会让整批判定作废。你能看到的全部信息就是用户消息里给出的文本。\n' +
    '只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码围栏。',
};

/**
 * 构造判定 prompt。
 *
 * 三个刻意的设计：
 * 1. **要求返回 `{"verdicts":[...]}` 对象包数组，而不是裸数组**。runClassifierOnce 用大括号计数
 *    提取首个 JSON **对象**，模型若吐 `[{...}]` 会被截成第一个元素，等于整批判定丢失。
 * 2. **一正一反两个 few-shot 都要给**。只给反例会让模型把清单里所有「禁止」一律判成过度——
 *    这是这类判定任务最常见的偏置，而候选恰恰全都是「禁止/必须」开头的。
 * 3. **reason 必须落到「AI 会多做哪件事」**。「表述宽泛」这种空话对使用者没有任何修改指引，
 *    而且写得出具体多余动作本身就是 over-broad 的验证条件——写不出来说明这条其实没问题。
 * 4. **not-a-rule 的两个示例必须成对给（C 描述 / D 要求）**。单给一个描述性反例，模型学到的是
 *    「带这种句式的判 not-a-rule」，会把真规则一起误杀；成对给才逼它去看主语是代码还是作者。
 *    这两条是静态层承认自己分不出来的那一类（见 VALID_VERDICTS 注释），提示词是唯一的拦截点。
 */
function buildPrompt(batch) {
  const list = batch
    .map((c, i) => `[${i + 1}] file=${c.file} line=${c.line}\n${String(c.text).slice(0, TEXT_CLIP)}`)
    .join('\n\n');

  return [
    '下面是从项目提示词里捞出的候选规则（措辞绝对、且没有写明适用边界）。请逐条判定。',
    '',
    '## 判定口径',
    '',
    '- `not-a-rule`：这条根本**不是下达给 AI 的行为要求**，而是在**描述代码现状、解释设计原因或说明既有约束**。',
    '  哪怕它用了「必须 / 禁止」这类字眼，主语也是代码而不是你。',
    '- `over-broad`：规则的**判定标准本身依赖解释**，AI 无法直接确认自己是否达标，',
    '  于是会为了保险起见去做范围外的调查、验证或补充工作。',
    '- `acceptable`：规则虽然措辞绝对，但**判据客观、可直接验证、没有解释空间**，',
    '  AI 一眼就知道自己合不合规，不会因此多做任何事。',
    '- `conflicting`：与本清单中另一条规则互相矛盾，AI 无论怎么做都会违反其中一条',
    '  （必须在 reason 里指明与哪一条冲突）。',
    '',
    '**判定顺序：先问「这是不是一条要求」，再问「这条要求好不好」。**',
    '只要判定为 `not-a-rule`，就不必再考虑它宽不宽泛——描述性文字谈不上宽泛与否。',
    '',
    '**绝对化措辞本身不是问题。**「禁止 / 必须 / 一律 / MUST」在工程规范里绝大多数是合理且必要的。',
    '判 `over-broad` 的唯一门槛是：你能**具体说出 AI 会因此多做哪一件事**。',
    '说不出具体的多余动作，就必须判 `acceptable`。',
    '',
    '候选是从文件里逐条截出来的片段，**有些脱离上下文会看不太懂，这是正常的**。',
    '这种情况直接判 `acceptable`（看不出它会诱发多余劳动），reason 里写明「片段信息不足以判定其有害」即可。',
    '**绝对不要为了补上下文去读文件或调工具**——你没有这个能力，尝试一次就会让这一整批判定全部作废。',
    '',
    '## 示例',
    '',
    '### 示例 A —— 判 over-broad',
    '原文：`⛔ 禁止做出假设——具体结论必须给出 \\`文件:行号\\` 依据`',
    'verdict: `over-broad`',
    'reason: 没有区分「代码事实」和「用户在需求里直接给定的输入」。真实后果：用户已在需求中写明 agent code 的值，',
    'AI 仍把它当成待验证假设，跑到另一个后端仓库翻数据库实体定义找出处，一个定点改动因此耗时 20 分钟。',
    'suggestion: 禁止对**代码现状**做出假设——涉及代码行为的结论必须给出 `文件:行号` 依据；',
    '但用户在需求里直接给定的值、外部系统返回的数据不在此列，直接采信即可。',
    '',
    '### 示例 B —— 判 acceptable',
    '原文：`禁止提交无法编译的代码（type-check 必须全绿）`',
    'verdict: `acceptable`',
    'reason: 判据客观且可机器验证——跑一次 type-check 就有确定答案，没有解释空间，不会诱发任何范围外的调查或反查。',
    '',
    '### 示例 C —— 判 not-a-rule（描述代码现状）',
    '原文：`sid 归属校验必须先确认 uid 已就绪`',
    'verdict: `not-a-rule`',
    'reason: 这是在描述代码里 `canVerifyOwnership` 已有的执行顺序（它内部就是先等 uid 再校验 sid），',
    '属于对既有实现的说明，不是要求作者去做什么。「必须」的主语是那段代码，不是 AI。',
    '',
    '### 示例 D —— 对照：同样句式，但判 acceptable（是真的规则）',
    '原文：`v-show 必须套在原生 \\`<view>\\` 上`',
    'verdict: `acceptable`',
    'reason: 主语是写代码的人——它要求作者今后写 v-show 时必须这么写，是一条真实的行为约束；',
    '且判据客观（看一眼 v-show 挂在哪个标签上即可），不会诱发范围外劳动。',
    '',
    '**示例 C 和 D 在字面上几乎同构**（同为列表项、同为祈使句、义务词位置相同），',
    '唯一的区别是：C 在陈述「代码本来就是这样运行的」，D 在要求「你以后要这样写」。',
    '判不准时用这个测试：把它交给一个正在写新代码的 AI，它能不能照着**做**一个动作？',
    '能 → 是规则；只能照着**理解**代码为什么长这样 → `not-a-rule`。',
    '',
    '## 输出格式',
    '',
    '严格输出一个 JSON 对象（注意 verdicts 是对象的字段，不要直接输出数组）：',
    '{"verdicts":[{"line":12,"file":"CLAUDE.md","verdict":"over-broad","reason":"...","suggestion":"..."}]}',
    '',
    '- 必须为下面**每一条**候选各输出一条判定，一条不漏；`line` 与 `file` 按候选原样回填。',
    '- `verdict` 只能是 `over-broad` / `acceptable` / `conflicting` / `not-a-rule` 四者之一，',
    '  写成别的值会让这一整批判定全部作废。',
    '- 判 `over-broad` 时，`reason` 必须描述「AI 会因此多做哪一件事」的具体场景，',
    '  禁止写「表述宽泛」「不够明确」这类空话；判 `not-a-rule` 时，`reason` 写明它在描述什么即可。',
    '- `suggestion` 只有 `over-broad` 需要：保留原意、补上范围限定的改写建议；其余可省略。',
    '',
    '只有 `over-broad` 和 `conflicting` 会被计入扣分并展示给用户。',
    '`acceptable` 和 `not-a-rule` 都不扣分、也不会出现在问题清单里——',
    '所以碰到「像是描述而不是要求」的条目，放心判 `not-a-rule`，不会有任何副作用。',
    '',
    `## 候选清单（共 ${batch.length} 条）`,
    '',
    list,
  ].join('\n');
}

/**
 * 校验模型返回的一批判定。
 *
 * 全有或全无：只要有一条不合法就整批作废。
 * 为什么不修补：这一层的输出会直接变成给用户看的「你的规则有问题」结论，
 * 一条结构都对不上说明模型这次没按格式走，剩下那些「看起来合法」的条目同样不可信；
 * 挑着用等于把噪声当结论展示，比老老实实报 partial 危险得多。
 *
 * @returns {Array|null} 合法则返回判定数组，否则 null
 */
function validateVerdicts(raw, expectedCount) {
  if (!raw || !Array.isArray(raw.verdicts)) return null;
  const list = raw.verdicts;
  if (list.length === 0) return null;
  // 条数必须对得上。原实现只校验「非空 + 每条结构合法」，模型只判 12 条里的 3 条也照样放行——
  // 剩下 9 条既不在 verdicts 里、也就不会产出 issue，被**静默当成 acceptable**，而 status 仍是 done。
  // 这个组合能通过大括号计数（JSON 对象本身是完整的，只是条目不全），所以截断检测挡不住它。
  // 后果是「0 over-broad」这种结果无法区分「都合格」和「模型漏判了大半」。
  if (typeof expectedCount === 'number' && list.length !== expectedCount) return null;
  for (const v of list) {
    if (!v || typeof v !== 'object') return null;
    if (!VALID_VERDICTS.has(v.verdict)) return null;
    if (typeof v.line !== 'number' || !Number.isFinite(v.line)) return null;
  }
  return list;
}

/**
 * 判定一批候选（失败重试一次）。
 *
 * 为什么要重试：实测同一份 prompt 连跑两次，第一次模型返回空文本（SDK 报 success、也计了费，
 * 但 onText/onResult 都没拿到内容），第二次完全正常。这种瞬时空响应本身不可控，
 * 但它撞上「任何一批失败 → 整体 partial」的全有或全无策略后果被放大：
 * 6 批并行时，单批 p 的失败率会放成 1-(1-p)^6。重试一次把这个概率压回可接受范围。
 *
 * 只重试一次：真正的失败原因（额度耗尽、限流）重试也不会好转，多试只是让用户多等两分钟。
 *
 * @returns {Promise<Array|null>} null 表示这批失败（超时/额度耗尽/结构不合法）
 */
async function judgeBatch(batch, index) {
  const prompt = buildPrompt(batch);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const raw = await runClassifierOnce({
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      model: JUDGE_MODEL,
      logTag: `checkup/prompts#${index}`,
      timeoutMs: BATCH_TIMEOUT_MS,
    });
    const list = raw ? validateVerdicts(raw, batch.length) : null;
    if (list) return list;
    logger.warn('check-prompts', 'LLM 判定失败（无输出或结构不合法）', {
      batch: index,
      attempt,
      size: batch.length,
      got: raw ? JSON.stringify(raw).slice(0, 200) : null,
    });
  }
  return null;
}

/** 限并发版 Promise.all：保持结果与入参同序，避免一次拉起过多 Claude 子进程 */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * 把模型返回的判定重新锚定到真实候选上。
 *
 * 模型回填的 `file` 可能拼错或省略，而 evaluatePrompts 只按 `line` 建索引——
 * 多文件场景下同一个行号会在不同文件里重复出现，光靠 line 无法区分。
 * 这里用 (file, line) 精确匹配一次，匹配上就以我们自己的候选表为准覆盖 file，
 * 保证展示给用户的定位信息来自磁盘事实而不是模型记忆。
 */
function reanchor(verdicts, candidates) {
  const exact = new Map(candidates.map((c) => [`${c.file}#${c.line}`, c]));
  const byLine = new Map();
  for (const c of candidates) if (!byLine.has(c.line)) byLine.set(c.line, c);

  return verdicts.map((v) => {
    const hit = exact.get(`${v.file}#${v.line}`) || byLine.get(v.line);
    return {
      line: v.line,
      file: hit?.file ?? v.file ?? null,
      verdict: v.verdict,
      reason: typeof v.reason === 'string' ? v.reason : undefined,
      suggestion: typeof v.suggestion === 'string' ? v.suggestion : undefined,
    };
  });
}

/**
 * 维度②入口：提示词质量体检。
 *
 * @param {string} projectDir 项目根目录
 * @param {object} [opts]
 * @param {{fingerprint:string, result:object}|null} [opts.cache] 上次的缓存条目（由上层持久化后传入）
 * @param {boolean} [opts.force] 忽略缓存强制重跑
 * @returns {Promise<{score:number, status:string, issues:Array, cached:boolean,
 *   cacheEntry:{fingerprint:string, result:object}|null, fingerprint:string}>}
 *   `cacheEntry` 即下次要传回 `opts.cache` 的东西；status 非 done 时为 null（见下方说明）
 */
export async function checkPrompts(projectDir, { cache = null, force = false } = {}) {
  const files = collectPromptFiles(projectDir);
  const fingerprint = computeFingerprint(statFiles(files));

  if (!force && isCacheValid(cache, fingerprint)) {
    return { ...cache.result, cached: true, cacheEntry: cache, fingerprint };
  }

  const candidates = [];
  const oversizedFiles = [];
  const duplicateGroups = [];

  for (const f of files) {
    let md;
    try { md = fs.readFileSync(f.full, 'utf8'); } catch { continue; }
    candidates.push(...findCandidates(md, f.rel));
    const lines = md.split(/\r?\n/).length;
    if (lines > OVERSIZE_LINES) oversizedFiles.push({ file: f.rel, lines });
    duplicateGroups.push(...findDuplicateGroups(md, f.rel));
  }

  // 候选为 0 → 不调 LLM。没有可疑条目，结论已经确定（本项满分），发请求纯属烧额度。
  if (candidates.length === 0) {
    const result = evaluatePrompts({ candidates, oversizedFiles, duplicateGroups });
    return finish(result, fingerprint, candidates.length, 0);
  }

  const batches = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) batches.push(candidates.slice(i, i + BATCH_SIZE));

  // 限并发跑各批：批之间互不依赖，串行会把耗时线性放大（111 条 = 10 批 × 最长 2 分钟）。
  const results = await mapLimited(batches, MAX_CONCURRENCY, (b, i) => judgeBatch(b, i + 1));

  // 任何一批失败 → 整体走 partial。
  // 不做「部分判定 + 部分未判定」的混合态：evaluatePrompts 的语义是二元的（有 verdicts 就认为
  // 全部候选都判过了），塞半份进去会让没判过的候选被静默当成 acceptable，凭空抬高分数。
  const failed = results.some((r) => r === null);
  const verdicts = failed ? null : reanchor(results.flat(), candidates);

  const result = evaluatePrompts({ candidates, oversizedFiles, duplicateGroups, verdicts });
  return finish(result, fingerprint, candidates.length, batches.length);
}

/**
 * 收尾：附上缓存条目和统计信息。
 *
 * 只有 status === 'done' 才产出 cacheEntry。partial 意味着这次 LLM 没跑成，
 * 分数是「假设候选全有问题」的保守占位值——把它缓存下来，用户下次点体检会拿到同一个
 * 错误结论且再也不会重试（指纹没变 → 永久命中），失败就被固化了。
 */
function finish(result, fingerprint, candidateCount, batchCount) {
  const cacheEntry = result.status === 'done' ? { fingerprint, result } : null;
  return { ...result, cached: false, cacheEntry, fingerprint, candidateCount, batchCount };
}

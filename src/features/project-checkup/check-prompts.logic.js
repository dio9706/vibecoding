/**
 * 维度②：提示词质量——静态候选捞取 + 判分。
 *
 * 这一层不调 LLM，只做纯文本处理。它的职责是「把可疑的条目捞出来」，而不是「判定它合不合理」。
 *
 * 为什么这么分层：过度宽泛的规则之所以有害，不在于它用了绝对化措辞，而在于**措辞与适用边界不匹配**。
 * 真实反例（kxmall-app-ui CLAUDE.md）：
 *   「⛔ 禁止做出假设——具体结论必须给出 `文件:行号` 依据」
 * 这条没区分「代码事实」和「需求输入」，导致 AI 把用户在需求里直接给定的 agent code 也当成
 * 待验证假设，跑去另一个后端仓库翻数据库实体定义，一个定点跳转改动跑了 20 分钟。
 * 同一份文件里的「禁止提交无法编译的代码」措辞同样绝对，却完全合理——判据客观、可机器验证、
 * 没有解释空间，不会诱发额外劳动。
 *
 * 两者的差别是语义的，正则区分不了。所以静态层只负责**召回**（宁可多捞，不能漏），
 * 「绝对化措辞 + 无范围限定」是一个高召回的粗筛条件；精确判定交给下一层 LLM。
 */

/**
 * 义务词（deontic）：在向读者下达要求，且不给例外留口子。
 *
 * 这里**刻意不收 `所有`**。实测（kxmall-app-ui 全量 111 条候选）里，`所有` 有 26 次是纯数量词，
 * 出现在描述性正文里：「页面用的所有聊天 UI」「找到所有子节点」「挡在所有副作用之前」——
 * 它陈述的是「全集」，不是「你必须」。这 26 条全部是假阳性，占静态层噪声的最大单一来源。
 * `所有` 只在与真义务词共现时随之被捞出（由义务词立案），它自己不立案。
 */
const ABSOLUTE_ZH = ['禁止', '严禁', '不允许', '不得', '必须', '一律', '永远不', '任何情况下'];

/**
 * 英文绝对词只认全大写形式。
 * 因为 must / never / always 的小写形态在普通英文散文里极常见（"you must call it after mount"
 * 只是陈述而非禁令），而 CLAUDE.md 类文档约定用全大写表示强制级别，大写形态的信噪比高得多。
 */
const ABSOLUTE_EN = ['MUST', 'NEVER', 'ALWAYS'];

/**
 * 范围限定词白名单：出现即说明作者已经意识到边界并写明了例外。
 *
 * 这里刻意**不收** `范围`。它在中文里绝大多数时候是描述性名词（「影响范围较大」「范围广」），
 * 而不是在划定适用边界。误收的代价是不对称的：多一个限定词会**豁免掉真候选**（假阴性，
 * 真问题被静默漏掉、永远到不了 LLM 那层），而少一个限定词最多只是多捞一条（假阳性，
 * 下一层判一下就过滤掉）。漏报比误报危险，所以宁可收窄白名单。
 */
const QUALIFIER_ZH = ['但', '除非', '仅当', '例外', '不适用于', '以下情况', '除了'];
const QUALIFIER_EN = ['unless', 'except'];

/** 列表项标记：`-` / `*` / `+` / `1.` / `1)` */
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * 条目正文前的装饰：列表标记、序号、引用符、粗体/代码强调符。
 * 剥掉它们才能看到「这一条真正的第一个字」。
 */
const LEAD_DECORATION = /^[\s\-*+>]*(?:\d+[.)])?[\s*_`~]*/;

/**
 * 强制级别标记符。作者亲手打上 ⛔ / ✅ 就是在声明「这是一条硬规矩」，
 * 这个信号比任何句法特征都可靠，所以它**独立立案**：带标记的条目直接进候选，
 * 既不受章节和首句限制，也不要求正文里另有绝对化措辞。
 *
 * 最后这点是实测逼出来的。`⛔ 禁用 easycom 自动注册`、`⛔ 普通表单页根容器用 position:fixed`、
 * `✅ 优先复用 src/components/` 这类条目一个绝对词都没有，纯靠标记表达强制级别，
 * kxmall-app-ui 里有 13 条。要求「另有绝对词」会把它们全漏掉——而漏报比误报危险得多：
 * 漏掉的是真问题，多捞的下一层 LLM 判一下就过滤了。
 *
 * 刻意不收 ⚠️：实测它在描述性正文里用得同样多（「⚠️ 曾经还有第四环…」「⚠️ 不在这个目录里」），
 * 表达的是「注意看」而不是「必须照做」。
 */
const MANDATE_MARKER = new RegExp(`${LEAD_DECORATION.source}[⛔\u{1F6AB}❌✅]`, 'u');

/**
 * 句子边界。破折号也算——中文技术文档里 `——` 后面几乎总是转入解释。
 * 冒号和分号**不算**：`- 后端仓库 \`compass-agent\`：**只读参考，禁止修改**` 这种
 * 「主题：条款」写法极常见，按冒号切会把条款本体切掉。
 */
const SENTENCE_END = /[。！？]|——/;

/** 括号内是出处、补充、代码片段，不是条款本体 */
const PARENTHETICAL = [/（[^（）]*）/g, /\([^()]*\)/g, /【[^【】]*】/g];

/**
 * 「非规范区」章节的标题特征。命中的章节里，作者写的是知识而不是条款。
 *
 * ⚠️ **这条判据依赖章节命名习惯，跨项目可能失效**——它不是通用语言学规则，
 * 而是从 kxmall-app-ui 的文档模板归纳出来的。词表按语义类目铺开（而不是照抄
 * 那个项目的标题原文）只能降低失效概率，不能消除。后来人别把它当成普适规律：
 * 换一套文档模板（比如小节直接叫 `## 组件` `## 路由`）时它基本不起作用，
 * 那时静态层会退化回「形态判据 only」，多捞一些但不会漏。
 *
 * 为此留了两个安全阀，任一命中就绕过本判据：
 *   1. 带 ⛔/✅ 强制标记 —— 作者的显式声明优先于章节位置
 *   2. **以义务词开头**的祈使句（`- **必须显式 import**`）—— 形态上已无可争议
 *
 * 两类依据：
 * A. 说明区。模块级 CLAUDE.md 的 `这是什么`/`关键机制`/`关键流程` 共产出 26 条候选，
 *    人工核对只有 4 条是规则，其余全是「地图里带必须二字的说明文字」
 *    （「分包必须至少有一个页面才合法」是在讲平台约束，不是在要求 AI 做什么）；
 *    skill 的 `执行流程 > Step N` 同理，18 条里一条真规则都没有。
 * B. 经验区（`容易踩的坑`/`陷阱`/`注意事项`）。这些条目本身是**知识**——「这个 API 有这个坑」，
 *    而且作用域已被 `v-show`、`pages.json`、`biz_mode` 这类具体符号钉死，
 *    语义上不可能「过度宽泛」，送进 LLM 只是烧额度。真要当硬规矩的，作者会打 ⛔/✅，
 *    那条会被安全阀 1 救回来。这个分层是刻意的：作者标了强制的一定查，没标的不查。
 */
const DESCRIPTIVE_HEADING =
  /(这是什么|是什么|关键机制|关键流程|工作机制|执行流程|工作流程|目录结构|结构说明|术语|名词解释|背景|概述|简介|跟其他模块|与其他模块|代码示例|示例代码|使用示例|参考资料|参考链接|延伸阅读|坑|陷阱|注意事项|Step\s*\d|步骤\s*\d)/i;

/**
 * 解释性开场：这些写法把义务词降格成「被解释的对象」而不是「被下达的要求」。
 * `为什么门禁必须落在服务层` 是在讲设计理由，`这里的 await 是必须的` 是在讲代码事实。
 */
const EXPLANATORY = /(为什么|必须的)/;

/**
 * 因果连接词。出现在义务词**之前**，说明这条义务是从前面的事实推出来的后果，
 * 整段的重心是「解释现象」而非「立规矩」：
 * 「重设 canvas.width/height 会清掉 ctx 的状态，**所以** ctx.scale() 必须放在它后面」。
 *
 * 刻意不收 `会`：它在「新会话」「机会」「体会」里都出现，误伤率高得离谱。
 */
const CAUSAL = /(所以|因为|因此|由于)/;

/** 代码围栏标记 */
const FENCE = /^\s*```/;
/** markdown 表格行 */
const TABLE_ROW = /^\s*\|/;
/** ATX 章节标题 */
const HEADING = /^\s*(#{1,6})(?:\s+(.*))?$/;
/** frontmatter 分隔线 */
const FM_FENCE = /^---\s*$/;

/** 超过这个行数的提示词文件视为过长 */
const OVERSIZE_LINES = 200;

const DEDUCT_OVER_BROAD = 8;
const DEDUCT_CONFLICTING = 12;
const DEDUCT_UNJUDGED_CANDIDATE = 4;
const DEDUCT_OVERSIZED = 5;
const DEDUCT_DUPLICATE = 3;

/**
 * 把 markdown 切成「段落」。
 *
 * 切分口径：空行分隔的块算一段；但列表项每一项单独算一段。
 * 之所以对列表项特殊处理：规则清单几乎都写成一条一行的列表，若按空行切，
 * 整个清单会糊成一大块，任何一条带了「但」都会把同块里其它无限定的条款一起豁免掉（假阴性），
 * 而报出来的行号也只能指向块首，对使用者没有定位价值。
 *
 * 反过来，列表项的**续行必须并回本项**。实测依据（kxmall-app-ui CLAUDE.md L209-211）：
 * 「禁止做出假设」的修复版把边界说明写在了第 2 行的「但需求里用户给定的值…」上。
 * 若按行切，首行会变成假阳性——一条已经修好的规则被反复报出来。
 *
 * 另外跳过三类**本质不是规则语句**的行：代码围栏内容、表格行、章节标题。
 * 它们即使命中绝对词也没有判定价值——用户没法「改进」一个章节标题或表头，
 * 报出来只会白烧下一层 LLM 的额度。实测这三类占候选总量的 27.6%。
 *
 * 文件头部的 YAML frontmatter 整块跳过：SKILL.md 的 `name` / `description` 是给
 * 加载器读的元数据，`description` 里为了触发词覆盖率常写「…禁止…」「…所有…」，
 * 实测 6 个 skill 每个都因此各贡献一条纯噪声候选。
 *
 * 每个段落带上它所属的**标题链**（`一级 > 二级 > 三级`），供 findCandidates 判断
 * 这段话是写在规范区还是说明区。
 *
 * @param {string} md
 * @returns {Array<{text:string, line:number, heading:string}>} line 为 1-based 起始行号
 */
export function splitBlocks(md) {
  const lines = String(md ?? '').split(/\r?\n/);
  const blocks = [];

  let buf = [];
  let startLine = 0;
  let inFence = false;
  /** 标题栈：{level, title}，用来还原当前段落的标题链 */
  const headings = [];
  let headingChain = '';

  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.join('\n').trim();
    if (text) blocks.push({ text, line: startLine, heading: headingChain });
    buf = [];
    startLine = 0;
  };

  // frontmatter 必须紧贴文件首行，否则 `---` 只是一条分隔线
  let start = 0;
  if (FM_FENCE.test(lines[0] ?? '')) {
    const close = lines.findIndex((l, i) => i > 0 && FM_FENCE.test(l));
    if (close > 0) start = close + 1;
  }

  for (let i = start; i < lines.length; i += 1) {
    const raw = lines[i];

    // 围栏线：翻转标志即可。这里不做成对性校验、也不认嵌套围栏——
    // markdown 里嵌套围栏极罕见，而一旦出现，翻转法最坏结果只是把某段代码当正文（多捞一条），
    // 不会漏掉真规则。为这种罕见情况引入状态机不划算。
    if (FENCE.test(raw)) {
      inFence = !inFence;
      flush();
      continue;
    }
    // 围栏内的一切都是代码或命令，不是规则
    if (inFence) continue;

    // 空行：段落边界
    if (!raw.trim()) {
      flush();
      continue;
    }

    // 章节标题：跳过本行（标题不是规则语句），但要维护标题栈供后续段落使用
    const h = raw.match(HEADING);
    if (h) {
      flush();
      const level = h[1].length;
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
      headings.push({ level, title: (h[2] ?? '').trim() });
      headingChain = headings.map((x) => x.title).join(' > ');
      continue;
    }

    // 表格行：同样跳过，但要先 flush，让它仍然充当段落边界
    if (TABLE_ROW.test(raw)) {
      flush();
      continue;
    }

    // 新的列表标记：无条件开启新段落（哪怕上一行也是列表项）
    if (LIST_MARKER.test(raw)) {
      flush();
      buf = [raw];
      startLine = i + 1;
      continue;
    }

    // 普通行：并入当前段落（也承担列表项的续行）
    if (buf.length === 0) startLine = i + 1;
    buf.push(raw);
  }

  flush();
  return blocks;
}

/** 中英混排时中文没有词边界，只能用 includes；英文加 \b 避免 "MUSTARD" 之类误命中 */
function containsAny(text, zhWords, enWords, enFlags) {
  const s = String(text ?? '');
  if (zhWords.some((w) => s.includes(w))) return true;
  return enWords.some((w) => new RegExp(`\\b${w}\\b`, enFlags).test(s));
}

/**
 * 段落里是否出现绝对化指令词。
 * @param {string} text
 * @returns {boolean}
 */
export function hasAbsolute(text) {
  // 英文用 '' 而非 'i'：只认全大写的强制级别写法，见 ABSOLUTE_EN 注释
  return containsAny(text, ABSOLUTE_ZH, ABSOLUTE_EN, '');
}

/**
 * 段落里是否出现范围限定词。
 * @param {string} text
 * @returns {boolean}
 */
export function hasQualifier(text) {
  // 限定词大小写不敏感：这里宁可多认，多认一个限定词只会少捞一条候选（保守方向）
  return containsAny(text, QUALIFIER_ZH, QUALIFIER_EN, 'i');
}

/** 剥掉括号：里面是出处 / 补充 / 代码片段，不是条款本体 */
function stripParenthetical(text) {
  return PARENTHETICAL.reduce((s, re) => s.replace(re, ''), String(text ?? ''));
}

/**
 * 取「首句」——软换行不算句子边界（markdown 里的折行只是排版）。
 * @param {string} text
 * @returns {string}
 */
export function firstSentence(text) {
  return stripParenthetical(String(text ?? '').replace(/\r?\n/g, ' ')).split(SENTENCE_END)[0];
}

/** 剥掉装饰后，这一条是不是直接以义务词开头（无可争议的祈使句） */
function startsWithDeontic(text) {
  const s = String(text ?? '').replace(LEAD_DECORATION, '');
  return ABSOLUTE_ZH.some((w) => s.startsWith(w)) || ABSOLUTE_EN.some((w) => s.startsWith(w));
}

/** 义务词之前出现因果连接 → 这条义务是被推导出来的后果，整段重心在解释 */
function isDerivedConsequence(sentence) {
  const s = String(sentence ?? '');
  let pos = -1;
  const mark = (p) => { if (p >= 0 && (pos < 0 || p < pos)) pos = p; };
  for (const w of ABSOLUTE_ZH) mark(s.indexOf(w));
  for (const w of ABSOLUTE_EN) mark(new RegExp(`\\b${w}\\b`).exec(s)?.index ?? -1);
  if (pos < 0) return false;
  return CAUSAL.test(s.slice(0, pos));
}

/**
 * 这一段是不是「规则语句」——而不是恰好带了义务词的描述性正文。
 *
 * 分层理由见文件头。判据按「先看作者的显式声明，再看句法，最后看上下文」排：
 *
 * 1. 范围限定词一票否决 —— 作者已经写明了边界，这条不该再被报出来。
 *    放在最前面是因为它优先级最高：`⛔ 禁止做出假设……但需求里给定的值是输入不是假设`
 *    是修复后的形态，哪怕带着 ⛔ 也不能再捞。
 * 2. ⛔ / ✅ 标记独立立案 —— 作者亲手标了强制级别，比任何句法特征都可靠，
 *    不再要求正文里另有绝对化措辞（见 MANDATE_MARKER）。
 * 3. 义务词必须落在**首句**且在括号外 —— 描述性正文的通病是先讲一段代码怎么运转，
 *    末尾才捎带一句「所以这里必须 X」。实测 21 条这类正文的义务词平均落在第 130 个字符
 *    之后，而真规则条目平均落在第 20 个字符。
 * 4. 排除解释性 / 推导性写法（`为什么…必须…`、`是必须的`、`…，所以…必须…`）。
 * 5. 排除非规范区章节，但**以义务词开头的祈使句除外**——后者形态上已经无可争议，
 *    不该因为作者把它写在「这是什么」小节里就漏掉。
 */
function isRuleStatement(block) {
  const text = block.text;
  if (hasQualifier(text)) return false;
  if (MANDATE_MARKER.test(text)) return true;

  const lead = firstSentence(text);
  if (!hasAbsolute(lead)) return false;
  if (EXPLANATORY.test(lead)) return false;
  if (isDerivedConsequence(lead)) return false;
  if (DESCRIPTIVE_HEADING.test(block.heading ?? '') && !startsWithDeontic(text)) return false;
  return true;
}

/**
 * 捞出「有绝对化措辞但没写明适用边界」的规则条目。
 *
 * 注意这里**只做召回不做判定**：被捞出不等于这条规则有问题。
 * 例如「禁止提交无法编译的代码」同样会被捞出，因为它确实不含范围限定词——
 * 它是否合理由下一层 LLM 结合语义判断。
 *
 * 但召回**只针对规则语句**。这是 2026-08-25 收窄的重点：原实现把「文本里出现绝对词」
 * 直接当候选，结果 kxmall-app-ui 捞出 111 条要分 10 批送 LLM，同一份输入连跑三次
 * 判为 over-broad 的条数是 23 / 18 / 9——批次越多，每批上下文越不同，判定标准漂移越厉害。
 * 而漂移的燃料正是那些「地图里带必须二字的说明文字」：它们不是规则，LLM 却仍会认真给出
 * over-broad 判定，用户看到的是「让你改一段说明文档」。收窄后 111 → 53，批次 10 → 5。
 *
 * @param {string} md 文件全文
 * @param {string} file 文件名（用于回报定位，本模块不碰 fs）
 * @returns {Array<{file:string, line:number, text:string}>}
 */
export function findCandidates(md, file) {
  return splitBlocks(md)
    .filter(isRuleStatement)
    .map((b) => ({ file, line: b.line, text: b.text }));
}

function normalizeOversized(entry) {
  if (typeof entry === 'string') return { file: entry, lines: null };
  return { file: entry?.file ?? String(entry), lines: entry?.lines ?? null };
}

/**
 * 汇总本维度得分。
 *
 * @param {object} input
 * @param {Array<{file:string,line:number,text:string}>} input.candidates 静态层捞出的候选
 * @param {Array<string|{file:string,lines:number}>} input.oversizedFiles 超长文件
 * @param {Array<{file:string,text:string,lines:number[]}>} input.duplicateGroups 重复条目分组
 * @param {Array<{line:number,file?:string,verdict:string,reason?:string,suggestion?:string}>|null} input.verdicts
 *   LLM 判定结果；null 表示还没判定
 */
export function evaluatePrompts({ candidates = [], oversizedFiles = [], duplicateGroups = [], verdicts = null } = {}) {
  const issues = [];
  let score = 100;
  let status;

  if (verdicts) {
    // 有判定结果：只对真正被判为有问题的条目扣分
    // 复合键 file#line：只按 line 建索引会串号——多文件扫描时同一行号必然碰撞，
    // Map 后写覆盖先写。实测 39 条候选里就有 5 组碰撞（L35/L47/L206/L207/L208 各两条），
    // 表现为 issue 的 meta.text 取到另一个文件同行号的原文，理由和原条目对不上号。
    const keyOf = (file, line) => `${file}#${line}`;
    const byKey = new Map(candidates.map((c) => [keyOf(c.file, c.line), c]));

    for (const v of verdicts) {
      if (v.verdict !== 'over-broad' && v.verdict !== 'conflicting') continue;

      const c = byKey.get(keyOf(v.file, v.line)) || {};
      const isConflict = v.verdict === 'conflicting';
      score -= isConflict ? DEDUCT_CONFLICTING : DEDUCT_OVER_BROAD;

      issues.push({
        code: isConflict ? 'P2_CONFLICTING' : 'P1_OVER_BROAD',
        severity: 'warn',
        file: v.file ?? c.file ?? null,
        line: v.line,
        message: v.reason ?? (isConflict ? '与其它规则冲突' : '规则过度宽泛，缺少适用边界'),
        // 提示词是 AI 全部行为的输入源，改错一个字就可能让整个项目的协作方式跑偏，
        // 属高危维度：一律只给建议，不自动改写。
        fixable: false,
        fixHint: v.suggestion ?? '建议补充适用范围或例外说明',
        meta: { verdict: v.verdict, text: c.text ?? null },
      });
    }
    status = 'done';
  } else {
    // 未判定：按候选数保守估计
    score -= candidates.length * DEDUCT_UNJUDGED_CANDIDATE;

    // 候选为 0 时直接 done：没有可疑条目就没什么可让 LLM 判的，结论已经确定（满分），
    // 再发一次请求纯属浪费额度和时间。
    //
    // 有候选却没判定时必须是 partial：此时的分数是「假设候选全有问题」的保守估计，
    // 只是个占位值。score.logic.js 的 aggregateScore 只让 status === 'done' 的维度参与加权，
    // 未经判定的估计值不该以确定的姿态影响总分——那会让总分看起来比实际可信。
    status = candidates.length === 0 ? 'done' : 'partial';
  }

  for (const entry of oversizedFiles) {
    const { file, lines } = normalizeOversized(entry);
    score -= DEDUCT_OVERSIZED;
    issues.push({
      code: 'P3_OVERSIZED_RULE',
      severity: 'info',
      file,
      line: 1,
      message: lines
        ? `提示词文件 ${lines} 行，超过 ${OVERSIZE_LINES} 行阈值，建议拆分或下沉为按需加载的 skill`
        : `提示词文件超过 ${OVERSIZE_LINES} 行，建议拆分或下沉为按需加载的 skill`,
      fixable: false,
      fixHint: '按主题拆分，把低频内容改为 skill 按需调用',
      meta: { lines },
    });
  }

  for (const g of duplicateGroups) {
    score -= DEDUCT_DUPLICATE;
    issues.push({
      code: 'P4_DUPLICATE',
      severity: 'info',
      file: g.file,
      line: g.lines?.[0] ?? 1,
      message: `重复条目出现在第 ${(g.lines ?? []).join('、')} 行：${String(g.text ?? '').slice(0, 60)}`,
      fixable: false,
      fixHint: '保留一处，其余删除',
      meta: { lines: g.lines ?? [], text: g.text ?? null },
    });
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    status,
    issues,
  };
}

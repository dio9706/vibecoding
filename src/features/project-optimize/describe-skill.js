/**
 * rules → skill 降级时生成 skill 的 `description` 字段。
 *
 * 为什么单独一个模块、为什么这么小心：
 * description 是整个降级操作里**唯一一处不会以报错或扣分形式暴露失败**的地方。
 * 规范从 `.claude/rules/` 搬到 `.claude/skills/` 之后，能不能被唤起完全取决于这一行字——
 * 写砸了，规范在磁盘上还在、体检分数反而会涨到满分（rules 目录空了，没得扣分），
 * 但实际效果等同于规范被删除。分数变好、实际变差，没有任何自动信号能发现。
 *
 * 因此这里的设计取向是：宁可用一句机械但准确的兜底，也不要一句好听但没说清触发场景的话；
 * 并且必须让上层知道这一条到底是 LLM 写的还是兜底拼的（`source` 字段）。
 *
 * 本模块不碰文件系统、不做 git 操作，只做「正文 → 一行描述」的变换。
 *
 * ⚠️ 工具禁用写法：**阶段三 spec 里写的 `allowedTools: []` 是错的，不要照着改回去。**
 * Claude Agent SDK 官方文档对 `allowedTools` 的原文是
 * 「Tools to auto-approve without prompting. **This does not restrict Claude to only these tools.**」
 * —— 它是「免确认列表」而不是白名单，`allowedTools: []` 的实际效果是**这次调用拥有全部工具**、
 * 只是每个都要确认。而本调用执行在删 rules 文件、改写全仓引用的**中途**（快照备份已经打完），
 * 模型此时的任何多余写入都落在备份之外，回滚救不回来。
 * 正确写法是 `disallowedTools: ['*']`：文档原文「Every tool definition is removed from the request.
 * Tool-name globs are supported in deny rules.」—— 裸名字/通配符是把工具定义从请求里**摘除**，
 * 模型压根看不见。runClassifierOnce 内部已经是 `disallowedTools: ['*']`（见 llm-classify.js），
 * 所以本模块不传任何工具相关参数，别在这里覆盖它。
 */
import { runClassifierOnce } from '../llm-classify.js';
import { logger } from '../../shared/logger.js';

/**
 * 生成模型。null = 跟随会话默认模型（claude.js 对 falsy 的 model 会整个跳过该参数）。
 *
 * 为什么不用 haiku 省钱：这里是**写作**任务而不是分类任务，输出直接变成用户仓库里的持久化文本，
 * 且发生在删文件 + 改写全仓引用的中途——事后想复核只能人工一条条读。
 * check-prompts 那边已经用实测证明了低档位模型在「学不会抽象判据、只会照抄 few-shot 句式」上的
 * 系统性缺陷（见 check-prompts.js 的 JUDGE_MODEL 注释）；那里的代价只是判定不稳，
 * 这里的代价是规范失踪。一键优化是低频操作，单个 skill 一次调用，用默认模型的钱花得起。
 */
const DESCRIBE_MODEL = null;

/**
 * 单次生成的超时预算。
 *
 * 输出只有一行（<120 字）、输入是截断过的提纲，token 量很小，按理 30s 就够。
 * **但实测反复证伪**：
 *
 * - 2026-08-26 首轮：style-system.md（124 行）单独跑耗时 54.5s，原定 60s 只剩 5.5s 余量 → 提到 120s。
 * - 同日 P3-12 真实项目验收：keyboard-input-pattern 那次日志赫然是
 *   `✔ runClaude {"ms":127091}` —— **模型成功返回了**，但 race 在 122s（budget+2s）就放弃，
 *   答案晚到 5 秒，整条 description 落了机械兜底。同一次跑里另外三个是 91.6s / 34.9s / 35.3s，
 *   波动接近 4 倍：连续多次调用、赶上限流排队时，长尾远超单独跑时测到的值。
 *
 * 127s 这个数字和 check-prompts 的 BATCH_TIMEOUT_MS 当初撞的完全一样（见那边的注释），
 * 所以这里也对齐到 300s。
 *
 * 为什么不能踩线：这里超时的后果不是报错，而是**静默落兜底**——生成一句机械描述照样写进
 * frontmatter，降级照常完成、体检分数照涨，没有任何信号说明这个 skill 的唤起能力打了折。
 * 这正是本模块开头说的那种「分数变好、实际变差」的失败。
 * 而多等的代价极小：一键优化是低频操作，通常只有 1-4 个文件，且只在真卡住时才等满。
 *
 * 教训：超时预算是**模型速度的依赖变量**，必须按**并发/连续跑的长尾**校准，
 * 而不是按单次实测值加一点余量——更不是按「输出很短所以应该很快」拍脑袋。
 */
const DESCRIBE_TIMEOUT_MS = 300_000;

/** 正文开头喂给模型的截断长度：够看出这份规范在讲什么即可，整篇塞进去只是烧 token */
const HEAD_CLIP = 500;

/**
 * 判定「LLM 这次没写出东西」的最短长度。
 *
 * 合格的 description 要同时说清「是什么」和「什么时候调」，不可能短于 10 个字。
 * 低于这个长度的返回（空串、`"无"`、`"规范"`）说明模型这次没按要求走，
 * 与其把一句废话写进 frontmatter，不如退回机械兜底——兜底至少标题和小节是真的。
 */
const MIN_DESCRIPTION_LEN = 10;

/** 兜底描述里列举的二级标题条数：三条足以勾勒范围，再多就超出单行可读长度 */
const FALLBACK_SUB_COUNT = 3;

/**
 * 从 markdown 正文抽取结构，作为 LLM 的输入。
 *
 * 为什么不直接把整篇正文喂进去：rules 文件动辄一两百行，里面大量是代码块和表格。
 * 对「这份规范是什么、什么时候该调它」这个问题，标题层级的信息密度远高于正文细节，
 * 而提纲同时也是兜底路径唯一能用的原料——两条路径共用一份输入，行为才好对齐。
 *
 * @param {string} body 已剥掉 frontmatter 的 markdown 正文
 * @returns {{h1:string, subs:string[], head:string}}
 *   h1 一级标题（没有则空串）；subs 全部二级/三级标题；head 去掉一级标题后的正文开头
 */
export function outlineOf(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  let h1 = '';
  const subs = [];
  // 只认行首的 ATX 标题。代码块里的 `# 注释` 会被误收，但它进的是「提纲」而非「结论」，
  // 多一两条噪声标题不影响模型判断，为此维护一个围栏状态机不划算。
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const level = m[1].length;
    const title = m[2].trim();
    if (!title) continue;
    if (level === 1) {
      if (!h1) h1 = title; // 一份规范只认第一个 h1，后面的当异常结构忽略
    } else {
      subs.push(title);
    }
  }

  // head 要去掉**所有**标题行：标题已经通过 h1/subs 单独给出去了，
  // 在 head 里再出现一遍等于用同样的信息挤占仅有的 500 字预算，
  // 而 head 的全部价值就在于补充标题**看不出来**的那部分内容（引言、正文口径、表格开头）。
  // 顺手丢掉开头的空行，让截断窗口对准真正的内容。
  const headSource = lines
    .filter((l) => !/^#{1,6}\s+/.test(l))
    .join('\n')
    .replace(/^\n+/, '')
    .trim();

  return { h1, subs, head: headSource.slice(0, HEAD_CLIP) };
}

/**
 * 机械兜底描述：LLM 不可用 / 没写出东西时用。
 *
 * 刻意保持「拼装感」而不去修饰：这句话会连同 `source: 'fallback'` 一起交给上层提示用户复核，
 * 读起来像模板本身就是一种信号——用户一眼能看出这条没被认真写过。
 * 反过来，如果兜底写得跟 LLM 生成的一样自然，用户就不会去复核了。
 *
 * @param {{h1?:string, subs?:string[]}} outline
 * @returns {string} 单行描述
 */
export function fallbackDescription({ h1, subs } = {}) {
  const title = String(h1 ?? '').trim() || '本项目规范';
  const list = (Array.isArray(subs) ? subs : [])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .slice(0, FALLBACK_SUB_COUNT);

  const scope = list.length ? `覆盖${list.join('、')}。` : '';
  return toYamlScalar(`${title} —— ${scope}修改相关内容时调用本技能。`);
}

/**
 * YAML 纯量的**首字符**指示符集合（含各种包裹引号）。
 *
 * 只管首字符：这些字符出现在句中都是普通字符，YAML 只在纯量开头才赋予它们语法含义
 * （`[`/`{` 开流式集合、`-` 开列表项、`#` 开注释、`>`/`|` 开块标量、`*`/`&` 开别名锚点……）。
 * 所以这里只削开头，不做全局替换——句中的 `[` 改掉纯属篡改原文。
 */
const YAML_LEADING_INDICATORS = /^[-?:,[\]{}#&*!|>%@`"'「『]+\s*/;

/**
 * 把任意文本压成可以安全写进 YAML frontmatter 的单行纯量。
 *
 * 为什么这个函数值得单独导出并单测：`buildSkillFile` 是**裸拼** `description: <值>`，
 * 没有引号保护，值本身必须已经合法。而这里每一条规则对应的都不是「描述写得差」，
 * 而是 skill **整个加载不了**或**内容被静默截断**——前者规范直接失踪，
 * 后者更阴险：skill 照常加载，只是「什么时候调」那半句没了，而那正是唤起判断唯一的依据。
 *
 * 五条规则：
 * 1. 换行/连续空白 → 单个空格。YAML 单行纯量不能含换行。
 * 2. 去掉整体包裹的引号。模型很爱回 `"..."`，值以引号开头会被当成带引号标量解析，
 *    一旦内部还有引号就直接语法错误。
 * 3. 去掉开头的指示符（见 YAML_LEADING_INDICATORS）。模型偶尔会回 `[弹框规范] ……`
 *    或 `- 用于……` 这种带前缀的写法。
 * 4. `:` → 全角。**句中的 `: ` 和结尾的 `:` 都要管**：YAML 里 `:` 只有紧跟非空白字符时
 *    才是普通字符，跟着空白或行尾就是键值分隔符。原实现只匹配 `/:\s/`，
 *    而结尾冒号后面没有空白，正好从这条规则底下漏过去 → `description: 适用于:` 抛语法错误。
 *    中文描述里 `C#`、`3:1` 这类紧贴的冒号不受影响，本来也合法。
 * 5. 空白后的 `#` → 全角。YAML 规则是「前面挨着空白的 # 起注释作用」，
 *    `description: 处理 #tag 语法时使用` 会被截成「处理」。同样按规则只改挨着空白的那种。
 *
 * @param {unknown} text
 * @returns {string} 合法的 YAML 单行纯量（幂等：对自己的输出再跑一次结果不变）
 */
export function toYamlScalar(text) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(/["'`」』]+$/, '').trim();
  s = s.replace(YAML_LEADING_INDICATORS, '').trim();
  s = s.replace(/:\s/g, '：').replace(/:+$/, '：');
  s = s.replace(/(\s)#/g, '$1＃');
  return s;
}

/**
 * 生成角色设定。
 *
 * 「你没有任何工具」这段沿用 check-prompts 的做法，且理由在这里更强：
 * 该调用发生在删除 rules 文件、改写全仓引用的**中途**，快照备份已经打完。
 * 模型若在此时动手改文件，改动落在备份之外，回滚也救不回来。
 * 工具在 runClassifierOnce 里已被 `disallowedTools: ['*']` 从请求里整个移除，
 * 这段话是提示词层面的第二道闸——掐掉「我先去读一下原文件」这个念头本身，
 * 免得它把 maxTurns=1 的唯一一轮浪费在一次注定失败的工具调用上（实测发生过）。
 */
const SYSTEM_PROMPT = {
  type: 'custom',
  custom:
    '你在为一份项目规范文档撰写 Claude Code skill 的 description 字段。\n' +
    'description 是这个 skill 唯一的被唤起依据——AI 只看它来决定「当前任务要不要读这份规范」。\n' +
    '写得含糊，规范就永远不会被读到，等同于被删除。\n' +
    '你没有任何工具，也没有文件系统访问权限。禁止调用工具、禁止尝试读取文件、禁止搜索工具——\n' +
    '你能看到的全部信息就是用户消息里给出的提纲。\n' +
    '只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码围栏。',
};

/**
 * 构造生成 prompt。
 *
 * 几个刻意的设计：
 * 1. **要求返回 `{"description":"..."}` 对象，不是裸字符串**。runClassifierOnce 用大括号计数
 *    提取首个 JSON **对象**，模型若直接吐一行文本会被判成「提取不出」→ null → 白白走兜底。
 * 2. **把「是什么 + 什么时候调」拆成两个必答项并解释后果**。只说「写个描述」，模型会写成
 *    文档摘要（「本文档介绍了……」）——摘要对唤起判断毫无用处，AI 读完仍不知道何时该用它。
 * 3. **few-shot 用本项目真人写的 description**。它同时示范了结构（前半句范围、后半句触发场景）、
 *    语气和长度，比任何抽象规则都有效；且这个样例是经受过实际使用检验的。
 * 4. **触发场景要求写「排查/修改/新增」这类动作词**。唤起判断本质是拿当前任务和场景做匹配，
 *    名词化的「与样式相关时」匹配不上具体任务，动词化的「新增或修改输入框时」才匹配得上。
 */
function buildPrompt(name, { h1, subs, head }) {
  const subList = subs.length ? subs.map((s) => `- ${s}`).join('\n') : '（无小节标题）';

  return [
    `下面是一份项目规范文档的提纲，它即将变成技能 \`/${name}\`。请为它写一句 description。`,
    '',
    '## description 必须同时说清两件事',
    '',
    '1. **是什么**：一句话概括这份规范管的是哪一块内容（可以带上关键小节，让范围具体）。',
    '2. **什么时候调**：具体的触发场景，用动作词描述——',
    '   「新增 X / 修改 X / 排查 X 问题 / 做 X 时」这类写法。',
    '',
    '第 2 点是重点。AI 只拿当前任务去和触发场景做匹配，匹配不上就不会读这份规范。',
    '「与样式相关时使用」这种名词化的空话匹配不上任何具体任务，等于没写；',
    '「新增或修改页面样式、排查小程序端样式不生效时使用」才匹配得上。',
    '',
    '## 格式约束',
    '',
    '- 单行，不超过 120 字（中文字符计 1 字）。',
    '- 不要加引号，不要换行，不要写「本文档」「该规范介绍了」这类摘要腔。',
    '- 直接输出描述内容本身，不要任何前缀。',
    '',
    '## 范本（本项目真人写的合格样例）',
    '',
    '技能 `/popup-pattern` 的 description：',
    '本项目统一弹框规范（十条硬规则 + 模板骨架 + 跨分包引用三件事 + 弹框内输入框处理）。' +
      '当需要新增弹框、修改已有弹框、排查弹框白屏/失效/高度塌陷、或弹框里要放输入框时使用。',
    '',
    '注意它的结构：**前半句括号里列出覆盖范围，后半句「当……时使用」列出具体触发动作**。',
    '照这个结构写。',
    '',
    '## 输出格式',
    '',
    '严格输出一个 JSON 对象（description 是字段，不要直接输出字符串）：',
    '{"description":"..."}',
    '',
    '## 待描述的规范提纲',
    '',
    `技能名：${name}`,
    `标题：${h1 || '（无一级标题）'}`,
    '小节：',
    subList,
    '',
    '正文开头：',
    head || '（正文为空）',
  ].join('\n');
}

/**
 * 为一个即将生成的 skill 产出 description。
 *
 * 失败一律降级、绝不抛错：调用方正处在「文件已删、引用已改」的中途，
 * 这里抛异常会把整个降级操作停在半路，比拿一句机械描述糟糕得多。
 *
 * 不重试：与 check-prompts 的批量判定不同，这里单个 skill 只有一次调用，
 * 失败不会被 `1-(1-p)^n` 放大；而真正的失败原因（额度耗尽、限流）重试也不会好转。
 * 兜底描述虽然机械但内容真实，加上 `source: 'fallback'` 标注后用户能定点复核，
 * 让用户多等一分钟换一次大概率同样失败的调用不划算。
 *
 * @param {string} name skill 名（即原 rules 文件名去掉 .md）
 * @param {string} body 已剥掉 frontmatter 的 markdown 正文
 * @returns {Promise<{description:string, source:'llm'|'fallback'}>}
 *   `source` 会被上层用来提示「这条是机械生成的，建议复核」，必须如实反映来源
 */
export async function describeSkill(name, body) {
  const outline = outlineOf(body);

  const raw = await runClassifierOnce({
    prompt: buildPrompt(name, outline),
    systemPrompt: SYSTEM_PROMPT,
    model: DESCRIBE_MODEL,
    logTag: `optimize/describe:${name}`,
    timeoutMs: DESCRIBE_TIMEOUT_MS,
  });

  if (!raw || typeof raw.description !== 'string') {
    logger.warn('describe-skill', 'LLM 未产出 description，改用机械兜底（建议人工复核）', {
      skill: name,
      reason: raw ? 'description 字段缺失或非字符串' : '调用失败/超时/额度耗尽',
      got: raw ? JSON.stringify(raw).slice(0, 200) : null,
    });
    return { description: fallbackDescription(outline), source: 'fallback' };
  }

  const description = toYamlScalar(raw.description);
  if (description.length < MIN_DESCRIPTION_LEN) {
    logger.warn('describe-skill', 'LLM 产出的 description 过短，改用机械兜底（建议人工复核）', {
      skill: name,
      len: description.length,
      got: description,
    });
    return { description: fallbackDescription(outline), source: 'fallback' };
  }

  // 超长只记不改：从中间截断会把「什么时候调」那半句砍掉——那恰恰是唤起判断唯一依赖的部分，
  // 截出来的半句比原样超长危险得多。120 字是可读性建议，不是加载器的硬限制。
  if (description.length > 120) {
    logger.warn('describe-skill', 'description 超过 120 字（已原样保留，建议人工精简）', {
      skill: name,
      len: description.length,
    });
  }

  return { description, source: 'llm' };
}

/**
 * 维度⑤：注释合理性——文件系统层 + LLM 判定层。
 *
 * 静态层（check-comments.logic.js）只负责**取样**：挑最近改过的源码文件、把注释块连同紧邻代码
 * 抠出来、按字符上限拼成载荷。这一层负责**判定**：注释到底是在解释「为什么」，
 * 还是在复述代码 / 已经和代码对不上 / 干脆是被注释掉的死代码。
 *
 * 为什么这一步非 LLM 不可：三类问题全都只能靠语义分辨，正则一条都判不了。
 *   `// 把 loading 设为 true` + `loading = true;`
 * 和
 *   `// 先置 true 再发请求：按钮禁用态绑的是 loading，晚一拍会被连点两次` + `loading = true;`
 * 在任何静态特征上都同构——同为行注释、同样提到 loading 和 true、长度也能差不多。
 * 差别只在于第二条回答了「为什么」，读者从中拿到了代码本身没有的信息。
 *
 * 本模块不落盘：缓存通过入参 `cache` 传入、通过返回值 `cacheEntry` 传出，
 * 由上层编排决定要不要写进 optimize.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runClassifierOnce } from '../llm-classify.js';
import { logger } from '../../shared/logger.js';
import {
  pickSampleFiles,
  extractCommentBlocks,
  buildPayload,
  evaluateComments,
  SAMPLE_SIZE,
} from './check-comments.logic.js';
import { computeFingerprint, isCacheValid } from './fingerprint.logic.js';

/**
 * 遍历时跳过的目录。
 *
 * 与维度②口径一致，`worktrees` 同样要跳：`.claude/worktrees/` 下是 git worktree 的完整签出副本，
 * 每个副本都带一整套源码。收进来只会让抽样池被临时分支的重复文件挤满、白烧额度，
 * 而用户根本不会去改临时分支里的注释。
 *
 * 注：更细的文件级过滤（扩展名白名单、测试文件、.min.）在 logic 层的 pickSampleFiles 里，
 * 这里只挡「整棵子树都不用进」的目录，省掉无谓的 stat。
 */
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.expo', 'worktrees']);

/**
 * 判定模型。null = 跟随会话默认模型（claude.js 对 falsy 的 model 会整个跳过该参数）。
 *
 * 不要图便宜换 haiku。维度②（提示词质量）2026-08-24 实测过，haiku 在三个维度上都不够用：
 * 判定不稳（同一输入连跑三次，条目层面的一致率只有 11%）、抽象判据学不会（只会照抄 few-shot 的句式，
 * 换一条没见过的同类条目就判错）、指令遵循度差（明确要求给出的字段有一半不给）。换回默认模型后一致率 100%。
 *
 * 本维度对这三点的依赖只多不少：restates-code 与 ok 的分界（「有没有回答为什么」）恰恰是一条
 * 抽象判据，而不是句式匹配——照抄 few-shot 的模型会把所有提到代码标识符的注释一起误杀。
 */
const JUDGE_MODEL = null;

/**
 * 单批注释块数上限。
 *
 * 为什么要分批：抽样上限是 30 个文件 × 每文件最多 10 处，一次性喂给模型，输出侧要生成上百条
 * 带 reason 的判定，极易触发长度截断——而截断的 JSON 在 extractFirstJsonObject 里配不平大括号，
 * 整批直接返回 null（全军覆没）。分批把「一次截断毁全场」的风险切成小块。
 *
 * 取 12 与维度②对齐：实测 20 条一批时，批量越大、清单越杂，模型越容易动「先去读一下原文件」的念头，
 * 而工具全被禁、maxTurns 只有一轮，念头一起这批就废了。
 */
const BATCH_SIZE = 12;

/**
 * 送进 LLM 的注释块总数上限。
 *
 * 为什么要有这道闸：抽样上限（30 文件 × 10 块）理论上能产出 300 块 = 25 批，
 * 单次体检的额度消耗会失控到不可接受，而边际收益极低——同一份代码里第 200 条注释的判定
 * 几乎不会改变「这个项目注释质量如何」的结论。48 块 = 4 批，与维度②单次的批数量级一致。
 *
 * 截取顺序沿用抽样顺序（文件按 mtime 倒序），先保证最近改动的文件被覆盖：
 * 新写的注释最容易烂，也最值得看。
 */
const MAX_TOTAL_BLOCKS = 48;

/**
 * 并发批数上限。
 *
 * 每批都会拉起一个独立的 Claude CLI 子进程，全并发意味着同时若干个进程，
 * 本机内存和 API 并发都吃不消。限到 4 路。
 */
const MAX_CONCURRENCY = 4;

/**
 * 单批超时预算。
 *
 * 默认的 30s 是给「一句话分类」设计的，这里差着一到两个数量级的输出 token，必然不够。
 *
 * 300s 是继承维度②的教训，不是拍脑袋：那边原值 120s 按 haiku 校准，换默认模型后每批实测
 * 60/94/114/127 秒——日志里赫然是 `✔ runClaude {"ms":127093}`，即**模型成功返回了，
 * 但 race 在 122s（budget+2s）就放弃**，`out` 只拿到半截流 → 大括号配不平 → null → 整批废 →
 * 整个维度 partial，而 partial 会被 aggregateScore 踢出总分，等于功能没有。
 *
 * 本维度的单批载荷（注释原文 + 紧邻代码）比维度②的规则条目更长，只会更慢，所以不能取更小的值。
 */
const BATCH_TIMEOUT_MS = 300_000;

/**
 * 合法 verdict 白名单。
 *
 * `ok` 必须在表内且必须由模型显式给出：条数校验（见 validateVerdicts）要求判定条数与送进去的
 * 注释块数严格相等，允许模型「没问题就不写」等于自废这道校验。
 *
 * 这个 Set 是**全有或全无**校验的一部分：模型吐出不在表里的 verdict 会让整批判定作废，
 * 所以新增 verdict 必须同时改提示词和这里，漏一处就是整批失败。
 */
const VALID_VERDICTS = new Set(['restates-code', 'stale', 'dead-code', 'ok']);

/** 只有这三种会变成 issue 并扣分；`ok` 天然被忽略 */
const PROBLEM_VERDICTS = new Set(['restates-code', 'stale', 'dead-code']);

/** issue message 的前缀，让用户不用去查 code 就知道是哪类问题 */
const VERDICT_LABEL = {
  'restates-code': '注释只是在复述代码',
  stale: '注释与当前代码不符',
  'dead-code': '被注释掉的死代码',
};

/**
 * 单块注释 / 上下文在载荷里的截断长度。
 *
 * 不只是省钱：块注释（尤其是本项目这种长篇 JSDoc 文件头）动辄上百行，整块喂进去会把一批的
 * 输入撑到失控，也会稀释模型对同批其它注释的注意力。判「有没有回答为什么」看开头几百字就够了。
 */
const COMMENT_CLIP = 800;
const CONTEXT_CLIP = 300;

/**
 * 单批载荷的字符上限。
 *
 * 刻意给得远高于实际需要（12 块 × (800+300) ≈ 13k）：buildPayload 一旦触发截断就会**丢掉整个文件的块**，
 * 而条数校验用的是 batch.length，两者对不上会让每一批都判定失败。
 * 这里靠「预先按块截断 + 宽裕的批上限」把截断变成不可能事件，真触发了也当整批失败处理（见 buildBatchPayload）。
 */
const BATCH_PAYLOAD_CHARS = 60_000;

/**
 * 收集扫描范围内的源码文件。
 *
 * 只返回 path/mtime/size，真正「哪些文件值得抽样」的判据（扩展名白名单、排除测试文件与压缩产物）
 * 交给 logic 层的 pickSampleFiles——那是纯函数、有单测覆盖，不该在这里复制一份口径。
 *
 * mtime 用 fs 的 mtimeMs 而不是 git 提交时间：git log 要对每个文件跑一次子进程，
 * 30+ 个文件的开销远大于 stat；而且体检要能对付非 git 目录。代价是 checkout / clone 会把
 * 全仓 mtime 刷成同一时刻，此时抽样退化成任意 30 个文件——不影响正确性，只影响「优先看新代码」这个偏好。
 *
 * @param {string} projectDir
 * @returns {Array<{full:string, rel:string, mtime:number, size:number}>} rel 统一用正斜杠
 */
function collectSourceFiles(projectDir) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIR.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(full, r); continue; }
      try {
        const st = fs.statSync(full);
        out.push({ full, rel: r, mtime: st.mtimeMs, size: st.size });
      } catch { /* 竞态删除等，跳过 */ }
    }
  };
  walk(projectDir, '');
  return out;
}

/**
 * 判定角色设定。
 *
 * 「你没有任何工具」这段是维度②实测逼出来的，不是保险话术：某批脱离上下文看不懂的候选让模型先说
 * 「让我读取源文件以获取完整上下文」，然后调 ToolSearch 把被禁的 Read 重新捞出来——
 * 这一次调用消耗掉了 maxTurns=1 的唯一一轮，SDK 报 error_max_turns、result 为空串，整批作废。
 *
 * 本维度更容易触发这个念头：模型每块只能看到注释加紧邻三行代码，「想看看这个函数全貌」是极自然的反应。
 * 所以必须在提示词层面掐掉念头本身，并明确告诉它「看不全时怎么办」——不给出路，它还是会想去找。
 */
const SYSTEM_PROMPT = {
  type: 'custom',
  custom:
    '你是代码注释的质量审查员。\n' +
    '你唯一关心的问题是：这条注释对读代码的人有没有价值——它是否给出了代码本身读不出来的信息。\n' +
    '你没有任何工具，也没有文件系统访问权限。禁止调用工具、禁止尝试读取文件、禁止搜索工具——\n' +
    '任何一次工具调用都会让整批判定作废。你能看到的全部信息就是用户消息里给出的注释与片段代码。\n' +
    '只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码围栏。',
};

/**
 * 把一批注释块渲染成载荷文本。
 *
 * 复用 logic 层的 buildPayload 而不是自己拼：格式（`## 文件` / `L12 注释:` / `L12 代码:`）是有单测的
 * 既定契约，模型回填 file/line 时靠的就是这个格式，两处各写一份迟早会漂移。
 *
 * @returns {string|null} null 表示这批渲染后仍超上限（理论上不会发生，见 BATCH_PAYLOAD_CHARS）
 */
function buildBatchPayload(batch) {
  // buildPayload 按文件分组接收，先把批内的块还原成 [{path, blocks}]（保持批内原顺序）
  const grouped = [];
  const indexOfFile = new Map();
  for (const b of batch) {
    if (!indexOfFile.has(b.file)) {
      indexOfFile.set(b.file, grouped.length);
      grouped.push({ path: b.file, blocks: [] });
    }
    grouped[indexOfFile.get(b.file)].blocks.push({ line: b.line, comment: b.comment, context: b.context });
  }
  const payload = buildPayload(grouped, BATCH_PAYLOAD_CHARS);
  if (payload.truncated) return null;
  return payload.text;
}

/**
 * 构造判定 prompt。
 *
 * 四个刻意的设计：
 * 1. **要求返回 `{"verdicts":[...]}` 对象包数组，而不是裸数组**。runClassifierOnce 用大括号计数提取
 *    首个 JSON **对象**，模型若吐 `[{...}]` 会被截成第一个元素，等于整批判定丢失。
 * 2. **三类问题各配一对正反例**。维度②的教训：只给反例，模型会学成「见此句式即有问题」——
 *    对本维度而言就是「注释里出现了代码里的标识符 → restates-code」，把所有解释性注释一起误杀。
 *    每对里的两条刻意描述同一段代码，逼模型去看真正的分界（有没有回答「为什么」），而不是句式。
 * 3. **reason 必须落到具体**。「注释不够好」这种空话对使用者没有任何修改指引；
 *    而写得出「读者从这条注释里没多知道任何事」本身就是判定的验证条件——写不出来说明它其实没问题。
 * 4. **给「看不全」一条明确出路（判 ok）**。模型每块只拿到三行上下文，不给出路它要么去调工具（整批作废），
 *    要么把所有「无法从这几行验证」的注释误判成 stale。
 */
function buildPrompt(payloadText, count) {
  return [
    '下面是从项目源码里抽样出来的注释，每条都附带它紧邻的代码。请逐条判定注释的质量。',
    '',
    '## 判定口径',
    '',
    '- `restates-code`：注释只是把代码翻译了一遍，没有解释「为什么」。',
    '  判据是**信息增量**：读者看完注释，比只看代码多知道了什么？答案是「什么都没多知道」才算这一类。',
    '- `stale`：注释描述的行为与**眼前这几行代码**直接矛盾，照注释理解会得出错误结论。',
    '- `dead-code`：被注释掉的可执行代码——它原本在运行，被人用注释停用了，现在既不执行也不是写给人看的说明。',
    '- `ok`：没有上述问题。**解释「为什么」的注释一律判 ok**，这正是好注释该有的样子。',
    '',
    '**「解释为什么」是好注释，不是复述代码。**本项目明确要求注释解释「为什么」而不是复述代码，',
    '所以凡是交代了设计取舍、踩过的坑、约束来历、为什么不用另一种写法的注释，都是合格注释，不要报。',
    '**不要因为注释里提到了代码中出现过的标识符就判 restates-code**——解释某行代码为什么这么写，',
    '本来就必须提到那行代码里的东西。',
    '',
    '你只能看到注释和它紧邻的两三行代码，**很多注释脱离全文会看不全，这是正常的**。',
    '这种情况一律判 `ok`，reason 里写明「片段信息不足以判定」即可。',
    '**绝对不要为了补上下文去读文件或调工具**——你没有这个能力，尝试一次就会让这一整批判定全部作废。',
    '',
    '## 示例（每组两条描述的是同一段代码，请对照看清分界）',
    '',
    '### 第一组：复述 vs 解释',
    '',
    '注释 `// 把 loading 设为 true`，代码 `loading = true;`',
    'verdict: `restates-code`',
    'reason: 逐字翻译了这行代码，读者看完注释比只看代码多知道的信息为零；这里真正值得写下来的是',
    '「为什么要在这个位置提前置 true」。',
    '',
    '注释 `// 先置 true 再发请求：按钮的禁用态绑的是 loading，晚一拍会被用户连点两次`，代码 `loading = true;`',
    'verdict: `ok`',
    'reason: 同样在说 loading = true，但交代了「为什么是这个顺序」以及不这么写的后果，',
    '读者拿到了代码本身给不出的信息。',
    '',
    '**分界不在句式，而在有没有回答「为什么」。**两条注释都提到了 loading 和 true。',
    '',
    '### 第二组：过时 vs 只是看不全',
    '',
    '注释 `// 重试 3 次后放弃`，代码 `for (let i = 0; i < 5; i += 1) { ... }`',
    'verdict: `stale`',
    'reason: 注释写 3 次，眼前的循环上限就是 5，两者直接矛盾；按注释去理解这段代码的行为必然出错。',
    '',
    '注释 `// 超时预算按 haiku 校准过，换模型必须重新测`，代码 `const TIMEOUT_MS = 300_000;`',
    'verdict: `ok`',
    'reason: 注释讲的是这个取值的来历和维护约束，眼前的代码里没有任何信息与之矛盾。',
    '',
    '**判 `stale` 的门槛是「眼前的代码直接推翻了注释的说法」。**',
    '仅仅是「注释提到的东西在这几行里看不到 / 无法验证」，一律判 `ok`——你拿到的只是片段，不是全文。',
    '',
    '### 第三组：死代码 vs 文档里的代码',
    '',
    '注释：',
    '```',
    '// const res = await fetchOld(url);',
    '// if (res.ok) return res.data;',
    '```',
    'verdict: `dead-code`',
    'reason: 整块是被注释掉的可执行语句，不是写给人读的说明；它不会运行，只会让后来者困惑',
    '「这段还要不要」。历史版本控制里已经有了，留在源码里没有价值。',
    '',
    '注释 `// 用法：pick({ a: 1, b: 2 }, ["a"]) → { a: 1 }`',
    'verdict: `ok`',
    'reason: 这里的代码片段是在演示这个函数怎么用，是写给读者的文档，不是被停用的实现。',
    '',
    '**判 `dead-code` 的判据是「这段代码原本在运行、被人注释掉了」，而不是「注释里出现了代码」。**',
    '',
    '## 输出格式',
    '',
    '严格输出一个 JSON 对象（注意 verdicts 是对象的字段，不要直接输出数组）：',
    '{"verdicts":[{"file":"src/a.js","line":12,"verdict":"restates-code","reason":"..."}]}',
    '',
    `- 必须为下面**每一处**注释各输出一条判定，一条不漏，**总共 ${count} 条**。`,
    '  条数对不上会让这一整批判定全部作废，包括你判对的那些。',
    '- `file` 按样本里 `## ` 后面的路径原样回填，`line` 按 `L<数字>` 里的数字原样回填。',
    '- `verdict` 只能是 `restates-code` / `stale` / `dead-code` / `ok` 四者之一，',
    '  写成别的值会让这一整批判定全部作废。',
    '- 判为问题时，`reason` 必须具体说明**为什么**这条注释有问题（复述了什么 / 与哪句代码矛盾 /',
    '  哪几行是被停用的代码），禁止写「注释不够清晰」「可以改进」这类空话。',
    '- 判 `ok` 时 `reason` 一句话说明它好在哪或为什么不算问题即可，但**不能省略这条判定**。',
    '',
    '只有 `restates-code` / `stale` / `dead-code` 会被计入扣分并展示给用户；',
    '`ok` 不扣分、也不会出现在问题清单里——所以拿不准时放心判 `ok`，不会有任何副作用。',
    '',
    `## 注释样本（共 ${count} 处）`,
    '',
    payloadText,
  ].join('\n');
}

/**
 * 校验模型返回的一批判定。
 *
 * 全有或全无：只要有一条不合法就整批作废。
 * 为什么不修补：这一层的输出会直接变成给用户看的「你的注释有问题」结论，
 * 一条结构都对不上说明模型这次没按格式走，剩下那些「看起来合法」的条目同样不可信；
 * 挑着用等于把噪声当结论展示，比老老实实报 partial 危险得多。
 *
 * @returns {Array|null} 合法则返回判定数组，否则 null
 */
function validateVerdicts(raw, expectedCount) {
  if (!raw || !Array.isArray(raw.verdicts)) return null;
  const list = raw.verdicts;
  if (list.length === 0) return null;
  // 条数必须对得上。只校验「非空 + 每条结构合法」的话，模型只判 12 条里的 3 条也照样放行——
  // 剩下 9 条既不在 verdicts 里、也就不会产出 finding，被**静默当成没问题**，而 status 仍是 done。
  // 这个组合能通过大括号计数（JSON 对象本身是完整的，只是条目不全），所以截断检测挡不住它。
  // 后果是「0 个问题」这种结果无法区分「注释都合格」和「模型漏判了大半」。
  if (typeof expectedCount === 'number' && list.length !== expectedCount) return null;
  for (const v of list) {
    if (!v || typeof v !== 'object') return null;
    if (!VALID_VERDICTS.has(v.verdict)) return null;
    if (typeof v.line !== 'number' || !Number.isFinite(v.line)) return null;
  }
  return list;
}

/**
 * 判定一批注释块（失败重试一次）。
 *
 * 为什么要重试：实测同一份 prompt 连跑两次，第一次模型返回空文本（SDK 报 success、也计了费，
 * 但 onText/onResult 都没拿到内容），第二次完全正常。这种瞬时空响应本身不可控，
 * 但它撞上「任何一批失败 → 整体 partial」的全有或全无策略后果被放大：
 * 并行 N 批时，单批 p 的失败率会放成 1-(1-p)^N。重试一次把这个概率压回可接受范围。
 *
 * 只重试一次：真正的失败原因（额度耗尽、限流）重试也不会好转，多试只是让用户多等几分钟。
 *
 * @returns {Promise<Array|null>} null 表示这批失败（超时/额度耗尽/结构不合法/条数不符）
 */
async function judgeBatch(batch, index) {
  const payloadText = buildBatchPayload(batch);
  if (payloadText === null) {
    // 载荷被截断意味着实际送出去的块数少于 batch.length，条数校验必然失败；
    // 与其白跑两次 LLM 调用，不如直接判这批失败
    logger.warn('check-comments', '批载荷超出上限，跳过该批', { batch: index, size: batch.length });
    return null;
  }

  const prompt = buildPrompt(payloadText, batch.length);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const raw = await runClassifierOnce({
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      model: JUDGE_MODEL,
      logTag: `checkup/comments#${index}`,
      timeoutMs: BATCH_TIMEOUT_MS,
    });
    const list = raw ? validateVerdicts(raw, batch.length) : null;
    if (list) return list;
    logger.warn('check-comments', 'LLM 判定失败（无输出或结构不合法）', {
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
 * 把模型返回的判定重新锚定到真实注释块上。
 *
 * 模型回填的 `file` 可能拼错或省略，而下游按 (file, line) 建索引——抽样跨 30 个文件，
 * 同一个行号必然在多个文件里重复出现，光靠 line 无法区分（维度②实测 39 条候选里就有 5 组行号碰撞，
 * 表现为 issue 的原文取到了另一个文件同行号的内容，理由和条目对不上号）。
 * 这里用 (file, line) 精确匹配一次，匹配上就以我们自己的块表为准覆盖 file，
 * 保证展示给用户的定位信息来自磁盘事实而不是模型记忆。
 */
function reanchor(verdicts, blocks) {
  const exact = new Map(blocks.map((b) => [`${b.file}#${b.line}`, b]));
  const byLine = new Map();
  for (const b of blocks) if (!byLine.has(b.line)) byLine.set(b.line, b);

  return verdicts.map((v) => {
    const hit = exact.get(`${v.file}#${v.line}`) || byLine.get(v.line);
    return {
      file: hit?.file ?? v.file ?? null,
      line: v.line,
      verdict: v.verdict,
      reason: typeof v.reason === 'string' ? v.reason : '',
    };
  });
}

/** 判定 → 打分用的 findings。只有三类问题进来，`ok` 天然被过滤掉 */
function toFindings(verdicts) {
  return verdicts
    .filter((v) => PROBLEM_VERDICTS.has(v.verdict))
    .map((v) => ({
      type: v.verdict,
      file: v.file,
      line: v.line,
      message: `${VERDICT_LABEL[v.verdict]}：${v.reason || '（模型未给出理由）'}`,
    }));
}

/**
 * 维度⑤入口：注释合理性体检。
 *
 * @param {string} projectDir 项目根目录
 * @param {object} [opts]
 * @param {{fingerprint:string, result:object}|null} [opts.cache] 上次的缓存条目（由上层持久化后传入）
 * @param {boolean} [opts.force] 忽略缓存强制重跑
 * @returns {Promise<{score:number|null, status:string, issues:Array, verdictLog:Array, cached:boolean,
 *   cacheEntry:{fingerprint:string, result:object}|null, fingerprint:string}>}
 *   `cacheEntry` 即下次要传回 `opts.cache` 的东西；status 非 done 时为 null（见 finish 的说明）
 */
export async function checkComments(projectDir, { cache = null, force = false } = {}) {
  const all = collectSourceFiles(projectDir);
  const sampled = pickSampleFiles(all.map((f) => ({ path: f.rel, mtime: f.mtime })), SAMPLE_SIZE);

  // 指纹只覆盖抽样中的文件，而不是全部源码文件。
  // 看似漏了「池子里其它文件改了」的情况，实际不会漏：抽样按 mtime 倒序，任何文件一旦被改动，
  // 它的 mtime 就变成当前时刻，必然挤进前 30 名 → 抽样集合本身就变了 → 指纹随之变化。
  // 反过来，用全池指纹会让任何一个不参与分析的文件改动都作废缓存，白烧一次 LLM 额度。
  const sizeOf = new Map(all.map((f) => [f.rel, f.size]));
  const fingerprint = computeFingerprint(
    sampled.map((f) => ({ path: f.path, mtime: f.mtime, size: sizeOf.get(f.path) ?? 0 })),
  );

  if (!force && isCacheValid(cache, fingerprint)) {
    return { ...cache.result, cached: true, cacheEntry: cache, fingerprint };
  }

  // 没有可抽样文件 → 不调 LLM。结论已经确定（本维度 na），发请求纯属烧额度。
  if (sampled.length === 0) {
    return finish(evaluateComments({ sampledFiles: 0, findings: [] }), fingerprint, 0, 0);
  }

  const fullPathOf = new Map(all.map((f) => [f.rel, f.full]));
  const blocks = [];
  for (const f of sampled) {
    if (blocks.length >= MAX_TOTAL_BLOCKS) break;
    let src;
    try { src = fs.readFileSync(fullPathOf.get(f.path), 'utf8'); } catch { continue; }
    for (const b of extractCommentBlocks(src)) {
      if (blocks.length >= MAX_TOTAL_BLOCKS) break;
      blocks.push({
        file: f.path,
        line: b.line,
        comment: String(b.comment).slice(0, COMMENT_CLIP),
        context: String(b.context).slice(0, CONTEXT_CLIP),
      });
    }
  }

  // 抽到了文件但一处注释都没有 → 同样不调 LLM。没有样本就没有可判的东西，
  // 这里给满分而不是 na：文件是有的，只是它们没写注释，属于「没发现问题」而非「无法判断」。
  if (blocks.length === 0) {
    return finish(evaluateComments({ sampledFiles: sampled.length, findings: [] }), fingerprint, sampled.length, 0);
  }

  const batches = [];
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) batches.push(blocks.slice(i, i + BATCH_SIZE));

  // 限并发跑各批：批之间互不依赖，串行会把耗时线性放大（4 批 × 最长 5 分钟）
  const results = await mapLimited(batches, MAX_CONCURRENCY, (b, i) => judgeBatch(b, i + 1));

  // 任何一批失败 → 整体走 partial。
  // 不做「部分判定 + 部分未判定」的混合态：evaluateComments 的 findings 语义是二元的
  // （给了数组就认为全部样本都判过了），塞半份进去会让没判过的注释被静默当成合格，凭空抬高分数。
  const failed = results.some((r) => r === null);
  if (failed) {
    return finish(
      evaluateComments({ sampledFiles: sampled.length, findings: null }),
      fingerprint, sampled.length, batches.length,
    );
  }

  const verdicts = reanchor(results.flat(), blocks);
  const result = evaluateComments({
    sampledFiles: sampled.length,
    findings: toFindings(verdicts),
    verdicts,
    blocks,
  });
  return finish(result, fingerprint, sampled.length, batches.length, blocks.length);
}

/**
 * 收尾：附上缓存条目和统计信息。
 *
 * 只有 status === 'done' 才产出 cacheEntry。partial 意味着这次 LLM 没跑成，分数是 null 的占位态——
 * 把它缓存下来，用户下次点体检会拿到同一个「没查成」的结论且再也不会重试（指纹没变 → 永久命中），
 * 失败就被固化了。
 */
function finish(result, fingerprint, sampledCount, batchCount, blockCount = 0) {
  const cacheEntry = result.status === 'done' ? { fingerprint, result } : null;
  return { ...result, cached: false, cacheEntry, fingerprint, sampledCount, batchCount, blockCount };
}

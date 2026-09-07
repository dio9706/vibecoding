/**
 * 维度⑤：注释合理性 —— 送 LLM 之前的全部准备工作（抽样 / 提取 / 截断 / 判分）。
 *
 * 为什么这一层不调 LLM：三类问题（复述代码 / 与代码不符 / 被注释掉的死代码）最终都要靠
 * 语义判断，机器规则做不了；但「送什么给 LLM」是纯粹的确定性逻辑，抽出来才能单测。
 * 本模块因此不 import fs、不执行 git、不发请求——文件列表与内容由调用方读好传进来。
 */

/** 抽样上限。全量扫大仓库送 LLM 成本不可控，取最近改的 30 个文件性价比最高：
 *  新写的注释最容易烂，也最值得看；老代码里的陈年注释边际收益低。 */
export const SAMPLE_SIZE = 30;

/** 每个文件最多取 10 处注释。单文件注释再多，样本再增也不会改变对这个文件的判断，
 *  只会挤占其它文件的配额，让抽样退化成「一个大文件刷屏」。 */
export const MAX_BLOCKS_PER_FILE = 10;

/** 注释块紧邻的代码行数上限。LLM 判断「这条注释是不是在复述代码」只需要看它描述的那几行，
 *  送整个文件既贵又会稀释注意力。 */
const CONTEXT_LINES = 3;

/** 问题密度打满时的最大扣分。注释是代码卫生问题，不该让一个维度把总分打到 0。 */
const MAX_DEDUCT = 60;

/** 源码扩展名白名单。用白名单而非黑名单：配置、文档、锁文件里的「注释」不是本维度的目标，
 *  漏掉一种小众语言的代价，远小于把 JSON/Markdown 当源码送进 LLM。 */
const SOURCE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'py', 'go', 'rs', 'java']);

/** 路径片段黑名单：依赖、构建产物、覆盖率报告、测试目录。 */
const EXCLUDED_PATH_SEGMENTS = ['node_modules', 'dist', 'build', 'coverage', '__tests__'];

/** 文件名黑名单：测试文件与压缩产物。测试里的注释多是场景描述，本来就不解释「为什么」，
 *  按本维度的标准判会全是假阳性；.min. 是机器生成的，注释质量无从谈起。 */
const EXCLUDED_NAME_MARKERS = ['.test.', '.spec.', '.min.'];

const TYPE_TO_CODE = {
  'restates-code': 'C1_RESTATES_CODE',
  stale: 'C2_STALE',
  'dead-code': 'C3_DEAD_CODE',
};

function extensionOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * 判断一个文件是否值得进抽样池。
 * @param {string} path 仓库相对路径，统一用 `/` 分隔
 */
function isSampleCandidate(path) {
  const normalized = String(path || '').replace(/\\/g, '/');
  if (!SOURCE_EXTENSIONS.has(extensionOf(normalized))) return false;

  const segments = normalized.split('/');
  // 按路径段精确比对而不是子串包含：子串会让 `src/distribution/x.js` 被 `dist` 误伤
  if (segments.some((seg) => EXCLUDED_PATH_SEGMENTS.includes(seg))) return false;

  const name = segments[segments.length - 1];
  return !EXCLUDED_NAME_MARKERS.some((marker) => name.includes(marker));
}

/**
 * 按 git 最近修改时间倒序取前 limit 个源码文件。
 * @param {Array<{path:string, mtime:number}>} files
 * @param {number} [limit]
 * @returns {Array<{path:string, mtime:number}>}
 */
export function pickSampleFiles(files, limit = SAMPLE_SIZE) {
  if (!Array.isArray(files)) return [];
  return files
    .filter((f) => f && isSampleCandidate(f.path))
    .slice() // 不改调用方传进来的数组
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    .slice(0, Math.max(0, limit));
}

/**
 * 找出一行里作为行注释起点的 `//` 位置，找不到返回 -1。
 *
 * 这里刻意不写词法分析器：真正做对要处理字符串、模板字面量、正则字面量、转义，
 * 成本远高于本维度的收益，而且解析器一旦出错是静默的假阴性。
 * 取舍是只挡最高频的那类误报——URL（`https://`、`file://`），判据为 `//` 前紧跟 `:`。
 * 已知代价：不含 `:` 的字符串里若出现 `//`（如 `const s = "a//b"`）仍会被当成注释送给 LLM。
 * 这种误报的后果只是多花一点 token，LLM 看到上下文自然会忽略，比漏判真注释安全。
 */
function findLineCommentIndex(line) {
  let from = 0;
  for (;;) {
    const idx = line.indexOf('//', from);
    if (idx === -1) return -1;
    if (idx > 0 && line[idx - 1] === ':') {
      from = idx + 2;
      continue;
    }
    return idx;
  }
}

/**
 * 收集注释块之后紧邻的若干行代码（跳过空行）。
 * 之所以取「之后」而不是「之前」：绝大多数注释描述的是下方的代码。
 */
function collectContext(lines, startIndex) {
  const picked = [];
  for (let i = startIndex; i < lines.length && picked.length < CONTEXT_LINES; i += 1) {
    if (lines[i].trim() === '') continue;
    picked.push(lines[i]);
  }
  return picked.join('\n');
}

/**
 * 从源码里提取注释块及其紧邻代码。
 * @param {string} src
 * @returns {Array<{line:number, comment:string, context:string}>} line 为 1 起始的行号
 */
export function extractCommentBlocks(src) {
  if (typeof src !== 'string' || src === '') return [];

  const lines = src.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length && blocks.length < MAX_BLOCKS_PER_FILE) {
    const line = lines[i];
    const trimmed = line.trim();

    // 块注释：从 /* 起一直吃到 */，多行内容整块保留（截断会让 LLM 看不懂上下文）
    if (trimmed.startsWith('/*')) {
      const startLine = i + 1;
      const collected = [];
      let end = i;
      // 起始行要从 /* 之后开始找 */，否则 `/**` 会把开头的 `*` 误当成闭合
      let searchFrom = line.indexOf('/*') + 2;
      while (end < lines.length) {
        collected.push(lines[end]);
        if (lines[end].indexOf('*/', searchFrom) !== -1) break;
        end += 1;
        searchFrom = 0;
      }
      blocks.push({
        line: startLine,
        comment: collected.join('\n'),
        context: collectContext(lines, end + 1),
      });
      i = end + 1;
      continue;
    }

    const commentIndex = findLineCommentIndex(line);
    if (commentIndex === -1) {
      i += 1;
      continue;
    }

    // 整行注释：把连续的若干行并成一块。拆开送会让 LLM 逐行看半句话，判断必然失真
    if (trimmed.startsWith('//')) {
      const startLine = i + 1;
      const collected = [];
      let end = i;
      while (end < lines.length && lines[end].trim().startsWith('//')) {
        collected.push(lines[end]);
        end += 1;
      }
      blocks.push({
        line: startLine,
        comment: collected.join('\n'),
        context: collectContext(lines, end),
      });
      i = end;
      continue;
    }

    // 行尾注释：注释描述的就是同一行的代码，上下文取本行
    blocks.push({
      line: i + 1,
      comment: line.slice(commentIndex),
      context: line,
    });
    i += 1;
  }

  return blocks;
}

/**
 * 把各文件的注释块拼成送 LLM 的文本，并按字符上限截断。
 *
 * 截断策略是「加之前先算」而不是「加完再切」：后者会把最后一块注释从中间剁掉，
 * 留下半句话反而更容易诱导 LLM 误判。宁可少送一个文件，也不送残缺样本。
 *
 * @param {Array<{path:string, blocks:Array<{line:number, comment:string, context:string}>}>} files
 * @param {number} maxChars
 * @returns {{text:string, truncated:boolean, includedFiles:number, includedBlocks:number}}
 */
export function buildPayload(files, maxChars) {
  const limit = typeof maxChars === 'number' && maxChars > 0 ? maxChars : Infinity;
  const list = Array.isArray(files) ? files : [];

  const parts = [];
  let used = 0;
  let truncated = false;
  let includedFiles = 0;
  let includedBlocks = 0;

  for (const file of list) {
    const blocks = Array.isArray(file?.blocks) ? file.blocks : [];
    if (blocks.length === 0) continue;

    const body = blocks
      .map((b) => `L${b.line} 注释:\n${b.comment}\nL${b.line} 代码:\n${b.context}`)
      .join('\n---\n');
    const chunk = `## ${file.path}\n${body}\n\n`;

    if (used + chunk.length > limit) {
      truncated = true;
      // 一个文件就撑爆上限时硬切，否则 text 会是空的，LLM 拿不到任何样本
      if (parts.length === 0) {
        parts.push(chunk.slice(0, limit));
        used = limit;
        includedFiles += 1;
        includedBlocks += blocks.length;
      }
      break;
    }

    parts.push(chunk);
    used += chunk.length;
    includedFiles += 1;
    includedBlocks += blocks.length;
  }

  let text = parts.join('');
  // 显式标注截断，让 LLM 知道自己看到的不是全部，别对「没发现问题」下过强结论
  if (truncated) text += '…（样本已截断）';

  return { text, truncated, includedFiles, includedBlocks };
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** verdictLog 单条的截断长度：够看懂是哪条注释、模型为什么这么判即可 */
const LOG_TEXT_CLIP = 200;
const LOG_REASON_CLIP = 300;

/**
 * 把模型的全部判定原样留档（含判为 ok 的）。
 *
 * 为什么需要它：只有 restates-code / stale / dead-code 会变成 issue，判 ok 的连同模型给的
 * reason 一起被丢弃。于是出现「0 个问题」这种结果时，无法区分「模型认真判了且都合格」和
 * 「模型摆烂 / 只判了一小半」——维度②（提示词质量）就因为这个盲区白跑过一轮，
 * 一次跑出 0 条问题却没法判断是好消息还是坏消息。留档后任何一轮结果都能逐条回溯、横向对比。
 *
 * 注释原文取自 blocks 而不是模型回填：展示给用户的定位与原文必须来自磁盘事实，
 * 模型转述的原文可能被改写或截断。复合键 file#line 而不是单用 line——
 * 抽样跨 30 个文件，同一行号必然在多个文件里碰撞，只按 line 建索引会串号取到别的文件的注释。
 *
 * 截断是为了别把 optimize.json 撑爆：一次体检上百条注释块，text+reason 不设限会到几百 KB。
 *
 * @param {Array<{file?:string,line:number,verdict:string,reason?:string}>|null} verdicts
 * @param {Array<{file:string,line:number,comment:string}>} blocks 送进 LLM 的注释块（提供原文）
 */
function buildVerdictLog(verdicts, blocks) {
  if (!Array.isArray(verdicts)) return [];
  const keyOf = (file, line) => `${file}#${line}`;
  const byKey = new Map((Array.isArray(blocks) ? blocks : []).map((b) => [keyOf(b.file, b.line), b]));

  return verdicts.map((v) => {
    const src = byKey.get(keyOf(v.file, v.line)) || {};
    return {
      file: v.file ?? src.file ?? null,
      line: v.line,
      verdict: v.verdict,
      text: String(src.comment ?? '').slice(0, LOG_TEXT_CLIP),
      reason: String(v.reason ?? '').slice(0, LOG_REASON_CLIP),
    };
  });
}

/**
 * 按问题密度判分。
 *
 * @param {object} input
 * @param {number} input.sampledFiles 实际抽到的文件数（分母）
 * @param {Array<{type:string,file:string,line:number,message:string}>|null} input.findings
 *   null 表示 LLM 没跑完（超时 / 报错 / 被跳过）。
 * @param {Array<{file?:string,line:number,verdict:string,reason?:string}>|null} [input.verdicts]
 *   模型的**全部**判定（含 ok），只进 verdictLog、不参与判分。
 * @param {Array<{file:string,line:number,comment:string}>} [input.blocks] 送进 LLM 的注释块，供 verdictLog 回填原文
 *
 * 为什么 findings 和 verdicts 分成两个入参而不是就地过滤：判分口径（哪些 verdict 算问题、
 * message 怎么措辞）属于调用方的判定层，logic 层只负责「有几条问题 → 几分」这个纯计算，
 * 保持这个边界才让已有单测不依赖 verdict 词表。
 *
 * 为什么 null 要标 partial 而不是给个默认分：分数会以确定的姿态参与总分加权，
 * 一个未经分析的「80 分」和一个真的分析出来的「80 分」在用户眼里毫无区别，
 * 会把「没查」伪装成「查过没问题」。宁可让这一维不计入总分，也不制造假确定性。
 */
export function evaluateComments({ sampledFiles, findings, verdicts = null, blocks = [] } = {}) {
  const sampled = Number(sampledFiles) || 0;

  // 没有可抽样文件（空仓库 / 全是被排除的文件）不是缺陷，不该扣分，也不该计入总分
  if (sampled === 0) {
    return { score: null, status: 'na', issues: [], verdictLog: [], reason: '没有符合抽样条件的源码文件' };
  }

  if (findings === null || findings === undefined) {
    // partial 意味着这次判定没跑成，手上没有可信的 verdicts，留档字段一律给空数组——
    // 让调用方不必按 status 分支写两套取值逻辑
    return { score: null, status: 'partial', issues: [], verdictLog: [], reason: 'LLM 分析未完成，本维度不计入总分' };
  }

  const list = Array.isArray(findings) ? findings : [];
  const score = Math.round(clamp(100 - (list.length / sampled) * MAX_DEDUCT, 0, 100));

  const issues = list.map((f) => ({
    code: TYPE_TO_CODE[f.type] || 'C0_COMMENT_ISSUE',
    severity: 'info',
    file: f.file,
    line: f.line,
    message: f.message,
    // 原先一律留给人工确认，理由是「改注释要动源码，改错了比不改更误导人」。
    // 现在交给 llm-refactor，因为那条路径补上了当初缺的那道保证：
    // 改前测试必须全绿、改完立刻重跑、红了回滚**该文件**；项目没有可跑的测试时
    // 整个策略自动降级为只出清单（见 project-optimize/test-gate.logic.js）。
    // 「改错了」现在有机制发现，而不是只靠人事后察觉
    fixable: true,
    fixHint: '人工确认后修改：说明「为什么」而不是复述代码；死代码直接删除',
    meta: { type: f.type },
  }));

  return { score, status: 'done', issues, verdictLog: buildVerdictLog(verdicts, blocks) };
}

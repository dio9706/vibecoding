/**
 * LLM 编辑策略的纯逻辑层：分组、prompt 组装、模型回报校验。
 *
 * 三种策略共用这一层，因为它们的骨架完全相同（按文件分组 → 组装 prompt → 单文件写权限 →
 * 校验回报），差别只在 prompt 的约束和是否过测试闸：
 *
 *   `llm-refactor` 改源码 —— 过测试闸，改坏了回滚该文件
 *   `llm-rewrite`  改文档 —— 不过测试闸（.md 改不坏测试），但限定扩展名
 *   `llm-create`   建测试 —— 只新建，产出物必须真跑得通才保留
 *
 * ## 所有 prompt 都有一条硬约束：只准改这一个文件
 *
 * 这不只是提示词里的一句话，也是 `llm-write-agent` 的运行时白名单（那边只放行一个路径）。
 * 两处都要有：白名单是闸，提示词是**告诉模型闸在哪**——不说的话它会反复尝试改别的文件、
 * 撞一次拦截耗一轮，最后可能什么都没做完。
 *
 * 而这条约束的根源是安全模型：调用方的保证是「改一个文件 → 跑测试 → 红了回滚这个文件」，
 * 它只在**改动范围等于回滚范围**时成立（详见 llm-write-agent.js 的文件头）。
 */

/** 单个文件一次最多带几条 issue：太多会让模型在一轮里做太多互相牵扯的改动 */
const MAX_ISSUES_PER_FILE = 8;

/** 参考用的既有测试文件截断长度：够看出框架与写法，不必整份喂进去 */
const EXAMPLE_CLIP = 3000;

/**
 * 按文件分组。
 *
 * 必须分组而不是逐条改：同一个文件里的 3 条 issue 如果分 3 次调用，
 * 第 2 次看到的文件已经被第 1 次改过，issue 里的行号全部失效；
 * 而且要跑 3 遍测试。一个文件一次调用，模型自己在文件内协调这几处改动。
 */
export function groupIssuesByFile(issues = []) {
  const byFile = new Map();
  for (const it of issues) {
    const file = String(it?.file || '').trim();
    if (!file || file === '.') continue; // 没有具体文件的 issue 无法定点修
    if (!byFile.has(file)) byFile.set(file, []);
    const list = byFile.get(file);
    if (list.length < MAX_ISSUES_PER_FILE) list.push(it);
  }
  return byFile;
}

/** 把 issue 渲染成 prompt 里的待办清单 */
function renderIssues(issues) {
  return issues.map((it, i) => {
    const parts = [`${i + 1}. 第 ${it.line} 行附近（规则 ${it.code}）：${it.message}`];
    if (it.fixHint) parts.push(`   建议改法：${it.fixHint}`);
    return parts.join('\n');
  }).join('\n');
}

/** 共用的输出格式段。三种 prompt 的回报结构一致，便于同一个校验函数处理 */
const REPORT_FORMAT = [
  '## 输出格式',
  '',
  '改完后只输出一个 JSON 对象（不要 markdown 围栏）：',
  '{"changed":true,"applied":["把 X 抽成了 Y"],"skipped":[{"what":"第 3 条","why":"需要同时改另一个文件"}]}',
  '',
  '- `changed`：你是否真的写入了文件。一处都没改就填 `false`。',
  '- `applied`：**实际做了什么**，一条一句，用于给用户看。',
  '- `skipped`：没做的条目及原因。**跳过是完全可以接受的**——',
  '  做不到就如实说，不要为了「看起来完成了」而做一个自己没把握的改动。',
].join('\n');

export const REFACTOR_SYSTEM = {
  type: 'custom',
  custom: [
    '你是一位资深工程师，正在对一个文件做**行为等价**的重构。',
    '铁律：外部可观察行为必须一字不变——函数签名、返回值形状、抛出的错误、副作用顺序都不能变。',
    '你只能修改被指定的那一个文件。禁止执行命令、禁止访问网络。',
    '只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码围栏。',
  ].join('\n'),
};

/**
 * 重构 prompt。
 *
 * 「注释语言与现有代码保持一致」这一条是项目硬约定（根 CLAUDE.md：文档与注释用中文，
 * 注释解释「为什么」而非复述代码）。不写进 prompt 的话，模型会按自己的默认习惯写英文注释，
 * 于是一个精心维护中文注释的仓库被掺进几段英文——这种不一致比原来的问题更刺眼。
 */
export function buildRefactorPrompt({ file, issues, dim }) {
  return [
    `请修改 \`${file}\`，处理下面这些经过审查确认的问题。`,
    '',
    `判据出处：${dim.source}`,
    '',
    '## 待处理问题',
    '',
    renderIssues(issues),
    '',
    '## 约束（违反其中任何一条都不如不改）',
    '',
    `1. **只能修改 \`${file}\`**。如果某条问题必须同时改动别的文件才能修好，`,
    '   就把它放进 `skipped` 并说明，不要勉强在本文件里凑一个半成品。',
    '2. **行为必须等价**。这是重构不是重写：不要顺手改逻辑、不要「优化」你觉得不好的地方、',
    '   不要调整对外的函数签名或返回值形状。只做被要求的结构调整。',
    '3. **注释与现有代码保持同一语言和风格**（先看这个文件已有的注释怎么写）。',
    '   新增注释要解释「为什么这样」，不要复述代码在做什么。',
    '4. 不要动 import 的顺序和无关的空行——那会让 diff 里全是噪声，掩盖真正的改动。',
    '5. 先用 Read 把整个文件读完再动手。文件里可能有注释说明了某处「为什么必须这么写」，',
    '   那种地方不要改（如果它正是被报的问题，请把这条 skip 掉并引用那段注释）。',
    '',
    REPORT_FORMAT,
  ].join('\n');
}

export const REWRITE_SYSTEM = {
  type: 'custom',
  custom: [
    '你是一位技术写作者，正在对一份项目文档做**定点**修订。',
    '你只能修改被指定的那一个文档文件。禁止执行命令、禁止访问网络。',
    '只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码围栏。',
  ].join('\n'),
};

/**
 * 文档改写 prompt。
 *
 * 「保留作者的语气与结构」是刻意的约束：文档是人写给人看的，一次「顺便润色」
 * 会让作者认不出自己的文档，下一次他就不再信任这个工具了。定点改，别重写。
 */
export function buildRewritePrompt({ file, issues, dim, sharedContext = '' }) {
  return [
    `请修订 \`${file}\`，处理下面这些经过审查确认的问题。`,
    '',
    `判据出处：${dim.source}`,
    '',
    ...(sharedContext ? [sharedContext, ''] : []),
    '## 待处理问题',
    '',
    renderIssues(issues),
    '',
    '## 约束',
    '',
    `1. **只能修改 \`${file}\`**，且只做定点修订。`,
    '2. **保留原作者的语气、结构和格式**。不要重写段落、不要统一措辞、不要调整章节顺序。',
    '   读者应该看不出除被指出的问题之外还有任何改动。',
    '3. 语言与原文保持一致（原文是中文就写中文）。',
    '4. 涉及命令、路径、脚本名时，必须与项目的真实情况一致——拿不准就用 Read/Grep 核实，别猜。',
    '5. 先 Read 整份文档再动手。',
    '',
    REPORT_FORMAT,
  ].join('\n');
}

export const CREATE_TEST_SYSTEM = {
  type: 'custom',
  custom: [
    '你是一位资深工程师，正在为一个既有模块补写单元测试。',
    '你只能创建 / 修改被指定的那一个测试文件，**绝对不能改被测源码**。',
    '禁止执行命令、禁止访问网络。',
    '只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码围栏。',
  ].join('\n'),
};

/**
 * 新建测试 prompt。
 *
 * 三个刻意的约束，各自挡掉一种「生成了但没价值甚至有害」的测试：
 *
 * 1. **不准改源码**。模型为了让测试通过去改被测代码，是这类任务最常见也最危险的失败模式
 *    ——它会把「测试暴露了一个 bug」变成「bug 被抹掉了」。运行时白名单只放行测试文件，
 *    提示词这一条是告诉它闸在哪。
 * 2. **只测公开行为，不测实现细节**。测私有细节的测试会在每次重构时假报警，
 *    最终被人整段注释掉——比没有测试更糟（《Google 软件工程》ch12 的核心论点）。
 * 3. **写不出有意义的断言就不要写**。一个 `assert(typeof f === 'function')` 式的测试
 *    只是把覆盖率数字做上去，还会让人误以为这块有保护。
 */
export function buildTestPrompt({ sourceFile, testFile, sourceHint, example }) {
  return [
    `请为 \`${sourceFile}\` 补写单元测试，写到 \`${testFile}\`。`,
    '',
    ...(sourceHint ? [`体检结论：${sourceHint}`, ''] : []),
    '## 约束',
    '',
    `1. **只能写 \`${testFile}\`**。绝对不要修改 \`${sourceFile}\` 或任何其它文件——`,
    '   如果测试跑不过，那是发现了一个真问题，请把它写进 `skipped` 说明，而不是去改源码让它变绿。',
    '2. **只测对外公开的行为**（导出的函数 / 类的公开方法）：给定输入 → 期望输出、',
    '   边界与异常路径。不要测私有实现细节——那种测试会在每次重构时假报警，最后被人整段删掉。',
    '3. **写不出有意义的断言的部分就不要写**。宁可只覆盖三个函数但断言扎实，',
    '   也不要为了凑数写一堆「函数存在」「返回值不是 undefined」这类测试。',
    '4. 必须沿用项目现有的测试框架与写法（见下方参考），包括断言库、文件命名、用例描述语言。',
    '5. 测试必须**可独立运行**：不依赖外部服务、不依赖执行顺序、不留下临时文件。',
    '   需要文件系统时用临时目录并在结束时清理。',
    '6. 先用 Read 把被测源码读完，理解它的契约再写。',
    '',
    ...(example ? ['## 项目现有测试的写法（请沿用）', '', '```', example.slice(0, EXAMPLE_CLIP), '```', ''] : []),
    REPORT_FORMAT,
  ].join('\n');
}

/**
 * 校验模型的回报。
 *
 * 与逐条判定不同，这里**不做全有或全无**：回报只是「给用户看的说明」，
 * 真正的事实来源是 `llm-write-agent` 记录的实际写入路径与随后的测试结果。
 * 回报解析失败不影响修复的成败判定，只是文案变简略。
 */
export function validateEditReport(data) {
  if (!data || typeof data !== 'object') return null;
  const applied = (Array.isArray(data.applied) ? data.applied : [])
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 10);
  const skipped = (Array.isArray(data.skipped) ? data.skipped : [])
    .map((s) => ({ what: String(s?.what || '').trim(), why: String(s?.why || '').trim() }))
    .filter((s) => s.what || s.why).slice(0, 10);
  return { changed: data.changed !== false, applied, skipped };
}

/**
 * 把回报摘成一句结果文案。
 *
 * `skipped` 一定要带出来：用户看到「已修改」却不知道有 3 条被跳过了，
 * 会以为这个文件的问题都清了，下次体检又冒出来只会让人怀疑工具在骗人。
 */
export function summarizeReport(report, verdictText) {
  if (!report) return verdictText;
  const bits = [verdictText];
  if (report.applied.length) bits.push(`改动：${report.applied.join('；')}`);
  if (report.skipped.length) {
    bits.push(`跳过 ${report.skipped.length} 条（${report.skipped.map((s) => s.why || s.what).join('；')}）`);
  }
  return bits.join('。');
}

/** 源文件 → 配对测试文件路径。与 check-tests 的 fixHint 口径一致 */
export function testPathFor(sourceRel) {
  return String(sourceRel).replace(/\.(\w+)$/, '.test.$1');
}

/** 只允许 llm-rewrite 触碰的扩展名。改源码要走 llm-refactor（那条路径有测试闸） */
const DOC_EXT = /\.(?:md|markdown|txt|mdx)$/i;

export function isDocFile(rel) {
  return DOC_EXT.test(String(rel));
}

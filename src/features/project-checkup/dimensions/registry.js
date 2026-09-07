/**
 * 维度注册表 —— 整个体检 / 优化功能的**唯一声明来源**。
 *
 * ## 它取代了什么
 *
 * 原来加一个维度要动四处：建 `check-X.js` + `check-X.logic.js`、在 `score.logic.js` 加权重、
 * 在 `optimize-ops.js` 的 RUNNERS 登记、在前端 `DIM_META` 登记。四处任一漏改都是静默失效
 * （前端 DIM_META 漏登记时，后端算得再对也完全不显示）。
 *
 * 现在：**在本表加一条声明**。分数、调度、修复策略、前端展示全部从这里读。
 *
 * ## 每条声明的字段契约
 *
 * | 字段 | 说明 |
 * |---|---|
 * | `id` | 维度 key，也是 `report.dims` 的键、缓存键、前端勾选值 |
 * | `label` / `hint` | 前端展示用 |
 * | `category` | 所属域，前端按它分组 |
 * | `weight` | 总分权重。**省略即不参与加权**（holistic 与 augment 型条目都省略） |
 * | `source` | 判据的权威出处。给用户看的，让结论可争辩而不是只能服从 |
 * | `engine` | `'audit'` 走通用审计引擎；`'legacy'` 有自己的检测器（既有六维） |
 * | `recall` | 召回器（仅 audit）。返回候选数组，或 `{candidates, sharedContext}` |
 * | `verdicts` | 判定词表。**同时是校验白名单、扣分表、issue 码表**——三者分开写必然漂移 |
 * | `scoring` | 判分方式，见下方「两种判分口径」 |
 * | `rubric` | 判据文案（rubrics-*.js） |
 * | `fingerprintScope` | 吃哪一份指纹（collect.js 的 fingerprints）。决定缓存何时失效 |
 * | `fix` | 修复策略，见 project-optimize/fix-engine.js |
 * | `augments` | 本条目的结果并入哪个维度（不单独成维度、不参与加权） |
 * | `fixContext` | `(evidence) => string`：修复期要注入 prompt 的项目事实。
 *   判定期的共享上下文由召回器返回，但**修复期没有召回步骤**，所以要单独声明——
 *   漏了它，`docs` 的改写会在「以真实脚本为准」这句话下面拿到一段空白 |
 * | `risk` | **仅专用流程维度（map / rules）需要**。其余维度的风险由策略决定
 *   （见 fix-engine.logic.js 的 `STRATEGY_RISK`），因为一个维度可以有多种修法、
 *   风险各不相同（prompts 的去重是低风险、规则改写是中风险） |
 * | `fixOrder` | 修复管线里的执行次序。**顺序不是审美，每一步为后一步创造前提**：
 *   10~19 机械与配置层（零源码风险，最快）；20 建立测试安全网（必须在源码重构之前，
 *   否则第 40 段整批降级）；30~39 文档层（放在源码之前，因为改源码会让地图更过期）；
 *   40~49 源码层（需测试闸放行，内部按「改动面从大到小」——先删死代码可能让后面几项无事可做，
 *   反序会做白工：先改好名字的函数下一步就被删了）；50~59 只出清单（跨文件设计决策，人拍板）；
 *   90 整体计划（最后，读前面各步的实际结果） |
 *
 * ## 两种判分口径，以及为什么必须有两种
 *
 * - `absolute`：问题条数直接换算扣分。适合「一条就够糟」且候选量不随项目规模增长的维度
 *   （一个可利用的注入点不会因为项目大就没那么严重）。
 * - `density`：按「每个源文件摊到多少问题」扣分。适合候选量与项目规模成正比的维度
 *   ——1000 个文件的项目有 50 个长函数和 20 个文件的项目有 50 个长函数，
 *   前者健康得多，用绝对条数会把大项目一律判成不及格。
 *
 * `factor` 是密度到扣分的换算系数，`maxDeduct` 是扣分上限（防止单一维度直接归零，
 * 那会让分数失去分辨力——0 分和 0 分之间看不出差别）。
 * **这两个数字是首轮估值、未经实测校准**（见 spec §9 的风险表），
 * 调整它们前先看 `verdictLog`：那里留着每一轮的全量判定，可以横向对比。
 */
import {
  recallOversizedUnits, recallSimilarBlocks, recallVagueNames,
  recallDeadCode, recallCatchBlocks, recallRiskyPatterns, recallHardcodedConfig,
} from '../evidence/selectors-code.logic.js';
import {
  recallImportGraph, recallDepManifest, recallOnboardingDocs, recallSuspiciousTracked,
} from '../evidence/selectors-project.logic.js';
import * as RC from './rubrics-code.js';
import * as RP from './rubrics-project.js';

/** 域：前端按它分组展示，也是 holistic 组织行动计划的骨架 */
export const CATEGORIES = [
  { key: 'ai', label: 'AI 协作配置' },
  { key: 'quality', label: '代码质量' },
  { key: 'architecture', label: '架构' },
  { key: 'robustness', label: '健壮性' },
  { key: 'engineering', label: '工程化' },
  { key: 'holistic', label: '整体评估' },
];

/** 不产出 issue 的判定档位，写起来比每处重复 `{ weight: 0 }` 清楚 */
const OK = { weight: 0 };

export const DIMENSIONS = [
  // ==================== 域 A · AI 协作配置 ====================
  {
    id: 'map',
    label: '项目地图',
    hint: '地图是否建立、是否过期、引用是否失效',
    category: 'ai',
    weight: 10,
    source: '本项目的 AI 协作约定',
    engine: 'legacy',
    fixOrder: 30,
    fix: 'llm-rewrite',
    // 会新建与改写各级 CLAUDE.md。不影响运行时，但地图写偏了会持续误导后续每次开发
    risk: 'medium',
  },
  {
    id: 'prompts',
    label: '提示词质量',
    hint: '规则是否过度宽泛、是否互相冲突、是否重复',
    category: 'ai',
    weight: 11,
    source: '本项目实测的「规则诱发多余劳动」判据',
    engine: 'legacy',
    fixOrder: 32,
    // 复合策略：P4_DUPLICATE（重复条目）是纯机械的删行，交确定性策略；
    // P1/P2/P3 要理解语义才改得动，交文档改写。分派按 issue 码，见 fix-engine.logic.js
    fix: ['deterministic', 'llm-rewrite'],
  },
  {
    id: 'rules',
    label: '规范加载方式',
    hint: '大块规范是否该从 rules 降级为 skill',
    category: 'ai',
    weight: 4,
    source: '按需加载优于常驻注入',
    engine: 'legacy',
    fixOrder: 31,
    // 归高风险而不是跟着 deterministic 走低风险：`fix-rules.js` 的文件头写明它是
    // **本功能唯一的破坏性操作**——删除规则文件 + 改写全仓引用。
    // 策略名相同不代表风险相同，这就是专用流程维度要显式声明 risk 的原因
    risk: 'high',
    fix: 'deterministic',
  },

  // ==================== 域 B · 代码质量 ====================
  {
    id: 'complexity',
    label: '复杂度与函数规模',
    hint: '长函数、深嵌套、参数过多、巨型文件',
    category: 'quality',
    weight: 7,
    source: '《代码整洁之道》ch3；《代码大全》ch7 / ch19',
    engine: 'audit',
    recall: recallOversizedUnits,
    rubric: RC.complexity,
    fingerprintScope: 'sources',
    verdicts: {
      'must-split': { weight: 8, code: 'X1_MUST_SPLIT', severity: 'warn' },
      'should-split': { weight: 3, code: 'X2_SHOULD_SPLIT', severity: 'info' },
      acceptable: OK,
    },
    scoring: { mode: 'density', factor: 40, maxDeduct: 70 },
    fixOrder: 42,
    fix: 'llm-refactor',
  },
  {
    id: 'duplication',
    label: '重复实现',
    hint: '同一条知识在多处各写一遍（DRY 违背）',
    category: 'quality',
    weight: 6,
    source: '《重构》Duplicated Code；《程序员修炼之道》DRY',
    engine: 'audit',
    recall: recallSimilarBlocks,
    rubric: RC.duplication,
    fingerprintScope: 'sources',
    verdicts: {
      extract: { weight: 6, code: 'D1_EXTRACT', severity: 'warn' },
      acceptable: OK,
    },
    scoring: { mode: 'density', factor: 90, maxDeduct: 60 },
    fixOrder: 41,
    fix: 'llm-refactor',
  },
  {
    id: 'naming',
    label: '命名与意图表达',
    hint: '导出符号的名字是否说明了它做什么',
    category: 'quality',
    weight: 4,
    source: '《代码整洁之道》ch2；《编写可读代码的艺术》ch2 / ch3',
    engine: 'audit',
    recall: recallVagueNames,
    rubric: RC.naming,
    fingerprintScope: 'sources',
    verdicts: {
      rename: { weight: 5, code: 'N1_RENAME', severity: 'info' },
      acceptable: OK,
    },
    scoring: { mode: 'density', factor: 100, maxDeduct: 40 },
    // 改名要动全部调用点，而调用点里有字符串引用（路由表、清单）时静态改写会漏。
    // 只出清单、由人决定——这条边界与 security / structure 同理
    fixOrder: 43,
    fix: 'advisory',
  },
  {
    id: 'comments',
    label: '注释合理性',
    hint: '注释是否解释「为什么」、是否已过期',
    category: 'quality',
    weight: 4,
    source: '《代码整洁之道》ch4',
    engine: 'legacy',
    fixOrder: 44,
    fix: 'llm-refactor',
  },
  {
    id: 'deadcode',
    label: '死代码与未使用导出',
    hint: '零引用的导出、被注释掉的代码块',
    category: 'quality',
    weight: 3,
    source: 'YAGNI；《重构》Dead Code / Speculative Generality',
    engine: 'audit',
    recall: recallDeadCode,
    rubric: RC.deadcode,
    fingerprintScope: 'sources',
    verdicts: {
      remove: { weight: 4, code: 'Z1_REMOVE', severity: 'info' },
      keep: OK,
    },
    scoring: { mode: 'density', factor: 35, maxDeduct: 50 },
    fixOrder: 40,
    fix: 'llm-refactor',
  },

  // ==================== 域 C · 架构 ====================
  {
    id: 'structure',
    label: '分层与依赖方向',
    hint: '反向依赖、循环依赖、跨层直连',
    category: 'architecture',
    weight: 12,
    source: '《架构整洁之道》依赖规则；SOLID-D',
    engine: 'audit',
    recall: recallImportGraph,
    rubric: RP.structure,
    fingerprintScope: 'sources',
    verdicts: {
      violation: { weight: 9, code: 'A1_DEP_VIOLATION', severity: 'error' },
      smell: { weight: 3, code: 'A2_DEP_SMELL', severity: 'warn' },
      acceptable: OK,
    },
    // 权重从 20 降到 9 **不是为了让分数好看**，而是为了保住分辨力。
    //
    // 2026-09-03 实测：本仓库 8 条 violation + 2 条 smell。按旧值算 8×20=160，
    // 被 maxDeduct 80 截断 → 20 分；而修掉一半（4 条）仍是 4×20=80 → 还是 20 分。
    // **用户修掉一半的违规却看不到任何变化**，指标就失去了反馈作用，
    // 而这个维度的全部价值就在于「改了有没有进步」。
    //
    // 新值下的曲线：1 条 → 91、4 条 → 58、8 条 → 22、12 条 → 15。
    // 结论强度没有被软化（8 条真违规仍然是 22 分的重灾区），只是中间有了刻度。
    scoring: { mode: 'absolute', maxDeduct: 85 },
    // 解耦一条反向依赖要重新设计接口归属，是跨文件的设计决策。
    // 机器给证据和方案，人拍板——这是本功能刻意不越过的边界
    fixOrder: 51,
    fix: 'advisory',
  },

  // ==================== 域 D · 健壮性 ====================
  {
    id: 'tests',
    label: '测试健康度',
    hint: '测试是否全绿、大文件是否缺测试',
    category: 'robustness',
    weight: 12,
    source: '《Google 软件工程》ch11；《修改代码的艺术》',
    engine: 'legacy',
    fixOrder: 20,
    // S2（大文件缺测试）有具体目标文件，可生成；S1（测试挂红）与 S3（零测试）没有
    // 单一目标文件，会被兜底 advisory 接住——修失败用例是真开发工作，不该由机器代劳
    fix: 'llm-create',
  },
  {
    id: 'errors',
    label: '错误处理与稳定性',
    hint: '静默吞异常、只打日志、缺诊断信息',
    category: 'robustness',
    weight: 7,
    source: '《Release It!》稳定性模式；《Effective Java》ch10',
    engine: 'audit',
    recall: recallCatchBlocks,
    rubric: RC.errors,
    fingerprintScope: 'sources',
    verdicts: {
      'must-fix': { weight: 12, code: 'E1_SILENT_FAILURE', severity: 'error' },
      'should-fix': { weight: 5, code: 'E2_LOST_DIAGNOSTICS', severity: 'warn' },
      acceptable: OK,
    },
    scoring: { mode: 'density', factor: 90, maxDeduct: 80 },
    fixOrder: 45,
    fix: 'llm-refactor',
  },
  {
    id: 'security',
    label: '敏感信息与危险用法',
    hint: '硬编码凭证、注入面、弱加密、明文传输',
    category: 'robustness',
    weight: 6,
    source: 'OWASP Top 10',
    engine: 'audit',
    recall: recallRiskyPatterns,
    rubric: RC.security,
    fingerprintScope: 'sources',
    verdicts: {
      vulnerable: { weight: 22, code: 'S1_VULNERABLE', severity: 'error' },
      risky: { weight: 7, code: 'S2_RISKY', severity: 'warn' },
      'false-positive': OK,
    },
    // 同 structure 的理由：旧值（30 / 上限 100）在 4 条就打满，之后修多少都不动。
    // 新曲线：1 条 → 78、2 条 → 56、3 条 → 34、4 条 → 12、5 条以上 → 5。
    // 「一个可利用的漏洞就该让这一维很难看」这个口径保留了（单条直接扣到 78），
    // 只是不再在第 4 条之后失去刻度
    scoring: { mode: 'absolute', maxDeduct: 95 },
    // 安全修复必须人过目：自动改写一处注入点而改错，会把「已知有洞」变成「以为修好了」，
    // 后者更危险。只出清单
    fixOrder: 50,
    fix: 'advisory',
  },

  // ==================== 域 E · 工程化 ====================
  {
    id: 'hygiene',
    label: '仓库卫生',
    hint: '运行数据、临时脚本是否误入版本库',
    category: 'engineering',
    weight: 4,
    source: '版本库只放需要协同演进的内容',
    engine: 'legacy',
    fixOrder: 10,
    fix: 'deterministic',
  },
  {
    // augment 型条目：不是独立维度，结果并进 hygiene。
    //
    // 为什么要这个机制：hygiene 的确定性规则刻意做成**零误报**（只认 .jsonl/.log 和
    // tmp-/temp-/debug- 前缀），代价是召回极低——`cobe-probe.tmp.mjs` 这类命名抓不到。
    // 但那层的零误报保证不能动（它没有 LLM 兜底）。于是分成两层：
    // 确定性层保下限，本条目用 LLM 补召回，两者的 issue 合并展示、扣分累加。
    id: 'hygiene-audit',
    label: '仓库卫生（AI 深化）',
    category: 'engineering',
    source: '同 hygiene',
    engine: 'audit',
    augments: 'hygiene',
    recall: recallSuspiciousTracked,
    rubric: RP.hygiene,
    fingerprintScope: 'tracked',
    verdicts: {
      'should-ignore': { weight: 6, code: 'H3_SHOULD_IGNORE', severity: 'info' },
      keep: OK,
    },
    scoring: { mode: 'absolute', maxDeduct: 40 },
    fixOrder: 10,
    fix: 'deterministic',
  },
  {
    id: 'deps',
    label: '依赖健康',
    hint: '未使用 / 缺失声明 / 功能重复的依赖',
    category: 'engineering',
    weight: 4,
    source: '《Google 软件工程》ch21',
    engine: 'audit',
    recall: recallDepManifest,
    rubric: RP.deps,
    fingerprintScope: 'manifest',
    verdicts: {
      add: { weight: 12, code: 'P1_MISSING_DEP', severity: 'error' },
      consolidate: { weight: 6, code: 'P2_DUPLICATE_DEP', severity: 'warn' },
      remove: { weight: 4, code: 'P3_UNUSED_DEP', severity: 'info' },
      acceptable: OK,
    },
    scoring: { mode: 'absolute', maxDeduct: 60 },
    fixOrder: 11,
    fix: 'advisory',
  },
  {
    id: 'config',
    label: '配置与环境收口',
    hint: '硬编码地址 / 路径 / 端口，env 是否收口',
    category: 'engineering',
    weight: 3,
    source: '12-Factor App §3',
    engine: 'audit',
    recall: recallHardcodedConfig,
    rubric: RC.config,
    fingerprintScope: 'sources',
    verdicts: {
      externalize: { weight: 8, code: 'C1_EXTERNALIZE', severity: 'warn' },
      acceptable: OK,
    },
    scoring: { mode: 'absolute', maxDeduct: 60 },
    fixOrder: 12,
    fix: 'advisory',
  },
  {
    id: 'docs',
    label: '文档可上手性',
    hint: 'README 的上手命令能否真的跑通',
    category: 'engineering',
    weight: 3,
    source: '《Google 软件工程》ch10',
    engine: 'audit',
    recall: recallOnboardingDocs,
    rubric: RP.docs,
    fingerprintScope: 'docs',
    // 修复期必须重新注入真实脚本清单：rubric 明写「以共享上下文为准」，
    // 而那段在判定期由召回器给出、修复期没有召回步骤。不给就只剩模型自己去猜或去读盘
    fixContext: (ev) => {
      const scripts = Object.entries(ev?.manifest?.scripts || {});
      if (!scripts.length) return '## 项目清单里没有声明任何脚本';
      const list = scripts.map(([k, v]) => `- npm run ${k} → ${v}`).join('\n');
      return `## 项目真实可用的脚本（文档里的命令必须与它一致）\n\n${list}`;
    },
    verdicts: {
      broken: { weight: 18, code: 'O1_BROKEN_ONBOARDING', severity: 'error' },
      outdated: { weight: 6, code: 'O2_OUTDATED_DOC', severity: 'warn' },
      acceptable: OK,
    },
    // 同 structure / security：旧值（25 / 上限 80）在 4 条就触顶。
    // 新曲线 1 条 → 82、2 条 → 64、4 条 → 28。「第一条上手命令就跑不通」
    // 仍然直接扣 18 分（新人的第一步断在那里，值这个分量）
    scoring: { mode: 'absolute', maxDeduct: 85 },
    fixOrder: 33,
    fix: 'llm-rewrite',
  },

  // ==================== 域 F · 综合 ====================
  {
    id: 'holistic',
    label: '整体智能评估',
    hint: '读全部维度结论，给出该先做的几件事',
    category: 'holistic',
    // 刻意不给 weight：它是对其它维度的**元评估**，计入总分等于把同一批问题数两遍。
    // aggregateScore 只遍历 WEIGHTS 的 key，不在表里就天然被排除，无需额外分支
    source: '综合全部维度',
    engine: 'holistic',
    fixOrder: 90,
    fix: 'advisory',
  },
];

const BY_ID = new Map(DIMENSIONS.map((d) => [d.id, d]));

export function dimensionById(id) {
  return BY_ID.get(id) || null;
}

/** 走通用审计引擎的维度（含 augment 型） */
export function auditDimensions() {
  return DIMENSIONS.filter((d) => d.engine === 'audit');
}

/** 参与总分加权的维度 → `{id: weight}`，供 score.logic.js 的 WEIGHTS 使用 */
export function weightMap() {
  const out = {};
  for (const d of DIMENSIONS) if (typeof d.weight === 'number') out[d.id] = d.weight;
  return out;
}

/** 前端要展示的维度（augment 型不单独成卡片） */
export function displayDimensions() {
  return DIMENSIONS.filter((d) => !d.augments);
}

/**
 * 按修复管线顺序排好的维度。
 *
 * 编排层直接按这个顺序循环即可，不必自己记「测试要在源码重构之前」这类前提关系
 * ——那些关系已经编码进 fixOrder（见字段契约表）。
 */
export function fixOrderedDimensions() {
  return [...DIMENSIONS].sort((a, b) => (a.fixOrder ?? 999) - (b.fixOrder ?? 999));
}

/**
 * 修复引擎的分派层（纯函数）：一个维度的 issue 该由哪个策略处理。
 *
 * ## 核心规则：没有 issue 会被静默丢掉
 *
 * 原来的行为是——用户勾了没有自动修复能力的维度，只得到一句
 * 「勾选的 X 维度暂无自动修复能力，未做任何改动」（`fix-plan.logic.js` 的 buildFixNotes）。
 * 那句话本身是诚实的，但产出为零：用户勾它就是想要点什么。
 *
 * 现在的规则是**兜底 advisory**：任何策略都不认领的 issue，一律进整改清单。
 * 于是每一条 issue 的归宿只有两种——被改掉，或者出现在一份带定位、带依据、带改法的清单里。
 * 「什么都没发生」不再是可能的结果。
 *
 * ## 降级也走同一条路
 *
 * 源码维度被测试闸挡下时（项目没测试 / 测试是红的），它的全部 issue 转进 advisory，
 * 并带上降级原因。这样「没有安全网所以没改」和「没有能力所以没改」在实现上是同一条路径，
 * 不会出现一条有产出、另一条没有的不一致。
 */
import { HANDLED_CODES } from './strategies/deterministic.logic.js';
import { isDocFile } from './strategies/llm-edit.logic.js';

/**
 * 每种策略的风险档位 —— **风险属于策略，不属于维度**。
 *
 * 这个归属很关键：`prompts` 一个维度里，P4 重复条目去重是纯机械的删行（低风险），
 * 而 P1/P2 的规则改写要理解语义（中风险）。按维度定风险就没法表达这种差别，
 * 只能一刀切成保守的那一档，于是本来安全的去重也被挡在「中高风险」按钮后面。
 *
 * 三档的判据是**改错了的后果范围**，不是改动的技术难度：
 *   low    —— 不动任何既有代码：只新增文件（测试、整改清单）或改配置（.gitignore），
 *             且都可逆。测试生成也在这一档：它只新建，跑不通就删掉，绝不碰被测源码。
 *   medium —— 改既有**文档**（CLAUDE.md / README）。不影响运行时，但会影响 AI 与新人
 *             对项目的理解，改偏了是「静默误导」而不是「立刻报错」。
 *   high   —— 改既有**源码**。有测试闸兜着（改前绿、改后重跑、红了回滚该文件），
 *             但测试覆盖不到的行为仍然可能被改变。
 */
export const STRATEGY_RISK = {
  advisory: 'low',
  deterministic: 'low',
  'llm-create': 'low',
  'llm-rewrite': 'medium',
  'llm-refactor': 'high',
};

/** 给 UI 用的档位说明。文案放这里而不是前端，免得两处措辞漂移 */
export const RISK_META = [
  { key: 'low', label: '低风险', hint: '不改既有代码：只新增测试与整改清单、改 .gitignore、删重复条目' },
  { key: 'medium', label: '中风险', hint: '改既有文档（CLAUDE.md / README），不影响运行时' },
  { key: 'high', label: '高风险', hint: '改既有源码，有测试闸兜底但仍可能改变未被测试覆盖的行为' },
];

export function riskOf(strategy) {
  return STRATEGY_RISK[strategy] || 'high'; // 不认识的策略按最保守档处理
}

/**
 * 必须有**绿色测试基线**才能执行的策略。
 *
 * `llm-refactor` 需要基线是显然的（改源码要能发现改坏）。
 * **`llm-create` 同样需要，这一点很容易漏**：它靠「生成后跑一遍测试」判断产出物好不好，
 * 而那跑的是**全量测试**。项目本来就有失败用例时，每一份新生成的测试都会被判成
 * 「未通过」然后删掉——即便它自己完全正确。
 *
 * 实测形状：本仓库当前有 14 个既有失败（jsdom 缺 ResizeObserver），
 * 不设这道闸的话 `tests` 维度会把生成的每一份测试都删光，还报「生成的测试未通过」，
 * 用户据此会以为模型写不出能跑的测试。
 */
const GATED_STRATEGIES = new Set(['llm-refactor', 'llm-create']);

/** 维度声明的 fix 字段归一成数组。允许写字符串是因为大多数维度只有一种修法 */
export function strategiesOf(dim) {
  const raw = dim?.fix;
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return raw ? [raw] : ['advisory'];
}

/**
 * 这个维度在给定风险档位下有没有事可做。
 *
 * `advisory` 恒为 low，所以**任何维度在低风险档位下都至少能产出整改清单**——
 * 这正是我们要的：点「低风险优化」不会让高风险维度变成什么都没有，
 * 而是拿到一份「这些问题需要你走高风险优化或手工处理」的清单。
 */
export function dimHasWorkAt(dim, allowedRisks) {
  return strategiesOf(dim).some((s) => allowedRisks.includes(riskOf(s)))
    || allowedRisks.includes('low'); // advisory 兜底
}

/** issue 是否指向一个可定点编辑的具体文件 */
function hasEditableTarget(issue) {
  const f = String(issue?.file || '');
  return !!f && f !== '.' && /\.\w+$/.test(f);
}

/**
 * 某个策略是否认领这条 issue。
 *
 * ## `fixable: false` 是检测器的**逐条否决权**
 *
 * 检测器比引擎更了解单条 issue 的性质。同一个维度里的两条 issue 可能一条能自动修、
 * 一条不能——`tests` 维度就是典型：S2（某个大文件缺测试）有明确的生成目标，
 * 而 S1（项目测试挂红，issue 的 file 是 `package.json`）根本不是「给 package.json 补测试」，
 * 修它是真正的开发工作。
 *
 * 不尊重这个字段的后果实测过：S1 会被 `llm-create` 认领，
 * 目标路径算成 `package.test.json`，然后让模型给 package.json 写单元测试。
 *
 * `advisory` 不看这个字段——它是兜底，被否决的 issue 正是要落到它这里。
 *
 * ## rewrite 与 refactor 用扩展名切开，是安全边界而不是分类偏好
 *
 * rewrite 那条路径没有测试闸（文档改不坏测试），一旦让它碰源码，
 * 就等于开了一个「改源码不跑测试」的洞——本设计里最不该有的那个洞。
 */
export function claims(strategy, issue) {
  if (strategy === 'advisory') return true;
  // 检测器明确说了不可自动修，就一条都不碰
  if (issue?.fixable === false) return false;

  switch (strategy) {
    case 'deterministic':
      return HANDLED_CODES.has(issue?.code);
    case 'llm-rewrite':
      return hasEditableTarget(issue) && isDocFile(issue.file);
    case 'llm-refactor':
    case 'llm-create':
      return hasEditableTarget(issue) && !isDocFile(issue.file);
    default:
      return false;
  }
}

/**
 * 把一个维度的 issue 分派到各策略。
 *
 * @param {object} args
 * @param {object} args.dim 维度声明
 * @param {Array} args.issues
 * @param {boolean} args.gateAllowed 测试闸是否放行（只影响 llm-refactor）
 * @param {string} [args.gateReason] 闸关闭的原因，会写进清单首行
 * @returns {{byStrategy:Array<{strategy:string, issues:Array}>, advisory:Array,
 *   degradeReason:string, degraded:boolean}}
 */
export function partitionIssues({
  dim, issues = [], gateAllowed = true, gateReason = '',
  allowedRisks = ['low', 'medium', 'high'],
} = {}) {
  const strategies = strategiesOf(dim);
  const gated = strategies.filter((s) => GATED_STRATEGIES.has(s) && allowedRisks.includes(riskOf(s)));
  const degraded = gated.length > 0 && !gateAllowed;

  // 两道过滤，顺序无关但都会把被摘掉的策略的 issue 推给 advisory 兜底：
  //   1. 风险档位：用户点「低风险优化」时，改文档与改源码的策略整个不参与
  //   2. 测试闸：需要绿色基线的策略在没有安全网时摘掉
  // 摘掉而不是「跑一遍再逐个拒」——后者会为每个文件白跑一次 LLM 调用
  const active = strategies
    .filter((s) => allowedRisks.includes(riskOf(s)))
    .filter((s) => !(degraded && GATED_STRATEGIES.has(s)));

  const byStrategy = [];
  const claimed = new Set();

  for (const strategy of active) {
    if (strategy === 'advisory') continue; // advisory 是兜底，最后统一处理
    const mine = issues.filter((it, i) => !claimed.has(i) && claims(strategy, it));
    // 记下已认领的下标：同一条 issue 不该被两个策略各改一遍
    issues.forEach((it, i) => { if (mine.includes(it)) claimed.add(i); });
    if (mine.length) byStrategy.push({ strategy, issues: mine });
  }

  const advisory = issues.filter((it, i) => !claimed.has(i));

  // 因风险档位被摘掉的策略：编排层要据此在清单里写明「这些要走中高风险优化」，
  // 否则用户点了低风险、看到清单里有源码问题，会以为工具没能力修
  const skippedByRisk = strategies
    .filter((st) => !allowedRisks.includes(riskOf(st)))
    .map((st) => ({ strategy: st, risk: riskOf(st) }));

  return {
    byStrategy,
    advisory,
    degraded,
    degradeReason: degraded ? gateReason : '',
    skippedByRisk,
  };
}

/**
 * 本次优化涉及哪些维度。
 *
 * 三个条件缺一不可：
 *   1. 用户勾了它（空数组 = 全都要，这是老前端的行为，改成静默不做会让旧页面点了没反应）
 *   2. 这一维跑出了**完整**结果（partial / analyzing 的结论不完整，拿它驱动修改会漏改错改）
 *   3. 有 issue 可处理
 *
 * `map` / `rules` 刻意排除：它们有各自校准过的专用修复流程（`fix-map.js` / `fix-rules.js`），
 * 走通用引擎会把那些校准丢掉。编排层单独调它们。
 */
export const BESPOKE_DIMS = new Set(['map', 'rules']);

export function selectFixableDims({
  dimensions = [], report = null, requested = [], allowedRisks = ['low', 'medium', 'high'],
} = {}) {
  const want = (id) => !requested.length || requested.includes(id);
  const out = [];

  for (const dim of dimensions) {
    if (BESPOKE_DIMS.has(dim.id)) continue;
    if (dim.augments) continue; // augment 型的 issue 已经并进宿主维度，不重复处理
    if (!want(dim.id)) continue;
    if (!dimHasWorkAt(dim, allowedRisks)) continue;

    const d = report?.dims?.[dim.id];
    if (!d || d.status !== 'done') continue;
    if (!d.issues?.length) continue;

    out.push({ dim, issues: d.issues });
  }

  return out;
}

/**
 * 本次是否有策略需要绿色测试基线 —— 决定要不要花几分钟去开测试闸。
 *
 * 带上风险档位：点「低风险优化」时源码重构整个不参与，不必为它开闸。
 * 但**低风险档里的 `llm-create` 照样要开**——它靠跑全量测试判断生成的测试好不好，
 * 没有基线就分不清「新测试写坏了」和「项目本来就是红的」（见 GATED_STRATEGIES 的说明）。
 */
export function needsTestGate(selected = [], allowedRisks = ['low', 'medium', 'high']) {
  return selected.some(({ dim }) => strategiesOf(dim).some(
    (s) => GATED_STRATEGIES.has(s) && allowedRisks.includes(riskOf(s)),
  ));
}

/**
 * 把前端传来的档位归一成允许的风险集合。
 *
 * 两个入口：`'low'` → 只做低风险；`'elevated'` → 中 + 高（**不含低**，
 * 因为低风险那部分用户点第一个按钮就做完了，重复做只会重复写清单）。
 * 传别的值时 fail-closed 到只做低风险——这是个会改代码的操作，
 * 拿不准就该做最保守的那件事，而不是最激进的。
 */
export function risksFor(level) {
  if (level === 'elevated') return ['medium', 'high'];
  if (level === 'all') return ['low', 'medium', 'high'];
  return ['low'];
}

/**
 * 一键优化的选材与提示：从体检报告里挑出「能自动修的」，以及生成给用户的手工待办。
 * 纯函数，不碰文件系统。
 */

/**
 * 已具备自动修复能力的维度 —— 现在**全部**维度都有，所以这张表由注册表派生。
 *
 * 它原来是一份手写的 `['rules', 'map']`，配合下面的 `buildFixNotes` 产出一句
 * 「勾选的 X 维度暂无自动修复能力，未做任何改动」。那句话诚实但产出为零。
 *
 * 现在的规则是：每个维度都至少有一种修法，最弱的一档是 `advisory`
 * （产出带定位、带依据、带改法的整改清单）。所以「勾了却什么都没发生」不再可能，
 * 这张表也退化成「注册表里声明过 fix 的维度」——保留它是因为
 * `buildFixNotes` 仍需在**降级**时提醒用户（见下方第 4 条）。
 */
import { DIMENSIONS } from '../project-checkup/dimensions/registry.js';
import { strategyForIssue, strategiesOf, riskOf, BESPOKE_DIMS } from './fix-engine.logic.js';
import { decideGate } from './test-gate.logic.js';

export const SUPPORTED_DIMENSIONS = DIMENSIONS.filter((d) => d.fix && !d.augments).map((d) => d.id);

const RULES_PREFIX = '.claude/rules/';

/** 会写地图文件的任务类型 —— 用来判断要不要发 mtime 提醒 */
const MAP_KINDS = new Set(['gen-map', 'stale-audit', 'dead-link']);

/**
 * 从体检报告里挑出可自动降级的 rules 文件。
 *
 * `fixable` 这个字段是检测器给的判断，这里**只读不改**——尤其是 `R2_DEMOTE_UNCERTAIN`
 * （有 frontmatter 但解析不出 paths）故意标成不可自动修：降级要删文件、改写全仓引用，
 * 基于一个「可能是解析器不认识的写法」的猜测去做，代价远大于少优化一条。
 *
 * 被挡下的项要如实返回而不是丢掉——用户看到「这条没动，因为 XXX」才知道要去人工处理。
 *
 * @param {object|null} report 体检报告
 * @param {number[]|null} [pickIndices] 只处理这些 issue 下标；`null` = 全选（既有调用点的行为）。
 *   空数组表示「一条都没勾」，与 null 语义**不同**——用户明确取消全部勾选时不该退回全做
 * @returns {{files:string[], blocked:Array<{file:string, reason:string}>}} files 是文件名（含 .md）
 */
export function selectFixableRules(report, pickIndices = null) {
  const issues = report?.dims?.rules?.issues;
  if (!Array.isArray(issues)) return { files: [], blocked: [] };

  const pick = pickIndices ? new Set(pickIndices) : null;

  const files = [];
  const seen = new Set();
  const blocked = [];

  for (let i = 0; i < issues.length; i += 1) {
    if (pick && !pick.has(i)) continue;
    const it = issues[i];
    const file = String(it?.file || '');
    // 别的维度将来也可能产出 fixable 的 issue，降级只认 rules 目录下的
    if (!file.startsWith(RULES_PREFIX)) continue;

    if (it.fixable !== true) {
      blocked.push({ file, reason: String(it?.message || '检测器标记为不可自动修复') });
      continue;
    }
    // 同一个文件可能命中多条规则，降级只做一次
    const name = file.slice(RULES_PREFIX.length);
    if (seen.has(name)) continue;
    seen.add(name);
    files.push(name);
  }

  return { files, blocked };
}

/**
 * 生成「机器做不了、需要你自己动手」的提示。
 *
 * 每条都对应一种「不说就会被误以为已经处理好了」的情况：
 *
 * 1. **勾了不支持的维度**。理论上已不可能（每个维度都有 fix 策略），
 *    但保留这条判断：注册表将来加了没写 fix 的维度时，它是唯一的兜底告知。
 * 2. **根 CLAUDE.md 里还留着旧文件名**。项目地图常有一张「规则文件 | 覆盖范围」的索引表，
 *    表格里写的是裸文件名（`design-system.md`）而不是带目录的路径，
 *    replaceRuleRefs 只认反引号包裹的完整路径，匹配不到它 —— 于是表里留下一行
 *    指向已删除文件的条目。这个改不了自动化：表格的列结构因项目而异，
 *    机器分不清该改成技能名还是整行删掉，只能请用户看一眼。
 * 3. **地图文件被写过，M3 的过期告警会消失**。check-map.js 判过期靠
 *    「代码 mtime - 地图 mtime」，而本次写入把地图 mtime 推到了当下 → staleDays 归零 →
 *    下次体检不报 M3、map 分数还涨，**但地图正文并没有变新鲜**。
 *    这正是 describe-skill.js 开头警告的「分数变好、实际变差」形状。
 *    追加块自带日期是第一道提醒，这条 note 是第二道——两道都别删。
 *
 * @param {object} [args]
 * @param {string[]} [args.requested] 用户勾选的维度
 * @param {Array<{status:string,file:string,skillName?:string,kind?:string}>} [args.results]
 *   demoteOne（带 skillName）与地图修复（带 kind）的结果混在一起
 * @param {string|null} [args.rootClaudeMd] 降级完成后根 CLAUDE.md 的内容；读不到传 null
 * @param {{allowed:boolean, reason:string}} [args.gate] 本次实际的测试闸裁决。
 *   传了就用它的 reason 说明降级原因——原来这里写死「缺少可用的测试安全网」，
 *   而真实原因常常是「测试有失败用例」。对一个有 106 个测试文件的项目说它「缺少测试」，
 *   用户只会觉得这句话说的不是自己，于是整条告知失效。
 * @returns {string[]}
 */
export function buildFixNotes({ requested, results, rootClaudeMd, gate } = {}) {
  const notes = [];
  const list = Array.isArray(results) ? results : [];

  const unsupported = (Array.isArray(requested) ? requested : [])
    .filter((d) => !SUPPORTED_DIMENSIONS.includes(d));
  if (unsupported.length) {
    notes.push(`勾选的 ${unsupported.join('、')} 维度暂无自动修复能力，未做任何改动。`);
  }

  const md = typeof rootClaudeMd === 'string' ? rootClaudeMd : '';
  if (md) {
    const residual = list
      // 只看 rules 降级的结果：地图结果的 file 不以 .claude/rules/ 开头，
      // 拿它去 slice 会切出一段垃圾字符串，再用它做 includes 匹配就是误报源
      .filter((r) => r?.status === 'done' && r.skillName)
      // 比对原文件名而不是技能名：技能名会出现在刚替换好的 `/xxx` 里，拿它去搜必然误报
      .map((r) => String(r.file || '').slice(RULES_PREFIX.length))
      .filter((name) => name && md.includes(name));

    if (residual.length) {
      notes.push(
        `根 CLAUDE.md 里仍出现 ${residual.join('、')}（多半是索引表里的裸文件名，` +
        '自动替换只认带反引号的完整路径），请手工改成对应技能或删掉该行。',
      );
    }
  }

  const mapWrites = list.filter((r) => r?.status === 'done' && MAP_KINDS.has(r.kind));
  if (mapWrites.length) {
    notes.push(
      `本次改写了 ${mapWrites.length} 份地图文件，它们的时间戳已刷新——` +
      '「地图过期」告警在下次体检时会消失，但这不代表地图正文已经跟上代码。' +
      '请以地图末尾的「⚠️ 自动核对」块为准，那里列出的差异仍需人工处理。',
    );
  }

  // 4. **产出的是清单而不是改动**。用户看到「优化完成」不会自己去翻 `.claude/optimize/`，
  //    不指路的话这些清单等于没产出——而它们是安全 / 架构 / 命名这几维的**全部**产出。
  const advisories = list.filter((r) => r?.status === 'done' && r.kind === 'advisory');
  if (advisories.length) {
    notes.push(
      `有 ${advisories.length} 份整改清单写在 \`.claude/optimize/\` 下（安全、架构、命名这类` +
      '涉及跨文件设计决策的问题不自动改写，只给证据和方案）；' +
      '总体行动计划见 `.claude/optimize/PLAN.md`。',
    );
  }

  // 5. **源码维度被测试闸挡下了**。这是最容易被误解的一种情况：用户看到「优化完成」，
  //    合理地以为源码已经改过。必须显式否认，并说清怎样才能解锁。
  const degraded = list.filter((r) => r?.kind === 'advisory' && /未改动代码|测试/.test(r.reason || ''));
  if (degraded.length) {
    // 原因取自本次真实的闸裁决。没传 gate 才退回通用措辞——**不要**再无条件说
    // 「缺少测试安全网」：那句话对「有测试但跑不过」的项目是错的，而那正是最常见的一种
    const why = gate && !gate.allowed && gate.reason
      ? gate.reason
      : '缺少可用的测试安全网。让「测试健康度」维度先把测试补起来（或修好现有的失败用例），下一轮优化就能自动修复源码。';
    notes.push(
      `源码维度**没有改动任何代码**，只产出了 ${degraded.length} 份清单。原因：${why}`,
    );
  }

  // 6. **git 索引被动过，而还原只管文件内容**。这是实现层面的真实局限（备份层没有
  //    「索引快照」这个概念），不说就会变成「用户以为还原了、其实文件又被 git add 回来」。
  const untracked = list.filter((r) => r?.status === 'done' && r.kind === 'untrack');
  if (untracked.length) {
    notes.push(
      `有 ${untracked.length} 个文件已从 git 索引移除（文件仍在磁盘上）。` +
      '注意：「还原」只恢复文件内容，**不会**把它们加回索引——需要时请手工 `git add`。',
    );
  }

  return notes;
}

/**
 * 动作标签 —— 给用户看的「勾了会发生什么」。
 *
 * 与风险是同一来源（策略）的两面，所以放同一张表：这保证了标签与实际行为不可能漂移。
 * `bespoke-*` 两条对应 map / rules 的专用流程，它们不走策略表
 * （理由见 registry.js 里 rules 的 risk 字段说明）。
 */
export const ACTION_META = {
  deterministic: { label: '改配置', hint: '追加 .gitignore、git rm --cached、按行删重复条目' },
  'llm-create': { label: '新建测试', hint: '只新建文件，跑不通会自动删掉，绝不碰被测源码' },
  advisory: { label: '只出清单', hint: '写一份带定位、依据、改法的整改清单到 .claude/optimize/，不改任何文件' },
  'llm-rewrite': { label: '改文档', hint: '改写既有 CLAUDE.md / README 等文档，不影响运行时' },
  'llm-refactor': { label: '改源码', hint: '改写既有源码，有测试闸兜底（改前绿、改后重跑、红了回滚该文件）' },
  'bespoke-map': { label: '生成/改写地图', hint: '新建或改写各级 CLAUDE.md 项目地图' },
  'bespoke-rules': { label: '降级为技能', hint: '删除规则文件并改写全仓引用——本功能唯一的破坏性操作' },
};

/**
 * 会被测试闸挡下的策略。与 `fix-engine.logic.js` 的 `GATED_STRATEGIES` 同源，
 * 但这里**只列 llm-refactor**：`llm-create` 被挡下时是「不新建测试」，
 * 用户预期里本来就没有「它会改我的代码」，不需要在标签上改口。
 */
const GATED_IN_PLAN = new Set(['llm-refactor']);

/**
 * 从体检报告预判测试闸会不会开。
 *
 * ## 为什么需要「预判」
 *
 * 真正的闸在 `test-gate.js` 的 `openGate`，它要**现跑一遍测试**，只有修复开始后才有答案。
 * 但那时用户已经点下去了——而这正是最需要提前知道的一件事：实测 kxmall-app-ui 的
 * 317 项问题里 165 项（52%）是 `llm-refactor`，闸一关这一整档**一行代码都不会改**，
 * 用户却会看着「改源码·高风险」的标签以为它们都要动。
 *
 * 所以拿体检时跑出来的 `testRun` 先算一次。两者可能不一致（体检之后测试被修好了），
 * 但那个方向是安全的：预判说「不会改」而实际改了，比反过来强得多。
 *
 * `known:false` 表示报告里没有这个字段（旧报告，或 tests 维度没跑完）——
 * 此时调用方应当**不做任何降级标注**，宁可不说也不要说错。
 *
 * @param {object|null} report
 * @returns {{known:boolean, allowed:boolean, reason:string}}
 */
export function previewGate(report) {
  const testRun = report?.dims?.tests?.testRun;
  if (!testRun || typeof testRun.status !== 'string') {
    return { known: false, allowed: true, reason: '' };
  }
  return { known: true, ...decideGate(testRun) };
}

/**
 * 单个计划项的策略与风险。
 *
 * bespoke 维度（map / rules）不走策略表：它们的 issue 由专用流程处理，风险取注册表声明。
 * 但**检测器逐条否决（fixable !== true）的仍退回 advisory** —— 那些项根本不会被执行，
 * 标成「降级为技能·高风险」会吓退用户去勾一件其实什么都不会发生的事。
 */
function classifyPlanItem(dim, issue) {
  if (BESPOKE_DIMS.has(dim.id)) {
    if (issue?.fixable !== true) return { strategy: 'advisory', risk: 'low' };
    return { strategy: `bespoke-${dim.id}`, risk: dim.risk || 'high' };
  }
  const strategy = strategyForIssue(strategiesOf(dim), issue);
  return { strategy, risk: riskOf(strategy) };
}

/**
 * 构建修复计划：把报告里每条 issue 摊平成一个可勾选项，并标注动作与风险。
 *
 * ## 为什么不直接复用 partitionIssues
 *
 * 它返回的是「按策略分组」，而 UI 要的是「逐条」。两者的认领规则由
 * `strategyForIssue` 统一提供（见 fix-engine.logic.js），所以这里没有二次实现。
 *
 * ## map / rules 的例外
 *
 * 这两维走专用流程，风险显式声明在注册表的 `risk` 字段上——`rules` 的策略是
 * `deterministic`（按策略表算低风险），但它会删文件并改写全仓引用，实际是最高风险。
 * 按策略表推会把破坏性操作标成「低风险」并**默认勾上**，这是绝不能出的错。
 *
 * @param {object|null} report 体检报告
 * @param {Array<object>} dimensions 维度声明（注册表的 fixOrderedDimensions()）
 * @returns {{at:string, items:Array<object>}}
 */
export function buildFixPlan(report, dimensions) {
  const items = [];
  const gate = previewGate(report);
  // 闸确定关着时，llm-refactor 项的标签必须改口。不改的话它写着「改源码·高风险」，
  // 而实际产出只有一份清单——用户「全选 → 修复 → 重新体检还是三百多项」的体验就是这么来的
  const degradeRefactor = gate.known && !gate.allowed;

  for (const dim of dimensions || []) {
    if (dim?.augments) continue; // augment 条目已并进宿主维度，不重复列出
    const d = report?.dims?.[dim.id];
    if (!d || d.status !== 'done') continue;
    const issues = Array.isArray(d.issues) ? d.issues : [];

    issues.forEach((issue, index) => {
      const { strategy, risk } = classifyPlanItem(dim, issue);
      // 被闸挡下的项：**策略本身不改**（执行侧仍按原路走，降级由 fix-engine 决定，
      // 这里动它就会出现两套判定），只在展示层如实改口并把风险降到 low——
      // 一件「只写一份 markdown」的事标成高风险，会让用户误以为取消勾选是在避险
      const degraded = degradeRefactor && GATED_IN_PLAN.has(strategy);
      items.push({
        id: `${dim.id}#${index}`,
        dim: dim.id,
        dimLabel: dim.label || dim.id,
        category: dim.category || '',
        file: String(issue?.file || ''),
        line: Number(issue?.line) || 0,
        message: String(issue?.message || ''),
        severity: String(issue?.severity || 'info'),
        strategy,
        action: degraded ? '只出清单' : (ACTION_META[strategy]?.label || strategy),
        risk: degraded ? 'low' : risk,
        ...(degraded ? { degraded: true } : {}),
      });
    });
  }

  return { at: String(report?.at || ''), items };
}

/**
 * 把前端传来的计划项 id 还原成「维度 → issue 子集」。
 *
 * ## 这是一道安全边界，不是格式转换
 *
 * 本功能持有 bypassPermissions 级的写权限：`llm-refactor` 能改写任意源码。
 * 如果让前端直接回传 issue 对象（实现起来更省事），改一下请求体的 `file` 字段
 * 就能指挥模型去重构仓库里任何一个文件。所以**前端只能传下标，
 * 真实的 file / line / message 一律从后端自己落盘的报告里取**。
 *
 * 同理，下标必须逐个校验：越界、负数、非整数、未知维度、未跑完的维度，
 * 一律丢弃并计入 rejected（由调用方记日志）——不能信任前端传来的任何数字。
 *
 * @param {object|null} report
 * @param {string[]} ids 形如 `complexity#3`
 * @returns {{byDim:Object<string,Array>, indicesByDim:Object<string,number[]>, rejected:string[]}}
 */
export function resolveSelection(report, ids) {
  /** @type {Object<string, number[]>} */
  const picked = {};
  const rejected = [];
  const seen = new Set();

  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw);
    if (seen.has(id)) continue; // 重复只算一次，不计入 rejected（那不是错误）
    seen.add(id);

    const at = id.lastIndexOf('#');
    if (at <= 0) { rejected.push(id); continue; }

    const dimId = id.slice(0, at);
    const idxRaw = id.slice(at + 1);
    // 三道都要判：Number('') === 0、Number('1.5') === 1.5、Number('abc') === NaN，
    // 少判一条就会让脏下标混进来
    const idx = Number(idxRaw);
    if (idxRaw === '' || !Number.isInteger(idx) || idx < 0) { rejected.push(id); continue; }

    const d = report?.dims?.[dimId];
    // status 必须是 done：analyzing / partial 的结论不完整，拿它驱动修改会漏改错改
    if (!d || d.status !== 'done' || !Array.isArray(d.issues) || idx >= d.issues.length) {
      rejected.push(id);
      continue;
    }

    (picked[dimId] ||= []).push(idx);
  }

  const byDim = {};
  const indicesByDim = {};
  for (const [dimId, list] of Object.entries(picked)) {
    // 升序：保持与报告里的 issue 顺序一致，下游按行号倒序删除等逻辑依赖稳定次序
    const sorted = [...list].sort((a, b) => a - b);
    indicesByDim[dimId] = sorted;
    byDim[dimId] = sorted.map((i) => report.dims[dimId].issues[i]);
  }

  return { byDim, indicesByDim, rejected };
}

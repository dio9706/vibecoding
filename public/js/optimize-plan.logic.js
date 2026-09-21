/**
 * 修复计划勾选树的纯逻辑层：不碰 DOM，可在 node 下单测。
 *
 * 这里承载的是「勾了什么、按钮该长什么样」这类判定。把它们留在渲染函数里，
 * 就会重演 `checkupBusy` 那次事故的形状——状态变量改了、某个渲染分支没跟上，
 * 而这种漏改在没有纯函数边界时既测不到、也看不出来。
 */

/** 风险档位的展示文案。与后端 RISK_META 对应，措辞保持一致 */
export const RISK_LABEL = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

/**
 * 初始勾选：只勾低风险。
 *
 * 这是个会改文件的操作，默认值必须是最保守的那个。但也不能默认全不勾——
 * 那会让用户面对一棵上百项的空树无从下手。低风险项本身是安全的
 * （只新增文件、改配置、出清单），默认勾上既有产出又不会造成意外改动。
 */
export function defaultSelection(items) {
  return new Set((items || []).filter((i) => i?.risk === 'low').map((i) => i.id));
}

/**
 * 按「域 → 维度」两层分组，组内保持计划里的原始顺序。
 *
 * 刻意不排序：计划本身已按注册表的 fixOrder 排好，那个顺序有语义
 * （补测试在改源码之前，因为源码重构要拿测试当安全网），
 * 重排会让用户看到的次序与实际执行次序不一致。
 */
export function groupPlan(items) {
  const byCat = new Map();
  for (const it of items || []) {
    if (!byCat.has(it.category)) byCat.set(it.category, new Map());
    const dims = byCat.get(it.category);
    if (!dims.has(it.dim)) dims.set(it.dim, { dim: it.dim, dimLabel: it.dimLabel, items: [] });
    dims.get(it.dim).items.push(it);
  }
  return [...byCat.entries()].map(([category, dims]) => ({
    category,
    dims: [...dims.values()],
  }));
}

/**
 * 一个节点（域或维度）的勾选态。
 *
 * 空节点返回 'none' 而不是 'all'：`[].every()` 恒为 true，不特判的话
 * 一个没有任何可修项的分组会显示成「已全选」，点一下却什么都没发生。
 *
 * @returns {'all'|'some'|'none'}
 */
export function nodeCheckState(ids, selected) {
  const list = ids || [];
  if (!list.length) return 'none';
  const n = list.filter((id) => selected.has(id)).length;
  if (n === 0) return 'none';
  return n === list.length ? 'all' : 'some';
}

/**
 * 切换一个节点：全选态 → 全不选，其余（含半选）→ 全选。
 *
 * 半选按「变全选」处理，是因为用户点一个半选分组时想的是「都要」——
 * 点成全不选会把他刚才手工勾的那几条也一起清掉。
 *
 * 返回新 Set 而不是原地改：调用方按不可变语义重渲染，避免漏掉某处更新。
 */
export function toggleNode(ids, selected) {
  const next = new Set(selected);
  const state = nodeCheckState(ids, selected);
  for (const id of ids || []) {
    if (state === 'all') next.delete(id);
    else next.add(id);
  }
  return next;
}

/**
 * 当前勾选里的中高风险项 —— 二次确认弹窗的取材。
 *
 * 已处理的排除掉：它们这一轮不会再被执行，为它们要求确认是无谓的恐吓。
 */
export function riskyPicks(items, selected, handled) {
  const done = handled || new Set();
  return (items || []).filter(
    (i) => selected.has(i.id) && !done.has(i.id) && (i.risk === 'medium' || i.risk === 'high'),
  );
}

/**
 * 顶部按钮区该显示什么。
 *
 * ## 两个数必须分清
 *
 * - **显示 / 隐藏「一键修复」** 看的是计划里**还有没有未处理项**（与勾选无关）。
 *   用户只勾低风险修完后，中高风险项仍未处理，按钮该留着。
 * - **`fixCount` 与可点性** 看的是**当前勾选且未处理**的数量。
 *   全取消勾选时禁用但**不隐藏**——隐藏会让用户以为没东西可修了。
 *
 * 优先级：体检中 > 修复中 > 无报告 > 全部处理完 > 正常。
 * 体检排最前是因为那一刻报告是上一轮的旧值，任何基于它的按钮都不该可点。
 *
 * @returns {{mode:'idle'|'checking'|'fixing'|'ready'|'done-all', fixCount:number, fixDisabled:boolean}}
 */
/**
 * 五种状态下四个顶部按钮各自显不显示。
 *
 * 单列成一张表而不是散在渲染函数里：这四个按钮是**互斥**的，
 * 而「修复中忘了隐藏重新体检」「体检完中止按钮还在」这类漏改，
 * 只有把 5×4 个格子摆在一起才看得出来——它们也确实同时漏过。
 *
 * ⚠️ 这张表只管 `hidden` 属性。另一半在 CSS：`.opt-score-actions .btn` 是
 * `display:inline-flex`，作者样式会压过 UA 的 `[hidden]{display:none}`，
 * 必须有 `.opt-score-actions .btn[hidden]{display:none}` 兜着，否则这里算得再对也不生效。
 *
 * @param {'idle'|'checking'|'fixing'|'ready'|'done-all'} mode
 */
export function buttonVisibility(mode) {
  return {
    // 修复中一并隐藏：那一刻它既不能点，留着也只是让用户去试一下再被拒
    checkup: mode === 'idle' || mode === 'ready' || mode === 'done-all',
    cancelCheckup: mode === 'checking',
    fix: mode === 'ready',
    cancelFix: mode === 'fixing',
  };
}

export function topButtonsState({ hasReport, checkupBusy, fixRunning, items, selected, handled }) {
  if (checkupBusy) return { mode: 'checking', fixCount: 0, fixDisabled: true };
  if (fixRunning) return { mode: 'fixing', fixCount: 0, fixDisabled: true };
  if (!hasReport) return { mode: 'idle', fixCount: 0, fixDisabled: true };

  const list = items || [];
  const done = handled || new Set();
  const remaining = list.filter((i) => !done.has(i.id));
  if (!remaining.length) return { mode: 'done-all', fixCount: 0, fixDisabled: true };

  const fixCount = remaining.filter((i) => selected.has(i.id)).length;
  return { mode: 'ready', fixCount, fixDisabled: fixCount === 0 };
}

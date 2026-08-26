// 「一键优化」按钮的纯逻辑层：可用性判定、文案、结果统计。
// 不碰 DOM，不 import 其它模块，方便单测和后续被 optimize-view 等宿主复用。

/**
 * 判断「一键优化」按钮是否可点。
 * 三个条件缺一不可：
 * - 必须已经跑出报告（否则不知道要优化什么）
 * - 必须至少勾选了一项（避免用户误触发全量操作）
 * - 不能正在跑（避免重复提交并发请求）
 * 参数按可选处理，未传时一律视为「不满足」，避免调用方漏传字段导致误判为可点。
 */
export function canFix({ hasReport, selected, running } = {}) {
  return hasReport === true && Array.isArray(selected) && selected.length > 0 && running !== true;
}

/** 按钮文案随运行状态切换，运行中要明确告知用户「正在处理」防止误以为卡死。 */
export function fixButtonLabel(running) {
  return running ? '优化中…' : '一键优化';
}

/**
 * SSE step 事件里 phase 的中文说明。
 *
 * 未知 phase 原样回显而不是给「未知步骤」：后端将来加新阶段时，
 * 用户至少能看到个标识，而不是一行空白或一堆「未知」。
 */
const STEP_LABEL = {
  plan: '规划要处理的文件',
  backup: '创建还原快照',
  describe: '生成技能描述',
  'write-skill': '写入技能文件',
  'delete-rule': '删除原规则文件',
  'replace-refs': '改写文档引用',
  abort: '已中止',
};

export function stepLabel(phase) {
  const key = typeof phase === 'string' ? phase : '';
  return STEP_LABEL[key] || key;
}

/**
 * 脏工作区的确认文案。
 *
 * 光说「有未提交改动」用户不会当回事——要说清后果：优化产生的改动会和手头的活混在一起，
 * 事后想分辨哪些是自己改的、哪些是工具改的会非常费劲。
 *
 * 非 git 仓库要单独措辞：有 git 时用户还能 `git checkout` 兜底，
 * 没有时唯一的退路就是本工具的快照，风险口径不一样，不该套用同一句话。
 */
export function dirtyConfirmMessage({ dirtyCount, isRepo } = {}) {
  if (isRepo === false) {
    return '这个目录不是 git 仓库，出问题只能靠本工具的还原快照，没有 git 可以兜底。确定继续？';
  }
  return `工作区有 ${Number(dirtyCount) || 0} 个未提交改动，优化产生的改动会和它们混在一起，事后难以分辨。建议先提交或暂存。确定继续？`;
}

/** 数组长度；字段缺失或形状不对时按 0 计，不让统计条炸掉整个结果区 */
function countOf(v) {
  return Array.isArray(v) ? v.length : 0;
}

/**
 * 汇总后端返回的优化结果数组，供 UI 展示统计条。
 * results 可能是 null/undefined（比如接口异常时上游未兜底），一律按空数组处理。
 *
 * `refsUpdated` / `refsFailed` 的形状以 demoteOne 的实际返回为准——都是数组
 * （前者是被改写的文件路径，后者是 {path, reason}）。这里原本按数字处理，
 * 而数组过 Number() 只要多于一个元素就是 NaN，统计恒为 0；
 * 这个契约是在 demoteOne 实现之前先写好的，属于猜错了生产者的形状。
 */
export function summarizeResults(results) {
  const list = Array.isArray(results) ? results : [];

  let done = 0;
  let skipped = 0;
  let failed = 0;
  let refsTotal = 0;
  let refsFailedTotal = 0;
  const fallbackNames = [];

  for (const item of list) {
    if (!item) continue;
    // 引用改写失败与降级本身的成败无关（降级照样算 done），但必须计数：
    // 那意味着文档里留了指向已删除文件的路径，用户不看见就永远不会去修
    refsFailedTotal += countOf(item.refsFailed);
    if (item.status === 'done') {
      done += 1;
      refsTotal += countOf(item.refsUpdated);
      // description 由「机械模板兜底」生成时质量差——它决定 skill 能否被正确唤起，
      // 所以要单独挑出来，提示用户人工复核这些 skill 的描述文案。
      if (item.descriptionSource === 'fallback') {
        fallbackNames.push(item.skillName);
      }
    } else if (item.status === 'skipped') {
      skipped += 1;
    } else if (item.status === 'failed') {
      failed += 1;
    }
  }

  const text = list.length === 0
    ? '没有可处理的项'
    : `成功 ${done} · 跳过 ${skipped} · 失败 ${failed}`;

  return {
    done, skipped, failed, refsTotal, refsFailedTotal,
    fallbackCount: fallbackNames.length, fallbackNames, text,
  };
}

/**
 * 生成优化前后分数变化的展示文案。
 * before/after 任一为 null（比如首次优化没有历史分数）时，退化为只展示已知的那个值；
 * 两者都缺失时用 '--' 占位，避免界面出现 NaN 或空白。
 */
export function scoreDelta(before, after) {
  if (before == null && after == null) return '--';
  if (before == null) return `${after}`;
  if (after == null) return `${before}`;

  const diff = after - before;
  const diffText = diff === 0 ? '无变化' : (diff > 0 ? `+${diff}` : `${diff}`);
  return `${before} → ${after}（${diffText}）`;
}

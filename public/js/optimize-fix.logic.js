// 修复流程的纯逻辑层：步骤文案、结果统计、确认文案。
// 不碰 DOM，不 import 其它模块，方便单测和被 optimize-view / optimize-report 复用。
//
// 注：按钮的可用性判定与文案（原 canFix / fixButtonLabel）已移交
// `optimize-plan.logic.js` 的 `topButtonsState` —— 风险从「按钮档位」改成「逐项标签」后，
// 按钮状态不再由「勾了几个维度」决定，而由计划项的已处理/未处理与勾选共同决定，
// 旧的两个函数无法表达 done-all 这类状态，留着只会有两套并存的判定。

/**
 * 一条 issue 行在本轮修复里的进度态。
 *
 * ## 为什么粒度是「维度 + 文件」而不是逐条 issue
 *
 * 后端进度流给不出 planId：`step` 事件带的是 `{phase, dim, text}`，`file` 事件带的是
 * `{file, kind, status}`。所以只能用两个可观测量合成：
 *   - **维度**：修复管线按 `fixOrder` **串行**跑维度，`step.dim` 就是「现在在修哪一维」；
 *   - **文件**：`file` 事件一到，说明那个文件的结果已经落定。
 * 靠文件名反查 planId 是不行的——一个文件常对应多条 issue，会把同文件的行全部标掉。
 *
 * ## 维度已跑过、但这一条没等到 file 事件时，为什么算 'done' 而不是「排队中」
 *
 * 修复引擎有一条硬规则：**没有 issue 会被静默丢掉**——任何策略都不认领的、被测试闸挡下的，
 * 一律写进整改清单（见 fix-engine.js 头注释）。那份清单是整维一个文件，不会逐条回报。
 * 所以维度过去了就意味着这一条已被处理过，继续显示「排队中」是明确的假话，
 * 而且看起来像卡死了。真实结果以结束后的修复报告为准。
 *
 * @param {object} args
 * @param {boolean} args.inRound 是否在本轮提交的计划项里
 * @param {string} args.dim 该条所属维度 id
 * @param {string} args.file 该条对应的文件路径
 * @param {string} args.activeDim 当前正在跑的维度 id（''=还没开跑或已跑完全部）
 * @param {Set<string>} args.seenDims 已经开跑过的维度 id（含当前这个）
 * @param {Map<string,string>} args.doneFiles 文件 → 后端回报的 status
 * @returns {'idle'|'queued'|'running'|'done'|'failed'}
 */
export function fixRowState({ inRound, dim, file, activeDim, seenDims, doneFiles }) {
  if (!inRound) return 'idle';
  const st = doneFiles?.get?.(file);
  // status 只有 'done' 算成功，其余（failed / skipped / 任何将来新增的值）一律按未完成显示 —— fail-closed
  if (st) return st === 'done' ? 'done' : 'failed';
  if (dim && dim === activeDim) return 'running';
  if (dim && seenDims?.has?.(dim)) return 'done'; // 维度已跑过，见上方说明
  return 'queued';
}

/** 进度态 → 行尾文案。'idle' 不显示任何标签（那是常态，加字只会变成噪声） */
export const FIX_STATE_LABEL = {
  queued: '排队中',
  running: '修复中',
  done: '已处理',
  failed: '未完成',
};

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
  'dead-link': '修复地图死链',
  'gen-map': '生成项目地图',
  // 测试闸：源码重构的准入检查。用户看到这一步在跑几分钟测试时得知道为什么
  'test-gate': '检查测试安全网',
  // 五种修复策略。原样露出策略名而不是笼统写「修复中」——
  // 用户据此知道这一步是在真改代码（refactor/rewrite）还是只在出清单（advisory）
  deterministic: '机械修复（无 AI 参与）',
  'llm-refactor': '重构源码（改完立刻跑测试）',
  'llm-rewrite': '修订文档',
  'llm-create': '生成测试文件',
  advisory: '生成整改清单',
  degrade: '缺少测试安全网，改为只出清单',
  'plan-file': '写出整体行动计划',
  cancelling: '正在停止',
  abort: '已中止',
};

export function stepLabel(phase) {
  const key = typeof phase === 'string' ? phase : '';
  return STEP_LABEL[key] || key;
}

/**
 * 结果条目的 `kind` → 给用户看的「这条做了什么」。
 *
 * 必须展示：风险分级的全部意义就是让用户知道**哪些改了代码、哪些只写了清单**。
 * 结果列表只有文件名和一句 reason 的话，「重构了 src/a.js」和「为 src/a.js 写了条清单」
 * 看起来一模一样——那用户就没法判断这次优化到底动了什么。
 */
const KIND_LABEL = {
  advisory: '整改清单',
  refactor: '重构源码',
  rewrite: '修订文档',
  'create-test': '新建测试',
  ignore: '改 .gitignore',
  untrack: '脱离 git 索引',
  dedupe: '删重复条目',
  'gen-map': '生成地图',
  'stale-audit': '地图核对块',
  'dead-link': '修复死链',
};

export function kindLabel(kind) {
  const k = typeof kind === 'string' ? kind : '';
  // 未知 kind 原样回显：后端加新策略时用户至少看得到标识，而不是一片空白
  return KIND_LABEL[k] || k;
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

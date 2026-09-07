/**
 * deterministic 策略的判定层（纯函数）：机械、可预测、无 LLM 参与的编辑。
 *
 * ## 这一档存在的意义
 *
 * 有些修复的正确答案是唯一的、可机械推导的：一个运行日志被 git 追踪了，
 * 修法就是「加进 .gitignore + 从索引移除」，没有判断空间。
 * 让 LLM 去做这类事只会引入不确定性和成本。
 *
 * 所以判断留给检测层（那一步已经由 LLM 判过了），执行留给这里，纯函数、可直测。
 */

/** 本工具写入 .gitignore 的托管段标记。有它才能在还原时准确识别自己加了哪些行 */
export const IGNORE_SECTION_HEADER = '# --- 由项目优化功能自动添加 ---';

/**
 * 一行 .gitignore 规则是否已经覆盖了目标路径。
 *
 * 只做三种保守判断——精确相同、目录前缀、简单的 `*.ext` 后缀通配。
 * **刻意不实现完整的 gitignore 通配语义**（`**`、`!` 取反、字符类）：
 * 实现错了的后果是重复添加一条已被覆盖的规则，代价极小；
 * 而为了追求完整性引入一个半对的匹配器，会在「以为覆盖了其实没覆盖」时漏掉真正的修复。
 * 宁可多写一行冗余规则。
 */
export function ignoreCovers(rule, rel) {
  const r = rule.trim();
  if (!r || r.startsWith('#') || r.startsWith('!')) return false;
  const clean = r.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!clean) return false;
  if (clean === rel) return true;
  if (rel.startsWith(`${clean}/`)) return true; // 目录规则
  const ext = /^\*(\.[A-Za-z0-9.]+)$/.exec(clean);
  if (ext && rel.endsWith(ext[1])) return true;
  return false;
}

/**
 * 算出要往 .gitignore 追加哪些行。
 *
 * 用**精确路径**而不是通配（`*.jsonl`）：通配会顺手忽略掉项目里其它同类文件，
 * 其中可能有本该入库的（测试夹具里的 `.jsonl` 就是这种）。精确路径的行为可预测、
 * 影响面等于用户在清单上看到的那几条，也让「还原」有确定的撤销目标。
 *
 * @param {string} existing 现有 .gitignore 内容（没有该文件传空串）
 * @param {string[]} rels 要忽略的相对路径
 * @returns {{text:string, added:string[], alreadyCovered:string[]}}
 */
export function mergeGitignore(existing, rels) {
  const lines = String(existing ?? '').split(/\r?\n/);
  const added = [];
  const alreadyCovered = [];

  for (const rel of rels) {
    if (lines.some((l) => ignoreCovers(l, rel))) alreadyCovered.push(rel);
    else if (!added.includes(rel)) added.push(rel);
  }

  if (!added.length) return { text: String(existing ?? ''), added, alreadyCovered };

  const base = String(existing ?? '');
  const needsNewline = base.length > 0 && !base.endsWith('\n');
  const text = base
    + (needsNewline ? '\n' : '')
    + (base.length ? '\n' : '')
    + `${IGNORE_SECTION_HEADER}\n`
    + `${added.join('\n')}\n`;

  return { text, added, alreadyCovered };
}

/**
 * 删掉文件里重复出现的条目，只保留第一处。
 *
 * 用于提示词维度的 P4_DUPLICATE。输入的行号来自检测器（`check-prompts.js` 的
 * `findDuplicateGroups`），是**同一段文本在同一文件里出现的全部行号**。
 *
 * 两个安全设计：
 * 1. **按行号从大到小删**。从小到大删会让后续行号全部前移，第二次删除就删错行了。
 * 2. **删前核对内容**。行号是上一次体检时算的，文件可能已经被人改过。
 *    核对不上就整条跳过——宁可不修，也不能删掉一行别的东西。
 *
 * @param {string} text 文件内容
 * @param {number[]} lines 重复条目出现的全部行号（1 基）
 * @param {string} sample 用于核对的条目原文（归一化后比较）
 * @returns {{text:string, removed:number[], mismatched:number[]}}
 */
export function dropDuplicateLines(text, lines, sample) {
  const arr = String(text ?? '').split(/\r?\n/);
  const norm = (s) => String(s ?? '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const want = norm(sample);

  // 第一处要保留，所以从第二个行号开始；倒序删除避免行号前移
  const targets = [...new Set(lines)].sort((a, b) => a - b).slice(1).reverse();
  const removed = [];
  const mismatched = [];

  for (const ln of targets) {
    const idx = ln - 1;
    if (idx < 0 || idx >= arr.length || (want && norm(arr[idx]) !== want)) {
      mismatched.push(ln);
      continue;
    }
    arr.splice(idx, 1);
    removed.push(ln);
  }

  return { text: arr.join('\n'), removed: removed.reverse(), mismatched };
}

/** 本策略认领的 issue 码。不在表里的交给别的策略或 advisory 兜底 */
export const HANDLED_CODES = new Set([
  'H1_RUNTIME_DATA_TRACKED',
  'H2_ONESHOT_TRACKED',
  'H3_SHOULD_IGNORE',
  'P4_DUPLICATE',
]);

/** 需要「加 .gitignore + 从索引移除」的那几个码 */
export const IGNORE_CODES = new Set([
  'H1_RUNTIME_DATA_TRACKED',
  'H2_ONESHOT_TRACKED',
  'H3_SHOULD_IGNORE',
]);

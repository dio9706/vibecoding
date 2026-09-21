/**
 * 三个扫描维度（map / prompts / comments）共用的目录排除规则。
 *
 * 抽出的动机：原先 check-map / check-prompts / check-comments 各持一份 SKIP_DIR，
 * 三份互不一致（check-map 少了 .expo 与 worktrees），同一个项目在不同维度下扫描范围不同。
 */

export const SKIP_DIR = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.expo',
  // 两种写法都要有：原实现只写 'worktrees'，而 git worktree 的惯用目录名是 '.worktrees'
  //（带点），规则因此形同虚设。worktree 里是主仓库的完整副本，漏掉会把同一份配置重复计分。
  'worktrees',
  '.worktrees',
  // 测试夹具是刻意写成「健康」或「有问题」的假配置（如 tests/fixtures/projects/demote-target/
  // CLAUDE.md），被当成真实项目配置参与评分会污染分数，送进 LLM 还要白烧额度。
  'fixtures',
  '__fixtures__',
  // 本功能**自己**打的备份（.claude/optimize-backup/<时间戳>/files/ 下是整个源码树的完整快照）。
  //
  // 不排除它就形成自我污染的正反馈：跑一次优化 → 留下一份全量副本 → 用户一次 `git add .`
  // 就让副本进了索引 → 下轮体检把副本当真源码扫 → 问题数暴涨 → 再修再备份。
  // 实测（kxmall-app-ui，2026-09-21）：317 项问题里 **140 项（44%）**出自上一轮的备份目录，
  // 其中 hygiene 的 77 项**全部**是它，complexity/errors/duplication/prompts/deps 另有 63 项。
  //
  // 放共用的 SKIP_DIR 而不是 collect.js 的 EXTRA_SKIP_DIR：那层注释担心的是「改扫描范围会让
  // 既有六维的批大小/超时预算校准失效」，而这一条只会**减少**候选量，不会把批次撑爆；
  // 且它是工具自产物，没有任何维度该评价它——不是 vendor/archive 那种取舍型排除。
  'optimize-backup',
]);

/**
 * 是否跳过该目录。
 *
 * 注意 `tests` 本身**不**在排除列表里：真实测试代码的注释质量同样值得体检，
 * 只有夹具目录（fixtures）才是假数据。
 *
 * @param {string} name 目录名（非路径）
 * @param {boolean} [opts.skipHidden] 连所有点开头的目录一并跳过。
 *   check-map 的既有行为依赖它（只找代码模块，无需进 .claude/.github 等），
 *   另两个维度不开——它们要能进 .claude 找规则文件。
 */
export function shouldSkipDir(name, { skipHidden = false } = {}) {
  if (!name) return false;
  if (SKIP_DIR.has(name)) return true;
  if (skipHidden && name.startsWith('.')) return true;
  return false;
}

/**
 * 路径级的同一判定：这条相对路径是否落在被排除的目录下。
 *
 * `shouldSkipDir` 收的是**目录名**，只在自己遍历目录时管用。而拿 `git ls-files` 取材的地方
 * （hygiene、evidence 层）手里只有 `a/b/c.ts` 这样的路径——不逐段比就完全绕过了排除规则。
 * 实测漏网：hygiene 直接遍历 git 清单，于是备份目录里的 77 个文件被逐条报成「应该忽略」。
 *
 * 只比目录段（去掉最后一段文件名）：`fixtures.ts` 这样的文件名不该被当成 fixtures 目录。
 *
 * @param {string} rel 相对项目根的正斜杠路径
 */
export function isUnderSkippedDir(rel) {
  if (!rel) return false;
  const segs = String(rel).split('/');
  return segs.slice(0, -1).some((seg) => SKIP_DIR.has(seg));
}

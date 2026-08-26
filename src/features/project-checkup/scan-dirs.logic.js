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

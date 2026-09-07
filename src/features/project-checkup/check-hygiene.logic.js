/**
 * 维度「仓库卫生」的判定层（纯函数）。落地原先恒为 disabled 的 deadcode 槽位。
 *
 * 只做两件**零误报**的判定：
 *   H1 运行数据/日志被 git 追踪（warn）—— 会让工作区永远脏，还可能把本地数据推上远端
 *   H2 项目根目录下的一次性脚本被追踪（info）
 *
 * 刻意不做的：文档时效（不改往往就是不需要改）、重复代码（需相似度比对，假阳性高）、
 * 并发缺锁启发式（判错代价高）。见设计文档 §4。
 */

/** 运行期产物的扩展名。日志/追加流一旦入库就会让工作区永远脏 */
const RUNTIME_EXT = /\.(jsonl|log)$/i;

/** 测试夹具目录：里面的 .jsonl 是测试数据，本该入库 */
const FIXTURE_SEG = /(^|\/)(fixtures|__fixtures__)(\/|$)/;

/**
 * 一次性脚本的命名约定。刻意只认这三个前缀且只在项目根：
 * 它们是临时文件的通用约定，零误报。`verify-*` 这类**不**收——在别的项目里
 * 可能是正经的校验工具，为多抓一两个文件放宽规则不值得。
 */
const ONESHOT_PREFIX = /^(tmp|temp|debug)-/i;

const DEDUCT_RUNTIME = 10;
const DEDUCT_ONESHOT = 5;

/**
 * @param {Set<string>|null} p.trackedFiles git 追踪的相对路径；null = 非 git 仓库
 */
export function evaluateHygiene({ trackedFiles = null } = {}) {
  if (!(trackedFiles instanceof Set)) {
    return { score: null, status: 'na', issues: [], reason: '不是 git 仓库，无法判断版本库卫生' };
  }

  const issues = [];
  let score = 100;

  for (const rel of trackedFiles) {
    if (FIXTURE_SEG.test(rel)) continue;

    if (RUNTIME_EXT.test(rel)) {
      score -= DEDUCT_RUNTIME;
      issues.push({
        code: 'H1_RUNTIME_DATA_TRACKED',
        severity: 'warn',
        file: rel,
        line: 1,
        message: '运行期日志/数据文件被 git 追踪，会让工作区持续变脏，也可能把本地数据推上远端',
        // 修法是确定性的、可预测的：加 .gitignore + git rm --cached（文件留在磁盘上）。
        // 没有判断空间，所以标 true 交给确定性策略
        fixable: true,
        fixHint: `把它加入 .gitignore，并用 git rm --cached ${rel} 从索引里移除`,
      });
      continue;
    }

    // 仅项目根：rel 不含 '/'
    if (!rel.includes('/') && ONESHOT_PREFIX.test(rel)) {
      score -= DEDUCT_ONESHOT;
      issues.push({
        code: 'H2_ONESHOT_TRACKED',
        severity: 'info',
        file: rel,
        line: 1,
        message: '临时/调试脚本被 git 追踪，长期留在版本库里会被误当成正式代码',
        // 同 H1 走「加忽略 + 脱离索引」。刻意**不**自动删除文件——
        // 「确认不再需要就删除」那一步要人判断，而脱离索引已经解决了「被误当成正式代码」
        fixable: true,
        fixHint: '确认不再需要就删除；仍要用则移到 scripts/ 并起个正式名字',
      });
    }
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    status: 'done',
    issues,
    reason: '',
  };
}

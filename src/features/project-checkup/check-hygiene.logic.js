/**
 * 维度「仓库卫生」的判定层（纯函数）。落地原先恒为 disabled 的 deadcode 槽位。
 *
 * 只做三件**零误报**的判定：
 *   H1 运行数据/日志被 git 追踪（warn）—— 会让工作区永远脏，还可能把本地数据推上远端
 *   H2 项目根目录下的一次性脚本被追踪（info）
 *   H4 本功能自己的备份目录被 git 追踪（warn）—— 聚合成一条，见下方说明
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

/**
 * 本功能自己打的备份目录。
 *
 * 它被 git 追踪是**工具自我污染**的症状：`.claude/optimize-backup/<时间戳>/files/` 下是整个
 * 源码树的完整快照，用户一次 `git add .` 就把它变成了「真实源码」——
 * 下一轮体检会把这份副本当代码分析。实测（kxmall-app-ui）一份备份贡献了 140 项假问题。
 *
 * 检测侧已经在 `scan-dirs.logic.js` 的 SKIP_DIR 里把它排除出扫描范围，但**静默过滤 ≠ 问题解决**：
 * 那些文件仍然躺在用户的 git 索引里。所以这里仍要报，只是聚合成**一条**——
 * 逐文件报会是几十上百条噪音，而修法自始至终只有一个：整目录忽略 + `git rm -r --cached`。
 */
const TOOL_BACKUP_DIR = '.claude/optimize-backup';

const DEDUCT_RUNTIME = 10;
const DEDUCT_ONESHOT = 5;
const DEDUCT_TOOL_BACKUP = 10;

/**
 * @param {Set<string>|null} p.trackedFiles git 追踪的相对路径；null = 非 git 仓库
 */
export function evaluateHygiene({ trackedFiles = null } = {}) {
  if (!(trackedFiles instanceof Set)) {
    return { score: null, status: 'na', issues: [], reason: '不是 git 仓库，无法判断版本库卫生' };
  }

  const issues = [];
  let score = 100;

  // 先把备份目录整体摘出来：它下面的文件不再参与逐条判定（否则快照里的 .jsonl、
  // 快照里的 tmp-*.py 会被当成用户自己的卫生问题重复报一遍）
  const backupTracked = [];
  for (const rel of trackedFiles) {
    if (rel === TOOL_BACKUP_DIR || rel.startsWith(`${TOOL_BACKUP_DIR}/`)) backupTracked.push(rel);
  }
  if (backupTracked.length) {
    score -= DEDUCT_TOOL_BACKUP;
    issues.push({
      code: 'H4_TOOL_BACKUP_TRACKED',
      severity: 'warn',
      file: TOOL_BACKUP_DIR,
      line: 1,
      message: `项目优化功能自己的备份目录有 ${backupTracked.length} 个文件被 git 追踪。`
        + '那是整个源码树的快照副本，留在版本库里会让后续每一次体检都把副本当成真实源码重复分析',
      // 修法唯一且机械：整目录忽略 + 从索引移除。走确定性策略，不需要任何判断
      fixable: true,
      fixHint: `把 ${TOOL_BACKUP_DIR}/ 加入 .gitignore，并用 git rm -r --cached ${TOOL_BACKUP_DIR} 从索引移除（文件仍留在磁盘上，「还原」功能不受影响）`,
      meta: { trackedCount: backupTracked.length },
    });
  }
  const inBackup = new Set(backupTracked);

  for (const rel of trackedFiles) {
    if (FIXTURE_SEG.test(rel)) continue;
    if (inBackup.has(rel)) continue;

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

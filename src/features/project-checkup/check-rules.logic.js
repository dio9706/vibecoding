/**
 * 维度③：判定 .claude/rules/ 下哪些规范应该降级为 skill。
 *
 * 判定的理由（来自 2026-08-24 kxmall-app-ui 实测）：path-scoped rule 是**被动注入**的，
 * 只要读到匹配文件就整份塞进上下文。体积大 + paths 宽的组合会让纯逻辑改动也吃满无关规范，
 * 且中途注入会打断 KV cache，代价比多几千 token 更高。这类规范应改为 skill 按需调用。
 */

const DEMOTE_SIZE_THRESHOLD = 5 * 1024; // 5KB
const MAX_DEDUCT_PER_FILE = 20;

/**
 * 判断单条 glob 的宽度等级。
 *
 * 判定只看两个结构性事实，不穷举 glob 语法：
 * 1. 有没有 `**`——没有就只能匹配单层目录，影响面天然有限；
 * 2. 最后一段有没有限定扩展名——`src/**` 会吃掉整棵子树的所有文件，
 *    而 `src/**\/*.vue` 至少把范围收敛到一种文件类型。
 *
 * 之所以不去识别具体语法（`{ts,tsx}`、`[jt]s` 等）：早期版本用
 * `/\*\*.*\.\w+$/` 匹配扩展名，花括号扩展（官方支持的写法）里的
 * `{` `,` `}` 不属于 `\w`，导致 `src/**\/*.{ts,tsx}` 被误判成 narrow——
 * 一份 20KB 的胖规范因此完全逃过降级检测，是与本工具目的相反的假阴性。
 * 改成「最后一段有没有点号 + 后缀」后，任何限定扩展名的写法都能识别，
 * 换新语法也不会再漏。
 *
 * @param {string} glob
 * @returns {'wide'|'medium'|'narrow'}
 */
function classifySingleGlob(glob) {
  // 不含 ** 的 glob 只匹配单层目录，影响面有限
  if (!glob.includes('**')) return 'narrow';

  const lastSegment = glob.slice(glob.lastIndexOf('/') + 1);
  const dotIndex = lastSegment.lastIndexOf('.');
  // 点号后有非空内容才算真的限定了扩展名（排除 `foo.` 这种残缺写法）
  const hasExtension = dotIndex !== -1 && dotIndex < lastSegment.length - 1;

  return hasExtension ? 'medium' : 'wide';
}

/**
 * 判断 paths 的宽度等级，多条取最宽的那条（最宽的那条决定实际注入频率）。
 * @param {string[]|null} paths
 * @returns {'unconditional'|'wide'|'medium'|'narrow'}
 */
export function classifyPathsWidth(paths) {
  // 无 paths 字段 = 启动即无条件加载，最宽
  if (!paths) return 'unconditional';
  // 显式空数组 = 声明不匹配任何文件，和「没写」是相反语义
  if (paths.length === 0) return 'narrow';

  const rank = { narrow: 0, medium: 1, wide: 2 };
  let worst = 'narrow';

  for (const p of paths) {
    const level = classifySingleGlob(p);
    if (rank[level] > rank[worst]) worst = level;
  }
  return worst;
}

/**
 * @param {Array<{name:string,sizeBytes:number,paths:string[]|null,hasFrontmatter:boolean}>|null} files
 *   null 表示项目没有 .claude/rules 目录
 */
export function evaluateRules(files) {
  if (files === null) {
    return { score: null, status: 'na', issues: [], reason: '项目没有 .claude/rules 目录' };
  }

  const issues = [];
  let score = 100;

  for (const f of files) {
    const width = classifyPathsWidth(f.paths);
    const isWide = width === 'unconditional' || width === 'wide';
    if (f.sizeBytes <= DEMOTE_SIZE_THRESHOLD || !isWide) continue;

    // 读到了 frontmatter 却没解析出 paths —— 可能是解析器不认识的写法，
    // 而非真的没写。降级是破坏性操作（删文件 + 改写全仓引用），
    // 基于不确定的判断做破坏性操作代价太高，所以只提示不自动修。
    const uncertain = f.hasFrontmatter === true && !f.paths;

    const sizeKB = f.sizeBytes / 1024;
    score -= Math.min(MAX_DEDUCT_PER_FILE, sizeKB * 1.5);

    issues.push({
      code: uncertain ? 'R2_DEMOTE_UNCERTAIN' : 'R1_SHOULD_DEMOTE',
      severity: 'warn',
      file: `.claude/rules/${f.name}`,
      line: 1,
      message: uncertain
        ? `${sizeKB.toFixed(1)}KB，有 frontmatter 但未能解析出 paths，可能是本工具不认识的写法，请人工确认后再降级`
        : `${sizeKB.toFixed(1)}KB 且 paths 宽度为 ${width}，预估每次匹配注入约 ${Math.round(f.sizeBytes / 4)} tokens（估算值）`,
      fixable: !uncertain,
      fixHint: `降级为 /${f.name.replace(/\.md$/, '')} 技能，按需调用`,
      meta: { sizeBytes: f.sizeBytes, width },
    });
  }

  return {
    score: Math.max(0, Math.round(score)),
    status: 'done',
    issues,
  };
}

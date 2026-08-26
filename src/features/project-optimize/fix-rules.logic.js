/**
 * rules → skill 降级的纯文本变换。
 * 不碰文件系统，所有判断都可单测。
 */

/**
 * `docs/` 之下这几个名字的目录视为历史存档。
 *
 * 判定口径是「docs 祖先 + 归档目录名」，而不是紧挨着的 `docs/specs/`：
 * 2026-08-26 实测 kxmall-app-ui 时才发现，它和本仓库都把设计文档放在
 * `docs/superpowers/specs|plans/` 下，中间隔了一层。原来的前缀匹配完全认不出来，
 * 一次降级改写了 13 份历史设计文档——那些文档写的「见 `.claude/rules/xxx.md`」
 * 在当时是事实，改掉就是伪造历史记录。
 *
 * 为什么要求必须有 `docs` 祖先、不直接按目录名全局匹配：业务代码里正常会有
 * 叫 `plans` 的目录（订阅套餐、行程计划），把它一起保护起来只会留下失效引用。
 */
const ARCHIVE_SEGMENTS = new Set(['specs', 'plans', 'migration']);

/** 备份目录不按上面的规则走：它不在 docs 下，但同样是「当时的快照」，绝不能改 */
const BACKUP_DIR = '.claude/optimize-backup/';

export function skillNameOf(fileName) {
  return String(fileName).replace(/\.md$/i, '');
}

/** 剥掉开头的 YAML frontmatter 块，保留正文 */
export function stripFrontmatter(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  if (!/^---[ \t]*\n/.test(text)) return text;
  const lines = text.split('\n');
  // 从第 2 行起找闭合分隔行——正文里的 --- 分隔线在它之后，不会被误匹配
  const end = lines.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l));
  if (end === -1) return text;
  return lines.slice(end + 1).join('\n').replace(/^\n+/, '');
}

/**
 * 组装 skill 文件。
 * description 压成单行——YAML 单行标量不能含换行，否则加载 skill 时 frontmatter 解析会崩。
 */
export function buildSkillFile({ name, description, body }) {
  const desc = String(description || '').replace(/\s*\n\s*/g, ' ').trim();
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}`;
}

/**
 * 引用在文档里的书写形式。
 *
 * 只认反引号包裹的形式——地图和文档里引用路径都带反引号，
 * 裸写的路径多半出现在散文里（"rules 目录下的那些文件"），换了反而读不通。
 *
 * hasRuleRef 与 replaceRuleRefs 共用它，保证「判断要不要改」和「实际怎么改」
 * 永远是同一个口径：两者脱钩的后果是执行层漏改文件，或者反过来白写一次盘。
 */
function refToken(name) {
  return '`.claude/rules/' + String(name) + '.md`';
}

/** 这份文档里有没有对该规则的引用（供执行层决定要不要动这个文件） */
export function hasRuleRef(md, name) {
  return String(md || '').includes(refToken(name));
}

/**
 * 把 `.claude/rules/<name>.md` 的引用换成 `/<name>` 技能。
 *
 * 无引用时**整个短路**，一个字都不改。这一点不是优化而是正确性：
 * 下面两条空格清理是全局替换，而「技能 的」这三个字在任何一篇讲 skill 的文档里
 * 都可能自然出现。不短路的话，一次降级会顺手改掉全仓所有含这个字串的 md，
 * 这些改动既不在用户预期内，也和本次降级毫无关系。
 *
 * 用 split/join 而不是正则：规则名会直接进匹配式，正则要额外转义元字符
 * （`a.b.md` 里的点号会当通配，误伤 `axb.md`）。字面量切分天然没有这个问题。
 */
export function replaceRuleRefs(md, name) {
  const text = String(md || '');
  if (!hasRuleRef(text, name)) return text;

  let out = text.split(refToken(name)).join('`/' + name + '` 技能');
  // 「技能 的」这类多余空格：原文是「`xxx.md` 的分支」，替换后成了「技能 的分支」
  out = out.replace(/技能 的/g, '技能的').replace(/技能 「/g, '技能「');
  return out;
}

/** 归档目录不参与引用替换——那里记录的是当时的事实，改掉等于篡改历史 */
export function isArchivedPath(relPath) {
  const p = String(relPath).replace(/\\/g, '/');
  if (p.startsWith(BACKUP_DIR) || p.includes('/' + BACKUP_DIR)) return true;

  const segs = p.split('/');
  const docsAt = segs.indexOf('docs');
  if (docsAt === -1) return false;
  // 掐掉最后一段（文件名）：`docs/specs.md` 是一份普通文档，不是 specs 目录里的东西
  return segs.slice(docsAt + 1, -1).some((s) => ARCHIVE_SEGMENTS.has(s));
}

/**
 * rules → skill 降级的纯文本变换。
 * 不碰文件系统，所有判断都可单测。
 */

const ARCHIVED = ['docs/specs/', 'docs/plans/', 'docs/migration/', '.claude/optimize-backup/'];

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
 * 把 `.claude/rules/<name>.md` 的引用换成 `/<name>` 技能。
 *
 * 只替换反引号包裹的形式——地图和文档里引用路径都带反引号，
 * 裸写的路径多半出现在散文里（"rules 目录下的那些文件"），换了反而读不通。
 */
export function replaceRuleRefs(md, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('`\\.claude/rules/' + escaped + '\\.md`', 'g');
  let out = String(md || '').replace(re, '`/' + name + '` 技能');
  // 「技能 的」这类多余空格：原文是「`xxx.md` 的分支」，替换后成了「技能 的分支」
  out = out.replace(/技能 的/g, '技能的').replace(/技能 「/g, '技能「');
  return out;
}

/** 归档目录不参与引用替换——那里记录的是当时的事实，改掉等于篡改历史 */
export function isArchivedPath(relPath) {
  const p = String(relPath).replace(/\\/g, '/');
  return ARCHIVED.some((a) => p.startsWith(a) || p.includes('/' + a));
}

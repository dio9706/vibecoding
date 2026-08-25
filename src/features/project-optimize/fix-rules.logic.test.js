import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillNameOf, stripFrontmatter, buildSkillFile, replaceRuleRefs, isArchivedPath } from './fix-rules.logic.js';

test('skill 名由文件名推导', () => {
  assert.equal(skillNameOf('design-system.md'), 'design-system');
  assert.equal(skillNameOf('popup-pattern.md'), 'popup-pattern');
});

test('剥掉 frontmatter 保留正文', () => {
  const raw = "---\npaths:\n  - 'src/**'\n---\n\n# 标题\n\n正文\n";
  assert.equal(stripFrontmatter(raw), '# 标题\n\n正文\n');
});

test('没有 frontmatter 时原样返回', () => {
  assert.equal(stripFrontmatter('# 标题\n正文\n'), '# 标题\n正文\n');
});

test('CRLF 的 frontmatter 也能剥', () => {
  const raw = "---\r\npaths:\r\n  - 'src/**'\r\n---\r\n\r\n# 标题\r\n";
  const out = stripFrontmatter(raw);
  assert.ok(!out.includes('paths:'));
  assert.ok(out.includes('# 标题'));
});

test('正文里出现的 --- 分隔线不会被误当 frontmatter 结束', () => {
  const raw = "---\npaths:\n  - 'src/**'\n---\n\n# 标题\n\n正文\n\n---\n\n后半段\n";
  const out = stripFrontmatter(raw);
  assert.ok(out.startsWith('# 标题'));
  assert.ok(out.includes('后半段'));
});

test('组装 skill 文件', () => {
  const out = buildSkillFile({ name: 'foo', description: '一句话说明', body: '# 标题\n正文\n' });
  assert.ok(out.startsWith('---\nname: foo\ndescription: 一句话说明\n---\n\n'));
  assert.ok(out.endsWith('# 标题\n正文\n'));
});

test('description 里的换行会被压成空格', () => {
  // YAML 单行标量不能含换行，否则加载 skill 时 frontmatter 解析会崩
  const out = buildSkillFile({ name: 'foo', description: '第一行\n第二行', body: 'x' });
  assert.ok(out.includes('description: 第一行 第二行'));
});

test('替换反引号包裹的 rules 引用', () => {
  const md = '先读 `.claude/rules/popup-pattern.md`，照模板写。';
  assert.equal(replaceRuleRefs(md, 'popup-pattern'), '先读 `/popup-pattern` 技能，照模板写。');
});

test('替换后清掉「技能 的」这类多余空格', () => {
  const md = '读 `.claude/rules/keyboard-input-pattern.md` 的分支';
  assert.equal(replaceRuleRefs(md, 'keyboard-input-pattern'), '读 `/keyboard-input-pattern` 技能的分支');
});

test('不碰其它规则的引用', () => {
  const md = '见 `.claude/rules/other.md`';
  assert.equal(replaceRuleRefs(md, 'popup-pattern'), md);
});

test('名字含正则元字符也能安全替换', () => {
  const md = '见 `.claude/rules/a.b.md`';
  assert.equal(replaceRuleRefs(md, 'a.b'), '见 `/a.b` 技能');
  // 确认不会因为 . 被当通配而误伤
  assert.equal(replaceRuleRefs('见 `.claude/rules/axb.md`', 'a.b'), '见 `.claude/rules/axb.md`');
});

test('一行里多处引用全部替换', () => {
  const md = '`.claude/rules/a.md` 和 `.claude/rules/a.md`';
  assert.equal(replaceRuleRefs(md, 'a'), '`/a` 技能 和 `/a` 技能');
});

test('归档路径判定', () => {
  assert.equal(isArchivedPath('docs/specs/x.md'), true);
  assert.equal(isArchivedPath('docs/plans/x.md'), true);
  assert.equal(isArchivedPath('docs/migration/2026/x.md'), true);
  assert.equal(isArchivedPath('.claude/optimize-backup/2026/x.md'), true);
  assert.equal(isArchivedPath('docs/guide.md'), false);
  assert.equal(isArchivedPath('CLAUDE.md'), false);
  assert.equal(isArchivedPath('src/a/CLAUDE.md'), false);
});

test('归档判定对反斜杠路径同样生效', () => {
  assert.equal(isArchivedPath('docs\\specs\\x.md'), true);
});

test('嵌套在子目录下的归档目录也算', () => {
  assert.equal(isArchivedPath('sub/docs/specs/x.md'), true);
});

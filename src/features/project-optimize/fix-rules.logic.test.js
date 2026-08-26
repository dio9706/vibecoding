import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillNameOf, stripFrontmatter, buildSkillFile, replaceRuleRefs, hasRuleRef, isArchivedPath } from './fix-rules.logic.js';

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

test('替换后清掉「技能」与后续中文之间的多余空格', () => {
  // 原文是「`xxx.md` 的分支」，反引号后那个空格在替换后夹在了「技能」和中文之间，
  // 而中文排版本来就不用空格分词
  const md = '读 `.claude/rules/keyboard-input-pattern.md` 的分支';
  assert.equal(replaceRuleRefs(md, 'keyboard-input-pattern'), '读 `/keyboard-input-pattern` 技能的分支');
});

test('「技能」后接任意中文助词都要收紧，不只是「的」', () => {
  // 2026-08-26 P3-12 实测发现的：原来只针对「的」「「」两种写死，
  // kxmall 的 popup-pattern.md 里是「以 `xxx.md` 为准」，替换后留下「技能 为准」
  const cases = [
    ['颜色以 `.claude/rules/a.md` 为准', '颜色以 `/a` 技能为准'],
    ['见 `.claude/rules/a.md` 「模态」分支', '见 `/a` 技能「模态」分支'],
    ['照 `.claude/rules/a.md` 里写的做', '照 `/a` 技能里写的做'],
    ['参考 `.claude/rules/a.md` 。', '参考 `/a` 技能。'],
  ];
  for (const [md, want] of cases) assert.equal(replaceRuleRefs(md, 'a'), want);
});

test('「技能」后接英文或行尾时空格保留', () => {
  // 只收紧中文侧：后面跟拉丁字母时空格是有意义的分隔
  assert.equal(replaceRuleRefs('见 `.claude/rules/a.md` (v2)', 'a'), '见 `/a` 技能 (v2)');
  assert.equal(replaceRuleRefs('见 `.claude/rules/a.md`', 'a'), '见 `/a` 技能');
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
  // 「技能和」而不是「技能 和」：那个空格原本是用来隔开代码片段的，
  // 替换后夹在两个中文词之间就成了多余（见上面的空格收紧规则）
  const md = '`.claude/rules/a.md` 和 `.claude/rules/a.md`';
  assert.equal(replaceRuleRefs(md, 'a'), '`/a` 技能和 `/a` 技能');
});

test('hasRuleRef 认出反引号包裹的引用', () => {
  assert.equal(hasRuleRef('先读 `.claude/rules/popup-pattern.md`，照模板写。', 'popup-pattern'), true);
  assert.equal(hasRuleRef('先读 `.claude/rules/other.md`', 'popup-pattern'), false);
  assert.equal(hasRuleRef('完全无关的一段话', 'popup-pattern'), false);
});

test('hasRuleRef 不认裸写的路径', () => {
  // 与 replaceRuleRefs 的口径必须一致：它只替换反引号包裹的形式，
  // 这里多认一种，执行层就会去改一个 replaceRuleRefs 根本不会动的文件
  assert.equal(hasRuleRef('见 .claude/rules/popup-pattern.md 那份', 'popup-pattern'), false);
});

test('hasRuleRef 与 replaceRuleRefs 口径一致', () => {
  // 这两个函数必须同进同退：hasRuleRef 为 false 却被 replaceRuleRefs 改了，
  // 意味着执行层会漏改；反过来则意味着白写一次文件。
  // 「技能 的」这条清理规则是全局的，正是最容易让两者脱钩的地方。
  const cases = [
    ['见 `.claude/rules/a.md` 的说明', 'a'],
    ['无关文本，但含「技能 的」这三个字', 'a'],
    ['见 `.claude/rules/b.md`', 'a'],
    ['', 'a'],
  ];
  for (const [md, name] of cases) {
    assert.equal(
      hasRuleRef(md, name),
      replaceRuleRefs(md, name) !== md,
      `口径不一致: ${JSON.stringify(md)}`,
    );
  }
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

test('docs 与 specs/plans 之间隔着中间层级也算归档', () => {
  // 2026-08-26 实测发现的漏网之鱼：kxmall-app-ui 和本仓库都把设计文档放在
  // docs/superpowers/specs|plans/ 下，而原实现只认紧挨着的 docs/specs/。
  // 结果一次降级改写了 13 份历史设计文档——那些文档里的
  // 「见 `.claude/rules/xxx.md`」在当时是事实，改掉就是伪造历史记录。
  assert.equal(isArchivedPath('docs/superpowers/specs/2026-05-27-design.md'), true);
  assert.equal(isArchivedPath('docs/superpowers/plans/2026-06-24-plan.md'), true);
  assert.equal(isArchivedPath('docs/a/b/c/migration/x.md'), true);
});

test('docs 下的非归档目录仍要参与引用替换', () => {
  // 模块文档是活文档，路径变了就该跟着改；把它一起保护起来会留下失效引用
  assert.equal(isArchivedPath('docs/modules/baby-food.md'), false);
  assert.equal(isArchivedPath('docs/README.md'), false);
});

test('没有 docs 祖先的 specs/plans 目录不算归档', () => {
  // 收窄误伤面：业务代码里正常会有叫 plans 的目录（订阅套餐、行程计划等），
  // 那不是历史存档，把它保护起来等于留下一条失效引用
  assert.equal(isArchivedPath('src/pages/plans/README.md'), false);
  assert.equal(isArchivedPath('src/specs/x.md'), false);
});

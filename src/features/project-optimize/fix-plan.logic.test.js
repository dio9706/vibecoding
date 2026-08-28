import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectFixableRules, buildFixNotes, SUPPORTED_DIMENSIONS } from './fix-plan.logic.js';

/** 造一份只含 rules 维度的体检报告 */
const reportWith = (issues) => ({ dims: { rules: { status: 'done', issues } } });

// ---------- selectFixableRules ----------

test('只挑出 fixable 的项', () => {
  const r = reportWith([
    { code: 'R1_SHOULD_DEMOTE', file: '.claude/rules/design-system.md', fixable: true, message: 'a' },
    { code: 'R1_SHOULD_DEMOTE', file: '.claude/rules/keyboard.md', fixable: true, message: 'b' },
  ]);
  assert.deepEqual(selectFixableRules(r).files, ['design-system.md', 'keyboard.md']);
});

test('R2_DEMOTE_UNCERTAIN 被挡下并说明原因', () => {
  // 「有 frontmatter 但解析不出 paths」是故意标成不可自动修的：
  // 基于不确定的判断做删文件 + 改写全仓引用，代价太高
  const r = reportWith([
    { code: 'R1_SHOULD_DEMOTE', file: '.claude/rules/a.md', fixable: true, message: 'ok' },
    { code: 'R2_DEMOTE_UNCERTAIN', file: '.claude/rules/b.md', fixable: false, message: '请人工确认' },
  ]);
  const out = selectFixableRules(r);
  assert.deepEqual(out.files, ['a.md']);
  assert.equal(out.blocked.length, 1);
  assert.equal(out.blocked[0].file, '.claude/rules/b.md');
  assert.match(out.blocked[0].reason, /人工确认/);
});

test('同一个文件出现多条问题时只降级一次', () => {
  const r = reportWith([
    { file: '.claude/rules/a.md', fixable: true, message: 'x' },
    { file: '.claude/rules/a.md', fixable: true, message: 'y' },
  ]);
  assert.deepEqual(selectFixableRules(r).files, ['a.md']);
});

test('rules 维度缺失 / 报告为空都返回空结果而不抛错', () => {
  for (const bad of [null, undefined, {}, { dims: {} }, { dims: { rules: {} } }]) {
    const out = selectFixableRules(bad);
    assert.deepEqual(out.files, []);
    assert.deepEqual(out.blocked, []);
  }
});

test('只认 .claude/rules/ 下的文件', () => {
  // 别的维度将来也可能产出 fixable 的 issue，降级逻辑不该去动它们
  const r = reportWith([
    { file: 'CLAUDE.md', fixable: true, message: 'x' },
    { file: '.claude/rules/a.md', fixable: true, message: 'y' },
  ]);
  assert.deepEqual(selectFixableRules(r).files, ['a.md']);
});

// ---------- buildFixNotes ----------

test('勾选了尚不支持的维度要如实说明', () => {
  // 静默忽略最糟：用户勾了「注释合理性」，看到「优化完成」，以为注释也处理过了
  // 注意：map 已进入 SUPPORTED_DIMENSIONS，这里改用 comments/tests 举例
  const notes = buildFixNotes({ requested: ['rules', 'comments', 'tests'], results: [] });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /comments/);
  assert.match(notes[0], /tests/);
});

test('只勾选支持的维度时不产生该提示', () => {
  assert.deepEqual(buildFixNotes({ requested: [...SUPPORTED_DIMENSIONS], results: [] }), []);
});

test('根 CLAUDE.md 仍提到旧文件名时提示手工核对', () => {
  // 索引表里写的是 `big-wide.md` 这种裸文件名，不带 .claude/rules/ 前缀，
  // replaceRuleRefs 匹配不到，会留下指向已删除文件的表格行
  const notes = buildFixNotes({
    requested: ['rules'],
    results: [{ status: 'done', file: '.claude/rules/big-wide.md', skillName: 'big-wide' }],
    rootClaudeMd: '规范见 `/big-wide` 技能。\n\n| `big-wide.md` | 大且宽 |',
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /CLAUDE\.md/);
  assert.match(notes[0], /big-wide\.md/);
});

test('根 CLAUDE.md 已无残留时不提示', () => {
  const notes = buildFixNotes({
    requested: ['rules'],
    results: [{ status: 'done', file: '.claude/rules/big-wide.md', skillName: 'big-wide' }],
    rootClaudeMd: '规范见 `/big-wide` 技能。',
  });
  assert.deepEqual(notes, []);
});

test('没降级成功的文件不参与残留检查', () => {
  // 跳过/失败的文件本来就还在原地，CLAUDE.md 提到它是正确的
  const notes = buildFixNotes({
    requested: ['rules'],
    results: [{ status: 'skipped', file: '.claude/rules/big-wide.md', skillName: 'big-wide' }],
    rootClaudeMd: '见 `.claude/rules/big-wide.md`',
  });
  assert.deepEqual(notes, []);
});

test('读不到根 CLAUDE.md 时不报噪声', () => {
  const results = [{ status: 'done', file: '.claude/rules/a.md', skillName: 'a' }];
  assert.deepEqual(buildFixNotes({ requested: ['rules'], results, rootClaudeMd: null }), []);
  assert.deepEqual(buildFixNotes({ requested: ['rules'], results }), []);
});

test('缺参数不抛错', () => {
  assert.deepEqual(buildFixNotes({}), []);
  assert.deepEqual(buildFixNotes(), []);
});

// ---------- 维度① 地图接入后的补充 ----------

test('map 已进入支持的维度', () => {
  assert.ok(SUPPORTED_DIMENSIONS.includes('map'));
  assert.ok(SUPPORTED_DIMENSIONS.includes('rules'));
});

test('只勾 map 时不再提示「暂无自动修复能力」', () => {
  assert.deepEqual(buildFixNotes({ requested: ['map'], results: [] }), []);
});

test('写过地图文件时提示 mtime 已被刷新', () => {
  // 这是 M3 过期告警会被本次写入清零的唯一提醒。删掉它，用户会把分数上涨
  // 误读成「地图已经更新了」——而地图正文其实一个字都没改
  const notes = buildFixNotes({
    requested: ['map'],
    results: [{ status: 'done', kind: 'stale-audit', file: 'src/a/CLAUDE.md' }],
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /时间戳|新鲜度|过期/);
  assert.match(notes[0], /自动核对/);
});

test('没有地图写入成功时不产生该提示', () => {
  const notes = buildFixNotes({
    requested: ['map'],
    results: [{ status: 'failed', kind: 'stale-audit', file: 'src/a/CLAUDE.md' }],
  });
  assert.deepEqual(notes, []);
});

test('地图结果不会污染 rules 的残留检查', () => {
  // 地图结果的 file 不以 .claude/rules/ 开头，拿去 slice 会产生垃圾字符串，
  // 再用它去 includes 根 CLAUDE.md 可能误报
  const notes = buildFixNotes({
    requested: ['map', 'rules'],
    results: [{ status: 'done', kind: 'gen-map', file: 'src/a/CLAUDE.md' }],
    rootClaudeMd: '# 根地图\n\n见 `src/a/CLAUDE.md`',
  });
  assert.equal(notes.length, 1, '只该有 mtime 那一条');
  assert.match(notes[0], /时间戳|新鲜度|过期/);
});

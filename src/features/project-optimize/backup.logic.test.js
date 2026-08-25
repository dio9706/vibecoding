import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, restoreActionsOf, backupDirName } from './backup.logic.js';

test('备份目录名由时间戳生成且文件系统安全', () => {
  const n = backupDirName('2026-08-24T08:00:00.000Z');
  assert.ok(!n.includes(':'), '冒号在 Windows 路径里非法');
  assert.equal(n, '2026-08-24T08-00-00');
});

test('目录名可按字典序排出时间先后', () => {
  // 保留策略要靠排序删旧的，字典序必须等于时间序
  const a = backupDirName('2026-01-02T03:04:05.000Z');
  const b = backupDirName('2026-01-02T03:04:06.000Z');
  const c = backupDirName('2026-01-03T00:00:00.000Z');
  assert.ok(a < b && b < c);
});

test('生成 manifest', () => {
  const m = buildManifest({
    at: '2026-08-24T08:00:00.000Z',
    dir: 'C:/p',
    dimensions: ['rules'],
    entries: [
      { path: '.claude/rules/a.md', action: 'deleted' },
      { path: 'CLAUDE.md', action: 'modified' },
      { path: '.claude/skills/a/SKILL.md', action: 'created' },
    ],
  });
  assert.equal(m.at, '2026-08-24T08:00:00.000Z');
  assert.equal(m.dir, 'C:/p');
  assert.deepEqual(m.dimensions, ['rules']);
  assert.equal(m.entries.length, 3);
  // created 的没有内容可备份，其余都要
  assert.equal(m.entries.find((e) => e.action === 'created').backed, false);
  assert.equal(m.entries.find((e) => e.action === 'deleted').backed, true);
  assert.equal(m.entries.find((e) => e.action === 'modified').backed, true);
});

test('manifest 容忍缺省字段', () => {
  const m = buildManifest({ at: 'x', dir: 'y' });
  assert.deepEqual(m.entries, []);
  assert.deepEqual(m.dimensions, []);
});

test('还原动作：deleted/modified 复制回去，created 删掉', () => {
  const acts = restoreActionsOf({
    entries: [
      { path: '.claude/rules/a.md', action: 'deleted', backed: true },
      { path: 'CLAUDE.md', action: 'modified', backed: true },
      { path: '.claude/skills/a/SKILL.md', action: 'created', backed: false },
    ],
  });
  assert.deepEqual(acts.map((a) => a.op), ['copy', 'copy', 'remove']);
  assert.equal(acts[2].path, '.claude/skills/a/SKILL.md');
});

test('没有 entries 时返回空动作', () => {
  assert.deepEqual(restoreActionsOf({ entries: [] }), []);
  assert.deepEqual(restoreActionsOf({}), []);
  assert.deepEqual(restoreActionsOf(null), []);
});

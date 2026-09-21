import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHygiene } from './check-hygiene.logic.js';

test('非 git 仓库 → na（无法判断版本库卫生）', () => {
  const r = evaluateHygiene({ trackedFiles: null });
  assert.equal(r.status, 'na');
  assert.equal(r.score, null);
});

test('运行数据被追踪 → warn', () => {
  const r = evaluateHygiene({ trackedFiles: new Set(['src/a.js', 'event-log.jsonl', 'logs/run.log']) });
  const codes = r.issues.map((i) => i.code);
  assert.equal(codes.filter((c) => c === 'H1_RUNTIME_DATA_TRACKED').length, 2);
  assert.equal(r.issues.find((i) => i.code === 'H1_RUNTIME_DATA_TRACKED').severity, 'warn');
  assert.ok(r.score < 100);
});

test('夹具里的 .jsonl 不报（那是测试数据，本该入库）', () => {
  const r = evaluateHygiene({
    trackedFiles: new Set(['tests/fixtures/sample.jsonl', 'src/__fixtures__/x.log']),
  });
  assert.deepStrictEqual(r.issues, []);
  assert.equal(r.score, 100);
});

test('根目录一次性脚本被追踪 → info', () => {
  const r = evaluateHygiene({
    trackedFiles: new Set(['tmp-probe.mjs', 'temp-x.js', 'debug-y.mjs', 'src/a.js']),
  });
  assert.equal(r.issues.filter((i) => i.code === 'H2_ONESHOT_TRACKED').length, 3);
  assert.equal(r.issues.find((i) => i.code === 'H2_ONESHOT_TRACKED').severity, 'info');
});

test('非根目录的 tmp- 文件不报（收窄到根目录，避免误伤正常命名）', () => {
  const r = evaluateHygiene({ trackedFiles: new Set(['src/utils/tmp-buffer.js']) });
  assert.deepStrictEqual(r.issues, []);
});

test('干净仓库 → 100 done', () => {
  const r = evaluateHygiene({ trackedFiles: new Set(['src/a.js', 'README.md', 'package.json']) });
  assert.equal(r.score, 100);
  assert.equal(r.status, 'done');
  assert.deepStrictEqual(r.issues, []);
});

test('分数有下限，不会为负', () => {
  const many = new Set(Array.from({ length: 40 }, (_, i) => `log-${i}.jsonl`));
  const r = evaluateHygiene({ trackedFiles: many });
  assert.ok(r.score >= 0);
});

test('容错：不传参不抛', () => {
  assert.doesNotThrow(() => evaluateHygiene());
  assert.equal(evaluateHygiene().status, 'na');
});

// ---------- H4：工具自己的备份目录被追踪 ----------

const backupSet = (n) => new Set([
  'src/a.js',
  ...Array.from({ length: n }, (_, i) => `.claude/optimize-backup/2026-09-18T06-39-43/files/src/m${i}.ts`),
]);

test('备份目录被追踪 → 聚合成一条 H4，而不是逐文件报 N 条', () => {
  // 逐文件报会是几十上百条噪音（实测一份备份 77 个文件），而修法自始至终只有一个
  const r = evaluateHygiene({ trackedFiles: backupSet(77) });
  const h4 = r.issues.filter((i) => i.code === 'H4_TOOL_BACKUP_TRACKED');
  assert.equal(h4.length, 1, '77 个文件只该出一条');
  assert.equal(h4[0].file, '.claude/optimize-backup', 'file 指向目录，修法是整目录移除');
  assert.equal(h4[0].fixable, true, '修法机械且唯一，交给确定性策略');
  assert.equal(h4[0].meta.trackedCount, 77);
  assert.match(h4[0].message, /77/);
});

test('备份目录里的文件不再参与逐条判定（快照里的 .jsonl 不该被当成用户的卫生问题）', () => {
  const r = evaluateHygiene({
    trackedFiles: new Set([
      '.claude/optimize-backup/2026-09-18T06-39-43/files/event-log.jsonl',
      '.claude/optimize-backup/2026-09-18T06-39-43/files/logs/run.log',
    ]),
  });
  assert.deepStrictEqual(
    r.issues.map((i) => i.code),
    ['H4_TOOL_BACKUP_TRACKED'],
    '只报 H4，不再为快照里的日志副本报 H1',
  );
});

test('备份目录未被追踪时不报 H4（.gitignore 生效的正常情况）', () => {
  const r = evaluateHygiene({ trackedFiles: new Set(['src/a.js', 'README.md']) });
  assert.equal(r.issues.length, 0);
  assert.equal(r.score, 100);
});

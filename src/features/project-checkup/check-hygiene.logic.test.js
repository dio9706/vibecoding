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

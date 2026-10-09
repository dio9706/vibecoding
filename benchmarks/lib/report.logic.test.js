/**
 * benchmark 报告纯函数单测（T5）：聚合口径与 markdown 三张表。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeResults, renderMarkdownReport } from './report.logic.js';

const rec = (over = {}) => ({
  caseId: 'c1',
  title: '案例一',
  ok: true,
  error: null,
  metrics: { toolCalls: 10, numTurns: 4, inputTokens: 1000, outputTokens: 200, costUsd: 0.5, durationMs: 60_000 },
  verify: { ok: true, summary: 'node --test a.test.js 通过（1m）' },
  ...over,
});

test('summarizeResults：通过率、各项合计、null 字段按覆盖数统计不臆造', () => {
  const records = [
    rec(),
    rec({ caseId: 'c2', ok: false, metrics: { toolCalls: 20, numTurns: null, inputTokens: 2000, outputTokens: 100, costUsd: null, durationMs: 120_000 } }),
    rec({ caseId: 'c3', ok: false, error: 'agent 执行失败：boom', metrics: { toolCalls: 0, numTurns: null, inputTokens: 0, outputTokens: 0, costUsd: null, durationMs: 0 } }),
  ];
  const s = summarizeResults(records);
  assert.equal(s.total, 3);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 2);
  assert.equal(s.errored, 1);
  assert.ok(Math.abs(s.passRate - 1 / 3) < 1e-9);
  assert.equal(s.toolCalls, 30);
  assert.equal(s.numTurns, 4);
  assert.equal(s.numTurnsKnown, 1);
  assert.equal(s.inputTokens, 3000);
  assert.equal(s.outputTokens, 300);
  assert.equal(s.costUsd, 0.5);
  assert.equal(s.costKnown, 1);
  assert.equal(s.durationMs, 180_000);
  assert.deepEqual(summarizeResults([]), {
    total: 0,
    passed: 0,
    failed: 0,
    errored: 0,
    passRate: 0,
    toolCalls: 0,
    numTurns: 0,
    numTurnsKnown: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    costKnown: 0,
    durationMs: 0,
  });
});

test('renderMarkdownReport：头部汇总 + 三张表 + 汇总行；null 显示 -；失败/异常如实入表', () => {
  const records = [
    rec(),
    rec({
      caseId: 'c2',
      title: '案例|二',
      ok: false,
      metrics: { toolCalls: 5, numTurns: null, inputTokens: 500, outputTokens: 0, costUsd: null, durationMs: 1_000 },
      verify: { ok: false, summary: 'node --test b.test.js 失败（退出码 1）' },
    }),
    rec({ caseId: 'c3', title: '案例三', ok: false, error: 'agent 执行失败：boom', metrics: { toolCalls: 0, numTurns: null, inputTokens: 0, outputTokens: 0, costUsd: null, durationMs: 0 } }),
  ];
  const md = renderMarkdownReport({ startedAt: 'T0', finishedAt: 'T1', model: 'claude-sonnet-4-6', records });

  assert.match(md, /# 内部 Benchmark 报告/);
  assert.match(md, /模型：claude-sonnet-4-6/);
  assert.match(md, /通过 \*\*1\/3（33%）\*\*/);
  assert.match(md, /## 一、通过率/);
  assert.match(md, /## 二、回合数/);
  assert.match(md, /## 三、token 成本/);
  assert.match(md, /✅ 通过/);
  assert.match(md, /❌ 未通过/);
  assert.match(md, /⚠️ agent 执行失败：boom/);
  assert.match(md, /案例\\\|二/, '表格里的 | 必须转义');
  assert.match(md, /\| \*\*合计\*\* \| 15 \| 4 \|/, '回合数汇总行');
  assert.match(md, /\| \*\*合计\*\* \| 1,500 \| 200 \| \$0\.5000 \|/, 'token 汇总行（null 成本不摊派）');
});

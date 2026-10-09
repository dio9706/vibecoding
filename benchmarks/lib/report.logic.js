/**
 * 内部 benchmark 报告纯函数（T5）：结果聚合 + markdown 三张表（通过率 / 回合数 / token 成本）。
 * 零 IO；文件写出在 CLI（benchmarks/run.mjs）。
 */
import { formatDuration } from '../../src/capabilities/verifier.logic.js';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null; // null 不得被 Number(null)=0 混成「已知的 0」
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 结果聚合（缺失值不臆造：numTurns/costUsd 可能为 null，按已知项求和并给出覆盖数） */
export function summarizeResults(records = []) {
  const list = Array.isArray(records) ? records : [];
  const passed = list.filter((r) => r && r.ok).length;
  const errored = list.filter((r) => r && r.error).length;
  const sum = (pick) => list.reduce((n, r) => n + (num(pick(r)) || 0), 0);
  const known = (pick) => list.filter((r) => num(pick(r)) !== null).length;
  return {
    total: list.length,
    passed,
    failed: list.length - passed,
    errored,
    passRate: list.length ? passed / list.length : 0,
    toolCalls: sum((r) => r?.metrics?.toolCalls),
    numTurns: sum((r) => r?.metrics?.numTurns),
    numTurnsKnown: known((r) => r?.metrics?.numTurns),
    inputTokens: sum((r) => r?.metrics?.inputTokens),
    outputTokens: sum((r) => r?.metrics?.outputTokens),
    costUsd: sum((r) => r?.metrics?.costUsd),
    costKnown: known((r) => r?.metrics?.costUsd),
    durationMs: sum((r) => r?.metrics?.durationMs),
  };
}

const fmtTokens = (n) => (num(n) === null ? '-' : Number(n).toLocaleString('en-US'));
const fmtUsd = (n) => (num(n) === null ? '-' : '$' + Number(n).toFixed(4));
const fmtRate = (rate) => `${Math.round((Number(rate) || 0) * 100)}%`;
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');

/**
 * 渲染 markdown 报告（给人和归档看；JSON 给机器看）。
 * @param {{startedAt?:string, finishedAt?:string, model?:string, records?:Array, summary?:object}} input
 */
export function renderMarkdownReport({ startedAt = '', finishedAt = '', model = '', records = [], summary = null } = {}) {
  const list = Array.isArray(records) ? records : [];
  const s = summary || summarizeResults(list);
  const lines = [];
  lines.push('# 内部 Benchmark 报告');
  lines.push('');
  lines.push(`- 开始：${startedAt || '-'} / 结束：${finishedAt || '-'}`);
  lines.push(`- 模型：${model || '(默认)'}`);
  lines.push(
    `- 汇总：通过 **${s.passed}/${s.total}（${fmtRate(s.passRate)}）**；工具调用合计 ${s.toolCalls} 次；` +
      `模型回合合计 ${s.numTurns}（覆盖 ${s.numTurnsKnown}/${s.total}）；` +
      `token 输入 ${fmtTokens(s.inputTokens)} / 输出 ${fmtTokens(s.outputTokens)}；` +
      `成本合计 ${fmtUsd(s.costUsd)}（覆盖 ${s.costKnown}/${s.total}）；总耗时 ${formatDuration(s.durationMs)}`,
  );

  lines.push('');
  lines.push('## 一、通过率');
  lines.push('');
  lines.push('| 案例 | 结果 | 自检 |');
  lines.push('| --- | --- | --- |');
  for (const r of list) {
    const name = `${cell(r.title || '')}（${cell(r.caseId)}）`;
    const mark = r.error ? `⚠️ ${cell(r.error)}` : r.ok ? '✅ 通过' : '❌ 未通过';
    lines.push(`| ${name} | ${mark} | ${cell(r.verify?.summary || '')} |`);
  }

  lines.push('');
  lines.push('## 二、回合数');
  lines.push('');
  lines.push('| 案例 | 工具调用 | 模型回合 | 耗时 |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of list) {
    const m = r.metrics || {};
    lines.push(
      `| ${cell(r.caseId)} | ${num(m.toolCalls) === null ? '-' : m.toolCalls} | ${num(m.numTurns) === null ? '-' : m.numTurns} | ${formatDuration(m.durationMs)} |`,
    );
  }
  lines.push(`| **合计** | ${s.toolCalls} | ${s.numTurns} | ${formatDuration(s.durationMs)} |`);

  lines.push('');
  lines.push('## 三、token 成本');
  lines.push('');
  lines.push('| 案例 | 输入 tokens | 输出 tokens | 成本(USD) |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of list) {
    const m = r.metrics || {};
    lines.push(`| ${cell(r.caseId)} | ${fmtTokens(m.inputTokens)} | ${fmtTokens(m.outputTokens)} | ${fmtUsd(m.costUsd)} |`);
  }
  lines.push(`| **合计** | ${fmtTokens(s.inputTokens)} | ${fmtTokens(s.outputTokens)} | ${fmtUsd(s.costUsd)} |`);
  lines.push('');
  return lines.join('\n');
}

#!/usr/bin/env node
/**
 * 内部 benchmark CLI（T5，见 docs/superpowers/specs/2026-10-08-internal-benchmark-design.md）。
 *
 *   node benchmarks/run.mjs --list                          # 题集概览
 *   node benchmarks/run.mjs --scan [--limit 60] [--write]   # 扫描可回放的提交；--write 产出 draft 案例
 *   node benchmarks/run.mjs --validate [--case <id>] [--keep]  # 离线校验（修复前判据必须失败）
 *   node benchmarks/run.mjs --run [--case <id>] [--model <m>] [--keep] [--timeout <min>]
 *
 * `--run` 走真实模型（runClaude，bypassPermissions），消耗额度，**只手动触发**。
 * 产出：benchmarks/results/<stamp>.json + <stamp>.md（通过率 / 回合数 / token 成本三张表）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCase, draftCaseFromCommit } from './lib/cases.logic.js';
import { summarizeResults, renderMarkdownReport } from './lib/report.logic.js';
import { REPO_ROOT, BENCH_WS_DIRNAME, scanRepoCommits, runCases, validateCases, makeGit } from './lib/runner.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(ROOT, 'cases');
const RESULTS_DIR = path.join(ROOT, 'results');
const WS_ROOT = path.join(REPO_ROOT, BENCH_WS_DIRNAME);

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const numOpt = (name, dflt) => {
  const v = Number(opt(name, NaN));
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

function printHelp() {
  console.log(`内部 benchmark（T5）

  node benchmarks/run.mjs --list
  node benchmarks/run.mjs --scan [--limit 60] [--write]
  node benchmarks/run.mjs --validate [--case <id>] [--keep]
  node benchmarks/run.mjs --run [--case <id>] [--model <模型>] [--keep] [--timeout <分钟>]
`);
}

/** 读 cases/ 下全部案例并校验；返回 {cases, errors, total} */
function loadCases(onlyId = null) {
  if (!fs.existsSync(CASES_DIR)) return { cases: [], errors: [], total: 0 };
  const files = fs.readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort();
  const cases = [];
  const errors = [];
  const known = new Set();
  for (const f of files) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8'));
    } catch (e) {
      errors.push(`${f}: JSON 解析失败：${e?.message || String(e)}`);
      continue;
    }
    const r = validateCase(raw, { knownIds: known });
    if (!r.ok) {
      errors.push(`${f}: ${r.errors.join('；')}`);
      continue;
    }
    known.add(r.case.id);
    cases.push({ ...r.case, _file: f });
  }
  if (onlyId) {
    const hit = cases.filter((c) => c.id === onlyId);
    if (!hit.length) errors.push(`案例不存在：${onlyId}`);
    return { cases: hit, errors, total: files.length };
  }
  return { cases, errors, total: files.length };
}

function printCaseErrors(errors) {
  for (const e of errors) console.error('  ✖ ' + e);
}

function cmdList() {
  const { cases, errors, total } = loadCases();
  if (errors.length) printCaseErrors(errors);
  if (!cases.length) {
    console.log(`题集为空（cases/ 共 ${total} 个文件）。先 node benchmarks/run.mjs --scan --write 生成候选。`);
    return errors.length ? 1 : 0;
  }
  console.log(`题集：${cases.length} 条${cases.some((c) => c.draft) ? '（含 draft，需先人工改写 input 再入库）' : ''}\n`);
  for (const c of cases) {
    const flag = c.draft ? ' [draft]' : '';
    console.log(`  ${c.id}${flag}  ${c.type.padEnd(7)} fix=${c.fixRef}  tests=${c.testFiles.length}  ${c.title}`);
  }
  return errors.length ? 1 : 0;
}

async function cmdScan() {
  const limit = numOpt('--limit', 60);
  const r = await scanRepoCommits({ repoDir: REPO_ROOT });
  if (!r.ok) {
    console.error('✖ ' + r.error);
    return 1;
  }
  console.log(`候选提交：${r.commits.length} 条（测试+实现同改、非合并、规模可控）\n`);
  const shown = r.commits.slice(0, limit);
  for (const c of shown) {
    console.log(`  ${c.short}  ${String(c.files.length).padStart(2)} 文件  ${c.subject}`);
  }
  if (!has('--write')) {
    console.log(`\n（--write 可把前 ${shown.length} 条写成 draft 案例到 cases/，input 需人工改写）`);
    return 0;
  }
  let written = 0;
  for (const c of shown) {
    const draft = draftCaseFromCommit(c);
    if (!draft) continue;
    const checked = validateCase(draft);
    if (!checked.ok) continue;
    const file = path.join(CASES_DIR, `${draft.id}.json`);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(CASES_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(draft, null, 2) + '\n');
    written++;
  }
  console.log(`\n已写 ${written} 条 draft 到 cases/（不改写既有文件）。下一步：人工把 input 改成用户口吻的反馈，删掉 "draft": true，再 --validate。`);
  return 0;
}

async function cmdValidate() {
  const only = opt('--case');
  const { cases, errors } = loadCases(only);
  if (errors.length) {
    printCaseErrors(errors);
    if (!cases.length) return 1;
  }
  if (!cases.length) {
    console.log('没有可校验的案例。');
    return 1;
  }
  console.log(`离线校验 ${cases.length} 条（修复前判据必须失败）…\n`);
  const results = await validateCases({ cases, repoDir: REPO_ROOT, wsRoot: WS_ROOT, deps: { keep: has('--keep') } });
  let bad = 0;
  for (const r of results) {
    const mark = r.valid ? '✔ 有效' : '✖ 无效';
    if (!r.valid) bad++;
    console.log(`  ${mark}  ${r.caseId}${r.detail ? ' — ' + r.detail : ''}${r.summary ? `（${r.summary}）` : ''}`);
  }
  console.log(`\n有效 ${results.length - bad} / ${results.length}`);
  return bad ? 1 : 0;
}

async function cmdRun() {
  const only = opt('--case');
  const model = opt('--model');
  const timeoutMin = numOpt('--timeout', 30);
  const { cases, errors } = loadCases(only);
  if (errors.length) {
    printCaseErrors(errors);
    if (!cases.length) return 1;
  }
  const runnable = cases.filter((c) => !c.draft);
  if (!runnable.length) {
    console.log('没有可跑的案例（draft 需先改写 input 并去掉 "draft": true）。');
    return 1;
  }
  console.log(`开始跑 ${runnable.length} 条（串行；model=${model || '(默认)'}，单题超时 ${timeoutMin} 分钟）…\n`);
  const startedAt = new Date().toISOString();
  const records = await runCases({
    cases: runnable,
    repoDir: REPO_ROOT,
    wsRoot: WS_ROOT,
    deps: { model, keep: has('--keep'), agentTimeoutMs: timeoutMin * 60_000 },
  });
  const finishedAt = new Date().toISOString();
  const summary = summarizeResults(records);
  const stamp = startedAt.replace(/[:.]/g, '-').slice(0, 19);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const jsonPath = path.join(RESULTS_DIR, `${stamp}.json`);
  const mdPath = path.join(RESULTS_DIR, `${stamp}.md`);
  const payload = { v: 1, startedAt, finishedAt, model: model || null, summary, cases: records };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + '\n');
  fs.writeFileSync(mdPath, renderMarkdownReport({ startedAt, finishedAt, model, records, summary }) + '\n');
  for (const r of records) {
    const mark = r.error ? `⚠️ ${r.error}` : r.ok ? '✅' : '❌';
    console.log(`  ${mark}  ${r.caseId}  tools=${r.metrics.toolCalls}  turns=${r.metrics.numTurns ?? '-'}  $${r.metrics.costUsd ?? '-'}`);
  }
  console.log(`\n通过 ${summary.passed}/${summary.total}（${Math.round(summary.passRate * 100)}%）`);
  console.log(`报告：${path.relative(process.cwd(), mdPath)}`);
  console.log(`原始：${path.relative(process.cwd(), jsonPath)}`);
  return 0;
}

const main = async () => {
  // 启动先把测试残留的 worktree 元数据清一遍（--keep 或崩溃可能留下）
  if (has('--run') || has('--validate')) {
    try {
      await makeGit().prune(REPO_ROOT);
    } catch {
      /* prune 失败不阻塞 */
    }
  }
  if (has('--scan')) return cmdScan();
  if (has('--validate')) return cmdValidate();
  if (has('--run')) return cmdRun();
  if (has('--list')) return cmdList();
  printHelp();
  return 0;
};

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('benchmark CLI 异常：' + (e?.stack || e));
    process.exit(1);
  });

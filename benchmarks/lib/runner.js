/**
 * 内部 benchmark 编排（T5，spec `docs/superpowers/specs/2026-10-08-internal-benchmark-design.md`）。
 *
 * 单题全链：worktree 准备（fixRef^）→ 植入判据（fixRef 的 testFiles）→ prompt（与生产 develop 同模板）
 * → runClaude（bypassPermissions、cwd=工作树）→ **重置判据防篡改** → verify →（默认）清理工作树。
 *
 * 依赖注入：git / agent / verify / now 均可注入，编排逻辑离线可测；
 * 真跑（agent=runClaude）只在 CLI `--run` 手动触发，消耗真实额度。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript } from '../../src/integrations/shell.js';
import { runClaude } from '../../src/integrations/claude.js';
import { claudeAuthOpts } from '../../src/capabilities/token-rotation.js';
import { runVerify } from '../../src/capabilities/verifier.js';
import { buildDevelopPrompt } from '../../src/plugins/team-tools/auto-dev/prompt.logic.js';
import { buildVerifyCommand, isCaseCandidate, draftCaseFromCommit, parseGitNumstatLog } from './cases.logic.js';

/** 仓库根（benchmarks/lib → 上三级）；工作树固定放 `<repo>/.bench-ws/`，模块解析可向上找到根 node_modules */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BENCH_WS_DIRNAME = '.bench-ws';
export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

/** git 操作封装（固定参数数组 + shell:false，命令与参数均受信；deps 注入便于单测） */
export function makeGit(runner = runScript) {
  const git = (args, cwd) => runner('git', args, { shell: false, cwd });
  return {
    revParse: (repo, ref) => git(['rev-parse', '--verify', String(ref)], repo),
    addWorktree: (repo, dir, ref) => git(['worktree', 'add', '--detach', dir, ref], repo),
    overlayFiles: (ws, ref, files) => git(['checkout', ref, '--', ...files], ws),
    removeWorktree: (repo, dir) => git(['worktree', 'remove', '--force', dir], repo),
    prune: (repo) => git(['worktree', 'prune'], repo),
  };
}

/** 扫描本仓提交（供 --scan；返回解析后的提交列表，候选判定在 cases.logic.js#isCaseCandidate） */
export async function scanRepoCommits({
  repoDir,
  runGit = (args) => runScript('git', args, { shell: false, cwd: repoDir, timeoutMs: 60_000 }),
} = {}) {
  const r = await runGit(['log', '--all', '--no-merges', '--numstat', '--format=%x00%H%x1f%h%x1f%s%x1f%P']);
  if (!r || !r.ok) return { ok: false, error: `git log 失败：${r?.err || r?.msg || '未知错误'}`, commits: [] };
  return { ok: true, commits: parseGitNumstatLog(r.out).filter((c) => isCaseCandidate(c)) };
}

/** 基准工作区的 prompt 说明段（生产对应的 scopeFix 见 task-ops.js#develop） */
export function buildBenchScopeFix(wsDir) {
  return (
    `\n【工作区说明】本次开发在独立基准工作区（git worktree，当前目录 ${wsDir}）进行；` +
    `所有文件修改必须在当前目录内完成，绝对不要修改该目录之外的任何文件。\n`
  );
}

/**
 * 准备工作树：清理同名残留 → worktree add --detach <base> → checkout fixRef -- <testFiles>。
 * @returns {Promise<{ok:true, dir:string, baseRef:string} | {ok:false, error:string}>}
 */
export async function prepareCaseWorkspace({ case: c, repoDir, wsRoot, git = makeGit() }) {
  const wsDir = path.join(wsRoot, c.id);
  // 残留清理：目录可能来自上次 --keep/崩溃（未注册的目录要 rm 兜底）
  try {
    if (fs.existsSync(wsDir)) await git.removeWorktree(repoDir, wsDir);
  } catch {
    /* 未注册为 worktree 时 remove 会失败，交给下面的 rm */
  }
  try {
    fs.rmSync(wsDir, { recursive: true, force: true });
  } catch {
    /* 删不掉时后续 add 会报错并如实返回 */
  }
  const baseRef = c.baseRef || `${c.fixRef}^`;
  const rv = await git.revParse(repoDir, baseRef);
  if (!rv.ok) return { ok: false, error: `基线不可解析（${baseRef}）：${rv.err || rv.msg || ''}`.trim() };
  const add = await git.addWorktree(repoDir, wsDir, baseRef);
  if (!add.ok) return { ok: false, error: `worktree 创建失败：${add.err || add.msg || ''}`.trim() };
  const ov = await git.overlayFiles(wsDir, c.fixRef, c.testFiles);
  if (!ov.ok) {
    await cleanupWorkspace({ repoDir, wsDir, git });
    return { ok: false, error: `判据植入失败（checkout ${c.fixRef} -- ${c.testFiles.join(' ')}）：${ov.err || ov.msg || ''}`.trim() };
  }
  return { ok: true, dir: wsDir, baseRef };
}

/** 清理工作树（worktree 注销 + 目录删除，双双 fail-soft） */
export async function cleanupWorkspace({ repoDir, wsDir, git = makeGit() }) {
  try {
    await git.removeWorktree(repoDir, wsDir);
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(wsDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 默认 agent：runClaude（与生产 develop 同权限模式）+ 指标采集。
 * @returns {Promise<{toolCalls:number, numTurns:number|null, inputTokens:number, outputTokens:number, costUsd:number|null, isError:boolean, subtype:string|null}>}
 */
export async function runClaudeAgent({ prompt, cwd, timeoutMs = DEFAULT_AGENT_TIMEOUT_MS, model = null } = {}) {
  let toolCalls = 0;
  let result = null;
  const abort = new AbortController();
  const timer = setTimeout(() => {
    try {
      abort.abort();
    } catch {
      /* ignore */
    }
  }, timeoutMs);
  if (timer.unref) timer.unref();
  try {
    await runClaude(prompt, {
      ...claudeAuthOpts(),
      cwd,
      permissionMode: 'bypassPermissions',
      abortController: abort,
      ...(model ? { model } : {}),
      onActivity: () => {
        toolCalls++;
      },
      onResult: (i) => {
        result = i;
      },
    });
  } finally {
    clearTimeout(timer);
  }
  return {
    toolCalls,
    numTurns: result?.numTurns ?? null,
    inputTokens: result?.inputTokens ?? 0,
    outputTokens: result?.outputTokens ?? 0,
    costUsd: result?.cost_usd ?? null,
    isError: result ? !!result.is_error : true,
    subtype: result?.subtype ?? null,
  };
}

/**
 * 跑单题（含准备/执行/评分/清理），任何阶段失败都如实入 record，不抛出。
 * @param {{case:object, repoDir:string, wsRoot:string, deps?:object}} input
 *   deps: { git, agent, verify, now, keep, agentTimeoutMs, model }
 */
export async function runCaseRecord({ case: c, repoDir, wsRoot, deps = {} }) {
  const {
    git = makeGit(),
    agent = runClaudeAgent,
    verify = runVerify,
    now = Date.now,
    keep = false,
    agentTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
    model = null,
  } = deps;
  const record = {
    caseId: c.id,
    title: c.title,
    at: new Date(now()).toISOString(),
    ok: false,
    error: null,
    develop: null,
    verify: null,
    metrics: { toolCalls: 0, numTurns: null, inputTokens: 0, outputTokens: 0, costUsd: null, durationMs: 0 },
  };
  const prep = await prepareCaseWorkspace({ case: c, repoDir, wsRoot, git });
  if (!prep.ok) {
    record.error = prep.error;
    return record;
  }
  try {
    const command = buildVerifyCommand(c.testFiles, c.verifyCommand);
    const prompt = buildDevelopPrompt({
      type: c.type,
      detail: c.input,
      analysis: c.analysis,
      scopeFix: buildBenchScopeFix(prep.dir),
      verifyCommand: command,
    });
    const t0 = now();
    let agentOut = null;
    try {
      agentOut = await agent({ prompt, cwd: prep.dir, timeoutMs: agentTimeoutMs, model });
    } catch (e) {
      record.error = `agent 执行失败：${e?.message || String(e)}`;
    }
    record.metrics.durationMs = now() - t0;
    if (agentOut) {
      record.metrics.toolCalls = agentOut.toolCalls ?? 0;
      record.metrics.numTurns = agentOut.numTurns ?? null;
      record.metrics.inputTokens = agentOut.inputTokens ?? 0;
      record.metrics.outputTokens = agentOut.outputTokens ?? 0;
      record.metrics.costUsd = agentOut.costUsd ?? null;
    }
    record.develop = { subtype: agentOut?.subtype ?? null, isError: agentOut ? !!agentOut.isError : !!record.error };

    // 防篡改：评分前把判据测试重置回 fixRef 版本（agent 改测试/删测试都不能影响评分）
    if (!record.error) {
      const reset = await git.overlayFiles(prep.dir, c.fixRef, c.testFiles);
      if (!reset.ok) record.error = `判据重置失败：${reset.err || reset.msg || ''}`.trim();
    }
    if (!record.error) {
      const v = await verify({ cwd: prep.dir, command });
      record.verify = {
        ok: v.ok,
        skipped: v.skipped,
        exitCode: v.exitCode,
        timedOut: v.timedOut,
        durationMs: v.durationMs,
        summary: v.summary,
      };
      record.ok = v.skipped !== true && v.ok === true;
      if (v.skipped) record.error = `验证被跳过（判据未真实执行）：${v.reason || ''}`;
    }
  } catch (e) {
    record.error = record.error || `benchmark 执行异常：${e?.message || String(e)}`;
  } finally {
    if (!keep) await cleanupWorkspace({ repoDir, wsDir: prep.dir, git });
  }
  return record;
}

/** 串行跑多题（额度敏感：绝不并发） */
export async function runCases({ cases = [], repoDir, wsRoot, deps = {} }) {
  const records = [];
  for (const c of cases) records.push(await runCaseRecord({ case: c, repoDir, wsRoot, deps }));
  return records;
}

/**
 * 离线校验单题：准备 → 判据必须「修复前失败」。
 * @returns {{caseId:string, valid:boolean, why:string, detail?:string, summary?:string}}
 */
export async function validateCase({ case: c, repoDir, wsRoot, deps = {} }) {
  const { git = makeGit(), verify = runVerify, keep = false } = deps;
  const prep = await prepareCaseWorkspace({ case: c, repoDir, wsRoot, git });
  if (!prep.ok) return { caseId: c.id, valid: false, why: 'prepare_failed', detail: prep.error };
  try {
    const command = buildVerifyCommand(c.testFiles, c.verifyCommand);
    const v = await verify({ cwd: prep.dir, command });
    if (v.skipped) return { caseId: c.id, valid: false, why: 'skipped', detail: v.reason || '', summary: v.summary };
    if (v.ok) {
      return { caseId: c.id, valid: false, why: 'already_passes', detail: '修复前判据即通过——该提交不构成回放题', summary: v.summary };
    }
    return { caseId: c.id, valid: true, why: 'ok', summary: v.summary };
  } catch (e) {
    return { caseId: c.id, valid: false, why: 'validate_error', detail: e?.message || String(e) };
  } finally {
    if (!keep) await cleanupWorkspace({ repoDir, wsDir: prep.dir, git });
  }
}

/** 串行校验多题 */
export async function validateCases({ cases = [], repoDir, wsRoot, deps = {} }) {
  const out = [];
  for (const c of cases) out.push(await validateCase({ case: c, repoDir, wsRoot, deps }));
  return out;
}

export { draftCaseFromCommit };

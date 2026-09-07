/**
 * 记忆库胶水层：调度 tick + 跑一轮提炼 + 渲染落盘。
 * v2 版本：两阶段流水线（Phase 1 逐会话分析 + Phase 2 合成记忆）。
 * 逻辑全在纯函数模块里（scan-sessions/analyze/synthesize/render/schedule），这里只做 IO 编排。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../../shared/logger.js';
import { ensureImport } from '../../shared/claude-md.js';
import { readBank, updateBank, addSession, patchSession } from '../../store/memory-bank.js';
import { getMemoryBankSettings } from '../../store/settings.js';
import { listActiveRuns, isPidAlive } from '../../store/active-runs.js';
import { getTokens } from '../../capabilities/token-rotation.js';
import { renderMarkdown } from './render.js';
import { shouldRun } from './schedule.js';
import { scanForUnanalyzedSessions } from './scan-sessions.js';
import { analyzeSession } from './analyze.js';
import { synthesizeMemories } from './synthesize.js';

const TICK_MS = 10 * 60 * 1000;

let _timer = null;
let _running = false;
let _shouldStop = false;

/** 请求中止当前 runOnce 循环（处理完当前会话后停止） */
export function stopOnce() {
  _shouldStop = true;
}

/** 当前是否正在提炼中 */
export function isRunning() {
  return _running;
}

/**
 * 渲染并落盘两个 scope 的 Markdown，同时挂接对应 CLAUDE.md。
 *
 * 铁律：渲染结果为空串也必须写盘，不能跳过 —— 用户在面板上否掉最后一条条目后，渲染结果会变空；
 * 若此时跳过写盘，磁盘上的 memory-bank.md 会原封不动，CLAUDE.md 的 @ 引用继续生效，
 * 刚被否掉的规则会在此后每一轮对话里照常静默注入，且用户完全无感知（与 render.js 的 renderMarkdown 契约一致）。
 */
export function writeRenders(items, { now, settings, projectDirs }) {
  const budget = { maxItems: settings.maxItems, maxChars: settings.maxChars, now };
  const results = [];

  // 全局：~/.claude/memory-bank.md，引用行 @memory-bank.md（该目录本身就是配置目录，不再嵌 .claude/）
  // 无论 g.text 是否为空都要写盘（空串也写成空文件），否则旧内容会被 CLAUDE.md 永久引用下去；
  // ensureImport 只在有内容时调用 —— 没有任何条目时没必要去动用户的 CLAUDE.md 加一行引用。
  const g = renderMarkdown(items, { scope: 'global', ...budget });
  const gPath = path.join(os.homedir(), '.claude', 'memory-bank.md');
  fs.mkdirSync(path.dirname(gPath), { recursive: true });
  fs.writeFileSync(gPath, g.text, 'utf8');
  if (g.text) {
    ensureImport(path.join(os.homedir(), '.claude', 'CLAUDE.md'), '@memory-bank.md');
  }
  results.push({ scope: 'global', ...g });

  // 项目级：<dir>/.claude/memory-bank.md，引用行 @.claude/memory-bank.md
  // 结果为空串时：该工程此前若已生成过 memory-bank.md，必须把它写空（同上，防止旧规则死灰复燃）；
  // 若从未生成过（文件不存在），说明这个工程本就没有 project-scope 记忆，不必凭空造一个空文件。
  for (const dir of projectDirs) {
    if (!dir) continue;
    const p = renderMarkdown(items, { scope: 'project', projectDir: dir, ...budget });
    const file = path.join(dir, '.claude', 'memory-bank.md');
    if (!p.text && !fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, p.text, 'utf8');
    if (p.text) ensureImport(path.join(dir, 'CLAUDE.md'), '@.claude/memory-bank.md');
    results.push({ scope: 'project', projectDir: dir, ...p });
  }
  return results;
}

/**
 * 跑一轮两阶段流水线。手动触发与定时触发共用。
 *
 * Phase 1：扫描 ~/.claude/projects 找未分析/需重分析的会话，逐条调 analyzeSession；
 * LLM 失败（null）时跳过该条不更新 bank，留待下轮重试。
 *
 * Phase 2：收集 bank.sessions 所有非空 findings，调 synthesizeMemories 合成长期记忆写入 bank。
 *
 * @param {{model?:string, _runner?:Function, now?:number}} opts
 *   `_runner` 仅供测试注入替换 runClassifierOnce，避免单测烧用户额度。
 * @returns {Promise<{analyzed:number, newMemories:Array|null, truncated:number}>}
 */
export async function runOnce(opts = {}) {
  if (_running) {
    return { analyzed: 0, newMemories: null, skipped: 'already-running' };
  }
  _running = true;
  _shouldStop = false;
  try {
    const { _runner, model } = opts;
    const settings = getMemoryBankSettings();

    // ── Phase 1: 扫描 + 逐会话分析 ──────────────────────────────────────────
    let bank = readBank();
    const unanalyzed = scanForUnanalyzedSessions(bank);

    let analyzedCount = 0;
    for (const { path: sessionPath, mtime } of unanalyzed) {
      // 每次循环开始检查暂停信号
      if (_shouldStop) {
        _shouldStop = false;
        logger.info('memory-bank', '收到暂停信号，提前终止 Phase 1');
        break;
      }

      let content;
      try {
        content = fs.readFileSync(sessionPath, 'utf8');
      } catch {
        continue;
      }

      // 分析前先标记为「分析中」，供 UI 实时展示进度
      const preBank = readBank();
      const preExisting = preBank.sessions.find((s) => s.path === sessionPath);
      if (preExisting) {
        patchSession(preExisting.id, { status: 'analyzing' });
      } else {
        const preId = `ses_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        addSession({ id: preId, path: sessionPath, mtime, analyzedAt: 0, findings: [], status: 'analyzing' });
      }

      const findings = await analyzeSession(content, { model, _runner });

      if (findings === null) {
        // LLM 调用失败：重置为 pending，让下轮重试
        const failBank = readBank();
        const failSes = failBank.sessions.find((s) => s.path === sessionPath);
        if (failSes) patchSession(failSes.id, { status: 'pending' });
        logger.warn('memory-bank', '会话分析失败，跳过本条等下轮重试', { sessionPath });
        continue;
      }

      // findings 为 [] 或 [...]：用当前时刻作为 analyzedAt（避免长批次中 mtime > 批次起始时间导致下轮误判为待分析）
      const analyzedAt = Date.now();
      const freshBank = readBank();
      const existing = freshBank.sessions.find((s) => s.path === sessionPath);
      if (existing) {
        patchSession(existing.id, { mtime, analyzedAt, findings, status: 'analyzed' });
      } else {
        const id = `ses_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        addSession({ id, path: sessionPath, mtime, analyzedAt, findings, status: 'analyzed' });
      }
      analyzedCount++;
    }

    // ── Phase 2: 合成记忆 ────────────────────────────────────────────────────
    // 重新读取含最新 sessions 的 bank
    bank = readBank();
    const allFindings = bank.sessions
      .filter((s) => Array.isArray(s.findings) && s.findings.length > 0)
      .flatMap((s) => s.findings);

    let newMemories;
    if (allFindings.length > 0) {
      newMemories = await synthesizeMemories(allFindings, { model, _runner });
    } else {
      // 没有任何 findings，跳过 LLM 合成（[] 不是失败）
      newMemories = [];
    }

    // ── 渲染落盘（保留 CLAUDE.md 注入链路）──────────────────────────────────
    // v2 memories 尚无 scope/projectDir 字段，projectDirs 传空列表；
    // render.js 的 selectForInjection 会过滤掉缺 status/inject 字段的条目，写空文件是正确行为。
    bank = readBank();
    const renders = await writeRenders(bank.memories || [], { now, settings, projectDirs: [] });
    const truncated = (renders || []).reduce((a, r) => a + (r.truncated || 0), 0);
    if (truncated > 0) logger.info('memory-bank', '条目因注入预算未渲染', { truncated });

    // 更新最后提炼时间（供 shouldRun 的冷却判定使用）
    updateBank((b) => ({ ...b, lastExtractAt: now }));

    logger.info('memory-bank', '两阶段流水线完成', {
      analyzed: analyzedCount,
      total: unanalyzed.length,
      newMemories: newMemories?.length ?? null,
      truncated,
    });
    return { analyzed: analyzedCount, newMemories, truncated };
  } catch (e) {
    logger.error('memory-bank', '两阶段流水线异常', { err: e?.message || String(e) });
    return { analyzed: 0, newMemories: null, error: e?.message || String(e) };
  } finally {
    _running = false;
  }
}

/** 定时 tick：判定窗口后才跑。web 入口启动时调用一次 */
export function startMemoryBankTicker({ cwd = process.cwd() } = {}) {
  // 幂等：重复调用不叠加定时器（否则每次调用都多一路 tick，提炼频率成倍上涨）
  if (_timer) clearInterval(_timer);
  _timer = setInterval(async () => {
    // 整个 tick 体兜异常：readBank/getTokens 等任一处抛错（如配置文件被写坏）都不能变成
    // unhandledRejection 打死常驻进程 —— 记忆库是锦上添花的功能，绝不该拖垮执行台。
    try {
      const now = Date.now();
      const bank = readBank();
      const decision = shouldRun({
        now,
        settings: getMemoryBankSettings(),
        tokens: getTokens(),
        activeRunCount: listActiveRuns().filter((e) => isPidAlive(e?.pid)).length,
        lastExtractAt: bank.lastExtractAt,
        // providerId 走默认值 DEFAULT_PROVIDER_ID('claude-agent')：提炼最终经
        // runClassifierOnce → claudeAuthOpts() → getActiveToken() 也是这个默认 provider，两边必须一致。
      });
      if (!decision.run) {
        logger.info('memory-bank', 'tick 跳过', { reason: decision.reason, window: decision.window });
        return;
      }
      logger.info('memory-bank', '进入提炼窗口', { window: decision.window });
      await runOnce({ now });
    } catch (e) {
      logger.error('memory-bank', 'tick 异常', { err: e?.message || String(e) });
    }
  }, TICK_MS);
  // 不阻止进程退出：记忆库定时器不该让 node 因为一个后台 tick 迟迟不退
  if (_timer.unref) _timer.unref();
  return _timer;
}

/** 停表（测试/优雅退出用）；未启动时无副作用 */
export function stopMemoryBankTicker() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

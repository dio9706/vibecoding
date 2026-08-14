/**
 * 记忆库胶水层：调度 tick + 跑一轮提炼 + 渲染落盘。
 * 逻辑全在纯函数模块里（prefilter/promote/render/schedule），这里只做 IO 编排。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../../shared/logger.js';
import { ensureImport } from '../../shared/claude-md.js';
import { readBank, writeBank } from '../../store/memory-bank.js';
import { getMemoryBankSettings } from '../../store/settings.js';
import { listActiveRuns, isPidAlive } from '../../store/active-runs.js';
import { getTokens } from '../token-rotation.js';
import { readUserLog } from '../../store/user-log.js';
import { buildExtractionInput } from './prefilter.js';
import { extractFromSessions } from './extract.js';
import { mergeCandidates, applyDormancy } from './promote.js';
import { renderMarkdown } from './render.js';
import { shouldRun } from './schedule.js';

const TICK_MS = 10 * 60 * 1000;
/** 单轮最多消费的用户输入条数：防首次启用时把整份历史日志一次性喂进去烧穿额度。
 *  超出的部分留在游标之后，下一轮接着读（readUserLog 的 limit 只把 offset 推进到最后一条被返回的行）。 */
const MAX_ENTRIES_PER_RUN = 120;

let _timer = null;
let _running = false;

/**
 * 条目 id 生成器。id 是条目主键（patchItem/rejectItem/ackItems 都按它定位），重复即改错条目，
 * 因此盐里必须带**完整**毫秒时间戳 + 随机段：只取 now % 1000 的话，同一天里两轮提炼有 1/1000
 * 的概率首个 id 撞车（生日问题下几十轮就接近必然），而撞车后用户在面板上「否掉」A 会连带删掉 B。
 */
function makeIdFactory(now) {
  let n = 0;
  const stamp = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  const salt = `${Math.floor(now).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return () => `mem_${stamp}_${salt}${(++n).toString(36)}`;
}

/** 黑名单按 fingerprint 去重合并（磁盘最新 + 内存快照） */
function mergeBlacklist(a, b) {
  const out = [];
  const seen = new Set();
  for (const e of [...(a || []), ...(b || [])]) {
    const fp = e?.fingerprint;
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    out.push(e);
  }
  return out;
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
 * 需要重渲染的工程目录集合。
 * 必须并上当前 cwd：条目全被否掉后 items 里就再也找不到这个 projectDir，
 * 只从 items 推导的话，该工程磁盘上的旧 memory-bank.md 永远不会被写空 —— 正是上面那条铁律要防的情形。
 * 同理要并上本轮扫到的会话 cwd：user-log 是全局日志，一批里混着好几个工程，
 * 某个工程的条目刚被清零时，只看 items 和 cwd 同样漏掉它。
 */
function collectProjectDirs(items, cwd, seenDirs = []) {
  const set = new Set(
    (items || []).filter((i) => i.scope === 'project' && i.projectDir).map((i) => i.projectDir),
  );
  if (cwd) set.add(cwd);
  for (const d of seenDirs) if (d) set.add(d);
  return [...set];
}

/**
 * 跑一轮。手动触发与定时触发共用。
 *
 * 数据源是 store/user-log.js（后端埋点采集的用户真实输入），不再是会话转录 ——
 * 转录那条路已被真实数据证伪（脏、且正则捞纠正的信号模型压根不成立），详见 prefilter.js 顶部。
 *
 * 为什么整批只发**一次** LLM 调用：用户真人发言总量极小（实测 20 个会话约 5000 字符），
 * 一次装得下；而 user-log 是单条时间序日志、游标是字节偏移，多个会话的字节区间彼此交错，
 * 按会话逐个调用时根本无法「只推进成功那部分」的游标。一次调用 = 一个原子的成功/失败，
 * 游标要么整体推进要么原地不动，不会出现半推进的中间态。
 *
 * @param {{cwd?:string, now?:number}} opts cwd = 提炼进程的工作目录（会话自身没记 cwd 时的兜底）
 * @returns {Promise<{scanned:number, candidates:number, promoted:string[], truncated:number, dropped:number}>}
 */
export async function runOnce({ cwd = process.cwd(), now = Date.now() } = {}) {
  if (_running) {
    return { scanned: 0, candidates: 0, promoted: [], truncated: 0, dropped: 0, skipped: 'already-running' };
  }
  _running = true;
  try {
    const settings = getMemoryBankSettings();
    const bank = readBank();
    const { entries, offset } = readUserLog({ offset: bank.userLogOffset, limit: MAX_ENTRIES_PER_RUN });
    const { sessions, used, dropped } = buildExtractionInput(entries);
    // 必须记进日志：游标按字节推进，被预算挤掉的条目下一轮读不到了，静默丢等于永久丢证据。
    if (dropped > 0) logger.warn('memory-bank', '用户输入超预算被丢弃（这批证据不会再读到）', { dropped, used });

    const makeId = makeIdFactory(now);
    let state = { items: bank.items, blacklist: bank.blacklist };
    let candidateCount = 0;
    const promoted = [];
    // 游标推进的唯一条件：这批输入被成功处理完。提炼失败就原地不动，下轮整批重试。
    let cursor = bank.userLogOffset;
    let llmCalls = 0;

    if (!sessions.length) {
      // 这批里没有一句用户真话（全是空行/畸形行）——已消费完毕，属成功，必须推进，
      // 否则游标会永久卡在这批噪声上，此后所有新输入都读不到。
      cursor = offset;
    } else {
      // llmCalls 在发起调用前就计数：失败的调用也烧了额度，必须计入，否则一轮全失败会被
      // shouldRun 误判为「没跑过」，白白多起一轮冷却窗之外的重试。
      llmCalls += 1;
      const cands = await extractFromSessions(sessions, {
        cwd,
        // 归位失败时的兜底会话标识（正常情况下 sanitizeCandidates 会按 quote 回填真实会话 id）。
        // 带上偏移量是为了让不同批次落成不同标识：两批各出一次的同一条偏好本就是两次独立证据。
        sessionId: `user-log@${bank.userLogOffset}`,
        model: settings.model,
      });
      // extractFromSessions 的返回契约：null = 底层调用失败（超时/额度耗尽/解析不出），
      // 不推进游标，下轮重试；[] = 调用成功但模型判定确实提炼不出偏好，属正常完成，可以推进。
      if (cands !== null) {
        candidateCount += cands.length;
        const merged = mergeCandidates(state, cands, {
          now, makeId,
          threshold: { minEvidence: settings.minEvidence, minSessions: settings.minSessions },
        });
        state = { items: merged.items, blacklist: merged.blacklist };
        promoted.push(...merged.promoted);
        cursor = offset;
      }
    }

    state.items = applyDormancy(state.items, { now, dormantDays: settings.dormantDays });

    // 落盘前与磁盘最新状态对账：本轮跨了多次 await（每次提炼最长 30s），
    // 期间用户可能在面板上否掉某条 —— rejectItem 已把 fingerprint 写进磁盘黑名单并删掉条目，
    // 而我们手上的 state 还是开跑前的快照，整体回写会让它复活，破坏 promote.js 的「否过的永不复活」不变量。
    const disk = readBank();
    const blacklist = mergeBlacklist(disk.blacklist, state.blacklist);
    const banned = new Set(blacklist.map((b) => b?.fingerprint).filter(Boolean));
    const items = state.items.filter((it) => !banned.has(it.fingerprint));

    // 无论本轮有没有读到新输入都要渲染落盘：用户刚否掉最后一条时 entries 往往是空的，
    // 此时若直接返回，被否掉的规则会继续躺在磁盘上被 CLAUDE.md 引用（同 writeRenders 的铁律）；
    // applyDormancy 的降级也同理，需要在没有新输入的日子里照常生效。
    const projectDirs = collectProjectDirs(items, cwd, sessions.map((s) => s.cwd));
    const renders = writeRenders(items, { now, settings, projectDirs });
    const truncated = renders.reduce((a, r) => a + (r.truncated || 0), 0);
    if (truncated > 0) logger.info('memory-bank', '条目因注入预算未渲染', { truncated });

    writeBank({
      version: 1,
      // 转录游标原样透传：默认链路已不用它，但历史回填/终端场景（prefilter-transcript.js）还要靠它，
      // 这里若忘了带上，整份回写会把它抹成 0。
      lastScannedAt: bank.lastScannedAt,
      // 提炼失败时不推进游标，下轮整批重试；否则这批输入会被永久跳过、证据静默丢失
      userLogOffset: cursor,
      // 只有真发起过 LLM 调用才算「跑过一轮」：没花额度就不该起冷却，
      // 否则一次空扫会把 shouldRun 的 minIntervalHours 冷却窗白白吃掉。
      lastExtractAt: llmCalls > 0 ? now : bank.lastExtractAt,
      items,
      blacklist,
    });

    logger.info('memory-bank', '提炼完成', {
      scanned: used, sessions: sessions.length, candidates: candidateCount, promoted: promoted.length, truncated, dropped,
    });
    return { scanned: used, candidates: candidateCount, promoted, truncated, dropped };
  } catch (e) {
    logger.error('memory-bank', '提炼异常', { err: e?.message || String(e) });
    return { scanned: 0, candidates: 0, promoted: [], truncated: 0, dropped: 0, error: e?.message || String(e) };
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
      if (!decision.run) return;
      logger.info('memory-bank', '进入提炼窗口', { window: decision.window });
      await runOnce({ cwd, now });
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

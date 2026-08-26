/**
 * feature: 埋点统计（`帮我统计埋点: <自然语言>`）。
 *
 * 前缀严格匹配开头（零 LLM）→ 阶段 A 理解（时间/目标/检索词）→ 纯函数召回
 * → 阶段 B 精选 + 硬校验 → Python 脚本查生产只读库并渲染 HTML → 文字摘要 + 附件送达。
 *
 * **不设身份门禁**（用户拍板）：埋点统计是常规功能，团队里谁都该能自助查数。
 * 代价是唯一的闸门没了，所以必须自带速率与并发保护 —— 见 throttle.js。
 *
 * 与 \10001/\10002 的差别：那两个是全等匹配，本功能必须携带自然语言正文，
 * 只能用前缀匹配；安全边界因此落在「前缀足够长且不像日常用语」+「只匹配消息开头」两处。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript } from '../../integrations/shell.js';
import { uploadFile, sendFile } from '../../integrations/lark.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { loadDict } from './dict.js';
import { understandRequest, pickTargets, beijingNow } from './understand.js';
import {
  parseTrackingCommand,
  recallCandidates,
  normalizeRange,
  inferGroupBy,
  validateSelection,
  buildSummaryText,
  buildReportFileName,
  buildUnderstandFailureReply,
  normalizeScope,
  buildScopeNotice,
  SCOPE_SAFE_TITLE,
  MAX_TARGETS,
} from './logic.js';
import { checkThrottle, buildThrottleReply, collectExpired, MAX_CONCURRENT } from './throttle.js';

/** 脚本超时：SQL 单条 30s 上限 + 环比/精确 UV 等多轮查询 + 渲染，3 分钟留足余量 */
const SCRIPT_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * 查询脚本路径：从模块自身位置反推，**不走 config.scripts.dir**。
 *
 * config.scripts.dir 指向可写的数据目录（生产注入 APP_DATA_DIR），那是给 action-runner 的
 * 用户自配动作脚本用的 —— 用户丢个脚本进去就能跑，不必改代码，放可写目录是对的。
 * 但本脚本与 Node 侧共享 QuerySpec 契约（字段名、page path 格式、summary 结构），两边必须同版本；
 * 放数据目录意味着每次改 Node 都要手工同步 Python，忘了就是契约错位 ——
 * 而那种错误的表现是「数字不对」或「解析失败」，不是清晰报错。
 * 与同目录 dict.js 定位 data/event-dict.json 同理：cwd 由谁拉起进程决定，不能依赖。
 */
const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tracking_report.py');

/** 冷却状态：userId → 上次发起时刻（内存态，进程重启即清空） */
const lastRunAt = new Map();
/** 当前在跑的统计条数（全局并发计数） */
let running = 0;
/** 冷却表超过这个规模才做一次清扫 —— 平时不为一个几十项的 Map 付遍历成本 */
const SWEEP_THRESHOLD = 200;

/** 把 QuerySpec 写进临时文件传给脚本 —— 走命令行参数会撞长度与转义问题 */
async function writeSpecFile(spec) {
  const dir = path.join(os.tmpdir(), 'tracking-stats');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `spec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await fs.writeFile(p, JSON.stringify(spec), 'utf8');
  return p;
}

/** 宽松 JSON 解析：解析不出来返回 null，绝不抛 —— 调用方要区分「脚本没输出」和「输出了错误」 */
function parseJsonSafe(text) {
  try {
    const t = String(text || '').trim();
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
}

/**
 * 主流程。任何一步失败都必须回话 —— 静默失败是这个功能最糟的失败模式：
 * 用户等一个统计结果等到天荒地老却毫无音讯。
 */
async function runReport(ctx, body) {
  const dict = loadDict();
  if (!dict) {
    return ctx.reply('❌ 埋点索引未就绪，请先运行：node scripts/sync-event-dict.mjs <compass-agent 目录>');
  }

  // today 必须与阶段 A 注入 prompt 的那个日期**同源**：understandRequest 内部走
  // beijingNow(now).date，这里把同一个 now 传进去，再用同一次 beijingNow 的结果去收敛区间。
  // 各算各的会在跨日边界上错位 —— 模型按 8-20 推算、校验按 8-19 收敛，区间凭空少一天。
  const now = new Date();
  const { date: today } = beijingNow(now);

  // 阶段 A：理解
  const understood = await understandRequest(body, dict, now);
  if (!understood.ok) {
    // 按真实原因回话：超时/额度耗尽时说「换个说法」，只会让用户反复改写一句本来正确的需求
    return ctx.reply(buildUnderstandFailureReply(understood.reason));
  }

  const range = normalizeRange(understood.range, today);
  // 整段区间都在保留期外：**不查库**。查了只会得到一张写着「该时段无数据」的报告，
  // 而那句话会被读成「那阵子真没人用」—— 一个看着有效、实则完全错误的结论。
  if (range.outOfRetention) {
    return ctx.reply(
      [
        `📅 你要查的是 ${range.start} ~ ${range.end}（共 ${range.days} 天）。`,
        ...range.notes,
        '换一个更近的时间段再试试～',
      ].join('\n'),
    );
  }

  // 召回（纯函数，零成本）
  const candidates = recallCandidates(understood.keywords, dict, understood.target);
  if (!candidates.events.length && !candidates.pages.length) {
    const cats = (dict.categories || []).slice(0, 12).map((c) => c.label || c.prefix).filter(Boolean).join('、');
    return ctx.reply(`没找到相关埋点～${cats ? `目前有数据的业务模块：${cats}\n` : ''}换个说法再试试。`);
  }

  // 阶段 B：精选
  const picked = await pickTargets(body, candidates);
  if (!picked) {
    return ctx.reply('埋点匹配失败（模型无响应），稍后再试～');
  }
  const sel = validateSelection(picked, dict);
  if (sel.empty) {
    const hint = [...candidates.events.map((e) => e.label), ...candidates.pages.map((p) => p.label)]
      .filter(Boolean)
      .slice(0, 8)
      .join('、');
    return ctx.reply(`没匹配到具体埋点～${hint ? `你是想看这些吗：${hint}` : '换个说法再试试。'}`);
  }
  if (sel.dropped.length) {
    // 模型编造标识是这条链路唯一会「安静产出错误结论」的失效方式，必须在日志里留痕
    logger.warn('tracking-stats', '剔除了索引中不存在的标识', { dropped: sel.dropped });
  }

  // 能力边界（见 specs/2026-08-26-tracking-stats-scope-guard-design.md）：
  // 「漏斗/留存/下钻/多事件关联/用户分群」这五类设计上就不做。越界时不拒答，
  // 而是降级给 PV/UV 并显式声明 —— 但 title 必须换成固定安全标题：
  // 用户拍板报告附件里不加声明，title 就是这份报告脱离对话后**唯一**的防线。
  // 沿用模型产出的「付费用户行为轨迹统计」之类标题，截图转发出去就是个污染源。
  const scope = normalizeScope(understood.scope);
  const title = scope.supported ? understood.title : SCOPE_SAFE_TITLE;
  if (!scope.supported) {
    logger.info('tracking-stats', '需求超出能力边界，降级为 PV/UV 口径', {
      unsupported: scope.unsupported,
      // 留原标题便于回溯模型当时怎么理解的；也是评估误判率的唯一线索
      droppedTitle: understood.title,
    });
  }

  const spec = {
    title,
    events: sel.events,
    pages: sel.pages,
    range: { start: range.start, end: range.end },
    rangeDays: range.days,
    includesToday: range.includesToday,
    metrics: ['pv', 'uv'],
    groupBy: inferGroupBy(range),
    compare: true,
    // 区间被静默改写而报告上不写，用户会拿着一份「我以为查了半年」的报告去开会
    notes: [...range.notes, ...(sel.truncated ? [`统计对象超过 ${MAX_TARGETS} 项，已截断`] : [])],
  };

  const specPath = await writeSpecFile(spec);
  const fileName = buildReportFileName(title, now);
  logger.info('tracking-stats', '开始查询', {
    title: spec.title,
    events: spec.events.length,
    pages: spec.pages.length,
    range: `${spec.range.start}~${spec.range.end}`,
    groupBy: spec.groupBy,
  });

  let r;
  try {
    // TRACKING_DB_* 不必在这里逐个透传：runScript 的 env 是 `{...process.env, ...env}`，
    // 父进程环境整体继承下去（见 integrations/shell.js）。这里只补 Python 侧必须的编码设置 ——
    // 报告标题与事件中文名全是中文，Windows 控制台默认 GBK 会直接把进程打挂。
    r = await runScript(config.scripts.pythonBin, [SCRIPT_PATH, '--spec', specPath, '--file-name', fileName], {
      env: { PYTHONIOENCODING: 'utf-8' },
      timeoutMs: SCRIPT_TIMEOUT_MS,
    });
  } finally {
    // 临时 spec 不留在盘上；删失败不影响结论，吞掉即可
    await fs.rm(specPath, { force: true }).catch(() => {});
  }

  // 先解析 stdout 再看退出码：脚本失败时也会往 stdout 打一行 {"error": ...} 并 exit 1。
  // 反过来先判 r.ok 就只能拿到空的 stderr，回给用户一句「(无输出)」—— 错因彻底丢失。
  const out = parseJsonSafe(r.out);
  if (out?.error) {
    logger.error('tracking-stats', '脚本报错', { error: out.error });
    return ctx.reply(`❌ 统计失败：${String(out.error).slice(0, 300)}`);
  }
  if (!r.ok) {
    const tail = (r.msg || r.err || '').slice(-500);
    return ctx.reply(`❌ 统计失败\n${tail || '(无输出)'}`);
  }
  if (!out?.htmlPath) {
    return ctx.reply(`❌ 报告结果解析失败\n${(r.out || '').slice(-400) || '(stdout 为空)'}`);
  }

  // 先发摘要再发附件：附件上传可能失败，结论必须先到。
  // 摘要发送失败也不能中断附件发送 —— 两条是互为备份的送达路径。
  //
  // 越界声明拼在摘要**前面、同一条消息里**：分成两条发会被别人的消息割开，
  // 而一条孤零零的摘要看上去就是个正常结论 —— 声明必须和它要限定的数字待在一起。
  const summaryText = buildSummaryText(out.summary);
  await ctx
    .reply(scope.supported ? summaryText : `${buildScopeNotice(scope.unsupported)}\n\n${summaryText}`)
    .catch((e) => logger.warn('tracking-stats', '摘要发送失败', { err: e?.message || String(e) }));

  const chatId = ctx.meta?.chatId || ctx.sessionKey;
  try {
    const buf = await fs.readFile(out.htmlPath);
    const key = await uploadFile(buf, fileName);
    await sendFile(chatId, key);
    logger.info('tracking-stats', '报告已送达', { chatId, fileName });
  } catch (e) {
    logger.error('tracking-stats', '附件发送失败', { err: e?.message || String(e) });
    // 降级：把本地路径告诉用户，报告本身还在，人工也能取到
    await ctx
      .reply(`⚠️ 报告文件发送失败（${e?.message || e}），本地路径：${out.htmlPath}`)
      .catch(() => {});
  }
}

export default {
  name: 'tracking-stats',
  // 全员可用：埋点统计是常规功能，不设身份门禁；防滥用靠 throttle 而不是白名单
  permission: 'any',
  // 不参与意图路由：前缀已经足够明确，多一条意图只会给分类器增加一个出错面
  intents: [],
  match: (ctx) => parseTrackingCommand(ctx.text).hit,
  handle: async (ctx) => {
    const { body } = parseTrackingCommand(ctx.text);
    // 追问不占配额：只发了前缀的人还没触发任何 LLM 或查询，罚他冷却一分钟毫无道理
    if (!body) {
      return ctx.reply('要统计什么埋点？例如：\n帮我统计埋点: 最近7天分享功能的点击情况');
    }

    const userId = ctx.user?.id || ctx.sessionKey || 'anonymous';
    const nowMs = Date.now();
    const verdict = checkThrottle({ lastAtMs: lastRunAt.get(userId), running, now: nowMs });
    if (!verdict.ok) {
      logger.info('tracking-stats', '请求被限流', { userId, reason: verdict.reason, running });
      // 明确回话，不静默丢弃：什么都不回，用户会以为机器人死了，然后再发几遍
      return ctx.reply(buildThrottleReply(verdict, MAX_CONCURRENT));
    }

    if (lastRunAt.size > SWEEP_THRESHOLD) {
      for (const k of collectExpired(lastRunAt.entries(), nowMs)) lastRunAt.delete(k);
    }
    lastRunAt.set(userId, nowMs);
    running += 1;

    // 即时应答不 await（与 bug-patrol 同理：发送失败不该中断统计流程）
    ctx
      // 说 1~3 分钟而不是 1 分钟：实测两阶段 LLM 常态各 20~30s，加查库 1~7s 与渲染，
      // 总耗时多在 1.5 分钟上下；但限流窗口内单阶段实测可达 52s，两阶段预算上限合计 3 分钟
      // （见 understand.js 的 TIMEOUT_MS）。承诺短了用户会在还没出结果时以为机器人挂了，然后重发。
      .reply('📊 收到，正在理解需求并查询埋点…（约需 1~3 分钟，完成后在此回报）')
      .catch((e) => logger.warn('tracking-stats', '即时应答发送失败', { err: e?.message || String(e) }));

    // 异步执行：任何没被局部 catch 的异常都在这里兜底回告，绝不静默；
    // 并发计数必须在 finally 归还，否则一次异常就永久占掉一个名额。
    runReport(ctx, body)
      .catch(async (e) => {
        logger.error('tracking-stats', '统计失败', { err: e?.message || String(e) });
        await ctx
          .reply(`❌ 统计失败：${(e?.message || String(e)).slice(0, 200)}`)
          .catch((e2) => logger.error('tracking-stats', '失败回告也发送失败', { err: e2?.message || String(e2) }));
      })
      .finally(() => {
        running = Math.max(0, running - 1);
      });
  },
};

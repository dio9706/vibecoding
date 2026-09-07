/**
 * 自由形数据问答（`帮我查数据: <自然语言>`）—— 编排层。
 *
 * 与同目录 `feature.js`（`帮我统计埋点:`）是**并行的两条路径，不是替换**：
 * - 老路径：闭合 QuerySpec → 固定 SQL → 精美 HTML 报告（折线图 + KPI + 明细表）。
 *   处理「标准埋点报表」这个高频场景，图表质量是它的价值。
 * - 本路径：只读 Agent 多轮探 schema、自己写 SQL → 文字结论。
 *   处理长尾自由问题（跨表、任意分组、非埋点的业务库统计）。
 *
 * 安全边界不在本文件 —— 四层防线分别在 `capabilities/llm-sql-agent.js`（工具面收窄）、
 * `capabilities/sql-guard.js`（SQL 校验）、`sql_exec.py`（会话只读 + 行数截断）、
 * `store/sql-audit.js`（审计）。本文件只做编排与回话，**不要在这里加安全判断** ——
 * 分散的安全逻辑等于没有安全逻辑。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript } from '../../integrations/shell.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { runSqlAgent } from '../../capabilities/llm-sql-agent.js';
import { appendSqlAudit } from '../../store/sql-audit.js';
import { loadDict } from './dict.js';
import { beijingNow } from './understand.js';
import {
  parseFreeformCommand,
  buildAnalysisPrompt,
  buildAnswerReply,
  buildFreeformFailureReply,
  classifyDbError,
} from './freeform.logic.js';
import { checkThrottle, buildThrottleReply, collectExpired, MAX_CONCURRENT } from './throttle.js';

/**
 * 执行器路径：从模块自身位置反推，**不走 config.scripts.dir**。
 * 理由同 feature.js 的 SCRIPT_PATH —— 该脚本与 Node 侧共享协议（stdin/stdout 的 JSON 形状），
 * 两边必须同版本；放可写数据目录意味着每次改 Node 都要手工同步 Python，忘了就是协议错位，
 * 而那种错误表现为「解析失败」而不是清晰报错。
 */
const EXEC_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sql_exec.py');

/** 单条查询的子进程超时：Python 冷启 ~1s + MySQL 侧 MAX_EXECUTION_TIME 30s，留足余量 */
const EXEC_TIMEOUT_MS = 60_000;
/** 单次分析的总预算 —— 多轮 Agent，比单次报告贵得多 */
const AGENT_TIMEOUT_MS = 5 * 60 * 1000;
/** 单条查询返回的最大行数（超出截断并在回复里明说） */
const MAX_ROWS = 200;

/** 冷却状态：userId → 上次发起时刻（内存态，进程重启即清空；与 feature.js 各自独立） */
const lastRunAt = new Map();
let running = 0;
const SWEEP_THRESHOLD = 200;

/**
 * 跑一条 SQL：spawn sql_exec.py，stdin 递 JSON，stdout 收 JSON。
 *
 * 为什么每条查询起一个进程而不常驻连接：本功能极低频（一两个人、1~2 周一次），
 * 冷启约 1 秒不可感知，而复用 Python 白拿三样 —— pymysql 多语句默认关闭、
 * SSDictCursor 流式截断、以及 tracking_report.py 已跑通的连接配置与跳板环境（详见 spec §6.1）。
 *
 * @throws {Error} 带 `kind` 属性（'db_connect'|'db_query'）供上层分类回话
 */
async function executeSql(sql, maxRows = MAX_ROWS) {
  const r = await runScript('python', [EXEC_PATH], {
    input: JSON.stringify({ sql, maxRows }),
    timeoutMs: EXEC_TIMEOUT_MS,
  });

  // runScript 的结果字段是 out/err（不是 stdout/stderr），且它永不抛，只回结构化结果
  let out = null;
  try {
    const last = String(r?.out || '').trim().split('\n').filter(Boolean).pop();
    out = last ? JSON.parse(last) : null;
  } catch {
    out = null;
  }

  if (!out) {
    // 脚本没给出合法 JSON：多半是 python 不在 PATH、脚本崩在 import 阶段、或超时被杀。
    // 把 stderr / 启动失败信息带出来 —— 这类问题不给原文根本没法查。
    const detail = String(r?.msg || r?.err || '').slice(0, 300) || '(无错误输出)';
    const err = new Error(`查询执行器无输出：${detail}`);
    err.kind = 'db_query';
    throw err;
  }
  if (out.error) {
    const err = new Error(out.error);
    err.kind = classifyDbError(out);
    throw err;
  }
  return out;
}

/**
 * 主流程。任何一步失败都必须回话 —— 静默失败是这类功能最糟的失败模式
 *（用户等一个结果等到天荒地老却毫无音讯）。
 */
async function runAnalysis(ctx, question) {
  const userId = ctx.user?.id || ctx.sessionKey || 'anonymous';
  const { date: today } = beijingNow(new Date());
  const dbName = process.env.TRACKING_DB_NAME || 'compass_prod';

  // 埋点索引是**先验**不是必需：非埋点类查询（订单、用户表统计）没有它照样能做，
  // 所以缺失只降级、不阻断 —— 与 feature.js 那条「索引未就绪就直接拒」的老路径不同。
  const dict = loadDict();
  if (!dict) logger.info('tracking-stats', '埋点索引未就绪，自由形查询降级为无先验模式');

  const prompt = buildAnalysisPrompt(question, dict, today, dbName);

  let dbFailure = null; // 记住首个 DB 层失败，用于给出更准的失败文案
  const r = await runSqlAgent({
    prompt,
    timeoutMs: AGENT_TIMEOUT_MS,
    execute: async (sql, maxRows) => {
      try {
        return await executeSql(sql, maxRows);
      } catch (e) {
        if (!dbFailure && e?.kind === 'db_connect') dbFailure = e;
        throw e; // 抛回工具层，由它转成模型能读的 error 文本继续下一轮
      }
    },
    onAudit: (e) => {
      // 审计**不 await**：它在用户等待路径上，且 appendSqlAudit 自身永不抛
      appendSqlAudit({ ...e, userId, userName: ctx.user?.name || null, question });
    },
  });

  // 一次库都没连上 → 别报「模型没结论」，那会把人往提示词方向带偏
  if (dbFailure && !r.text.trim()) {
    return ctx.reply(buildFreeformFailureReply('db_connect', dbFailure.message));
  }
  if (r.reason) {
    return ctx.reply(buildFreeformFailureReply(r.reason));
  }
  return ctx.reply(buildAnswerReply(r));
}

export default {
  name: 'tracking-freeform',
  // 全员可用（维护者拍板：一两个人用、1~2 周一次，建名单不划算）。
  // ⚠️ 连带后果：没有身份门禁时，sql-guard 的 PII 黑名单就是**唯一**的隐私边界，
  // 审计日志是唯一的事后手段。放开使用面前请重新评估这条（见 spec §3 第 4 层）。
  permission: 'any',
  // 不参与意图路由：前缀已足够明确，多一条意图只会给分类器增加一个出错面
  intents: [],
  match: (ctx) => parseFreeformCommand(ctx.text).hit,
  handle: async (ctx) => {
    const { body } = parseFreeformCommand(ctx.text);
    // 追问不占配额：只发了前缀的人还没触发任何 LLM 或查询
    if (!body) {
      return ctx.reply(
        [
          '想查什么数据？直接用大白话问就行，例如：',
          '  帮我查数据: 上周新增用户里有多少下单了',
          '  帮我查数据: 这个月按渠道分组看看订单量',
          '  帮我查数据: 分享功能最近 7 天的点击趋势',
        ].join('\n'),
      );
    }

    const userId = ctx.user?.id || ctx.sessionKey || 'anonymous';
    const nowMs = Date.now();
    const verdict = checkThrottle({ lastAtMs: lastRunAt.get(userId), running, now: nowMs });
    if (!verdict.ok) {
      logger.info('tracking-stats', '自由形查询被限流', { userId, reason: verdict.reason, running });
      return ctx.reply(buildThrottleReply(verdict, MAX_CONCURRENT));
    }

    if (lastRunAt.size > SWEEP_THRESHOLD) {
      for (const k of collectExpired(lastRunAt.entries(), nowMs)) lastRunAt.delete(k);
    }
    lastRunAt.set(userId, nowMs);
    running += 1;

    // 即时应答不 await（同 feature.js：发送失败不该中断分析流程）
    ctx
      .reply('🔍 收到，正在看数据…（要探表结构 + 多轮查询，约 1~5 分钟，完成后在此回报）')
      .catch((e) => logger.warn('tracking-stats', '即时应答发送失败', { err: e?.message || String(e) }));

    // 异步执行：未被局部 catch 的异常在这里兜底回告，绝不静默；
    // 并发计数必须在 finally 归还，否则一次异常就永久占掉一个名额。
    runAnalysis(ctx, body)
      .catch(async (e) => {
        logger.error('tracking-stats', '自由形分析失败', { err: e?.message || String(e) });
        await ctx
          .reply(buildFreeformFailureReply(e?.kind || 'error', e?.message))
          .catch((e2) => logger.error('tracking-stats', '失败回告也发送失败', { err: e2?.message || String(e2) }));
      })
      .finally(() => {
        running = Math.max(0, running - 1);
      });
  },
};

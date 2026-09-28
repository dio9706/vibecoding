/**
 * 同事对话 agent 的编排层 —— 把「一条同事消息」变成「一轮 agent 对话 + 一条回复」。
 *
 * **只在 web 进程跑。** 工具的 handler 要调 `entrypoints/web/requirement-ops.js` 的
 * `registerApiDoc` / `enqueueSystemTask`，那两个函数操作的是 web 进程内存里的需求泵与
 * busy 状态机；在 feishu 进程跑会拿到另一份实例，`start_dev_task` 入队后永远不被执行。
 *
 * 失败一律退化到 ACK（spec §8「任何失败都不会比现状更糟」）：同事手里至少有一句回执，
 * 入站消息已经由飞书进程落盘，主机在 web 端看得到原文。**最糟的失败形态是静默不回**，
 * 所以连「模型返回空文本」都走 ACK。
 */
import { logger } from '../../shared/logger.js';
import { getColleagues, ROLES } from '../../store/colleagues.js';
import { getRequirements } from '../../store/requirements.js';
import { getAgentSessionId, setAgentSessionId, appendTo } from '../../store/colleague-messages.js';
import { buildAgentMcpServer } from '../../capabilities/agent-tools.js';
import { runAgentTurn } from '../../capabilities/agent-session.js';
import { getActiveBot } from '../../store/settings.js';
import { sendTextToUser } from '../../integrations/lark.js';
import { buildSystemPrompt } from './prompt.js';
import { rateLimiter } from './rate-limit.js';

/** 三句固定话术。刻意分开：同事据此知道该等一下还是该改口 */
export const ACK_FALLBACK = '已收到，信息会同步发送给主机！';
export const ACK_BUSY = '已收到，我这边正忙，稍后回复你～';
export const ACK_RATE = '已收到，消息有点密，我按顺序处理，稍等一下～';

/** 喂进 prompt 的需求阶段。归档/废弃的是噪音，会让模型把陈年需求当成在做的 */
const LIVE_PHASES = new Set(['review', 'dev', 'test']);

/** 当前启用机器人的私聊发送凭证（照抄 task-notify.js#creds 的范式） */
function creds() {
  const bot = getActiveBot();
  return bot?.appId && bot?.appSecret ? { appId: bot.appId, appSecret: bot.appSecret } : null;
}

function roleLabelOf(roleId) {
  return ROLES.find((r) => r.id === roleId)?.label || roleId || '同事';
}

/**
 * 跑一轮同事对话。
 *
 * @param {{colleagueId:string, text:string, msgId?:string, files?:Array}} input
 * @param {object} [deps] 注入便于单测（真实依赖见默认值）
 * @returns {Promise<{ok:boolean, reason?:string, toolCount?:number}>} **不抛**
 */
export async function handleColleagueTurn(input, deps = {}) {
  const {
    getColleague = (id) => getColleagues().find((c) => c.id === id) || null,
    getRequirements: getReqs = getRequirements,
    getAgentSessionId: getSid = getAgentSessionId,
    setAgentSessionId: setSid = setAgentSessionId,
    appendTo: append = appendTo,
    buildServer = buildAgentMcpServer,
    runTurn = runAgentTurn,
    sendText = async (openId, text) => {
      const c = creds();
      if (!c) {
        // 这条路径一旦走到，同事那边就是彻底静默 —— 而静默正是本层最不能接受的失败形态。
        // 触发条件苛刻（飞书长连接用的是同一个 getActiveBot），但真发生时必须留下线索。
        logger.warn('colleague-agent', '飞书凭证不完整，回复无法送达', { openId });
        return;
      }
      await sendTextToUser(c, openId, text);
    },
    tryAcquire = (id) => rateLimiter.tryAcquire(id),
  } = deps;

  const { colleagueId, text = '', msgId = null, files = [] } = input || {};
  const colleague = getColleague(colleagueId);
  if (!colleague) {
    logger.warn('colleague-agent', '未知同事，放弃本轮', { colleagueId });
    return { ok: false, reason: 'unknown-colleague' };
  }
  // 没有 open_id 就没地方送回复，跑完也是白跑 —— 在花额度之前拦掉
  if (!colleague.feishuOpenId) {
    logger.warn('colleague-agent', '同事未填飞书 open_id，放弃本轮', { colleagueId });
    return { ok: false, reason: 'no-openid' };
  }

  const gate = tryAcquire(colleagueId);
  if (!gate.ok) {
    logger.info('colleague-agent', '限流，回 ACK 不起 agent', { colleagueId, reason: gate.reason });
    await sendText(colleague.feishuOpenId, gate.reason === 'busy' ? ACK_BUSY : ACK_RATE);
    return { ok: false, reason: gate.reason };
  }

  try {
    const requirements = getReqs().filter(
      (r) => LIVE_PHASES.has(r.phase) && (r.assignees || []).includes(colleagueId),
    );
    const systemPrompt = buildSystemPrompt({
      colleague,
      roleLabel: roleLabelOf(colleague.role),
      requirements,
    });

    // ctx 会被 Object.freeze 后闭包进每个 handler：工具靠它知道「这是谁、哪条消息」。
    // files 也放进 ctx（而不是塞进 userText）：register_api_doc 这类工具要按文件名
    // 反查磁盘路径时从这里取，路径**不经模型之手**——模型看不到、也编不出真实存在的路径。
    const { server, allowed, defs } = buildServer(colleague.role, {
      ctx: { colleagueId, role: colleague.role, msgId, files },
    });

    // 只把文件名喂进 userText，绝不给磁盘绝对路径：那是主机机器上的真实路径
    // （形如 C:\Users\...\data\uploads\xxx.md），念给模型等于把主机用户名、
    // 数据目录结构讲给对话另一头的公司同事听（同 get_api_doc「不给 path」的纪律）。
    // 工具要用路径时从 ctx.files 里按文件名反查，见上面 ctx 组装。
    const fileLine = files.length
      ? `\n\n[他同时发来了文件]\n` + files.map((f) => `- ${f.name || '(未命名)'}`).join('\n')
      : '';

    const r = await runTurn({
      userText: `${text}${fileLine}`,
      systemPrompt,
      server,
      allowed,
      sessionId: getSid(colleagueId) || undefined,
      logTag: `colleague:${colleagueId}`,
    });

    const reply = String(r?.text || '').trim();
    if (r?.reason || !reply) {
      // 退化到 ACK。入站消息早已落盘，主机在 web 端看得到，同事也有回执 —— 不比现状更糟
      logger.warn('colleague-agent', '本轮未产出回复，退化到 ACK', {
        colleagueId,
        reason: r?.reason || 'empty-text',
      });
      await sendText(colleague.feishuOpenId, ACK_FALLBACK);
      return { ok: false, reason: r?.reason || 'empty-text', toolCount: defs.length };
    }

    await sendText(colleague.feishuOpenId, reply);
    // 只落出站这一条：入站那条由飞书进程在触发前就落好了，这里再落一次就是重复
    append(colleagueId, {
      dir: 'out',
      text: reply,
      role: colleague.role,
      reqId: null, // 出站消息不打需求标签：它是对某条入站的回应，归属看那条
      toolTrace: r.toolTrace || [],
    });
    // sessionId 可能为 null（SDK 未回 init/result），runAgentTurn 已保留旧值，这里照写即可
    if (r.sessionId) setSid(colleagueId, r.sessionId);

    logger.info('colleague-agent', '一轮完成', {
      colleagueId,
      tools: (r.toolTrace || []).length,
      chars: reply.length,
    });
    return { ok: true, toolCount: defs.length };
  } catch (e) {
    // 绝不让异常穿回 HTTP 层：那会让飞书进程的 fire-and-forget 收到 500 且无人处理
    logger.warn('colleague-agent', '本轮异常（已捕获）', { colleagueId, err: e?.message || String(e) });
    try {
      await sendText(colleague.feishuOpenId, ACK_FALLBACK);
    } catch {
      /* 连 ACK 都发不出去就只能认了 */
    }
    return { ok: false, reason: 'error' };
  } finally {
    // 不放位的话全局并发闸会被永久占死，两条之后整个功能静默停摆
    gate.release();
  }
}

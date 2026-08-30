/**
 * feature: BUG 巡检与修复（\10001，可信提交人专属，飞书入口）。
 * 触发文案严格匹配（零 LLM）→ 等用户发多维表格 → Haiku 字段映射 → 筛「关于我的待处理 BUG」
 * → 逐条评审门（reviewTask 只读查证）→ 确认缺陷：写表「修复中」+ 建任务进自动开发管线 → 汇总回告。
 * 修复完成通知由 auto-dev replySource 天然送达触发会话；表格状态不回写（用户合并代码后自行修改）。
 * 会话为内存态（等表 10 分钟超时），与 task-triage 同范式。
 */
import {
  listBitableTables,
  listBitableFields,
  searchBitableRecords,
  updateBitableRecord,
  resolveWikiNodeObj,
} from '../../../integrations/lark.js';
import { runClassifierOnce } from '../../../capabilities/llm-classify.js';
import { reviewTask } from '../review/index.js';
import { requestAutoDevelop } from '../auto-dev/index.js';
import { createTask } from '../../../store/tasks.js';
import { getMyFeishuOpenId } from '../../../store/settings.js';
import { resolveTrustedOpenIds, isTrustedSubmitter } from '../../../shared/trusted-ids.js';
import { matchesExactTrigger } from '../trusted-trigger.js';
import { config } from '../../../shared/config.js';
import { logger } from '../../../shared/logger.js';
import {
  PATROL_TRIGGERS,
  isCancelText,
  parseBitableLink,
  buildFieldMappingPrompt,
  validateFieldMapping,
  primaryFieldName,
  buildStatusFilter,
  isAssignedToMe,
  recordTitle,
  buildRecordDetail,
  buildPatrolSummary,
} from './logic.js';

/** 等表会话：openId → { expiresAt }（TTL 对齐 material-pool 的 10 分钟） */
const SESSION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map();

/**
 * 该用户是否处于「等多维表格链接」状态（过期即清）。
 * 飞书入口据此绕过云文档材料摄取——否则 wiki 链接会被 docx 流程拦截吞掉，永远到不了这里。
 */
export function hasPatrolPending(openId) {
  const s = sessions.get(openId);
  if (!s) return false;
  if (Date.now() > s.expiresAt) {
    sessions.delete(openId);
    return false;
  }
  return true;
}

function isTrusted(ctx) {
  return isTrustedSubmitter(ctx, resolveTrustedOpenIds(getMyFeishuOpenId()));
}

/** Haiku 字段映射（自适应任意表结构，映射结果由 validateFieldMapping 硬校验） */
async function mapFields(fields) {
  return runClassifierOnce({
    prompt: buildFieldMappingPrompt(fields),
    model: config.intent.classifyModel,
    logTag: 'bug-patrol/field-map',
  });
}

/** 权限类错误的引导话术（对齐 docx 材料链路的提示风格） */
function permissionHint(e) {
  const msg = e?.message || String(e);
  const isPerm = /perm|forbidden|access|denied|91403|99991|1254/i.test(msg);
  return isPerm
    ? '（看起来是权限问题：请确认应用已开通「多维表格 bitable:app」权限并发布版本，且表格已对机器人可见——加为文档协作者或所在知识库可见）'
    : '';
}

/**
 * 巡检管线（异步执行，不阻塞 dispatch）。
 * 逐条评审串行：reviewTask 是重调用（读码查证 30s+），并行会互相争抢 token 池。
 */
async function runPatrol({ appToken, tableId, url, openId, chatId, chatType, reply }) {
  const summary = { mine: 0, fixed: [], rejected: [], failed: [], skippedTables: [] };
  const tables = tableId
    ? [{ tableId, name: '' }]
    : await listBitableTables(appToken);
  if (!tables.length) {
    await reply('该多维表格里没有数据表～');
    return;
  }
  for (const t of tables) {
    const tableLabel = t.name || t.tableId;
    let fields;
    try {
      fields = await listBitableFields(appToken, t.tableId);
    } catch (e) {
      summary.skippedTables.push({ name: tableLabel, reason: `读取字段失败：${e?.message || e}` });
      continue;
    }
    const mapping = await mapFields(fields);
    const v = validateFieldMapping(mapping, fields);
    if (!v.ok) {
      summary.skippedTables.push({ name: tableLabel, reason: v.error });
      logger.info('bug-patrol', '字段映射未通过，跳过数据表', { table: tableLabel, error: v.error, mapping });
      continue;
    }
    let records;
    try {
      records = await searchBitableRecords(appToken, t.tableId, {
        filter: buildStatusFilter(v.statusField, v.pendingValue),
      });
    } catch (e) {
      summary.skippedTables.push({ name: tableLabel, reason: `查记录失败：${e?.message || e}` });
      continue;
    }
    const mine = records.filter((r) => isAssignedToMe(r, v.assigneeField, openId));
    summary.mine += mine.length;
    logger.info('bug-patrol', '筛选完成', {
      table: tableLabel, pending: records.length, mine: mine.length,
      statusField: v.statusField, assigneeField: v.assigneeField,
    });

    const titleField = primaryFieldName(fields);
    for (const rec of mine) {
      const title = recordTitle(rec, titleField);
      const detail = buildRecordDetail(rec, { tableName: t.name, url });
      try {
        // 评审确认「是当前项目的 BUG 且确实是缺陷」；synthetic id 仅供判例库溯源
        const r = await reviewTask({ id: 'patrol_' + rec.record_id, type: 'bug', title, detail });
        if (r.verdict !== 'fix') {
          summary.rejected.push({ title, reason: r.reason });
          continue;
        }
        // 先写表再建任务：写表失败时不建任务（避免「修了但表上还是待处理」的反向不一致更难察觉）
        await updateBitableRecord(appToken, t.tableId, rec.record_id, { [v.statusField]: v.fixingValue });
        const task = createTask({
          type: 'bug',
          title: title.slice(0, 40),
          detail,
          source: { openId, via: 'feishu', chatId, chatType },
        });
        requestAutoDevelop(task.id, 'BUG 巡检确认，自动修复');
        summary.fixed.push({ title });
        logger.info('bug-patrol', '记录转自动修复', { recordId: rec.record_id, taskId: task.id, title });
      } catch (e) {
        summary.failed.push({ title, reason: (e?.message || String(e)).slice(0, 120) });
        logger.error('bug-patrol', '单条记录处理失败', { recordId: rec.record_id, err: e?.message || String(e) });
      }
    }
  }
  await reply(buildPatrolSummary(summary));
}

export default {
  name: 'bug-patrol',
  // any + match/hasPending 自带可信门禁：非可信人发触发文案不命中，自然落常规流程（不暴露功能存在）
  permission: 'any',
  intents: [],
  // 廉价判定在前（Map 查找 / 全等比较），isTrusted 要读设置，别让每条消息都付这个成本
  hasPending: (ctx) => hasPatrolPending(ctx.user.id) && isTrusted(ctx),
  match: (ctx) => matchesExactTrigger(ctx.text, PATROL_TRIGGERS) && isTrusted(ctx),
  handle: async (ctx) => {
    const openId = ctx.user.id;

    // A. 触发文案（首次触发或等表中重复触发都重置会话）
    if (matchesExactTrigger(ctx.text, PATROL_TRIGGERS)) {
      sessions.set(openId, { expiresAt: Date.now() + SESSION_TTL_MS });
      logger.info('bug-patrol', '进入等表状态', { openId });
      return ctx.reply('好的～请把要巡检的多维表格链接发我（/base/ 直链或 wiki 链接均可；10 分钟内有效，回复「取消」退出）。');
    }

    // B. 等表状态（hasPending 接管）
    if (isCancelText(ctx.text)) {
      sessions.delete(openId);
      return ctx.reply('已取消 BUG 巡检。');
    }
    const link = parseBitableLink(ctx.text);
    if (!link) {
      return ctx.reply('没识别出多维表格链接～请发 /base/ 直链或含多维表格的 wiki 链接（回复「取消」退出）。');
    }
    sessions.delete(openId); // 拿到链接即退出等待；巡检异步跑，不阻塞后续消息

    // wiki 链接换 app_token（obj_type 必须是 bitable）
    let appToken = link.kind === 'base' ? link.appToken : null;
    if (link.kind === 'wiki') {
      try {
        const node = await resolveWikiNodeObj(link.token);
        if (node?.objType !== 'bitable' || !node.objToken) {
          return ctx.reply('该 wiki 链接不是多维表格～请重新触发巡检并发多维表格链接。');
        }
        appToken = node.objToken;
      } catch (e) {
        logger.warn('bug-patrol', 'wiki 节点解析失败', { err: e?.message || String(e) });
        return ctx.reply(`读取该 wiki 链接失败：${e?.message || e}${permissionHint(e)}`);
      }
    }

    // 即时应答不 await（与 feedback 同理：发送失败不该中断巡检启动）
    ctx.reply('🔍 已收到表格，开始巡检…（逐条评审需要几分钟，完成后在此汇报）')
      .catch((e) => logger.warn('bug-patrol', '即时应答发送失败', { err: e?.message || String(e) }));

    const params = {
      appToken,
      tableId: link.tableId,
      url: link.url,
      openId,
      chatId: ctx.meta?.chatId || ctx.sessionKey,
      chatType: ctx.meta?.chatType || null,
      reply: ctx.reply,
    };
    // 异步执行：任何一层没被局部 catch 的异常都在这里兜底回告，绝不静默
    runPatrol(params).catch(async (e) => {
      logger.error('bug-patrol', '巡检失败', { err: e?.message || String(e) });
      await ctx
        .reply(`❌ 巡检失败：${(e?.message || String(e)).slice(0, 200)}${permissionHint(e)}`)
        .catch((e2) => logger.error('bug-patrol', '失败回告也发送失败', { err: e2?.message || String(e2) }));
    });
  },
};

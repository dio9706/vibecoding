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
  downloadBitableMedia,
  resolveWikiNodeObj,
} from '../../../integrations/lark.js';
import { appDataPath } from '../../../shared/app-paths.js';
import { runClassifierOnce } from '../../../capabilities/llm-classify.js';
import { reviewTask } from '../review/index.js';
import { requestAutoDevelop } from '../auto-dev/queue.js';
import { createTask } from '../../../store/tasks.js';
import { getMyFeishuOpenId, getActiveBot } from '../../../store/settings.js';
import { getRequirement, getRequirements } from '../../../store/requirements.js';
import { getColleagues } from '../../../store/colleagues.js';
import { readLoop, markSeen, pushCycleTask, pushReport } from '../../../store/patrol-loop.js';
import { resolveTrustedOpenIds, isTrustedSubmitter } from '../../../shared/trusted-ids.js';
import { atPrefix } from '../../../shared/mention.js';
import { matchesExactTrigger } from '../trusted-trigger.js';
import { config } from '../../../shared/config.js';
import { logger } from '../../../shared/logger.js';
import { reviewSideWithTimeout } from './side-review.js';
import { resolveBackendAssignees, buildAssigneePatch } from './side-review.logic.js';
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
  collectImageAttachments,
  filterUnseen,
  parseReqChoice,
  buildStartReply,
  buildReqChoicePrompt,
} from './logic.js';

/**
 * 等待态会话：openId → { expiresAt, stage, link?, reqs? }
 *   stage='link' 等多维表格链接；stage='req' 等用户回需求序号。
 * 两个 stage 共用同一个 10 分钟 TTL（对齐 material-pool）与同一个「取消」出口。
 */
const SESSION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map();

/**
 * 截图落盘目录。按 fileToken 命名（见 downloadBitableMedia），同一张图在多轮巡检里
 * 会覆盖写同一个文件——循环 12 小时也不会无限堆积，且重复下载的成本只有一次网络往返。
 */
const PATROL_MEDIA_DIR = appDataPath('.uploads', 'patrol-media');

/**
 * 该用户是否处于等待态（过期即清）。
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
 * 单轮巡检（由 loop.js 的泵调用；\10001 只负责启动循环，不再直接调它）。
 *
 * 与循环化改造前的三处差异：
 *  1. 多一道 filterUnseen 成本护栏——驳回过的记录不重复评审（12 小时里这是主要额度消耗源）；
 *  2. verdict==='fix' 且关联了测试期需求时，走前后端归属判定；backend 转派、其余自动修；
 *  3. 不再自己发汇总——汇总由泵在「本轮任务全终结」后统一发（那时才拿得到分支名与成败）。
 *
 * 逐条评审仍是串行：reviewTask 是重调用（读码查证 30s+），并行会互相争抢 token 池。
 *
 * @returns {{ mine:number, skippedTables:Array }} 供泵记日志；处理结果直接写进 store 的 report
 */
export async function runPatrolRound({ appToken, tableId, url, openId, chatId, chatType, reqId }) {
  const summary = { mine: 0, skippedTables: [] };
  const loop = readLoop();
  const req = reqId ? getRequirement(reqId) : null;
  const frontendDir = req?.projects?.frontend?.dir || null;
  const backendDir = req?.projects?.backend?.dir || null;

  const tables = tableId ? [{ tableId, name: '' }] : await listBitableTables(appToken);
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
    // 先按人筛（服务端 filter 只管状态），再过成本护栏
    const assigned = records.filter((r) => isAssignedToMe(r, v.assigneeField, openId));
    const mine = filterUnseen(assigned, loop.seen);
    summary.mine += mine.length;
    logger.info('bug-patrol', '筛选完成', {
      table: tableLabel,
      pending: records.length,
      assigned: assigned.length,
      fresh: mine.length,
      statusField: v.statusField,
      assigneeField: v.assigneeField,
    });

    const titleField = primaryFieldName(fields);
    for (const rec of mine) {
      const title = recordTitle(rec, titleField);
      // 先把截图落到本地：测试提的 BUG 描述普遍只有一句话，判断依据大半在图里。
      // 下载失败不阻断（downloadBitableMedia 内部吞错回 null），退化成原来的纯文本判断。
      const images = await downloadRecordImages(rec);
      const detail = buildRecordDetail(rec, { tableName: t.name, url, images });
      try {
        // 评审确认「是当前项目的 BUG 且确实是缺陷」；synthetic id 仅供判例库溯源
        const r = await reviewTask({ id: 'patrol_' + rec.record_id, type: 'bug', title, detail });

        // 评审门只查前端工程，所以「不属于本工程」的判决是对的——但它可能正是一条**后端**
        // BUG（2026-09-18 实测：一条「描述主题不清晰」在前端全仓零命中判 reject，实际那段
        // 文案由后端 growth_foresight 的 LLM prompt 生成）。reject 之后必须再问一句
        // 「那属于谁」，是后端就转派出去，不能当噪音丢掉。
        //
        // ask 刻意不走这条：它 belongs=true，确实是前端的活，只是信息不足定位不了，
        // 转给后端没有意义，只会平白打扰人。
        const canJudgeSide = reqId && frontendDir && backendDir;
        if (r.verdict !== 'fix') {
          if (r.verdict === 'reject' && canJudgeSide) {
            const sr = await reviewSideWithTimeout({ title, detail }, { frontendDir, backendDir });
            if (sr.side === 'backend') {
              await handoffToBackend({
                appToken, tableId: t.tableId, record: rec, assigneeField: v.assigneeField,
                openId, req, title, advice: sr.advice, chatType,
              });
              markSeen(rec.record_id, { verdict: 'reject', side: 'backend' });
              continue;
            }
          }
          markSeen(rec.record_id, { verdict: r.verdict });
          continue;
        }

        // 归属判定 + 缺图判定。两条路径都跑，区别只在问得多深：
        //  - 关联需求且前后端目录齐备 → 完整判定（前后端归属 + 缺图）
        //  - 否则 → 精简判定（只问缺图）。前后端归属在只有一个工程目录时本就判不了，
        //    但缺图照样要拦——否则 AI 会拿占位图硬做一版 UI 出来（用户拍板：补这条路径保证全覆盖）
        let side = 'frontend';
        let advice = '';
        let blocked = '';
        let blockReason = '';
        if (canJudgeSide) {
          const sr = await reviewSideWithTimeout({ title, detail }, { frontendDir, backendDir });
          side = sr.side;
          advice = sr.advice;
          blocked = sr.blocked;
          blockReason = sr.blockReason;
        } else {
          const dir = frontendDir || getActiveBot()?.projectDir || config.feedback.frontendDir;
          const sr = await reviewSideWithTimeout({ title, detail }, { frontendDir: dir }, { assetOnly: true });
          blocked = sr.blocked;
          blockReason = sr.blockReason;
        }

        if (side === 'backend') {
          await handoffToBackend({
            appToken,
            tableId: t.tableId,
            record: rec,
            assigneeField: v.assigneeField,
            openId,
            req,
            title,
            advice,
            chatType,
          });
          markSeen(rec.record_id, { verdict: 'fix', side: 'backend' });
          continue;
        }

        // 缺图：AI 修不了（只会编占位资源）。不写表、不建任务——记录保持「待处理 + 指派给我」，
        // 本轮汇报里单列一组让人自己认领。记 seen 是为了不在 12 小时里反复烧同一条的评审额度
        // （用户拍板；补完图想让它修，在面板或飞书重新发一条即可）。
        if (blocked === 'need-assets') {
          markSeen(rec.record_id, { verdict: 'fix', side, blocked: 'need-assets' });
          pushReport('needHuman', { title, reason: blockReason });
          logger.info('bug-patrol', '记录缺少图片资源，转人工', { recordId: rec.record_id, title, reason: blockReason });
          continue;
        }

        // frontend / unknown：先写表再建任务——写表失败就不建任务
        // （「修了但表上还是待处理」这种反向不一致更难察觉）
        await updateBitableRecord(appToken, t.tableId, rec.record_id, { [v.statusField]: v.fixingValue });
        const task = createTask({
          type: 'bug',
          title: title.slice(0, 40),
          detail,
          source: { openId, via: 'feishu', chatId, chatType },
        });
        requestAutoDevelop(task.id, 'BUG 巡检确认，自动修复');
        pushCycleTask(task.id);
        markSeen(rec.record_id, { verdict: 'fix', side });
        // 分支名此刻还不存在（auto-dev 建分支在后），留空由泵结算时回填
        pushReport(side === 'unknown' ? 'unknown' : 'fixed', { title, taskId: task.id, branch: '' });
        logger.info('bug-patrol', '记录转自动修复', { recordId: rec.record_id, taskId: task.id, side, title });
      } catch (e) {
        const reason = (e?.message || String(e)).slice(0, 120);
        // 记 seen 防下一轮反复在同一条上失败
        markSeen(rec.record_id, { verdict: 'error' });
        pushReport('failed', { title, reason });
        logger.error('bug-patrol', '单条记录处理失败', { recordId: rec.record_id, err: reason });
      }
    }
  }
  return summary;
}

/**
 * 下载记录里的截图，返回给 buildRecordDetail 用的 [{field, path}]。
 *
 * 串行下载：一条记录通常只有 1~2 张图，并发的收益还不如多一层错误处理的复杂度。
 * 单张失败只跳过那张（downloadBitableMedia 内部已吞错回 null），绝不让整条记录失败——
 * 看不到图最多判得保守一点（落 ask/unknown），而抛错会让这条 BUG 直接进 failed。
 */
async function downloadRecordImages(record) {
  const out = [];
  for (const att of collectImageAttachments(record)) {
    const p = await downloadBitableMedia(att.fileToken, att.name, PATROL_MEDIA_DIR);
    if (p) out.push({ field: att.field, path: p });
  }
  return out;
}

/**
 * 转派后端：人员字段「移除我 + 加后端」，**状态字段刻意不动**。
 *
 * 为什么不写状态：表结构不一定有「后端处理中」这类选项（Haiku 映射只保证状态/待处理/
 * 修复中三个值存在）。而归属筛选本就靠人员字段，把我摘掉后下一轮 isAssignedToMe 天然
 * 筛不到这条——人员字段同时充当了去重游标，语义还准确（这确实不再是我的活）。
 */
async function handoffToBackend({ appToken, tableId, record, assigneeField, openId, req, title, advice, chatType }) {
  // 需求里配了几位后端就同时转派/@ 几位（用户拍板）——挑一个代表会漏掉真正负责这块的人
  const backends = resolveBackendAssignees({
    assignees: req?.assignees || [],
    colleagues: getColleagues(),
  });
  const next = buildAssigneePatch(
    record?.fields?.[assigneeField],
    openId,
    backends.map((b) => b.openId),
  );
  await updateBitableRecord(appToken, tableId, record.record_id, { [assigneeField]: next });
  pushReport('handoff', {
    title,
    // 群聊拼真 <at> 标签，私聊降级为文字姓名（atPrefix 对 p2p 返回空串）
    to: backends.map((b) => atPrefix(b.openId, chatType) || `@${b.name}（后端） `).join(''),
    advice,
    demoted: !backends.length,
  });
  logger.info('bug-patrol', '记录转派后端', {
    recordId: record.record_id,
    to: backends.map((b) => b.name).join('、') || '(需求未配后端)',
  });
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
    const chatId = ctx.meta?.chatId || ctx.sessionKey;
    const chatType = ctx.meta?.chatType || null;

    // A. 触发文案（首次触发或等待中重复触发都重置会话）
    if (matchesExactTrigger(ctx.text, PATROL_TRIGGERS)) {
      sessions.set(openId, { expiresAt: Date.now() + SESSION_TTL_MS, stage: 'link' });
      logger.info('bug-patrol', '进入等表状态', { openId });
      return ctx.reply('好的～请把要巡检的多维表格链接发我（/base/ 直链或 wiki 链接均可；10 分钟内有效，回复「取消」退出）。');
    }

    // 「取消」对两个 stage 都生效
    if (isCancelText(ctx.text)) {
      sessions.delete(openId);
      return ctx.reply('已取消 BUG 巡检。');
    }

    const s = sessions.get(openId);

    // C. 选需求阶段（多个测试期需求时才会进这里）
    if (s?.stage === 'req') {
      const idx = parseReqChoice(ctx.text, s.reqs.length);
      if (idx === null) {
        return ctx.reply(`没看懂～请回复 1-${s.reqs.length} 之间的序号（回复「取消」退出）。`);
      }
      sessions.delete(openId);
      return launch(ctx, { ...s.link, openId, chatId, chatType }, s.reqs[idx]);
    }

    // B. 等表阶段（hasPending 接管）
    const link = parseBitableLink(ctx.text);
    if (!link) {
      return ctx.reply('没识别出多维表格链接～请发 /base/ 直链或含多维表格的 wiki 链接（回复「取消」退出）。');
    }

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

    // 关联测试期需求：0 个不做归属判定；1 个自动关联；多个让用户选
    const resolved = { appToken, tableId: link.tableId, url: link.url };
    const reqs = getRequirements().filter((r) => r.phase === 'test');
    if (reqs.length > 1) {
      sessions.set(openId, { expiresAt: Date.now() + SESSION_TTL_MS, stage: 'req', link: resolved, reqs });
      return ctx.reply(buildReqChoicePrompt(reqs));
    }
    sessions.delete(openId); // 拿到全部参数即退出等待；循环在 web 进程跑，不阻塞后续消息
    return launch(ctx, { ...resolved, openId, chatId, chatType }, reqs[0] || null);
  },
};

/**
 * 跨进程启动循环（泵在 web 进程，见 loop.js 文件头）。
 * 沿用 create-session / feishu-relay 的 postToWeb 范式：3s 超时 + 非 JSON 响应不抛穿。
 */
async function postStart(payload) {
  const url = `http://127.0.0.1:${config.web.port}/api/patrol/start`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    const data = await r.json().catch(() => ({}));
    // 单例冲突：告知启动人与时间，否则用户只看到「已有巡检」却不知道是谁开的
    if (r.status === 409) {
      const who = data.openId === payload.openId ? '你' : `另一位可信提交人（${String(data.openId || '').slice(-6)}）`;
      const when = data.startedAt ? new Date(data.startedAt).toLocaleString('zh-CN', { hour12: false }) : '未知时间';
      return { ok: false, error: `已有巡检在运行中（${who}于 ${when} 启动）。先发「\\10004 停止巡检」再重新开始。` };
    }
    if (!r.ok || data.ok === false) return { ok: false, error: data.error || `执行台返回 ${r.status}` };
    return { ok: true };
  } catch (e) {
    logger.warn('bug-patrol', '启动循环失败', { err: e?.message || String(e) });
    return { ok: false, error: '执行台未运行或无响应，稍后再试' };
  }
}

/** 启动循环并回执（需求名按 spec §4.1 回显） */
async function launch(ctx, payload, req) {
  const r = await postStart({ ...payload, reqId: req?.id || null });
  if (!r.ok) return ctx.reply(`⚠️ ${r.error}`);
  logger.info('bug-patrol', '循环启动成功', { openId: payload.openId, reqId: req?.id || null });
  return ctx.reply(buildStartReply(req?.title || null));
}

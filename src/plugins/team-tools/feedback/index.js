/**
 * feature: 需求 / 故障 记录（任何人提交，owner 用强前缀提交时 claude-exec 会让路）。
 * 意图确定后先发即时应答（ackBug/ackFeature，取代原「已收集」文案），让用户第一秒就有反馈。
 * owner / 可信提交人（唯一来源：基础设置的「我的飞书 open_id」，单人）：跳过评审与方案生成，
 *   直接进自动开发队列（不分托管等级）。
 * 轻度托管：即时应答 → 记 Task → 自动分析 → 补一句闭环回复（否则用户等不到任何后续）。
 * 中度/完全托管：先过 AI 评审门（review/）——
 *   reject/ask=发「坚持修改/算了」按钮卡片（非飞书或发卡失败降级纯文本），30 分钟内文本挽回同样有效；
 *   fix=BUG 进自动开发管线；plan=生成方案（中度等 owner 确认，完全托管直接自动开发）。
 */
import { createTask, getTask, getTasks, updateTask } from '../../../store/tasks.js';
import { systemNotify } from '../../../integrations/notify.js';
import { analyze, attachMaterialToRecentTask } from '../task-ops.js';
import { addMaterial, drainMaterials, saveTextMaterial, materialDetailLine } from '../material-pool.js';
import { reviewTask, recordOverride } from '../review/index.js';
import { requestAutoDevelop } from '../auto-dev/index.js';
import { getActiveBot, getMyFeishuOpenId } from '../../../store/settings.js';
import { logger } from '../../../shared/logger.js';
import { config } from '../../../shared/config.js';
import { msg } from '../../../shared/messages.js';
import { findReviewableTask, isReviewableTask, buildVerdictCard, verdictResultCard, parseVerdictCardAction, canOperateVerdict, resolveTrustedOpenIds } from './logic.js';
import { sendCard, updateCard, sendText } from '../../../integrations/lark.js';
import { atPrefix } from '../../../shared/mention.js';
import { registerCardKindHandler } from '../../../shared/card-actions.js';

// 评审否定应答关键词：仅「短回复且命中」才接管（否则放行正常分流）。
// 长文本极可能是新的需求/故障描述（如「登录页的按钮颜色要修改一下」），绝不能被劫持成对旧任务的应答。
const REPLY_MAX_LEN = 20;
const YES_RE = /坚持|继续修改|确认修改|照做|做吧|改吧|修吧|还是改/;
const NO_RE = /算了|不用了|取消|不改了|放弃/;

/** 强前缀命中但没带正文时的追问语（如用户只发了「提交需求」） */
const ASK_BODY = {
  bug: '好的，请把故障内容发我～ 例如「提交故障：扫码页白屏，安卓 13 必现」。',
  feature: '好的，请把需求内容发我～ 例如「提交需求：登录页加记住密码」。',
};

/** 文本是否是对评审质疑的明确应答（短回复 + 命中肯定/否定词） */
function isChallengeReply(text) {
  const t = (text || '').trim();
  return t.length > 0 && t.length <= REPLY_MAX_LEN && (YES_RE.test(t) || NO_RE.test(t));
}

/** 该用户同会话 30 分钟内被评审否定（质疑 challenged / 拒绝 rejected）的任务；谓词见 logic.findReviewableTask */
function pendingReviewable(ctx) {
  return findReviewableTask(getTasks(), {
    openId: ctx.user.id,
    chatId: ctx.meta?.chatId || ctx.sessionKey,
  });
}

/** 评审通过（或用户坚持）后的处置：BUG 自动修；需求出方案（完全托管直接开发） */
async function proceedAfterReview(task, ctx, { overridden = false } = {}) {
  const autonomy = getActiveBot()?.autonomy || 'light';
  if (task.type === 'bug') {
    requestAutoDevelop(task.id, overridden ? '用户坚持，转自动修复' : '评审通过，转自动修复');
    // 进度回复不 await：状态已翻转，发送失败（429/网络抖动）不该把异常抛给调用方
    ctx.reply(`🔧 已开始自动修复「${task.title}」，将在独立分支进行，完成后在此通知。`)
      .catch((e) => logger.warn('feedback', '评审后进度回复发送失败', { id: task.id, err: e?.message || String(e) }));
    return;
  }
  updateTask(task.id, { status: 'analyzing' }, overridden ? '用户坚持，生成方案' : '评审通过，生成方案');
  // 不 await：若发送失败会中断在 analyze 之前，任务将永久卡在 analyzing（无恢复路径）
  ctx.reply(
    autonomy === 'full'
      ? `📝 「${task.title}」正在生成方案，随后自动开发（独立分支，合并需管理员确认）。`
      : `📝 「${task.title}」正在生成方案，完成后待管理员确认再开发。`,
  ).catch((e) => logger.warn('feedback', '评审后进度回复发送失败', { id: task.id, err: e?.message || String(e) }));
  await analyze(task); // 完成后任务为 analyzed
  if (autonomy === 'full') requestAutoDevelop(task.id, '完全托管：方案完成，自动开发');
}

/** 评审否定结论送达：飞书发「坚持修改/算了」按钮卡片；非飞书渠道或发卡失败降级纯文本 */
async function replyVerdict(task, ctx, verdict, reason, fallbackText) {
  if (ctx.source === 'feishu' && task.source?.chatId) {
    try {
      await sendCard(task.source.chatId, buildVerdictCard(task, verdict, reason));
      return;
    } catch (e) {
      logger.warn('feedback', '评审卡片发送失败，降级纯文本', { id: task.id, err: e?.message || String(e) });
    }
  }
  await ctx.reply(fallbackText);
}

/** 中度/完全托管的评审流（异步，不阻塞收集回复）；任一环节异常 → 任务退回 new，绝不卡死在 reviewing */
async function runReviewFlow(taskId, ctx) {
  const task = updateTask(taskId, { status: 'reviewing' }, 'AI 评审中');
  try {
    const r = await reviewTask(task);
    const updated = updateTask(
      taskId,
      { review: { verdict: r.verdict, reason: r.reason, scores: r.scores } },
      `评审判决：${r.verdict}`,
    );
    const kind = task.type === 'bug' ? '故障' : '需求';
    if (r.verdict === 'reject') {
      updateTask(taskId, { status: 'rejected' }, '评审拒绝');
      // 纯文本降级文案补挽回指引（原文案无任何挽回入口，是「坚持修改」失效 bug 的一半根因）
      return await replyVerdict(updated, ctx, 'reject', r.reason,
        `❌ 该${kind}未通过评审，暂不处理：${r.reason}\n如仍需处理请回复「坚持修改」。`);
    }
    if (r.verdict === 'ask') {
      updateTask(taskId, { status: 'challenged' }, '评审存疑，等待用户确认');
      return await replyVerdict(updated, ctx, 'ask', r.reason,
        `🤔 关于这条${kind}，评审建议暂缓：${r.reason}\n如仍需处理请回复「坚持修改」；回复「算了」则取消。`);
    }
    return await proceedAfterReview(updated, ctx, { overridden: false });
  } catch (e) {
    updateTask(taskId, { status: 'new' }, '评审流程异常，退回待确认');
    throw e; // 交给调用方记日志
  }
}

/**
 * 「坚持修改/算了」卡片回调（kind: review-verdict）。
 * 无内存态：taskId 从按钮 value 来，任务状态从盘上读 → 机器人重启后旧卡片按钮仍有效；
 * 幂等靠任务状态：已不在可挽回态则只更新卡片提示，不重复处理。
 * 与文本挽回（A 段）收敛到同一套动作：recordOverride + proceedAfterReview / 置 rejected。
 */
async function onVerdictCardAction(data) {
  const parsed = parseVerdictCardAction(data);
  if (!parsed) return;
  const task = getTask(parsed.taskId);
  // 终态更新卡片；拿不到 messageId（报文形态异常）只能跳过更新，动作本身照常执行
  const done = (text) =>
    parsed.messageId
      ? updateCard(parsed.messageId, verdictResultCard(text)).catch((e) =>
          logger.warn('feedback', '评审卡片更新失败', { id: parsed.taskId, err: e?.message || String(e) }),
        )
      : Promise.resolve();
  if (!task) return done('⚠️ 任务不存在或已被清理。');
  if (
    !canOperateVerdict(parsed.operatorOpenId, task, {
      trustedOpenIds: resolveTrustedOpenIds(getMyFeishuOpenId()),
      ownerOpenIds: config.lark.ownerOpenIds,
    })
  ) {
    // 群聊卡片人人可见：非提交人/白名单/owner 点击一律忽略（不回文本，避免群噪音）
    logger.info('feedback', '非授权用户点击评审卡片，忽略', { id: task.id, operator: parsed.operatorOpenId });
    return;
  }
  if (!isReviewableTask(task)) {
    return done(`ℹ️「${task.title}」已在处理中或已完结，无需重复操作。`);
  }
  if (parsed.action === 'giveup') {
    if (task.status === 'challenged') updateTask(task.id, { status: 'rejected' }, '用户放弃（评审卡片）');
    logger.info('feedback', '用户放弃（评审卡片）', { id: task.id });
    return done(`🗑 已取消「${task.title}」。`);
  }
  // insist：与文本「坚持修改」同一套动作。
  // 先同步抢占状态再做任何 await：卡片回调并发触达（channel 不 await、双击常见），
  // 若「可挽回检查」与「状态翻转」之间隔着 updateCard 网络往返，第二次点击会重复走整套处理
  //（feature 双跑 analyze、完全托管下甚至冲掉 developing）。confirmed 是状态机既有合法态，
  // isReviewableTask 对其为 false → 并发点击/文本挽回一律落「已在处理中」幂等提示。
  updateTask(task.id, { status: 'confirmed' }, '用户坚持修改（评审卡片），已受理');
  recordOverride(task);
  logger.info('feedback', '用户坚持修改（评审卡片覆盖）', { id: task.id });
  await done(`✋ 已坚持修改「${task.title}」，转入处理。`);
  // 后续进度回复发回任务来源会话；群聊 @ 提交人（p2p 前缀为空串）
  const at = atPrefix(task.source?.openId, task.source?.chatType);
  const reply = (t) => sendText(task.source.chatId, at ? at + '\n' + t : String(t ?? ''));
  return proceedAfterReview(task, { reply }, { overridden: true });
}

// 模块加载即注册（feishu/web 进程都会加载插件；web 进程无卡片事件，注册无害）。
// team-tools 停用时本模块不加载 → 回调自然落空（入口仅记 warn 日志）。
registerCardKindHandler('review-verdict', onVerdictCardAction);

export default {
  name: 'feedback',
  // any 而非 guest：owner 用「提交需求：/提交故障：」强前缀提交时也要能进收集流程
  //（claude-exec 已对这两类前缀让路，见 features/claude-exec/logic.js）。谁提交都该被收集。
  permission: 'any',
  intents: ['bug', 'feature', 'material'],
  // 评审否定应答拦截：存在可挽回任务（质疑中/被拒 30 分钟内）且文本是明确的短应答才接管
  hasPending: (ctx) => isChallengeReply(ctx.text) && !!pendingReviewable(ctx),
  handle: async (ctx, intentResult) => {
    // A. 评审否定应答（hasPending 路径，intentResult=null）：challenged 质疑 + rejected 被拒都可挽回
    const pending = !intentResult && isChallengeReply(ctx.text) ? pendingReviewable(ctx) : null;
    if (pending) {
      // 交叠时 YES 优先（如「算了，还是改吧」按坚持处理）
      if (!YES_RE.test(ctx.text || '')) {
        // 已 rejected（评审拒绝 / 此前已「算了」）再说算了 → 幂等提示，不重复改状态
        if (pending.status === 'rejected') return ctx.reply(`「${pending.title}」已是取消状态，无需再操作～`);
        updateTask(pending.id, { status: 'rejected' }, '用户放弃（评审质疑后）');
        return ctx.reply(`好的，已取消「${pending.title}」。`);
      }
      recordOverride(pending); // 人工覆盖 → 判例库，校准后续评审
      logger.info('feedback', '用户坚持修改（覆盖评审）', { id: pending.id });
      return proceedAfterReview(pending, ctx, { overridden: true });
    }

    // A2. 纯材料消息（长文本文档等）：先试挂近期任务，挂不上入池等待下一条文字立案
    if (intentResult?.intent === 'material') {
      const title = (ctx.text || '').trim().replace(/\s+/g, ' ').slice(0, 30);
      const path = saveTextMaterial(title, ctx.text || '');
      const material = { kind: 'text', path, title };
      const attached = attachMaterialToRecentTask(ctx.user.id, material);
      if (attached) return ctx.reply(`📎 已把材料补充到「${attached.title}」，会结合材料一并处理。`);
      addMaterial(ctx.user.id, ctx.meta?.chatId || ctx.sessionKey, material);
      logger.info('feedback', '材料入池', { openId: ctx.user.id, title });
      return ctx.reply(msg('materialAck'));
    }

    // B. 正常收集
    const type = intentResult?.intent === 'bug' ? 'bug' : 'feature';
    const tag = type === 'bug' ? '[故障]' : '[需求]';

    // 强前缀命中但没带正文（只发了「提交需求」）→ 追问，不建任务、不起 Claude。
    // 判据直接取 classify() 的契约字段：strong=true 表示 L1 强前缀命中，body 是剥掉前缀后的正文；
    // L3 语义分类 strong=false 且 body 恒为空串（原文非空），所以必须两个条件同时满足才算「只发了前缀」。
    // 不要在这里重跑 matchStrongIntent：正则已在 classify() 里跑过一遍，重复跑既浪费又容易两处判定漂移。
    const body = (intentResult?.body ?? '').trim();
    const prefixOnly = !body && intentResult?.strong === true;
    if (prefixOnly) {
      logger.info('feedback', '强前缀无正文 → 追问内容', { type, openId: ctx.user.id });
      return ctx.reply(ASK_BODY[type]);
    }

    // 即时应答：意图确定后的第一条回复（取代原「已收集」文案，让用户第一秒就有反馈）。
    // 绝不能 await：发送失败不该导致需求丢失 —— reply 链路（channel.send → lark.sendText）失败是抛错的，
    // 飞书 429 限流或网络抖动时 await 会让 handle 在 createTask 之前中断，tasks.json 无记录、用户零回复，需求静默蒸发。
    // 不 await 也仍是首个发出的动作（同步进入发送队列），用户体验不变。
    ctx.reply(msg(type === 'bug' ? 'ackBug' : 'ackFeature'))
      .catch((e) => logger.warn('feedback', '即时应答发送失败（不阻塞建任务）', { err: e?.message || String(e) }));

    const task = createTask({
      type,
      // title 用剥掉「提交需求：」前缀的正文（更干净）；detail 保留原文全文（不丢上下文）
      title: (body || ctx.text || '').slice(0, 40),
      detail: ctx.text || '',
      source: {
        openId: ctx.user.id,
        via: ctx.source,
        chatId: ctx.meta?.chatId || ctx.sessionKey,
        chatType: ctx.meta?.chatType || null, // 群聊异步通知要据此决定是否 @ 提交人
      },
    });

    // 吸附待归属材料（先发文件后发描述的归并出口）
    const mats = drainMaterials(ctx.user.id, ctx.meta?.chatId || ctx.sessionKey);
    const withMats = mats.length
      ? updateTask(task.id, { detail: `${task.detail}\n${mats.map(materialDetailLine).join('\n')}` }, `吸附材料 ${mats.length} 份`)
      : task;

    logger.info('feedback', '收集到反馈', { id: withMats.id, type, title: withMats.title, openId: ctx.user.id });
    systemNotify(`新${type === 'bug' ? '故障' : '需求'} ${tag}`, (ctx.text || '').slice(0, 80));

    const autonomy = getActiveBot()?.autonomy || 'light';
    const matsNote = mats.length ? `（已带上材料 ${mats.length} 份）` : '';

    // owner 与可信提交人（唯一来源：基础设置的「我的飞书 open_id」；env TRUSTED_OPEN_IDS 已废弃不读）直通：不判断合理性，
    // 跳过评审门与方案生成，直接进自动开发队列（独立任务分支改码，泵在 web 进程常驻；
    // 合并仍需管理员确认）。不分托管等级——「本人提的」本就不需要 AI 替我判断该不该做。
    const trusted = resolveTrustedOpenIds(getMyFeishuOpenId());
    if (ctx.user.role === 'owner' || trusted.includes(ctx.user.id)) {
      requestAutoDevelop(withMats.id, '可信提交人直通，自动开发');
      logger.info('feedback', '可信提交人直通 → 自动开发', { id: withMats.id, openId: ctx.user.id });
      // 回复自带 catch：任务已入队，发送失败只记日志，不让异常冒泡误报成「处理失败」
      return ctx.reply(`✅ 已直接进入自动开发（独立分支，完成后通知你确认合并）。${matsNote}`)
        .catch((e) => logger.warn('feedback', '直通回复发送失败', { id: withMats.id, err: e?.message || String(e) }));
    }

    if (autonomy === 'light') {
      // 轻度托管：即时应答已发，这里不再重复确认；分析完成后补一句闭环回复（否则用户等不到任何后续）。
      // 回复自带 catch：否则「回复失败」会顺着链条落进外层 catch 被误报成「分析失败」，排障时找错方向。
      analyze(withMats)
        .then(() =>
          ctx
            .reply(`📋「${withMats.title}」已记录并初步分析完成，等管理员确认后处理。${matsNote}`)
            .catch((e) => logger.warn('feedback', '闭环回复发送失败', { id: withMats.id, err: e?.message || String(e) })),
        )
        .catch((e) => logger.error('feedback', '分析失败', { id: withMats.id, err: e?.message || String(e) }));
      return;
    }
    // 中度/完全托管：即时应答已发，评审结论由 runReviewFlow 回复
    runReviewFlow(withMats.id, ctx).catch((e) =>
      logger.error('feedback', '评审流失败', { id: withMats.id, err: e?.message || String(e) }),
    );
  },
};

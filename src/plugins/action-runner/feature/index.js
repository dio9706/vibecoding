/**
 * feature: 通用动作执行器（action-runner）—— 取代硬编码的 data-cleanup。
 * 意图 action（由 classify 命中某条 ActionConfig）→ 槽位填充（提取变量 + 追问缺失）
 * → 调用脚本执行 → 回复结果。状态机：单用户单条 pendingState。
 *
 * 追问只做「有进展才继续」（事故驱动，勿放宽）：
 * dispatch 第 0 步只要 hasPending 为真就无条件劫持该用户**全部**消息、跳过意图识别，
 * 而旧 pendingState 既无轮次上限也无超时，只有打「取消」能退出 —— 用户缺个字段被追问后，
 * 再问任何别的问题都被当成在补字段，机器人反复追问同一句，功能等于卡死。
 * 现规则：追问后的这一轮若一个必填字段都没补上，立刻清状态 + 回一句「已结束」，
 * 并返回 PASS 把这条消息交回 dispatch 走常规意图识别（该答问题答问题）。
 */
import { getConfig as getConfigDefault } from '../../../store/action-configs.js';
import { setVar } from '../../../store/user-vars.js';
import { extractVars, pickMissingVars } from './slot-filler.js';
import { runAction, describeTarget } from './script-runner.js';
import { canRunAction } from './permission.js';
import { logger } from '../../../shared/logger.js';
import { msg } from '../../../shared/messages.js';
import { PASS } from '../../../app/signals.js';

// pendingState: userId(open_id) → { actionId, collected: {...}, waitingFor: varName, ts: number,
//                                    extracting?: boolean, inbox?: string[],
//                                    learnSrc?: { text: string } | null }
const pendingState = new Map();

/**
 * 追问中间态存活时长。与「一轮无进展即结束」互补：那条规则要等用户**再发一条**才触发，
 * 用户中途离开时状态会一直挂着，几小时后回来发的第一句无关消息仍会被当成补字段。
 */
export const PENDING_TTL_MS = 5 * 60 * 1000;

/** 取该用户的中间态；已过期的顺手清掉（读即剪枝，避免 Map 里堆死状态） */
function getPending(userId, now = Date.now()) {
  const p = pendingState.get(userId);
  if (!p) return null;
  if (now - p.ts > PENDING_TTL_MS) {
    pendingState.delete(userId);
    logger.info('action-runner', '追问中间态超时，已丢弃', { userId, actionId: p.actionId });
    return null;
  }
  return p;
}

/** 写入/刷新中间态（ts 每轮刷新：用户在正常互动就不该被超时打断） */
function setPending(userId, entry) {
  const prev = pendingState.get(userId);
  // learnSrc 只在 proceedWithAction 首轮写一次，此后靠这里在追问链上透传。
  // 不透传的话，走到 executeAction 时手里只剩最后一条补槽位的回答（「test」），
  // 而关键词要学的是**触发那句话**。在这里继承，比让 4 个调用点各自记得带一次可靠。
  // 不变式：三个调用点的 prev 都是新鲜的 —— handle 入口处刚做过 getPending（带 TTL 剪枝），
  // 两个追问路径的 prev 就是本轮 getPending 拿到的那条。新增调用点前请先确认这条仍成立。
  const learnSrc = entry.learnSrc !== undefined ? entry.learnSrc : (prev?.learnSrc ?? null);
  pendingState.set(userId, { ...entry, learnSrc, ts: Date.now() });
}

/** 检查该用户是否有未完成的交互（在追问中间态）。now 可注入，便于测超时。 */
export function hasPending(ctx, now = Date.now()) {
  return !!getPending(ctx.user.id, now);
}

/** 默认依赖；测试通过第三参注入替身（不联网、不写盘） */
const DEFAULT_DEPS = { getConfig: getConfigDefault, extract: extractVars, run: runAction, saveVar: setVar };

/**
 * 主处理流程
 * - 追问中间态：处理用户回复 → 继续追问 / 执行 / 放弃接管（PASS）
 * - 新请求：intentResult.actionId 指定动作 → 开始槽位填充
 * @returns {Promise<any|typeof PASS>} PASS = 这条消息不是给我的，请 dispatch 继续常规分发
 */
export async function handle(ctx, intentResult, deps = DEFAULT_DEPS) {
  const { getConfig } = deps;
  const userId = ctx.user.id;
  const text = (ctx.text || '').trim();

  // 取消
  if (/^(取消|cancel)$/i.test(text)) {
    pendingState.delete(userId);
    return ctx.reply('已取消。');
  }

  // 追问中间态 → 处理用户回复
  const pending = getPending(userId);
  if (pending) {
    return handlePendingResponse(ctx, pending, text, deps);
  }

  // 新请求 → actionId 由 intent.actionId 指定
  const actionId = intentResult?.actionId;
  if (!actionId) {
    logger.error('action-runner', '缺少 actionId', { userId });
    return ctx.reply('发生错误，无法匹配动作。');
  }

  const actionConfig = getConfig(actionId);
  if (!actionConfig) {
    logger.error('action-runner', '动作配置不存在', { actionId });
    return ctx.reply('动作不存在或已禁用。');
  }

  // 权限闸门：ActionConfig.permission 曾是死字段，任意员工一句含关键词的话即可触发
  // 破坏性脚本。必须在进入槽位填充**之前**拦——否则会先追问变量再拒绝，等于泄露动作存在性。
  if (!canRunAction(actionConfig, ctx.user?.role)) {
    logger.warn('action-runner', '权限不足，拒绝执行', {
      actionId,
      actionName: actionConfig.name,
      userId,
      role: ctx.user?.role,
      required: actionConfig.permission,
    });
    return ctx.reply('你没有执行该操作的权限。');
  }

  // via==='llm' 才带触发原句下去：只有 L3 兜底认出来的动作值得学关键词，
  // L2 命中的本来就零成本，卡片按钮入口（card-action.js）更是压根不经过意图识别。
  return proceedWithAction(ctx, actionConfig, deps, intentResult?.via === 'llm' ? text : null);
}

/**
 * 即时应答 —— **只在真的要等模型时才发**，由 slot-filler 的 `onLlmStart` 回调驱动。
 *
 * 判据从「这个动作有必填变量」改成「这一次确实发起了 LLM 调用」（2026-09-04）：
 * 变量抽取契约上线后，声明了 enum/pattern 的变量在本地亚毫秒抽完，绝大多数请求根本不碰模型。
 * 仍按老判据发的话，用户会先收到「请稍等，我正在确认执行这个操作所需的信息！」，
 * 紧接着立刻收到「⏳ 正在执行…」—— 两条挨在一起，反而像卡了一下。
 * 现在这条文案只在真有 8~17s 等待时出现，它本来就是为那段静默准备的。
 *
 * 绝不 await（与 feedback / bug-patrol 同款）：飞书限流会让 reply 抛错，
 * 而这条只是「让用户知道消息收到了」的锦上添花，不该把整个动作带崩。
 * ctx.reply 可能同步抛也可能返回 rejected promise，两条路径都要吞。
 */
function sendAck(ctx) {
  const swallow = (e) =>
    logger.warn('action-runner', '即时应答发送失败（不阻塞动作）', { err: e?.message || String(e) });
  try {
    const p = ctx.reply(msg('ackAction'));
    if (p && typeof p.catch === 'function') p.catch(swallow);
  } catch (e) {
    swallow(e);
  }
}

/** 开始某个动作的槽位填充（新请求首轮） */
async function proceedWithAction(ctx, actionConfig, deps, learnText = null) {
  const userId = ctx.user.id;
  const text = ctx.text || '';

  // ⚠️ 占位必须写在**发起抽取之前**（事故驱动，勿挪到 await 之后）。
  // 旧实现把 setPending 放在抽取结束后，于是抽取那 8~17s 里 hasPending 一直为 false：
  // 用户等不及先答了「test环境」，这条消息绕过本 feature 走常规意图识别 → 判 other →
  // 回一张「没有识别到你的意图」帮助卡，随后首轮才姗姗来迟地追问同一个字段
  //（实证 app-2026-09-01.log:231-255）。占位后窗口内的消息由 handlePendingResponse 收进 inbox。
  setPending(userId, {
    actionId: actionConfig.id,
    collected: {},
    waitingFor: null,
    extracting: true,
    inbox: [],
    learnSrc: learnText ? { text: learnText } : null,
  });

  try {
    // 从消息提取变量 + 合并持久化。
    // 即时应答交给 onLlmStart：只有真要等模型（8~17s）才发，本地抽完就直接执行，不弹噪音。
    // 追问轮（handlePendingResponse）一律不发 —— 用户刚回答完，下一条马上就到。
    const extracted = await deps.extract(actionConfig, text, userId, { onLlmStart: () => sendAck(ctx) });

    // 抽取那 8~17s 里用户可能已经打了「取消」（cancel 分支在 handle 开头，先于 getPending，
    // 会把占位删掉）。占位不在了 = 这次动作已被放弃，绝不能照常往下执行 ——
    // 破坏性脚本（清数据 / 退款）在用户明确喊停后仍然跑起来是不可接受的。
    if (!pendingState.has(userId)) {
      logger.info('action-runner', '抽取期间动作已被取消，放弃执行', { actionId: actionConfig.id, userId });
      return;
    }

    const collected = await mergeQueuedAnswers(userId, actionConfig, extracted, deps);
    const missing = pickMissingVars(actionConfig, collected);

    if (missing.length > 0) {
      // 保存到 pendingState 并追问第一个缺失变量
      const first = missing[0];
      setPending(userId, { actionId: actionConfig.id, collected, waitingFor: first.name });
      return ctx.reply(first.prompt || `请提供 ${first.label || first.name}`);
    }

    // 所有必填变量已收集 → 执行脚本
    // 直接用手里的 learnText，不要去读 pendingState —— 慢抽取那 8~17s 里，
    // 用户可能已经取消本动作、又触发了另一个动作并写进同一个 userId key，
    // 那时 Map 里躺着的是**别人的**原句。学错原句的后果是永久的（错词进关键词表，
    // 此后零模型介入直接误触发），比一次误执行严重得多。
    const learnSrc = learnText ? { text: learnText } : null;
    pendingState.delete(userId);
    return executeAction(ctx, actionConfig, collected, deps, learnSrc);
  } catch (e) {
    pendingState.delete(userId);
    logger.error('action-runner', '槽位填充异常', { actionId: actionConfig.id, err: e?.message });
    return ctx.reply('处理请求时出错，请重试。');
  }
}

/**
 * 并入竞态窗口内用户「抢答」的消息。
 *
 * 只在真的有抢答时才多跑一次抽取 —— 正常路径（inbox 空）零额外成本。
 * 抢答文本按「这就是对第一个缺失字段的回答」处理（forVar），用户只回「体验」两个字也能认出来。
 */
async function mergeQueuedAnswers(userId, actionConfig, extracted, deps) {
  const queued = pendingState.get(userId)?.inbox || [];
  if (!queued.length) return extracted;

  // 必填已经齐了 —— 抢答说的是别的事（「哦对了」「顺便问下」），与本次执行无关。
  // 这里若不早退就会白烧一次 LLM 抽取，还可能把无关内容覆盖进已抽好的变量。
  const missingNow = pickMissingVars(actionConfig, extracted);
  if (!missingNow.length) return extracted;

  const forVar = missingNow[0]?.name;
  logger.info('action-runner', '并入抽取窗口内的抢答消息', {
    actionId: actionConfig.id,
    userId,
    count: queued.length,
    forVar: forVar || null,
  });
  const more = await deps.extract(actionConfig, queued.join('\n'), null, forVar ? { forVar } : {});
  return { ...extracted, ...more };
}

/** 处理用户在追问中间态的回复 */
async function handlePendingResponse(ctx, pending, text, deps) {
  const userId = ctx.user.id;
  const actionConfig = deps.getConfig(pending.actionId);

  if (!actionConfig) {
    pendingState.delete(userId);
    return ctx.reply('动作不存在或已禁用。');
  }

  // 首轮抽取还在跑（竞态窗口）：这条是用户抢答，收进 inbox 交给 mergeQueuedAnswers，
  // 此处**不回话** —— 首轮马上就要给出追问或执行结果，再插一句只会变成两轮自问自答。
  if (pending.extracting) {
    pending.inbox.push(text);
    logger.info('action-runner', '抽取窗口内收到抢答，已暂存', { actionId: actionConfig.id, userId });
    return;
  }

  // 追问中间态也要复检：pendingState 可能跨越管理员收紧权限的时刻，
  // 只在入口拦一次会让「已在追问中」的用户绕过新权限设置。
  if (!canRunAction(actionConfig, ctx.user?.role)) {
    pendingState.delete(userId);
    logger.warn('action-runner', '权限不足，中断追问中的动作', {
      actionId: actionConfig.id,
      userId,
      role: ctx.user?.role,
    });
    return ctx.reply('你没有执行该操作的权限。');
  }

  try {
    // 提取这次回复的变量（不复用持久化查询，用户新输入优先）。
    // forVar 告诉抽取层「现在在等哪个字段」，用户只回「体验」两个字也能认出来。
    const extracted = await deps.extract(actionConfig, text, null, { forVar: pending.waitingFor });
    const collected = { ...pending.collected, ...extracted };

    const missingBefore = pickMissingVars(actionConfig, pending.collected);
    const missing = pickMissingVars(actionConfig, collected);

    // 无进展 = 这一轮一个必填字段都没补上 → 这条多半根本不是在回答追问。
    // 清状态 + 告知 + PASS 交还 dispatch，别把用户真正想问的问题吞掉。
    if (missing.length >= missingBefore.length) {
      pendingState.delete(userId);
      logger.info('action-runner', '追问一轮无补充，结束动作并交还常规流程', {
        actionId: actionConfig.id,
        userId,
        waitingFor: pending.waitingFor,
      });
      const waited = actionConfig.variables?.find((v) => v.name === pending.waitingFor);
      await ctx.reply(
        `已结束上次未完成的「${actionConfig.name}」（没等到${waited?.label || pending.waitingFor}）。需要的话重新说一次就行。`,
      );
      return PASS;
    }

    if (missing.length > 0) {
      // 有进展但还缺 → 继续追问下一个
      const next = missing[0];
      setPending(userId, { actionId: actionConfig.id, collected, waitingFor: next.name });
      return ctx.reply(next.prompt || `请提供 ${next.label || next.name}`);
    }

    // 全齐 → 执行。从 pending 取而不是从 Map 取：pending 是本轮 getPending() 刚拿到的条目
    //（已过 TTL 剪枝），比再读一次 Map 稳（理由同 proceedWithAction 那处）。
    const learnSrc = pending.learnSrc || null;
    pendingState.delete(userId);
    return executeAction(ctx, actionConfig, collected, deps, learnSrc);
  } catch (e) {
    pendingState.delete(userId);
    logger.error('action-runner', '追问处理异常', { actionId: actionConfig.id, err: e?.message });
    return ctx.reply('处理请求时出错，请重试。');
  }
}

/** 执行脚本并回复结果（含持久变量落盘） */
async function executeAction(ctx, actionConfig, collectedVars, deps, learnSrc = null) {
  const userId = ctx.user.id;

  try {
    // 保存永久变量（persistent=true），下次跳过追问
    for (const v of actionConfig.variables || []) {
      if (v.persistent && collectedVars[v.name]) {
        deps.saveVar(userId, v.name, collectedVars[v.name]);
      }
    }

    // 执行目标（哪个环境、哪个号）必须在 ⏳ 与结果两条回执里都出现 ——
    // persistent 变量会静默复用上次的值，不回显的话「清错对象」对用户零可观测
    // （事故实证见 script-runner.js#describeTarget 文档）。
    const target = describeTarget(actionConfig, collectedVars);
    const targetSuffix = target ? `\n（${target}）` : '';

    await ctx.reply(`⏳ 正在执行「${actionConfig.name}」…${target ? `\n${target}` : ''}`);

    const result = await deps.run(actionConfig, userId, collectedVars);
    const tail = (result.output || '').slice(-800);

    if (result.ok) {
      // 关键词自学习：只在「这次是 L3 兜底认出来的」+「脚本真的跑成功了」时触发。
      // 执行成功是用户用行为给出的确认 —— 中途取消、脚本失败都不学，
      // 免得把一次误判固化成永久关键词（见 learn-keywords.js 文件头）。
      if (learnSrc?.text) fireLearn(actionConfig, learnSrc.text, deps);
      // 成功：正文就是脚本自身输出（脚本已精简为用户关心的一句话），不加框架前缀。
      // 脚本一个字都没打时**不许伪造**「✅ xx完成」—— exit 0 只说明脚本自己认为跑完了，
      // 究竟做了什么无从确认，含糊报成功正是「明明啥也没干却说成功」的帮凶。
      const body = tail.trim() || `✅ ${actionConfig.name}已执行（退出码 0，但脚本无输出，无法确认结果）`;
      return ctx.reply(`${body}${targetSuffix}`);
    }
    return ctx.reply(`❌ 执行失败${targetSuffix}\n${tail || '(无输出)'}`);
  } catch (e) {
    logger.error('action-runner', '执行脚本异常', { actionId: actionConfig.id, err: e?.message });
    return ctx.reply('执行脚本时出错，请稍后重试。');
  }
}

/**
 * 触发关键词自学习：绝不 await、绝不让异常冒泡（与 sendAck 同款姿态）。
 * 学关键词是锦上添花，失败了用户照样该拿到执行结果。
 *
 * 动态 import：学习链要拉起 llm-classify + store，而绝大多数执行根本不走这条路
 *（L2 命中的、卡片按钮触发的都不学），没必要在模块加载期就把它们拖进来。
 */
function fireLearn(actionConfig, sourceText, deps) {
  const swallow = (e) =>
    logger.warn('action-runner', '关键词自学习失败（不影响执行结果）', {
      actionId: actionConfig.id,
      err: e?.message || String(e),
    });
  try {
    const run = deps.learn
      ? deps.learn({ action: actionConfig, sourceText })
      : import('./learn-keywords.js').then((m) =>
          m.learnKeywords({ action: actionConfig, sourceText }));
    if (run && typeof run.catch === 'function') run.catch(swallow);
  } catch (e) {
    swallow(e);
  }
}

export default {
  name: 'action-runner',
  // 'any'：feature 级只负责「让两种角色都能路由进来」，真正的裁决在 permission.js 的
  // canRunAction（按 ActionConfig.permission 逐动作判定）。
  // 不可写 'guest'——dispatch.js 用的是 `f.permission === ctx.user.role` 全等语义，
  // 写 'guest' 会让 owner 永远进不来（权限语义颠倒）。
  permission: 'any',
  intents: ['action'],
  hasPending: (ctx) => hasPending(ctx),
  handle: (ctx, intentResult) => handle(ctx, intentResult),
};

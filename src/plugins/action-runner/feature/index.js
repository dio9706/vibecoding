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
import { runAction } from './script-runner.js';
import { canRunAction } from './permission.js';
import { logger } from '../../../shared/logger.js';
import { msg } from '../../../shared/messages.js';
import { PASS } from '../../../app/signals.js';

// pendingState: userId(open_id) → { actionId, collected: {...}, waitingFor: varName, ts: number }
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
  pendingState.set(userId, { ...entry, ts: Date.now() });
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

  return proceedWithAction(ctx, actionConfig, deps);
}

/**
 * 即时应答 —— 只在**真会调 LLM** 时发（动作有必填变量），否则纯本地流程会凭空多出一条噪音。
 *
 * 绝不 await（与 feedback / bug-patrol 同款）：飞书限流会让 reply 抛错，
 * 而这条只是「让用户知道消息收到了」的锦上添花，不该把整个动作带崩。
 * ctx.reply 可能同步抛也可能返回 rejected promise，两条路径都要吞。
 */
function sendAck(ctx, actionConfig) {
  const needsSlotFilling = (actionConfig.variables || []).some((v) => v.required);
  if (!needsSlotFilling) return;
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
async function proceedWithAction(ctx, actionConfig, deps) {
  const userId = ctx.user.id;
  const text = ctx.text || '';

  // 抽取前先应答：下面这一行 await 在生产实测要 6~12s。
  // 追问轮（handlePendingResponse）刻意不发 —— 用户刚回答完，下一条马上就到，再来一条只是噪音。
  sendAck(ctx, actionConfig);

  try {
    // 从消息提取变量 + 合并持久化
    const extracted = await deps.extract(actionConfig, text, userId);
    const missing = pickMissingVars(actionConfig, extracted);

    if (missing.length > 0) {
      // 保存到 pendingState 并追问第一个缺失变量
      const first = missing[0];
      setPending(userId, { actionId: actionConfig.id, collected: extracted, waitingFor: first.name });
      return ctx.reply(first.prompt || `请提供 ${first.label || first.name}`);
    }

    // 所有必填变量已收集 → 执行脚本
    pendingState.delete(userId);
    return executeAction(ctx, actionConfig, extracted, deps);
  } catch (e) {
    pendingState.delete(userId);
    logger.error('action-runner', '槽位填充异常', { actionId: actionConfig.id, err: e?.message });
    return ctx.reply('处理请求时出错，请重试。');
  }
}

/** 处理用户在追问中间态的回复 */
async function handlePendingResponse(ctx, pending, text, deps) {
  const userId = ctx.user.id;
  const actionConfig = deps.getConfig(pending.actionId);

  if (!actionConfig) {
    pendingState.delete(userId);
    return ctx.reply('动作不存在或已禁用。');
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

    // 全齐 → 执行
    pendingState.delete(userId);
    return executeAction(ctx, actionConfig, collected, deps);
  } catch (e) {
    pendingState.delete(userId);
    logger.error('action-runner', '追问处理异常', { actionId: actionConfig.id, err: e?.message });
    return ctx.reply('处理请求时出错，请重试。');
  }
}

/** 执行脚本并回复结果（含持久变量落盘） */
async function executeAction(ctx, actionConfig, collectedVars, deps) {
  const userId = ctx.user.id;

  try {
    // 保存永久变量（persistent=true），下次跳过追问
    for (const v of actionConfig.variables || []) {
      if (v.persistent && collectedVars[v.name]) {
        deps.saveVar(userId, v.name, collectedVars[v.name]);
      }
    }

    await ctx.reply(`⏳ 正在执行「${actionConfig.name}」…`);

    const result = await deps.run(actionConfig, userId, collectedVars);
    const tail = (result.output || '').slice(-800);

    if (result.ok) {
      // 成功：直接回脚本自身输出（脚本已精简为用户关心的一句话），不加框架前缀
      return ctx.reply(tail.trim() || `✅ ${actionConfig.name}完成`);
    }
    return ctx.reply(`❌ 执行失败\n${tail || '(无输出)'}`);
  } catch (e) {
    logger.error('action-runner', '执行脚本异常', { actionId: actionConfig.id, err: e?.message });
    return ctx.reply('执行脚本时出错，请稍后重试。');
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

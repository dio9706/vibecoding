/**
 * 路由核心 —— 把统一 Context 分发到某个 feature。
 * 顺序：未完成会话状态优先 → owner 兜底(match) → 意图匹配(permission + intents) → 帮助。
 *
 * 加功能不改这里：业务功能一律作为插件挂载（`src/plugins/`，清单在 plugins/index.js），
 * 由 features/index.js 按 order 与内核 claude-exec 合并。契约见 docs/ARCHITECTURE.md
 * 「Feature 契约与装配」。（早期版本是「在 features/index.js 注册」，现已不再登记业务 feature。）
 */
import { classify } from './intent.js';
import { features } from '../features/index.js';
import { logger, preview } from '../shared/logger.js';
import { msg, buildWelcomeText, buildWelcomeCard } from '../shared/messages.js';
import { PASS } from './signals.js';
import { getActiveBot } from '../store/settings.js';

/** 失败回告文案。刻意不暴露内部错误细节，只保证用户知道「这条没成」。 */
const FAILURE_TEXT = '😵 处理这条消息时出错了，我已记录。麻烦换个说法再发一次～';

/**
 * dispatch 的兜底包装 —— **异常必须回告用户，绝不静默**。
 *
 * 为什么必须在这一层兜：dispatch 记录后重抛 → 飞书入口 `try{}finally{}` 无 catch
 * → channels/feishu.js 只 `.catch(logger.error)`。而 SDK 在 handler resolve 时已回 200 ack，
 * 飞书**不会重推**；去重表 seen 也已标记该 messageId，用户重发同一条也不会被重跑。
 * 净效果就是「表情贴上又取下，然后永远没有下文」。
 *
 * 放在 app 层而不是飞书入口层：任何渠道的入口都应得到同一个保证。
 *
 * @param {object} ctx 统一 Context
 * @param {{run?: (ctx:object)=>any}} [deps] run 可注入，便于单测
 * @returns {Promise<{ok:boolean, notified?:boolean}>}
 */
export async function dispatchSafely(ctx, { run = dispatch } = {}) {
  try {
    await run(ctx);
    return { ok: true };
  } catch (e) {
    logger.error('dispatch', '处理失败，尝试回告用户', {
      source: ctx?.source,
      user: ctx?.user?.id,
      err: e?.message || String(e),
      stack: preview(e?.stack, 500),
    });
    try {
      if (typeof ctx?.reply !== 'function') return { ok: false, notified: false };
      await ctx.reply(FAILURE_TEXT);
      return { ok: false, notified: true };
    } catch (e2) {
      // 回告本身也失败（多半是同一个限流还没过去）——只能落日志。
      // 关键是**不能再抛**：往上没有任何 catch，冒泡等于回到静默丢失的老路。
      logger.error('dispatch', '失败回告也发送失败', { err: e2?.message || String(e2) });
      return { ok: false, notified: false };
    }
  }
}

/**
 * @param {object} ctx 统一 Context
 * @param {{featureList?: Array, classifyFn?: Function}} [deps] 可注入，便于单测（默认取真实装配表）
 */
export async function dispatch(ctx, { featureList = features, classifyFn = classify } = {}) {
  const t0 = Date.now();
  logger.info('dispatch', '收到消息', {
    source: ctx.source,
    role: ctx.user?.role,
    user: ctx.user?.id,
    text: preview(ctx.text),
  });
  try {
    // 0. 某 feature 对该用户有未完成会话（如追问中间态）→ 优先交给它，不再意图识别。
    //    但 hasPending 是**同步**判定，判不出「这条到底是不是在回答追问」；feature 接进去后
    //    发现不是给自己的，可返回 PASS 把消息还回来（事故：动作追问粘住，用户问别的也被吞）。
    for (const f of featureList) {
      if (f.hasPending && f.hasPending(ctx)) {
        logger.info('dispatch', `→ ${f.name}（会话中 hasPending）`);
        const r = await f.handle(ctx, null);
        if (r !== PASS) return r;
        logger.info('dispatch', `← ${f.name} 放弃接管（PASS），转常规流程`);
      }
    }

    // 1. owner 兜底：match 命中的 feature（owner 全接）
    for (const f of featureList) {
      if (f.match && f.match(ctx)) {
        logger.info('dispatch', `→ ${f.name}（match）`);
        return await f.handle(ctx, null);
      }
    }

    // 2. 意图识别 → 按 权限 + intents 匹配（hasMaterials 由入口层写入 ctx.meta，影响分类分层）
    const intent = await classifyFn(ctx.text, { hasMaterials: !!ctx.meta?.hasMaterials });
    logger.info('dispatch', '意图识别', { intent: intent.intent, env: intent.env ?? null });
    ctx.body = intent.body || ''; // 强前缀命中时的正文（已剥掉「提交需求：」这类前缀）
    for (const f of featureList) {
      const permOK = f.permission === 'any' || f.permission === ctx.user.role;
      if (permOK && f.intents.includes(intent.intent)) {
        logger.info('dispatch', `→ ${f.name}（intent=${intent.intent}）`);
        return await f.handle(ctx, intent);
      }
    }

    // 3. 无匹配：帮助
    logger.info('dispatch', '无匹配 → 帮助');
    const bot = getActiveBot();
    const welcomeCard = buildWelcomeCard(bot?.id);
    await ctx.sendCard(welcomeCard);
  } catch (e) {
    logger.error('dispatch', '处理异常', { err: e?.message || String(e), stack: preview(e?.stack, 500) });
    throw e;
  } finally {
    logger.info('dispatch', '完成', { ms: Date.now() - t0 });
  }
}

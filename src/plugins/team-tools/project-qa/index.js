/**
 * feature: 项目问答（显式问询意图）。
 *
 * 变更历史（重要，勿回退）：原先挂 intents:['other'] 作完全托管兜底 —— 任何未命中消息都会触发
 * 一次「读代码查证再回答」，冷启动 + 工具探索动辄几十秒，闲聊也走这条路，是「放开对话限制后
 * 响应变慢」的直接原因。现改为只接显式问询意图（intent=question），且不再看托管档位：
 * 用户明确问了，就该查代码回答。未识别的消息由 dispatch 回引导文案。
 *
 * 三道保护：同用户串行闸（防连问打爆额度）、3 分钟超时（SDK 流在限流时可能永不结束）、答案截断（飞书 2000 字上限）。
 */
import { runClaude } from '../../../integrations/claude.js';
import { claudeAuthOpts } from '../../../capabilities/token-rotation.js';
import { getActiveBot } from '../../../store/settings.js';
import { botSystemAppend } from '../../../shared/bot-scope.js';
import { msg } from '../../../shared/messages.js';
import { config } from '../../../shared/config.js';
import { logger } from '../../../shared/logger.js';

/** 读码问答超时：到点 abort 并回提示，绝不让用户无限等 */
const QA_TIMEOUT_MS = 180_000;
/** 答案长度上限（飞书单条文本 2000 字，留余量给截断提示） */
const ANSWER_MAX = 1800;

/** 同一用户串行闸：正在查的 openId 集合（纯内存，进程级） */
const running = new Set();

export default {
  name: 'project-qa',
  permission: 'any',
  intents: ['question'],
  handle: async (ctx, intentResult) => {
    // 空正文保护：只发了「问个问题」这类强前缀时必须追问后 return，不起 Claude。
    // 判据取 classify() 的契约字段（strong=L1 强前缀命中、body=剥掉前缀后的正文），
    // 不能退化成 `body || ctx.text` 后再判空 —— 那样 ctx.text 就是「问个问题」本身，判空永不成立，
    // 会真的起一个 Claude 进程去读代码「查证」这个字面量，最长 180s 且占掉该用户的串行闸。
    const body = (intentResult?.body || '').trim();
    if (!body && intentResult?.strong) {
      return ctx.reply('好的，你想问什么？直接说「问个问题 XXXX」就行～');
    }
    // L3 语义分类命中 question 时 body 恒为空串，此时问题就是原文
    const question = body || (ctx.text || '').trim();
    if (!question) return ctx.reply('好的，你想问什么？直接说「问个问题 XXXX」就行～');

    const bot = getActiveBot();
    const cwd = bot?.projectDir || config.feedback.frontendDir;
    if (!cwd) return ctx.reply('我还没被配置项目目录，暂时答不了这个问题～');

    // 串行闸：一个用户同时只查一个问题（连问会各起一个 Claude 进程，额度与机器都吃不住）
    if (running.has(ctx.user.id)) {
      return ctx.reply('我还在查上一个问题，稍等一下～');
    }

    const append = botSystemAppend(bot);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), QA_TIMEOUT_MS);
    let out = '';
    let timedOut = false;
    try {
      // 进闸必解闸：running.add 必须是 try 内第一行。放在 try 之前的话，中间任何一行抛错都会
      // 让该用户永久卡在串行闸里（finally 走不到），此后再也问不了任何问题。
      running.add(ctx.user.id);

      // 即时应答：先让用户知道我去翻代码了（放在 try 内，即时应答失败也要经 finally 解闸）
      await ctx.reply(msg('ackQuestion'));

      const call = runClaude(
        `团队成员提问：「${question}」\n\n` +
          `请基于当前工程代码实际查证后回答（只读，不修改任何文件）。\n` +
          `回答面向提问者：简洁清晰、说结论和依据，不超过 500 字；工程中查证不到的内容直说不知道，不要编造。`,
        {
          ...claudeAuthOpts(), // 跟随备用账号轮换
          cwd,
          // dontAsk：未列出的工具直接拒绝，不再依赖「没传 canUseTool 回调」这个隐含前提。
          // allowedTools 单用只是免确认，挡不住 Write/Edit/Bash（见 review/index.js 注释）。
          permissionMode: 'dontAsk',
          allowedTools: ['Read', 'Grep', 'Glob'], // 只读
          persistSession: false, // 单轮问答不落盘 session
          abortController: abort,
          ...(append ? { systemPrompt: { type: 'preset', preset: 'claude_code', append } } : {}),
          onText: (t) => (out += t),
          onResult: (i) => {
            if (i.result) out = i.result;
          },
        },
      );
      // abort 后 SDK 流可能迟迟不结束（限流实测拖十分钟+）→ race 兜底，绝不被拖死
      call.catch((e) => logger.warn('project-qa', '问答调用异常（已落兜底）', { err: e?.message || String(e) }));
      const raced = await Promise.race([
        call.then(() => 'done'),
        new Promise((r) => setTimeout(() => r('timeout'), QA_TIMEOUT_MS + 2_000)),
      ]);
      timedOut = raced === 'timeout';
    } catch (e) {
      // 超时 abort 会让调用直接 reject → 归到超时分支给准确提示，其余才算真失败
      if (abort.signal.aborted) {
        timedOut = true;
      } else {
        logger.error('project-qa', '问答失败', { err: e?.message || String(e) });
        return ctx.reply('查询出错了，请稍后再试～');
      }
    } finally {
      clearTimeout(timer);
      running.delete(ctx.user.id); // 异常路径也必须解闸，否则该用户永久卡住
    }

    const text = out.trim();
    if (timedOut && !text) {
      logger.warn('project-qa', '问答超时', { openId: ctx.user.id });
      return ctx.reply('这个问题我查得有点久，稍后再试或换个问法～');
    }
    const answer = text.length > ANSWER_MAX ? text.slice(0, ANSWER_MAX) + '\n…（内容过长已截断）' : text;
    return ctx.reply(answer || '没有查到相关内容～');
  },
};

/**
 * feature: 完整 Claude 能力（owner 专属，飞书入口）。
 * owner 的消息都走完整 Claude（bypassPermissions），支持 /new 重置、首行 cwd 指定目录、多轮续接。
 * 唯一例外：「提交需求：/提交故障：」强前缀让路给 feedback（owner 也要能立案、材料池才有 drain 出口），
 * 判定见 logic.shouldOwnerExec。
 * 注：web 入口的 owner 聊天走流式 SSE，直接用 integrations/claude，不经此 feature。
 */
import fs from 'node:fs';
import { runClaude } from '../../integrations/claude.js';
import { msg } from '../../shared/messages.js';
import { botSystemAppend } from '../../shared/bot-scope.js';
import { getActiveBot } from '../../store/settings.js';
import { appendUserLog } from '../../store/user-log.js';
import { shouldOwnerExec } from './logic.js';
import { buildExecReply, splitForFeishu, splitForMarkdownCard } from './reply.js';

// sessionKey → session_id（多轮续接）
const sessions = new Map();

export default {
  name: 'claude-exec',
  permission: 'owner',
  intents: [],
  // owner 全接，不走意图分类；但「提交需求：/提交故障：」让路给 feedback（见 logic.shouldOwnerExec）
  match: (ctx) => shouldOwnerExec(ctx.text, ctx.user.role),
  handle: async (ctx) => {
    const { text, sessionKey, reply } = ctx;

    if (text === '/new' || text === '新对话') {
      sessions.delete(sessionKey);
      return reply(msg('execNewChat'));
    }

    // 每次读盘取启用机器人（保存配置后下一条消息生效）
    const bot = getActiveBot();
    /** 超长输出按卡片大小限制分片顺序发出（Markdown 渲染）；整条超限会让发送抛错，最终整条丢失 */
    const sendChunked = async (send, text) => {
      const parts = splitForMarkdownCard(text);
      if (!parts.length) return send('(无输出)');
      for (const p of parts) await send(p);
    };

    // 默认工作目录 = 机器人项目文件夹；owner 首行 cwd: 显式覆盖优先
    let workDir = bot?.projectDir && fs.existsSync(bot.projectDir) ? bot.projectDir : undefined;
    let promptText = text;
    const m = text.match(/^\s*cwd:\s*(.+?)\s*(?:\n|$)/i);
    if (m) {
      workDir = m[1].trim();
      promptText = text.slice(m[0].length).trim() || '(继续)';
      if (!fs.existsSync(workDir)) return reply(`工作目录不存在：${workDir}`);
    }

    // 用户输入原始日志（记忆库数据采集层，见 store/user-log.js）。
    // 埋在这里而不是 feishu/index.js 的 onInbound，有两个理由：
    //  1. 本 feature 是 owner 专属（permission: 'owner'）。onInbound 收的是**所有人**的消息，
    //     群里同事的话被记进去，等于拿别人的偏好去教 AI，比漏记严重得多。
    //  2. 这里是飞书侧「用户与 Claude 对话」的路径，和 web 执行台的起跑同性质；
    //     onInbound 还混着图片/文件/云文档等非文本分支。
    // 记 text 而非 promptText：首行的 `cwd:` 指令虽是机器指令，但也是用户敲出来的，
    // 原始层的职责是无损，剥离交给提炼层。飞书没有插话语义，kind 恒为 send。
    appendUserLog({
      text,
      source: 'feishu',
      kind: 'send',
      convId: sessionKey,
      sessionId: sessions.get(sessionKey) || null,
      cwd: workDir || null,
    });

    await reply(`${msg('execProcessing')}（完整能力${workDir ? ' @' + workDir : ''}）`);

    // 角色描述 + 工程边界/说明：preset+append 保留 Claude Code 完整系统提示
    const append = botSystemAppend(bot);
    let buf = '';
    let outcome = { isError: false, subtype: 'success' };
    try {
      await runClaude(promptText, {
        cwd: workDir,
        permissionMode: 'bypassPermissions',
        ...(append ? { systemPrompt: { type: 'preset', preset: 'claude_code', append } } : {}),
        resume: sessions.get(sessionKey),
        onInit: (i) => {
          if (i.session_id) sessions.set(sessionKey, i.session_id);
        },
        onText: (t) => (buf += t),
        onResult: (i) => {
          if (!buf && i.result) buf = i.result;
          // 必须记下 is_error/subtype：限流终止、error_max_turns、权限失败这些
          // 「不抛异常但确实失败了」的情况只能从这里得知。丢掉它们就会把失败回成「(无输出)」。
          outcome = { isError: !!i.is_error, subtype: i.subtype };
        },
      });
      // 使用 Markdown 渲染发送，分片大小按卡片限制（约 28KB）
      const sendMarkdownChunked = (text) => ctx.channel.sendMarkdownText(ctx.chatKey, text);
      await sendChunked(sendMarkdownChunked, buildExecReply({ text: buf, ...outcome }));
    } catch (err) {
      const sendMarkdownChunked = (text) => ctx.channel.sendMarkdownText(ctx.chatKey, text);
      await sendChunked(sendMarkdownChunked, `执行出错：${err?.message || String(err)}`);
    }
  },
};

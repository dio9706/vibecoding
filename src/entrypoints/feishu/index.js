/**
 * 飞书入口 —— 组装层：channel 收信 → 角色判定 / 业务特例 → 统一 Context → dispatch。
 * 渠道细节（WS 生命周期 / 凭证热重载 / 去重 / 报文解析 / 资源下载 / 状态上报）都在 channels/feishu.js；
 * ctx 契约字段（source/user/text/sessionKey/reply/meta）与 dispatch/features 的约定保持不变。
 */
import { config } from '../../shared/config.js';
import { migrateToBots } from '../../store/bots-migration.js';
import { get as getChannel } from '../../channels/index.js';
import { attachImageToRecentTask, attachMaterialToRecentTask } from '../../plugins/team-tools/task-ops.js';
import { addMaterial, hasMaterials, saveTextMaterial } from '../../plugins/team-tools/material-pool.js';
import { hasPatrolPending } from '../../plugins/team-tools/bug-patrol/index.js';
import { extractDocLinks, stripDocLinks } from '../../channels/feishu-normalize.js';
import { fetchDocRawContent, resolveWikiNode, getBotOpenId } from '../../integrations/lark.js';
import { atPrefix } from '../../shared/mention.js';
import { docxToMdFile } from '../../integrations/docx.js';
import { getPluginEnabled } from '../../store/settings.js';
import { dispatch, dispatchSafely } from '../../app/dispatch.js';
import { logger } from '../../shared/logger.js';
import { msg } from '../../shared/messages.js';
import { getCardKindHandler } from '../../shared/card-actions.js';
import { installProcessGuards } from '../../shared/process-guard.js';

// 最后兜底：单条畸形消息/一次飞书 API 抛错不得打死长连接进程。详见 process-guard.js。
installProcessGuards();

const channel = getChannel('feishu');

function roleOf(openId) {
  return openId && config.lark.ownerOpenIds.includes(openId) ? 'owner' : 'guest';
}

/**
 * 全局卡片回调处理器
 * 需要在业务特例中注册具体的回调逻辑（根据 messageId 或其他上下文）
 */
const cardActionHandlers = new Map(); // messageId -> handler

async function onCardAction(data) {
  // v2 schema 的 message_id 在 context.open_message_id；顶层字段兜底（旧机制假设的形态）
  const messageId = data?.context?.open_message_id || data?.message_id || null;
  const handler = messageId && cardActionHandlers.get(messageId);
  if (handler) {
    try {
      await handler(data);
    } finally {
      // 处理完后删除，避免重复处理
      cardActionHandlers.delete(messageId);
    }
    return;
  }
  // kind 路由：按钮 value 自带 taskId 等全部上下文，无内存态 → 机器人重启后旧卡片按钮仍有效
  let value = data?.action?.value ?? null;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const kindHandler = value?.kind ? getCardKindHandler(value.kind) : null;
  if (kindHandler) {
    await kindHandler(data);
    return;
  }
  logger.warn('feishu', '未注册卡片回调处理', { messageId, kind: value?.kind || null });
}

async function onInbound(m) {
  // 群聊策略：只处理 @ 了本机器人的消息（群里闲聊不该触发意图识别与读码问答）。
  // 只对 text（含富文本）生效：飞书图片/文件报文不含 mentions（发图时无法 @ 人），
  // 若按未 @ 处理会让群聊的先图后文材料链路整条失效（截图被静默丢弃，用户毫无感知）。
  // 取不到机器人 open_id（网络/权限问题）→ 不过滤，降级为原全响应行为，绝不因此让机器人在群里失声。
  // unsupported（表情包/语音/视频等）在群聊里一律静默：这类消息无 mentions 又不承载材料，
  // 若照 image/file 放行，群里任何人发个表情都会被回一句「不支持该类型」，是纯噪音。
  if (m.chatType === 'group' && (m.kind === 'text' || m.kind === 'unsupported')) {
    const botOpenId = await getBotOpenId();
    if (botOpenId && !(m.mentions || []).some((x) => x.openId === botOpenId)) {
      logger.info('feishu', '群聊消息未 @ 机器人，忽略', { chatId: m.chatKey, kind: m.kind, userId: m.userId });
      return;
    }
  }

  // 本函数所有出口（早返回提示 + ctx.reply）统一走这个 @ 前缀出口：群聊 @ 回提问人，p2p 为空串。
  // 前缀必须独占一行：否则 sendReply 的逐行图片直链判定会失效，二维码等会退化成文本链接。
  const mention = atPrefix(m.userId, m.chatType);
  const say = (text) =>
    channel.send(m.chatKey, { text: mention ? mention + '\n' + String(text ?? '') : String(text ?? '') });

  // 单发图片：归属到该用户最近提交的需求/故障（补充截图），不进 dispatch。
  // team-tools 插件停用时该特例一并失效（按不支持类型提示）。
  if (m.kind === 'image' && !getPluginEnabled('team-tools')) {
    await say('目前支持文本和富文本消息～');
    return;
  }
  if (m.kind === 'image') {
    const file = m.images[0];
    if (!file) {
      // 下载失败 → 按错误类型给出精准提示
      const downloadError = m.downloadError;
      if (downloadError) {
        const { code, msg, httpStatus } = downloadError;
        if ([403, 401].includes(httpStatus) || code === 'no_permission' || code === 'access_denied') {
          await say('🔐 机器人没有查看该图片的权限。请检查机器人是否有 `im:resource` 权限，或重新发送该图片～');
        } else if (code === 'not_found' || httpStatus === 404) {
          await say('🖼 图片不存在或已被删除，请重新发送～');
        } else if (httpStatus === 429 || code === 'rate_limit') {
          await say('⏳ 请求太频繁，请稍后重试～');
        } else {
          logger.warn('feishu', '图片下载未分类错误', { code, msg, httpStatus });
          await say(`🖼 图片下载失败（${code || 'ERR'}）。请稍后重试～`);
        }
      } else {
        await say('图片下载失败，请稍后重试～');
      }
      return;
    }
    const task = attachImageToRecentTask(m.userId, file);
    if (task) {
      await say(`🖼 已把截图补充到「${task.title}」，会结合截图分析处理。`);
    } else {
      // 先图后文：入材料池，等下一条文字立案时吸附（替代原「请随文字一起发」提示）
      addMaterial(m.userId, m.chatKey, { kind: 'image', path: file });
      await say(msg('materialAck'));
    }
    return;
  }
  // 文件消息：按扩展名归一化为材料（先挂近期任务，挂不上入池）
  if (m.kind === 'file') {
    if (!getPluginEnabled('team-tools')) {
      await say('目前支持文本和富文本消息～');
      return;
    }
    const f = m.files?.[0];
    if (!f) {
      // 下载失败 → 按错误类型给出精准提示
      const downloadError = m.downloadError;
      if (downloadError) {
        const { code, msg, httpStatus } = downloadError;
        // 权限/认证类错误
        if ([403, 401].includes(httpStatus) || code === 'no_permission' || code === 'access_denied') {
          await say(
            '🔐 机器人没有阅读该文件的权限。请在文件右上角把机器人加为协作者，或检查机器人是否有 `im:resource` 权限。',
          );
        } else if (code === 'not_found' || httpStatus === 404) {
          await say('📄 文件不存在或已被删除，请重新发送或检查文件链接。');
        } else if (httpStatus === 429 || code === 'rate_limit') {
          await say('⏳ 请求太频繁，请稍后重试～');
        } else {
          // 未分类的错误 → 既给"重试"建议，也给完整信息供诊断
          logger.warn('feishu', '文件下载未分类错误', { code, msg, httpStatus });
          await say(`📎 文件下载失败（${code || 'ERR'}）。请稍后重试，或检查文件是否仍可访问～`);
        }
      } else {
        // 无详细错误信息（兜底）
        await say('文件下载失败，请稍后重试～');
      }
      return;
    }
    const ext = (f.name.match(/\.(\w+)$/) || [])[1]?.toLowerCase() || '';
    let material = null;
    if (['md', 'txt', 'json', 'pdf'].includes(ext)) {
      material = { kind: 'file', path: f.path, title: f.name };
    } else if (ext === 'docx') {
      try {
        const mdPath = await docxToMdFile(f.path, f.name);
        material = { kind: 'file', path: mdPath, title: f.name };
      } catch (e) {
        logger.warn('feishu', 'docx 解析失败，附原件路径', { err: e?.message || String(e) });
        material = { kind: 'file', path: f.path, title: `${f.name}（未能解析，docx 原件）` };
      }
    } else {
      await say(`暂不支持解析 .${ext || '未知'} 文件，请转成文档（md/pdf/docx）或直接粘贴关键内容～`);
      return;
    }
    const task = attachMaterialToRecentTask(m.userId, material);
    await say(task ? `📎 已把「${f.name}」补充到「${task.title}」，会结合材料处理。` : msg('materialAck'));
    if (!task) addMaterial(m.userId, m.chatKey, material);
    return;
  }
  if (m.kind === 'unsupported') {
    await say('目前支持文本、图片、文件和富文本消息～');
    return;
  }

  // 云文档链接：拉取内容存为材料；纯链接消息不进 dispatch，带正文的链接消息取完材料继续分发。
  // BUG 巡检等表状态（\10001 触发后）必须旁路：多维表格常以 wiki 链接分享，
  // 若照常摄取会被 docx 流程判「不支持」吞掉，消息永远到不了 bug-patrol 的 hasPending。
  const docLinks =
    getPluginEnabled('team-tools') && !hasPatrolPending(m.userId) ? extractDocLinks(m.text) : [];
  if (docLinks.length) {
    for (const link of docLinks) {
      try {
        const docToken = link.kind === 'wiki' ? await resolveWikiNode(link.token) : link.token;
        if (!docToken) throw new Error('wiki 节点不是 docx 文档');
        const content = await fetchDocRawContent(docToken);
        const title = content.split('\n')[0]?.trim().slice(0, 30) || '飞书文档';
        const filePath = saveTextMaterial(title, content);
        const material = { kind: 'doc', path: filePath, title };
        const task = attachMaterialToRecentTask(m.userId, material);
        if (task) {
          await say(`📄 已把文档「${title}」补充到「${task.title}」。`);
        } else {
          addMaterial(m.userId, m.chatKey, material);
        }
      } catch (e) {
        logger.warn('feishu', '云文档拉取失败', { url: link.url, err: e?.message || String(e) });
        const errMsg = e?.message || '';
        await say(
          errMsg.includes('不是 docx 文档')
            ? '📄 该链接不是文档类型（表格/多维表格暂不支持），请导出为文件或粘贴内容发我～'
            : '📄 检测到飞书文档链接，但机器人没有阅读权限或文档不存在。请在文档右上角把机器人加为协作者，或导出为文件/粘贴内容发我～',
        );
      }
    }
    const rest = stripDocLinks(m.text);
    if (!rest) {
      // 纯链接消息：材料已归属/入池，若入了池补一句提示
      if (hasMaterials(m.userId, m.chatKey)) await say(msg('materialAck'));
      return;
    }
    m = { ...m, text: rest }; // 带正文：剥掉链接后继续正常分发（材料已入池，hasMaterials 生效）
  }

  const ctx = {
    source: 'feishu',
    user: { id: m.userId, role: roleOf(m.userId) },
    text: m.text,
    sessionKey: m.chatKey,
    reply: (t) => say(t),
    sendCard: (card) => channel.sendCard(m.chatKey, card),
    meta: {
      messageId: m.messageId,
      chatId: m.chatKey,
      chatType: m.chatType, // feedback 落进 task.source，异步通知据此决定是否 @
      hasMaterials: hasMaterials(m.userId, m.chatKey),
    },
  };

  // 文本消息中若有内嵌图片下载失败，给轻量提示（不中断主流程）
  if (m.kind === 'text' && m.downloadError) {
    const { code, httpStatus } = m.downloadError;
    if ([403, 401].includes(httpStatus) || code === 'no_permission') {
      await say('💡 内嵌图片可能无权访问，已跳过。若需要图片，请单独发送或检查权限～');
    } else if (code === 'not_found' || httpStatus === 404) {
      await say('💡 内嵌图片已被删除或不存在，已跳过～');
    }
    // 其他错误类型不给提示，继续正常分发（网络抖动等临时问题）
  }

  const emojis = config.lark.reactionEmojis;
  const emoji = emojis[Math.floor(Math.random() * emojis.length)];
  const reactionId = await channel.addReaction(m.messageId, emoji);
  try {
    // 用 dispatchSafely 而非裸 dispatch：这里没有 catch，而上游 channels/feishu.js 只 logger.error，
    // 且 SDK 早已回 200 ack（飞书不重推）+ seen 已标记（用户重发同一条也不会重跑）。
    // 裸 dispatch 抛错 = 用户看到表情贴上又取下，然后永远没有下文。
    await dispatchSafely(ctx);
  } finally {
    if (reactionId) await channel.removeReaction(m.messageId, reactionId);
  }
}

// bots 迁移幂等且走文件锁：feishu 先于 web 启动时也能立即用上机器人凭证/动作（避免动作失配窗口）
try {
  migrateToBots();
} catch (e) {
  logger.warn('feishu', 'bots 迁移失败（等待 web 进程迁移）', { err: e?.message || String(e) });
}

/**
 * 导出卡片回调处理器注册函数（供业务特例使用）
 * 用法: registerCardActionHandler(messageId, async (data) => { ... })
 */
export function registerCardActionHandler(messageId, handler) {
  cardActionHandlers.set(messageId, handler);
}

channel
  .start({ onInbound, onCardAction })
  .catch((e) => logger.error('feishu', 'channel 启动失败', { err: e?.message || String(e) }));

console.log(`\n  飞书 bot 已启动（长连接 + 凭证热重载）`);
console.log(
  `  owner: ${config.lark.ownerOpenIds.length ? config.lark.ownerOpenIds.join(', ') : '(未配置，发条消息看日志里的 open_id 再填 OWNER_OPEN_IDS)'}`,
);

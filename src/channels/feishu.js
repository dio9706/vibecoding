/**
 * 飞书 channel 适配器 —— 渠道细节的唯一归属：
 * WS 生命周期（含凭证热重载/代次守卫）、消息去重、报文解析、资源下载、状态上报（feishu-status.json）。
 * 组装层（entrypoints/feishu）只拿 InboundMessage 做业务路由，不碰渠道原始报文。
 * 热重载/wsGen 代次逻辑自 entrypoints/feishu/index.js 原样迁移（真实事故打磨，勿简化）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLarkCredentials } from '../shared/config.js';
import {
  larkSdk,
  createWsClient,
  resetApiClient,
  sendText,
  sendImageByUrl,
  addReaction,
  removeReaction,
  downloadMessageResource,
  downloadMessageResourceWithError,
  sendCard,
  sendMarkdown,
  updateCard,
} from '../integrations/lark.js';
import {
  parseTextContent,
  parseImageContent,
  parsePostContent,
  parseFileContent,
  parseMentions,
  stripMentions,
} from './feishu-normalize.js';
import { logger } from '../shared/logger.js';
import { writeJson } from '../store/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..'); // 项目根（开发态）
// 打包后 settings.json 写在 APP_DATA_DIR（Tauri 注入），开发态在项目根；fs.watch 需跟随
const WATCH_DIR = process.env.APP_DATA_DIR || ROOT;

// 独占一行的图片直链（允许结尾 ?t= 缓存参数）→ 作为图片消息发送，而非文本
const IMG_URL_RE = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp)(?:\?\S*)?$/i;

/**
 * 发送回复：文本里若含「独占一行的图片直链」，把这些行发成图片消息，其余文字仍发文本；
 * 无图片链接时行为与原来完全一致（纯文本）。发图失败回退成发该 URL 文本，绝不吞消息。
 */
async function sendReply(chatId, text) {
  const raw = String(text ?? '');
  const lines = raw.split('\n');
  const imgs = lines.map((l) => l.trim()).filter((t) => IMG_URL_RE.test(t));
  if (imgs.length === 0) return sendText(chatId, raw); // 原行为：纯文本
  const rest = lines.filter((l) => !IMG_URL_RE.test(l.trim())).join('\n').trim();
  if (rest) await sendText(chatId, rest);
  for (const url of imgs) {
    try {
      await sendImageByUrl(chatId, url);
    } catch (e) {
      logger.warn('feishu', '发图失败，回退发文本链接', { url, err: e?.message || String(e) });
      await sendText(chatId, url);
    }
  }
}

export function createFeishuChannel() {
  let wsClient = null;
  let wsGen = 0; // 当前 WS 代次；旧 client 回调代次不符则忽略（防拆旧后仍写状态抖动）
  let reloading = false; // 防并发热重载
  let activeCreds = { appId: '', appSecret: '' };
  let watcher = null;
  let watchTimer = null;
  let pollTimer = null;
  let _onInbound = null;

  function writeStatus(state, error = null) {
    try {
      writeJson('feishu-status.json', { state, at: new Date().toISOString(), error });
    } catch (e) {
      logger.warn('feishu', '写 feishu-status.json 失败', { err: e?.message || String(e) });
    }
  }

  // 消息去重（飞书失败会重推，窗口很短）；带 TTL 清理，防常驻进程内存无限增长
  const seen = new Map(); // messageId -> 首见时间
  const SEEN_TTL_MS = 10 * 60 * 1000;
  function seenBefore(messageId) {
    const now = Date.now();
    if (seen.size > 1000) {
      for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
    }
    if (seen.has(messageId)) return true;
    seen.set(messageId, now);
    return false;
  }

  /** 渠道原始事件 → InboundMessage；去重/无效返回 null（静默）。图片下载在此完成。 */
  async function toInbound(data) {
    const openId = data?.sender?.sender_id?.open_id;
    const chatId = data?.message?.chat_id;
    const messageId = data?.message?.message_id;
    const msgType = data?.message?.message_type;

    logger.info('feishu', '收到消息', { openId, chatId, type: msgType, messageId });

    if (!chatId) return null;
    if (messageId && seenBefore(messageId)) {
      logger.info('feishu', '重复消息已忽略', { messageId });
      return null;
    }
    const mentions = parseMentions(data?.message);
    const base = {
      channelId: 'feishu',
      chatKey: chatId,
      messageId,
      userId: openId,
      // 群聊策略与 @ 回复要用：'p2p' | 'group'
      chatType: data?.message?.chat_type || null,
      mentions,
      raw: data,
    };

    if (msgType === 'image') {
      const key = parseImageContent(data.message.content);
      if (!key) return null;
      const { file, error } = await downloadMessageResourceWithError(messageId, key, 'image');
      // 下载失败 → images 空数组，error 字段供业务侧分流提示
      return {
        ...base,
        kind: 'image',
        text: '',
        images: file ? [file] : [],
        ...(error && { downloadError: error }),
      };
    }
    if (msgType === 'file') {
      const parsed = parseFileContent(data.message.content);
      if (!parsed) return null;
      const { file, error } = await downloadMessageResourceWithError(
        messageId,
        parsed.fileKey,
        'file',
        parsed.fileName,
      );
      // 下载失败 → files 空数组，error 字段供业务侧分流提示；飞书 file 消息为单文件语义，files 用数组是跨渠道契约
      return {
        ...base,
        kind: 'file',
        text: '',
        images: [],
        files: file ? [{ path: file, name: parsed.fileName }] : [],
        ...(error && { downloadError: error }), // 下载失败时附加错误信息供上层诊断
      };
    }
    if (msgType === 'text') {
      // 剥掉 @_user_N 占位符：否则占位符会进意图识别与任务 title（历史污染源）
      const text = stripMentions(parseTextContent(data.message.content), mentions);
      return text ? { ...base, kind: 'text', text, images: [] } : null;
    }
    if (msgType === 'post') {
      // 富文本：抽取文字 + 下载内嵌图片，图片以本地路径附在文末（detail 随之带图，Claude 可 Read）
      const parsed = parsePostContent(data.message.content);
      let text = stripMentions(parsed.text, mentions);
      const images = [];
      let firstImageDownloadError = null; // 记录第一个失败（若有的话）
      for (const key of parsed.imageKeys) {
        const { file, error } = await downloadMessageResourceWithError(messageId, key, 'image');
        if (file) {
          images.push(file);
          text += `\n[附图] ${file}`;
        } else if (!firstImageDownloadError && error) {
          // 记录首个失败错误，供上层按需诊断
          firstImageDownloadError = error;
        }
      }
      text = text.trim();
      return text
        ? {
            ...base,
            kind: 'text',
            text,
            images,
            ...(firstImageDownloadError && { downloadError: firstImageDownloadError }),
          }
        : null;
    }
    return { ...base, kind: 'unsupported', text: '', images: [] };
  }

  // 卡片回调处理器（由上级注册）
  let _onCardAction = null;

  const dispatcher = new larkSdk.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      (async () => {
        const inbound = await toInbound(data);
        if (inbound && _onInbound) await _onInbound(inbound);
      })().catch((e) => logger.error('feishu', '处理失败', { err: e?.message || String(e) }));
    },
    'im.message.reaction.created_v1': async (data) => {
      // 表情回复事件（可选，目前未使用）
    },
    'card.action.trigger': async (data) => {
      // 卡片按钮点击回调
      if (_onCardAction) {
        (async () => {
          await _onCardAction(data);
        })().catch((e) => logger.error('feishu', '卡片回调处理失败', { err: e?.message || String(e) }));
      }
    },
  });

  /** 用当前凭证启动 WS；无凭证则置 failed 并等待设置页写入 */
  async function startWs() {
    const creds = getLarkCredentials();
    if (!creds.appId || !creds.appSecret) {
      activeCreds = { appId: '', appSecret: '' };
      writeStatus('failed', '未配置飞书凭证（请在 web 设置页填写）');
      logger.warn('feishu', '未配置凭证，等待设置页写入…');
      return;
    }
    activeCreds = creds;
    resetApiClient(creds);
    const gen = ++wsGen; // 本次连接代次
    const st = (state, error = null) => {
      if (gen === wsGen) writeStatus(state, error); // 仅当前代次的回调可写状态，防旧 client 抖动
    };
    // 注：SDK 的 start() 立即 resolve，凭证/网络失败经 onError 异步回调上报；先置 connecting，避免卡在旧状态
    writeStatus('connecting');
    wsClient = createWsClient(creds, {
      onReady: () => {
        st('connected');
        logger.info('feishu', 'WS 已连接');
      },
      onError: (err) => {
        st('failed', err?.message || String(err));
        logger.error('feishu', 'WS 错误', { err: err?.message || String(err) });
      },
      onReconnecting: () => st('reconnecting'),
      onReconnected: () => st('connected'),
    });
    try {
      await wsClient.start({ eventDispatcher: dispatcher });
    } catch (e) {
      st('failed', e?.message || String(e));
      logger.error('feishu', 'WS 启动失败', { err: e?.message || String(e) });
    }
  }

  /** 凭证变更则拆旧建新（热重载）；防并发、旧 client 引用即刻摘除 */
  async function reload() {
    const creds = getLarkCredentials();
    if (creds.appId === activeCreds.appId && creds.appSecret === activeCreds.appSecret) return; // 未变
    if (reloading) return; // 防并发重载
    reloading = true;
    try {
      logger.info('feishu', '凭证变更 → 热重载 WS');
      const old = wsClient; // 先摘除旧引用；其回调因 wsGen 递增而失效
      wsClient = null;
      try {
        old?.close({ force: true });
      } catch {
        /* 忽略关闭异常 */
      }
      await startWs();
    } finally {
      reloading = false;
    }
  }

  return {
    id: 'feishu',
    capabilities: { text: true, richText: true, image: true, reaction: true, mention: true },

    /** 开始收信：注册入站回调 + 卡片回调处理 + 监听凭证变更（fs.watch，失败降级 5s 轮询）+ 建立 WS */
    async start({ onInbound, onCardAction }) {
      _onInbound = onInbound;
      _onCardAction = onCardAction;
      // 监听数据目录（打包后为 APP_DATA_DIR，开发态为项目根），仅对 settings.json 变更做防抖热重载
      try {
        watcher = fs.watch(WATCH_DIR, (_evt, filename) => {
          if (filename !== 'settings.json') return;
          if (watchTimer) clearTimeout(watchTimer);
          watchTimer = setTimeout(
            () => reload().catch((e) => logger.error('feishu', '热重载失败', { err: e?.message || String(e) })),
            300,
          );
        });
      } catch (e) {
        logger.warn('feishu', 'fs.watch 不可用，改用 5s 轮询兜底', { err: e?.message || String(e) });
        pollTimer = setInterval(() => reload().catch(() => {}), 5000);
      }
      await startWs();
    },

    /** 拆连接与监听（wsGen 递增使旧回调失效） */
    stop() {
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      if (pollTimer) clearInterval(pollTimer);
      if (watchTimer) clearTimeout(watchTimer);
      const old = wsClient;
      wsClient = null;
      wsGen++;
      try {
        old?.close({ force: true });
      } catch {
        /* ignore */
      }
    },

    send: (chatKey, { text }) => sendReply(chatKey, text),
    sendMarkdownText: (chatKey, markdown) => sendMarkdown(chatKey, markdown),
    sendCard: (chatKey, cardContent) => sendCard(chatKey, cardContent),
    updateCard: (messageId, cardContent) => updateCard(messageId, cardContent),
    addReaction: (messageId, emoji) => addReaction(messageId, emoji),
    removeReaction: (messageId, reactionId) => removeReaction(messageId, reactionId),
  };
}

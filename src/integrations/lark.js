/**
 * 飞书（Lark）API 封装 —— 全项目唯一的飞书调用入口。
 * 提供 client / WSClient 工厂 + 发消息 + 表情回复 + 消息资源（图片）下载。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
// 飞书 SDK **不在模块顶部静态 import** —— 实测它单独就占 25.6MB heap / 40.3MB RSS，
// 是全进程最大的一块。而 web 进程只在「用户开了会话飞书通知」「需求流程发卡片」这类
// 按需路径上才真正用到它，绝大多数 web 会话一次都不碰。
// 静态 import 会让 web 一启动就背上这 40MB（本文件被 16 处引用，其中含 web 必经路径）。
// 改为首次真正要用时才加载；feishu 进程照旧在连长连接时立刻加载，行为不变。
let _sdk = null;
async function sdk() {
  if (!_sdk) _sdk = await import('@larksuiteoapi/node-sdk');
  return _sdk;
}
import { getLarkCredentials } from '../shared/config.js';
import { appDataPath } from '../shared/app-paths.js';
import { logger, preview } from '../shared/logger.js';

// 存到 .uploads/feishu/ 子目录：web 入口只清理 .uploads 顶层文件，任务截图可长期保留。
// 必须走 appDataPath：此前用 __dirname 拼项目根，打包后指向只读安装目录 →
// mkdirSync 抛 EPERM → 被 downloadMessageResourceWithError 的 catch 吞成
// 「📎 文件下载失败（UNKNOWN_ERROR）」，即**打包版所有图片/文件/文档材料链路失效**。
const RESOURCE_DIR = appDataPath('.uploads', 'feishu');

/** 供入口层使用 EventDispatcher / LoggerLevel 等（异步：SDK 按需加载，见文件头说明） */
export async function getLarkSdk() {
  return sdk();
}

let _client = null;
/**
 * 凭证覆盖值。`resetApiClient(creds)` 传进来的凭证存这里，等下次 getClient() 懒建时用。
 *
 * 为什么不在 resetApiClient 里直接 new：那样它就得变成 async，而它是凭证热重载路径上的
 * 同步调用。存下来延后到 getClient()（本就是 async）里用，语义完全一致 ——
 * 反正在下一次真正发请求之前，client 用不上。
 */
let _overrideCreds = null;

/** 懒实例化 API client；凭证优先用 resetApiClient 传入的，否则取 getLarkCredentials */
async function getClient() {
  if (!_client) {
    const c = _overrideCreds || getLarkCredentials();
    const Lark = await sdk();
    _client = new Lark.Client({ appId: c.appId, appSecret: c.appSecret });
  }
  return _client;
}

let _botOpenId = null; // 机器人自身 open_id 缓存（判断群聊是否 @ 了我）
let _botOpenIdFailedAt = 0; // 上次取 id 失败的时刻（负缓存），0 = 无失败记录
const BOT_OPEN_ID_FAIL_TTL = 60_000; // 负缓存 TTL（毫秒）

/** 凭证变更后重建 API client（让 sendText 等换新号）；creds 省略则重新读取 */
export function resetApiClient(creds) {
  // 只清缓存并记下凭证，真正的 new 延后到 getClient()（SDK 是按需加载的，见文件头）
  _overrideCreds = creds || null;
  _client = null;
  // 换号即失效：拿旧机器人的 id 判 @ 会让新号在群里彻底不响应；负缓存同时清掉，新号无需等 TTL
  _botOpenId = null;
  _botOpenIdFailedAt = 0;
  // 换号后 id 归属可能变，姓名缓存必须一起失效
  _userNames.clear();
  _userNameFailedAt.clear();
}

/**
 * 机器人自身 open_id（GET /open-apis/bot/v3/info）。
 * 模块级缓存；取不到返回 null —— 调用方据此降级为「不过滤群消息」，绝不因为查不到 id 就失声。
 * 失败走负缓存：权限缺失时不必每条群消息都打一次 HTTP + 刷一条 warn。
 * 负缓存要带 TTL：否则权限修好后必须重启才能恢复群聊 @ 过滤。
 */
export async function getBotOpenId() {
  if (_botOpenId) return _botOpenId;
  if (_botOpenIdFailedAt && Date.now() - _botOpenIdFailedAt < BOT_OPEN_ID_FAIL_TTL) return null;
  try {
    const r = await (await getClient()).request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    // SDK generic request 不校验业务 code：HTTP 200 + code!=0 也是失败
    if (r?.code) throw new Error(`bot/v3/info 失败: ${r.msg || r.code}`);
    const id = r?.bot?.open_id || r?.data?.bot?.open_id || null;
    if (id) {
      _botOpenId = id;
      _botOpenIdFailedAt = 0;
      logger.info('lark', '机器人 open_id 已缓存', { openId: id });
    } else {
      // code=0 但报文里没有 open_id：同样按失败计入负缓存，否则每条群消息都会重试
      _botOpenIdFailedAt = Date.now();
      logger.warn('lark', '获取机器人 open_id 失败（群聊将不做 @ 过滤）', { err: '响应未包含 open_id' });
    }
    return _botOpenId;
  } catch (e) {
    _botOpenIdFailedAt = Date.now();
    logger.warn('lark', '获取机器人 open_id 失败（群聊将不做 @ 过滤）', { err: e?.message || String(e) });
    return null;
  }
}

// —— 用户姓名解析（机器人日志展示用）——
/** 姓名正缓存：id → name */
const _userNames = new Map();
/** 失败负缓存：id → 失败时刻。**按 id 粒度**，否则一个查不到的离职用户会连带压掉所有人的解析 */
const _userNameFailedAt = new Map();
/** 负缓存 TTL，与 BOT_OPEN_ID_FAIL_TTL 同值：权限缺失时不必每条消息都打一次 HTTP + 刷一条 warn，
 *  带 TTL 则权限修好后无需重启即可恢复 */
const USER_NAME_FAIL_TTL = 60_000;

/**
 * openId / userId → 姓名。取不到返回 null（调用方降级为显示 id 尾号），**绝不抛错**。
 *
 * user_id_type 必须按前缀动态判定：ctx.user.id 并非恒为 open_id ——
 * card-actions.js 的卡片回调路径是「优先 userId（飞书内部 ID），回退 openId」。
 * 写死 open_id 会让卡片按钮触发的动作日志全部解析失败。
 *
 * 需应用开通 contact:user.base:readonly。未开通时负缓存生效，一分钟最多一次无效请求。
 */
export async function getUserName(id) {
  if (!id) return null;
  const key = String(id);
  const hit = _userNames.get(key);
  if (hit) return hit;
  const failedAt = _userNameFailedAt.get(key);
  if (failedAt && Date.now() - failedAt < USER_NAME_FAIL_TTL) return null;
  try {
    const r = await (await getClient()).request({
      method: 'GET',
      url: `/open-apis/contact/v3/users/${encodeURIComponent(key)}`,
      params: { user_id_type: key.startsWith('ou_') ? 'open_id' : 'user_id' },
    });
    // SDK generic request 不校验业务 code：HTTP 200 + code!=0 也是失败
    if (r?.code) throw new Error(`contact users get 失败: ${r.msg || r.code}`);
    const name = r?.data?.user?.name || r?.user?.name || null;
    if (!name) throw new Error('响应中无 user.name');
    _userNames.set(key, name);
    _userNameFailedAt.delete(key);
    return name;
  } catch (e) {
    _userNameFailedAt.set(key, Date.now());
    logger.warn('lark', '用户姓名解析失败（降级为显示 id 尾号）', {
      id: key,
      err: e?.message || String(e),
    });
    return null;
  }
}

/** 创建长连接客户端（入口层 start 用）；creds 省略则读 getLarkCredentials，handlers 挂状态回调 */
export async function createWsClient(creds, handlers = {}) {
  const c = creds || getLarkCredentials();
  const Lark = await sdk();
  return new Lark.WSClient({
    appId: c.appId,
    appSecret: c.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
    onReady: handlers.onReady,
    onError: handlers.onError,
    onReconnecting: handlers.onReconnecting,
    onReconnected: handlers.onReconnected,
  });
}

/** 发送文本消息到会话 */
export async function sendText(chatId, text) {
  try {
    await (await getClient()).im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: 'text',
      },
    });
    logger.info('lark', '发送消息', { chatId, text: preview(text, 60) });
  } catch (e) {
    logger.error('lark', '发送消息失败', { chatId, err: e?.message || String(e) });
    throw e;
  }
}

/**
 * 发送 Markdown 渲染的消息（交互卡片）到会话。
 * 飞书文本消息不支持 Markdown 渲染，使用交互卡片的 markdown 元素可以原生渲染 **加粗**、## 标题 等格式。
 * 注：卡片内容有约 30KB 大小限制；超大内容应分片发送。
 */
export async function sendMarkdown(chatId, markdownText) {
  try {
    const cardContent = {
      schema: '2.0',
      body: {
        elements: [
          {
            tag: 'markdown',
            content: markdownText,
          },
        ],
      },
    };
    return await sendCard(chatId, cardContent);
  } catch (e) {
    // 卡片发送失败时降级为纯文本发送，避免用户收不到消息
    logger.warn('lark', '发送 Markdown 卡片失败，降级为纯文本', { chatId, err: e?.message || String(e) });
    try {
      await sendText(chatId, markdownText);
    } catch (fallbackErr) {
      logger.error('lark', '降级到纯文本发送也失败了', { chatId, err: fallbackErr?.message || String(fallbackErr) });
      throw fallbackErr;
    }
  }
}

/** 上传图片到飞书图床，返回 image_key（失败抛错，由调用方兜底）。SDK 接受 Buffer 直传。 */
export async function uploadImage(buf) {
  const r = await (await getClient()).im.v1.image.create({
    data: { image_type: 'message', image: buf },
  });
  // code-gen client 已剥外层信封 → image_key 在顶层；保留 .data.image_key 兜底
  const key = r?.image_key || r?.data?.image_key || null;
  if (!key) throw new Error('上传图片未返回 image_key');
  return key;
}

/** 发送图片消息（已有 image_key） */
export async function sendImage(chatId, imageKey) {
  await (await getClient()).im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      content: JSON.stringify({ image_key: imageKey }),
      msg_type: 'image',
    },
  });
  logger.info('lark', '发送图片', { chatId, imageKey });
}

/** 下载 URL 图片 → 上传飞书 → 发图片消息。失败抛错（调用方回退发文本 URL）。 */
export async function sendImageByUrl(chatId, url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载图片失败 HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const key = await uploadImage(buf);
  await sendImage(chatId, key);
}

/**
 * 上传文件到飞书，返回 file_key（失败抛错，由调用方兜底）。
 * 与 uploadImage 同构：code-gen client 已剥外层信封 → file_key 在顶层，保留 .data 兜底。
 *
 * 飞书限制：文件 ≤ 30MB，且不允许空文件。两条都在上传前挡掉 ——
 * 让接口去报是一串英文错误码，调用方没法转成给用户看的话，且白跑一次网络请求。
 * 任意扩展名走 file_type: 'stream'（飞书只给 opus/mp4/pdf/doc/xls/ppt 定了专用类型）。
 * @param {Buffer} buf
 * @param {string} fileName 带扩展名
 * @param {'opus'|'mp4'|'pdf'|'doc'|'xls'|'ppt'|'stream'} [fileType]
 */
export async function uploadFile(buf, fileName, fileType = 'stream') {
  // 空值判定放最前，保持原有错误文案不变（已有用例依赖它）
  if (!buf) throw new Error('不能上传空文件');
  // 类型闸：必须是 Buffer。传路径字符串是个**极具误导性**的错误 —— 字符串也有 .length，
  // 下面那道长度校验照样放行，SDK 会把路径本身当文件内容传上去。
  // 表现是「上传成功、附件也收到了」，只有打开才发现内容是 `C:\...\xxx.html` 这么一行
  //（2026-09-08 实测踩过）。挡在这里，比让每个调用方自己记得 readFile 可靠。
  if (typeof buf === 'string') {
    throw new Error('uploadFile 需要 Buffer，收到的是字符串（是不是把文件路径直接传进来了？请先 fs.readFile）');
  }
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) {
    throw new Error(`uploadFile 需要 Buffer，收到 ${Object.prototype.toString.call(buf)}`);
  }
  if (!buf.length) throw new Error('不能上传空文件');
  if (buf.length > 30 * 1024 * 1024) {
    throw new Error(`文件超过 30MB 限制（${(buf.length / 1024 / 1024).toFixed(1)}MB）`);
  }
  const r = await (await getClient()).im.v1.file.create({
    data: { file_type: fileType, file_name: fileName, file: buf },
  });
  const key = r?.file_key || r?.data?.file_key || null;
  if (!key) throw new Error('上传文件未返回 file_key');
  logger.info('lark', '上传文件', { fileName, bytes: buf.length, fileKey: key });
  return key;
}

/** 发送文件消息（已有 file_key） */
export async function sendFile(chatId, fileKey) {
  await (await getClient()).im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      content: JSON.stringify({ file_key: fileKey }),
      msg_type: 'file',
    },
  });
  logger.info('lark', '发送文件', { chatId, fileKey });
}

/** 本地路径 → 上传 → 发文件消息。失败抛错（调用方回退发文字摘要）。 */
export async function sendFileByPath(chatId, filePath, fileName) {
  const buf = await fsp.readFile(filePath);
  const key = await uploadFile(buf, fileName || path.basename(filePath));
  await sendFile(chatId, key);
}

/** 给消息贴表情；返回 reaction_id，失败返回 null（不影响主流程） */
export async function addReaction(messageId, emojiType) {
  if (!messageId) return null;
  try {
    const r = await (await getClient()).im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
    return r?.data?.reaction_id || null;
  } catch (e) {
    logger.warn('lark', '贴表情失败', { messageId, err: e?.message || String(e) });
    return null;
  }
}

/** 按魔数判断图片扩展名（飞书接口不回文件名）；识别不出按 png 兜底 */
function imageExt(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf.length >= 4 && buf.slice(0, 4).toString('ascii') === 'GIF8') return '.gif';
  if (buf.length >= 12 && buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return '.png';
}

/**
 * 下载消息内资源（图片/文件）到 .uploads/feishu/，返回本地绝对路径；失败返回 null（不影响主流程）。
 * @param {string} messageId
 * @param {string} fileKey   消息 content 里的 image_key / file_key
 * @param {'image'|'file'} type
 * @param {string} [fileName]  文件消息原始文件名（可选，向后兼容）；传入时保留清洗后的名称供 Claude 识别扩展名
 */
export async function downloadMessageResource(messageId, fileKey, type = 'image', fileName = '') {
  try {
    const resp = await (await getClient()).im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    const chunks = [];
    for await (const c of await resp.getReadableStream()) chunks.push(c);
    const buf = Buffer.concat(chunks);
    fs.mkdirSync(RESOURCE_DIR, { recursive: true });
    // 文件消息带原始文件名 → 保留（清洗+截尾），Claude 按扩展名识别；图片仍按魔数判扩展名
    const safeName = fileName ? fileName.replace(/[^\w.一-龥-]+/g, '_').slice(-60) : '';
    const suffix = type === 'file' && safeName ? '-' + safeName : imageExt(buf);
    const file = path.join(
      RESOURCE_DIR,
      Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + suffix,
    );
    fs.writeFileSync(file, buf);
    logger.info('lark', '下载消息资源', { messageId, fileKey, file, bytes: buf.length });
    return file;
  } catch (e) {
    // 收集完整的错误上下文：SDK 错误、飞书业务码、HTTP 状态、资源类型
    const errCtx = {
      messageId,
      fileKey,
      type,
      fileName,
      errorMessage: e?.message || String(e),
      // SDK 错误对象的业务码、msg、HTTP 状态（若有）
      feishuCode: e?.code || e?.response?.data?.code,
      feishuMsg: e?.msg || e?.response?.data?.msg,
      httpStatus: e?.response?.status || e?.statusCode,
      // 完整错误对象用于调试（可选，避免过大）
      ...(e?.response?.data && { feishuResponse: e.response.data }),
    };
    logger.error('lark', '下载消息资源失败', errCtx);
    return null;
  }
}

/**
 * 拉取飞书云文档纯文本（docx OpenAPI）。
 * 前置：应用需 docx:document:readonly 权限，且文档对机器人可见（分享协作者/组织内可读）。
 * 无权限/不存在 → 抛错（调用方回复引导话术，不静默丢材料）。
 */
export async function fetchDocRawContent(documentId) {
  const r = await (await getClient()).docx.v1.document.rawContent({ path: { document_id: documentId } });
  const content = r?.data?.content ?? r?.content;
  if (typeof content !== 'string') throw new Error(`raw_content 无内容返回${r?.code ? `（code=${r.code} ${r?.msg || ''}）` : ''}`);
  return content;
}

/**
 * wiki 节点信息（需 wiki:wiki:readonly）：返回 { objType, objToken }，节点缺失返回 null。
 * 业务错误（无权限/不存在）抛错。docx / bitable 等类型的分流由调用方决定。
 */
export async function resolveWikiNodeObj(token) {
  const r = await (await getClient()).request({
    method: 'GET',
    url: '/open-apis/wiki/v2/spaces/get_node',
    params: { token },
  });
  // SDK generic request 不校验业务 code；HTTP 200 + code!=0 表示业务失败，需显式抛错
  if (r?.code) throw new Error(`wiki get_node 失败: ${r.msg || r.code}`);
  const node = r?.data?.node || r?.node;
  return node?.obj_type ? { objType: node.obj_type, objToken: node.obj_token || null } : null;
}

/** wiki 链接换 docx token；仅非 docx 节点返回 null（行为不变，基于 resolveWikiNodeObj） */
export async function resolveWikiNode(token) {
  const node = await resolveWikiNodeObj(token);
  return node?.objType === 'docx' ? node.objToken : null;
}

// —— 多维表格（bitable）——巡检链路用。需应用开通 bitable:app 权限并发布版本，且表格对机器人可见。

/** 列出多维表格下的数据表：[{ table_id, name }] */
export async function listBitableTables(appToken) {
  const r = await (await getClient()).bitable.v1.appTable.list({
    path: { app_token: appToken },
    params: { page_size: 100 },
  });
  if (r?.code) throw new Error(`bitable 列数据表失败: ${r.msg || r.code}`);
  return (r?.data?.items || r?.items || []).map((t) => ({ tableId: t.table_id, name: t.name || '' }));
}

/** 列出数据表字段：[{ field_name, type, ui_type, property }]（选项值在 property.options） */
export async function listBitableFields(appToken, tableId) {
  const r = await (await getClient()).bitable.v1.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 100 },
  });
  if (r?.code) throw new Error(`bitable 列字段失败: ${r.msg || r.code}`);
  return r?.data?.items || r?.items || [];
}

/**
 * 查询记录（user_id_type=open_id，人员字段返回 open_id 供比对）。
 * filter 传 search 接口的 filter 对象（如 状态=待处理）；分页拉全，安全上限 1000 条防失控。
 * @returns {Array<{record_id, fields}>}
 */
export async function searchBitableRecords(appToken, tableId, { filter } = {}) {
  const out = [];
  let pageToken;
  const MAX_RECORDS = 1000;
  do {
    const r = await (await getClient()).bitable.v1.appTableRecord.search({
      path: { app_token: appToken, table_id: tableId },
      params: { user_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
      data: filter ? { filter } : {},
    });
    if (r?.code) throw new Error(`bitable 查记录失败: ${r.msg || r.code}`);
    const d = r?.data || r || {};
    out.push(...(d.items || []));
    pageToken = d.has_more ? d.page_token : null;
  } while (pageToken && out.length < MAX_RECORDS);
  return out;
}

/** 更新单条记录的字段（fields 只含要改的字段，如 { 进展状态: '修复中' }） */
export async function updateBitableRecord(appToken, tableId, recordId, fields) {
  const r = await (await getClient()).bitable.v1.appTableRecord.update({
    path: { app_token: appToken, table_id: tableId, record_id: recordId },
    params: { user_id_type: 'open_id' },
    data: { fields },
  });
  if (r?.code) throw new Error(`bitable 改记录失败: ${r.msg || r.code}`);
  logger.info('lark', 'bitable 记录已更新', { appToken, tableId, recordId, fields: preview(JSON.stringify(fields), 80) });
  return true;
}

/** 移除消息表情 */
export async function removeReaction(messageId, reactionId) {
  if (!messageId || !reactionId) return;
  try {
    await (await getClient()).im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  } catch (e) {
    logger.warn('lark', '移除表情失败', { messageId, err: e?.message || String(e) });
  }
}

/**
 * 发送交互卡片消息到会话
 * @param {string} chatId - 会话 ID
 * @param {object} cardContent - 卡片 JSON 内容（完整的 elements 结构）
 * @returns {Promise<string|null>} message_id；SDK 未返回时为 null
 */
export async function sendCard(chatId, cardContent) {
  try {
    const r = await (await getClient()).im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify(cardContent),
        msg_type: 'interactive',
      },
    });
    logger.info('lark', '发送卡片消息', { chatId });
    // code-gen client 可能已剥外层信封（对齐 uploadImage 的兜底写法）；拿不到返回 null，调用方自行兜底
    return r?.data?.message_id || r?.message_id || null;
  } catch (e) {
    logger.error('lark', '发送卡片消息失败', { chatId, err: e?.message || String(e) });
    throw e;
  }
}

/**
 * 更新交互卡片消息（替换卡片内容）
 * @param {string} messageId - 消息 ID
 * @param {object} cardContent - 新的卡片 JSON 内容
 */
export async function updateCard(messageId, cardContent) {
  try {
    await (await getClient()).im.v1.message.patch({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(cardContent),
      },
    });
    logger.info('lark', '更新卡片消息', { messageId });
  } catch (e) {
    logger.error('lark', '更新卡片消息失败', { messageId, err: e?.message || String(e) });
    throw e;
  }
}

/**
 * 下载消息内资源，返回 { file, error } 对象。
 * error 为 null 表示成功；error 为对象时包含 code/msg/httpStatus 供上层按类型提示。
 * @param {string} messageId
 * @param {string} fileKey
 * @param {'image'|'file'} type
 * @param {string} [fileName]
 * @returns {Promise<{file: string|null, error: {code: string|number, msg: string, httpStatus: number}|null}>}
 */
export async function downloadMessageResourceWithError(messageId, fileKey, type = 'image', fileName = '') {
  try {
    const resp = await (await getClient()).im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    const chunks = [];
    for await (const c of await resp.getReadableStream()) chunks.push(c);
    const buf = Buffer.concat(chunks);
    fs.mkdirSync(RESOURCE_DIR, { recursive: true });
    const safeName = fileName ? fileName.replace(/[^\w.一-龥-]+/g, '_').slice(-60) : '';
    const suffix = type === 'file' && safeName ? '-' + safeName : imageExt(buf);
    const file = path.join(
      RESOURCE_DIR,
      Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + suffix,
    );
    fs.writeFileSync(file, buf);
    logger.info('lark', '下载消息资源', { messageId, fileKey, file, bytes: buf.length });
    return { file, error: null };
  } catch (e) {
    const errCtx = {
      messageId,
      fileKey,
      type,
      fileName,
      errorMessage: e?.message || String(e),
      feishuCode: e?.code || e?.response?.data?.code,
      feishuMsg: e?.response?.data?.msg,
      httpStatus: e?.response?.status || e?.statusCode,
      ...(e?.response?.data && { feishuResponse: e.response.data }),
    };
    logger.error('lark', '下载消息资源失败', errCtx);
    return {
      file: null,
      error: {
        code: errCtx.feishuCode || 'UNKNOWN_ERROR',
        msg: errCtx.feishuMsg || errCtx.errorMessage || 'Unknown error',
        httpStatus: errCtx.httpStatus,
        type,
      },
    };
  }
}

/**
 * 使用指定机器人凭证向用户 open_id 发送文本消息（私聊）。
 * 用于 docgen 完成通知等场景，不影响全局 singleton client。
 * 失败不抛错，仅日志记录。
 *
 * 返回布尔而不是 void：调用方需要区分「确实发出去了」与「静默失败」。
 * 会话通知据此决定要不要写 lastNotifiedAt —— 那个时间戳会被飞书侧
 * pickLatestNotified 当作「用户最近收到过通知的会话」来定位注入目标，
 * 若在压根没送达时也写上，用户裸发的补充内容就会被注入到错误的会话里。
 * @param {{ appId: string, appSecret: string }} botCreds
 * @param {string} openId
 * @param {string} text
 * @returns {Promise<boolean>} 是否确实发送成功
 */
export async function sendTextToUser(botCreds, openId, text) {
  if (!botCreds?.appId || !botCreds?.appSecret) {
    logger.warn('lark', '机器人凭证不完整，跳过通知', { openId });
    return false;
  }
  if (!openId) {
    logger.warn('lark', '目标 open_id 为空，跳过通知');
    return false;
  }
  try {
    // 创建临时 client，不影响全局 singleton
    const Lark = await sdk();
    const tempClient = new Lark.Client({
      appId: botCreds.appId,
      appSecret: botCreds.appSecret,
    });
    await tempClient.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        content: JSON.stringify({ text }),
        msg_type: 'text',
      },
    });
    logger.info('lark', '已发送通知给用户', { openId, text: preview(text, 60) });
    return true;
  } catch (e) {
    logger.warn('lark', '发送用户通知失败（不影响主流程）', { openId, err: e?.message || String(e) });
    return false; // 不抛错，fire-and-forget；由调用方按需决定要不要降级
  }
}

/**
 * 使用指定机器人凭证向用户 open_id 发送**交互卡片**（私聊）。
 * 与 sendTextToUser 同构（临时 client，不动全局 singleton），补上「私聊发卡片」这个缺口：
 * 既有的 sendCard 只能发 chat_id 且用全局启用机器人的凭证。
 * 失败不抛，返回 null —— 调用方据此降级发纯文本。
 * @returns {Promise<string|null>} message_id
 */
export async function sendCardToUser(botCreds, openId, cardContent) {
  if (!botCreds?.appId || !botCreds?.appSecret) {
    logger.warn('lark', '机器人凭证不完整，跳过卡片通知', { openId });
    return null;
  }
  if (!openId) {
    logger.warn('lark', '目标 open_id 为空，跳过卡片通知');
    return null;
  }
  try {
    const Lark = await sdk();
    const tempClient = new Lark.Client({ appId: botCreds.appId, appSecret: botCreds.appSecret });
    const r = await tempClient.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        content: JSON.stringify(cardContent),
        msg_type: 'interactive',
      },
    });
    logger.info('lark', '已发送卡片通知给用户', { openId });
    // code-gen client 可能已剥外层信封（对齐 sendCard 的兜底写法）
    return r?.data?.message_id || r?.message_id || null;
  } catch (e) {
    logger.warn('lark', '发送卡片通知失败（调用方将降级纯文本）', { openId, err: e?.message || String(e) });
    return null;
  }
}

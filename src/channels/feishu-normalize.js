/**
 * 飞书入站报文解析（纯函数，单测目标）。
 * 只做 JSON → 结构化抽取，不做网络下载——图片下载由 channel 组合层负责。
 */

/** text 消息 content → 纯文本（解析失败返回空串） */
export function parseTextContent(content) {
  try {
    return (JSON.parse(content).text || '').trim();
  } catch {
    return '';
  }
}

/** image 消息 content → image_key（解析失败返回空串） */
export function parseImageContent(content) {
  try {
    return JSON.parse(content).image_key || '';
  } catch {
    return '';
  }
}

/**
 * post 富文本 content → { text, imageKeys }。
 * 文字按段拼接（title 置首）；内嵌图片只收集 key，下载与「[附图] 路径」拼接由组合层完成。
 */
export function parsePostContent(content) {
  let post;
  try {
    post = JSON.parse(content);
  } catch {
    return { text: '', imageKeys: [] };
  }
  const lines = [];
  const imageKeys = [];
  for (const paragraph of post.content || []) {
    const parts = [];
    for (const node of paragraph || []) {
      if (node.tag === 'text' && node.text) parts.push(node.text);
      else if (node.tag === 'a') {
        // href 一并保留：云文档链接靠它被 extractDocLinks 识别（此前只取 text，URL 丢失）
        const s = [node.text, node.href].filter(Boolean).join(' ');
        if (s) parts.push(s);
      }
      else if (node.tag === 'img' && node.image_key) imageKeys.push(node.image_key);
    }
    if (parts.length) lines.push(parts.join(''));
  }
  const text = [post.title, ...lines].filter(Boolean).join('\n').trim();
  return { text, imageKeys };
}

/** file 消息 content → { fileKey, fileName }（解析失败返回 null） */
export function parseFileContent(content) {
  try {
    const c = JSON.parse(content);
    return c.file_key ? { fileKey: c.file_key, fileName: c.file_name || '' } : null;
  } catch {
    return null;
  }
}

// 飞书云文档链接（docx 直链 / wiki 需换 token）；token 后吞掉 ASCII query（遇中文/全角标点即停，防止误吞正文）
const DOC_LINK_RE = /https?:\/\/[\w.-]+\.(?:feishu\.cn|larksuite\.com)\/(docx|wiki)\/([A-Za-z0-9]+)(?:\?[\w&=%.~-]*)?/g;

/** 抽取文本中的云文档链接：[{ url, kind:'docx'|'wiki', token }] */
export function extractDocLinks(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(DOC_LINK_RE)) {
    out.push({ url: m[0], kind: m[1], token: m[2] });
  }
  return out;
}

/** 去掉云文档链接后的剩余文本（判断消息是否「纯链接」） */
export function stripDocLinks(text) {
  return String(text ?? '').replace(DOC_LINK_RE, '').trim();
}

/**
 * mentions 报文 → [{ key, openId, name }]。
 * 飞书群聊里被 @ 的人以 mentions 数组给出，正文里对应位置是 `@_user_N` 占位符。
 */
export function parseMentions(message) {
  const arr = message?.mentions;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((m) => ({ key: m?.key || '', openId: m?.id?.open_id || '', name: m?.name || '' }))
    .filter((m) => m.key && m.openId);
}

/**
 * 剥掉正文里的 `@_user_N` 占位符并压缩空白。
 * 不做这一步的话，「@_user_1 提交需求：xxx」会带着占位符进意图识别与任务 title（历史污染源）。
 * 按 key 长度降序替换：避免 `@_user_1` 先把 `@_user_10` 的前缀吃掉。
 */
export function stripMentions(text, mentions) {
  let t = String(text ?? '');
  const keys = (Array.isArray(mentions) ? mentions : [])
    .map((m) => m?.key)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const key of keys) {
    // key 形如 @_user_1，只含固定字符集，无需转义；不加 g flag 会漏掉重复 @，故用 split/join 替代
    t = t.split(key).join(' ');
  }
  return t.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

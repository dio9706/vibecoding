/**
 * 联网工具纯函数层（自定义模型路径）：URL 校验 / HTML→文本 / 搜索请求构造与响应解析。
 * 运行时（fetch/超时/上限）在 `web-tools.js`；本层零 IO、可直测。
 *
 * 搜索服务商适配：tavily / brave / bocha（博查）——任配其一（settings.search）。
 */

/** 仅放行 http/https；其余协议/垃圾串返回 null（调用方回错误文案） */
export function normalizeFetchUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.toString();
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', middot: '·', copy: '©', reg: '®', trade: '™',
};

/** 解 HTML 实体（命名 + 十进制/十六进制数字实体；未知实体原样保留） */
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const n = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      try {
        return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : m;
      } catch {
        return m;
      }
    }
    const key = body.toLowerCase();
    return Object.hasOwn(ENTITIES, key) ? ENTITIES[key] : m;
  });
}

/** 中段截断（保留头尾，标注略去字数） */
export function clipText(s, max) {
  const str = String(s ?? '');
  const cap = Number(max) > 0 ? Math.floor(Number(max)) : 0;
  if (!cap || str.length <= cap) return str;
  const head = Math.floor(cap * 0.6);
  const tail = cap - head;
  return str.slice(0, head) + `\n…（略 ${str.length - cap} 字符）…\n` + str.slice(-tail);
}

/**
 * HTML → 可读文本：去 script/style/noscript、块级标签转换行、剥标签、解实体、压缩空白。
 * @returns {{title: string, text: string}}
 */
export function htmlToText(html, { maxChars = 30000 } = {}) {
  const src = String(html ?? '');
  const titleMatch = src.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  let s = src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, arr) => line || (i > 0 && arr[i - 1])) // 折叠连续空行
    .join('\n')
    .trim();
  return { title, text: clipText(s, maxChars) };
}

/** 支持的搜索服务商 */
export const SEARCH_PROVIDERS = Object.freeze(['tavily', 'brave', 'bocha']);

/**
 * 构造某家的搜索请求。未支持的服务商/空 query → `{ error }`（调用方转成工具文案，不抛）。
 * @returns {{url:string, init:object}|{error:string}}
 */
export function buildSearchRequest(provider, { query, count = 5, apiKey } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return { error: 'query 不能为空' };
  const key = String(apiKey ?? '').trim();
  if (!key) return { error: '未配置搜索 API key（设置页「联网搜索」）' };
  const n = Math.min(10, Math.max(1, Math.floor(Number(count) || 5)));
  if (provider === 'tavily') {
    return {
      url: 'https://api.tavily.com/search',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ query: q, max_results: n, search_depth: 'basic' }),
      },
    };
  }
  if (provider === 'brave') {
    return {
      url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`,
      init: { method: 'GET', headers: { Accept: 'application/json', 'X-Subscription-Token': key } },
    };
  }
  if (provider === 'bocha') {
    return {
      url: 'https://api.bochaai.com/v1/web-search',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ query: q, count: n, summary: false }),
      },
    };
  }
  return { error: `未配置搜索服务商（支持：${SEARCH_PROVIDERS.join(' / ')}）` };
}

/**
 * 解析某家搜索响应 → `[{title,url,snippet}]`；形状无法识别返回 null。
 */
export function parseSearchResults(provider, payload) {
  const pick = (arr, map) => (Array.isArray(arr) ? arr.map(map).filter((r) => r && r.url) : null);
  if (provider === 'tavily') {
    return pick(payload?.results, (r) => ({ title: String(r?.title || r?.url || ''), url: String(r?.url || ''), snippet: String(r?.content || '') }));
  }
  if (provider === 'brave') {
    return pick(payload?.web?.results, (r) => ({ title: String(r?.title || r?.url || ''), url: String(r?.url || ''), snippet: String(r?.description || '') }));
  }
  if (provider === 'bocha') {
    return pick(payload?.data?.webPages?.value, (r) => ({ title: String(r?.name || r?.url || ''), url: String(r?.url || ''), snippet: String(r?.snippet || '') }));
  }
  return null;
}

/** 搜索结果 → 给模型的文本（编号列表；条数与摘要截断） */
export function formatSearchResults(query, results, { maxItems = 10, maxSnippet = 240 } = {}) {
  const list = Array.isArray(results) ? results.slice(0, maxItems) : [];
  if (!list.length) return `「${query}」没有搜索结果。`;
  const lines = list.map((r, i) => {
    const snip = String(r.snippet || '').replace(/\s+/g, ' ').trim();
    return `${i + 1}. ${r.title || r.url}\n   ${r.url}${snip ? `\n   ${clipText(snip, maxSnippet)}` : ''}`;
  });
  return `搜索「${query}」的结果：\n${lines.join('\n')}`;
}

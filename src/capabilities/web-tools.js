/**
 * 联网工具运行时（自定义模型路径）：WebFetch + WebSearch。
 *
 * - WebFetch：抓 URL → HTML 转可读文本；15s 超时、1MB 上限（流式截断，桩实现回落 text()）。
 * - WebSearch：按 settings.search 的 provider/apiKey 调搜索 API（tavily/brave/bocha）；未配置时
 *   返回指引文案（模型可转述给用户），不发请求。
 * - 审批由策略表负责：两个工具名都在 `NET_TOOLS`（网络类）——default 档弹确认、bypass/无人值守放行。
 * - `fetchImpl/timeoutMs/maxBytes` 注入点仅测试用（仓内 provider-models 同款范式）。
 */
import { z } from 'zod';
import { logger } from '../shared/logger.js';
import {
  normalizeFetchUrl,
  htmlToText,
  clipText,
  buildSearchRequest,
  parseSearchResults,
  formatSearchResults,
  SEARCH_PROVIDERS,
} from './web-tools.logic.js';

export const WEB_FETCH_TIMEOUT_MS = 15000;
export const WEB_FETCH_MAX_BYTES = 1024 * 1024;
export const WEB_FETCH_DEFAULT_CHARS = 30000;
export const WEB_FETCH_MAX_CHARS = 100000;
export const WEB_SEARCH_TIMEOUT_MS = 12000;
export const WEB_SEARCH_MAX_BYTES = 512 * 1024;

/** 读响应体并做字节上限；有 body 流时流式读取，桩实现回落 text() */
async function readBodyCapped(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    if (text.length > maxBytes) return { text: text.slice(0, maxBytes), truncated: true };
    return { text, truncated: false };
  }
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value?.length || 0;
    if (size > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* 关流失败不掩盖截断主因 */
      }
      truncated = true;
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), truncated };
}

function errText(e, fallback) {
  const name = e?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return '错误：请求超时';
  return `错误：${fallback || e?.message || String(e)}`;
}

/**
 * 组装联网工具集。
 * @param {object} p
 * @param {{provider?:string, apiKey?:string}} [p.search] settings.search
 * @returns {{toolDefs:object, executeTool:(name:string,input:any)=>Promise<string>}}
 */
export function createWebTools({ search = {}, fetchImpl = fetch } = {}) {
  const provider = SEARCH_PROVIDERS.includes(search?.provider) ? search.provider : '';
  const apiKey = typeof search?.apiKey === 'string' ? search.apiKey.trim() : '';

  const toolDefs = {
    WebFetch: {
      description:
        '抓取一个网页并转成可读文本（仅 http/https；自动去除脚本、样式与 HTML 标签）。' +
        '返回 URL、状态码与正文（过长会截断）。查资料、看文档时用。',
      inputSchema: z.object({
        url: z.string().describe('要抓取的完整 URL（http/https）'),
        max_chars: z.number().int().positive().optional().describe(`正文最大字符数（默认 ${WEB_FETCH_DEFAULT_CHARS}，上限 ${WEB_FETCH_MAX_CHARS}）`),
      }),
    },
    WebSearch: {
      description: provider
        ? `联网搜索（${provider}），返回标题、链接与摘要列表。需要最新信息或不确定网址时先搜后用 WebFetch。`
        : '联网搜索（当前未配置搜索服务商与 API key——请到「设置 > 基础 > 联网搜索」填写后再试）。',
      inputSchema: z.object({
        query: z.string().describe('搜索关键词'),
        count: z.number().int().positive().optional().describe('返回条数（默认 5，上限 10）'),
      }),
    },
  };

  async function webFetch(input) {
    const url = normalizeFetchUrl(input?.url);
    if (!url) return '错误：只支持 http/https 链接';
    const maxChars = Math.min(WEB_FETCH_MAX_CHARS, Math.max(1000, Math.floor(Number(input?.max_chars) || WEB_FETCH_DEFAULT_CHARS)));
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'principal-desktop-webfetch/1.0',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
        signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      logger.warn('web-tools', 'WebFetch 请求失败', { url, err: e?.message || String(e) });
      return errText(e, `无法连接：${e?.message || e}`);
    }
    if (!res.ok) return `错误：上游返回 HTTP ${res.status}`;
    let body;
    try {
      body = await readBodyCapped(res, WEB_FETCH_MAX_BYTES);
    } catch (e) {
      return errText(e, `读取响应失败：${e?.message || e}`);
    }
    const contentType = String(res.headers?.get?.('content-type') || '');
    const raw = body.text;
    let text;
    let title = '';
    if (contentType.includes('json') || contentType.includes('text/plain') || (!contentType.includes('html') && !/<[a-z][\s\S]*>/i.test(raw.slice(0, 2000)))) {
      text = clipText(raw, maxChars);
    } else {
      ({ title, text } = htmlToText(raw, { maxChars }));
    }
    const head = [`URL: ${url}`, `Status: ${res.status}` + (title ? `\nTitle: ${title}` : '') + (body.truncated ? '\n(响应体超 1MB 已截断)' : '')];
    return `${head.join('\n')}\n\n${text || '(无正文)'}`;
  }

  async function webSearch(input) {
    const built = buildSearchRequest(provider, { query: input?.query, count: input?.count, apiKey });
    if (built.error) return `错误：${built.error}`;
    let res;
    try {
      res = await fetchImpl(built.url, { ...built.init, signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS) });
    } catch (e) {
      logger.warn('web-tools', 'WebSearch 请求失败', { provider, err: e?.message || String(e) });
      return errText(e, `无法连接搜索服务：${e?.message || e}`);
    }
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? '（请检查 API key）' : '';
      return `错误：搜索服务返回 HTTP ${res.status}${hint}`;
    }
    let payload;
    try {
      const body = await readBodyCapped(res, WEB_SEARCH_MAX_BYTES);
      payload = JSON.parse(body.text);
    } catch (e) {
      return errText(e, '搜索响应不是合法 JSON');
    }
    const results = parseSearchResults(provider, payload);
    if (results === null) return '错误：无法识别的搜索响应格式';
    return formatSearchResults(String(input?.query || ''), results);
  }

  async function executeTool(name, input) {
    if (name === 'WebFetch') return webFetch(input);
    if (name === 'WebSearch') return webSearch(input);
    return `错误：未知的联网工具 ${name}`;
  }

  return { toolDefs, executeTool };
}

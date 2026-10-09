/**
 * 服务商模型列表拉取 —— 运行时（设置页「获取模型」按钮的后端代理）。
 * 前端直连第三方端点会被 CORS 拦，且 key 不该拼进浏览器直连的 URL；统一由本地服务代发。
 *
 * 安全口径：仅 http(s)（`modelsEndpoint` 校验）、10s 超时、响应体 1MB 截断、key 只进请求头。
 * `fetchImpl/timeoutMs/maxBytes` 是测试注入点（仓内 `builtin-mcp.js` 的 probe 同款范式）。
 */
import { modelsEndpoint, extractModels } from './provider-models.logic.js';

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** 读响应体并做字节上限；走流式读取，超限即断开（桩实现没有 body 流时回落 text()） */
async function readTextCapped(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    if (text.length > maxBytes) throw new Error('响应过大');
    return text;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value?.length || 0;
    if (size > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* 关流失败不掩盖「过大」这个主因 */
      }
      throw new Error('响应过大');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * 拉取服务商的 OpenAI 兼容模型列表。
 * @param {object} p
 * @param {string} p.baseURL 形如 `https://api.deepseek.com/v1`
 * @param {string} [p.apiKey] 可空（本地端点常免鉴权）；非空发 `Authorization: Bearer`
 * @returns {Promise<Array<{id:string, name?:string}>>} 失败抛出人话 Error
 */
export async function fetchProviderModels({
  baseURL,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
} = {}) {
  const url = modelsEndpoint(baseURL);
  if (!url) throw new Error('baseURL 无效（需 http/https）');

  const headers = { Accept: 'application/json' };
  const key = String(apiKey ?? '').trim();
  if (key) headers.Authorization = `Bearer ${key}`;

  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error('请求超时');
    throw new Error('无法连接：' + (e?.message || e));
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(`鉴权失败（HTTP ${res.status}），请检查 apiKey`);
    if (res.status === 404) throw new Error('服务商无 /models 端点（HTTP 404）');
    throw new Error(`上游返回 HTTP ${res.status}`);
  }

  const text = await readTextCapped(res, maxBytes);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('响应不是合法 JSON');
  }
  const models = extractModels(payload);
  if (models === null) throw new Error('无法识别的响应格式');
  return models;
}

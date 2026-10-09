/**
 * 服务商模型列表拉取 —— 纯函数层（T7 之外的设置页小能力，spec
 * `docs/superpowers/specs/2026-10-08-provider-model-list-fetch-design.md`）。
 *
 * 背景：`vendor-presets` 静态列表天然滞后（DeepSeek 已由 deepseek-chat 切到
 * deepseek-flash），设置页「获取模型」按 baseURL + apiKey 现拉 `GET {base}/models` 现填。
 * 本层只管「拼端点」与「解析响应」，网络在 provider-models.js。
 */

/** 单次拉取的模型条数上限（端点返回大量无关条目时的兜底） */
export const MAX_MODELS = 300;

/**
 * 从 baseURL 拼出 OpenAI 兼容的 `/models` 端点。
 * 规则：去尾斜杠；已以 `/models` 结尾时原样返回（幂等，用户误填完整端点也不 double）；
 * 仅接受 http/https；非法入参返回 null（调用方回 400/抛错）。
 * @returns {string|null}
 */
export function modelsEndpoint(baseURL) {
  const s = String(baseURL ?? '').trim().replace(/\/+$/, '');
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return s.endsWith('/models') ? s : s + '/models';
}

/**
 * 从 /models 条目解析强度元数据（DeepSeek 形态 `effort: { supported_levels, default_level }`）。
 * 只在合法时带上字段，保持条目形状干净（老端点没有 effort → 不带）。
 */
function itemEffort(item) {
  const e = item && typeof item === 'object' ? item.effort : null;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return {};
  const levels = Array.isArray(e.supported_levels)
    ? [...new Set(e.supported_levels.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean))]
    : [];
  const def = typeof e.default_level === 'string' ? e.default_level.trim() : '';
  const out = {};
  if (levels.length) out.efforts = levels;
  if (def && levels.includes(def)) out.defaultEffort = def;
  return out;
}

/**
 * 解析「列模型」响应体。兼容三种形状：
 *  - OpenAI 兼容标准 `{ object:'list', data:[{ id, name?, ... }] }`（DeepSeek 同款，带展示名与 effort 元数据）；
 *  - `{ models:[...] }`（条目取 `model` 或 `name`/`id`）；
 *  - 裸数组（字符串或对象混合）。
 * 去重、保序（尊重服务商推荐顺序），上限 MAX_MODELS。
 * @returns {Array<{id:string, name?:string, efforts?:string[], defaultEffort?:string}>|null} 无法识别返回 null
 */
export function extractModels(payload, { max = MAX_MODELS } = {}) {
  const arr = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : null;
  if (!arr) return null;

  const out = [];
  const seen = new Set();
  for (const item of arr) {
    let id = '';
    let name = '';
    if (typeof item === 'string') {
      id = item.trim();
    } else if (item && typeof item === 'object') {
      // openai 系取 id；ollama 原生清单用 model 字段
      id = String(item.id ?? item.model ?? '').trim();
      name = typeof item.name === 'string' ? item.name.trim() : '';
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, ...(name && name !== id ? { name } : {}), ...itemEffort(item) });
    if (out.length >= Math.max(1, Number(max) || MAX_MODELS)) break;
  }
  return out;
}

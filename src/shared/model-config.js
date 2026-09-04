/**
 * 各模型上下文窗口大小（单位：tokens）。
 * 前端用于计算 context 占用百分比，后端用于配置验证。
 */

/** 未知模型的兜底上下文窗口大小，与 Claude 最新主力模型对齐 */
const DEFAULT_CONTEXT_WINDOW = 200000;

export const MODEL_CONTEXT_WINDOWS = {
  // Anthropic Claude
  'claude-opus-5': DEFAULT_CONTEXT_WINDOW,
  'claude-opus-4': DEFAULT_CONTEXT_WINDOW,
  'claude-sonnet-5': DEFAULT_CONTEXT_WINDOW,
  'claude-sonnet-4': DEFAULT_CONTEXT_WINDOW,
  'claude-haiku-4-5': 100000,
  'claude-haiku-3': 100000,

  // OpenAI 兼容
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16000,
};

/**
 * 获取模型的上下文窗口大小。
 * @param {string|null|undefined} modelName
 * @returns {number} 上下文窗口大小；未知模型按最新 Claude 主力模型降级
 */
export function getContextWindow(modelName) {
  if (!modelName || typeof modelName !== 'string') return DEFAULT_CONTEXT_WINDOW;
  if (MODEL_CONTEXT_WINDOWS[modelName]) return MODEL_CONTEXT_WINDOWS[modelName];

  // 前缀匹配：处理带日期后缀的变体，如 claude-sonnet-4-20250514
  for (const [model, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (modelName.startsWith(model)) return size;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

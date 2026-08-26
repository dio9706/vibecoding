/** 自定义模型（openai-compat）凭证的厂商预设与 baseURL 反查表。
 *  独立成模块的原因：设置页与新用户引导两处都要用；留在 settings-panel.js 里的话
 *  第二个使用方只能复制一份，加厂商就变成改两处、必然漂移。
 *  纯数据、无副作用，node 下可直接 import 单测。 */

export const VENDOR_PRESETS = {
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o3-mini'],
  },
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  aliyun: {
    label: '阿里云百炼',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
  },
  moonshot: {
    label: '月之暗面',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  zhipu: {
    label: '智谱',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4', 'glm-4-flash'],
  },
  custom: {
    label: '其他（自定义）',
    baseURL: '',
    models: [],
  },
};

// baseURL → vendor key 反查表：vendor 字段是后加的，存量凭证没有它，
// 靠 baseURL 推回厂商，省掉一次数据迁移。
// 必须过滤空 baseURL —— custom 预设的 baseURL 是空串，不排除的话
// 会在表里占据 '' 这个键，把所有缺 baseURL 的凭证误判成「其他（自定义）」。
export const BASEURL_TO_VENDOR = Object.fromEntries(
  Object.entries(VENDOR_PRESETS)
    .filter(([, p]) => p.baseURL)
    .map(([k, p]) => [p.baseURL, k]),
);

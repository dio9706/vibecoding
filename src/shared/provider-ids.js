/**
 * Provider 标识共享常量。
 * DEFAULT_PROVIDER_ID = 未显式指定 provider 时的归属（Claude Agent SDK）：
 * 旧数据缺 providerId 字段的回填、run 路由缺省、token 池筛选缺省都用它，
 * 单点定义防字面量漂移。注意：claude-agent provider 自身的 id 定义在
 * providers/claude-agent.js（intrinsic 值），与「默认」是两个概念，勿混用。
 */
export const DEFAULT_PROVIDER_ID = 'claude-agent';

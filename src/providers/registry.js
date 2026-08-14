/**
 * 纯注册表工厂 —— 内核与模型实现之间的唯一入口。
 * 无内置 provider，便于隔离单测；默认实例在 index.js 组装。
 */
export function createRegistry() {
  const map = new Map();
  return {
    /** 注册 provider（同 id 覆盖，便于测试注入替身）；校验形状 */
    register(provider) {
      if (!provider || typeof provider.id !== 'string')
        throw new Error('register: provider 必须含 string id');
      if (typeof provider.run !== 'function')
        throw new Error('register: provider 必须含 run 函数');
      map.set(provider.id, provider);
      return provider;
    },
    /** 取 provider；未注册即抛（调用方须显式处理未知 provider） */
    get(id) {
      const p = map.get(id);
      if (!p) throw new Error(`未知 provider: ${id}`);
      return p;
    },
    has: (id) => map.has(id),
    /** 列出 { id, capabilities }，供设置页/诊断展示 */
    list: () => [...map.values()].map((p) => ({ id: p.id, capabilities: p.capabilities })),
  };
}

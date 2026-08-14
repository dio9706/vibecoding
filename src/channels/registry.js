/**
 * Channel 纯注册表工厂 —— 组装层与渠道实现之间的唯一入口（家风同 providers/registry）。
 * 无内置 channel，便于隔离单测；默认实例在 index.js 组装。
 */
export function createRegistry() {
  const map = new Map();
  return {
    /** 注册 channel（同 id 覆盖，便于测试注入替身）；校验最小契约形状 */
    register(channel) {
      if (!channel || typeof channel.id !== 'string')
        throw new Error('register: channel 必须含 string id');
      if (typeof channel.start !== 'function')
        throw new Error('register: channel 必须含 start 函数');
      if (typeof channel.send !== 'function')
        throw new Error('register: channel 必须含 send 函数');
      map.set(channel.id, channel);
      return channel;
    },
    /** 取 channel；未注册即抛（调用方须显式处理未知渠道） */
    get(id) {
      const c = map.get(id);
      if (!c) throw new Error(`未知 channel: ${id}`);
      return c;
    },
    has: (id) => map.has(id),
    /** 列出 { id, capabilities }，供设置页/诊断展示 */
    list: () => [...map.values()].map((c) => ({ id: c.id, capabilities: c.capabilities })),
  };
}

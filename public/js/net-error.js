/**
 * 网络层错误的单一定义处。
 *
 * 为什么要单独一个模块：`isNetworkError` 这个标记原本散在 5 个文件里（1 处生产、
 * 3 处消费、1 处测试里手搓），属性名一改就会**静默**失效——三处 toast 悄悄退回
 * 「业务前缀 + 原始错误」的误导文案，而测试全绿。收敛到这里之后，改名会连带
 * 所有引用一起动，测试也才真正咬得住契约。
 *
 * 为什么分类逻辑也放这里：它是本功能最微妙的一段（区分「后端没了」和「这个请求失败了」），
 * 但它原本长在 bootstrap.js 的 fetch 包装内部，而那个包装在 jsdom 下刻意不安装
 * （jsdom 无 window.fetch），于是无法单测。抽成纯函数后不依赖任何全局，可以直接测。
 */

/** 用户可见文案。改这里即可，消费方判的是标记不是文本。 */
export const NETWORK_ERROR_MSG = '后端未连接';

/**
 * 造一个「后端不可达」错误。保留 cause 便于排查原始的 TypeError。
 * @param {unknown} cause 原始的 fetch 拒绝原因
 */
export function makeNetworkError(cause) {
  return Object.assign(new Error(NETWORK_ERROR_MSG), { isNetworkError: true, cause });
}

/**
 * 是否为「后端整体不可达」。业务侧据此决定：系统故障不叠业务前缀
 *（叠了会把「后端没了」说成「上传功能坏了」，这正是本功能起因的那个 bug）。
 * @param {unknown} e
 */
export function isNetworkError(e) {
  return !!(e && e.isNetworkError);
}

/**
 * 给 fetch 的 **reject** 分类。只处理 reject 路径 —— resolve 但 `!r.ok` 的响应
 * 是业务错误（后端活着），调用方一律不该送进来。
 *
 * @param {unknown} e fetch 的拒绝原因
 * @param {{__skipGuard?: boolean}} [init] 原始 init，用于读旁路标记
 * @returns {{report: boolean, error: unknown}} report=是否上报给掉线守卫；error=该向上抛的错误
 */
export function classifyFetchRejection(e, init) {
  // 主动取消不是掉线：调用方自己 abort 的，比如 boot-gate 的 ping 超时
  if (e?.name === 'AbortError') return { report: false, error: e };
  // 旁路：启动期的各路探测 ping 带这个标记。它们失败是常态而非掉线，
  // 不排除会让掉线罩盖在启动罩上（打包态冷启动必现）
  if (init?.__skipGuard) return { report: false, error: e };
  return { report: true, error: makeNetworkError(e) };
}

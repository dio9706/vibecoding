/** web 入口 run 编排的纯函数层（无 I/O，可单测）。run-claude.js 本体全是 SDK 调用与落盘，无法直测。 */

/**
 * 这次异常终结「有没有资格」自动重试（不含代次判断，代次由 shouldAbandonResume 单独裁定）。
 *
 * 拆成两段而不是一个大判定：settleRun 需要区分「够格但超了上限」（要落 abandoned 让前端
 * 提示一次熔断）和「压根不够格」（如手动停止、无 session 锚点，静默走原有终结路径）。
 *
 * - hasError：确有异常（SDK 抛错 或 result.is_error）
 * - status ∈ {running, error}：`running` 是 SDK 直接抛错/自述失败、尚未终结的常态；
 *   `error` 是看门狗/超时路径——abortRun 先调 failRun 把 status 改 'error'，之后 SDK 的
 *   done reject 才到达 settleRun，只认 'running' 会把看门狗中断整类排除在重试之外。
 *   而手动停止（stopRun）落的是 'done'，天然被这条挡住
 * - subtype 不是 stopped/quota_blocked：纵深防御。前者是用户刚点的停止，重试等于抗命；
 *   后者归额度分支管（它在 settleRun 里已提前 return，走到这里说明状态异常）
 * - sid && convId：有 session 锚点才能续接；判档窗口/首轮 onInit 前崩溃的续不了
 *
 * @param {{hasError:boolean, status:string, subtype:?string, sid:?string, convId:?string}} p
 */
export function isRetryEligible({ hasError, status, subtype, sid, convId }) {
  if (!hasError) return false;
  if (status !== 'running' && status !== 'error') return false;
  if (subtype === 'stopped' || subtype === 'quota_blocked') return false;
  return !!(sid && convId);
}

/** dismiss 待续跑条目时，哪些条目对应的 run 需要一并中止（已起跑的重试/续跑，删条目挡不住进程） */
export function runIdsToAbortOnDismiss(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.status === 'resuming' && e.runId)
    .map((e) => e.runId);
}

/**
 * 该会话是否还有「会把新 run 送上来」的续跑计划。
 *
 * 供 handleRunAttach 在 run 不存在时回给前端：前端的「run 不存在 → 静默等待」分支等的就是
 * 这个新 run，判据为假时它必须改成中性终结，否则气泡永久停在「运行中…」。
 *
 * 活条目口径与 recoverPendingAndOrphans（run-claude.js）、isReqRunActive（requirement-ops.js）
 * 一致：done 已完成、abandoned 是熔断标记（只等前端消费一次提示后 dismiss），两者都不再产生新 run。
 */
export function isResumePlanned(pendingList, convId) {
  if (!convId) return false;
  return (Array.isArray(pendingList) ? pendingList : []).some(
    (e) => e && e.convId === convId && e.status !== 'done' && e.status !== 'abandoned',
  );
}

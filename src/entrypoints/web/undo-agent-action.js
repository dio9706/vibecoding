/**
 * 「乐观执行 + 可撤销」授权模型的兑现处：主机点一次撤销，把台账里的锚点变回真实操作。
 *
 * 上游写台账的两处（`req-write.js#buildUndo` 骨架 + `colleague-dev.js#commitAndMerge`
 * 的覆盖式补全）已经把「怎么撤」编码进 `undo.kind`；这里只负责按 kind 分派、以及
 * 一条贯穿全程的铁律：**只有撤销真正成功才 markUndone**。标早了等于把「改动其实还在」
 * 永久藏起来——主机再也点不了那个按钮，问题却没解决。
 *
 * P2 只产生 `revert-merge`/`delete-apidoc` 两种 kind；另两种（`revert-req-change`/
 * `discard-task`）要等 P4 才有工具写出对应锚点，此刻遇到只能是数据异常或未来版本抢跑，
 * 一律显式拒绝——绝不能静默当成功，那会让主机误以为已经撤销。
 */
import { getAction, markUndone } from '../../store/agent-actions.js';
import { getRequirement, updateRequirement } from '../../store/requirements.js';
import { revertMergeCommit } from '../../plugins/team-tools/auto-dev/revert.js';
import { deleteBranch } from '../../plugins/team-tools/auto-dev/git.js';

/**
 * 撤销一份接口文档登记（`register_api_doc` 的撤销侧）。
 * 按 `name` 而非 `id` 定位——`registerApiDoc` 本就以 name 去重（见 requirement-ops.js），
 * 撤销锚点在工具调用那一刻只知道 name，不该也不需要多存一份 id。
 */
function deleteApiDoc(reqId, name) {
  const req = getRequirement(reqId);
  if (!req) return { ok: false, error: '需求不存在，接口文档撤销不了' };
  const apiDocs = req.apiDocs || [];
  const doc = apiDocs.find((d) => d.name === name);
  if (!doc) return { ok: false, error: `接口文档已不存在：${name}` };
  const next = apiDocs.filter((d) => d.name !== name);
  updateRequirement(reqId, { apiDocs: next }, `撤销登记：删除接口文档 ${name}`);
  return { ok: true };
}

/**
 * 按 `undo.kind` 分派到具体的撤销执行。**永不抛**——调用方（HTTP handler）不必再包一层
 * try/catch，一律读 `{ok, error}` 判断。
 * @param {string} id agent-actions 台账条目 id
 * @param {object} [deps] 测试注入点：getAction/markUndone/revertMergeCommit/deleteBranch/deleteApiDoc
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function undoAgentAction(id, deps = {}) {
  const {
    getAction: getActionFn = getAction,
    markUndone: markUndoneFn = markUndone,
    revertMergeCommit: revertMergeCommitFn = revertMergeCommit,
    deleteBranch: deleteBranchFn = deleteBranch,
    deleteApiDoc: deleteApiDocFn = deleteApiDoc,
  } = deps;

  try {
    const action = getActionFn(id);
    if (!action) return { ok: false, error: `撤销记录不存在：${id}` };
    // 两种「撤不了」文案刻意区分：撤过了是操作层面的幂等提示，undo=null 是这条改动
    // 天生撤不回（external 档）——主机需要知道自己面对的是哪一种，别混着说
    if (action.undone === true) return { ok: false, error: '这条改动已经撤销过了' };
    if (!action.undo) return { ok: false, error: '这条改动已发生且撤不回，不可撤销' };

    const { undo } = action;
    let result;
    switch (undo.kind) {
      case 'revert-merge':
        // mergeSha 为空 = 还没合并过（待合并态），改动只在分支上，删分支即撤销；
        // 有 mergeSha 才需要在基线分支上做反向提交（见 revert.js 的 git revert 优先策略）
        result = undo.mergeSha
          ? await revertMergeCommitFn(undo.repo, { task: { branch: undo.branch, baseBranch: undo.baseBranch }, mergeCommit: undo.mergeSha })
          : await deleteBranchFn(undo.repo, undo.branch);
        break;
      case 'delete-apidoc':
        result = await deleteApiDocFn(undo.reqId, undo.name);
        break;
      case 'revert-req-change':
      case 'discard-task':
        return { ok: false, error: `这种撤销方式（${undo.kind}）暂不支持，需等 P4` };
      default:
        return { ok: false, error: `未知的撤销方式：${undo.kind}` };
    }

    if (!result?.ok) return { ok: false, error: result?.error || '撤销失败' };
    markUndoneFn(id);
    return { ok: true };
  } catch (e) {
    // 撤销执行本身抛错（git 炸了之类）按失败处理，绝不冒泡——冒泡会让 HTTP 层裸 500，
    // 主机看到的是一坨堆栈而不是「撤销失败，原因是……」
    return { ok: false, error: `撤销执行出错：${(e?.message || String(e)).slice(0, 200)}` };
  }
}

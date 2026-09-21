/**
 * 「放弃已合并改动」的纯函数层 —— commit message 与 LLM 兜底 prompt。
 *
 * 与 git.js#mergeMessage 同一套纪律：**必须符合 Conventional Commits**，因为目标仓库
 * 普遍装了 husky + commitlint，而 commitAll 走的是正常提交路径（会跑 commit-msg 钩子）。
 * `revert` 是 commitlint 默认放行的 type 之一。
 */

/** LLM 兜底的单次超时（对齐 bug-patrol/side-review.js#SIDE_TIMEOUT_MS） */
export const REVERT_TIMEOUT_MS = 5 * 60_000;

/**
 * 撤销提交的消息。控长 ≤72 以避开 header-max-length 类规则；
 * 标题缺失时用固定兜底词，绝不产生空 subject（那会被判 subject-empty 挡下）。
 */
export function revertCommitMessage(task) {
  const title = String(task?.title || '').trim() || '自动改动';
  const msg = `revert: 放弃「${title}」的自动改动`;
  return msg.length <= 72 ? msg : `${msg.slice(0, 69)}...`;
}

/**
 * git revert 冲突后交给 Claude 的 prompt。
 *
 * 两条要求是这个 prompt 存在的全部理由，少一条就会出事：
 * 1. **只撤销该次合并引入的改动** —— 合并之后基线分支上可能已经叠了别的任务的提交，
 *    整体回滚会把别人的活一起抹掉（这正是 git revert 冲突的成因）。
 * 2. **不要自己 commit** —— 提交由调用方 commitAll 统一做，那里有「无改动即失败」的校验；
 *    模型自行提交会绕过它，让「AI 其实什么都没改」看起来像成功。
 */
export function buildRevertPrompt({ task, mergeCommit } = {}) {
  const sha = String(mergeCommit || '').trim();
  const shaLine = sha
    ? `这次改动是通过合并提交 ${sha} 进入当前分支的（可用 git show ${sha} 查看它引入了什么）。\n`
    : `这次改动的合并提交记录已丢失，请用 git log 自行定位相关提交。\n`;
  return (
    `请撤销一次自动开发产生的代码改动。\n\n` +
    `原始诉求：${task?.title || '(无标题)'}\n` +
    `详细描述：${task?.detail || '(无)'}\n\n` +
    shaLine +
    `已经尝试过 git revert 但发生冲突——说明这次改动之后，又有别的提交改动了同一片代码。\n\n` +
    `要求：\n` +
    `1. 只撤销上述这次改动引入的内容，**保留此后其他提交对同一文件的修改**。\n` +
    `2. 撤销后代码必须能正常工作，不要留下半截状态或无法解析的残片。\n` +
    `3. 改完**不要自己执行 git commit**，提交由调用方统一完成。\n` +
    `4. 完成后用一段话说明你撤销了哪些文件的哪些内容、保留了什么。`
  );
}

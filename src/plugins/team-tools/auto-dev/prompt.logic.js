/**
 * 自动开发 develop 阶段的任务提示词构造 —— 纯函数、零 IO。
 *
 * 抽到独立文件的唯一理由：内部 benchmark（`benchmarks/`）必须与生产 develop 用**同一份模板**，
 * 否则「改提示词」这个变量在评测里测不出来（A/B 失去意义）。改动这里 = 同时改生产与评测。
 * 由 `task-ops.js#develop` 与 `benchmarks/lib/runner.js` 共用。
 */
import { buildVerifySection, buildVerifyRetrySection } from './verify.logic.js';

/**
 * @param {object} p
 * @param {'bug'|'feature'|string} p.type 任务类型（决定「修复 / 需求」措辞）
 * @param {string} p.detail 原始反馈文本（bug/需求描述）
 * @param {string} [p.analysis] 分析建议（analyze 阶段的产出）
 * @param {string} [p.scopeSection] 机器人作用域提示段（生产传 botScopePrompt；benchmark 传空串）
 * @param {string} [p.scopeFix] 工作区说明段（auto-dev 的 worktree 澄清；benchmark 的基准工作区说明）
 * @param {string} [p.verifyCommand] 完成标准（验证命令；只允许来自人配置，见 verifier.js 硬约束）
 * @param {object|null} [p.verifyFeedback] 上一次验证失败记录（重试场景）
 * @returns {string} 完整 prompt
 */
export function buildDevelopPrompt({
  type,
  detail,
  analysis,
  scopeSection = '',
  scopeFix = '',
  verifyCommand = '',
  verifyFeedback = null,
} = {}) {
  const isBug = type === 'bug';
  return (
    `请在当前项目实际实现这个${isBug ? '修复' : '需求'}：\n` +
    `原始反馈：「${detail}」\n` +
    `分析建议：\n${analysis || '(无)'}\n\n` +
    `反馈中若含本地文件/图片路径（截图、附件、参考文档），请先用 Read 查看再动手。\n` +
    scopeSection +
    scopeFix +
    buildVerifySection(verifyCommand) +
    (verifyFeedback ? buildVerifyRetrySection(verifyFeedback) : '') +
    `请修改代码完成它；完成后用一段话说明你改了哪些文件、做了什么。`
  );
}

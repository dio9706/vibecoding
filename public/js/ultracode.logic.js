/**
 * ultracode（多智能体编排）开关的纯逻辑 —— 零 DOM，供 chat.js 调用、node --test 直测。
 *
 * 链路：模型选择器弹层「会话」区的 ⚡ ultracode 行 → chat.js 会话级状态 chatUltracode →
 * send() 新建 run 时经 decorateUltracode 给 prompt 加 `ultracode ` 前缀 → CLI 原生关键字触发
 * （CLI 侧设置 workflowKeywordTriggerEnabled，默认开；本项目用自定义 systemPrompt，
 *   该触发在此情形下未实测，兜底见 docs/superpowers/specs/2026-09-02-workflow-ultracode-design.md 第 7 节）→ 模型调用 Workflow 工具。
 * 气泡、记忆库、会话记录都存用户原文，前缀只进 prompt。插话路径不加前缀（会污染记忆库语料）。
 */

export const ULTRACODE_KEYWORD = 'ultracode';
const CLAUDE_PROVIDER = 'claude-agent';

/**
 * 开着且走 Claude provider 才拼关键字；openai-compat 没有 Workflow 工具，拼了只会让别家模型困惑。
 * 用户自己手打了关键字会出现双前缀，接受，不去重。
 */
export function decorateUltracode(text, { on, provider }) {
  if (!on || provider !== CLAUDE_PROVIDER) return text;
  return `${ULTRACODE_KEYWORD} ${text}`;
}

/** Workflow 工具被用户禁用时不允许点亮：两处开关不得互相矛盾（反向顺序由服务端 canUseTool 兜底） */
export function canEnableUltracode(disabledTools) {
  return !(Array.isArray(disabledTools) && disabledTools.includes('Workflow'));
}

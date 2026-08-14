/**
 * Claude Agent Provider —— 把现有 runClaude 适配成 Provider 契约的一员。
 * Phase 1：run 透传 runClaude 的 opts（行为逐字不变，屏蔽 SDK 细节由 claude.js 负责）；
 * 规范化的 { input, hooks } 拆分与能力降级留到 Phase 3（第二个 provider 落地时定形）。
 */
import { runClaude } from '../integrations/claude.js';

/** Claude 能力全开：agent loop / 工具 / 文件读写 / 续接 / 流式 / 交互审批 / 限流上报 / 自动压缩均由 SDK 白送 */
export const CLAUDE_CAPABILITIES = Object.freeze({
  agentic: true,
  tools: true,
  fileIO: true,
  resume: true,
  stream: true,
  permissions: true,
  rateLimitAware: true,
  compaction: true,
});

/**
 * 工厂：注入 runFn 便于单测（默认用真实 runClaude，避免测试触达 SDK/网络）。
 * @param {(prompt:string, opts:object)=>Promise<void>} [runFn]
 */
export function createClaudeAgentProvider(runFn = runClaude) {
  return {
    id: 'claude-agent',
    capabilities: CLAUDE_CAPABILITIES,
    /**
     * @param {string} prompt
     * @param {object} [opts]  与 runClaude 完全一致的选项（Phase 1 透传）
     * @returns {{ done: Promise<void>, abort: () => void }}
     */
    run(prompt, opts = {}) {
      const done = runFn(prompt, opts);
      return { done, abort: () => opts.abortController?.abort() };
    },
  };
}

/** 默认实例（供注册表注册） */
export const claudeAgentProvider = createClaudeAgentProvider();

/**
 * 工具策略运行时门（T6）：把纯规则表（tool-policy.logic）包成两条 provider 路径共用的
 * `canUseTool` 裁决器，并承载两件有状态的事：
 *
 *   1. **无人值守翻译**：`ask` 在无人值守下没人能应答 → 一律翻译为 `deny`（附可读原因），
 *      绝不静默放行；
 *   2. **策略拦截计次 → 熔断**：无人值守下每次 deny 计一次；累计达 MAX_POLICY_BLOCKS
 *      → `onFuse` 恰一次（调用方据此停 run + 通知 owner）。交互路径（人在看）只 deny 不熔断。
 *
 * 职责边界：本模块不 import store/runs —— 停 run、写 journal、发通知都由调用方在
 * `onDeny`/`onFuse` 回调里做（capabilities 保持对上层零依赖）。
 */
import { logger } from '../shared/logger.js';
import { systemNotify } from '../integrations/notify.js';
import {
  decideToolAction,
  resolveUnattendedPolicy,
  MAX_POLICY_BLOCKS,
} from './tool-policy.logic.js';

export { MAX_POLICY_BLOCKS, resolveUnattendedPolicy };

/**
 * 造一个绑定到具体 run/工作区的策略门。
 *
 * @param {object} p
 * @param {'claude-agent'|'openai-compat'|string} [p.provider] 仅用于日志与文案
 * @param {string|(()=>string)} [p.level] 档位（函数形式用于读取运行中可变档位，如 run.mode）
 * @param {boolean} [p.unattended] 无人值守：ask→deny + 计次熔断
 * @param {string} [p.workspace]
 * @param {Set<string>} [p.disabledTools]
 * @param {Object} [p.alias] 工具别名表（如 Claude 的 MultiEdit→Edit）：判 disabled 前先归一
 * @param {Set<string>} [p.autoAllow]
 * @param {Set<string>} [p.readOnlyExtra]
 * @param {number} [p.maxBlocks]
 * @param {(info:object)=>void} [p.onDeny] 每次策略拒绝（不含用户点拒绝）
 * @param {(info:object)=>void} [p.onFuse] 无人值守计次达上限，恰一次
 * @returns {{decide:(toolName:string,input?:object)=>{action:'allow'|'ask'|'deny',klass:string,ruleId:string,reason:string}, blocks:()=>number}}
 */
export function createPolicyGate({
  provider = '',
  level = 'default',
  unattended = false,
  workspace,
  disabledTools = null,
  alias = null,
  autoAllow = null,
  readOnlyExtra = null,
  maxBlocks = MAX_POLICY_BLOCKS,
  onDeny = null,
  onFuse = null,
} = {}) {
  let blocks = 0;
  let fused = false;
  const limit = Number(maxBlocks) > 0 ? Number(maxBlocks) : MAX_POLICY_BLOCKS;

  function decide(toolName, input) {
    const lvl = typeof level === 'function' ? level() || 'default' : level || 'default';
    // disabledTools 按「逻辑名」判：MultiEdit 与 Edit 共用开关（别名表由调用方传入）
    const logicalName = (alias && alias[toolName]) || toolName;
    const decision = decideToolAction({
      toolName: logicalName,
      input,
      level: lvl,
      workspace,
      disabledTools,
      autoAllow,
      readOnlyExtra,
    });
    let { action, reason } = decision;
    if (unattended && action === 'ask') {
      action = 'deny';
      reason = `无人值守运行：该操作需要人工审批，已按策略拒绝（${decision.klass}）。可调高机器人执行档位（execPolicy）或改人工处理`;
    }
    if (action === 'deny') {
      const counted = unattended; // 交互路径人在看，不替用户熔断
      if (counted) blocks++;
      const info = {
        tool: toolName,
        klass: decision.klass,
        ruleId: decision.ruleId,
        reason,
        count: counted ? blocks : 0,
        provider,
      };
      try {
        onDeny?.(info);
      } catch (e) {
        logger.warn('tool-policy', 'onDeny 回调异常（已忽略）', { err: e?.message || String(e) });
      }
      if (counted && !fused && blocks >= limit) {
        fused = true;
        try {
          onFuse?.({
            count: blocks,
            last: { tool: toolName, klass: decision.klass, ruleId: decision.ruleId, reason },
            provider,
          });
        } catch (e) {
          logger.warn('tool-policy', 'onFuse 回调异常（已忽略）', { err: e?.message || String(e) });
        }
      }
    }
    return { action, klass: decision.klass, ruleId: decision.ruleId, reason };
  }

  return { decide, blocks: () => blocks };
}

/** Claude 路径的 PreToolUse 钩子片段：强制每次工具调用都交回 canUseTool（先例：run-claude.js） */
export const PRETOOL_ASK_HOOK = Object.freeze({
  PreToolUse: [
    {
      hooks: [
        async () => ({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
        }),
      ],
    },
  ],
});

/**
 * 给「直调 runClaude」的无人值守调用方（auto-dev 的 develop）拼 policy 选项。
 * bypass 档返回 `{ permissionMode:'bypassPermissions', policy:null }` —— 与改动前完全一致。
 *
 * @param {object} p
 * @param {'bypass'|'standard'|'trusted'} [p.execPolicy]
 * @param {string} p.workspace
 * @param {Set<string>} [p.disabledTools]
 * @param {Object} [p.alias]
 * @param {AbortController} [p.abortController] 熔断时用于中断本轮
 * @param {string} [p.label] 日志/通知里的任务标识（如 auto-dev 任务标题）
 * @param {(info:object)=>void} [p.onFuse]
 * @param {(title:string, message:string)=>void} [p.notify] 熔断通知通道（测试注入；默认系统通知）
 * @returns {{permissionMode:string, canUseTool?:Function, hooks?:object, policy:object|null}}
 */
export function buildUnattendedClaudeOpts({
  execPolicy,
  workspace,
  disabledTools = null,
  alias = null,
  abortController = null,
  label = '',
  onFuse = null,
  notify = systemNotify,
} = {}) {
  const resolved = resolveUnattendedPolicy(execPolicy);
  if (resolved.policyLevel === 'bypassPermissions') {
    return { permissionMode: 'bypassPermissions', policy: resolved };
  }
  const gate = createPolicyGate({
    provider: 'claude-agent',
    level: resolved.policyLevel,
    unattended: true,
    workspace,
    disabledTools,
    alias,
    onDeny: (info) => {
      logger.warn('tool-policy', '无人值守策略拒绝', { label, tool: info.tool, ruleId: info.ruleId, count: info.count });
    },
    onFuse: (info) => {
      try {
        onFuse?.(info);
      } finally {
        try {
          abortController?.abort();
        } catch {
          /* ignore */
        }
        notify(
          '无人值守任务被安全策略拦截',
          `「${label || '任务'}」连续 ${info.count} 次被策略拒绝（最后：${info.last.tool}），已中断。可在机器人配置调高执行档位后重试。`,
        );
      }
    },
  });
  return {
    permissionMode: 'default',
    hooks: PRETOOL_ASK_HOOK,
    canUseTool: async (toolName, input) => {
      const d = gate.decide(toolName, input);
      return d.action === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: d.reason };
    },
    policy: resolved,
  };
}

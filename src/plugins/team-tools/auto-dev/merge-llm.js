/**
 * 自动合并的 LLM 兜底 —— `git.js#mergeBranch` 的 `resolver` 实现。
 *
 * 为什么不写进 `git.js`：那是纯 git 封装，被 merge-queue 等多处 import；把 Claude 调用塞进去
 * 会让每个只想跑 `git status` 的调用方都拖上 SDK 与 token 轮换。故 `git.js` 只认一个回调接口，
 * 由本模块实现、由 `task-actions.js` 注入 —— 谁需要 AI 兜底谁自己带。
 *
 * ⚠️ 超时是「不再等」而不是「真的取消」（与 revert.js 同款缺口，原因也相同：
 * `integrations/claude.js#runClaude` 不支持 abortController）。Promise.race 落空后模型进程
 * 仍可能以 bypassPermissions 继续写文件。两条路径下的后果：
 *   - 路径 A（主工作区原地合并）：超时返回后模型仍可能继续改维护者的工作区；
 *   - 路径 B（临时 worktree）：withBranchWorktree 的 finally 会立刻 remove --force，
 *     Windows 上文件被占用时可能删不掉，留下半删的 worktree 注册。
 * 没有真正的取消机制，也不要自己发明一个 —— 这里只是如实记录这个缺口。
 */
import { runClaude } from '../../../integrations/claude.js';
import { claudeAuthOpts } from '../../../capabilities/token-rotation.js';
import { logger } from '../../../shared/logger.js';
import { buildMergeConflictPrompt, buildStashMergePrompt, MERGE_LLM_TIMEOUT_MS } from './merge-llm.logic.js';

/**
 * 真实 LLM 调用：在 dir 里改码（bypassPermissions —— 要动文件）。
 * 刻意不让模型自己 commit：提交与索引状态由 git.js 统一处理，那里有防谎报闸。
 */
async function callLlm(prompt, dir) {
  let out = '';
  try {
    await runClaude(prompt, {
      ...claudeAuthOpts(), // 跟随备用账号轮换（与 web run 同一 token 池）
      cwd: dir,
      permissionMode: 'bypassPermissions',
      persistSession: false, // 内部一次性调用不落盘 session
      onText: (t) => (out += t),
      onResult: (i) => {
        if (i.result) out = i.result;
      },
    });
    return { ok: true, log: out };
  } catch (e) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 200) };
  }
}

/** 带超时的兜底调用。超时不中断底层调用，只是不再等它（缺口见文件头） */
async function withTimeout(fn, timeoutMs, label) {
  const TIMEOUT = Symbol('timeout');
  let timer;
  try {
    const r = await Promise.race([
      fn(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      }),
    ]);
    if (r === TIMEOUT) return { ok: false, error: `${label}超时` };
    return r;
  } finally {
    // 调用先赢时计时器仍会挂到 timeoutMs 后才触发，不清会拖住进程退出
    clearTimeout(timer);
  }
}

/**
 * 造一个 resolver 注入给 `mergeBranch`。
 *
 * @param {{ task?: object }} ctx 任务上下文，只用于给解冲突 prompt 补充「源分支想干什么」
 * @param {{ callLlm?: Function, timeoutMs?: number }} [deps] 供测试注入
 * @returns {{ resolveConflict: Function, mergeStash: Function }}
 */
export function createMergeResolver(ctx = {}, deps = {}) {
  const { callLlm: call = callLlm, timeoutMs = MERGE_LLM_TIMEOUT_MS } = deps;

  return {
    /** 两个已提交分支的内容冲突 */
    async resolveConflict({ dir, source, target, files }) {
      logger.warn('auto-dev', '合并冲突转 AI 处理', { dir, source, target, files: (files || []).slice(0, 10) });
      const prompt = buildMergeConflictPrompt({ source, target, files, task: ctx.task });
      const r = await withTimeout(() => call(prompt, dir), timeoutMs, 'AI 解合并冲突');
      return r.ok ? { ok: true } : { ok: false, error: `AI 解冲突失败：${r.error || '未知原因'}` };
    },

    /** 合并结果 vs 维护者未提交的在写代码 */
    async mergeStash({ dir, source, target, files }) {
      logger.warn('auto-dev', '恢复本地改动冲突转 AI 融合', { dir, source, target, files: (files || []).slice(0, 10) });
      const prompt = buildStashMergePrompt({ source, target, files });
      const r = await withTimeout(() => call(prompt, dir), timeoutMs, 'AI 融合本地改动');
      return r.ok ? { ok: true } : { ok: false, error: `AI 融合本地改动失败：${r.error || '未知原因'}` };
    },
  };
}

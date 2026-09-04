/**
 * Claude Agent SDK 封装 —— 全项目唯一的 Claude 调用入口。
 * 底层复用本机 Claude Code 的订阅登录（与 claude -p 同额度，不额外计费）。
 * 通过回调把流式结果吐给调用方，屏蔽 SDK 细节。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { logger, preview } from '../shared/logger.js';
import { describeTaskEvent, isTaskEvent } from './claude.logic.js';
import { runScript } from './shell.js';

/**
 * 插话（steering）输入队列 —— SDK 流式输入模式的 prompt 源。
 * 首条为初始 prompt；运行中可随时 push 插话；result 到达时调 autoClose：
 * 无积压才关流结束 query，有刚插入的消息则继续同一 run 的下一轮。
 * 单消费者：仅供 SDK 流式输入消费，重复迭代会瓜分消息（勿在别处 for-await）。
 */
export function createInputQueue(initialText) {
  const buffered = [initialText]; // 待消费文本
  let closed = false;
  let wake = null; // 消费者挂起时的唤醒函数
  const notify = () => {
    const w = wake;
    wake = null;
    if (w) w();
  };
  const push = (text) => {
    if (closed) return false;
    buffered.push(text);
    notify();
    return true;
  };
  const close = () => {
    closed = true;
    notify();
  };
  const autoClose = () => {
    if (!buffered.length) close();
  };
  async function* iterate() {
    while (true) {
      while (buffered.length) {
        yield {
          type: 'user',
          message: { role: 'user', content: buffered.shift() },
          parent_tool_use_id: null,
        };
      }
      if (closed) return;
      await new Promise((r) => {
        wake = r;
      });
    }
  }
  return { push, close, autoClose, [Symbol.asyncIterator]: iterate };
}

/**
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string}   [opts.cwd]             工作目录
 * @param {string[]} [opts.additionalDirectories] 额外可访问目录（单会话跨双工程）
 * @param {object}   [opts.env]             覆盖子进程环境变量（整体替换语义！须自行 {...process.env,...}）
 * @param {string}   [opts.permissionMode]  'default' | 'bypassPermissions' | ...
 * @param {string[]} [opts.allowedTools]
 * @param {string[]} [opts.disallowedTools]
 * @param {string}   [opts.resume]          续接的 session_id（多轮）
 * @param {string}   [opts.model]           指定模型（如 claude-sonnet-4-6）
 * @param {string}   [opts.effort]          思考强度 low|medium|high|xhigh|max（模型不支持时 SDK 静默降级）
 * @param {object|string} [opts.settings]   透传 Claude Code 设置（如 { autoCompactEnabled:true } 长会话自动压缩省额度）
 * @param {Function} [opts.canUseTool]      工具执行前审批 (name,input,opts)=>Promise<PermissionResult>
 * @param {object}   [opts.hooks]           SDK 钩子（如 PreToolUse 强制审批，见 server.js 询问模式）
 * @param {Function} [opts.onUserDialog]    处理 Claude 交互提问 (request)=>Promise<UserDialogResult>
 * @param {string[]} [opts.supportedDialogKinds] 声明本端能渲染的 dialog kind（否则 SDK 不下发）
 * @param {object}   [opts.toolConfig]      内置工具配置（如 { askUserQuestion:{ previewFormat:'html' } }）
 * @param {object}   [opts.systemPrompt]    { type:'custom'|'preset', ... }
 * @param {number}   [opts.maxTurns]
 * @param {boolean}  [opts.includePartialMessages] 开启后按 token 级 text_delta 流式回调
 * @param {AbortController} [opts.abortController] 传入后可用于看门狗/超时/手动中断查询
 * @param {Function} [opts.onInputHandle]  插话（steering）：提供时以流式输入模式启动，
 *                                          回调收到 { push(text), close() }，运行中可注入用户消息
 * @param {()=>void}         [opts.onPulse]  SDK 流上收到任一消息即回调（喂看门狗，子代理静默期也算存活）
 * @param {(t:string)=>void} [opts.onText]
 * @param {(i:object)=>void} [opts.onInit]
 * @param {(i:object)=>void} [opts.onResult]
 * @param {(i:object)=>void} [opts.onRateLimit]
 * @param {(a:object)=>void} [opts.onActivity] 工具调用等运行状态：{ name, input }
 */
export async function runClaude(prompt, opts = {}) {
  const {
    cwd,
    additionalDirectories,
    env,
    permissionMode = 'default',
    allowedTools,
    disallowedTools,
    resume,
    model,
    effort,
    settings,
    systemPrompt,
    maxTurns,
    includePartialMessages = false,
    persistSession, // false = 不落盘 session（判档/意图分类等内部一次性调用，避免污染磁盘历史列表）
    abortController,
    onInputHandle,
    onPulse,
    onText,
    onInit,
    onResult,
    onRateLimit,
    onActivity,
    canUseTool,
    hooks,
    onUserDialog,
    supportedDialogKinds,
    toolConfig,
    maxRetries = 3, // 重试次数（默认 3 次）
  } = opts;

  // 排查用日志：记录每次 Claude 调用的开始/结束/耗时/错误。只见 ▶ 不见 ✔/✖ 即为「卡住」。
  const t0 = Date.now();
  logger.info('claude', '▶ runClaude', {
    model: model || 'default',
    cwd: cwd || '(默认)',
    permissionMode,
    resume: resume ? 'yes' : 'no',
    steering: !!onInputHandle, // 流式输入模式：日志中多条 result 属正常（插话多轮）
    prompt: preview(prompt),
  });

  // 插话（steering）：调用方要 handle 时启用流式输入——prompt 变为可持续注入的消息流
  const inputQueue = onInputHandle ? createInputQueue(prompt) : null;

  // 重试逻辑：处理 Response stalled mid-stream 等网络错误
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const q = query({
        prompt: inputQueue || prompt,
        options: {
          permissionMode,
          ...(cwd ? { cwd } : {}),
          ...(additionalDirectories?.length ? { additionalDirectories } : {}),
          ...(env ? { env } : {}),
          ...(allowedTools ? { allowedTools } : {}),
          ...(disallowedTools ? { disallowedTools } : {}),
          ...(resume ? { resume } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(settings ? { settings } : {}),
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(maxTurns ? { maxTurns } : {}),
          ...(includePartialMessages ? { includePartialMessages: true } : {}),
          ...(persistSession === false ? { persistSession: false } : {}),
          ...(abortController ? { abortController } : {}),
          ...(canUseTool ? { canUseTool } : {}),
          ...(hooks ? { hooks } : {}),
          ...(onUserDialog ? { onUserDialog } : {}),
          ...(supportedDialogKinds ? { supportedDialogKinds } : {}),
          ...(toolConfig ? { toolConfig } : {}),
        },
      });
      // 句柄在 query 创建后交给调用方：interrupt 直接绑定 q（轮内打断，run 存活，队列消息继续跑）
      if (inputQueue) onInputHandle({ push: inputQueue.push, close: inputQueue.close, interrupt: () => q.interrupt() });

      const taskKinds = new Map(); // task_id → { name, label, skip }，progress/notification 查表打标签；每个 attempt 一份（重试 = 新流）
      for await (const message of q) {
        onPulse?.(); // 任何消息到达都算存活：子代理并行探索期间主代理静默，靠这里喂看门狗
        if (message.type === 'system' && message.subtype === 'init') {
          logger.info('claude', 'init', { session_id: message.session_id });
          onInit?.({ session_id: message.session_id });
          continue;
        }
        // 子代理 / 工作流 / 后台任务进度（SDK 0.3.210+：子代理不再透流内消息，进度经 system task_* 事件给出）。
        // 文案与类型判定在 claude.logic.js；skip_transcript=true 的常驻任务不进转录（返回 null）。
        if (isTaskEvent(message)) {
          const activity = describeTaskEvent(message, taskKinds);
          if (activity) onActivity?.(activity);
          continue;
        }
        if (message.type === 'rate_limit_event') {
          logger.warn('claude', '限流事件 rate_limit', message.rate_limit_info || {});
          onRateLimit?.(message.rate_limit_info || {});
          continue;
        }
        // token 级增量：仅消费主代理文本（子代理文本不进气泡，避免污染），逐字吐出
        if (message.type === 'stream_event') {
          const ev = message.event;
          if (
            ev?.type === 'content_block_delta' &&
            ev.delta?.type === 'text_delta' &&
            ev.delta.text &&
            !message.parent_tool_use_id
          ) {
            onText?.(ev.delta.text);
          }
          continue;
        }
        if (message.type === 'assistant') {
          const sub = !!message.parent_tool_use_id; // 子代理（Task）产生的消息
          const content = message.message?.content || [];
          for (const block of content) {
            // 开启 partial 时文本已由 stream_event 逐字给出；子代理文本一律不进气泡
            if (block.type === 'text' && block.text && !includePartialMessages && !sub) onText?.(block.text);
            else if (block.type === 'tool_use') onActivity?.({ name: block.name, input: block.input, sub });
          }
          continue;
        }
        if (message.type === 'result') {
          logger.info('claude', 'result', {
            subtype: message.subtype,
            is_error: message.is_error ?? message.subtype !== 'success',
            cost_usd: message.total_cost_usd,
            ms: Date.now() - t0,
          });
          const usage = message.usage || {};
          onResult?.({
            subtype: message.subtype,
            result: message.subtype === 'success' ? message.result : '',
            is_error: message.is_error ?? message.subtype !== 'success',
            cost_usd: message.total_cost_usd,
            session_id: message.session_id,
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
          });
          inputQueue?.autoClose(); // 无积压插话 → 关闭输入流，query 随之收尾（行为与字符串模式一致）
        }
      }
      logger.info('claude', '✔ runClaude', { ms: Date.now() - t0, attempt });
      return; // 成功退出
    } catch (e) {
      lastError = e;
      const errorMsg = String(e?.message || e);
      const isStalledError = errorMsg.includes('stalled') || errorMsg.includes('mid-stream');

      logger.error('claude', isStalledError ? '⚠️  流式响应中断（重试中...）' : '✖ runClaude', {
        ms: Date.now() - t0,
        attempt,
        maxRetries,
        err: errorMsg,
        isStalledError,
      });

      // stalled/network 类错误才重试；其他错误（权限/请求有误）直接抛
      if (!isStalledError || attempt === maxRetries) {
        inputQueue?.close();
        throw e;
      }

      // 指数退避等待：1s, 2s, 4s, ...
      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      logger.info('claude', `等待 ${delayMs}ms 后重试...`, { attempt: attempt + 1, maxRetries });
      await new Promise(r => setTimeout(r, delayMs));

      // 重置输入队列供下次重试
      if (inputQueue) {
        inputQueue.close();
        // 重建队列（保留原始 prompt）
        const newQueue = createInputQueue(prompt);
        Object.assign(inputQueue, {
          push: newQueue.push,
          close: newQueue.close,
          autoClose: newQueue.autoClose,
          [Symbol.asyncIterator]: newQueue[Symbol.asyncIterator],
        });
      }
    }
  }

  // 所有重试都失败了
  logger.error('claude', `✖ 重试 ${maxRetries} 次后仍失败`, { ms: Date.now() - t0 });
  inputQueue?.close();
  throw lastError;
}

/**
 * 通过 Claude CLI 子进程向指定会话发送 /compact 指令，触发上下文压缩。
 * SDK 暂无压缩 API，改用 shell 子进程方式（claude --print /compact --resume SESSION_ID）。
 * 压缩后 session ID 不变，token 差值无法从 CLI 输出精确获取，返回占位 0。
 *
 * @param {string} sessionId
 * @returns {Promise<{newSessionId: string, inputTokensBefore: number, inputTokensAfter: number}>}
 */
export async function compactSession(sessionId) {
  if (!sessionId) throw new Error('sessionId is required');

  logger.info('claude', '触发上下文压缩', { sessionId });

  const result = await runScript(
    'claude',
    ['/compact', '--resume', sessionId],
    { timeoutMs: 120_000 },
  );

  if (!result.ok) {
    const msg = result.msg || result.err || result.out || 'compact failed';
    logger.warn('claude', '上下文压缩失败', { sessionId, msg });
    throw new Error(`Compact failed: ${msg}`);
  }

  logger.info('claude', '上下文压缩完成', { sessionId });

  return {
    newSessionId: sessionId, // 压缩后 session ID 不变
    inputTokensBefore: 0,    // CLI 不返回结构化 token 数据
    inputTokensAfter: 0,
  };
}

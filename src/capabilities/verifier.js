/**
 * 验证器：跑一条 owner 配置的验证命令，把「完成」的判据从模型自述换成客观结果。
 *
 * ## 硬约束（改动前必读）
 *
 * `command` 只能来自 **owner 在设置页手写的配置**（机器人级 `verifyScript`）或
 * **工程自身的 test 脚本**（Phase 2 自动发现，产物只有代码常量 `npm test` 一种形态）。
 * **绝不允许**模型输出、任务数据、同事消息拼接进这里——验证命令以 shell 执行，
 * 一旦可被上游内容影响，就等于给模型开了一条绕过审批的任意命令通道。
 * 新增调用方时，命令来源必须仍是「人配置的值」，不是「人配置的值 + 任何运行时数据」。
 *
 * ## fail-open 的边界
 *
 * 「未配置」与「命令本身不可用（打错字/未安装）」都算 **skipped（不算失败）**：
 * 否则配错一条命令会让所有任务永远失败，而这是配置问题不是代码问题。
 * 「命令正常跑起来但退出非零 / 超时」才算真失败。
 *
 * 为什么命令不存在要靠**探测**而不是解析报错文案：Windows 中文系统的 cmd 报错是 GBK 字节，
 * 经 UTF-8 解码后只剩乱码（实测），任何按文案匹配的判定都不可靠。改为执行失败后
 * 用 `where`（win）/ `command -v`（posix）探测首个 token 是否可解析——能解析 = 真失败，
 * 解析不到 = 配置问题。只探测「简单命令」的首 token，复杂命令（含 shell 元字符/变量赋值）
 * 不判，宁可当真实失败也不误跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from '../integrations/shell.js';
import { logger } from '../shared/logger.js';
import { buildVerifySummary, discoverVerifyCommand, truncateOutput } from './verifier.logic.js';

/** 验证预算：足够跑一轮完整测试，又不会让管线长时间被卡住 */
export const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

/** shell 内建命令不是外部可执行文件，`where`/`command -v` 查不到但并非配置错误 */
const SHELL_BUILTINS = new Set([
  'cd', 'echo', 'set', 'export', 'source', '.', 'if', 'for', 'while', 'true', 'false',
  'dir', 'copy', 'del', 'mkdir', 'md', 'rd', 'type', 'ver', 'exit', 'rem',
]);

/**
 * 首个 token 是否可解析（仅对简单命令给结论；判不了返回 null）。
 * @returns {Promise<boolean|null>} true=存在；false=不存在；null=不适用（保守，不判）
 */
async function firstTokenResolvable(command, cwd) {
  const token = String(command || '').trim().split(/\s+/)[0] || '';
  if (!token) return null;
  if (/[&|;<>"'`$()=]/.test(token)) return null; // 元字符/变量赋值：交给 shell，无法可靠判
  if (SHELL_BUILTINS.has(token.toLowerCase())) return null;
  if (/[\\/]/.test(token)) return fs.existsSync(path.resolve(cwd || process.cwd(), token)); // 显式路径：查文件
  const r =
    process.platform === 'win32'
      ? await runScript('where', [token], { shell: false })
      : await runScript('sh', ['-c', `command -v ${token}`], { shell: false });
  return r.ok;
}

/**
 * 解析本次运行的验证命令（Phase 2 自动发现）：显式配置 > 自动发现 > 空串（按「未配置」跳过）。
 *
 * 自动发现只认一条项目约定：`package.json` 有真实 test 脚本 → `npm test`。
 * 读不到文件 / 解析失败同样返回空串——发现失败绝不阻塞任务（fail-open 与执行期同一边界）。
 * 读的是**任务工作区**（autoDir）里的 package.json：验证就在那里跑，命令必须与之匹配。
 *
 * @param {{configured?:string, cwd?:string, readFileFn?:Function}} opts
 * @returns {Promise<string>} 最终命令（可能为空串）
 */
export async function resolveVerifyCommand({ configured, cwd, readFileFn = fs.promises.readFile } = {}) {
  const explicit = String(configured || '').trim();
  if (explicit) return explicit;
  if (!cwd) return '';
  try {
    const raw = await readFileFn(path.join(cwd, 'package.json'), 'utf8');
    return discoverVerifyCommand(JSON.parse(raw));
  } catch {
    return '';
  }
}

/**
 * @param {{cwd?:string, command?:string, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, skipped:boolean, command:string, reason?:string, exitCode:number|null, timedOut:boolean, durationMs:number, output:string, summary:string}>}
 */
export async function runVerify({ cwd, command, timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  const cmd = String(command || '').trim();
  const t0 = Date.now();

  if (!cmd) return finalize({ ok: true, skipped: true, command: '', reason: '未配置验证命令', durationMs: 0, output: '' });

  const r = await runScript(cmd, [], { cwd, shell: true, timeoutMs });
  const durationMs = Date.now() - t0;
  const output = truncateOutput([r.out, r.err].filter(Boolean).join('\n'));

  // spawn 层失败（shell 都起不来）：runScript 给 { ok:false, msg }，没有 code、不是超时
  const spawnFailed = !r.ok && !r.timedOut && r.code === undefined;
  // shell 报告「找不到命令」：探测首 token 是否可解析，解析不到按配置问题跳过
  const maybeNotFound = !r.ok && !r.timedOut && !spawnFailed && (await firstTokenResolvable(cmd, cwd)) === false;

  let result;
  if (spawnFailed) {
    result = { ok: true, skipped: true, command: cmd, reason: r.msg || '命令无法启动', durationMs, output };
  } else if (maybeNotFound) {
    result = { ok: true, skipped: true, command: cmd, reason: '命令不存在或无法执行（请检查自检命令配置）', durationMs, output };
  } else if (r.timedOut) {
    result = { ok: false, skipped: false, command: cmd, exitCode: null, timedOut: true, durationMs, output };
  } else {
    result = { ok: !!r.ok, skipped: false, command: cmd, exitCode: r.code ?? null, timedOut: false, durationMs, output };
  }

  const full = finalize(result);
  logger.info('verifier', '验证完成', {
    command: cmd,
    ok: full.ok,
    skipped: full.skipped,
    exitCode: full.exitCode,
    durationMs,
  });
  return full;
}

function finalize(r) {
  const full = {
    ok: !!r.ok,
    skipped: !!r.skipped,
    command: r.command || '',
    reason: r.reason || '',
    exitCode: r.exitCode ?? null,
    timedOut: !!r.timedOut,
    durationMs: r.durationMs || 0,
    output: r.output || '',
  };
  full.summary = buildVerifySummary(full);
  return full;
}

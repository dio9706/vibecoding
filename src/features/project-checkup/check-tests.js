/**
 * 维度「测试健康度」的 fs / 执行层。
 *
 * 这是体检里**唯一会执行目标项目代码**的检查项（用户明确选择默认开启）。三重防护：
 *   1. 超时判 partial 而不是「失败」——超时是「没测出来」，不是「测试红了」
 *   2. 识别 npm init 的占位 test 脚本（`exit 1`），否则每个没写测试的项目都会被报成测试失败
 *   3. 只读退出码，不解析输出（各框架输出格式不通用），maxBuffer 设上限防输出爆内存
 */
import fs from 'node:fs';
import path from 'node:path';
import { exec as execCallback, execFileSync } from 'node:child_process';
import { shouldSkipDir } from './scan-dirs.logic.js';
import { gitTrackedFiles } from './git-tracked.js';
import { findLargeFilesWithoutTest, evaluateTests } from './check-tests.logic.js';

/**
 * 用 exec（走 shell、收单条命令字符串）而不是 execFile，是被 Windows 逼出来的：
 * npm 在 Windows 上是 npm.cmd，而 Node 自 CVE-2024-27980 起禁止 execFile 直接执行 .cmd，
 * 实测抛 `spawn EINVAL`。给 execFile 加 shell:true 能跑通，但 args 数组 + shell 会触发
 * DEP0190（参数只拼接不转义）。exec 传单条命令字符串两个问题都没有，且跨平台一致。
 * 命令是模块内硬编码常量、projectDir 只作 cwd 不进命令行，因此没有注入面。
 */
const TEST_COMMAND = 'npm test --silent';

const TEST_TIMEOUT_MS = 120_000;
const CODE_EXT = /\.(m?js|cjs)$/i;
const TEST_FILE = /\.test\.m?js$/i;

/**
 * 杀掉整棵进程树。
 *
 * 必须自己杀：走 shell 时 Node 的 `timeout` 选项只杀 shell 本身，shell 启动的实际测试进程
 * 会变成孤儿继续跑到自己结束。实测后果是超时用例的临时目录删不掉（EPERM，cwd 被占），
 * 真实场景下则是反复体检累积一堆还在跑测试的孤儿进程。
 */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      // Windows 没有进程组信号，taskkill /T 是杀进程树的标准手段
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      // detached 让子进程自成进程组，负 pid 才能整组投递信号
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* 进程已自行退出 */
  }
}

/**
 * 跑测试命令，超时自己接管（不用 Node 的 timeout 选项——它杀不掉孙进程）。
 * @returns {Promise<{status:'pass'|'fail'|'timeout'|'na', reason?:string}>}
 */
function runTestCommand(projectDir, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const child = execCallback(
      TEST_COMMAND,
      {
        cwd: projectDir,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        detached: process.platform !== 'win32', // 自成进程组，超时才能整组杀
      },
      (err) => {
        if (!err) return done({ status: 'pass' });
        // 只认数字退出码为「测试失败」；其余（命令找不到等）都是「无法判断」
        if (typeof err.code === 'number') {
          return done({ status: 'fail', reason: `测试未通过（退出码 ${err.code}）` });
        }
        done({ status: 'na', reason: `无法执行测试命令：${err.message || String(err)}` });
      },
    );

    const timer = setTimeout(() => {
      killTree(child.pid);
      done({
        status: 'timeout',
        reason: `测试执行超过 ${Math.round(timeoutMs / 1000)}s，本维度不计入总分`,
      });
    }, timeoutMs);
  });
}

/**
 * 执行项目测试命令。
 * @returns {Promise<{status:'pass'|'fail'|'timeout'|'na', reason?:string}>}
 */
export async function runProjectTests(projectDir, { timeoutMs = TEST_TIMEOUT_MS } = {}) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  } catch {
    return { status: 'na', reason: '没有 package.json 或无法解析，未执行测试' };
  }
  const script = pkg?.scripts?.test;
  if (!script) return { status: 'na', reason: 'package.json 未定义 test 脚本' };
  if (/no test specified/i.test(script)) {
    return { status: 'na', reason: 'test 脚本是 npm init 生成的占位脚本，未执行' };
  }

  return runTestCommand(projectDir, timeoutMs);
}

/** 收集源文件（含行数）与全部相对路径集合。只看 git 追踪的文件，非 git 仓库降级为全扫。 */
function collectFiles(projectDir, tracked) {
  const sources = [];
  const allRel = new Set();
  let testFileCount = 0;

  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (shouldSkipDir(e.name)) continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(full, r); continue; }
      if (tracked && !tracked.has(r)) continue;
      allRel.add(r);
      if (!CODE_EXT.test(e.name)) continue;
      if (TEST_FILE.test(e.name)) { testFileCount += 1; continue; }
      try {
        const lines = fs.readFileSync(full, 'utf8').split('\n').length;
        sources.push({ rel: r, lines });
      } catch { /* 读不到就跳过 */ }
    }
  };
  walk(projectDir, '');
  return { sources, allRel, testFileCount };
}

/**
 * 第二参 `_opts` 只为与 RUNNERS 里其他 runner 的签名对齐（编排层统一按 (dir, {cache,force}) 调用）。
 * 返回值补 cacheEntry/fingerprint/cached：本维度不做指纹缓存（每次都要重跑测试），
 * 给 null 即可——store/optimize.js 的 saveLlmCache 开头就是 `if (!entry) return`，
 * 传 null 不会写脏 llmCache。
 */
export async function checkTests(projectDir, _opts) {
  const tracked = await gitTrackedFiles(projectDir);
  const { sources, allRel, testFileCount } = collectFiles(projectDir, tracked);
  const testRun = await runProjectTests(projectDir);
  const largeFilesWithoutTest = findLargeFilesWithoutTest(sources, allRel);

  return {
    ...evaluateTests({
      testRun,
      largeFilesWithoutTest,
      testFileCount,
      sourceFileCount: sources.length,
    }),
    cacheEntry: null,
    fingerprint: null,
    cached: false,
  };
}

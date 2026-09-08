/** src/entrypoints/web/routes-git.js
 * Git 相关 HTTP 端点 handler：status / branches / checkout
 */
import { execFile } from 'node:child_process';
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';

/** 校验分支名：仅允许字母数字加 /.-_，禁止 .. 路径序列 */
const BRANCH_NAME_REGEX = /^(?!.*\.\.)[a-zA-Z0-9/_.\-]+$/;

export function validateBranchName(name) {
  return typeof name === 'string' && BRANCH_NAME_REGEX.test(name);
}

/**
 * 执行 git 命令的通用工具函数
 * @param {string} cwd 工作目录
 * @param {string[]} args git 命令参数
 * @param {number} timeout 超时（毫秒）
 * @returns {Promise<{stdout: string, stderr: string, code: number|string}>}
 */
function execGit(cwd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout }, (err, stdout, stderr) => {
      resolve({
        // execFile 超时后 err.killed=true / err.signal='SIGTERM'，code 为 null
        code: (err?.killed || !!err?.signal) ? 'TIMEOUT' : (err ? 1 : 0),
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      });
    });
  });
}

/** GET /api/git/status - 检查是否 git 仓库，返回当前分支 */
export async function handleGitStatus(cwd, res) {
  const cwdStr = str(cwd);
  if (!cwdStr) {
    return sendJson(res, 200, { isGit: false, cwd: '' });
  }

  const isGitCheck = await execGit(cwdStr, ['rev-parse', '--is-inside-work-tree']);
  const isGit = isGitCheck.stdout === 'true';

  if (!isGit) {
    return sendJson(res, 200, { isGit: false, cwd: cwdStr });
  }

  const branchCheck = await execGit(cwdStr, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const currentBranch = branchCheck.code === 0 ? branchCheck.stdout : 'HEAD';

  sendJson(res, 200, { isGit: true, currentBranch, cwd: cwdStr });
}

/**
 * 解析 git branch -a --format=... 的输出行，返回 { local, remote, current }。
 * 纯函数，便于单元测试。
 *
 * 用 ref 全名（`refs/heads/x` / `refs/remotes/origin/x`）而非 `refname:short` 分类：
 * short 形式下远程分支就叫 `origin/x`，无从与同名本地分支区分，且 `origin/HEAD`
 * 会缩成一个看着像分支的 `origin`。
 *
 * @param {string[]} lines 每行格式：`<refname 全名>|(SEP)|<true|false>`
 * @returns {{ local: string[], remote: string[], current: string }}
 */
export function parseBranchLines(lines) {
  const local = [];
  const remote = [];
  let current = '';

  for (const line of lines) {
    const [ref, isCurrent] = line.split('|(SEP)|');
    if (!ref) continue;

    let name = '';
    if (ref.startsWith('refs/heads/')) {
      name = ref.slice('refs/heads/'.length);
      local.push(name);
    } else if (ref.startsWith('refs/remotes/')) {
      name = ref.slice('refs/remotes/'.length);
      if (name.endsWith('/HEAD')) continue; // origin/HEAD 是符号引用，不是分支
      remote.push(name);
    } else {
      continue;
    }

    if (isCurrent === 'true') current = name;
  }

  local.sort();
  remote.sort();

  return { local, remote, current };
}

/** GET /api/git/branches - 列出本地和远程分支，可选 refresh=1 触发 fetch */
export async function handleGitBranches(cwd, refresh, res) {
  const cwdStr = str(cwd);
  if (!cwdStr) {
    return sendJson(res, 400, { error: '缺少工作目录' });
  }

  if (refresh === '1') {
    const fetchResult = await execGit(cwdStr, ['fetch', '--all'], 10000);
    if (fetchResult.code === 'TIMEOUT') {
      return sendJson(res, 500, { error: 'git fetch 超时（10s）' });
    }
    if (fetchResult.code !== 0) {
      return sendJson(res, 500, { error: fetchResult.stderr || 'git fetch 失败' });
    }
  }

  // 列出所有分支（--format 含 HEAD 标记）
  const branchResult = await execGit(cwdStr, [
    'branch', '-a',
    '--format=%(refname)|(SEP)|%(if)%(HEAD)%(then)true%(else)false%(end)',
  ]);

  if (branchResult.code !== 0) {
    return sendJson(res, 500, { error: branchResult.stderr || 'git branch 失败' });
  }

  const lines = branchResult.stdout.split('\n').filter((l) => l.trim());
  const { local, remote, current } = parseBranchLines(lines);

  sendJson(res, 200, { local, remote, current });
}

/** POST /api/git/checkout - 切换分支 */
export async function handleGitCheckout(cwd, req, res) {
  const cwdStr = str(cwd);
  if (!cwdStr) {
    return sendJson(res, 400, { error: '缺少工作目录' });
  }

  return withJsonBody(req, async (body) => {
    const branch = str(body?.branch);
    if (!branch || !validateBranchName(branch)) {
      return sendJson(res, 400, { error: '无效的分支名' });
    }

    const checkoutResult = await execGit(cwdStr, ['checkout', branch], 5000);

    if (checkoutResult.code === 'TIMEOUT') {
      return sendJson(res, 500, { error: 'git checkout 超时（5s）' });
    }

    if (checkoutResult.code === 0) {
      return sendJson(res, 200, { ok: true, branch });
    }

    sendJson(res, 500, { error: checkoutResult.stderr || 'git checkout 失败' });
  });
}

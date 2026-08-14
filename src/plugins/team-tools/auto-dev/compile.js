/**
 * DEV 编译适配器：push 分支 → 调编译脚本 --env dev --branch <branch> → 解析二维码 URL。
 * 契约：compileDevQrcode({repo, branch}) -> { ok, qrUrl, log }。原 unattended/compile.js 迁入。
 */
import path from 'node:path';
import { runScript } from '../../../integrations/shell.js';
import { pushBranch } from './git.js';
import { parseQrUrl } from './logic.js';
import { config } from '../../../shared/config.js';
import { logger } from '../../../shared/logger.js';

export async function compileDevQrcode({ repo, branch }) {
  const push = await pushBranch(repo, branch);
  if (!push.ok) {
    logger.warn('auto-dev', 'push 失败', { repo, branch, err: push.err });
    return { ok: false, qrUrl: null, log: `push 失败：${push.err || ''}` };
  }
  const scriptPath = path.join(config.scripts.dir, config.autoDev.compileScript);
  const r = await runScript(config.scripts.pythonBin, [scriptPath, '--env', 'dev', '--branch', branch], {
    env: { PYTHONIOENCODING: 'utf-8' },
  });
  const stdout = r.out || '';
  const qrUrl = parseQrUrl(stdout);
  logger.info('auto-dev', 'compile 结束', { ok: r.ok, hasQr: !!qrUrl });
  return { ok: r.ok && !!qrUrl, qrUrl, log: r.ok ? stdout : r.err || r.msg || stdout };
}

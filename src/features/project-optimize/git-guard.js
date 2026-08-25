/**
 * 工作区状态检查的执行层。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parsePorcelain } from './git-guard.logic.js';

const exec = promisify(execFile);

/**
 * @returns {Promise<{isRepo:boolean, dirty:boolean, count:number, files:string[]}>}
 *   非 git 仓库返回 isRepo:false —— 此时用户无法用 git 回退，只能靠本工具的
 *   快照还原，调用方要据此调整提示文案。
 */
export async function checkWorkspace(projectDir) {
  try {
    const { stdout } = await exec('git', ['status', '--porcelain'], {
      cwd: projectDir,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { isRepo: true, ...parsePorcelain(stdout) };
  } catch {
    // git 不存在、目录不存在、或该目录不是仓库，都走这里
    return { isRepo: false, dirty: false, count: 0, files: [] };
  }
}

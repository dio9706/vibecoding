/**
 * git 追踪清单 —— 「什么是真实源码」的权威来源。
 *
 * 动机（实测）：comments 维度把 .gitignore 的构建产物当源码扫了，
 * `src/shared/app-paths.js:37` 的同一处注释被报了 3 次（真实源码 1 份 +
 * src-tauri/target 与 src-tauri/resources/sidecar 各 1 份副本）。后果是用户看到重复问题、
 * 评分公式两端被副本抬高失真，且**每份副本都单独烧了一次 LLM 额度**。
 *
 * 用项目自己的 .gitignore 判定比手工维护 SKIP_DIR 列表准确且零维护——它能一次性覆盖
 * target/、打包副本以及未来任何构建输出。SKIP_DIR 仍然保留：fixtures 是被 git 追踪的
 * 真实文件，只有它挡得住。两者叠加，不是替代。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * @param {string} projectDir
 * @returns {Promise<Set<string>|null>} 相对 projectDir 的正斜杠路径集合；
 *   非 git 仓库 / git 不可用 / 零追踪文件一律返回 null，调用方据此降级为目录遍历。
 *
 * 用 -z（NUL 分隔）而不是按行切：路径含空格或非 ASCII 时 git 默认会加引号并转义，
 * 按行切会拿到带引号的坏路径，匹配全部失配。
 */
export async function gitTrackedFiles(projectDir) {
  try {
    const { stdout } = await exec('git', ['ls-files', '-z'], {
      cwd: projectDir,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    const set = new Set();
    for (const p of stdout.split('\0')) {
      if (p) set.add(p); // git 输出已是正斜杠，且相对 cwd（实测：cd src && git ls-files → app/x.js）
    }
    // 空清单当 null：真返回空 Set 会让调用方把整个项目都过滤掉，
    // 表现为「体检什么都没扫到」的静默失败。宁可降级为目录遍历。
    return set.size ? set : null;
  } catch {
    // git 不存在、目录不存在、不是仓库，都走这里
    return null;
  }
}

/**
 * 启动期 .env 加载 —— 兜底填补进程环境，必须在任何业务模块被 import 之前跑完。
 *
 * 为什么需要它（2026-08-26 事故）：埋点统计的 Python 侧报
 * 「缺少环境变量：TRACKING_DB_HOST, TRACKING_DB_USER, TRACKING_DB_PASSWORD」，
 * 而 .env 里这五项俱全。真因是**接消息的进程压根没加载过 .env**，两条路径都会中：
 *   - 打包版：Tauri 只注入 APP_DATA_DIR + PORT（见 src-tauri/src/main.rs 的 spawn 段），
 *     GUI 由快捷方式启动，环境里没有 .env 的任何内容。飞书凭证之所以还能用，
 *     是因为它另有来源（store/settings.js 的机器人配置），而埋点库配置没有这条后路 ——
 *     于是表现为「机器人活得很好，只有这一个功能坏」，极难往环境变量上想。
 *   - 开发态：package.json 的 `start` 就是裸 `node server.js`，不带 --env-file；
 *     正确命令只写在 feishu.js 的注释里。少打一个参数就静默丢掉全部配置。
 * 两种失效的共同点：不在启动时喊出来，而是等某个功能真正被用到时才报缺变量。
 *
 * 为什么必须在业务模块之前：shared/config.js 在**模块求值时**读 process.env
 * （`export const config = {...}` 是字面量，import 完成即定型）。ESM 会先把整张 import 图
 * 求值完才执行模块体，所以入口里写一条 `loadAppEnv()` 语句是**来不及**的 ——
 * 它晚于 config.js 的求值。入口因此必须「先调用本函数，再用动态 import 拉起业务模块」，
 * 见 server.js / feishu.js / entrypoints/console/index.js 的顶部。
 *
 * 覆盖语义交给 Node，不自己实现：process.loadEnvFile 不改写进程里已存在的键
 * （Node 24 实测确认）。所以显式 `--env-file`、Tauri 注入的 APP_DATA_DIR/PORT、
 * CI 里的外部变量，一律赢过文件内容。这条性质是本模块能被无条件调用的前提 ——
 * 它只做兜底，永不夺权；反过来若自行 assign，就会把 Tauri 注入的端口覆盖成文件里的旧值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 开发态的 .env 位置（本文件在 src/shared/ 下，向上两级即仓库根） */
export const REPO_ENV_FILE = path.join(__dirname, '..', '..', '.env');

/**
 * 按优先级列出候选 .env 路径。
 *
 * 打包态优先 APP_DATA_DIR：安装目录（Program Files）只读，配置只能放用户可写目录，
 * 这样改配置不必重装。顺序反了会在开发机上「看起来正常」，装到别人机器上永远读不到。
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string[]} 高优先级在前
 */
export function envFileCandidates(env = process.env) {
  const out = [];
  const dataDir = env?.APP_DATA_DIR;
  // 与 app-paths.js 的 isPackaged() 用同一判定：trim 后非空才算真注入，
  // 否则空串会拼出仓库根之外的怪路径（path.join('', '.env') === '.env'，落到 cwd 上）
  if (typeof dataDir === 'string' && dataDir.trim()) out.push(path.join(dataDir.trim(), '.env'));
  out.push(REPO_ENV_FILE);
  return out;
}

/**
 * 加载**第一个存在**的候选文件。
 *
 * 只取第一个而不是逐个叠加：配置来源单一才好排查。叠加语义下
 * 「这个变量到底来自哪个文件」需要人脑做一次优先级推演，而排查环境变量问题时
 * 最需要的恰恰是一句确定的「读的是这个文件」。
 *
 * 依赖全部可注入：真调 process.loadEnvFile 会污染测试进程的环境。
 *
 * @returns {{loaded: string|null, error?: string}} loaded=实际读取的文件；error=解析失败原因
 */
export function loadAppEnv({
  env = process.env,
  exists = fs.existsSync,
  load = (p) => process.loadEnvFile(p),
  log = console.log,
} = {}) {
  for (const file of envFileCandidates(env)) {
    if (!exists(file)) continue;
    try {
      load(file);
      // 打印实际读取的文件：排查「变量没生效」时，第一个要确认的就是读的是哪份配置
      log(`[env] 已加载 ${file}`);
      return { loaded: file };
    } catch (e) {
      const error = e?.message || String(e);
      // 不抛：.env 写坏（比如粘进一段 YAML）时让进程继续起来。
      // 后面缺哪个变量报哪个，比进程在启动第一行秒退可读得多。
      log(`[env] 解析失败，已跳过 ${file}：${error}`);
      return { loaded: null, error };
    }
  }
  // 一个都没有是正常路径：生产/CI 常靠外部注入环境变量，本就不该有 .env 文件
  return { loaded: null };
}

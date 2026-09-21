/**
 * 记忆库 LLM 调用的「干净工作目录」。
 *
 * 为什么需要它（2026-09-18 对照实验）：`runClaude` 不传 `cwd` 时 SDK 落到 server 进程的工作目录，
 * 也就是**本项目根目录**，于是每一次提炼调用都要加载整个工程的 CLAUDE.md、skills 清单与 MCP 定义。
 * 同一段 8141 字符的转录、同一个模型，唯一变量是 cwd：
 *
 *   默认 cwd（项目根）→ 156s / $0.104 / 返回的 JSON **没有 findings 键**（被项目上下文带偏）
 *   空目录 cwd        →  70s / $0.039 / 输出完全正确
 *
 * 记忆库的两个调用都是单轮零工具、不读任何文件的纯文本任务，项目上下文对它们只有害处。
 * 指向 APP_DATA_DIR 下的空目录而不是 os.tmpdir()，是为了跟随打包后的可写目录、
 * 不在系统临时区留垃圾，也便于排查时一眼看到它。
 */
import fs from 'node:fs';
import { dataPath } from '../../store/index.js';

let _dir = null;

/**
 * 返回（并按需创建）那个空目录。结果进程内缓存，不重复 mkdir。
 * @returns {string} 绝对路径
 */
export function classifyCwd() {
  if (_dir) return _dir;
  const dir = dataPath('.llm-sandbox');
  fs.mkdirSync(dir, { recursive: true });
  _dir = dir;
  return dir;
}

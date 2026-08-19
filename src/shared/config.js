/**
 * 集中读取环境变量 —— 全项目唯一的 env 入口（见 ARCHITECTURE §3 shared）。
 * 其它模块只 import 这里，不直接读 process.env。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLark, getBots, getActiveBot } from '../store/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..'); // src/shared → 仓库根

/**
 * 脚本目录（绝对路径）：SCRIPTS_DIR 覆盖 > APP_DATA_DIR/scripts > 仓库根/scripts（dev 兜底）。
 * 纯函数，接收 env 便于测试；不依赖进程 cwd（打包后 cwd=AppData 会找不到脚本）。
 */
export function scriptsDirFor(env = process.env) {
  if (env.SCRIPTS_DIR) return path.resolve(env.SCRIPTS_DIR);
  if (env.APP_DATA_DIR) return path.join(env.APP_DATA_DIR, 'scripts');
  return path.join(REPO_ROOT, 'scripts');
}

/** 逗号分隔 open_id 列表 → 数组（trim + 去空）；OWNER_OPEN_IDS 用 */
export function parseOpenIdList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  web: {
    port: Number(process.env.PORT) || 3000,
    host: '127.0.0.1',
  },
  lark: {
    appId: process.env.LARK_APP_ID,
    appSecret: process.env.LARK_APP_SECRET,
    // owner 白名单（逗号分隔 open_id）→ 完整 Claude 能力
    ownerOpenIds: parseOpenIdList(process.env.OWNER_OPEN_IDS),
    // 注：环境变量 TRUSTED_OPEN_IDS 已废弃并从此处移除。可信提交人的唯一来源是
    // 基础设置里的「我的飞书 open_id」（见 shared/trusted-ids.js 的 resolveTrustedOpenIds）。
    // 不保留成一个没人读的字段：留着它就等于继续对外承诺一个不生效的开关。
    // 收到消息时随机贴一个「处理中」表情（emoji_type，逗号分隔，可用 env 覆盖）
    // 依次为：稍等 / 在做了 / 敲键盘 / 背叛 / 汗
    reactionEmojis: (process.env.REACTION_EMOJIS || 'OneSecond,OnIt,Typing,BETRAYED,SWEAT')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  scripts: {
    dir: scriptsDirFor(),
    pythonBin: process.env.PYTHON_BIN || 'python',
  },
  intent: {
    // 意图识别用的轻模型（走订阅）——用 Haiku：分类只需一行 JSON，冷启动/生成远快于 Sonnet
    classifyModel: process.env.CLASSIFY_MODEL || 'claude-haiku-4-5',
  },
  feedback: {
    // 分析需求/故障时读取的代码项目目录（只读分析，不改码）。
    // 缺省必须为空串，**不能**写死某台机器上的绝对路径：
    // 换机/换人后那些路径必然不存在，而调用方多是 `bot?.projectDir || config.feedback.frontendDir`
    // 这种兜底写法 —— 写死路径会让它静默落到一个不存在的目录，表现为「分析结果莫名其妙」
    // 而不是一句清晰的报错。真实值由 .env 的 FRONTEND_DIR / BACKEND_DIR 或机器人配置的
    // projectDir 提供；两者都缺时退化为「不指定工作目录」，而不是指向别人机器上的路径。
    frontendDir: process.env.FRONTEND_DIR || '',
    backendDir: process.env.BACKEND_DIR || '',
  },
  taskTriage: {
    // 进入待处理流程的触发词正则（env TRIAGE_TRIGGER 可覆盖）
    triggerPattern: process.env.TRIAGE_TRIGGER
      ? new RegExp(process.env.TRIAGE_TRIGGER)
      : /待处理|待办|代办|要处理|要办|处理一下/,
    // 可选单人白名单 open_id；空 = 沿用 lark.ownerOpenIds（满足「仅我本人」）
    ownerOpenId: (process.env.TRIAGE_OWNER_OPEN_ID || '').trim() || null,
    // 流程内意图分类兜底模型（复用 intent 的轻模型）
    classifyModel: process.env.CLASSIFY_MODEL || 'claude-haiku-4-5',
  },
  autoDev: {
    // DEV 编译脚本（在 config.scripts.dir 下），需支持 --env dev --branch <name>
    compileScript: process.env.UNATTENDED_COMPILE_SCRIPT || 'get_qrcode.py',
  },
};

export function assertLarkConfig() {
  if (!config.lark.appId || !config.lark.appSecret) {
    console.error(
      '❌ 缺少 LARK_APP_ID / LARK_APP_SECRET，请在 .env 配置后用 `node --env-file=.env <入口>` 启动',
    );
    process.exit(1);
  }
}

/** 飞书凭证：启用的飞书机器人；已配置 bots 但全部停用 → 返回空（应断连，勿被 env 复活）；
 *  从未配置过 bots（未迁移/裸 env 部署）才回落旧 lark 字段与 env。 */
export function getLarkCredentials() {
  const bot = getActiveBot();
  if (bot && bot.platform === 'feishu' && bot.appId && bot.appSecret) {
    return { appId: bot.appId, appSecret: bot.appSecret };
  }
  if (getBots().length > 0) return { appId: '', appSecret: '' }; // 有机器人但无可用启用项 = 用户意图下线
  const s = getLark();
  return {
    appId: s.appId || config.lark.appId || '',
    appSecret: s.appSecret || config.lark.appSecret || '',
  };
}

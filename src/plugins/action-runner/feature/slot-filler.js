/**
 * 槽位填充 —— 从用户消息中提取动作所需变量值，识别缺失的必填变量。
 * 优先用 Claude（精准提取），失败/超时/额度耗尽降级到正则兜底（手机号 / env）。
 *
 * 抽取完一律过 normalizeVars 归一（当前只有 env 有归一规则）。事故背景：
 * 用户说「体验版」时机器人识别不到，只有说「test」才稳 —— 两条路径都不认中文：
 *   1) 正则兜底只有 /\b(dev|test)\b/：中文别名与 prod 全漏 → 判字段缺失 → 追问；
 *   2) Claude 抽取提示词没给候选值，抽出的是中文原值（action-log.jsonl 有实证
 *      {"env":"正式版"}），而 reset_onboarding.py / refund_orders.py 是
 *      argparse choices=["dev","test"]，中文进去直接退出 2。
 * 归一层放在 Node 侧而不是各脚本里：脚本是用户可自己加的，不能要求每个脚本都自带别名表。
 */
import { getVar } from '../../../store/user-vars.js';
import { runClassifierOnce } from '../../../features/llm-classify.js';
import { logger } from '../../../shared/logger.js';

// 抽取用轻模型（Haiku）：仅做单轮抽取，不需要重模型（与 config.intent.classifyModel 无关，那是分类用的 sonnet）
const EXTRACT_MODEL = 'claude-haiku-4-5';
// 超时即 abort（runClassifierOnce 内部还有 race 兜底），绝不拖死上层槽位填充流程
const EXTRACT_TIMEOUT_MS = 10_000;

/**
 * 环境别名 → 规范值。**必须与 scripts/get_qrcode.py 的 ENV_ALIASES 保持一致**
 *（那边是脚本侧的第二道防线，两边同时认才不会出现「Node 认了脚本不认」）。
 */
const ENV_ALIASES = {
  dev: 'dev', 开发版: 'dev', 开发: 'dev', 开发环境: 'dev', develop: 'dev', development: 'dev',
  test: 'test', 体验版: 'test', 体验: 'test', 测试版: 'test', 测试: 'test', 测试环境: 'test', trial: 'test',
  prod: 'prod', 线上版: 'prod', 线上: 'prod', 正式版: 'prod', 正式: 'prod',
  生产版: 'prod', 生产: 'prod', 生产环境: 'prod', 线上环境: 'prod', online: 'prod', production: 'prod',
};

/** 归一前先剥掉常被一起抽出来的尾巴词（「正式版二维码」→「正式版」） */
const ENV_JUNK_RE = /(二维码|预览码|小程序码|的|环境|数据|订单|\s)/g;

/**
 * 自由文本里扫描环境词的**保守**正则（与 normalizeEnv 的宽松策略刻意不同）。
 * 只收无歧义的完整说法：裸「测试」「开发」在自由文本里几乎都是动词
 *（「帮我测试一下这个功能」「开发那边说…」），收进来会把无关消息误判成有环境。
 * 裸词只在追问上下文（forVar）里才认——那时整条消息就是对「哪个环境？」的回答。
 */
const ENV_SCAN_RE =
  /(?:\b(dev|test|prod|production)\b|开发版|开发环境|体验版|测试版|测试环境|线上版|线上环境|正式版|生产环境)/i;

/**
 * 同上，g 版本，**只给 matchAll 用**（matchAll 要求 g，且按规范会内部克隆正则，
 * 不会污染这里的 lastIndex；仍单独定义一个常量，避免任何人拿它去 .test()）。
 */
const ENV_SCAN_RE_G = new RegExp(ENV_SCAN_RE.source, 'gi');

/**
 * 否定词：出现在环境词**所在分句**里，说明这个环境词是被排除的对象而不是目标。
 * 事故场景：「别清 test，清 dev」——旧实现取第一个命中，直接清了 test（不可逆）。
 */
const NEGATION_RE = /(别|不要|不是|不用|无需|除了|而不是)/;

/** 分句边界：否定词只在同句内生效，否则「不是很急，清一下 test 环境」会被误伤 */
const CLAUSE_SPLIT_RE = /[，,。；;！!？?\n]/;

/**
 * 自由文本里扫环境词，**拿不准就弃权**（返回 null → 该字段判缺失 → 追问一次）。
 * 猜错的代价是清错环境/退错款（不可逆），多问一句的代价只是一轮对话 —— 不对称，永远选后者。
 * 弃权条件：① 出现两个不同环境（「别清 test，清 dev」）；② 环境词所在分句里有否定词。
 * 注意：只约束正则。LLM 抽出的值照常采纳 —— 语义判断本就该模型做，它能读懂「别…要…」。
 */
function scanEnv(text) {
  const t = String(text ?? '');
  const hits = [];
  for (const m of t.matchAll(ENV_SCAN_RE_G)) {
    const env = normalizeEnv(m[0]);
    if (env) hits.push({ env, index: m.index });
  }
  if (!hits.length) return null;

  if (new Set(hits.map((h) => h.env)).size > 1) {
    logger.info('slot-filler', '一句话出现多个环境词，正则弃权（交给追问/LLM）', {
      envs: [...new Set(hits.map((h) => h.env))],
    });
    return null;
  }

  const { env, index } = hits[0];
  const clause = t.slice(0, index).split(CLAUSE_SPLIT_RE).pop();
  if (NEGATION_RE.test(clause)) {
    logger.info('slot-filler', '环境词被否定词修饰，正则弃权（交给追问/LLM）', { env });
    return null;
  }
  return env;
}

/**
 * 把用户/LLM 给出的环境词归一到 dev/test/prod；识别不了返回 null（**绝不瞎猜**）。
 * @param {unknown} raw
 * @returns {'dev'|'test'|'prod'|null}
 */
export function normalizeEnv(raw) {
  const v = String(raw ?? '').trim().replace(ENV_JUNK_RE, '');
  if (!v) return null;
  return ENV_ALIASES[v] || ENV_ALIASES[v.toLowerCase()] || null;
}

/** 变量名 → 归一函数。归一返回 null 表示「这个值不合法」，调用方按未提供处理。 */
const NORMALIZERS = { env: normalizeEnv };

/**
 * 按变量名归一收集到的值；归一失败的键**直接删掉**（视为该字段缺失，走追问），
 * 而不是把非法值透传给脚本 —— 后者会让用户看到一坨 argparse 报错。
 * @param {object} actionConfig
 * @param {object} vars
 * @returns {object} 归一后的新对象
 */
export function normalizeVars(actionConfig, vars) {
  const out = { ...(vars || {}) };
  for (const v of actionConfig?.variables || []) {
    const fn = NORMALIZERS[v.name];
    if (!fn || !(v.name in out)) continue;
    const normalized = fn(out[v.name]);
    if (normalized) out[v.name] = normalized;
    else {
      logger.info('slot-filler', '变量值无法归一，按缺失处理', { name: v.name, raw: String(out[v.name]).slice(0, 40) });
      delete out[v.name];
    }
  }
  return out;
}

/**
 * 从用户消息文本提取配置所需的变量值，并与该用户已持久化的变量合并。
 * @param {object} actionConfig 动作配置（含 variables 定义）
 * @param {string} text 用户消息
 * @param {string|null} userId 用于查询持久变量；null 表示不查（如追问中间态的新输入）
 * @param {{forVar?: string, llmExtract?: Function}} [opts]
 *   forVar：当前正在追问的变量名 —— 此时整条消息就是对该字段的回答，允许把整条消息送去归一
 *           （用户只回「体验」两个字也要认，自由文本正则不收这种裸词）。
 *   llmExtract：可注入的 LLM 抽取函数，单测用（默认真实 Claude 调用）。
 * @returns {Promise<object>} 已收集变量（部分，已归一）
 */
export async function extractVars(actionConfig, text, userId, opts = {}) {
  const persistent = userId ? getPersistentVars(actionConfig, userId) : {};
  const extracted = await extractVarsFromText(actionConfig, text, opts);
  return normalizeVars(actionConfig, { ...persistent, ...extracted });
}

/** 获取该用户已持久化的变量（仅 persistent=true 的变量） */
function getPersistentVars(actionConfig, userId) {
  const result = {};
  for (const v of actionConfig.variables || []) {
    if (v.persistent) {
      const val = getVar(userId, v.name);
      if (val) result[v.name] = val;
    }
  }
  return result;
}

/** 从文本中提取变量（仅新值，不查持久化） */
async function extractVarsFromText(actionConfig, text, opts = {}) {
  const { forVar, llmExtract = tryClaudeExtract } = opts;
  const requiredVars = (actionConfig.variables || []).filter((v) => v.required);

  // 正则兜底先跑（同步、零成本），LLM 结果覆盖其上。
  // 刻意不是二选一：LLM 抽取常常只吐它最有把握的一两个字段，漏掉的正好由正则补上
  //（旧实现是 LLM 一旦成功就完全不看正则，白白丢掉能抓到的值）。
  const merged = { ...regexExtract(text) };
  if (requiredVars.length > 0) {
    const llm = await llmExtract(text, requiredVars);
    if (llm) {
      for (const [k, v] of Object.entries(llm)) {
        if (v !== null && v !== undefined && String(v).trim()) merged[k] = v;
      }
    }
  }

  // 追问上下文：该字段仍然没抓到时，把整条消息当作它的候选值送去归一。
  // 只对有归一函数的变量生效 —— 没有校验器的自定义变量不能盲取，否则「我不知道」会被当成答案。
  if (forVar && !merged[forVar] && NORMALIZERS[forVar]) {
    const v = NORMALIZERS[forVar](text);
    if (v) merged[forVar] = v;
  }
  return merged;
}

/** 用 Claude 提取变量（失败返回 null，降级到正则兜底） */
async function tryClaudeExtract(text, variables) {
  const varDefs = variables.map((v) => `${v.name}=${v.label || v.name}`).join(', ');
  const hasEnv = variables.some((v) => v.name === 'env');
  const prompt =
    `从用户消息提取变量，仅输出一行 JSON。\n` +
    `变量定义：${varDefs}\n` +
    // 给出候选值与归一要求：不给的话模型会原样吐中文（实测抽出 "正式版"），
    // 而脚本侧 argparse choices=["dev","test"] 只认规范值。
    (hasEnv
      ? `env 只能取 dev / test / prod 三者之一，需把用户说法归一：\n` +
        `  开发版·开发环境·dev → dev；体验版·测试版·测试环境·test → test；线上版·正式版·生产环境·prod → prod\n` +
        `  用户没提环境、或说的是其它环境（如「预发布」）时，省略 env 字段，不要猜。\n`
      : '') +
    `用户消息：「${text}」\n` +
    `输出：{"变量名":"值"}，找不到的字段省略。`;

  // 复用 llm-classify 的单轮调用骨架：额度耗尽 fail-fast（旧实现没有，限流时白等 10s
  // 再落正则兜底，正是「只有说 test 才准」的高频诱因）、abort+race 双保险、首个 JSON 块提取。
  return runClassifierOnce({
    prompt,
    model: EXTRACT_MODEL,
    logTag: 'slot-filler/extract',
    timeoutMs: EXTRACT_TIMEOUT_MS,
  });
}

/** 正则兜底：手机号、env（LLM 失败/超时/额度耗尽时的唯一防线，必须认中文别名） */
function regexExtract(text) {
  const result = {};
  const t = String(text ?? '');
  const phoneMatch = t.match(/1[3-9]\d{9}/);
  if (phoneMatch) result.phone = phoneMatch[0];
  const env = scanEnv(t);
  if (env) result.env = env;
  return result;
}

/**
 * 从配置中找出缺失的必填变量
 * @param {object} actionConfig
 * @param {object} collected 已收集的变量
 * @returns {Array<object>} 缺失的变量定义
 */
export function pickMissingVars(actionConfig, collected) {
  return (actionConfig.variables || []).filter((v) => v.required && !collected[v.name]);
}

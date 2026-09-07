/**
 * 槽位填充 —— 编排层。真正的抽取逻辑在三个纯函数模块里：
 *   var-contract.js  变量声明 → 有效契约（展开 preset）
 *   local-extract.js 本地确定性抽取（词表 / 正则 + 弃权规则）
 *   extract-prompt.js LLM 提示词生成
 *
 * 本文件只负责串起来：本地抽 → 还缺必填吗 → 缺才调一次 LLM → 合并归一。
 *
 * ## 为什么这么拆（2026-09-04 改造）
 *
 * 旧实现把抽取规则按**变量名**写死在三处：`NORMALIZERS = { env: normalizeEnv }`、
 * `regexExtract` 里的 `phone`/`env` 字面量、提示词里的 `hasEnv` 分支。用户新加一个动作、
 * 变量叫 `region` 或 `订单号`，三处一处都不生效 —— 抽不到、归一不了、模型也不知道合法值，
 * 表现为「机器人老是追问」，而用户无从察觉原因。
 *
 * ## 顺带解决的延迟
 *
 * 旧实现**每次**都调一次 LLM 抽参，生产实测 8~17s（光 Claude Code SDK 冷启就 2.7~3.7s，
 * 实测一次鉴权即失败的调用 init 仍耗 2.7s）。而 env 是闭集查表、phone 是正则，都不需要推理。
 * 现在这类变量本地抽完就返回，**主路径零 LLM**；LLM 只在还剩自由文本字段时才调，
 * 且提示词里只列剩下的字段。
 */
import { getVar } from '../../../store/user-vars.js';
import { runClassifierOnce } from '../../../capabilities/llm-classify.js';
import { logger } from '../../../shared/logger.js';
import { resolveVariable } from './var-contract.js';
import { localExtract, normalizeValue } from './local-extract.js';
import { buildExtractPrompt } from './extract-prompt.js';

/** 抽取用轻模型：已是最低档（Haiku）。分类点统一的 effort 默认档在 llm-classify.js。 */
const EXTRACT_MODEL = 'claude-haiku-4-5';

/**
 * 超时即 abort（runClassifierOnce 内部还有 race 兜底），绝不拖死上层槽位填充流程。
 *
 * 为什么是 25s 而不是最初的 10s：生产实测这次调用耗时落在 8~17s
 *（app-2026-09-04.log 有 `result ms:10321` 紧跟 `✖ runClaude ms:10440 Operation aborted`
 * —— 模型算完了、钱也扣了，却被超时丢弃）。预算卡在耗时分布中间会让成败五五开。
 *
 * 改造后这条路径只在「还有自由文本必填字段」时才走到，触发频率大幅下降，
 * 但预算仍保持 25s：偶尔走一次就要走通，不能再出现「算完了被丢掉」。
 */
const EXTRACT_TIMEOUT_MS = 25_000;

/**
 * 从用户消息文本提取配置所需的变量值，并与该用户已持久化的变量合并。
 *
 * @param {object} actionConfig 动作配置（含 variables 定义）
 * @param {string} text 用户消息
 * @param {string|null} userId 用于查询持久变量；null 表示不查（如追问中间态的新输入）
 * @param {{forVar?: string, llmExtract?: Function}} [opts]
 *   forVar：当前正在追问的变量名 —— 该变量额外获得 weakAliases 与「整条消息当候选值」两项待遇
 *           （用户只回「体验」两个字也要认）。
 *   llmExtract：可注入的 LLM 抽取函数 `(text, unresolved) => Promise<object|null>`，单测用。
 *               `unresolved` 是 resolveVariable 的产物数组。
 *   onLlmStart：**即将真的发起 LLM 调用**时同步回调一次（本地全命中则永不触发）。
 *               调用方用它来发「请稍等」那条即时应答 —— 本地抽取是亚毫秒级的，
 *               命中就直接执行了，此时再弹一句「我正在确认所需信息」纯属噪音
 *               （用户会先看到「请稍等」再立刻看到「正在执行」，观感像卡了一下）。
 *               为什么是回调而不是让调用方自己判断：要判断就得把「哪些字段还缺、
 *               持久值顶不顶得住、是不是弃权」这套规则在 feature 层再实现一遍，
 *               两份规则迟早分叉。
 * @returns {Promise<object>} 已收集变量（部分，已归一）
 */
export async function extractVars(actionConfig, text, userId, opts = {}) {
  const { forVar, llmExtract = llmExtractDefault, onLlmStart } = opts;
  const variables = actionConfig?.variables || [];
  const persistent = userId ? getPersistentVars(actionConfig, userId) : {};

  // ① 本地确定性抽取（零成本）
  const { values: local, unresolved } = localExtract(variables, text, { forVar });

  // ② 决定要不要为这些字段烧一次 LLM。**「值不值得调」与「调了问哪些字段」是两件事**，
  //    合成一件会出安全问题（复核实证，2026-09-04）：
  //
  //    - 值不值得调（trigger）：必填 + 本地抽不出 + 「没有持久化旧值 **或** 本地是弃权而非没提到」。
  //      持久化旧值能顶掉一个字段，正是「第二次不用再报手机号」这个功能；但**弃权不算没提到** ——
  //      用户说「我的号从 138… 换成 139…，清一下 test」会因两个号命中而弃权，若当成没提到就会
  //      静默沿用旧号，清掉另一个人的数据。
  //    - 调了问哪些（payload）：全部必填的 unresolved，**含被持久化顶掉的那些**。
  //      调用既然已经发生，边际成本为零，而用户这次说的新值必须有机会覆盖旧值
  //      （旧实现把它们排除在提示词外，于是新值永远进不来）。
  //
  //    非必填字段两边都不进：为一个可选字段烧 8~17s 不划算，缺了也不影响执行。
  const declOf = new Map(variables.filter((v) => v && v.name).map((v) => [v.name, v]));
  const requiredUnresolved = unresolved.filter((rv) => declOf.get(rv.name)?.required);
  const shouldCallLlm = requiredUnresolved.some((rv) => !persistent[rv.name] || rv.reason === 'abstained');

  let fromLlm = {};
  if (shouldCallLlm) {
    // 通知调用方「这次真要等模型了」。绝不让它的异常影响抽取本身 ——
    // 它的唯一用途是发一条锦上添花的提示。
    try {
      onLlmStart?.();
    } catch (e) {
      logger.warn('slot-filler', 'onLlmStart 回调异常（不影响抽取）', { err: e?.message || String(e) });
    }
    const got = await llmExtract(text, requiredUnresolved);
    if (got && typeof got === 'object') {
      for (const [k, v] of Object.entries(got)) {
        // 只收「声明过 && 本地没抽到」的字段：本地抽到的是确定性结果，
        // 不该被模型改写；没声明过的键是模型幻觉，直接丢。
        if (!declOf.has(k) || k in local) continue;
        if (v === null || v === undefined || !String(v).trim()) continue;
        fromLlm[k] = v;
      }
    }
  } else if (unresolved.length) {
    logger.info('slot-filler', '全部必填字段本地抽取命中，跳过 LLM', {
      resolved: Object.keys(local),
      skipped: unresolved.map((rv) => rv.name),
    });
  }

  // ③ 合并。顺序：持久化 < 本地 < LLM —— 用户这次说的话优先于上次存的值。
  const merged = { ...persistent, ...local, ...fromLlm };

  // ④ 弃权字段的最后一道闸：本地读不准、LLM 也没给出值时，**丢弃持久化旧值**，
  //    让它判缺失去追问。否则「我的号从 138… 换成 139…」在 LLM 也失手时仍会落回旧号 ——
  //    而这条链路的下游是清数据 / 退款这类不可逆脚本。宁可多问一句。
  for (const rv of requiredUnresolved) {
    if (rv.reason !== 'abstained') continue;
    if (rv.name in fromLlm || rv.name in local) continue;
    if (!(rv.name in merged)) continue;
    logger.info('slot-filler', '本地弃权且 LLM 未给出值，丢弃持久化旧值改为追问', { name: rv.name });
    delete merged[rv.name];
  }

  return normalizeCollected(variables, merged);
}

/**
 * 按变量声明归一全部收集到的值；归一失败的键**直接删掉**（视为缺失，走追问），
 * 而不是把非法值透传给脚本 —— 后者会让用户看到一坨 argparse 报错。
 *
 * 持久化的值也要过这一关：user-vars 里可能存着旧格式或被手改坏的值。
 */
function normalizeCollected(variables, collected) {
  const out = { ...(collected || {}) };
  for (const raw of variables) {
    const rv = resolveVariable(raw);
    if (!rv.name || !(rv.name in out)) continue;
    // weak=true：走到这里的值要么是用户明确给的、要么是模型抽的，都已脱离「自由文本歧义」语境
    const normalized = normalizeValue(rv, out[rv.name], { weak: true });
    if (normalized) out[rv.name] = normalized;
    else {
      logger.info('slot-filler', '变量值无法归一，按缺失处理', {
        name: rv.name,
        raw: String(out[rv.name]).slice(0, 40),
      });
      delete out[rv.name];
    }
  }
  return out;
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

/**
 * 默认 LLM 抽取：提示词由变量声明自动生成（不再有 `name === 'env'` 之类的分支）。
 * 失败/超时/额度耗尽返回 null，此时缺失字段走追问。
 */
async function llmExtractDefault(text, unresolved) {
  return runClassifierOnce({
    prompt: buildExtractPrompt(unresolved, text),
    model: EXTRACT_MODEL,
    logTag: 'slot-filler/extract',
    timeoutMs: EXTRACT_TIMEOUT_MS,
  });
}

/**
 * 从配置中找出缺失的必填变量
 * @param {object} actionConfig
 * @param {object} collected 已收集的变量
 * @returns {Array<object>} 缺失的变量定义（**原始声明**，调用方要读 prompt/label）
 */
export function pickMissingVars(actionConfig, collected) {
  return (actionConfig.variables || []).filter((v) => v.required && !collected[v.name]);
}

/**
 * 动作关键词自学习 —— 「这次花了一次模型调用才认出来的说法，下次让它走本地快路」。
 *
 * 触发条件（由 feature/index.js 把关）：L3 语义兜底命中 action **且** 脚本执行成功。
 * 「执行成功」是用户用行为给出的确认，比模型自己的置信度可靠得多 ——
 * 中途取消、脚本失败都不学，避免把一次误判固化成永久关键词。
 *
 * 全程 fire-and-forget：调用方不 await、不看返回值。学关键词失败绝不该影响用户拿到执行结果。
 *
 * 模型只负责**提词**，能不能加由 keyword-guard.js 的确定性规则裁决（见该文件头）。
 */
import { runClassifierOnce } from '../../../capabilities/llm-classify.js';
import { getConfigs, appendAutoKeyword } from '../../../store/action-configs.js';
import { canLearnKeyword, MAX_AUTO_KEYWORDS } from './keyword-guard.js';
import { config } from '../../../shared/config.js';
import { logger } from '../../../shared/logger.js';

/** 一轮最多沉淀几个词：多了会让一句话吃光配额，也超出「不激进」的口径 */
const MAX_PER_ROUND = 2;

/** 触发原句喂给模型的长度上限（长文只取前段，够用且省 token） */
const SOURCE_TEXT_MAX = 300;

/**
 * 提词 prompt 里最多列几个其他动作。
 * 与 `app/intent.js` 的 `ACTION_POOL_MAX` 同一口径：动作多的 bot 上，全量列举只是线性烧 token，
 * 还会稀释模型对「当前这个动作」的注意力。截断不影响安全性 —— 冲突的最终裁决在 keyword-guard，
 * 它拿的是**全量** otherActions，不受这里影响。
 */
const PROMPT_ACTION_MAX = 20;

/** 拼提词 prompt。其他动作最多列 PROMPT_ACTION_MAX 个，让模型先自己避一道；最终裁决仍在硬闸。 */
function buildPrompt(action, otherActions, sourceText) {
  if (otherActions.length > PROMPT_ACTION_MAX) {
    logger.warn('action-learn', '提词 prompt 的其他动作超过上限，已截断', {
      total: otherActions.length,
      max: PROMPT_ACTION_MAX,
    });
  }
  const others = otherActions
    .slice(0, PROMPT_ACTION_MAX)
    .map((c, i) => `${i + 1}. ${c.name} —— ${c.description || '（无描述）'}（关键词：${(c.keywords || []).join('、') || '无'}）`)
    .join('\n');

  return (
    `你在维护一个聊天机器人的「动作关键词表」。关键词的用法是：用户消息只要**包含**某个关键词，就直接触发对应动作，不再调用模型。\n\n` +
    `这次用户说了一句话，系统花了一次模型调用才认出他想执行哪个动作。现在要把这个说法沉淀成关键词。\n\n` +
    `用户原话：「${String(sourceText).slice(0, SOURCE_TEXT_MAX)}」\n` +
    `本次命中的动作：${action.name} —— ${action.description || '（无描述）'}\n` +
    `该动作已有关键词：${(action.keywords || []).join('、') || '无'}\n\n` +
    (others ? `同一机器人下的其他动作（必须避开会与它们混淆的说法）：\n${others}\n\n` : '') +
    `请给出 1-3 个候选关键词，规则：\n` +
    `1. 必须是用户原话里**原样出现的连续片段**，一个字都不能改、不能调换顺序、不能补字。\n` +
    `2. 要能代表「想做这件事」的意图，通常是动宾短语。\n` +
    `3. 不要给变量值：环境名、手机号、用户 ID、日期这类是参数，不是意图。\n` +
    `4. 不要给通用词：帮我、一下、麻烦、数据、环境、系统……它们在任何消息里都可能出现。\n` +
    `5. 放进上面任何一个其他动作的语境里也说得通的词，一律不要给。\n` +
    `6. 想不出合格的就给空数组，宁缺毋滥。\n\n` +
    `只输出一行 JSON，不要任何解释：{"keywords":["…"]}`
  );
}

/**
 * 学一轮关键词。
 *
 * @param {{action: object, sourceText: string}} o action 为命中的动作配置，sourceText 为触发原句
 * @param {object} [deps] 依赖注入口（单测用）
 * @returns {Promise<string[]>} 本轮真正写入的词
 */
export async function learnKeywords({ action, sourceText }, deps = {}) {
  const {
    classify = runClassifierOnce,
    listConfigs = getConfigs,
    append = appendAutoKeyword,
    guard = canLearnKeyword,
  } = deps;

  const text = String(sourceText ?? '').trim();
  if (!action?.id || !text) return [];

  // 配额先看一眼：满了连模型都不用调（省一次调用）
  if ((action.autoKeywords || []).length >= MAX_AUTO_KEYWORDS) {
    logger.info('action-learn', '自动关键词已满，跳过本次学习', { actionId: action.id });
    return [];
  }

  // 冲突判据只取**同 bot 的其余启用动作**：动作 per-bot 独享，跨 bot 不会互相干扰；
  // 已禁用的动作不参与 L2 匹配，拿它做冲突判断会无谓地卡掉合法候选。
  const otherActions = listConfigs().filter(
    (c) => c && c.enabled !== false && c.botId === action.botId && c.id !== action.id,
  );

  const data = await classify({
    prompt: buildPrompt(action, otherActions, text),
    model: config.intent.classifyModel,
    logTag: 'action/learn-kw',
  });
  const candidates = Array.isArray(data?.keywords) ? data.keywords : [];
  if (!candidates.length) {
    logger.info('action-learn', '模型未给出候选词', { actionId: action.id });
    return [];
  }

  const learned = [];
  for (const raw of candidates) {
    if (learned.length >= MAX_PER_ROUND) break;
    const word = String(raw ?? '').trim();

    // 本轮已学的词必须参与后续候选的判重与配额 —— action 是进函数时的快照，
    // 逐个写盘不会让它自动更新（否则「清掉业务表」和「清掉业务」会双双写进去）。
    const snapshot = {
      ...action,
      keywords: [...(action.keywords || []), ...learned],
      autoKeywords: [...(action.autoKeywords || []), ...learned.map((w) => ({ word: w }))],
    };

    const verdict = guard({ word, action: snapshot, otherActions, sourceText: text });
    if (!verdict.ok) {
      logger.info('action-learn', '候选词未通过硬闸', {
        actionId: action.id,
        word,
        reason: verdict.reason,
      });
      continue;
    }

    if (append(action.id, word, { sourceText: text, max: MAX_AUTO_KEYWORDS })) {
      learned.push(word);
      logger.info('action-learn', '已学到新关键词', { actionId: action.id, word });
    } else {
      // 过了本地硬闸却没写进去：说明锁内复核拒了（另一进程刚把配额写满 / 该词已存在）。
      // 不记的话，排查「这个词明明该学怎么没学到」只能靠上面那条日志的缺席去反推，等于没线索。
      logger.info('action-learn', '候选词过闸但写盘被拒（锁内复核）', { actionId: action.id, word });
    }
  }

  return learned;
}

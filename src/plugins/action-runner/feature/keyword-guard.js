/**
 * 动作关键词自学习的本地硬闸（纯函数）。
 *
 * 模型提的候选词说了不算 —— 最终裁决全在这里。理由：L2 匹配（`消息.includes(关键词)`）
 * 是**全局共享的资源**，给 A 动作加一个词可能让 B 动作原本秒出的消息变成多命中而退回 L3。
 * 这种伤害对用户不可见、对提词的模型更不可见，只能靠确定性规则挡。
 *
 * ⚠️ 依赖纪律：本文件只许 import `app/intent-keywords.js` —— 它是刻意允许的零依赖叶子
 * （见 `src/app/CLAUDE.md` §C，`src/import-graph.test.js` 有测试钉住它保持零 import）。
 * **不得** import `app/intent.js` 的 `isChitchat`：那个文件依赖 llm-classify 与 store，
 * 引进来是把整条分类链拖进插件层的真实反向依赖。寒暄拦截由长度闸 + 黑名单承担
 * （常见寒暄本就 2 字：你好 / 在吗 / 谢谢，长度闸已经卡掉）。
 *
 * ## 已知边界：本闸只管「子串嵌套」，管不到「共现」
 *
 * 规则 5 拦的是「候选词与别人的关键词互为子串」。它管不到另一种多命中：两个互不为子串的词
 * 出现在同一句话里 —— 学了「生成登录码」给 A 之后，「帮我生成登录码，然后重置密码」会同时
 * 命中 A 和持有「重置密码」的 B。
 *
 * 不为它加规则，有两个理由：
 * 1. 这是 L2「多词表共存」的固有属性，不是自学习引入的 —— 人工在面板上配同一个词，效果一模一样。
 * 2. 一句话同时要求两个动作，本来就是 L2（只认单命中）无法正确处理的。退回 L3 由模型判断
 *    用户到底想干哪个，恰恰是**正确行为**，不是伤害。
 *
 * 真正的伤害只发生在「本该单命中的句子被拖成多命中」，那正是规则 5 覆盖的范围。
 * 想用确定性规则穷尽共现组合是做不到的（只防得住训练那一句，防不住其后任意组合）。
 */
import { matchStrongIntent } from '../../../app/intent-keywords.js';

/** 每个动作最多自动学 5 个词：够覆盖常见说法，又不至于让关键词表膨胀到没人看得懂 */
export const MAX_AUTO_KEYWORDS = 5;

/** 纯中文候选词的最短长度：2 字词（「清理」「重置」）语义太弱，必然泛命中 */
const MIN_LEN_CJK = 3;
/** 含英文 / 数字的候选词最短长度 */
const MIN_LEN_MIXED = 4;
/** 候选词最长长度：再长的说法学了也不会再命中第二次，白占配额 */
const MAX_LEN = 12;

/**
 * 通用停用词 + 寒暄词黑名单。
 * 寒暄放在这里而不是调 `intent.js` 的 `isChitchat`，理由见文件头的依赖纪律；
 * 这里只需补 3 字以上的少数几个，2 字的（你好 / 在吗 / 谢谢）由长度闸拦。
 *
 * 注：表里的 2 字条目（帮我 / 一下 / 数据…）实际永远走不到这一条 —— 长度闸在前。
 * 保留它们是**冗余防线**：万一日后有人调低 MIN_LEN_CJK，这层还在。
 */
const STOP_WORDS = new Set([
  // 口语填充
  '帮我', '一下', '麻烦', '可以', '这个', '那个', '什么', '怎么', '现在',
  '我要', '我想', '需要', '能不能', '可不可以', '给我', '一个',
  // 语义太泛的业务名词
  '数据', '环境', '系统', '问题', '功能', '页面', '账号', '用户',
  // 寒暄（3 字以上）
  '早上好', '中午好', '下午好', '晚上好', '辛苦了', '谢谢你', '麻烦了',
]);

const CJK_ONLY_RE = /^[一-龥]+$/;

/**
 * 归一化：去首尾空白 + 小写。
 *
 * L2 实际匹配（`消息.includes(关键词)`）是**大小写敏感**的，这里却不敏感 —— 刻意的：
 * 归一化只会让闸判得**更严**（大小写不同但归一后重叠的一律拒），代价是少数其实不会真冲突的
 * 候选被误杀；反过来若改成大小写敏感，就会漏判真实冲突。误杀无害，漏判有害。别「优化」它。
 */
function norm(s) {
  return String(s ?? '').trim().toLowerCase();
}

/** a 与 b 互为子串（含相等）—— 双向子串冲突的判据本体 */
function overlaps(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

/**
 * 判断一个候选关键词能否学。
 *
 * 规则编号对齐设计文档 §4 步骤 3；代码里的判断顺序按「成本从低到高」排，
 * 与编号顺序不完全一致，不影响结果（任一条不过即弃）。
 *
 * @param {object} o
 * @param {string} o.word 候选词
 * @param {object} o.action 命中的动作配置（读 keywords / autoKeywords / rejectedKeywords / id）
 * @param {object[]} [o.otherActions] 同 bot 其余**启用**动作
 * @param {string} [o.sourceText] 触发本次动作的用户原句
 * @returns {{ok:boolean, reason:string}} ok=false 时 reason 说明卡在哪条，用于排查「为什么没学到」
 */
export function canLearnKeyword({ word, action, otherActions = [], sourceText = '' }) {
  // `action-configs.json` 是无 schema 校验的通用 CRUD store，配置导入等路径可能带进脏数据。
  // 这里统一归一成数组，而不是在各处零散判 —— 也顺带兜住 otherActions 本身不是数组的情况。
  const others = Array.isArray(otherActions) ? otherActions : [];
  const w = String(word ?? '').trim();
  if (!w) return { ok: false, reason: 'empty' };

  // 规则 1：必须是原句里原样出现的连续片段 —— 严格档的地基，防模型凭空造词
  if (!norm(sourceText).includes(norm(w))) return { ok: false, reason: 'not-in-source' };

  // 规则 2：长度
  if (w.length > MAX_LEN) return { ok: false, reason: 'too-long' };
  if (w.length < (CJK_ONLY_RE.test(w) ? MIN_LEN_CJK : MIN_LEN_MIXED)) {
    return { ok: false, reason: 'too-short' };
  }

  // 规则 3：停用词
  if (STOP_WORDS.has(norm(w))) return { ok: false, reason: 'stop-word' };

  // 规则 4：不得命中 L1 强前缀词表，否则「提交需求：清一下数据后白屏」会被动作抢走
  if (matchStrongIntent(w)) return { ok: false, reason: 'strong-intent-prefix' };

  // 规则 7：用户删过的词永不再学（否则面板上的「删除」形同虚设）
  // 脏数据防御：不能用 `action?.rejectedKeywords || []` —— 非空字符串是 truthy，
  // 不会走 `|| []` 分支；后续对字符串调用数组方法会直接抛 TypeError。必须先判 Array.isArray。
  const rejected = Array.isArray(action?.rejectedKeywords) ? action.rejectedKeywords : [];
  if (rejected.some((r) => norm(r) === norm(w))) {
    return { ok: false, reason: 'rejected-before' };
  }

  // 规则 6：与本动作已有词冗余 / 自动词配额已满（同样的脏数据防御，理由同上）
  const ownKeywords = Array.isArray(action?.keywords) ? action.keywords : [];
  if (ownKeywords.some((k) => overlaps(w, k))) return { ok: false, reason: 'redundant' };
  const ownAuto = Array.isArray(action?.autoKeywords) ? action.autoKeywords : [];
  if (ownAuto.length >= MAX_AUTO_KEYWORDS) {
    return { ok: false, reason: 'quota-full' };
  }

  // 规则 5：双向子串冲突（本闸的核心）。
  //   正向（候选含别人的词）：今后含候选的消息必然也含那个词 → 多命中 → L2 失效，
  //                          把**别的动作**也从秒出拖回花钱的 L3。
  //   反向（别人的词含候选）：别人那条消息今后会同时命中两边 → 同样多命中。
  // 两个方向都得拦，只查一边等于留一半的洞。
  for (const other of others) {
    if (!other || other.id === action?.id) continue;
    // 脏数据防御：`other.keywords || []` 兜不住非空字符串 —— 更危险的是字符串本身可迭代，
    // `for...of` 会逐字符遍历，把整词冲突检测静默降级成单字符比对：该拦的冲突拦不住，
    // 还不报错，比抛异常更难发现。必须先判 Array.isArray 再迭代。
    for (const k of Array.isArray(other.keywords) ? other.keywords : []) {
      if (overlaps(w, k)) return { ok: false, reason: `conflict:${other.id}` };
    }
  }

  return { ok: true, reason: '' };
}

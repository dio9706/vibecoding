/**
 * 强意图前缀词表（纯函数，零 LLM 成本的意图快路）。
 *
 * 设计铁律：
 * 1. **只匹配消息开头**——历史事故：后端接口文档整篇贴入，全文命中「错误/异常」被误判为故障。
 * 2. 只收**显式提交意图**的说法；歧义表达（「有个问题」「不能用了」「希望优化」）一律不收，
 *    交给一次 Haiku 语义分类。宁可多花一次分类调用，也不要误立案。
 * 3. 正则不加 g flag（.test()/.exec() 有状态会让重复调用结果不确定）。
 */

// 【完整说法】与正文之间允许的分隔符（可零长，也允许直接相接，如「请问订单状态…」）：
// 「提交需求」「问个问题」这类说法本身已经把提交动作说明白了，不需要标点辅助判断。
const SEP = '[\\s:：,，。、\\-—]*';
// 【裸词】与正文之间**必需**的标点分隔符。
// 为什么必需：裸词（需求/故障/bug/咨询）语义太弱，可零长分隔符会把陈述句整片吃掉 ——
// 实测「需求文档我已经发你了」判 feature、「bug 我已经修好了，不用管」判 bug、
// 「故障已经恢复了，谢谢」判 bug、「咨询过产品了，他说不用做」判 question，全是误立案。
// 规格 §3.2 里这几条本就写的是「需求：」「故障：」「bug：」，即靠标点表达「下面是正文」。
// 空白不算分隔符：「bug 我已经修好了」是陈述而不是提交（宁可多花一次 L3 分类，也不要误立案）。
// 「。」也不收：「故障。已经恢复了」同理是陈述。
const SEP_REQ = '\\s*[:：,，、\\-—]+\\s*';
// 行首允许的噪声：空白 / 标点 / 表情（\p{S} 覆盖 emoji 的符号类，\p{Emoji_Presentation} 覆盖其余）
const LEAD = '^[\\s\\p{P}\\p{S}\\p{Emoji_Presentation}]*';

/**
 * 每类的前缀候选，分两组：
 * - words：完整说法（分隔符可零长）。长的写在前，避免「提需求」抢先吃掉「提交需求」的匹配；
 *   同理「请问一下」必须排在「请问」之前，否则 body 被切成「一下这个怎么用」。
 * - bare：短裸词（必需标点分隔符，见 SEP_REQ 注释）。
 */
const GROUPS = [
  {
    type: 'feature',
    words: ['提交需求', '提个需求', '提一个需求', '有一个需求', '有个需求', '提需求'],
    bare: ['需求'],
  },
  {
    type: 'bug',
    words: [
      '提交故障', '提个故障', '有一个故障', '有个故障', '提交问题',
      '提交bug', '提个bug', '有一个bug', '有个bug', '报个bug', '报一个bug',
    ],
    bare: ['故障', 'bug'],
  },
  {
    type: 'question',
    words: [
      '问一个问题', '问个问题', '想问一下', '想问下', '想问问', '问一下',
      '有个疑问', '有一个疑问', '咨询一下', '请问一下', '请问',
    ],
    bare: ['咨询'],
  },
];

/**
 * 词表 → 编译好的正则（模块加载时一次性编译；u flag 供 \p{...} 使用，无 g flag）。
 * 完整说法分支排在裸词分支之前：两者都能匹配时（如「提交需求：x」）走完整说法，剥掉更长的前缀。
 */
const PATTERNS = GROUPS.map(({ type, words, bare }) => ({
  type,
  re: new RegExp(`${LEAD}(?:(?:${words.join('|')})${SEP}|(?:${bare.join('|')})${SEP_REQ})`, 'iu'),
}));

/**
 * 匹配强意图前缀。
 * @param {unknown} text
 * @returns {{ type:'bug'|'feature'|'question', body:string } | null}
 *   body = 剥掉前缀与分隔符后的正文（只发前缀时为空串，调用方据此追问）
 */
export function matchStrongIntent(text) {
  const t = typeof text === 'string' ? text : '';
  if (!t.trim()) return null;
  for (const { type, re } of PATTERNS) {
    const m = re.exec(t);
    // 必须从开头命中（LEAD 已锚 ^，此处再确认 index===0 以防意外）
    if (m && m.index === 0 && m[0].trim()) {
      return { type, body: t.slice(m[0].length).trim() };
    }
  }
  return null;
}

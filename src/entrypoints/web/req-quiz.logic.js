/**
 * 评审期问卷纯逻辑 —— prompt 构造 / LLM 输出解析 / 答案回注（单测目标，零 IO）。
 *
 * 问卷的意义不是「多问几句」，而是**把模型的猜测摊开给用户看**：每题必有且只有一个
 * `guess:true` 选项，界面上标成「AI 猜测」并注明「不选就按这个实现」。用户全跳过也没关系，
 * 至少他知道模型会怎么走——这正是「实现的不对」的根因所在。
 */
import { parseJsonLoose } from './req-map.logic.js';
import { projectRoleLines } from './req-logic.js';

/** 题数上下限：少于 MIN 说明没找出真歧义（不如不问），多于 MAX 用户会答烦。 */
export const QUIZ_MIN = 3;
export const QUIZ_MAX = 8;

/** 每题选项数上下限。 */
const OPT_MIN = 2;
const OPT_MAX = 4;

/**
 * 「不确定」选项的保留值。
 *
 * 它不是 LLM 生成的选项（parseQuiz 强制每题恰好一个 guess），而是前端在选项列表
 * 末尾注入的固定项——问卷改为「必答」后，逃生口从整体跳过下沉到每题，用户至少被迫
 * 看过一遍这些不确定点。选它 = 明确表示不知道，语义上不同于压根没答。
 */
export const UNSURE_VALUE = '__unsure__';

export function buildQuizPrompt({ reqDocText, projects, primeText = '' }) {
  const roles = projectRoleLines(projects);
  // 用户已在背景里说清的地方不该再问：否则界面上承诺的「说清楚的就不会再问」成了空话，
  // 用户写了半页背景还被问同样的问题，下次就不会再写了。
  const prime = String(primeText ?? '').trim();
  const primeSec = prime
    ? `用户已补充的背景（**这里已经说清的内容不要再问**）：\n「${prime}」\n\n`
    : '';
  return (
    `你是资深架构师。请阅读需求文档并实际查证下列工程，找出**文档里描述不明确、你不得不靠猜测才能动手**的地方。\n\n` +
    `工程角色（只读查证，本次不做任何修改）：\n${roles.length ? roles.join('\n') : '（未配置工程目录）'}\n\n` +
    `需求文档全文：\n「${reqDocText}」\n\n` +
    primeSec +
    `找的是这几类歧义：\n` +
    `1. 范围没界定（「支持批量导出」——导选中的还是全部？）\n` +
    `2. 与已有逻辑的组合关系没写（新筛选项和老筛选项是 AND 还是 OR？）\n` +
    `3. 连带影响没交代（入口删了，权限点/埋点要不要一起回收？）\n` +
    `4. 容器/交互形态没定（「弹出确认」——模态框、抽屉还是新页面？）\n` +
    `5. 代码里发现的、文档没提的依赖（某模板复用了要改的组件）\n\n` +
    `不要问「你希望怎么做」这种开放题，也不要问文档里已经写清楚的东西。\n\n` +
    `输出契约（严格遵守）：只输出一个 JSON 数组，不要代码围栏，不要任何解释性文字。结构必须是——\n` +
    `[{\n` +
    `  "id": "Q1",\n` +
    `  "title": "问题本身，一句话",\n` +
    `  "hint": "为什么这里有歧义，一句话",\n` +
    `  "why": "来源：需求文档 3.2 · 描述缺失  或  来源：代码扫描 · List.vue:210",\n` +
    `  "opts": [\n` +
    `    { "v": "短标识", "lab": "选项文案", "desc": "选它意味着什么", "guess": true },\n` +
    `    { "v": "短标识", "lab": "选项文案", "desc": "选它意味着什么" }\n` +
    `  ]\n` +
    `}]\n\n` +
    `硬性要求：\n` +
    `- 出 ${QUIZ_MIN}-${QUIZ_MAX} 题，每题 ${OPT_MIN}-${OPT_MAX} 个选项。\n` +
    `- **每题必须恰好有一个选项带 "guess": true**，即「你不问的话就会这么实现」的那个默认答案。\n` +
    `- desc 要写清代价（如「跨页导出，需要后端分页保护」），别写废话。`
  );
}

/** 单个选项规范化；缺 lab 视为无效（界面上是张白卡片）。 */
function normalizeOpt(o, i) {
  const lab = String(o?.lab ?? '').trim();
  if (!lab) return null;
  return {
    v: String(o?.v ?? '').trim() || `o${i + 1}`,
    lab,
    desc: String(o?.desc ?? '').trim(),
    guess: !!o?.guess,
  };
}

/**
 * LLM 输出 → 问卷题目数组。
 * 单题不合格就丢单题（模型偶尔漏个字段，不该让整份问卷作废）；
 * 有效题数低于 QUIZ_MIN 才整体抛错——那说明这次是真没找出东西，走降级路径直接 docgen。
 */
export function parseQuiz(text) {
  const raw = parseJsonLoose(text);
  if (!Array.isArray(raw)) throw new Error('问卷输出不是 JSON 数组');

  const usedIds = new Set();
  const questions = [];
  raw.forEach((q, i) => {
    const title = String(q?.title ?? '').trim();
    if (!title) return;
    const opts = (Array.isArray(q?.opts) ? q.opts : [])
      .map(normalizeOpt)
      .filter(Boolean)
      .slice(0, OPT_MAX);
    if (opts.length < OPT_MIN) return;

    // guess 唯一化：缺了补首项（否则「跳过」就没有落点），多了只留第一个
    const firstGuess = opts.findIndex((o) => o.guess);
    const keep = firstGuess >= 0 ? firstGuess : 0;
    opts.forEach((o, oi) => {
      o.guess = oi === keep;
    });

    let id = String(q?.id ?? '').trim() || `Q${i + 1}`;
    let n = 2;
    while (usedIds.has(id)) id = `Q${i + 1}-${n++}`;
    usedIds.add(id);

    questions.push({ id, title, hint: String(q?.hint ?? '').trim(), why: String(q?.why ?? '').trim(), opts });
  });

  if (questions.length < QUIZ_MIN) {
    throw new Error(`有效题数不足（${questions.length}/${QUIZ_MIN}），本次不出问卷`);
  }
  return questions.slice(0, QUIZ_MAX);
}

/**
 * 问卷答案 → docgen prompt 追加节。三种落点措辞不同，因为它们给模型的授权强度不同：
 *
 * - 选了实质项       → 用户确认过的口径，冲突时以此为准
 * - 选了「不确定」     → 用户看过题目后明确说不知道，按猜测走但他知情
 * - 未作答           → 模型自己的默认值，用户根本没看见
 *
 * 「未作答」分支必须保留：必答规则只约束新提交，已落盘的 answered 问卷仍可能缺题。
 */
export function answersToPromptPart(quiz) {
  const questions = quiz?.questions || [];
  if (!questions.length) return '';
  const answers = quiz?.answers || {};

  const lines = questions.map((q, i) => {
    const a = answers[q.id];
    const picked = a?.v && a.v !== UNSURE_VALUE ? q.opts.find((o) => o.v === a.v) : null;
    const chosen = picked || q.opts.find((o) => o.guess) || q.opts[0];
    const unsure = a?.v === UNSURE_VALUE;
    let mark = '';
    if (unsure) mark = '（用户明确表示不确定，按默认猜测执行）';
    else if (!picked) mark = '（用户未作答，按 AI 默认猜测执行）';
    const note = String(a?.note ?? '').trim();
    return (
      `${i + 1}. ${q.title}\n` +
      `   → ${chosen.lab}${mark}` +
      (note ? `\n   用户补充：${note}` : '')
    );
  });

  return `\n用户对不确定点的答复（优先级高于需求文档原文，冲突时以此为准）：\n${lines.join('\n')}\n`;
}

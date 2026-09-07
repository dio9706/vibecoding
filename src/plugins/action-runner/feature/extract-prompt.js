/**
 * LLM 抽取提示词的自动生成 —— **零 IO 纯函数**。
 *
 * 取代旧 slot-filler.js 里写死的 `hasEnv = variables.some(v => v.name === 'env')` 分支：
 * 那段逻辑只有当变量恰好叫 `env` 时才把候选值与归一要求写进提示词，别的变量一律只得到
 * 一句干巴巴的 `name=label`。模型不知道合法值是什么，抽出的自然是中文原值
 *（action-log.jsonl 有实证 `{"env":"正式版"}`），而脚本 argparse choices 只认规范值。
 *
 * 现在约束段由变量声明生成，与变量名无关。
 */

/** 提示词里每个变量最多列几条别名映射（防上百条别名把提示词撑爆） */
const MAX_ALIAS_HINTS = 12;

/**
 * 为一组**待抽取**变量生成提示词。
 *
 * 关键：只列 `unresolved` —— 本地已抽好的字段不出现在提示词里。既省 token，
 * 也避免模型把已经确定的值改写掉。
 *
 * @param {Array<object>} unresolved resolveVariable 的产物数组
 * @param {string} text 用户消息
 * @returns {string}
 */
export function buildExtractPrompt(unresolved, text) {
  const lines = (unresolved || []).map((rv) => describeVariable(rv));
  return (
    '从用户消息提取变量，仅输出一行 JSON。\n\n' +
    lines.join('\n') +
    '\n\n' +
    // 「不要猜」是硬要求：猜错的代价是清错环境 / 退错款（不可逆），漏抽只是多问一句。
    '用户没提到、或说的是列表外的值时，**省略该字段，不要猜**。\n' +
    `用户消息：「${String(text ?? '')}」\n` +
    '输出：{"变量名":"值"}，找不到的字段省略。'
  );
}

/** 单个变量的约束段 */
function describeVariable(rv) {
  const head = `- ${rv.name}（${rv.label || rv.name}）：`;

  if (rv.kind === 'enum') {
    const parts = [`只能取 ${rv.enum.join(' / ')} 之一。`];
    const hints = aliasHints(rv);
    if (hints) parts.push(`\n  用户说法需归一：${hints}`);
    if (rv.example) parts.push(`\n  示例：${rv.example}`);
    return head + parts.join('');
  }

  if (rv.kind === 'pattern') {
    const parts = [`需匹配格式 /${rv.pattern}/。`];
    if (rv.example) parts.push(`\n  示例：${rv.example}`);
    return head + parts.join('');
  }

  return head + '自由文本，原样提取。' + (rv.example ? `\n  示例：${rv.example}` : '');
}

/**
 * 把 aliases 按规范值分组，拼成「上海·沪 → sh；北京 → bj」。
 * 分组而不是逐条列，是为了让模型看清「多个说法指向同一个值」这层结构。
 * weakAliases 也一并列出 —— 提示词场景下模型有整句上下文，不存在裸词歧义问题。
 */
function aliasHints(rv) {
  const byTarget = new Map();
  for (const [alias, target] of [...Object.entries(rv.aliases), ...Object.entries(rv.weakAliases)]) {
    const key = String(target);
    // 别名与规范值同名时不必列（`dev → dev` 是噪音）
    if (alias === key) continue;
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push(alias);
  }
  if (!byTarget.size) return '';

  let budget = MAX_ALIAS_HINTS;
  const groups = [];
  for (const [target, aliases] of byTarget) {
    if (budget <= 0) break;
    const take = aliases.slice(0, Math.max(1, Math.min(aliases.length, budget)));
    budget -= take.length;
    groups.push(`${take.join('·')} → ${target}`);
  }
  return groups.join('；');
}

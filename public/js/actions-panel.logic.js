/**
 * 动作配置面板的纯逻辑（零 DOM，可单测）。
 *
 * 为什么单独成文件：`actions-panel.js` 顶层就有 `$('#addActionBtn')?.addEventListener(...)`
 * 这类 DOM 副作用，在 node:test 里 import 会直接炸。项目里 `*.logic.js` 的既有约定
 *（optimize-view.logic.js / optimize-fix.logic.js 等）正是为此。
 */

/**
 * `别名=值` 多行文本 → 对象。
 *
 * 空行、缺 `=` 的行、键或值为空的行一律跳过 —— 用户在文本框里留空行是常态，
 * 不该因此产出 `{'': ''}` 这种会被后端校验拒掉的脏数据。
 * 用 `indexOf('=')` 而非 `split('=')`：值里可能含 `=`（如某些 token 形态的枚举值）。
 *
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseAliasLines(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

/** 对象 → `别名=值` 多行文本（编辑回显用，与 parseAliasLines 互为逆） */
export function formatAliasLines(obj) {
  return Object.entries(obj || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/**
 * 把表单读到的原始字段拼成变量声明。
 *
 * **空字段一律省略**，绝不写成 `aliases: {}` —— preset 的合并语义是浅覆盖
 *（见 var-contract.js），传空对象会把预置的别名整体覆盖掉。用户只是没填，
 * 却导致预置静默失效，是最难排查的那类问题。
 *
 * **例外：`raw.expanded` 为真时反过来**。用户点过「展开预置为可编辑」，各框里已经是
 * 预置的实体内容，此后他清空某个框就是明确的「我要删掉它」，必须如实下发空值，
 * 否则浅覆盖会让预置内容原样补回来 —— 用户会发现这个字段怎么都删不掉。
 *
 * 展开后**仍保留 `preset` 字段**（不清空下拉）：`junk`（「正式版二维码」→「正式版」
 * 这类尾巴词剥离）刻意不在 UI 里、只能来自 preset（见 var-contract.js 的 CONTRACT_KEYS）。
 * 清掉预置会静默丢掉它。保留 preset + 显式下发全部 UI 字段，两者兼得。
 *
 * @param {object} raw 表单原始值（字符串/布尔；`expanded` 标记是否已展开预置）
 * @returns {object} 变量声明
 */
export function buildVarDecl(raw) {
  const decl = {
    name: raw.name || '',
    label: raw.label || '',
    prompt: raw.prompt || '',
    required: !!raw.required,
    persistent: !!raw.persistent,
  };
  if (raw.preset) decl.preset = raw.preset;

  // 展开过预置：各框即真相，空也要如实下发。否则「删掉一条别名」永远删不掉。
  const expanded = !!raw.expanded;

  const list = (raw.enumText || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // 展开后清空要下发 `null` 而不是 `[]`：后者会撞上「合法值必须是非空数组」的保存校验
  //（用户展开一个 phone 预置再保存就会被拒），而 null 正好表达「这个变量没有 enum」——
  // resolveVariable 的浅覆盖会用它盖掉预置的 enum，validateVariable 则跳过 enum 分支。
  if (list.length) decl.enum = list;
  else if (expanded) decl.enum = null;

  const aliases = parseAliasLines(raw.aliasesText);
  if (Object.keys(aliases).length || expanded) decl.aliases = aliases;

  const weak = parseAliasLines(raw.weakAliasesText);
  if (Object.keys(weak).length || expanded) decl.weakAliases = weak;

  const pattern = (raw.pattern || '').trim();
  if (pattern || expanded) decl.pattern = pattern;

  const example = (raw.example || '').trim();
  if (example || expanded) decl.example = example;

  return decl;
}

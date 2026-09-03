/**
 * 条目 → Markdown。纯函数。
 * 预算截断是刚性要求：注入内容每次对话都要烧 token，攒半年会失控。
 * 被截断的条目数必须如实返回，由面板显式提示 —— 静默丢弃会让用户以为规则生效了，
 * 实际没有，这是最难排查的一类问题。
 */

export const FINDING_TYPE_LABEL = {
  bug: '易错点',
  solution: '解决方案',
  pattern: '规律',
  preference: '偏好',
};

export const CATEGORY_LABEL = {
  'code-style': '代码风格',
  collaboration: '协作习惯',
  writing: '写作习惯',
  dialogue: '对话风格',
  'tech-pref': '技术偏好',
};

/** 分节顺序：与 CATEGORY_LABEL 无关，显式固定，保证渲染结果稳定可 diff */
const SECTION_ORDER = ['code-style', 'collaboration', 'writing', 'dialogue', 'tech-pref'];

/** 已知分类集合：renderMarkdown 按 SECTION_ORDER 分节，不在此集合里的 category 无处落地，
 * 必须在 selectForInjection 就挡掉，否则会在渲染阶段被无声丢弃且不计入 truncated */
const KNOWN_CATEGORIES = new Set(Object.keys(CATEGORY_LABEL));

const HEADER = '<!-- 由记忆库自动生成，勿手工编辑；改动请在执行台「记忆库」面板操作 -->';

const DAY_MS = 86400000;

/**
 * 把 v2 memory 对象归一化为 selectForInjection 能处理的 v1 格式。
 * v2 memories（来自 synthesize.js）缺少 status / inject / scope / evidenceCount / lastSeenAt / projectDir，
 * 归一化后才能正常通过过滤逻辑，无需改动核心排序/截断流程。
 */
function normalizeMem(mem) {
  return {
    status: 'active',
    inject: true,
    scope: 'global',
    category: mem.category,
    statement: mem.statement,
    evidenceCount: 1,
    lastSeenAt: mem.createdAt || 0,
    source: 'inferred',
    projectDir: '',
  };
}

/**
 * 排序权重：运行时计算、不落盘（少一个要维护一致性的持久化字段）。
 * 证据越多越重；最后一次出现越近越重（半衰期 60 天）。
 */
export function weight(item, now) {
  const ageDays = Math.max(0, (now - (item.lastSeenAt || 0)) / DAY_MS);
  const recency = 1 / (1 + ageDays / 60);
  return (item.evidenceCount || 0) * recency;
}

/** 按 scope 过滤 + 排序 + 预算截断，返回入选条目 */
export function selectForInjection(items, { scope, projectDir = '', now, maxItems = 40, maxChars = 3000 }) {
  // 入口处归一化：v2 memories 缺少 v1 字段（status/inject/scope），归一后才能正常过滤
  const normalizedItems = (items || []).map(it =>
    it.status === undefined ? normalizeMem(it) : it
  );
  // 未知 category 的条目在渲染阶段无处落地（renderMarkdown 按 SECTION_ORDER 分节），
  // 必须在这里就诚实地计入 truncated，否则会被无声丢弃：面板报 0 条未注入，规则却哪儿都不在。
  // 只统计「本该有资格注入、但因 category 未知被挡掉」的条目，dormant/inject=false 等本就不合格的不算。
  let categoryRejected = 0;
  const pool = normalizedItems.filter((it) => {
    if (it.status !== 'active' || !it.inject) return false;
    if (scope === 'project') {
      if (!(it.scope === 'project' && it.projectDir === projectDir)) return false;
    } else if (it.scope !== 'global') {
      return false;
    }
    if (!KNOWN_CATEGORIES.has(it.category)) {
      categoryRejected += 1;
      return false;
    }
    return true;
  });

  // explicit 永远压过 inferred：用户明说的规矩不该被推断出来的挤掉
  pool.sort((a, b) => {
    const ea = a.source === 'explicit' ? 0 : 1;
    const eb = b.source === 'explicit' ? 0 : 1;
    if (ea !== eb) return ea - eb;
    return weight(b, now) - weight(a, now);
  });

  const included = [];
  let chars = 0;
  for (const it of pool) {
    if (included.length >= maxItems) break;
    const cost = String(it.statement || '').length + 3; // '- ' + 换行；与 weight() 的 || 0 兜底姿态保持一致
    if (chars + cost > maxChars) break;
    included.push(it);
    chars += cost;
  }
  return { included, truncated: pool.length - included.length + categoryRejected };
}

/**
 * @returns {{text:string, included:Array, truncated:number}} text 为空串表示该 scope 已无可注入条目 ——
 *   调用方必须把对应的 memory-bank.md 写成空文件，而不是跳过写盘。
 *   跳过会让磁盘上的旧内容继续被 CLAUDE.md 引用，用户否掉的规则将永久生效。
 */
export function renderMarkdown(items, opts) {
  // 入口处归一化：v2 memories 缺少 v1 字段（status/inject/scope），归一后传给 selectForInjection
  const normalized = (items || []).map(it =>
    it.status === undefined ? normalizeMem(it) : it
  );
  const { included, truncated } = selectForInjection(normalized, opts);
  if (included.length === 0) return { text: '', included: [], truncated };

  const lines = [HEADER, ''];
  for (const cat of SECTION_ORDER) {
    const group = included.filter((it) => it.category === cat);
    if (group.length === 0) continue;
    lines.push(`## ${CATEGORY_LABEL[cat] || cat}`);
    for (const it of group) lines.push(`- ${it.statement}`);
    lines.push('');
  }
  return { text: lines.join('\n').trimEnd() + '\n', included, truncated };
}

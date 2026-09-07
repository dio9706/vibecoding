/**
 * advisory 策略的渲染层（纯函数）：把 issue 清单渲染成可直接执行的 Markdown 整改清单。
 *
 * ## 为什么「只出清单」也是一种修复策略
 *
 * 有三类问题机器不该动手，但**不动手不等于不产出**：
 *
 *   - `security`：自动改写一处注入点而改错，会把「已知有洞」变成「以为修好了」，后者更危险；
 *   - `structure` / `naming`：修法涉及跨文件的设计决策（接口该归谁、名字该叫什么），
 *     而调用点里可能有字符串引用（路由表、插件清单），静态改写会漏；
 *   - 任何被测试闸挡下的源码维度：没有安全网时不该改源码。
 *
 * 对这三类，本策略的产出物是「一份带定位、带依据、带完成判据的清单」——
 * 它比一个分数有用得多，也是用户能拿去派活的东西。
 *
 * ## 降级说明必须写在第一行
 *
 * 源码维度被测试闸挡下时，用户在 UI 上看到的是「优化完成」。如果清单里不写明
 * 「本维度未做任何源码改动」，他会合理地以为代码已经改过了——这是本功能最容易
 * 造成误解的一处，所以这句话的位置是硬性的（首屏可见，不放在文末）。
 */

/** 严重度 → 展示用的中文标签与排序权重 */
const SEVERITY = {
  error: { label: '必须处理', order: 0 },
  warn: { label: '建议处理', order: 1 },
  info: { label: '可以处理', order: 2 },
};

function severityOf(s) {
  return SEVERITY[s] || { label: '待确认', order: 3 };
}

/** 按严重度分组并保持组内的原有顺序（召回顺序即文件顺序，便于逐个文件处理） */
function groupBySeverity(issues) {
  const groups = new Map();
  for (const it of issues) {
    const key = it.severity || 'info';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return [...groups.entries()].sort((a, b) => severityOf(a[0]).order - severityOf(b[0]).order);
}

/**
 * 渲染一个维度的整改清单。
 *
 * @param {object} args
 * @param {object} args.dim 维度声明（要 label / id / source）
 * @param {Array} args.issues
 * @param {string} [args.degradeReason] 非空表示这一维本来能自动修、但被降级了
 * @param {string} args.at ISO 时间戳
 * @returns {string} Markdown 正文
 */
/** 策略 → 给用户看的「这类改动是什么」。措辞要让人能判断该不该授权 */
const STRATEGY_DESC = {
  'llm-rewrite': '改写既有文档（CLAUDE.md / README）',
  'llm-refactor': '重构既有源码',
  deterministic: '机械修复（改 .gitignore、删重复条目）',
  'llm-create': '新建测试文件',
};

export function renderAdvisory({ dim, issues = [], degradeReason = '', riskSkipped = [], at }) {
  const lines = [`# ${dim.label} · 整改清单`, ''];

  if (riskSkipped.length) {
    // 必须写出来：用户点了「低风险优化」、看到清单里躺着源码问题，
    // 如果不说明「本轮没被授权」，他会以为这个工具没能力修
    const what = riskSkipped
      .map((r) => `${STRATEGY_DESC[r.strategy] || r.strategy}（${r.risk === 'high' ? '高风险' : '中风险'}）`)
      .join('、');
    lines.push(
      '> ℹ️ **本轮只执行了低风险改动。**',
      `> 这一维还有需要「${what}」才能处理的问题，点界面上的「中高风险优化」按钮才会执行。`,
      '',
    );
  }

  if (degradeReason) {
    // 首屏可见的显式否认。措辞用「未做任何改动」而不是「已降级」——
    // 后者是内部术语，用户不一定知道它意味着代码没被碰过
    lines.push(
      '> ⚠️ **本维度未对代码做任何改动。**',
      `> ${degradeReason}`,
      '',
    );
  }

  lines.push(
    `- 判据出处：${dim.source}`,
    `- 生成时间：${at}`,
    `- 共 ${issues.length} 项`,
    '',
  );

  if (!issues.length) {
    lines.push('本维度没有发现需要处理的问题。', '');
    return lines.join('\n');
  }

  for (const [severity, list] of groupBySeverity(issues)) {
    lines.push(`## ${severityOf(severity).label}（${list.length} 项）`, '');
    for (const [i, it] of list.entries()) {
      lines.push(`### ${i + 1}. \`${it.file}:${it.line}\``, '');
      if (it.message) lines.push(it.message, '');
      if (it.fixHint) lines.push(`**建议改法**：${it.fixHint}`, '');
      // 判定档位要露出来：用户据此知道这条是「模型很确定」还是「模型觉得可以更好」
      if (it.meta?.verdict) lines.push(`<sub>判定：\`${it.meta.verdict}\`｜规则：\`${it.code}\`</sub>`, '');
      else if (it.code) lines.push(`<sub>规则：\`${it.code}\`</sub>`, '');
    }
  }

  return lines.join('\n');
}

/** 优先级 → 中文标签。与 check-holistic.logic.js 的词表对齐 */
const PRIORITY_LABEL = { now: '现在就做', next: '接下来做', later: '以后再说' };

/**
 * 渲染整体行动计划（holistic 维度的产出物）。
 *
 * 这是整个功能的收口产物：一份带优先级、有出处、可直接执行的计划。
 * 与逐维度清单的区别在于它**跨维度排序**——用户拿到的是「先做哪件」，
 * 而不是十几份各自说自己最重要的清单。
 */
export function renderPlan({ plan, at, dimSummaries = [] }) {
  const lines = ['# 项目优化行动计划', '', `- 生成时间：${at}`, ''];

  if (plan.score !== null && plan.score !== undefined) {
    lines.push(`- 整体健康分：**${plan.score}**`, '');
  }
  // 业务理解置顶：它决定了后面每条建议是否可信。读者先要认同「这个工具读懂了我的项目」
  if (plan.businessRead) lines.push('## 这个项目是做什么的', '', plan.businessRead, '');
  if (plan.verdict) lines.push('## 总体判断', '', plan.verdict, '');

  if (plan.businessRisks?.length) {
    // 与 topActions 分开：这些是「你得知道」而不是「你得做」，
    // 混进待办清单会让人以为逐条做完就没事了
    lines.push('## 业务特有风险（通用扫描看不见的）', '');
    for (const r of plan.businessRisks) {
      lines.push(`- ${r.what}`);
      if (r.evidence) lines.push(`  依据：\`${r.evidence}\``);
    }
    lines.push('');
  }

  lines.push('## 最该先做的事', '');
  for (const [i, a] of plan.topActions.entries()) {
    lines.push(`### ${i + 1}. ${a.title}`, '', `- **优先级**：${PRIORITY_LABEL[a.priority] || a.priority}`);
    if (a.why) lines.push(`- **为什么是现在**：${a.why}`);
    if (a.files?.length) lines.push(`- **预计涉及**：${a.files.map((f) => `\`${f}\``).join('、')}`);
    // 完成判据是这份计划区别于「一堆建议」的关键：没有它，用户做完也不知道算不算做完
    if (a.done) lines.push(`- **完成判据**：${a.done}`);
    lines.push('');
  }

  if (plan.contradictions?.length) {
    lines.push('## 跨维度矛盾', '', '以下建议互相冲突，需要你拍板：', '');
    for (const c of plan.contradictions) {
      lines.push(`- **冲突**：${c.what}`);
      if (c.resolution) lines.push(`  **建议取舍**：${c.resolution}`);
    }
    lines.push('');
  }

  if (plan.strengths?.length) {
    // 只报问题会让用户失去判断基准，也不知道哪些现有约定不该被后续改动破坏
    lines.push('## 做得好、应当保持的地方', '');
    for (const s of plan.strengths) lines.push(`- ${s}`);
    lines.push('');
  }

  if (dimSummaries.length) {
    lines.push('## 各维度得分', '', '| 维度 | 分数 | 问题数 | 判据出处 |', '|---|---|---|---|');
    for (const d of dimSummaries) {
      lines.push(`| ${d.label} | ${d.score ?? '--'} | ${d.issueCount} | ${d.source} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 项目优化面板的纯逻辑层：不碰 DOM，可在 node 下单测。
 */

export const DIM_META = [
  { key: 'map', label: '项目地图', hint: '地图是否建立、是否过期、引用是否失效' },
  { key: 'prompts', label: '提示词质量', hint: '规则是否过度宽泛、是否互相冲突' },
  { key: 'rules', label: '规范加载方式', hint: '大块规范是否该从 rules 降级为 skill' },
  { key: 'deadcode', label: '无用代码', hint: '即将支持' },
  { key: 'comments', label: '注释合理性', hint: '注释是否解释「为什么」、是否已过期' },
];

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

export function severityRank(s) {
  const r = SEVERITY_ORDER[s];
  return r === undefined ? 99 : r;
}

export function sortIssues(issues) {
  return [...(issues || [])].sort((a, b) => {
    const d = severityRank(a.severity) - severityRank(b.severity);
    if (d !== 0) return d;
    const f = String(a.file || '').localeCompare(String(b.file || ''));
    if (f !== 0) return f;
    return (a.line || 0) - (b.line || 0);
  });
}

/**
 * 把报告摊平成 UI 需要的维度列表。
 *
 * selectable 的含义是「这个维度能不能参与一键优化」——只有跑出**完整**结果的才行。
 * partial 有分数但结论不完整（LLM 只判了一部分/没判成），拿它去驱动自动修改会漏改错改，
 * 所以照样不可勾选，只把分数亮出来并标注原因。
 *
 * busy 专给 analyzing：LLM 维度是异步回填的，卡片要先转圈占位，等 SSE 送来结果再变成分数。
 */
export function dimListFrom(report) {
  return DIM_META.map((meta) => {
    const d = report?.dims?.[meta.key];
    const status = d?.status || 'idle';
    const hasScore = typeof d?.score === 'number';
    return {
      ...meta,
      status,
      score: hasScore ? d.score : null,
      scoreText: hasScore ? String(d.score) : '--',
      issueCount: d?.issues?.length || 0,
      issues: sortIssues(d?.issues),
      reason: d?.reason || '',
      busy: status === 'analyzing',
      note: status === 'partial' ? '未深度分析，分数仅供参考且不计入总分' : '',
      selectable: status === 'done',
    };
  });
}

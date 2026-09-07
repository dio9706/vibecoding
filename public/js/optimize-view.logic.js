/**
 * 项目优化面板的纯逻辑层：不碰 DOM，可在 node 下单测。
 */

/**
 * 维度分组。渲染时按这个顺序插组标题——17 个维度平铺是一面墙，
 * 分域之后用户能先定位「哪个方面有问题」，再往下看具体条目。
 */
export const CATEGORY_META = [
  { key: 'holistic', label: '整体评估' },
  { key: 'ai', label: 'AI 协作配置' },
  { key: 'architecture', label: '架构' },
  { key: 'robustness', label: '健壮性' },
  { key: 'quality', label: '代码质量' },
  { key: 'engineering', label: '工程化' },
];

/**
 * 维度元信息 —— **面板渲染的唯一来源**（dimListFrom 基于它 map，不遍历 report.dims）。
 * 后端新增维度若不在这里登记，即使有数据也完全不显示。
 *
 * ## 这张表是后端注册表的镜像，靠测试钉住一致性
 *
 * 权威声明在 `src/features/project-checkup/dimensions/registry.js`。前端不能直接 import 它
 * （那是 node 端模块，浏览器加载不了，而且会把整条召回器依赖链拖进浏览器）。
 * 所以这里手抄一份，并在 `optimize-view.logic.test.js` 里做交叉校验——
 * 后端加了维度而这里忘了加，会变成一条测试失败而不是一个「算出来但不显示」的静默 bug。
 *
 * `holistic` 排在最前：它就是「先看哪儿」的答案，放末尾没人会滚到那里。
 */
export const DIM_META = [
  { key: 'holistic', category: 'holistic', label: '整体智能评估', hint: '读全部维度结论，给出该先做的几件事' },

  { key: 'map', category: 'ai', label: '项目地图', hint: '地图是否建立、是否过期、引用是否失效' },
  { key: 'prompts', category: 'ai', label: '提示词质量', hint: '规则是否过度宽泛、是否互相冲突、是否重复' },
  { key: 'rules', category: 'ai', label: '规范加载方式', hint: '大块规范是否该从 rules 降级为 skill' },

  { key: 'structure', category: 'architecture', label: '分层与依赖方向', hint: '反向依赖、循环依赖、跨层直连' },

  { key: 'tests', category: 'robustness', label: '测试健康度', hint: '测试是否全绿、大文件是否缺测试' },
  { key: 'errors', category: 'robustness', label: '错误处理与稳定性', hint: '静默吞异常、只打日志、缺诊断信息' },
  { key: 'security', category: 'robustness', label: '敏感信息与危险用法', hint: '硬编码凭证、注入面、弱加密、明文传输' },

  { key: 'complexity', category: 'quality', label: '复杂度与函数规模', hint: '长函数、深嵌套、参数过多、巨型文件' },
  { key: 'duplication', category: 'quality', label: '重复实现', hint: '同一条知识在多处各写一遍（DRY 违背）' },
  { key: 'comments', category: 'quality', label: '注释合理性', hint: '注释是否解释「为什么」、是否已过期' },
  { key: 'naming', category: 'quality', label: '命名与意图表达', hint: '导出符号的名字是否说明了它做什么' },
  { key: 'deadcode', category: 'quality', label: '死代码与未使用导出', hint: '零引用的导出、被注释掉的代码块' },

  { key: 'hygiene', category: 'engineering', label: '仓库卫生', hint: '运行数据、临时脚本是否误入版本库' },
  { key: 'deps', category: 'engineering', label: '依赖健康', hint: '未使用 / 缺失声明 / 功能重复的依赖' },
  { key: 'config', category: 'engineering', label: '配置与环境收口', hint: '硬编码地址 / 路径 / 端口，env 是否收口' },
  { key: 'docs', category: 'engineering', label: '文档可上手性', hint: 'README 的上手命令能否真的跑通' },
];

/**
 * 多久没体检算「长时间未体检」。
 *
 * 取 30 天而不是更短：体检是低频操作（跑一次十几分钟、要花额度），
 * 一两周没跑很正常，催得太勤会让这个提示变成常驻噪声而被忽略。
 * 而超过一个月，报告里的结论大概率已经指向被改动过甚至移走的文件——
 * 那时它不只是「旧」，是会误导人。
 */
export const STALE_CHECKUP_DAYS = 30;

/**
 * 报告的新鲜度。
 *
 * 只返回判定结果、**不返回格式化后的文案**：时间格式化要走 `toLocaleString`，
 * 它的输出随运行环境的 locale 变化，放进纯逻辑层会让单测依赖环境。
 *
 * @param {string} at ISO 时间戳
 * @param {number} [now]
 * @returns {{days:number|null, stale:boolean}} at 不可解析时 days 为 null、stale 为 false
 *   （拿不到时间就不该指责用户没体检）
 */
export function checkupAge(at, now = Date.now()) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return { days: null, stale: false };
  const days = Math.floor((now - t) / 86_400_000);
  return { days, stale: days >= STALE_CHECKUP_DAYS };
}

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
 * busy 专给 analyzing：异步维度是回填的，卡片要先转圈占位，等 SSE 送来结果再变成分数。
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
      // 只有 holistic 有：行动计划，卡片里要单独渲染成一块
      plan: d?.plan || null,
      busy: status === 'analyzing',
      note: status === 'partial' ? '未深度分析，分数仅供参考且不计入总分' : '',
      selectable: status === 'done',
    };
  });
}

/**
 * 按域把维度列表切成分组，供分组渲染。
 *
 * 空组会被丢掉：一个没有任何维度出结果的域，标题挂在那里只是噪声。
 */
export function groupDims(list) {
  return CATEGORY_META
    .map((cat) => ({ ...cat, dims: list.filter((d) => d.category === cat.key) }))
    .filter((g) => g.dims.length);
}

/**
 * 一个组的汇总标签：「3/5 已出结果 · 平均 72」。
 *
 * 有它才能在组折叠起来时仍看出这个域好不好——不然折叠就等于隐藏信息。
 */
export function groupSummary(dims) {
  const scored = dims.filter((d) => typeof d.score === 'number');
  const issues = dims.reduce((n, d) => n + d.issueCount, 0);
  if (!scored.length) return `${dims.length} 项待分析`;
  const avg = Math.round(scored.reduce((s, d) => s + d.score, 0) / scored.length);
  return `${scored.length}/${dims.length} 已出结果 · 均分 ${avg} · ${issues} 个问题`;
}

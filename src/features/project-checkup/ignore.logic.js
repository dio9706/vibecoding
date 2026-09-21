/**
 * 体检豁免的纯函数层：匹配、过滤、码表、文案、md 渲染。零 IO，可直测。
 *
 * 豁免键是 `(dim, code, file)` 三元组。为什么是这三样、为什么不含行号、
 * 为什么不细到代码单元，见 spec `docs/superpowers/specs/2026-09-18-checkup-phase2-design.md` §1.1。
 */

/**
 * 路径归一。
 *
 * **只归一分隔符，不归一大小写**：比较两侧的 file 都来自同一次体检的产出
 * （git ls-files / fs 遍历），大小写本就一致；而强行小写会在大小写敏感的文件系统上
 * 把 `src/Api/x.js` 和 `src/api/x.js` 误判成同一个文件，一条豁免会吃掉两个文件的问题。
 * 分隔符仍要归一——md 可被手工编辑，不同来源可能混入反斜杠。
 */
export function normalizeFile(file) {
  return String(file || '').trim().replace(/\\/g, '/');
}

/** 一条 issue 是否命中某条豁免记录 */
export function matchesIgnore(dimId, issue, rule) {
  return rule?.dim === dimId
    && rule?.code === issue?.code
    && normalizeFile(rule?.file) === normalizeFile(issue?.file);
}

/**
 * 过滤掉被豁免的 issue。
 *
 * @returns {{kept: Array, ignoredCount: number}} 零豁免时 `kept` 就是传入的同一个数组引用
 *   —— 这是最常见的路径（绝大多数项目没有任何豁免），不该为它产生垃圾
 */
export function filterIgnoredIssues(dimId, issues, ignores) {
  const list = Array.isArray(issues) ? issues : [];
  const rules = (Array.isArray(ignores) ? ignores : []).filter((r) => r?.dim === dimId);
  if (!rules.length || !list.length) return { kept: list, ignoredCount: 0 };

  const kept = list.filter((it) => !rules.some((r) => matchesIgnore(dimId, it, r)));
  return { kept, ignoredCount: list.length - kept.length };
}

/**
 * 某维度某文件上已被豁免的 code 集合。
 *
 * 给召回阶段排除用：召回时还不知道 verdict code（code 是判定的产物），
 * 所以只能反过来问「这个文件上哪些 code 已经被免了」，再由调用方判断是否覆盖了全部有权重的 code。
 */
export function ignoredCodesFor(dimId, file, ignores) {
  const f = normalizeFile(file);
  const out = new Set();
  for (const r of Array.isArray(ignores) ? ignores : []) {
    if (r?.dim === dimId && normalizeFile(r.file) === f) out.add(r.code);
  }
  return out;
}

/**
 * 往维度的 reason 上追加豁免说明。
 *
 * `scoreAdjusted` 必须如实区分：走召回排除的 audit 维度分数会跟着变，
 * 只走兜底过滤的维度分数不变。不说清楚，用户会看到「0 个问题却 72 分」而无从理解。
 */
export function appendIgnoreNote(reason, count, scoreAdjusted) {
  if (!count) return reason || '';
  const note = scoreAdjusted ? `已豁免 ${count} 条` : `已豁免 ${count} 条，本维度分数未重算`;
  return reason ? `${reason}（${note}）` : note;
}

/** 时间戳 → `YYYY-MM-DD HH:mm`；解析不出就原样返回（宁可难看也别丢信息） */
function fmtAt(at) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return String(at || '');
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 渲染 `.claude/optimize/IGNORED.md`。
 *
 * 每次写入/删除后**整份重渲染**，不做增量拼接：增量拼接必然漂移，
 * 而整份重渲染是一次纯计算加一次写盘，成本可以忽略。
 *
 * 顶部那句「手工修改会被覆盖」是必须的——不写的话用户会在里面补充内容然后丢失。
 *
 * @param {Array} items 豁免记录
 * @param {Array<{id:string,label:string}>} dims 维度声明（只取 id 与 label）
 */
export function renderIgnoredMd(items, dims) {
  const label = new Map((dims || []).map((d) => [d.id, d.label || d.id]));
  const lines = [
    '# 体检豁免清单',
    '',
    '> 本文件由「项目优化 → 这不是问题」自动生成，**手工修改会在下次豁免操作时被覆盖**。',
    '> 真相源是应用数据目录下的 `checkup-ignores.json`；此处是给人和 AI 读的副本。',
    '> 下一次体检会跳过这里列出的问题。',
    '',
  ];

  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    lines.push('目前没有任何豁免记录。', '');
    return lines.join('\n');
  }

  // 按维度分组：同一个维度的豁免通常有共同的背景，凑在一起读才有上下文
  const byDim = new Map();
  for (const it of list) {
    if (!byDim.has(it.dim)) byDim.set(it.dim, []);
    byDim.get(it.dim).push(it);
  }

  for (const [dimId, group] of byDim) {
    lines.push(`## ${label.get(dimId) || dimId}（${dimId}）`, '');
    for (const it of group) {
      lines.push(`### ${normalizeFile(it.file)} · ${it.code}`);
      if (it.message) lines.push(`- **原始判定**：${it.message}`);
      lines.push(`- **豁免理由**：${it.note || '（未填写）'}`);
      lines.push(`- **登记时间**：${fmtAt(it.at)}`, '');
    }
  }

  return lines.join('\n');
}

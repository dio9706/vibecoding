/**
 * 项目优化面板：体检展示 + 一键优化。
 *
 * 安全约定：所有来自后端的文本一律 createElement + textContent 渲染，
 * 禁止 innerHTML 拼接（本项目硬性约定，因为渲染的是后端/LLM 产出的不可信文本）。
 */
import { $ } from './util.js';
import {
  dimListFrom, groupDims, groupSummary, checkupAge, STALE_CHECKUP_DAYS, shouldNormalizeStale,
} from './optimize-view.logic.js';
import { stepLabel, dirtyConfirmMessage, fixRowState, FIX_STATE_LABEL } from './optimize-fix.logic.js';
import {
  defaultSelection, nodeCheckState, toggleNode, topButtonsState, buttonVisibility,
  riskyPicks, RISK_LABEL,
} from './optimize-plan.logic.js';
import { setOptimizeBadge, probeOptimizeBadge } from './optimize-badge.js';
import { openFixReport } from './optimize-report.js';
import { confirmDialog, textareaDialog } from './ui.js';
import toast from './toast.js';

/**
 * 当前项目目录读取器，由 chat.js 经 `bindOptimizeCwd` 注入。
 *
 * cwd 归属 chat.js（一窗一项目），这里只读不写——与 `bindGitSelector` / `bindDirPopover`
 * 同一范式，避免 optimize-view 反向 import chat.js。
 */
let _getCwd = () => '';

/** 注入当前项目目录读取器（chat.js 在 import 后立即调用） */
export function bindOptimizeCwd({ getCwd }) {
  _getCwd = getCwd || (() => '');
}

let inited = false;
let currentReport = null;
/**
 * 本面板正在展示的项目目录。
 *
 * 恒等于打开面板那一刻的 `_getCwd()`——体检/优化只作用于当前项目，面板不再自带目录选择。
 * 仍保留这个模块级副本而不是处处现读：一次体检要跨 SSE 回填持续几分钟，
 * 期间顶栏目录若变了，正在跑的任务仍必须按发起时的目录收尾。
 */
let currentDir = '';
/** 正在接收 LLM 维度回填的 SSE 连接；同一时刻只允许一条 */
let checkupStream = null;
/**
 * 体检的忙碌态：`''` 空闲 / `'posting'` 请求在途 / `'analyzing'` LLM 维度经 SSE 回填中。
 *
 * 必须区分后两者：原来按钮只在 POST 期间禁用，而 POST 几百毫秒就返回了，
 * LLM 维度还要跑好几分钟。用户看到按钮恢复可点，就会以为体检结束了、或者以为卡住了再点一次——
 * 每点一次都是一整轮 LLM 额度（现在后端有串行闸会拒掉，但 UI 不该先把人引到那一步）。
 */
let checkupBusy = '';
/**
 * 已点过「中止体检」/「停止修复」，正在等后端收尾。
 *
 * 必须是状态而不是按钮上的临时文案：体检期间每落地一个维度就 render 一次，
 * 直接改 DOM 的话「中止中…」会被下一次 render 刷回可点的「中止体检」——
 * 用户看到按钮活过来，只会以为刚才那下没点上，然后再点一次。
 */
let cancelling = { checkup: false, fix: false };
/** 正在接收优化进度的 SSE 连接 */
let fixStream = null;
let fixRunning = false;
/**
 * 本轮提交给后端的计划项 id —— 这些 issue 行要显示进度。
 *
 * 为什么必须前端自己记：后端的进度事件里没有 planId，
 * 靠文件名反查会在「一个文件对应多条 issue」时全部命中，标错行。
 * 提交那一刻的 `picked` 才是准确的「正在修哪些」。
 */
let fixingIds = new Set();
/**
 * 当前正在跑的维度 id，取自 `step` 事件的 `dim`。
 *
 * 修复管线按 fixOrder **串行**跑维度，所以同一时刻只有一个。判定口径见
 * `optimize-fix.logic.js` 的 `fixRowState`。
 */
let fixActiveDim = '';
/** 本轮已开跑过的维度（含当前这个）。用来把「已经跑过去了」和「还没轮到」区分开 */
let fixSeenDims = new Set();
/** 文件 → 后端回报的 status，取自 `file` 事件。issue 行据此从「修复中」落到 ✓/✗ */
let fixDoneFiles = new Map();
/** 当前优化任务 id —— 「停止」要拿它去调 cancel 接口 */
let fixJobId = null;
/**
 * 当前修复计划（后端算的，前端只读不改）。
 *
 * `at` 是体检报告的时间戳：提交修复时要带上它做快照校验——计划项的 id 是
 * 「报告里的 issue 下标」，报告一变下标就会错位，修到不相干的文件上。
 *
 * `gate` 是后端对测试闸的**预判**（`previewGate`）：闸关着时，计划里 `degraded: true` 的
 * 那些项只会产出清单、一行代码都不改。这件事必须在用户**点修复之前**说清——
 * 实测一个项目 317 项里 165 项（52%）属于这一档，不说的话用户会以为它们都要被改。
 */
let plan = { at: '', items: [], gate: { known: false, allowed: true, reason: '' } };
/** 已勾选的计划项 id。存在 DOM 之外：render() 每次都重建整棵树 */
let selected = new Set();
/**
 * 本轮已处理的计划项 id。
 *
 * 只是**防重复勾**的 UI 标记，不参与任何重算：分数、等级、问题数、维度状态
 * 在修复后一律保持修复前的值，必须重新体检才更新（这是明确的产品拍板）。
 */
let handled = new Set();
/** 正在跑的体检 job id —— 「中止体检」要拿它去调 cancel 接口 */
let checkupJobId = null;
/**
 * 各维度的批级进度：`维度id -> {done, total}`。
 *
 * 为什么必须有：一个维度要**全部批次跑完**才落地成分数，而 deadcode 这类维度有 19 批、
 * 每批约 55 秒——卡片会转圈二十多分钟、界面零变化。实测已经因此被误判为「任务死了」。
 * 存在 DOM 之外的理由同 selected：render() 每次都重建全部卡片。
 */
let dimProgress = new Map();
/**
 * 用户手动展开的维度卡片 key。
 *
 * **必须显式持有，不能从 selected 之类的状态现推。** 这正是「勾选时莫名收起/展开」
 * 那个缺陷的根因：原实现每次 render 都按「这个维度有没有勾选项」重新决定折叠，
 * 而任何勾选都会触发 render —— 于是勾掉最后一条会连带收起、域级全选会连带展开。
 * 折叠是**用户意图**，只有用户点击才该改变它。
 */
let openCards = new Set();
/** 用户手动折叠的域 key。理由同 openCards */
let foldedGroups = new Set();

const GRADE_LABEL = {
  healthy: '健康',
  good: '良好',
  'needs-work': '需优化',
  poor: '较差',
};

/** 空计划。四处重置共用一份，免得漏掉 gate 字段让横幅读到 undefined */
function emptyPlan() {
  return { at: '', items: [], gate: { known: false, allowed: true, reason: '' } };
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/**
 * 上次体检时间 + 超期标记。
 *
 * 超过一个月就把时间标红并挂一个「长时间未体检」标签：那时报告里的结论大概率已经指向
 * 被改动过甚至移走的文件——它不只是旧，是会误导人（见 optimize-view.logic.js 的阈值说明）。
 */
function renderLastAt(host, at) {
  host.textContent = '';
  host.classList.remove('is-stale');
  if (!at) return;

  const { stale, days } = checkupAge(at);
  host.appendChild(el('span', null, `上次体检 ${new Date(at).toLocaleString()}`));
  if (!stale) return;

  host.classList.add('is-stale');
  const badge = el('span', 'opt-stale-badge', '长时间未体检');
  // 标题里给出具体天数与阈值：只说「长时间」用户无从判断要不要立刻处理
  badge.title = `已经 ${days} 天没有体检（超过 ${STALE_CHECKUP_DAYS} 天即提示）`;
  host.appendChild(badge);
}

function renderScore(report) {
  const ring = $('#optRing');
  const num = $('#optScoreNum');
  const grade = $('#optGrade');
  const count = $('#optIssueCount');
  const lastAt = $('#optLastAt');

  ring.className = 'opt-ring';

  // 体检进行中：分数环换成 loading。这一档必须先判——
  // 此刻报告里还留着**上一次**的分数，直接显示会让用户以为这次已经出结果了
  if (checkupBusy) {
    ring.classList.add('is-loading');
    num.textContent = '';
    grade.textContent = checkupBusy === 'posting' ? '正在启动…' : '分析中…';
    count.textContent = '各维度陆续出结果，可以离开这个页面';
    renderLastAt(lastAt, report?.at);
    return;
  }

  if (!report || typeof report.score !== 'number') {
    num.textContent = '--';
    grade.textContent = '未体检';
    count.textContent = '';
    renderLastAt(lastAt, report?.at);
    return;
  }

  num.textContent = String(report.score);
  if (report.grade) ring.classList.add(`is-${report.grade}`);
  grade.textContent = GRADE_LABEL[report.grade] || '';
  count.textContent = `发现 ${report.issueCount} 项问题`;
  renderLastAt(lastAt, report.at);
}

/** 当前项目的豁免清单（`/api/optimize/ignores` 拉的），只用于「已豁免 N 项」入口与面板 */
let ignoredItems = [];

/** 拉一次豁免清单并刷新入口按钮。失败静默——它是附加信息，不该挡住看报告 */
async function loadIgnored(dir) {
  if (!dir) { ignoredItems = []; renderIgnoredEntry(); return; }
  try {
    const r = await fetch(`/api/optimize/ignores?dir=${encodeURIComponent(dir)}`);
    const data = await r.json();
    ignoredItems = Array.isArray(data.items) ? data.items : [];
  } catch {
    ignoredItems = [];
  }
  renderIgnoredEntry();
}

function renderIgnoredEntry() {
  const btn = $('#optIgnoredEntry');
  if (!btn) return;
  // 修复中一并隐藏：它通向「全部撤销豁免」，而那会让本轮正在修的清单当场失效。
  // 顶部四个按钮在 fixing 态只留「停止修复」（buttonVisibility），这个入口漏在外面，
  // 就成了那一刻屏幕上唯一一个能点却不该点的东西
  btn.hidden = !ignoredItems.length || fixRunning;
  btn.textContent = `已豁免 ${ignoredItems.length} 项`;
  btn.title = '查看并撤销「这不是问题」的记录';
}

/**
 * 把一条 issue 标记为「这不是问题」。
 *
 * 备注必填：空备注等于没记录 —— 三个月后翻到 IGNORED.md 的人（包括提交者自己）
 * 无从判断这条豁免还成不成立，那样的记录比没有更糟，因为它看起来像个结论。
 */
async function ignoreIssue(dimKey, issue, row) {
  const where = issue.line ? `${issue.file}:${issue.line}` : issue.file;
  const note = await textareaDialog({
    title: '这不是问题',
    message: `${where}\n${issue.message}\n\n说明为什么这不算问题。下次体检会跳过它，理由会记进 .claude/optimize/IGNORED.md。`,
    placeholder: '例如：这是历史商城遗留的兼容层，下个版本整体删除，现在解耦不划算',
    confirmText: '记下并忽略',
  });
  // null = 取消；空白 = 没写理由，两者都不该落盘
  if (note === null || !note.trim()) return;

  const { ok, data } = await postJson('/api/optimize/ignore', {
    dir: currentDir,
    dim: dimKey,
    code: issue.code,
    file: issue.file,
    message: issue.message,
    note: note.trim(),
  });
  if (!ok) { toast.error(data.error || '记录失败'); return; }

  // 就地移除而不是整体 render：此刻后端报告里那条 issue 还在
  // （过滤发生在下一次体检），重渲染会把它原样画回来
  row.remove();
  await loadIgnored(currentDir);
  toast.success('已记下，下次体检会跳过这一条');
}

/**
 * 「已豁免 N 项」面板：逐条列出，可全部撤销。
 *
 * 复用 confirmDialog 做只读列表 + 全部撤销，而不是造一个可逐条撤销的自定义弹窗：
 * 逐条撤销的价值在这里很低（要精修可以直接改 IGNORED.md 旁边的真相源或重新豁免），
 * 为它造一套新弹窗的代价不成比例。
 */
async function openIgnoredPanel() {
  if (!ignoredItems.length) return;
  const lines = ignoredItems.slice(0, 20).map((it) => `· ${it.file}（${it.code}）—— ${it.note}`);
  const more = ignoredItems.length > 20 ? `\n…另有 ${ignoredItems.length - 20} 项，完整清单见 .claude/optimize/IGNORED.md` : '';
  const go = await confirmDialog({
    title: `已豁免 ${ignoredItems.length} 项`,
    message: `${lines.join('\n')}${more}\n\n撤销全部豁免后，这些问题会在下次体检重新出现。`,
    confirmText: '全部撤销',
    cancelText: '关闭',
    danger: true,
  });
  if (!go) return;

  for (const it of ignoredItems) {
    await postJson('/api/optimize/ignore/remove', {
      dir: currentDir, dim: it.dim, code: it.code, file: it.file,
    });
  }
  await loadIgnored(currentDir);
  toast.success('已撤销全部豁免，重新体检后这些问题会重新出现');
}

/**
 * 渲染一个维度的问题清单。
 *
 * 每条前面带复选框——勾选从底部那棵独立的「修复计划树」上移到了这里。
 * 一处勾选、一处真相：两处都能勾会让用户不知道以哪个为准，而同一状态两处渲染的
 * 同步成本长期看远高于横向筛选带来的便利。
 *
 * 不在计划里的 issue（维度 status 非 done，或该 issue 没有可用的修复策略）
 * 渲染一个等宽占位而不是复选框 —— 少了占位，有勾和没勾的行会左右错开。
 */
function renderIssues(box, dimKey, issues) {
  const byId = planItemIndex();

  for (const it of issues) {
    const row = el('div', 'opt-issue');
    const item = byId.get(it.planId);

    // 定点刷新（applyFixRowState）靠这三个数据属性认行，不必重建 DOM
    if (item) row.dataset.planId = item.id;
    row.dataset.dim = item?.dim || dimKey;
    row.dataset.file = it.file || '';

    // 前导位：复选框 / 进度指示 / 等宽占位三选一，同宽保证整列不左右错开。
    // 包一层壳而不是直接塞进 row，是为了让 applyFixRowState 能只换这一格的内容
    const lead = el('span', 'opt-issue-lead');
    row.appendChild(lead);

    if (item) {
      const isHandled = handled.has(item.id);
      if (isHandled) row.classList.add('is-handled');
      const cb = planCheckbox(selected.has(item.id) ? 'all' : 'none', () => {
        selected = toggleNode([item.id], selected);
        refreshSelectionUi();
      });
      cb.dataset.planId = item.id;
      // 已处理的不可再勾：防止用户在同一轮里重复修同一条
      if (isHandled) cb.disabled = true;
      lead.appendChild(cb);
    } else {
      lead.appendChild(el('span', 'opt-issue-nocheck'));
    }

    row.appendChild(el('span', `opt-issue-sev sev-${it.severity}`, it.severity));
    row.appendChild(el('span', 'opt-issue-loc', it.line ? `${it.file}:${it.line}` : it.file));
    const msg = el('span', 'opt-issue-msg', it.message);
    msg.title = it.message; // 超宽由 CSS 截断，title 兜住全文
    row.appendChild(msg);

    // 动作与风险是同一来源（策略）的两面，合成一个标签：分成两个会让人以为是两种属性
    if (item) {
      row.appendChild(el('span', `opt-tag risk-${item.risk}`, `${item.action}·${RISK_LABEL[item.risk] || item.risk}`));
    }
    if (item && handled.has(item.id)) row.appendChild(el('span', 'opt-plan-handled', '本轮已处理'));

    // 本轮进度文案（排队中 / 修复中 / 已处理 / 未完成）。空壳常驻，内容由 applyFixRowState 填，
    // 这样每次进度事件只改文字，不必重建这几百行
    row.appendChild(el('span', 'opt-issue-state'));

    // 「这不是问题」：紧跟在文案/标签之后随行排（不再 margin-left:auto 顶到最右）——
    // 每行内容长短不一，顶到最右会让这一列落在一片空白中央，既难扫读也难与文案对上
    const ignoreBtn = el('button', 'opt-issue-ignore', '这不是问题');
    ignoreBtn.title = '标记为「这不是问题」并填写理由，下次体检会跳过';
    ignoreBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // 别触发所在卡片的折叠
      ignoreIssue(dimKey, it, row);
    });
    row.appendChild(ignoreBtn);

    applyFixRowState(row); // 本轮在修的行：把前导位换成进度指示、禁掉豁免按钮
    box.appendChild(row);
  }
}

/** 进度态 → 前导位的标记类与字符。running 用转圈（无字符），其余用符号 */
const FIX_MARK = {
  queued: ['opt-issue-wait', '·'],
  running: ['opt-issue-spin', ''],
  done: ['opt-issue-ok', '✓'],
  failed: ['opt-issue-bad', '✗'],
};

/**
 * 把一行的修复进度刷到位。
 *
 * **渲染与 SSE 定点更新共用这一个函数**：两处各写一遍必然漂移——这个面板已经因为
 * 「状态变量改了、某个渲染分支没跟上」栽过一次（见 refreshButtons 头注释）。
 *
 * 只改前导位与行尾文案两处，不动整行：一次修复几百条 issue，
 * 每个进度事件都 render() 会把用户正展开的清单反复折叠掉（同 openCheckupStream 的教训）。
 */
function applyFixRowState(row) {
  const planId = row.dataset.planId || '';
  const state = fixRowState({
    inRound: !!planId && fixingIds.has(planId),
    dim: row.dataset.dim || '',
    file: row.dataset.file || '',
    activeDim: fixActiveDim,
    seenDims: fixSeenDims,
    doneFiles: fixDoneFiles,
  });

  const lead = row.querySelector('.opt-issue-lead');
  const label = row.querySelector('.opt-issue-state');
  const ignoreBtn = row.querySelector('.opt-issue-ignore');
  if (!lead || !label) return;

  row.classList.toggle('is-fixing', state === 'running');
  // 本轮内的行一律禁掉豁免：点下去会把这一行从 DOM 摘掉，而后端还在改它对应的文件
  if (ignoreBtn) ignoreBtn.disabled = state !== 'idle';

  if (state === 'idle') {
    label.textContent = '';
    label.className = 'opt-issue-state'; // 连同上一态的着色一起清掉，别留个没字的彩色空格
    return;
  }
  // 复选框此刻本就是禁用的，把这一格让给进度指示不丢任何信息，
  // 却能让用户在几百行里一眼找到「进度到哪了」
  const [cls, ch] = FIX_MARK[state];
  lead.textContent = '';
  lead.appendChild(el('span', cls, ch));
  label.textContent = FIX_STATE_LABEL[state] || '';
  label.className = `opt-issue-state is-${state}`;
}

/** 修复进度变化后的定点刷新：只走已渲染的 issue 行，不重建 DOM */
function refreshFixProgressUi() {
  for (const row of document.querySelectorAll('#optDims .opt-issue')) applyFixRowState(row);
}

/**
 * 渲染 holistic 的行动计划块。
 *
 * 单独一块而不是混进 issue 列表：issue 是「哪里有问题」，计划是「先做哪件、做完算什么」。
 * 后者是这一维的全部价值，塞进一排 issue 里会被当成第 18 条问题而不是一份计划。
 */
function renderPlan(box, plan) {
  // 业务理解置顶：它决定了后面每条建议是否可信。用户先要认同「这个工具读懂了我的项目」，
  // 否则再具体的建议也只会被当成又一份通用报告
  if (plan.businessRead) {
    const b = el('div', 'opt-plan-biz');
    b.appendChild(el('div', 'opt-plan-title', '这个项目是做什么的'));
    b.appendChild(el('div', 'opt-plan-text', plan.businessRead));
    box.appendChild(b);
  }

  if (plan.verdict) {
    const v = el('div', 'opt-plan-verdict');
    v.appendChild(el('div', 'opt-plan-title', '总体判断'));
    v.appendChild(el('div', 'opt-plan-text', plan.verdict));
    box.appendChild(v);
  }

  if (plan.businessRisks?.length) {
    // 与 topActions 分开渲染：这些是「你得知道」而不是「你得做」，
    // 混进待办里会让人以为逐条做完就没事了
    const r = el('div', 'opt-plan-risks');
    r.appendChild(el('div', 'opt-plan-title', '业务特有风险（通用扫描看不见的）'));
    const ul = el('ul', 'opt-plan-list');
    for (const it of plan.businessRisks) {
      const li = el('li', null, it.what);
      if (it.evidence) li.appendChild(el('div', 'opt-plan-sub', `依据：${it.evidence}`));
      ul.appendChild(li);
    }
    r.appendChild(ul);
    box.appendChild(r);
  }

  if (plan.strengths?.length) {
    // 只报问题会让用户失去判断基准，也不知道哪些现有约定不该被后续改动破坏
    const s = el('div', 'opt-plan-strengths');
    s.appendChild(el('div', 'opt-plan-title', '做得好、应当保持'));
    const ul = el('ul', 'opt-plan-list');
    for (const t of plan.strengths) ul.appendChild(el('li', null, t));
    s.appendChild(ul);
    box.appendChild(s);
  }

  if (plan.contradictions?.length) {
    const c = el('div', 'opt-plan-contra');
    c.appendChild(el('div', 'opt-plan-title', '跨维度矛盾（需要你拍板）'));
    const ul = el('ul', 'opt-plan-list');
    for (const it of plan.contradictions) {
      const li = el('li', null, it.what);
      if (it.resolution) li.appendChild(el('div', 'opt-plan-sub', `建议取舍：${it.resolution}`));
      ul.appendChild(li);
    }
    c.appendChild(ul);
    box.appendChild(c);
  }
}

function renderDims(report) {
  const host = $('#optDims');
  host.textContent = '';

  for (const group of groupDims(dimListFrom(report))) {
    const section = el('div', 'opt-group');
    // 折叠态读显式持有的 Set，render 只读不写（写只发生在下面的 click handler 里）
    if (foldedGroups.has(group.key)) section.classList.add('is-folded');

    const head = el('div', 'opt-group-head');
    head.appendChild(el('span', 'opt-group-label', group.label));
    head.appendChild(el('span', 'opt-group-sum', groupSummary(group.dims)));
    // 组标题可折叠：17 个维度全展开是一面墙，用户往往只关心一两个域。
    // 折叠后靠 groupSummary 仍能看出这个域好不好，不是把信息藏起来
    head.addEventListener('click', () => {
      if (foldedGroups.has(group.key)) foldedGroups.delete(group.key);
      else foldedGroups.add(group.key);
      section.classList.toggle('is-folded', foldedGroups.has(group.key));
    });
    section.appendChild(head);

    const body = el('div', 'opt-group-body');
    renderDimCards(body, group.dims);
    section.appendChild(body);

    host.appendChild(section);
  }
}

/** 批级进度文案。没有进度信息时返回空串，由调用方回退到常规提示 */
function progressText(d) {
  const p = dimProgress.get(d.key);
  if (!d.busy || !p || !p.total) return '';
  return `AI 分析中… 第 ${p.done}/${p.total} 批`;
}

/** planId → 计划项。issue 行要靠它决定能不能勾、显示什么动作与风险标签 */
function planItemIndex() {
  return new Map(plan.items.map((i) => [i.id, i]));
}

/** 某维度在当前计划里的全部 planId（维度头部三态复选框的作用域） */
function planIdsOfDim(dimKey) {
  return plan.items.filter((i) => i.dim === dimKey).map((i) => i.id);
}

/**
 * 勾选变化后的**定点**刷新：只改复选框状态、计数与顶部按钮，不重建任何 DOM。
 *
 * 为什么不直接 render()：本仓库实测一次体检 265 项问题，全量重建意味着每点一次复选框
 * 就重造几百个节点——不只是卡顿，还会把用户正在看的展开状态和滚动位置一起扰乱。
 * （批级进度事件早就为同一个理由做过定点更新，见 openCheckupStream 里的 progress 处理。）
 */
function refreshSelectionUi() {
  for (const cb of document.querySelectorAll('#optDims input[data-plan-id]')) {
    cb.checked = selected.has(cb.dataset.planId);
  }
  for (const cb of document.querySelectorAll('#optDims input[data-dim-check]')) {
    const ids = planIdsOfDim(cb.dataset.dimCheck);
    const state = nodeCheckState(ids, selected);
    cb.checked = state === 'all';
    cb.indeterminate = state === 'some';
  }
  for (const label of document.querySelectorAll('#optDims [data-dim-count]')) {
    const ids = planIdsOfDim(label.dataset.dimCount);
    label.textContent = `已勾 ${ids.filter((id) => selected.has(id)).length}/${ids.length}`;
  }
  refreshButtons();
}

function renderDimCards(host, dims) {
  for (const d of dims) {
    const card = el('div', 'opt-dim');
    card.dataset.dim = d.key;
    if (d.status === 'disabled') card.classList.add('is-disabled');
    if (d.busy) card.classList.add('is-busy');

    const head = el('div', 'opt-dim-head');

    // 维度级三态勾选：全选 / 部分 / 无。只有该维度在计划里有条目时才出现
    const dimIds = planIdsOfDim(d.key);
    if (dimIds.length) {
      const cb = planCheckbox(nodeCheckState(dimIds, selected), () => {
        selected = toggleNode(dimIds, selected);
        refreshSelectionUi();
      });
      cb.dataset.dimCheck = d.key;
      head.appendChild(cb);
    } else {
      head.appendChild(el('span', 'opt-issue-nocheck'));
    }

    head.appendChild(el('span', 'opt-dim-label', d.label));

    // analyzing / pending / disabled / error 用 reason 说明为什么没分，避免用户以为坏了；
    // partial 有分数但结论不完整，用 note 标注出来别让人当成可信分数
    const hintText = d.status === 'done' ? d.hint : (d.note || d.reason || d.hint);
    const hintEl = el('span', 'opt-dim-hint', progressText(d) || hintText);
    // 打上 data-dim：批级进度事件来得很频繁（每批一次），靠它定点改这一个节点，
    // 不必为每个进度事件重建全部 17 张卡片
    hintEl.dataset.dimHint = d.key;
    head.appendChild(hintEl);

    if (dimIds.length) {
      const count = el('span', 'opt-dim-count', `已勾 ${dimIds.filter((id) => selected.has(id)).length}/${dimIds.length}`);
      count.dataset.dimCount = d.key;
      head.appendChild(count);
    }

    if (d.issueCount > 0) head.appendChild(el('span', 'opt-dim-badge', `${d.issueCount} 项`));
    // analyzing 时分数位换成转圈，等 SSE 送来结果再变成数字
    if (d.busy) head.appendChild(el('span', 'opt-dim-spin'));
    else head.appendChild(el('span', 'opt-dim-score', d.scoreText));

    // 点头部展开问题清单。展开态记进 openCards —— 否则下一次 render 就丢了
    const expandable = d.issueCount > 0 || !!d.plan;
    head.addEventListener('click', (e) => {
      // 复选框有自己的 stopPropagation，这里再挡一道 label 等可能的冒泡来源
      if (e.target.closest('input')) return;
      if (!expandable) return;
      if (openCards.has(d.key)) openCards.delete(d.key);
      else openCards.add(d.key);
      card.classList.toggle('is-open', openCards.has(d.key));
    });

    card.appendChild(head);

    if (expandable) {
      const box = el('div', 'opt-issues');
      // 计划在前、逐条 issue 在后：计划是「先做哪件」，issue 是「哪里有问题」。
      // 反序会让用户先读完 17 条问题才看到该从哪下手
      if (d.plan) renderPlan(box, d.plan);
      if (d.issueCount > 0) renderIssues(box, d.key, d.issues);
      card.appendChild(box);
    }

    if (expandable && openCards.has(d.key)) card.classList.add('is-open');

    host.appendChild(card);
  }
}

// ==================== 勾选控件 ====================

/**
 * 造一个项目风格的复选框。issue 行与维度头部共用。
 *
 * 用 `.pretty-check`（项目既有的样式化复选框）而不是裸 `input[type=checkbox]`——
 * 后者会渲染成浏览器原生控件，与整个界面的视觉语言不符。
 * 三态由 `checked` / `indeterminate` 两个原生属性表达，CSS 已为两者都定义了样式。
 */
function planCheckbox(state, onToggle) {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'pretty-check';
  cb.checked = state === 'all';
  cb.indeterminate = state === 'some';
  cb.disabled = fixRunning || !!checkupBusy;
  cb.addEventListener('click', (e) => {
    e.stopPropagation(); // 勾选不该触发所在行的折叠
    onToggle();
  });
  return cb;
}

/**
 * 测试闸关闭时的横幅。
 *
 * 为什么非有不可：闸一关，计划里**过半**的条目（源码重构）就只会产出清单、一行代码不改。
 * 在这之前用户能看到的全部线索是——issue 行上一个「只出清单」的小标签。
 * 那个标签说明了「是什么」，说不了「为什么」和「怎么解锁」，而后两者才是用户要的。
 *
 * `gate.known === false`（旧报告里没有 testRun 字段）时什么都不显示：
 * 宁可不说，也不要对着一个我们其实没判过的状态下结论。
 */
function renderGateBanner() {
  const host = $('#optGateBanner');
  if (!host) return;
  host.textContent = '';

  const gate = plan.gate || {};
  const blocked = plan.items.filter((i) => i.degraded).length;
  // 没有被挡下的条目就不必提闸 —— 闸关着但这次没有源码项，说了只是噪音
  host.hidden = !gate.known || gate.allowed || !blocked || !!checkupBusy;
  if (host.hidden) return;

  host.appendChild(el('span', 'opt-gate-icon', '⚠'));
  const body = el('div', 'opt-gate-body');
  body.appendChild(el('div', 'opt-gate-title', `本轮有 ${blocked} 项源码问题不会被修改，只会生成整改清单`));
  body.appendChild(el('div', 'opt-gate-why', gate.reason));
  host.appendChild(body);
}

function render() {
  renderScore(currentReport);
  renderGateBanner();
  renderDims(currentReport);
  refreshButtons();
  // 必须在这里也刷一次：它的可见性现在还取决于 fixRunning，
  // 而 fixRunning 变化只会触发 render，不会触发 loadIgnored
  //（凡是参与渲染的状态变量，改它的地方就必须触发渲染——本文件反复吃过这个亏）
  renderIgnoredEntry();
}

/**
 * 顶部按钮区。
 *
 * **判定全在 `optimize-plan.logic.js` 的 topButtonsState**，这里只把结果映射到 DOM。
 * 上一轮的事故教训是「状态变量改了但某个渲染分支没跟上」，把判定收进一个可单测的
 * 纯函数是杜绝它的唯一办法——五种状态在测试里都有断言。
 */
function refreshButtons() {
  const s = topButtonsState({
    hasReport: !!currentReport,
    checkupBusy,
    fixRunning,
    items: plan.items,
    selected,
    handled,
  });
  const vis = buttonVisibility(s.mode);

  const run = $('#optRunCheckup');
  const cancelCk = $('#optCancelCheckup');
  const fix = $('#optFix');
  const cancelFixBtn = $('#optFixCancel');
  const note = $('#optDoneNote');

  // 体检按钮：没报告时「开始体检」，有报告时「重新体检」；
  // 体检中让位给「中止体检」，修复中让位给「停止修复」——
  // 修复中原来是 disabled 而非 hidden，但一个灰着的大按钮和「停止修复」并排，
  // 只会让人以为还有得选。同一时刻只留一个可点的动作
  if (run) {
    run.hidden = !vis.checkup;
    run.disabled = false;
    run.textContent = currentReport ? '重新体检' : '开始体检';
    // 没体检过时它是面板上唯一的动作，该用实心；有报告后让位给「一键修复」
    run.classList.toggle('is-primary', !currentReport);
  }
  if (cancelCk) {
    cancelCk.hidden = !vis.cancelCheckup;
    if (vis.cancelCheckup) {
      cancelCk.disabled = cancelling.checkup;
      cancelCk.textContent = cancelling.checkup ? '中止中…' : '中止体检';
    }
  }
  if (fix) {
    // 只有 ready 态才显示：done-all（全处理完）与 idle（没报告）都不该有这个按钮
    fix.hidden = !vis.fix;
    fix.disabled = s.fixDisabled;
    fix.textContent = s.fixCount ? `一键修复（${s.fixCount} 项）` : '一键修复';
  }
  if (cancelFixBtn) {
    cancelFixBtn.hidden = !vis.cancelFix;
    if (vis.cancelFix) {
      cancelFixBtn.disabled = cancelling.fix;
      cancelFixBtn.textContent = cancelling.fix ? '停止中…' : '停止修复';
    }
  }
  if (note) {
    // 两种空态共用这一个位置：
    //   done-all —— 本轮勾选的都修完了，但分数没重算，不说清用户会以为分数已反映修复结果；
    //   计划为空 —— 体检出了问题，但没有一条是机器能自动处理的。
    // 后者在修复计划树被移除后失去了原来的容身之处（原 renderFixPlan 里的 opt-plan-empty），
    // 不补的话用户只会看到「所有 issue 行都没有复选框」而无从理解为什么
    // 名字不能叫 emptyPlan：那是模块级构造空计划的函数，同名会在本块内把它整个遮蔽掉
    const planIsEmpty = !!currentReport && !checkupBusy && !fixRunning && !plan.items.length;
    note.hidden = s.mode !== 'done-all' && !planIsEmpty;
    note.textContent = s.mode === 'done-all'
      ? '本轮可修项已全部处理。分数与问题数仍是修复前的值，重新体检才会更新。'
      : '本次体检没有发现可自动处理的问题。下方清单仍可查看，并逐条标记「这不是问题」。';
  }
}

/**
 * 把报告里残留的 analyzing 当「没跑完」处理。
 *
 * 正常路径下 analyzing 只是内存里的过渡态，每个维度落地都会立刻覆盖并落盘；
 * 只有服务在分析中途被杀才会把它留在 optimize.json 里。此时那次任务的 SSE 早已随进程消失，
 * 不改写的话卡片会永远转圈——转圈是「马上就有结果」的承诺，兑现不了就不该显示。
 *
 * ⚠️ **调用前必须先过 `shouldNormalizeStale(busy)`**：体检真在跑的时候调它，
 * 会把「正在进行」显示成「分析失败，请重新体检」，而那些维度不会再发 SSE 事件来纠正。
 * 这里不自带守卫，是因为另有一条真失败路径（SSE 连接不可恢复）要无条件改写。
 */
function normalizeStaleReport(report) {
  for (const d of Object.values(report?.dims || {})) {
    if (d?.status === 'analyzing') {
      d.status = 'error';
      d.reason = '上次分析未完成（服务可能已重启），请重新体检';
    }
  }
  return report;
}

/**
 * 载入某个目录的报告。
 *
 * @param {string} dir
 * @param {object} [opts]
 * @param {boolean} [opts.switching] 是否在**换项目**。
 *   这个区分是必须的：本函数既被「换目录」调用，也被「每次打开面板」调用
 *   （`initOptimizePanel`），而两者对已有 SSE 连接的处置完全相反。
 *   原实现一律 `closeCheckupStream()`，于是「体检跑到一半切去别的页面再回来」
 *   会把活着的订阅退掉、`checkupBusy` 清空——界面看不到 loading，
 *   点体检又被后端的串行闸 409 挡住（「该项目正在体检或优化中」），而任务其实还在跑。
 */
async function loadReport(dir, { switching = true } = {}) {
  if (switching) {
    // 换项目：上一个项目的流、勾选、优化结果都不该跟过来
    closeCheckupStream();
    closeFixStream();
    setFixRunning(false);
    const progress = $('#optProgress');
    if (progress) { progress.textContent = ''; progress.hidden = true; }
  }

  if (!dir) {
    currentReport = null;
    plan = emptyPlan();
    selected = new Set();
    handled = new Set();
    ignoredItems = [];
    render();
    return;
  }
  try {
    const r = await fetch(`/api/optimize/report?dir=${encodeURIComponent(dir)}`);
    const data = await r.json();
    // 体检还在跑时**绝不能**改写 analyzing —— 那会把「正在进行」显示成「分析失败」。
    // 判据与理由见 optimize-view.logic.js 的 shouldNormalizeStale
    currentReport = shouldNormalizeStale(data.busy)
      ? normalizeStaleReport(data.report)
      : data.report;
    await loadPlan(dir);
    await loadIgnored(dir);
    render();
    await resumeIfBusy(dir, data.busy);
    return;
  } catch {
    currentReport = null;
    plan = emptyPlan();
  }
  render();
}

/**
 * 拉取修复计划。
 *
 * 换项目或重新体检后必须重拉：计划项的 id 是「报告里的 issue 下标」，
 * 报告一变下标就会错位（后端还有一道 reportAt 校验兜底，但前端不该主动送错数据）。
 *
 * 顺带重置 handled —— 「本轮已处理」是针对一份具体计划的标记，换了计划就不再适用。
 */
async function loadPlan(dir) {
  if (!dir) {
    plan = emptyPlan();
    selected = new Set();
    handled = new Set();
    openCards = new Set();
    foldedGroups = new Set();
    return;
  }
  try {
    const r = await fetch(`/api/optimize/fix-plan?dir=${encodeURIComponent(dir)}`);
    const data = await r.json();
    plan = {
      at: String(data.at || ''),
      items: Array.isArray(data.items) ? data.items : [],
      gate: data.gate || { known: false, allowed: true, reason: '' },
    };
  } catch {
    plan = emptyPlan();
  }
  selected = defaultSelection(plan.items); // 默认只勾低风险
  handled = new Set();
  // 折叠态跟着新计划重来。初始值取「有勾选项的维度」——低风险默认勾选，
  // 所以一进来展开的正好是本轮会动的那些（这是原计划树的好行为，保留下来）。
  // 之后它只由用户点击改变，不再被勾选影响——那正是「勾选时莫名收起/展开」的根因
  openCards = new Set(plan.items.filter((i) => selected.has(i.id)).map((i) => i.dim));
  // 整体评估默认展开：它是「先看哪儿」的答案，要用户多点一下才看到就白搭了
  openCards.add('holistic');
  foldedGroups = new Set();
}

/**
 * 后端说这个项目正被占用时，决定是「重连」还是「解锁」。
 *
 * 两种情况外观相同、处置完全相反，靠后端给的 `alive` 区分：
 *   - `alive: true`  → 任务真在跑，接回它的 SSE，loading 与逐维度回填都恢复
 *   - `alive: false` → 占用记录还在但任务已死（服务重启过），请求解锁，
 *                      否则用户会被这条记录挡在门外最多一小时
 *
 * 已经有本地活跃流时直接返回：那说明是本页面自己发起的，不必重复接。
 */
async function resumeIfBusy(dir, busy) {
  if (!busy) return;

  if (!busy.alive) {
    try {
      const r = await fetch('/api/optimize/busy/heal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir }),
      });
      const out = await r.json();
      // 只在真解锁了才提示：没解锁的原因是「任务其实活着」，那不是用户要知道的事
      if (out.healed) toast.info('上次的体检/优化没跑完（服务可能重启过），已解锁，可以重新开始');
    } catch { /* 解锁失败不影响看报告；下次打开面板会再试一次 */ }
    return;
  }

  if (busy.kind === 'checkup' && busy.jobId && !checkupStream) {
    // 不必在这里 render：openCheckupStream 内部会置状态并整体渲染
    openCheckupStream(busy.jobId);
  } else if (busy.kind === 'fix' && busy.jobId && !fixStream) {
    setFixRunning(true);
    render();
    openFixStream(busy.jobId);
  }
}

function closeCheckupStream() {
  checkupBusy = '';
  checkupJobId = null;
  // 收尾即复位：openCheckupStream 也会先调本函数，下一轮体检不会带着上一轮的「中止中…」开场
  cancelling.checkup = false;
  dimProgress = new Map();
  setOptimizeBadge('');
  // 必须整体 render()，不能只 refreshButtons()。
  //
  // 实测事故：体检跑完后进度环永远停在 loading，用户重开面板才刷新。原因是
  // `renderScore` 依赖 `checkupBusy` 决定画 loading 还是分数，而 done 事件的处理顺序是
  // `applyCheckupDone()`（内部 render，此刻 checkupBusy 还是 'analyzing' → 画 loading）
  // → `closeCheckupStream()`（清空 checkupBusy，但只刷按钮）。于是环再没被重画过。
  //
  // 教训：**凡是参与渲染的状态变量，清理它的地方就必须触发渲染**。
  // 只刷按钮是这个函数的历史行为——那时 checkupBusy 只影响按钮，现在不是了。
  render();
  if (!checkupStream) return;
  checkupStream.close();
  checkupStream = null;
}

/** 单个 LLM 维度回填：只换该维度，其余卡片和总分环保持原样 */
function applyDimResult(key, result) {
  if (!currentReport?.dims || !key || !result) return;
  currentReport.dims[key] = result;
  render();
}

/** 全部维度落地：后端重算过的总分/等级/问题数一次性盖上来 */
function applyCheckupDone(done) {
  if (!currentReport || !done) return;
  currentReport.score = done.score;
  currentReport.grade = done.grade;
  currentReport.issueCount = done.issueCount;
  render();
  // 新报告 = 新下标，计划必须重拉。不 await：这里是 SSE 事件回调，
  // 拉完自己再 render 一次即可
  loadPlan(currentDir).then(render);
}

/**
 * 接一次体检的维度回填流。
 *
 * replay 是必需的：POST 返回到这里把 EventSource 建起来之间有个窗口，跑得快的维度
 * （比如注释维度抽不到样本直接 na）可能正好落在窗口里，只听 dim 事件会永远等不到它。
 */
function openCheckupStream(checkupId) {
  closeCheckupStream();
  const es = new EventSource(`/api/optimize/checkup-stream?checkupId=${encodeURIComponent(checkupId)}`);
  checkupStream = es;
  // closeCheckupStream 刚把状态清空，这里再置回分析中（顺序不能反）
  checkupBusy = 'analyzing';
  checkupJobId = checkupId; // 「中止体检」要拿它调 cancel
  setOptimizeBadge('checkup'); // 面板开着时直接驱动侧栏标签，不必等轮询
  // render() 而不是 refreshButtons()：checkupBusy 现在还决定分数环画 loading 还是画分数，
  // 只刷按钮的话环不会切成 loading（与 closeCheckupStream 里记的是同一个教训）
  render();

  es.addEventListener('replay', (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    for (const [key, result] of Object.entries(d.dims || {})) applyDimResult(key, result);
    if (!d.done) return;
    // 接晚了：任务在 EventSource 建起来之前就跑完了，replay 里已是终局，不会再有 done 事件
    applyCheckupDone(d.done);
    closeCheckupStream();
  });

  es.addEventListener('dim', (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    dimProgress.delete(d.key); // 维度已落地，进度信息没用了
    applyDimResult(d.key, d.result);
  });

  // 批级进度：一个维度要全部批次跑完才落地（deadcode 有 19 批、每批约 55 秒），
  // 没有这条事件，卡片会转圈二十多分钟且界面零变化——实测已被误判成「任务死了」
  es.addEventListener('progress', (ev) => {
    let p;
    try { p = JSON.parse(ev.data); } catch { return; }
    dimProgress.set(p.dim, { done: p.done, total: p.total });
    // 定点改这一个节点而不是 render()：进度事件每批一次，全量重建 17 张卡片
    // 会把用户正在展开的问题清单反复折叠掉
    const hint = document.querySelector(`[data-dim-hint="${p.dim}"]`);
    if (hint) hint.textContent = `AI 分析中… 第 ${p.done}/${p.total} 批`;
  });

  es.addEventListener('done', (ev) => {
    try { applyCheckupDone(JSON.parse(ev.data)); } catch { /* 脏帧忽略 */ }
    closeCheckupStream();
  });

  es.onerror = () => {
    // EventSource 默认会自动重连（网络抖动时正是我们要的，重连后 replay 补齐）。
    // 只有 readyState 落到 CLOSED 才是不可恢复的失败（任务已过期返 404 等），此时才收手。
    if (es.readyState !== EventSource.CLOSED) return;
    closeCheckupStream();
    currentReport = normalizeStaleReport(currentReport);
    render();
    toast.error('AI 分析连接中断，请重新体检');
  };
}

/** 同步「当前项目」展示：有目录显示全路径（超宽由 CSS 截断，title 兜住全路径），无目录给引导语 */
function refreshDirLabel() {
  const label = $('#optDirLabel');
  const host = $('#optDirCurrent');
  if (!label) return;
  label.textContent = currentDir || '未选择项目目录，请在顶栏选择';
  if (host) host.title = currentDir || '';
}

async function runCheckup() {
  const dir = currentDir;
  if (!dir) { toast.error('请先在顶栏选择项目目录'); return; }

  checkupBusy = 'posting';
  render(); // 同上：环要立刻切成 loading，不能只刷按钮

  try {
    const r = await fetch('/api/optimize/checkup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    });
    const data = await r.json();
    if (!r.ok) { toast.error(data.error || '体检失败'); return; }
    closeCheckupStream(); // 上一次体检的流可能还开着，先退订再换报告
    currentReport = data.report;
    render();
    // 有 checkupId 才说明有维度要冷跑；缓存全命中时后端直接把 done 结果并进了同步返回
    if (data.checkupId) openCheckupStream(data.checkupId);
  } catch (e) {
    toast.error('体检请求失败：' + (e?.message || e));
  } finally {
    // 已经进入 SSE 阶段的话由 closeCheckupStream 负责收尾，这里不能抢着清
    if (checkupBusy === 'posting') checkupBusy = '';
    render();
  }
}

/**
 * 中止体检。
 *
 * 后端立即收尾：已完成的维度保留分数，未跑完的标 cancelled（「已取消，重新体检可续」）。
 * 不在这里改本地状态——等 SSE 的 done 事件回来统一处理，否则会和后端的终局状态打架。
 */
async function cancelCheckup() {
  if (!checkupJobId || cancelling.checkup) return;
  cancelling.checkup = true;
  refreshButtons();

  const { ok } = await postJson('/api/optimize/checkup/cancel', { checkupId: checkupJobId });
  // 404 = 任务已经自己跑完了，这不是错误；按钮此时已随 done 事件隐藏
  if (!ok) {
    cancelling.checkup = false;
    refreshButtons();
  }
}

// ==================== 一键修复 ====================

/**
 * 统一切换「修复中」态。
 *
 * 唯一入口，不允许再裸写 `fixRunning = x`：这几个变量必须同生共死——
 * 退出修复的路径有七条（正常收尾 / SSE 断 / 四种提交失败 / 换项目），
 * 任何一条漏清 `fixingIds`，那几行 issue 就会永远转圈。
 *
 * @param {boolean} on
 * @param {string[]} [ids] 本轮提交的计划项 id。断流重连等拿不到 id 的场景传空，
 *   此时只显示「停止修复」不标行——宁可不标，也不靠文件名猜（一个文件常对应多条 issue）
 */
function setFixRunning(on, ids) {
  fixRunning = on;
  fixingIds = on ? new Set(ids || []) : new Set();
  // 进度三件套跟着一起进出。它们只在本轮有意义：留到下一轮会让新一轮的行
  // 一开始就顶着上一轮的 ✓，而那些文件这一轮压根还没动
  fixActiveDim = '';
  fixSeenDims = new Set();
  fixDoneFiles = new Map();
  cancelling.fix = false; // 进出修复态都复位，理由同 closeCheckupStream
}

function closeFixStream() {
  fixJobId = null;
  setOptimizeBadge('');
  if (!fixStream) return;
  fixStream.close();
  fixStream = null;
}

/**
 * 停止正在跑的优化。
 *
 * 只发停止信号，**不动已落盘的改动**——想撤销要走「还原本次优化」。
 * 把两者绑在一起会让「我不想再等了」变成「我要放弃已经生成好的那几份地图」，
 * 而后者几乎从来不是用户点停止时的本意。
 */
async function cancelFix() {
  if (!fixJobId || cancelling.fix) return;
  cancelling.fix = true;
  refreshButtons();

  const { ok } = await postJson('/api/optimize/fix/cancel', { jobId: fixJobId });
  // 404 = 任务已经自己跑完了，这不是错误，照常收尾即可
  if (!ok) {
    cancelling.fix = false;
    refreshButtons();
  }
}

/** 追加一行进度。同一行内「阶段 + 文件」，文件名可能为空（plan/backup 是全局步骤） */
function appendProgress({ phase, file, text }) {
  const host = $('#optProgress');
  if (!host) return;
  host.hidden = false;
  const row = el('div', 'opt-step');
  row.appendChild(el('span', 'opt-step-phase', stepLabel(phase)));
  if (file) row.appendChild(el('span', 'opt-step-file', file));
  if (text) row.appendChild(el('span', 'opt-step-text', text));
  host.appendChild(row);
  host.scrollTop = host.scrollHeight;
}

function openFixStream(jobId) {
  closeFixStream();
  const es = new EventSource(`/api/optimize/fix-stream?jobId=${encodeURIComponent(jobId)}`);
  fixStream = es;
  // closeFixStream 会把它清空，所以必须在它之后赋值
  fixJobId = jobId;
  setOptimizeBadge('fix');

  const finish = (done) => {
    setFixRunning(false);
    // 后端在优化结束时重算过静态维度，直接用它的报告，别让面板停在优化前的分数
    if (done?.report) currentReport = done.report;

    // 本轮提交过的计划项打「已处理」标记，防止用户在同一轮里重复修同一条。
    // **不重算分数与问题数** —— 那必须重新体检才更新（产品拍板）
    for (const id of done?.handledIds || []) handled.add(id);
    // 已处理的项没必要还勾着：留着会让「一键修复(N)」把它们算进去
    selected = new Set([...selected].filter((id) => !handled.has(id)));

    render();
    closeFixStream();
    openFixReport(done || {}, {
      onRollback: (backupDir) => rollbackFix(backupDir),
      onRecheck: () => runCheckup(),
    });
  };

  /**
   * step 事件推进「现在在修哪一维」。
   *
   * **只认带 dim 的那些**：test-gate / gen-map / plan-file 与 rules 降级的 step 没有 dim，
   * 拿它们覆盖会把 activeDim 清成空串，正在转圈的那一维瞬间退回「排队中」。
   */
  const trackStep = (s) => {
    const dim = typeof s?.dim === 'string' ? s.dim : '';
    if (!dim) return false;
    fixActiveDim = dim;
    fixSeenDims.add(dim);
    return true;
  };

  /** file 事件 = 某个文件的结果落定，对应行从「修复中」落到 ✓/✗ */
  const trackFile = (r) => {
    if (!r?.file) return false;
    fixDoneFiles.set(r.file, r.status || '');
    return true;
  };

  // replay 必需：POST 返回到 EventSource 建起来之间有个窗口，
  // 期间产生的 step 事件不补就永远丢了（快的任务甚至整个跑完都在窗口里）
  es.addEventListener('replay', (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    for (const e of d.events || []) {
      if (e.event === 'step') { appendProgress(e.data); trackStep(e.data); }
      // file 事件原先整批丢掉 —— 断线重连后已完成的那些行会退回「修复中」，
      // 看上去像在重跑。补进度回放必须把两类事件都补上
      else if (e.event === 'file') trackFile(e.data);
    }
    refreshFixProgressUi();
    if (d.done) finish(d.done);
  });

  es.addEventListener('step', (ev) => {
    let s;
    try { s = JSON.parse(ev.data); } catch { return; /* 脏帧忽略 */ }
    appendProgress(s);
    if (trackStep(s)) refreshFixProgressUi();
  });

  es.addEventListener('file', (ev) => {
    let r;
    try { r = JSON.parse(ev.data); } catch { return; }
    if (trackFile(r)) refreshFixProgressUi();
  });

  es.addEventListener('done', (ev) => {
    let d = null;
    try { d = JSON.parse(ev.data); } catch { /* 脏帧也要收尾，否则按钮永远卡在「优化中…」 */ }
    finish(d);
  });

  es.onerror = () => {
    // EventSource 默认自动重连（网络抖动时正是我们要的，重连后 replay 补齐）；
    // 只有 CLOSED 才是不可恢复的失败
    if (es.readyState !== EventSource.CLOSED) return;
    closeFixStream();
    setFixRunning(false);
    render();
    toast.error('优化进度连接中断。改动可能已部分完成，请重新体检确认');
  };
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

/**
 * 跑一次优化。
 *
 * @param {object} [opts]
 * @param {'low'|'elevated'} [opts.risk] 风险档位。默认 `'low'`——这是个会改代码的操作，
 *   缺省就该做最保守的那件事（后端 `risksFor` 也 fail-closed 到 low）
 * @param {boolean} [opts.force] 跳过脏工作区确认
 */
async function runFix({ force = false } = {}) {
  const dir = currentDir;
  if (!dir) { toast.error('请先在顶栏选择项目目录'); return; }

  const picked = plan.items.filter((i) => selected.has(i.id) && !handled.has(i.id));
  if (!picked.length) { toast.error('请先勾选要修复的项'); return; }

  // 测试闸关闭的告知。**必须在中高风险确认之前**：闸一关，被它挡下的项风险已降为 low，
  // 下面那个弹窗根本不会为它们弹出来 —— 于是用户一路点到底，全程没人告诉过他
  // 「你勾的这 165 项里没有一项会改代码」。这正是「修完再体检还是三百多项」的由来。
  const blocked = picked.filter((i) => i.degraded);
  if (blocked.length && !force) {
    const dims = [...new Set(blocked.map((i) => i.dimLabel))].join('、');
    const go = await confirmDialog({
      title: '其中大部分不会改代码',
      message: `勾选的 ${picked.length} 项里，有 ${blocked.length} 项（${dims}）`
        + '**只会生成整改清单，不会修改任何源码**。\n\n'
        + `原因：${plan.gate?.reason || '测试闸未放行'}\n\n`
        + `本次真正会落地改动的是另外 ${picked.length - blocked.length} 项。`
        + '要让源码修复生效，先处理掉上面这个原因再跑一次优化。',
      confirmText: '知道了，仍然继续',
      cancelText: '先去处理测试',
      danger: false,
    });
    if (!go) return;
  }

  // 中高风险二次确认。风险不再是按钮档位（那套语义与逐条勾选打架：
  // 用户勾了高风险项却被静默跳过），所以确认时机改由「勾选里有什么」决定。
  // 必须列出**具体会改写的文件**——只写一句「有风险」等于没确认
  const risky = riskyPicks(plan.items, selected, handled);
  if (risky.length && !force) {
    const lines = risky.slice(0, 12).map((i) => `· ${i.file} —— ${i.action}（${RISK_LABEL[i.risk]}）`);
    const more = risky.length > 12 ? `\n…另有 ${risky.length - 12} 项` : '';
    const go = await confirmDialog({
      title: '确认修复',
      message: `本次勾选含 ${risky.length} 项中高风险，会改动这些既有文件：\n\n${lines.join('\n')}${more}\n\n`
        + '兜底：开工前打全量快照；源码改动逐个文件跑测试，测试变红立即回滚该文件；'
        + '项目没有可跑的测试时，源码维度自动降级为只出清单、不改代码。\n\n'
        + '出问题可以用「还原本次优化」撤销全部改动。',
      confirmText: '我了解，开始修复',
      danger: true,
    });
    if (!go) return;
  }

  setFixRunning(true, picked.map((i) => i.id));
  render();
  $('#optProgress').textContent = '';
  $('#optProgress').hidden = true;

  try {
    const { ok, data } = await postJson('/api/optimize/fix', {
      dir,
      items: picked.map((i) => i.id),
      // 计划快照：报告变了就让后端拒掉，别拿旧下标去改文件
      reportAt: plan.at,
      // 风险由勾选决定，所以放开全部档位；真正的把关在上面的二次确认
      risk: 'all',
      force,
    });

    if (!ok) {
      setFixRunning(false);
      render();
      // 计划过期：报告变了，下标会错位。重拉计划让用户在新计划上重勾
      if (data.stalePlan) {
        toast.error('体检报告已更新，已为你重新加载修复计划');
        await loadPlan(dir);
        render();
        return;
      }
      // 409 = 串行闸挡下，多半是自己另开了一个标签页；带回来的 jobId 可以直接接上去看进度
      if (data.busy?.jobId) {
        toast.error('该项目已有一次修复在跑，已切换到它的进度');
        setFixRunning(true);
        render();
        openFixStream(data.busy.jobId);
        return;
      }
      toast.error(data.error || '修复失败');
      return;
    }

    if (data.needsConfirm) {
      setFixRunning(false);
      render();
      const go = await confirmDialog({
        title: '工作区有未提交的改动',
        message: dirtyConfirmMessage(data),
        confirmText: '仍然修复',
        danger: true,
      });
      // force 一并带下去：中高风险的确认上面已经过了，这里不该再弹一次
      if (go) await runFix({ force: true });
      return;
    }

    if (data.nothing) {
      setFixRunning(false);
      render();
      openFixReport({
        results: [],
        blocked: data.blocked,
        notes: ['勾选的项目前没有可自动处理的内容。'],
      }, { onRecheck: () => runCheckup() });
      return;
    }

    openFixStream(data.jobId);
  } catch (e) {
    setFixRunning(false);
    render();
    toast.error('修复请求失败：' + (e?.message || e));
  }
}

async function rollbackFix(dirName) {
  const go = await confirmDialog({
    title: '还原本次优化',
    message: '会把这次优化改动过的文件恢复到优化前的内容。优化之后你手工改过的文件会被跳过（不会丢）。确定还原？',
    confirmText: '还原',
    danger: true,
  });
  if (!go) return;

  const { ok, data } = await postJson('/api/optimize/rollback', { dir: currentDir, dirName });
  if (!ok) { toast.error(data.error || '还原失败'); return; }

  if (data.report) currentReport = data.report;
  // 还原把文件改回去了，「本轮已处理」的标记也就不再成立
  handled = new Set();
  render();
  $('#optProgress').hidden = true;

  const skipped = data.skipped?.length || 0;
  toast.success(`已还原 ${data.restored} 个文件${skipped ? `，跳过 ${skipped} 个（优化后又被手工改过）` : ''}`);
}

export function initOptimizePanel() {
  if (!inited) {
    inited = true;
    $('#optRunCheckup')?.addEventListener('click', runCheckup);
    $('#optCancelCheckup')?.addEventListener('click', cancelCheckup);
    $('#optFix')?.addEventListener('click', () => runFix());
    $('#optFixCancel')?.addEventListener('click', cancelFix);
    $('#optIgnoredEntry')?.addEventListener('click', openIgnoredPanel);
  }

  // 目录跟随顶栏：面板每次打开都重新取一次当前项目
  const dir = _getCwd() || '';
  // switching 必须靠「目录变没变」来判，不能恒 true 也不能恒 false：
  //   同一项目重开面板传 true，会把正在跑的体检/优化 SSE 退掉并清空 loading，
  //   而后端任务还在跑、串行闸还占着 —— 用户回来会看到「没有 loading 但点体检被拒」；
  //   换了项目传 false，则上一个项目的流、勾选、优化结果会跟到新项目上。
  // 顶栏「一窗一项目」通常开新窗，但 cwd 原为空时选目录是**就地生效**的，这条路径真会走到。
  const switching = dir !== currentDir;
  currentDir = dir;

  refreshDirLabel(); // 面板每次打开都同步一次，避免 DOM 被重建后文案回退
  loadReport(currentDir, { switching });
  // 面板打开时也探一次：用户可能是在别处发起的体检（另一个标签页 / 服务重启前）
  probeOptimizeBadge(currentDir);
}

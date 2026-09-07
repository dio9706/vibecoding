/**
 * 项目优化面板：体检展示 + 一键优化。
 *
 * 安全约定：所有来自后端的文本一律 createElement + textContent 渲染，
 * 禁止 innerHTML 拼接（本项目硬性约定，因为渲染的是后端/LLM 产出的不可信文本）。
 */
import { $, lsGet, lsSet } from './util.js';
import {
  dimListFrom, groupDims, groupSummary, checkupAge, STALE_CHECKUP_DAYS,
} from './optimize-view.logic.js';
import {
  canFix, fixButtonLabel, summarizeResults, scoreDelta, stepLabel, dirtyConfirmMessage, kindLabel,
} from './optimize-fix.logic.js';
import { openDirPickerFor } from './dir-popover.js';
import { confirmDialog } from './ui.js';
import toast from './toast.js';

let inited = false;
let currentReport = null;
/** 当前选中的体检目录。单例状态而非从 DOM 读——选择器已改成弹层式按钮，没有可读的 input */
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
/** 正在接收优化进度的 SSE 连接 */
let fixStream = null;
let fixRunning = false;
/** 当前优化任务 id —— 「停止」要拿它去调 cancel 接口 */
let fixJobId = null;
/**
 * 被用户**主动取消**勾选的维度。
 *
 * 两个设计点：
 * 1. 存在 DOM 之外——render() 每次都重建全部卡片，状态留在 checkbox 上的话，
 *    一次 SSE 维度回填就会把用户的勾选冲掉。
 * 2. 记「取消」而不是记「勾选」：默认是全选可选项，那么异步回填刚落地的维度会自动纳入、
 *    变得不可选的维度会自动剔除，都不需要额外的重算逻辑去追。
 */
let deselectedDims = new Set();
/**
 * 各维度的批级进度：`维度id -> {done, total}`。
 *
 * 为什么必须有：一个维度要**全部批次跑完**才落地成分数，而 deadcode 这类维度有 19 批、
 * 每批约 55 秒——卡片会转圈二十多分钟、界面零变化。实测已经因此被误判为「任务死了」。
 * 存在 DOM 之外的理由同 deselectedDims：render() 每次都重建全部卡片。
 */
let dimProgress = new Map();

const GRADE_LABEL = {
  healthy: '健康',
  good: '良好',
  'needs-work': '需优化',
  poor: '较差',
};

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

function renderIssues(box, issues) {
  for (const it of issues) {
    const row = el('div', 'opt-issue');
    row.appendChild(el('span', `opt-issue-sev sev-${it.severity}`, it.severity));
    row.appendChild(el('span', 'opt-issue-loc', `${it.file}:${it.line}`));
    row.appendChild(el('span', 'opt-issue-msg', it.message));
    box.appendChild(row);
  }
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

    const head = el('div', 'opt-group-head');
    head.appendChild(el('span', 'opt-group-label', group.label));
    head.appendChild(el('span', 'opt-group-sum', groupSummary(group.dims)));
    // 组标题可折叠：17 个维度全展开是一面墙，用户往往只关心一两个域。
    // 折叠后靠 groupSummary 仍能看出这个域好不好，不是把信息藏起来
    head.addEventListener('click', () => section.classList.toggle('is-folded'));
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

function renderDimCards(host, dims) {
  for (const d of dims) {
    const card = el('div', 'opt-dim');
    card.dataset.dim = d.key;
    if (d.status === 'disabled') card.classList.add('is-disabled');
    if (d.busy) card.classList.add('is-busy');

    const head = el('div', 'opt-dim-head');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = d.selectable && !deselectedDims.has(d.key);
    cb.disabled = !d.selectable || fixRunning;
    cb.addEventListener('change', () => {
      if (cb.checked) deselectedDims.delete(d.key);
      else deselectedDims.add(d.key);
      refreshFixButton();
    });
    head.appendChild(cb);

    head.appendChild(el('span', 'opt-dim-label', d.label));

    // analyzing / pending / disabled / error 用 reason 说明为什么没分，避免用户以为坏了；
    // partial 有分数但结论不完整，用 note 标注出来别让人当成可信分数
    const hintText = d.status === 'done' ? d.hint : (d.note || d.reason || d.hint);
    const hintEl = el('span', 'opt-dim-hint', progressText(d) || hintText);
    // 打上 data-dim：批级进度事件来得很频繁（每批一次），靠它定点改这一个节点，
    // 不必为每个进度事件重建全部 17 张卡片
    hintEl.dataset.dimHint = d.key;
    head.appendChild(hintEl);

    if (d.issueCount > 0) head.appendChild(el('span', 'opt-dim-badge', `${d.issueCount} 项`));
    // analyzing 时分数位换成转圈，等 SSE 送来结果再变成数字
    if (d.busy) head.appendChild(el('span', 'opt-dim-spin'));
    else head.appendChild(el('span', 'opt-dim-score', d.scoreText));

    // 点头部展开问题清单；勾选框自己的点击不该触发展开
    const expandable = d.issueCount > 0 || !!d.plan;
    head.addEventListener('click', (e) => {
      if (e.target === cb) return;
      if (expandable) card.classList.toggle('is-open');
    });

    card.appendChild(head);

    if (expandable) {
      const box = el('div', 'opt-issues');
      // 计划在前、逐条 issue 在后：计划是「先做哪件」，issue 是「哪里有问题」。
      // 反序会让用户先读完 17 条问题才看到该从哪下手
      if (d.plan) renderPlan(box, d.plan);
      if (d.issueCount > 0) renderIssues(box, d.issues);
      card.appendChild(box);
    }

    // 整体评估默认展开：它是「先看哪儿」的答案，要用户多点一下才看到就白搭了
    if (d.plan) card.classList.add('is-open');

    host.appendChild(card);
  }
}

function render() {
  renderScore(currentReport);
  renderDims(currentReport);
  refreshButtons();
}

const CHECKUP_LABEL = { posting: '体检中…', analyzing: 'AI 分析中…' };

function refreshButtons() {
  const check = $('#optRunCheckup');
  if (check) {
    check.disabled = !!checkupBusy || fixRunning;
    check.textContent = CHECKUP_LABEL[checkupBusy] || '体检';
  }
  refreshFixButton();
}

/** 当前生效的勾选：可选的维度减去用户主动取消的那些 */
function selectedKeys() {
  return dimListFrom(currentReport)
    .filter((d) => d.selectable && !deselectedDims.has(d.key))
    .map((d) => d.key);
}

function refreshFixButton() {
  const btn = $('#optFix');
  if (!btn) return;
  btn.disabled = !canFix({
    hasReport: !!currentReport,
    selected: selectedKeys(),
    running: fixRunning || !!checkupBusy,
  });
  // 三态文案收在 optimize-fix.logic.js 里（可单测），这里只负责取值
  btn.textContent = fixButtonLabel(fixRunning, checkupBusy);

  // 中高风险按钮与主按钮同一套可用性判据（同一个后端闸、同一批勾选），
  // 只是不共享「优化中」文案——两个按钮同时显示「优化中」会让人不知道在跑哪一档
  const elevated = $('#optFixElevated');
  if (elevated) {
    elevated.disabled = btn.disabled;
    elevated.textContent = '中高风险优化';
  }

  // 「停止」只在跑的时候露出来：没在跑时摆一个禁用的停止按钮纯属噪声。
  // 地图维度是全量生成，十几个模块可能跑十几分钟，必须给用户一个退出口。
  const cancel = $('#optFixCancel');
  if (!cancel) return;
  cancel.hidden = !fixRunning;
  if (!fixRunning) {
    cancel.disabled = false;
    cancel.textContent = '停止';
  }
}

/**
 * 落盘报告里残留的 analyzing 一律当「没跑完」处理。
 *
 * 正常路径下 analyzing 只是内存里的过渡态，每个维度落地都会立刻覆盖并落盘；
 * 只有服务在分析中途被杀才会把它留在 optimize.json 里。此时那次任务的 SSE 早已随进程消失，
 * 不改写的话卡片会永远转圈——转圈是「马上就有结果」的承诺，兑现不了就不该显示。
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
    deselectedDims = new Set();
    fixRunning = false;
    const progress = $('#optProgress');
    const result = $('#optResult');
    if (progress) { progress.textContent = ''; progress.hidden = true; }
    if (result) { result.textContent = ''; result.hidden = true; }
  }

  if (!dir) { currentReport = null; render(); return; }
  try {
    const r = await fetch(`/api/optimize/report?dir=${encodeURIComponent(dir)}`);
    const data = await r.json();
    currentReport = normalizeStaleReport(data.report);
    render();
    await resumeIfBusy(dir, data.busy);
    return;
  } catch {
    currentReport = null;
  }
  render();
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
    fixRunning = true;
    render();
    openFixStream(busy.jobId);
  }
}

function closeCheckupStream() {
  checkupBusy = '';
  dimProgress = new Map();
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

/** 同步目录按钮的文案：无目录给引导语；有目录显示全路径，超宽由 CSS 截断，title 兜住全路径 */
function refreshDirLabel() {
  const label = $('#optDirLabel');
  const btn = $('#optDirBtn');
  if (!label) return;
  label.textContent = currentDir || '选择项目目录';
  if (btn) btn.title = currentDir || '选择要体检的项目目录';
}

/** 应用一个新目录：落盘 lastDir + 刷新标签 + 拉该目录的历史报告 */
function applyDir(p) {
  currentDir = p || '';
  if (currentDir) lsSet('optimize.lastDir', currentDir);
  refreshDirLabel();
  loadReport(currentDir);
}

/**
 * 借用顶栏那套目录弹层。
 * 不能直接复用 chat 注入的 selectDir——它带「一窗一项目」逻辑，选不同目录会开新窗口。
 */
function pickDir() {
  openDirPickerFor({
    getCwd: () => currentDir,
    selectDir: applyDir,
  });
}

async function runCheckup() {
  const dir = currentDir;
  if (!dir) { toast.error('请先选择项目目录'); return; }

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
    lsSet('optimize.lastDir', dir);
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

// ==================== 一键优化 ====================

function closeFixStream() {
  fixJobId = null;
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
  if (!fixJobId) return;
  const btn = $('#optFixCancel');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '停止中…';
  }
  const { ok } = await postJson('/api/optimize/fix/cancel', { jobId: fixJobId });
  // 404 = 任务已经自己跑完了，这不是错误，照常收尾即可
  if (!ok && btn) btn.textContent = '停止';
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

/** 一条 key-value 行；value 为空就整行不渲染，避免结果区堆满空标签 */
function kv(box, label, value, valueClass) {
  if (value === null || value === undefined || value === '') return;
  const row = el('div', 'opt-kv');
  row.appendChild(el('span', 'opt-kv-k', label));
  row.appendChild(el('span', `opt-kv-v${valueClass ? ' ' + valueClass : ''}`, value));
  box.appendChild(row);
}

const STATUS_LABEL = { done: '已降级', skipped: '已跳过', failed: '失败' };

/**
 * 单个文件的处理结果。
 *
 * description 必须**全文**摊出来:它是这次操作里唯一「写砸了也不会报错、分数反而更好看」的产物
 * (规范搬进 skill 后能不能被唤起全看这一行字)。让用户当场看到并能立刻去改，
 * 是这个盲区唯一的兜底 —— 藏进文件里就等于没人会复核。
 */
function renderFileResult(host, r) {
  const card = el('div', `opt-res-file is-${r.status}`);

  const head = el('div', 'opt-res-head');
  head.appendChild(el('span', `opt-res-badge sev-${r.status}`, STATUS_LABEL[r.status] || r.status));
  head.appendChild(el('span', 'opt-res-file-name', r.file));
  // kind 必须露出来：不显示的话「重构了源码」和「只写了清单」在列表里长得一样，
  // 而这正是风险分级要让用户看清的东西
  if (r.kind) head.appendChild(el('span', 'opt-res-kind', kindLabel(r.kind)));
  card.appendChild(head);

  const body = el('div', 'opt-res-body');
  kv(body, '技能文件', r.skillFile);
  if (r.description) {
    kv(body, '技能描述', r.description, 'is-desc');
    // 兜底文案是机械拼的，唤起效果打折，必须显式提示复核
    if (r.descriptionSource === 'fallback') {
      kv(body, '⚠️ 提示', '这句描述是模板机械生成的（AI 未产出），建议打开上面的技能文件手工改写');
    }
  }
  if (r.refsUpdated?.length) kv(body, `已改写引用 ${r.refsUpdated.length} 处`, r.refsUpdated.join('、'));
  for (const f of r.refsFailed || []) kv(body, '⚠️ 引用未改成', `${f.path}：${f.reason}`);
  kv(body, '原因', r.reason);
  card.appendChild(body);

  host.appendChild(card);
}

function renderFixResult(done) {
  const host = $('#optResult');
  if (!host) return;
  host.textContent = '';
  host.hidden = false;

  if (done.error) {
    host.appendChild(el('div', 'opt-res-error', `优化失败：${done.error}`));
  }

  const results = done.results || [];
  const s = summarizeResults(results);
  const bar = el('div', 'opt-res-summary');
  bar.appendChild(el('span', 'opt-res-stat', s.text));
  if (s.refsTotal) bar.appendChild(el('span', 'opt-res-stat', `引用改写 ${s.refsTotal} 处`));
  if (s.refsFailedTotal) bar.appendChild(el('span', 'opt-res-stat is-warn', `${s.refsFailedTotal} 处未改成`));
  if (done.rules) {
    bar.appendChild(el('span', 'opt-res-stat', `规范加载方式 ${scoreDelta(done.rules.before, done.rules.after)}`));
  }
  host.appendChild(bar);

  for (const r of results) renderFileResult(host, r);

  // 被检测器挡下的项（如 R2_DEMOTE_UNCERTAIN）：没处理不代表没问题，要如实列出来
  for (const b of done.blocked || []) {
    host.appendChild(el('div', 'opt-res-note', `未自动处理 ${b.file}：${b.reason}`));
  }
  for (const n of done.notes || []) {
    host.appendChild(el('div', 'opt-res-note', n));
  }

  const foot = el('div', 'opt-res-foot');
  const recheck = el('button', 'btn', '重新体检');
  recheck.addEventListener('click', runCheckup);
  foot.appendChild(recheck);

  if (done.backupDir) {
    const rollback = el('button', 'btn danger', '还原本次优化');
    rollback.addEventListener('click', () => rollbackFix(done.backupDir));
    foot.appendChild(rollback);
  }
  host.appendChild(foot);
}

function openFixStream(jobId) {
  closeFixStream();
  const es = new EventSource(`/api/optimize/fix-stream?jobId=${encodeURIComponent(jobId)}`);
  fixStream = es;
  // closeFixStream 会把它清空，所以必须在它之后赋值
  fixJobId = jobId;

  const finish = (done) => {
    fixRunning = false;
    // 后端在优化结束时重算过静态维度，直接用它的报告，别让面板停在优化前的分数
    if (done?.report) currentReport = done.report;
    render();
    renderFixResult(done || {});
    closeFixStream();
  };

  // replay 必需：POST 返回到 EventSource 建起来之间有个窗口，
  // 期间产生的 step 事件不补就永远丢了（快的任务甚至整个跑完都在窗口里）
  es.addEventListener('replay', (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    for (const e of d.events || []) {
      if (e.event === 'step') appendProgress(e.data);
    }
    if (d.done) finish(d.done);
  });

  es.addEventListener('step', (ev) => {
    try { appendProgress(JSON.parse(ev.data)); } catch { /* 脏帧忽略 */ }
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
    fixRunning = false;
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
async function runFix({ risk = 'low', force = false } = {}) {
  const dir = currentDir;
  if (!dir) { toast.error('请先选择项目目录'); return; }

  fixRunning = true;
  render();
  $('#optProgress').textContent = '';
  $('#optProgress').hidden = true;
  $('#optResult').hidden = true;

  try {
    const { ok, data } = await postJson('/api/optimize/fix', {
      dir,
      dimensions: selectedKeys(),
      risk,
      force,
    });

    if (!ok) {
      fixRunning = false;
      render();
      // 409 = 串行闸挡下，多半是自己另开了一个标签页；带回来的 jobId 可以直接接上去看进度
      if (data.busy?.jobId) {
        toast.error('该项目已有一次优化在跑，已切换到它的进度');
        fixRunning = true;
        render();
        openFixStream(data.busy.jobId);
        return;
      }
      toast.error(data.error || '优化失败');
      return;
    }

    if (data.needsConfirm) {
      fixRunning = false;
      render();
      const go = await confirmDialog({
        title: '工作区有未提交的改动',
        message: dirtyConfirmMessage(data),
        confirmText: '仍然优化',
        danger: true,
      });
      // 必须把 risk 带下去：丢了它会让「确认后重试」降级成低风险，
      // 用户点的是中高风险按钮却只跑了低风险，而界面会说优化完成
      if (go) await runFix({ risk, force: true });
      return;
    }

    if (data.nothing) {
      fixRunning = false;
      render();
      renderFixResult({
        results: [],
        blocked: data.blocked,
        notes: [risk === 'low'
          ? '本轮（低风险）没有可自动处理的项。改文档与改源码的改动请点「中高风险优化」。'
          : '没有可自动优化的项。'],
      });
      return;
    }

    openFixStream(data.jobId);
  } catch (e) {
    fixRunning = false;
    render();
    toast.error('优化请求失败：' + (e?.message || e));
  }
}

/**
 * 中高风险优化的二次确认。
 *
 * 这个确认不是形式：它是用户唯一一次被明确告知「接下来会改既有文档与源码」的时机。
 * 文案要说清三件事——改什么、有什么兜底、出问题怎么办；只写「确定继续？」等于没确认。
 */
async function runElevatedFix() {
  const go = await confirmDialog({
    title: '中高风险优化',
    message: '接下来会「改动既有文件」：\n\n'
      + '· 改写既有文档（CLAUDE.md / README 等）\n'
      + '· 重构既有源码（复杂度 / 重复 / 死代码 / 错误处理 / 注释）\n'
      + '· 规则降级会删除规则文件并改写全仓引用\n\n'
      + '兜底：开工前会打全量快照；源码改动逐个文件跑测试，测试变红立即回滚该文件；'
      + '项目没有可跑的测试时，源码维度会自动降级为只出清单、不改代码。\n\n'
      + '出问题可以用「还原」撤销本次全部改动。',
    confirmText: '我了解，开始优化',
    danger: true,
  });
  if (go) await runFix({ risk: 'elevated' });
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
  render();
  $('#optResult').hidden = true;
  $('#optProgress').hidden = true;

  const skipped = data.skipped?.length || 0;
  toast.success(`已还原 ${data.restored} 个文件${skipped ? `，跳过 ${skipped} 个（优化后又被手工改过）` : ''}`);
}

export function initOptimizePanel() {
  if (!inited) {
    inited = true;
    $('#optRunCheckup')?.addEventListener('click', runCheckup);
    $('#optFix')?.addEventListener('click', () => runFix({ risk: 'low' }));
    $('#optFixElevated')?.addEventListener('click', runElevatedFix);
    $('#optFixCancel')?.addEventListener('click', cancelFix);
    $('#optDirBtn')?.addEventListener('click', pickDir);

    currentDir = lsGet('optimize.lastDir') || '';
  }

  refreshDirLabel(); // 面板每次打开都同步一次标签，避免 DOM 被重建后文案回退
  // switching:false —— 这是「重新打开面板」而不是「换项目」。传 true 会把正在跑的
  // 体检 / 优化的 SSE 退掉并清空 loading，而后端任务还在跑、串行闸还占着，
  // 用户回来就会看到「没有 loading 但点体检被拒」
  loadReport(currentDir, { switching: false });
}

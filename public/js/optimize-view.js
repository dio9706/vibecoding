/**
 * 项目优化面板：体检展示 + 一键优化。
 *
 * 安全约定：所有来自后端的文本一律 createElement + textContent 渲染，
 * 禁止 innerHTML 拼接（本项目硬性约定，因为渲染的是后端/LLM 产出的不可信文本）。
 */
import { $, lsGet, lsSet } from './util.js';
import { dimListFrom } from './optimize-view.logic.js';
import {
  canFix, fixButtonLabel, summarizeResults, scoreDelta, stepLabel, dirtyConfirmMessage,
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

function renderScore(report) {
  const ring = $('#optRing');
  const num = $('#optScoreNum');
  const grade = $('#optGrade');
  const count = $('#optIssueCount');
  const lastAt = $('#optLastAt');

  ring.className = 'opt-ring';
  if (!report || typeof report.score !== 'number') {
    num.textContent = '--';
    grade.textContent = '未体检';
    count.textContent = '';
    lastAt.textContent = '';
    return;
  }

  num.textContent = String(report.score);
  if (report.grade) ring.classList.add(`is-${report.grade}`);
  grade.textContent = GRADE_LABEL[report.grade] || '';
  count.textContent = `发现 ${report.issueCount} 项问题`;
  lastAt.textContent = `上次体检 ${new Date(report.at).toLocaleString()}`;
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

function renderDims(report) {
  const host = $('#optDims');
  host.textContent = '';

  for (const d of dimListFrom(report)) {
    const card = el('div', 'opt-dim');
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
    head.appendChild(el('span', 'opt-dim-hint', hintText));

    if (d.issueCount > 0) head.appendChild(el('span', 'opt-dim-badge', `${d.issueCount} 项`));
    // analyzing 时分数位换成转圈，等 SSE 送来结果再变成数字
    if (d.busy) head.appendChild(el('span', 'opt-dim-spin'));
    else head.appendChild(el('span', 'opt-dim-score', d.scoreText));

    // 点头部展开问题清单；勾选框自己的点击不该触发展开
    head.addEventListener('click', (e) => {
      if (e.target === cb) return;
      if (d.issueCount > 0) card.classList.toggle('is-open');
    });

    card.appendChild(head);

    if (d.issueCount > 0) {
      const box = el('div', 'opt-issues');
      renderIssues(box, d.issues);
      card.appendChild(box);
    }

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
  btn.textContent = fixButtonLabel(fixRunning);
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

async function loadReport(dir) {
  closeCheckupStream();
  closeFixStream();
  // 换目录 = 换项目，上一个项目的勾选和优化结果都不该跟过来
  deselectedDims = new Set();
  fixRunning = false;
  const progress = $('#optProgress');
  const result = $('#optResult');
  if (progress) { progress.textContent = ''; progress.hidden = true; }
  if (result) { result.textContent = ''; result.hidden = true; }

  if (!dir) { currentReport = null; render(); return; }
  try {
    const r = await fetch(`/api/optimize/report?dir=${encodeURIComponent(dir)}`);
    const data = await r.json();
    currentReport = normalizeStaleReport(data.report);
  } catch {
    currentReport = null;
  }
  render();
}

function closeCheckupStream() {
  checkupBusy = '';
  refreshButtons();
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
  refreshButtons();

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
    applyDimResult(d.key, d.result);
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
  refreshButtons();

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
    refreshButtons();
  }
}

// ==================== 一键优化 ====================

function closeFixStream() {
  if (!fixStream) return;
  fixStream.close();
  fixStream = null;
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

async function runFix(force = false) {
  const dir = currentDir;
  if (!dir) { toast.error('请先选择项目目录'); return; }

  fixRunning = true;
  refreshButtons();
  $('#optProgress').textContent = '';
  $('#optProgress').hidden = true;
  $('#optResult').hidden = true;

  try {
    const { ok, data } = await postJson('/api/optimize/fix', {
      dir,
      dimensions: selectedKeys(),
      force,
    });

    if (!ok) {
      fixRunning = false;
      refreshButtons();
      // 409 = 串行闸挡下，多半是自己另开了一个标签页；带回来的 jobId 可以直接接上去看进度
      if (data.busy?.jobId) {
        toast.error('该项目已有一次优化在跑，已切换到它的进度');
        fixRunning = true;
        refreshButtons();
        openFixStream(data.busy.jobId);
        return;
      }
      toast.error(data.error || '优化失败');
      return;
    }

    if (data.needsConfirm) {
      fixRunning = false;
      refreshButtons();
      const go = await confirmDialog({
        title: '工作区有未提交的改动',
        message: dirtyConfirmMessage(data),
        confirmText: '仍然优化',
        danger: true,
      });
      if (go) await runFix(true);
      return;
    }

    if (data.nothing) {
      fixRunning = false;
      refreshButtons();
      renderFixResult({ results: [], blocked: data.blocked, notes: ['没有可自动优化的项。'] });
      return;
    }

    openFixStream(data.jobId);
  } catch (e) {
    fixRunning = false;
    refreshButtons();
    toast.error('优化请求失败：' + (e?.message || e));
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
    $('#optFix')?.addEventListener('click', () => runFix(false));
    $('#optDirBtn')?.addEventListener('click', pickDir);

    currentDir = lsGet('optimize.lastDir') || '';
  }

  refreshDirLabel(); // 面板每次打开都同步一次标签，避免 DOM 被重建后文案回退
  loadReport(currentDir);
}

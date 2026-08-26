/**
 * 项目优化面板。阶段一只做体检展示，一键优化按钮保持禁用。
 *
 * 安全约定：所有来自后端的文本一律 createElement + textContent 渲染，
 * 禁止 innerHTML 拼接（本项目硬性约定，因为渲染的是后端/LLM 产出的不可信文本）。
 */
import { $, lsGet, lsSet } from './util.js';
import { dimListFrom } from './optimize-view.logic.js';
import { openDirPickerFor } from './dir-popover.js';
import toast from './toast.js';

let inited = false;
let currentReport = null;
/** 当前选中的体检目录。单例状态而非从 DOM 读——选择器已改成弹层式按钮，没有可读的 input */
let currentDir = '';
/** 正在接收 LLM 维度回填的 SSE 连接；同一时刻只允许一条 */
let checkupStream = null;

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
    cb.checked = d.selectable; // 默认全选（可选的才选中）
    cb.disabled = !d.selectable;
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

  const btn = $('#optRunCheckup');
  btn.disabled = true;
  btn.textContent = '体检中…';

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
    btn.disabled = false;
    btn.textContent = '体检';
  }
}

export function initOptimizePanel() {
  if (!inited) {
    inited = true;
    $('#optRunCheckup')?.addEventListener('click', runCheckup);
    $('#optDirBtn')?.addEventListener('click', pickDir);

    currentDir = lsGet('optimize.lastDir') || '';
  }

  refreshDirLabel(); // 面板每次打开都同步一次标签，避免 DOM 被重建后文案回退
  loadReport(currentDir);
}

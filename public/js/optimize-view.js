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

    const head = el('div', 'opt-dim-head');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = d.selectable; // 默认全选（可选的才选中）
    cb.disabled = !d.selectable;
    head.appendChild(cb);

    head.appendChild(el('span', 'opt-dim-label', d.label));

    // pending / disabled 用 reason 说明为什么没分，避免用户以为坏了
    head.appendChild(el('span', 'opt-dim-hint', d.status === 'done' ? d.hint : (d.reason || d.hint)));

    if (d.issueCount > 0) head.appendChild(el('span', 'opt-dim-badge', `${d.issueCount} 项`));
    head.appendChild(el('span', 'opt-dim-score', d.scoreText));

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

async function loadReport(dir) {
  if (!dir) { currentReport = null; render(); return; }
  try {
    const r = await fetch(`/api/optimize/report?dir=${encodeURIComponent(dir)}`);
    const data = await r.json();
    currentReport = data.report;
  } catch {
    currentReport = null;
  }
  render();
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
    currentReport = data.report;
    lsSet('optimize.lastDir', dir);
    render();
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

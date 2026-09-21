/**
 * 修复报告弹窗。
 *
 * ## 为什么不扩展 ui.js 的 confirmDialog
 *
 * 那是「纯文本 message + 两个按钮」的原语，它的 message 走 textContent，
 * 天然渲染不了分组列表。把富结构塞进去会让它变成胖接口，而它被全项目十几处复用。
 * 这里只复用它的 `.mask` / `.modal` **CSS**，JS 独立。
 *
 * ## 安全
 *
 * 全部内容来自后端与模型（文件路径、失败原因、模块职责），一律
 * createElement + textContent —— 本项目硬性约定，禁裸 innerHTML。
 */

import { kindLabel, summarizeResults, scoreDelta } from './optimize-fix.logic.js';

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

const STATUS_LABEL = { done: '已处理', skipped: '已跳过', failed: '失败' };

/** 一个小节；rows 为空就整节不渲染，避免报告里堆满空标题 */
function section(title, rows) {
  if (!rows.length) return null;
  const sec = el('div', 'opt-report-sec');
  sec.appendChild(el('h4', null, title));
  for (const r of rows) sec.appendChild(r);
  return sec;
}

/** ① 改了什么：按动作分组，让「重构了源码」和「只写了清单」一眼可分 */
function changeRows(results) {
  const byKind = new Map();
  for (const r of results) {
    const k = r?.kind || '其它';
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(r);
  }

  const rows = [];
  for (const [kind, list] of byKind) {
    // 文案走 optimize-fix.logic.js 的 kindLabel：那是既有的唯一来源，
    // 在这里另写一份必然与它漂移
    rows.push(el('div', 'opt-report-group', `${kindLabel(kind)}（${list.length}）`));
    for (const r of list) {
      const row = el('div', 'opt-report-row');
      row.appendChild(el('span', `opt-res-badge sev-${r.status}`, STATUS_LABEL[r.status] || r.status));
      row.appendChild(el('span', 'opt-plan-loc', r.file || ''));
      if (r.reason) {
        const why = el('span', 'opt-plan-msg', r.reason);
        why.title = r.reason;
        row.appendChild(why);
      }
      rows.push(row);
    }
  }
  return rows;
}

/** ② 需要复测：规则化产出，地图缺失的目录只列文件不编职责 */
function retestRows(retest) {
  return (retest || []).map((m) => {
    const box = el('div', 'opt-report-block');
    box.appendChild(el('div', 'opt-report-dir', m.dir));
    if (m.responsibility) box.appendChild(el('div', 'opt-report-resp', m.responsibility));
    box.appendChild(el('div', 'opt-report-resp', (m.files || []).join('、')));
    return box;
  });
}

/**
 * 弹出修复报告。
 *
 * @param {object} done 后端 done 事件的负载
 * @param {object} [handlers]
 * @param {Function} [handlers.onRollback] 还原本次优化，收到 backupDir
 * @param {Function} [handlers.onRecheck]  重新体检
 */
export function openFixReport(done, { onRollback, onRecheck } = {}) {
  const mask = el('div', 'mask');
  const modal = el('div', 'modal opt-report-modal');

  const head = el('div', 'head');
  head.appendChild(el('h3', null, '修复报告'));
  const closeBtn = el('button', 'close', '✕');
  head.appendChild(closeBtn);
  modal.appendChild(head);

  const body = el('div', 'body');

  if (done.error) {
    body.appendChild(el('div', 'opt-report-error', `修复过程报错：${done.error}`));
  }
  if (done.cancelled) {
    body.appendChild(el('div', 'opt-report-note', '本次修复被中止，已完成的改动保留，可用下方「还原本次优化」撤销。'));
  }

  // 汇总行：成功/跳过/失败，以及「引用未改成」这类必须显式告知的计数。
  // 复用 summarizeResults —— 它已经处理过 refsFailed 是数组而非数字这类坑
  const results = done.results || [];
  if (results.length) {
    const s = summarizeResults(results);
    const bar = el('div', 'opt-report-row');
    bar.appendChild(el('span', 'opt-report-dir', s.text));
    if (s.refsTotal) bar.appendChild(el('span', null, `引用改写 ${s.refsTotal} 处`));
    // 未改成的引用会在文档里留下指向已删除文件的路径，不说用户永远不会去修
    if (s.refsFailedTotal) bar.appendChild(el('span', 'opt-report-error', `${s.refsFailedTotal} 处未改成`));
    if (done.rules) bar.appendChild(el('span', null, `规范加载方式 ${scoreDelta(done.rules.before, done.rules.after)}`));
    body.appendChild(bar);
  }

  const sChange = section(results.length ? `改动了 ${results.length} 处` : '本次没有改动', changeRows(results));
  if (sChange) body.appendChild(sChange);

  const sRetest = section('需要复测', retestRows(done.retest));
  if (sRetest) body.appendChild(sRetest);

  // ③ 未处理的：blocked 与 notes 都是「不说就会被误以为已处理好」的内容，
  // 必须进报告——它们原先只在内联结果区，关掉就再也看不到了
  const noteRows = [];
  for (const b of done.blocked || []) {
    noteRows.push(el('div', 'opt-report-note', `未自动处理 ${b.file}：${b.reason}`));
  }
  for (const n of done.notes || []) {
    noteRows.push(el('div', 'opt-report-note', n));
  }
  const sNotes = section('需要你知道', noteRows);
  if (sNotes) body.appendChild(sNotes);

  // 分数没重算这件事必须说：用户刚看完一份「改了 12 处」的报告，
  // 回到面板看到分数没动，不解释就会以为哪里坏了
  body.appendChild(el('div', 'opt-report-note',
    '分数与问题数仍是修复前的值 —— 修复不会重算它们，重新体检才会更新。'));

  modal.appendChild(body);

  const foot = el('div', 'opt-report-foot');
  if (done.backupDir && onRollback) {
    const rb = el('button', 'btn danger', '还原本次优化');
    rb.addEventListener('click', () => { close(); onRollback(done.backupDir); });
    foot.appendChild(rb);
  }
  if (onRecheck) {
    const rc = el('button', 'btn', '重新体检');
    rc.addEventListener('click', () => { close(); onRecheck(); });
    foot.appendChild(rc);
  }
  const ok = el('button', 'btn primary', '关闭');
  foot.appendChild(ok);
  modal.appendChild(foot);

  mask.appendChild(modal);
  document.body.appendChild(mask);

  function onKey(e) { if (e.key === 'Escape') close(); }
  function close() {
    mask.remove();
    document.removeEventListener('keydown', onKey);
  }

  closeBtn.addEventListener('click', close);
  ok.addEventListener('click', close);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  document.addEventListener('keydown', onKey);
}

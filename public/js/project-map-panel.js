/** 项目地图弹框：检查是否已生成 → 展示生成入口或地图摘要。 */
import { $ } from './util.js';

let inited = false;

function getMask() { return document.getElementById('projectMapMask'); }
function getBody() { return document.getElementById('projectMapBody'); }

/** 从 dirLabel 的 title 属性读取当前工作目录（chat.js 写入） */
function getDir() {
  const title = document.getElementById('dirLabel')?.title || '';
  return (title && title !== '(服务所在目录)') ? title : '';
}

function closeMask() {
  const m = getMask();
  if (m) m.hidden = true;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function load() {
  const b = getBody();
  if (!b) return;
  const dir = getDir();
  if (!dir) {
    b.innerHTML = '<div class="pm-empty"><div class="pm-empty-text">请先在顶栏选择工作目录</div></div>';
    return;
  }
  b.innerHTML = '<div class="pm-empty"><div class="pm-empty-text">加载中…</div></div>';
  try {
    const r = await fetch(`/api/project-map/get?dir=${encodeURIComponent(dir)}`);
    if (r.status === 404) {
      renderNotGenerated(dir);
    } else if (r.ok) {
      renderMap(await r.json());
    } else {
      b.innerHTML = `<div class="pm-empty"><div class="pm-empty-text">加载失败（${r.status}）</div></div>`;
    }
  } catch (e) {
    b.innerHTML = `<div class="pm-empty"><div class="pm-empty-text">加载失败：${esc(e.message)}</div></div>`;
  }
}

function renderNotGenerated(dir) {
  const b = getBody();
  b.innerHTML = `
    <div class="pm-empty">
      <div class="pm-empty-icon">🗺️</div>
      <div class="pm-empty-text">该项目尚未生成地图</div>
      <div class="pm-empty-sub">${esc(dir)}</div>
      <button class="btn primary" id="pmGenBtn">生成项目地图</button>
    </div>
  `;
  document.getElementById('pmGenBtn')?.addEventListener('click', () => startGenerate(dir));
}

function renderMap(map) {
  const b = getBody();
  const modules = map.modules || [];
  b.innerHTML = `
    <div class="pm-summary">
      <div class="pm-summary-line">
        <span class="pm-summary-label">项目路径</span>
        <span class="pm-summary-value pm-summary-path">${esc(map.projectPath || '')}</span>
      </div>
      <div class="pm-summary-line">
        <span class="pm-summary-label">模块数</span>
        <span class="pm-summary-value">${modules.length} 个</span>
      </div>
      <div class="pm-summary-line">
        <span class="pm-summary-label">生成时间</span>
        <span class="pm-summary-value">${map.generatedAt ? new Date(map.generatedAt).toLocaleString('zh-CN') : '—'}</span>
      </div>
    </div>
    <div class="pm-regen-bar">
      <button class="btn" id="pmRegenBtn">重新生成</button>
    </div>
    <ul class="pm-module-list">
      ${modules.map((m) => `
        <li class="pm-module-item">
          <span class="pm-mod-name">${esc(m.name || m.id || '')}</span>
          <span class="pm-mod-path">${esc(m.path || '')}</span>
          ${m.description ? `<span class="pm-mod-desc">${esc(m.description)}</span>` : ''}
        </li>
      `).join('')}
    </ul>
  `;
  document.getElementById('pmRegenBtn')?.addEventListener('click', () => {
    startGenerate(map.projectPath || getDir());
  });
}

async function startGenerate(dir) {
  const b = getBody();
  if (!b) return;
  b.innerHTML = `
    <div class="pm-empty">
      <div class="pm-empty-icon">⚙️</div>
      <div class="pm-empty-text" id="pmGenStatus">正在请求生成…</div>
    </div>
  `;

  let jobId;
  try {
    const r = await fetch('/api/project-map/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 409 || r.status === 202 || r.ok) {
      jobId = d.jobId;
    } else {
      setStatus(`生成请求失败：${d.error || r.status}`, true);
      return;
    }
  } catch (e) {
    setStatus(`网络错误：${esc(e.message)}`, true);
    return;
  }

  setStatus('连接进度流…');

  const es = new EventSource(`/api/project-map/generate-stream?jobId=${encodeURIComponent(jobId)}`);

  // replay：任务已存在时先推全量历史；直接判断是否已完成
  es.addEventListener('replay', (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.status === 'done') {
        es.close();
        if (d.done?.ok) load();
        else setStatus(`生成失败：${esc(d.done?.error || '未知错误')}`, true);
      } else if (d.events?.length) {
        // 显示最新的 step 消息
        const last = [...d.events].reverse().find((ev) => ev.event === 'step');
        if (last?.data?.detail) setStatus(last.data.detail);
      }
    } catch {}
  });

  es.addEventListener('step', (e) => {
    try {
      const d = JSON.parse(e.data);
      setStatus(d.detail || d.stage || '处理中…');
    } catch {}
  });

  es.addEventListener('done', (e) => {
    es.close();
    try {
      const d = JSON.parse(e.data);
      if (d.ok) load();
      else setStatus(`生成失败：${esc(d.error || '未知错误')}`, true);
    } catch {
      load();
    }
  });

  // SSE 连接本身断开（非应用 error 事件）
  es.onerror = () => {
    es.close();
    setStatus('连接中断，请重试', true);
  };
}

function setStatus(msg, withRetry = false) {
  const el = document.getElementById('pmGenStatus');
  if (el) el.textContent = msg;
  if (withRetry) {
    const b = getBody();
    if (b && !b.querySelector('#pmRetryBtn')) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.id = 'pmRetryBtn';
      btn.textContent = '重试';
      btn.addEventListener('click', load);
      b.querySelector('.pm-empty')?.appendChild(btn);
    }
  }
}

function initOnce() {
  if (inited) return;
  inited = true;
  document.getElementById('projectMapClose')?.addEventListener('click', closeMask);
  // 点遮罩背景关闭
  getMask()?.addEventListener('click', (e) => { if (e.target === getMask()) closeMask(); });
}

export function openProjectMapPanel() {
  initOnce();
  const m = getMask();
  if (!m) return;
  m.hidden = false;
  load();
}

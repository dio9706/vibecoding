/**
 * 需求地图浮层 —— 开发/测试期从右栏打开地图的容器。
 *
 * 单独成文件是为了断依赖环：req-chat 要打开地图，而地图里触发 UI 还原又要往会话发消息
 *（chat.js）。这里做中转，req-map.js 本身不认识 req-chat。
 */
import { mountMap } from './req-map.js';
import { sendMessageProgrammatically } from './chat.js';

let openEl = null; // 同时只允许一个浮层，重复点击直接复用

export async function openMapOverlay({ reqId, phase }) {
  if (openEl) return;
  const mask = document.createElement('div');
  mask.className = 'mask rq-map-mask';
  mask.innerHTML =
    '<div class="rq-map-overlay">' +
    '<div class="rq-map-obar"><b>需求地图</b><span class="rq-map-osub"></span>' +
    '<button class="btn rq-map-close">✕ 关闭</button></div>' +
    '<div class="rq-map-obody"></div>' +
    '</div>';
  document.body.appendChild(mask);
  openEl = mask;

  const close = () => {
    document.removeEventListener('keydown', onKey);
    mask.remove();
    openEl = null;
  };
  // Esc 交给地图内部优先处理（关抽屉）；抽屉已关时才关浮层
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    const drawer = mask.querySelector('.rq-drawer');
    if (drawer && !drawer.hidden) return;
    close();
  };
  document.addEventListener('keydown', onKey);
  mask.querySelector('.rq-map-close').addEventListener('click', close);

  const body = mask.querySelector('.rq-map-obody');
  body.textContent = '加载中…';
  try {
    const r = await fetch('/api/req/map?id=' + encodeURIComponent(reqId));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '读取失败');
    body.textContent = '';
    const versions = d.versions || [];
    mask.querySelector('.rq-map-osub').textContent =
      versions.length ? 'v' + versions[versions.length - 1].v + ' · 共 ' + versions.length + ' 版' : '';
    mountMap(body, {
      reqId,
      phase,
      map: d.map,
      versions,
      onRestore: (prompt) => {
        close(); // 还原消息要发进聊天区，浮层挡着就看不到执行过程
        sendMessageProgrammatically(prompt, { mode: 'bypassPermissions' });
      },
    });
  } catch (e) {
    body.textContent = '地图加载失败：' + (e?.message || e);
  }
}

/** 启动闸门：轮询 /api/ping 等后端就绪，期间全屏 loading 罩住 UI；就绪后撤罩并放行启动初始化。
 *  背景：桌面版 webview 从 tauri.localhost 加载（页面秒开），Node 后端却要冷启动数秒——
 *  这段窗口里所有按钮的 fetch 必然失败，表现为「界面能点但什么都没反应」。
 *  必须在 bootstrap.js 之后 import：依赖其 fetch 补丁把相对路径改写到桌面版实际端口。 */

const PING_TIMEOUT_MS = 1500; // 单次探测超时：冷启动时端口可能已 accept 但迟迟不响应
const RETRY_GAP_MS = 400;
const SLOW_HINT_MS = 6000; // 超过此时长换「较慢」文案
const SKIP_BTN_MS = 20000; // 超过此时长给「仍然进入」逃生口
const HARD_GIVEUP_MS = 90000; // 兜底放行：避免后端永久不通时卡死在罩子里（放行后各请求自行失败/自愈）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _promise = null;
let _handoff = null;

/** 注册撤罩接管者：boot-gate 在撤罩前 await 它，返回 true 表示接管
 *  （罩子不 hide/remove，生命周期移交给接管者）。
 *  新用户引导用这个复用启动罩，避免另起一个 overlay 导致 LOGO 卸载重建闪断。
 *  必须在 whenBackendReady() 被调用前注册。 */
export function setOverlayHandoff(fn) {
  _handoff = fn;
}

/** 后端就绪（或用户跳过 / 兜底超时）后 resolve。幂等：多次调用共用同一次探测。 */
export function whenBackendReady() {
  if (!_promise) _promise = _run();
  return _promise;
}

async function ping() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PING_TIMEOUT_MS);
  try {
    // __skipGuard：本次失败不上报给 net-guard。启动期后端本来就还没起来，
    // 不排除会让掉线罩和启动罩同时升起打架。
    // 注意仍然走包装后的 fetch —— 打包态下这个相对路径必须被改写成
    // API_BASE + '/api/ping' 才打得到实际端口（bootstrap.js 的 URL 改写分支）。
    const r = await fetch('/api/ping', { signal: ac.signal, cache: 'no-store', __skipGuard: true });
    return r.ok;
  } catch {
    return false; // 后端未起 / 超时 / 端口未就绪
  } finally {
    clearTimeout(timer);
  }
}

async function _run() {
  const overlay = document.getElementById('bootOverlay');
  const textEl = document.getElementById('bootText');
  const skipEl = document.getElementById('bootSkip');

  let skipped = false;
  if (skipEl) skipEl.addEventListener('click', () => { skipped = true; });

  const t0 = Date.now();
  let stage = 0; // 0=初始 1=已提示较慢，避免每轮重复写 DOM
  while (true) {
    // 与超时赛跑：桌面版的 fetch 被 bootstrap 包过一层（内部 await 端口就绪），
    // 万一那层永不 settle，AbortController 也管不到——这里保证每轮必定收敛，
    // 否则「较慢」提示和「仍然进入」按钮永远等不到显示。
    const alive = await Promise.race([ping(), sleep(PING_TIMEOUT_MS + 200).then(() => false)]);
    if (alive) {
      console.log('[Boot] 后端就绪，耗时', Date.now() - t0, 'ms');
      break;
    }
    if (skipped) {
      console.warn('[Boot] 用户选择跳过等待，后端可能仍未就绪');
      break;
    }
    const elapsed = Date.now() - t0;
    if (elapsed > HARD_GIVEUP_MS) {
      console.error('[Boot] 等待后端超过', HARD_GIVEUP_MS, 'ms，兜底放行');
      break;
    }
    if (elapsed > SLOW_HINT_MS && stage === 0) {
      stage = 1;
      if (textEl) textEl.textContent = '后端启动较慢，正在重试连接…';
    }
    if (elapsed > SKIP_BTN_MS && skipEl && skipEl.hidden) skipEl.hidden = false;
    await sleep(RETRY_GAP_MS);
  }

  // 撤罩前问一句有没有人接管（新用户引导要原地复用这个罩子）。
  // 接管者抛异常也照常撤罩：引导炸了顶多没引导，把用户永久锁在罩子里是另一个量级的故障。
  if (_handoff) {
    let taken = false;
    try {
      taken = await _handoff(overlay);
    } catch (e) {
      console.error('[Boot] 撤罩接管者异常，照常撤罩', e);
    }
    if (taken) {
      console.log('[Boot] 启动罩已移交接管者');
      return;
    }
  }

  if (overlay) {
    overlay.classList.add('hide');
    // 与 .boot-overlay.hide 的 opacity 过渡时长对齐；移除而非仅隐藏，避免残留罩子吃点击
    setTimeout(() => overlay.remove(), 320);
  }
}

/** API 基址引导：Tauri 打包模式端口探测 + fetch/EventSource 相对路径补丁。必须最先 import。 */
import { reportNetworkFailure } from './net-guard.js';
import { classifyFetchRejection } from './net-error.js';
      // ============================================================
      // API 基址：桌面版（打包 release）后端端口由 Rust 动态探测后经
      // `backend_port` Tauri 命令告知前端；web / tauri dev 模式走相对路径。
      //
      // 三种模式：
      //   1. 打包 release：webview 源 tauri.localhost（hostname 非 127.x）
      //      → invoke('backend_port') 拿实际端口（默认 9701，冲突时自动 +1）
      //   2. tauri dev：devUrl=http://127.0.0.1:9701，同源相对路径可达后端
      //      → API_BASE = ''，不改写
      //   3. 浏览器直访：__TAURI_INTERNALS__ 未定义，相对路径可达后端
      //      → API_BASE = ''，不改写
      //
      // 需要后端已设置 CORS 头（server.js 已加）。必须早于所有请求执行。
      // ============================================================

      // ── 诊断日志（帮助排查前后端连接问题）──────────────────────────
      console.log('[Diag] app.js 开始执行，时间:', new Date().toISOString());
      console.log('[Diag] location.href:', window.location.href);
      console.log('[Diag] location.hostname:', window.location.hostname);
      console.log('[Diag] __TAURI_INTERNALS__ 存在:', typeof window.__TAURI_INTERNALS__ !== 'undefined');
      console.log('[Diag] __TAURI__ 存在:', typeof window.__TAURI__ !== 'undefined');

      const _isTauriPackaged = typeof window.__TAURI_INTERNALS__ !== 'undefined'
          && !window.location.hostname.startsWith('127.');

      console.log('[Diag] _isTauriPackaged:', _isTauriPackaged,
        '（__TAURI_INTERNALS__:', typeof window.__TAURI_INTERNALS__ !== 'undefined',
        '，hostname:', window.location.hostname, '）');

      // API_BASE：null = 尚未就绪；'' = web/dev 模式（相对路径）；字符串 = 桌面 release 基址
      export let API_BASE = _isTauriPackaged ? null : '';

      console.log('[Diag] 初始 API_BASE:', API_BASE);

      // baseReady：Tauri release 模式下异步向 Rust 询问实际端口；其它模式立即 resolve
      const _invoke = _isTauriPackaged
          ? (window.__TAURI__?.core?.invoke ?? ((cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args)))
          : null;

      if (_isTauriPackaged) {
        console.log('[Diag] 正在 invoke backend_port...');
      }

      const baseReady = _isTauriPackaged
          ? _invoke('backend_port')
              .then(p => {
                  console.log('[Diag] backend_port 返回端口:', p);
                  if (!p || p === 0) {
                    console.error('[Diag] ⚠️ backend_port 返回了无效端口', p, '，回退到 9701');
                    API_BASE = 'http://127.0.0.1:9701';
                  } else {
                    API_BASE = `http://127.0.0.1:${p}`;
                  }
                  console.log('[Diag] API_BASE 已设为:', API_BASE);
                  // 立即探一次连通性
                  // __skipGuard：这是打包态刚拿到端口后的连通性探测，此刻 Node sidecar
                  // 往往还在冷启动，失败是常态而非掉线。不旁路会让掉线罩盖在启动罩上。
                  fetch(API_BASE + '/api/ping', { __skipGuard: true }).then(r => r.json()).then(d => {
                    console.log('[Diag] /api/ping 成功:', d);
                  }).catch(e => {
                    console.error('[Diag] ⚠️ /api/ping 失败（后端可能未就绪）:', e.message);
                  });
              })
              .catch(e => {
                  console.error('[Diag] backend_port invoke 异常:', e);
                  console.warn('[API_BASE] backend_port invoke failed, falling back to 9701');
                  API_BASE = 'http://127.0.0.1:9701';
                  console.log('[Diag] API_BASE 回退为:', API_BASE);
              })
          : Promise.resolve();

      // ── fetch 包装：无条件安装 ────────────────────────────────────
      // 原先只在打包态装（为了改写相对路径）。改为无条件装，是为了让「网络层失败」
      // 在所有模式下都能被分类：不分类的话全项目几十处 fetch 的 catch 拿到的都是
      // 浏览器原文 `Failed to fetch`，被拼进业务文案后把系统故障说成功能故障
      //（req-chat.js 的「API 文档上传失败：Failed to fetch」就是这么来的）。
      // 守卫 typeof window.fetch：jsdom 不实现 window.fetch（undefined），测试用的是
      // globalThis.fetch。改动前这行在 if (_isTauriPackaged) 里、测试态恒假所以永不求值；
      // 无条件化之后若不守卫，.bind 作用在 undefined 上会在**模块加载期**直接抛，
      // 把整条 import 链带崩（offline-overlay.test.js 的 5 个用例就是这么全挂的）。
      // 测试态不装包装，恰好与「测试走 globalThis.fetch」的既有隔离一致；
      // 真实浏览器里 window.fetch 必然存在，运行时行为不受影响。
      if (typeof window.fetch !== 'function') {
        // 真实浏览器里不该发生。若真发生，打包态会**静默**丢掉相对路径改写
        //（所有 /api/* 请求打到 tauri.localhost 而非后端端口），比直接抛错更难查，
        // 所以至少留一行痕迹。jsdom 测试环境走这条是预期的。
        console.warn('[Diag] window.fetch 不可用，跳过 fetch 包装（URL 改写与掉线守卫均不生效）');
      } else {
        const _origFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          let url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
          if (_isTauriPackaged) {
            // 等端口就绪后再改写相对路径（对调用方透明，fetch 本就返回 Promise）
            const base = API_BASE ?? (await baseReady, API_BASE);
            if (typeof input === 'string' && input.startsWith('/')) {
              input = base + input;
            } else if (input instanceof Request && input.url.startsWith('/')) {
              input = new Request(base + input.url, input);
            }
            console.debug('[Diag] fetch ->', typeof input === 'string' ? input : url, 'API_BASE=', base);
          }
          try {
            return await _origFetch(input, init);
          } catch (e) {
            // 只有 reject 路径才在这里。resolve 但 !r.ok 的业务错误一律不碰 ——
            // 那种情况后端是活着的，不该升掉线罩。
            // 分类规则本身在 net-error.js（纯函数，可单测；这里的包装在 jsdom 下不安装）。
            const { report, error } = classifyFetchRejection(e, init);
            if (report) reportNetworkFailure();
            throw error;
          }
        };
      }

      if (_isTauriPackaged) {
        // EventSource 构造器同步，无法内部 await；
        // 约束：所有 EventSource 创建均发生在 await baseReady 之后（run 流式连接在引导后，天然满足）。
        const _OrigES = window.EventSource;
        const PatchedES = function (url, cfg) {
          if (API_BASE === null) console.warn('[EventSource] API_BASE not ready yet, url may be wrong:', url);
          const base = API_BASE || 'http://127.0.0.1:9701';
          if (typeof url === 'string' && url.startsWith('/')) {
            console.debug('[Diag] EventSource ->', base + url);
            url = base + url;
          }
          return new _OrigES(url, cfg);
        };
        PatchedES.prototype = _OrigES.prototype;
        PatchedES.CONNECTING = _OrigES.CONNECTING;
        PatchedES.OPEN = _OrigES.OPEN;
        PatchedES.CLOSED = _OrigES.CLOSED;
        window.EventSource = PatchedES;
      } else {
        console.log('[Diag] 非打包模式（web/tauri dev），使用相对路径，API_BASE=""');
        // 非打包模式也探一下。带 __skipGuard：启动期后端可能还没起来，
        // 这条诊断请求的失败不该升掉线罩。
        fetch('/api/ping', { __skipGuard: true }).then(r => r.json()).then(d => {
          console.log('[Diag] /api/ping (相对路径) 成功:', d);
        }).catch(e => {
          console.error('[Diag] ⚠️ /api/ping (相对路径) 失败（后端未就绪？）:', e.message);
        });
      }

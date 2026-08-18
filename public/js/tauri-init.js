/** Tauri API 异步初始化：产出 window.tauriApi / window.notifyUser（非 Tauri 环境为降级实现）。 */
import { API_BASE } from './bootstrap.js';
import toastApi from './toast.js';

// 视图桥：托盘导航 / 通知点击需要跳视图、开会话，但 showView 在 app.js、openConv 在 chat.js 的
// 模块作用域里，本模块拿不到（同 bindTasksNav 的做法，避免反向依赖）。由 app.js 注入。
const _nav = { showView: null, openConv: null };
export function bindTauriNav({ showView, openConv }) {
  _nav.showView = showView || null;
  _nav.openConv = openConv || null;
}

      // ============================================================
      // Tauri API 初始化
      // ============================================================

      // 异步加载 Tauri API（从 CDN）
      (async () => {
        try {
          // 检测是否在 Tauri 环境中运行
          // __TAURI_INTERNALS__ 在 Tauri v2 webview 中始终存在，比 __TAURI__ 更可靠
          const isTauri = typeof window.__TAURI_INTERNALS__ !== 'undefined';

          if (isTauri) {
            // ── invoke：同步获取，绝不依赖远程 CDN ──────────────────
            //    优先用 withGlobalTauri 注入的 window.__TAURI__.core.invoke；
            //    退化到 webview 中始终存在的 __TAURI_INTERNALS__.invoke。
            //    这样即使离线 / CDN 被墙，窗口拖拽与最小化/最大化/关闭也可用。
            const invoke = window.__TAURI__?.core?.invoke
              ?? ((cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args));

            // event / opener：优先全局，其次从随包 vendor 兜底加载（失败不影响窗口控制）
            let event = window.__TAURI__?.event ?? null;
            // shell.open 自 tauri-plugin-shell 2.1.0 起废弃，且其 scope 正则只认 URL，
            // 本地路径必然被拒（这就是「打开失败：未知错误」的成因）。改用 opener：
            // revealItemInDir 走系统文件管理器定位，不执行目标文件，无 RCE 面。
            let revealPath = null;
            let openUrl = null;
            try {
              // 一律走随包 vendor，不再从 jsdelivr 动态 import。
              // 原因有二：① 供应链——CDN 投毒/DNS 劫持/企业 MITM 任一成立，攻击者的 JS
              //   就在 webview 里运行，配合 shell 能力即完整 RCE；② 可用性——离线/CDN 被墙时
              //   这里静默降级，event 为 null，托盘导航与后端就绪事件全部失效（此前一直如此）。
              // vendor 产物在 public/vendor/tauri/（含 api-core 与 tslib，import 已改写为相对路径）。
              if (!event) {
                event = await import('/vendor/tauri/api-event.js');
              }
              const opener = await import('/vendor/tauri/plugin-opener.js');
              revealPath = opener.revealItemInDir;
              openUrl = opener.openUrl;
            } catch (e) {
              console.warn('[App] 可选 Tauri 模块 (event/opener) 本地加载失败，不影响窗口控制:', e?.message);
            }

            // 全局 Tauri 实例暴露给前端业务逻辑
            window.tauriApi = {
              isTauri: true,
              invoke,
              event,
              revealPath,
              openUrl,
            };

            console.log('[App] Tauri environment detected and initialized');

            // ── 全局超链接拦截：强制用系统浏览器打开，防止 WebView 内导航 ──────────
            // 捕获阶段拦截所有 <a> 点击；仅处理 http/https 外链，内部资源放行
            document.addEventListener('click', (e) => {
              const anchor = e.target.closest('a[href]');
              if (!anchor) return;
              const href = anchor.getAttribute('href');
              if (!href) return;
              let url;
              try { url = new URL(href, window.location.href); } catch { return; }
              // 只拦截 http / https 协议
              if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
              // 放行对本机后端的请求（127.0.0.1 / localhost）
              if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return;
              // 拦截外链：阻止 WebView 导航，改为系统浏览器打开
              e.preventDefault();
              e.stopImmediatePropagation();
              if (openUrl) {
                openUrl(url.href).catch((err) => {
                  console.warn('[App] opener.openUrl failed, fallback to invoke:', err);
                  invoke('plugin:opener|open_url', { url: url.href }).catch(console.error);
                });
              } else {
                // vendor 加载失败时直接 invoke opener 插件命令
                invoke('plugin:opener|open_url', { url: url.href }).catch(console.error);
              }
            }, true); // true = 捕获阶段，确保在子元素 handler 前拦截

            // ── 桌面 tab 在设置中显示 ─────────────────────────────
            // autostartToggle 已移至基础 tab，显示其父容器
            const basicAutostartSec = document.getElementById('basicAutostartSec');
            if (basicAutostartSec) basicAutostartSec.style.display = '';

            // ── 自定义窗口控制按钮（invoke Rust 命令，最可靠方式）────
            const winControls = document.getElementById('winControls');
            if (winControls) {
              winControls.hidden = false;
              console.log('[WinCtrl] initialized, invoke ready');

              // 全部走 invoke → Rust 自定义命令，无需 window.__TAURI__
              document.getElementById('winMin')?.addEventListener('click', (e) => {
                e.stopPropagation();
                console.log('[WinCtrl] minimize');
                invoke('win_minimize');
              });

              const winMaxBtn = document.getElementById('winMax');
              const updateMaxIcon = async () => {
                try {
                  const isMax = await invoke('win_is_maximized');
                  winMaxBtn.querySelector('svg').innerHTML = isMax
                    ? '<rect x="2.5" y="0.5" width="6" height="6" fill="none" stroke="currentColor"/><rect x="0.5" y="2.5" width="6" height="6" fill="none" stroke="currentColor"/>'
                    : '<rect x="0.5" y="0.5" width="8" height="8" fill="none" stroke="currentColor"/>';
                } catch(err) { console.warn('[WinCtrl] isMax err', err); }
              };
              winMaxBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                console.log('[WinCtrl] toggleMaximize');
                invoke('win_toggle_maximize').then(updateMaxIcon);
              });
              updateMaxIcon();

              document.getElementById('winClose')?.addEventListener('click', (e) => {
                e.stopPropagation();
                console.log('[WinCtrl] hide');
                invoke('win_hide');
              });

              // 拖拽 & 双击最大化：全部由 data-tauri-drag-region 原生处理（webview 层直接响应）。
              // 最大化态下拖标题栏还原并跟随鼠标是 Windows 原生行为，无需 JS 接管——
              // 曾加过 mousedown 接管，但按下即触发导致「单击也还原」，故移除。
              // 双击原生最大化后同步一次图标状态。
              document.getElementById('topbarDragArea')?.addEventListener('dblclick', () => {
                setTimeout(updateMaxIcon, 50);
              });
            }

            // ── 开机自启动 toggle ─────────────────────────────────
            const autostartToggle = document.getElementById('autostartToggle');
            if (autostartToggle) {
              // 初始化：读取当前系统自启状态
              invoke('plugin:autostart|is_enabled').then(enabled => {
                autostartToggle.checked = !!enabled;
              }).catch(() => {});

              autostartToggle.addEventListener('change', async () => {
                const on = autostartToggle.checked;
                try {
                  await invoke(on ? 'plugin:autostart|enable' : 'plugin:autostart|disable');
                  toastApi.success(on ? '已开启开机自启动' : '已关闭开机自启动');
                } catch (e) {
                  console.error('[Autostart]', e);
                  autostartToggle.checked = !on; // 回滚
                  toastApi.error('设置失败：' + (e?.message || e));
                }
              });
            }

            // ── 系统原生通知（Tauri plugin-notification）──────────
            // 加载通知插件；失败时降级到后端 IPC
            let _notifPlugin = null;
            try {
              // 随包 vendor，不走 CDN（理由同上：供应链 + 离线可用性）
              _notifPlugin = await import('/vendor/tauri/plugin-notification.js');
            } catch (e) {
              console.warn('[Notify] plugin-notification 本地加载失败，降级到 IPC:', e.message);
            }

            // 存储最近通知的目标 convId，用于点击通知后导航
            window._pendingNotifyConvId = null;

            // 窗口获得焦点时（用户点击通知弹出 → 应用前台）→ 导航到对应会话
            window.addEventListener('focus', () => {
              const cid = window._pendingNotifyConvId;
              if (!cid) return;
              window._pendingNotifyConvId = null;
              setTimeout(() => {
                // 同 show-view：openConv 在 chat.js 模块作用域，经视图桥调用
                // （原先写成 typeof openConv === 'function' 恒为 false，点通知从来没跳过会话）
                if (_nav.openConv) _nav.openConv(cid);
                else console.warn('[Notify] 通知点击跳会话失败：视图桥未注入');
              }, 150);
            });

            window.notifyUser = async function(title, body, { icon = 'info', convId = null } = {}) {
              if (convId) window._pendingNotifyConvId = convId;

              // 优先使用 Tauri 原生通知
              if (_notifPlugin) {
                try {
                  let granted = await _notifPlugin.isPermissionGranted();
                  if (!granted) {
                    const perm = await _notifPlugin.requestPermission();
                    granted = perm === 'granted';
                  }
                  if (granted) {
                    await _notifPlugin.sendNotification({ title, body });
                    console.log('[Notify] Native sent:', title);
                    return;
                  }
                } catch (e) {
                  console.warn('[Notify] Native failed, falling back:', e.message);
                }
              }

              // 降级：后端 IPC 记日志
              try {
                await fetch('/internal/notify', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ title, body, icon }),
                });
              } catch (e) {
                console.error('[Notify] IPC fallback error:', e);
              }
            };

            // ── Tauri 事件监听 ────────────────────────────────────
            // event 为可选能力（托盘/菜单集成）；缺失时静默跳过，不影响窗口控制。
            if (event) {
            // focus-input：来自托盘/菜单「新建任务」
            event.listen('focus-input', () => {
              const inputElement = document.querySelector('textarea, input[type="text"]');
              if (inputElement) {
                inputElement.focus();
                inputElement.scrollIntoView({ behavior: 'smooth' });
              }
            }).catch(err => console.error('[Tauri Event] focus-input:', err));

            // open-settings：来自托盘/菜单「设置」
            event.listen('open-settings', () => {
              const settingsBtn = document.querySelector('#settingsBtn');
              if (settingsBtn) settingsBtn.click();
            }).catch(err => console.error('[Tauri Event] open-settings:', err));

            // open-logs：来自菜单「日志」
            event.listen('open-logs', () => {
              const logsBtn = document.querySelector('[data-view="logs"]');
              if (logsBtn) logsBtn.click();
            }).catch(err => console.error('[Tauri Event] open-logs:', err));

            // ── 文件 / 目录拖入：交给拖拽总线按落点分派 ──────────
            // 原先这里是单槽位 _dropCb，第二个消费者注册会静默踢掉第一个。
            // 另外原先用的是默认 event target（{kind:'Any'}），而 Rust 侧 tauri://drag-*
            // 走 emit_to_webview，其 emit_filter 只放行具体 webview label 的监听器，
            // Any 一律丢弃——也就是说那个监听器从来就没生效过。总线内部已显式传 target。
            const { attachDragBus } = await import('./drag-bus.js');
            attachDragBus(event);

            // show-view：来自托盘菜单导航（接收 Rust 端 emit 事件）
            // 注意：事件名【不能】用 tauri:// 前缀（保留给内置事件），否则 listen 收不到。
            event.listen('show-view', (eventData) => {
              const view = eventData.payload;
              if (['chat', 'settings', 'tasks', 'logs'].includes(view)) { // 与 Rust 托盘 emit 的三个视图对齐（+chat 兜底）
                if (_nav.showView) _nav.showView(view);
                else console.warn('[Tauri Event] show-view 到达但视图桥未注入:', view);
              }
            }).catch(err => console.error('[Tauri Event] show-view:', err));

            // ── 后端就绪 / 启动失败通知（来自 Rust wait_backend_ready）──────
            // 自愈式错误条：冷启动（尤其重启开机）后端可能超时才就绪，Rust 探测超时会发
            // startup-error，但后端随后往往正常起来。这里不贴永久死条，而是持续 ping，
            // 后端一响应就自动撤条，避免永久误报。
            let _startupBar = null;
            let _startupPoll = null;
            const _clearStartupBar = (recovered) => {
              if (_startupPoll) { clearInterval(_startupPoll); _startupPoll = null; }
              if (!_startupBar) return;
              const bar = _startupBar;
              _startupBar = null;
              if (recovered) {
                bar.style.background = 'var(--green)';
                bar.textContent = '✅ 后端已连接';
                setTimeout(() => bar.remove(), 1800);
              } else {
                bar.remove();
              }
            };

            event.listen('backend-ready', () => {
              console.log('[Diag] ✅ Rust 通知：后端已就绪（backend-ready 事件）');
              _clearStartupBar(false); // 撤下任何残留错误条
              // 后端刚就绪时重新探一次 ping，确认连通
              const base = API_BASE || '';
              fetch((base || '') + '/api/ping').then(r => r.json()).then(d => {
                console.log('[Diag] backend-ready 后 /api/ping 成功:', d);
              }).catch(e => {
                console.error('[Diag] ⚠️ backend-ready 后 /api/ping 仍失败:', e.message);
              });
            }).catch(err => console.error('[Tauri Event] backend-ready 监听失败:', err));

            event.listen('startup-error', (ev) => {
              const msg = ev.payload || '后端启动失败（未知原因）';
              console.error('[Diag] ❌ Rust startup-error 事件:', msg);
              // 首次出现：贴一条「较慢/重试中」提示条（橙色，非致命红）
              if (!_startupBar) {
                _startupBar = document.createElement('div');
                _startupBar.style.cssText = 'position:fixed;top:0;left:0;right:0;background:var(--amber);color:var(--bg);padding:10px 16px;font-size:13px;z-index:99999;text-align:center;';
                document.body.appendChild(_startupBar);
              }
              _startupBar.textContent = '⚠️ 后端启动较慢，正在重试连接…';
              // 自愈：持续 ping，成功即撤条（后端冷启动完成后自动恢复）
              if (!_startupPoll) {
                _startupPoll = setInterval(() => {
                  const base = API_BASE || '';
                  fetch((base || '') + '/api/ping')
                    .then(r => { if (r.ok) _clearStartupBar(true); })
                    .catch(() => {});
                }, 2000);
              }
            }).catch(err => console.error('[Tauri Event] startup-error 监听失败:', err));
            }
          } else {
            // 非 Tauri 环境：提供降级的空实现
            window.tauriApi = {
              isTauri: false,
              invoke: null,
              event: null,
              revealPath: null,
              openUrl: null,
            };

            // Web 端隐藏最小化 / 最大化 / 关闭窗口控制按钮（加固：默认即 hidden）
            const winControls = document.getElementById('winControls');
            if (winControls) winControls.hidden = true;

            // 降级通知函数
            window.notifyUser = function(title, body, { icon = 'info' } = {}) {
              console.warn('[Notify] Not in Tauri, skipping system notification:', title);
            };

            console.log('[App] Not in Tauri environment, using fallback mode');
          }
        } catch (err) {
          console.error('[App] Failed to initialize Tauri API:', err);
          // 提供最小化的降级实现
          window.tauriApi = {
            isTauri: false,
            invoke: null,
            event: null,
            revealPath: null,
            openUrl: null,
          };
          window.notifyUser = function(title, body) {
            console.warn('[Notify] Tauri initialization failed:', title);
          };
        }
      })();

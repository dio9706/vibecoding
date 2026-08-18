/**
 * Tauri 原生拖拽总线：把 tauri://drag-* 事件按落点分派给已注册的拖拽区。
 *
 * 为什么需要它：原生拖拽一旦开启（移除 disable_drag_drop_handler），webview 内的
 * HTML5 drop 事件全部失效，落点判定必须自己做。而 tauri-init.js 原先的 _dropCb 是
 * 单槽位——第二个消费者注册时会静默踢掉第一个，输入框与 Markdown 区无法共存。
 */

const zones = [];

/**
 * 注册一个拖拽区。
 * @param {{el:Element, onDrop:(paths:string[], pt:{x:number,y:number})=>void,
 *          onDragOver?:Function, onDragLeave?:Function}} zone
 * @returns {() => void} 反注册函数
 */
export function registerDropZone(zone) {
  zones.push(zone);
  return () => {
    const i = zones.indexOf(zone);
    if (i >= 0) zones.splice(i, 1);
  };
}

/**
 * 物理像素 → CSS 像素。
 *
 * Tauri 的 drag 事件给的是 PhysicalPosition（未除以缩放比），而 elementFromPoint
 * 接受 CSS 像素。Windows 常见的 125%/150% 缩放下不换算必然命中错元素。
 * dpr 为 0/NaN 时兜底为 1，避免算出 Infinity 让 elementFromPoint 抛错。
 */
export function toCssPoint(position, dpr) {
  const ratio = Number(dpr) > 0 ? Number(dpr) : 1;
  return { x: (position?.x ?? 0) / ratio, y: (position?.y ?? 0) / ratio };
}

/**
 * 落点命中哪个拖拽区。
 *
 * 用 elementFromPoint 而不是逐个 getBoundingClientRect 比对：
 * 前者天然处理元素层叠、容器滚动、面板隐藏三种情况。
 *
 * 从命中元素逐级向上找最近的祖先拖拽区，而不是遍历 zones 找第一个 contains 命中的：
 * 拖拽区可能嵌套（面板套在容器里），语义必须是「最内层赢」。按注册顺序取第一个的话，
 * 外层先注册就会把内层的 drop 全吃掉，且这种 bug 只在结构调整后才浮现，极难定位。
 */
export function hitZone(doc, zoneList, pt) {
  let node = doc.elementFromPoint(pt.x, pt.y);
  while (node) {
    const z = zoneList.find((zone) => zone.el === node);
    if (z) return z;
    node = node.parentElement;
  }
  return null;
}

// 是否已挂载。Tauri 事件监听是叠加的：重复 attach 会让同一次 drop 触发多遍 onDrop
// （用户拖一个文件进来插入两个 chip）。热重载 / 误接线都可能重复调用，必须挡住。
let _attached = false;

/**
 * 接上 Tauri 事件源。由 tauri-init.js 在拿到 event 模块后调用一次。
 * @param {{listen:Function}} ev Tauri event 模块
 * @returns {(() => Promise<void>) | null} detach 函数；未挂载成功时为 null
 */
export function attachDragBus(ev) {
  if (_attached) {
    console.warn('[DragBus] attachDragBus 重复调用，已忽略');
    return null;
  }

  // ⚠️ 千万不要删掉 target 改用默认值 ⚠️
  // Rust 侧 tauri://drag-* 走的是 Webview::emit_to_webview（manager/webview.rs），它的
  // emit_filter 只放行 EventTarget::Webview / WebviewWindow 且 label 相等的监听器，
  // 其余分支一律 `_ => false`。而 JS 的 listen() 不传 options 时 target 默认是
  // { kind: 'Any' }，正好落进那个 false —— 结果是四个监听器永远收不到事件，且没有任何
  // 报错，表现为「拖拽完全没反应」。官方 Webview.listen 就是靠显式传 Webview target 才
  // 能收到（见 @tauri-apps/api/webview.js）。
  // 附带好处：target 锁定当前 webview，本应用的多窗口（main / win-2 / win-3）之间
  // 不会串扰——别的窗口的 drop 不会拿本窗口的 DOM 去做落点判定。
  const label = window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label;
  if (!label) {
    // 宁可整个总线不挂，也不退回默认 target：那样只会换来一个永远静默失效的假象
    console.error('[DragBus] 取不到当前 webview label，拖拽总线未挂载');
    return null;
  }
  _attached = true;
  const target = { kind: 'Webview', label };

  let hovered = null; // 当前高亮的区，用于在离开时精确取消

  const locate = (payload) =>
    hitZone(document, zones, toCssPoint(payload?.position, window.devicePixelRatio));

  const leaveCurrent = () => {
    if (hovered?.onDragLeave) hovered.onDragLeave();
    hovered = null;
  };

  // 原生模式下没有 HTML5 的 dragover/dragleave，拖入高亮只能由总线驱动
  const onOver = (e) => {
    const z = locate(e.payload);
    if (z !== hovered) {
      leaveCurrent();
      hovered = z;
      if (z?.onDragOver) z.onDragOver();
    }
  };

  const onDrop = (e) => {
    leaveCurrent();
    const paths = e.payload?.paths;
    if (!Array.isArray(paths) || !paths.length) return;
    const pt = toCssPoint(e.payload?.position, window.devicePixelRatio);
    const z = hitZone(document, zones, pt);
    // onDrop 用可选调用，与 onDragOver/onDragLeave 一致：漏写不该炸掉整条链路
    if (z?.onDrop) z.onDrop(paths, pt);
    // 落在任何拖拽区之外：什么都不做。不静默也不报错——用户拖到了标题栏之类的地方
  };

  const unlistens = [];
  const sub = (name, handler) => {
    unlistens.push(
      ev.listen(name, handler, { target }).catch((err) => {
        console.error(`[DragBus] ${name} 监听失败:`, err);
        return () => {}; // 占位，保证 detach 时不会去调用 undefined
      }),
    );
  };

  sub('tauri://drag-enter', onOver);
  sub('tauri://drag-over', onOver);
  sub('tauri://drag-leave', leaveCurrent);
  sub('tauri://drag-drop', onDrop);

  return async () => {
    _attached = false; // 允许之后重新挂载，否则热重载一次就永久失效
    for (const p of unlistens) {
      try { (await p)(); } catch (err) { console.error('[DragBus] 反注册失败:', err); }
    }
  };
}

// markdown-tool.js 以传统 <script> 引入（index.html 里非 module），不是 ES module，
// 拿不到 import，只能走 window 桥。
// 加 typeof 判断是因为本模块要能被 node --test 直接 import（纯函数部分要跑单测），
// 而 node 全局没有 window，不判断会在模块顶层直接 ReferenceError。
if (typeof window !== 'undefined') {
  window.dragBus = { registerDropZone };
}

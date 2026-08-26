# 后端掉线守卫实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 后端不可达时升起全屏蒙版（六芒星 LOGO + 「服务器后台异常」），恢复后自动撤罩；并把全项目 fetch 的网络层失败从 `Failed to fetch` 收口成可读语义。

**Architecture:** 三层解耦——`bootstrap.js` 的 fetch 包装负责**分类**（网络层失败 vs 业务错误），`net-guard.js` 负责**判定**（ping 确认 + 状态机 + 重连），`offline-overlay.js` 负责**展示**。展示层通过回调注入给判定层，判定层不认识 DOM。

**Tech Stack:** 原生 ESM + DOM，无框架；测试 `node:test` + `jsdom`。

**Spec:** `docs/superpowers/specs/2026-08-26-backend-offline-guard-design.md`

---

## 提交约定

**本计划不含任何 `git commit` 步骤。** 用户约定：改动留工作区，提交时机由用户掌控。
每个任务末尾只做「跑测试确认绿」，不提交。

## 与 spec 的两处实现层偏离

写计划时发现两处可以做得更好，已偏离 spec 原文，**实现前请确认**：

### 偏离 1：展示层改为回调注入，删掉 `isBackendDown()`

spec 4.1 写 `reportNetworkFailure()` 内部直接调 `showOfflineOverlay()`，并导出
`isBackendDown()` 供测试观测。

改为 `armNetworkGuard({ onDown, onUp })` 注入回调，由 `app.js` 接线。收益：
`net-guard.test.js` 变成零 DOM 依赖的纯逻辑测试（注入 spy 即可断言），不必为观测状态
额外导出 API。这更彻底地落实了 spec 3.2 节「拆开的收益是状态机能纯逻辑单测」的意图。

`isBackendDown()` 随之失去唯一用途（观测点），按 YAGNI 删除。

### 偏离 2：LOGO 克隆换 id，不把 SVG 的 id 改成 class

spec 未涉及此细节。实测发现启动罩 SVG 的动画挂在 **ID 选择器**上
（`app.css:2842` 的 `#bootStar #btri1`），而 `onboarding.css` 另有 **6 处**
`.boot-overlay.ob-arm #bootStar #btri1` 这类引导态变体（含两处 media query 内）。

把 id 改成 class 需要动这 12 处、其中 6 处是调优过的引导动画——回归面不值。
改为克隆时把 `#bootStar/#btri1/#btri2` 换成 `#offlineStar/#obtri1/#obtri2`，
在 `app.css` 新增一段同款动画规则。代价是 4 行 CSS 重复，换来完全不碰引导态。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `public/app.css` | 改 | `.boot-overlay[hidden]` 修正、`.offline-overlay`、`#offlineStar` 动画 |
| `public/js/boot-gate.js` | 改 | 撤罩 `remove()` → `hidden`；ping 加 `__skipGuard` |
| `public/js/tauri-init.js` | 改 | 抽出可重入的 `bindWindowControls(root)` |
| `public/js/offline-overlay.js` | 新增 | 掉线罩 DOM：建 / show / hide。无探测逻辑 |
| `public/js/offline-overlay.test.js` | 新增 | 罩子 DOM 结构、LOGO 克隆、幂等 |
| `public/js/net-guard.js` | 新增 | 判定状态机：上报 → ping 确认 → 升罩 → 重连 → 撤罩 |
| `public/js/net-guard.test.js` | 新增 | 状态机纯逻辑测试 |
| `public/js/bootstrap.js` | 改 | fetch 包装无条件装 + 错误分类 |
| `public/app.js` | 改 | 接线 `armNetworkGuard` |
| `public/js/req-chat.js` | 改 | `:560` 去双重归因 |
| `public/js/req-view.js` | 改 | `:1462` 去双重归因 |
| `public/js/composer.js` | 改 | `:172` 去双重归因 |
| `public/js/req-chat.apidoc.test.js` | 改 | 补网络错误文案回归 |

任务顺序即依赖顺序：Task 1-3 是零行为变化的地基，Task 4-5 造两个新模块，
Task 6-7 接线通电，Task 8 收尾文案，Task 9 端到端验。

---

## Task 1: CSS 地基

**Files:**
- Modify: `public/app.css`（在 `.boot-skip:hover` 规则之后、`/* ==== 需求视图 ==== */` 之前插入，即 `:2872` 附近）
- Modify: `public/app.css:2808-2813`（`.boot-overlay.hide` 之后补 `[hidden]` 修正）

- [ ] **Step 1: 补 `[hidden]` 修正**

在 `public/app.css` 的 `.boot-overlay.hide { ... }` 规则块**之后**插入：

```css
/* .boot-overlay 是 display:flex，会压过 UA 对 [hidden] 的 display:none —— 同款坑本文件
   已踩过两次（.ob-titlebar .win-controls[hidden]、.token-banner）。
   boot-gate 撤罩由 remove() 改成 hidden=true 之后（为了留住 #bootStar 供掉线罩克隆），
   漏这条的后果是罩子撤不掉、开机即黑屏。 */
.boot-overlay[hidden] {
  display: none;
}
```

- [ ] **Step 2: 加掉线罩样式**

在 `.boot-skip:hover { ... }` 规则块**之后**插入：

```css
/* ---- 后端掉线罩（net-guard.js 升起）----
   复用 .boot-overlay 的布局/背景/淡入，只覆盖层级：必须压住引导面板（.ob-panel）
   与一切弹窗，因为后端不通时它们全都是死的。 */
.offline-overlay {
  z-index: 100001; /* 启动罩 100000 高一档 */
}
/* 副文案压暗一档，与主文案「服务器后台异常」区分主次 */
.offline-overlay .off-sub {
  color: var(--faint);
}
/* LOGO 克隆自 #bootStar。启动罩的动画挂在 ID 选择器上，且 onboarding.css 另有 6 处
   .ob-arm #bootStar 引导态变体——改成 class 要动那 6 处调优过的规则，回归面不值。
   故克隆时换一组 id，这里补一份同款动画。 */
#offlineStar #obtri1,
#offlineStar #obtri2 {
  transform-box: view-box;
  transform-origin: 100px 100px;
  animation: vibeSpinPause 2.6s cubic-bezier(0.7, 0, 0.25, 1) infinite;
}
#offlineStar #obtri2 {
  animation-name: vibeSpinPauseRev;
}
```

- [ ] **Step 3: 验证三条规则都在**

不检查括号配平——`app.css` 里其他注释含 `{` 会把计数带偏，验不出东西。直接验规则存在：

Run（单引号包裹，避免 bash 解释正则里的反斜杠）:

```bash
cd "C:/Users/DELL/Desktop/claude-p-web-demo" && node -e '
const c = require("fs").readFileSync("public/app.css", "utf8");
const checks = [
  [/\.boot-overlay\[hidden\]\s*\{[^}]*display:\s*none/, "boot-overlay[hidden] 修正"],
  [/\.offline-overlay\s*\{[^}]*z-index:\s*100001/, "offline-overlay 层级"],
  [/#offlineStar #obtri1/, "克隆体动画规则"],
  [/#offlineStar #obtri2\s*\{[^}]*vibeSpinPauseRev/, "克隆体反向动画"],
];
let bad = 0;
for (const [re, name] of checks) { const ok = re.test(c); if (!ok) bad++; console.log(ok ? "OK  " : "FAIL", name); }
process.exit(bad ? 1 : 0);
'
```

Expected: 4 行全 `OK`，退出码 0

---

## Task 2: boot-gate 撤罩改 hidden

**Files:**
- Modify: `public/js/boot-gate.js:95-99`

- [ ] **Step 1: 改撤罩方式**

把 `_run()` 末尾这段：

```js
  if (overlay) {
    overlay.classList.add('hide');
    // 与 .boot-overlay.hide 的 opacity 过渡时长对齐；移除而非仅隐藏，避免残留罩子吃点击
    setTimeout(() => overlay.remove(), 320);
  }
```

替换为：

```js
  if (overlay) {
    overlay.classList.add('hide');
    // 过渡结束后置 hidden 而非 remove()：掉线罩（offline-overlay.js）要克隆 #bootStar
    // 复用 LOGO，remove 掉就没得克隆了。hidden 是 display:none，同样不吃点击
    //（依赖 app.css 的 .boot-overlay[hidden] 那条，缺它则 display:flex 压过 UA 样式）。
    setTimeout(() => {
      overlay.hidden = true;
    }, 320);
  }
```

- [ ] **Step 2: 验证改动落地且 remove 已清净**

**前置依赖**：Task 1 Step 1 的 `.boot-overlay[hidden]` 规则必须已经在位。
缺它则本步改完就是「开机即黑屏」——罩子永远撤不掉。Task 1 Step 3 已验过该规则。

Run:

```bash
cd "C:/Users/DELL/Desktop/claude-p-web-demo" && node -e '
const s = require("fs").readFileSync("public/js/boot-gate.js", "utf8");
const hasHidden = /overlay\.hidden = true/.test(s);
const hasRemove = /overlay\.remove\(\)/.test(s);
console.log(hasHidden ? "OK   已改为 hidden = true" : "FAIL 未找到 hidden = true");
console.log(!hasRemove ? "OK   overlay.remove() 已清净" : "FAIL overlay.remove() 仍在，会把 #bootStar 删掉");
process.exit(hasHidden && !hasRemove ? 0 : 1);
'
```

Expected: 两行 `OK`，退出码 0

- [ ] **Step 3: 跑全量测试确认无回归**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && npm test 2>&1 | tail -15`

Expected: 与改动前一致（记下改动前的 pass/fail 数用于对比）

---

## Task 3: 抽出可重入的 bindWindowControls

纯重构，零行为变化。目的是让懒创建的掉线罩也能绑上窗口按钮——现在是
`document.querySelectorAll('.wc-*')` 一次性绑定，掉线罩创建时绑定早已跑完。

**Files:**
- Modify: `public/js/tauri-init.js:98-142`

- [ ] **Step 1: 在 tauri-init.js 顶层加导出函数**

在 `public/js/tauri-init.js` 文件末尾追加：

```js
/**
 * 绑定一组窗口控制按钮（最小化/最大化/关闭 + 双击标题栏最大化）。
 *
 * 可重入：标题栏在本项目有三处——主界面顶栏、启动罩内 .ob-titlebar、掉线罩内 .ob-titlebar。
 * 前两处在启动时一次性绑定，掉线罩是运行时懒创建的，必须能单独补绑，否则无边框窗口
 * （main.rs 的 decorations(false)）被罩住之后拖不动也关不掉，只剩托盘和 Alt+F4。
 *
 * 自己解析 invoke 而不由调用方传入：换来调用方零心智负担，代价只是两行重复的解析。
 *
 * @param {ParentNode} root 只在此子树内查找按钮
 */
export function bindWindowControls(root = document) {
  if (typeof window.__TAURI_INTERNALS__ === 'undefined') return; // 非 Tauri：按钮保持 hidden
  const invoke = window.__TAURI__?.core?.invoke
    ?? ((cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args));

  const winControls = root.querySelectorAll('.win-controls');
  if (!winControls.length) return;
  winControls.forEach((c) => { c.hidden = false; });

  root.querySelectorAll('.wc-min').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    invoke('win_minimize');
  }));

  const winMaxBtns = root.querySelectorAll('.wc-max');
  const updateMaxIcon = async () => {
    try {
      const isMax = await invoke('win_is_maximized');
      const svg = isMax
        ? '<rect x="2.5" y="0.5" width="6" height="6" fill="none" stroke="currentColor"/><rect x="0.5" y="2.5" width="6" height="6" fill="none" stroke="currentColor"/>'
        : '<rect x="0.5" y="0.5" width="8" height="8" fill="none" stroke="currentColor"/>';
      winMaxBtns.forEach((b) => { const s = b.querySelector('svg'); if (s) s.innerHTML = svg; });
    } catch (err) { console.warn('[WinCtrl] isMax err', err); }
  };
  winMaxBtns.forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    invoke('win_toggle_maximize').then(updateMaxIcon);
  }));
  updateMaxIcon();

  root.querySelectorAll('.wc-close').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    invoke('win_hide');
  }));

  // 拖拽与双击最大化由 data-tauri-drag-region 原生处理（webview 层直接响应）；
  // 双击原生最大化后同步一次图标状态。曾加过 mousedown 接管，按下即触发导致
  // 「单击也还原」，故移除，勿再加回。
  root.querySelectorAll('#topbarDragArea, .ob-titlebar-drag').forEach((el) =>
    el.addEventListener('dblclick', () => { setTimeout(updateMaxIcon, 50); }));
}
```

- [ ] **Step 2: 让原有调用点改走新函数**

把 `public/js/tauri-init.js:98-142` 那一整段（从注释 `// ── 自定义窗口控制按钮` 到
它的闭合 `}`，即原 `const winControls = document.querySelectorAll('.win-controls');`
起至 `el.addEventListener('dblclick', ...)` 那个 `}` 止）替换为：

```js
            // ── 自定义窗口控制按钮（invoke Rust 命令，最可靠方式）────
            // 实现下沉到本文件末尾的 bindWindowControls()：标题栏有三处（主界面顶栏、
            // 启动罩、掉线罩），后者是运行时懒创建的，需要能单独补绑。
            bindWindowControls(document);
            console.log('[WinCtrl] initialized via bindWindowControls');
```

- [ ] **Step 3: 验证重构没漏 invoke 命令名**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && node -e "
const s = require('fs').readFileSync('public/js/tauri-init.js','utf8');
for (const c of ['win_minimize','win_is_maximized','win_toggle_maximize','win_hide']) {
  const n = (s.match(new RegExp(c,'g'))||[]).length;
  console.log(c, '出现', n, '次', n===1 ? 'OK' : (n===0 ? 'FAIL 丢了' : 'WARN 有重复，确认旧代码已删净'));
}
console.log('bindWindowControls 导出:', /export function bindWindowControls/.test(s));
"`

Expected: 四个命令各 1 次、`bindWindowControls 导出: true`

- [ ] **Step 4: 跑全量测试**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && npm test 2>&1 | tail -15`

Expected: 与 Task 2 结束时一致

---

## Task 4: offline-overlay.js（TDD）

**Files:**
- Create: `public/js/offline-overlay.test.js`
- Create: `public/js/offline-overlay.js`

- [ ] **Step 1: 先写失败的测试**

创建 `public/js/offline-overlay.test.js`：

```js
/**
 * 后端掉线罩的 DOM 测试。
 *
 * 三条不变量，每条都对应一个真实故障：
 *  1. LOGO 必须克隆成功且换掉 id —— 重复 id 是脏 DOM，且 app.css 的动画规则按
 *     #offlineStar #obtri1 限定作用域，id 不换就没动画（罩子变成一张静止图）。
 *  2. 必须带 .ob-titlebar —— 窗口无边框（decorations(false)），inset:0 的罩子盖住
 *     header.topbar 之后窗口拖不动也关不掉，只剩托盘和 Alt+F4。
 *  3. show/hide 必须幂等 —— 多路轮询会在同一时刻集中失败，并发升罩不能堆出多个罩子。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

let dom;
let showOfflineOverlay;
let hideOfflineOverlay;

before(async () => {
  // 用真实 index.html 当骨架：掉线罩要克隆里面的 #bootStar
  const html = fs.readFileSync('public/index.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  dom = new JSDOM(html, { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  const mod = await import('./offline-overlay.js');
  showOfflineOverlay = mod.showOfflineOverlay;
  hideOfflineOverlay = mod.hideOfflineOverlay;
});

after(() => {
  dom?.window?.close();
});

beforeEach(() => {
  hideOfflineOverlay();
});

test('升罩：建出罩子，文案为「服务器后台异常」', () => {
  showOfflineOverlay();
  const el = document.getElementById('offlineOverlay');
  assert.ok(el, '应建出 #offlineOverlay');
  assert.equal(el.hidden, false, '升罩后不应是 hidden');
  assert.ok(el.classList.contains('boot-overlay'), '应复用 .boot-overlay 布局');
  assert.ok(el.classList.contains('offline-overlay'), '应带 .offline-overlay 覆盖层级');
  assert.match(el.textContent, /服务器后台异常/, '主文案应为「服务器后台异常」');
  assert.match(el.textContent, /正在尝试重新连接/, '应有重连副文案');
});

test('LOGO 克隆自 #bootStar 且换掉全部 id（否则重复 id + 丢动画）', () => {
  showOfflineOverlay();
  const el = document.getElementById('offlineOverlay');
  const star = el.querySelector('#offlineStar');
  assert.ok(star, 'LOGO 应克隆为 #offlineStar');
  assert.ok(star.classList.contains('boot-star'), '应保留 .boot-star 尺寸样式');
  assert.ok(star.querySelector('#obtri1'), '内层三角应换 id 为 #obtri1');
  assert.ok(star.querySelector('#obtri2'), '内层三角应换 id 为 #obtri2');
  // 关键：不能带走原 id，否则整个文档出现重复 id
  assert.equal(el.querySelector('#bootStar'), null, '克隆体不应保留 #bootStar');
  assert.equal(el.querySelector('#btri1'), null, '克隆体不应保留 #btri1');
  assert.equal(el.querySelector('#btri2'), null, '克隆体不应保留 #btri2');
  // 原罩子的 LOGO 必须还在（撤罩改 hidden 就是为了这个）
  assert.ok(document.getElementById('bootStar'), '启动罩的 #bootStar 应仍在 DOM 里');
});

test('带罩内标题栏：否则无边框窗口拖不动也关不掉', () => {
  showOfflineOverlay();
  const el = document.getElementById('offlineOverlay');
  assert.ok(el.querySelector('.ob-titlebar'), '应有罩内标题栏');
  assert.ok(el.querySelector('.ob-titlebar-drag[data-tauri-drag-region]'), '应有拖拽区');
  assert.ok(el.querySelector('.wc-min'), '应有最小化按钮');
  assert.ok(el.querySelector('.wc-max'), '应有最大化按钮');
  assert.ok(el.querySelector('.wc-close'), '应有关闭按钮');
});

test('show/hide 幂等：并发升罩不堆出多个罩子', () => {
  showOfflineOverlay();
  showOfflineOverlay();
  showOfflineOverlay();
  assert.equal(document.querySelectorAll('#offlineOverlay').length, 1, '只应有一个罩子');

  hideOfflineOverlay();
  hideOfflineOverlay();
  assert.equal(document.getElementById('offlineOverlay').hidden, true, '撤罩后应为 hidden');

  // 再升起：复用同一节点，不重建
  showOfflineOverlay();
  assert.equal(document.querySelectorAll('#offlineOverlay').length, 1, '复用同一节点');
  assert.equal(document.getElementById('offlineOverlay').hidden, false);
});

test('「重新加载」按钮存在且可点（不在测试里真的 reload）', () => {
  showOfflineOverlay();
  const btn = document.querySelector('#offlineOverlay #offlineReload');
  assert.ok(btn, '应有「重新加载」按钮');
  assert.match(btn.textContent, /重新加载/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && node --test public/js/offline-overlay.test.js 2>&1 | tail -20`

Expected: FAIL，报 `Cannot find module './offline-overlay.js'`

- [ ] **Step 3: 写实现**

创建 `public/js/offline-overlay.js`：

```js
/**
 * 后端掉线罩：纯展示层，不含任何探测逻辑（判定在 net-guard.js）。
 *
 * 为什么懒创建而不像启动罩那样写静态 HTML：index.html 里启动罩必须第一帧就在 DOM 里
 * （注释「无二次挂载抖动」），但那个理由只针对首帧。掉线是运行时事件，触发时 JS 早已
 * 就绪，没有抖动代价，省一段常驻的无用 DOM。
 *
 * 为什么不复用 #bootOverlay：它已承载启动等待 + 经 setOverlayHandoff 移交的新用户引导
 * 两种状态，再塞第三种就是一个 DOM 三套状态机；且掉线罩需要盖在引导面板之上，
 * 同一节点做不到。
 */
import { bindWindowControls } from './tauri-init.js';

let el = null;

/** 罩内标题栏：窗口无边框（main.rs 的 decorations(false)），inset:0 的罩子盖住
 *  header.topbar 之后窗口就拖不动也关不掉，只剩托盘和 Alt+F4。与 index.html 里
 *  启动罩那份保持同构（按类不按 id，两处共用 bindWindowControls）。 */
const TITLEBAR_HTML = `
  <div class="ob-titlebar" data-tauri-drag-region>
    <div class="ob-titlebar-drag" data-tauri-drag-region></div>
    <div class="win-controls" hidden>
      <button class="wc-btn wc-min" title="最小化">
        <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
      </button>
      <button class="wc-btn wc-max" title="最大化/还原">
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><rect x="0.5" y="0.5" width="8" height="8" stroke="currentColor"/></svg>
      </button>
      <button class="wc-btn wc-close" title="关闭到托盘">
        <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
    </div>
  </div>`;

/** LOGO 克隆自启动罩的 #bootStar，不存第二份 SVG 素材。
 *  必须换掉全部 id：原 id 带走会让文档出现重复 id，且 app.css 的动画规则按
 *  `#offlineStar #obtri1` 限定作用域，不换就没动画（罩子成一张静止图）。 */
function cloneStar() {
  const src = document.getElementById('bootStar');
  if (!src) return null; // 启动罩被 remove 过（理论上不会，boot-gate 已改 hidden）
  const clone = src.cloneNode(true);
  clone.id = 'offlineStar';
  const t1 = clone.querySelector('#btri1');
  const t2 = clone.querySelector('#btri2');
  if (t1) t1.id = 'obtri1';
  if (t2) t2.id = 'obtri2';
  return clone;
}

function create() {
  const box = document.createElement('div');
  box.id = 'offlineOverlay';
  // 复用 .boot-overlay 的布局/背景/淡入；.offline-overlay 只覆盖 z-index
  box.className = 'boot-overlay offline-overlay';
  box.innerHTML = `${TITLEBAR_HTML}
    <div class="vibe-title">VIBE CODING</div>
    <div class="boot-text">服务器后台异常</div>
    <div class="boot-text off-sub">正在尝试重新连接…</div>
    <button class="boot-skip" id="offlineReload" type="button">重新加载</button>`;

  const star = cloneStar();
  // 插在标题栏之后、标题之前：.boot-overlay 是 column flex，顺序即视觉顺序
  if (star) box.insertBefore(star, box.querySelector('.vibe-title'));

  box.querySelector('#offlineReload').addEventListener('click', () => {
    window.location.reload();
  });

  document.body.appendChild(box);
  // 必须补绑：tauri-init 的绑定是一次性 querySelectorAll，此时早已跑完
  bindWindowControls(box);
  return box;
}

/** 升起掉线罩（幂等，首次调用懒创建）。 */
export function showOfflineOverlay() {
  if (!el || !el.isConnected) el = create();
  el.hidden = false;
}

/** 撤下掉线罩（幂等）。保留节点供下次复用——掉线可能反复发生，不必反复建 DOM。 */
export function hideOfflineOverlay() {
  if (el) el.hidden = true;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && node --test public/js/offline-overlay.test.js 2>&1 | tail -20`

Expected: 5 个 test 全 pass

---

## Task 5: net-guard.js（TDD）

**Files:**
- Create: `public/js/net-guard.test.js`
- Create: `public/js/net-guard.js`

- [ ] **Step 1: 先写失败的测试**

创建 `public/js/net-guard.test.js`：

```js
/**
 * 掉线判定状态机测试。纯逻辑——展示层由 armNetworkGuard 注入回调，这里塞 spy，
 * 不碰 DOM。
 *
 * 每条用例都对应一个会真实发生的误判：
 *  - AbortError：boot-gate 自己就用 AbortController 做 ping 超时，不排除会自我触发
 *  - __skipGuard：boot-gate 启动期 ping 的旁路，不排除则冷启动时两个罩子打架
 *  - ping 通：单接口 500/偶发超时不该把好端端的后端说成异常
 *  - 并发上报：多路轮询（req/list 30s、conv-notify 5s）会在同一时刻集中失败
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { armNetworkGuard, reportNetworkFailure } from './net-guard.js';

let downCalls;
let upCalls;
let pingResults; // 依次消费：true=后端活着，false=不通
let pingCount;

/** 装一个受控的全局 fetch：只服务 net-guard 内部的 /api/ping */
function stubPing(results) {
  pingResults = [...results];
  pingCount = 0;
  globalThis.fetch = async () => {
    pingCount++;
    const ok = pingResults.length ? pingResults.shift() : false;
    if (!ok) throw new TypeError('Failed to fetch');
    return { ok: true, json: async () => ({ status: 'ok' }) };
  };
}

beforeEach(() => {
  downCalls = 0;
  upCalls = 0;
  // armNetworkGuard 幂等重置状态机，每个用例重新装一次即得干净状态
  armNetworkGuard({
    onDown: () => { downCalls++; },
    onUp: () => { upCalls++; },
    retryMs: 5, // 测试里把重连间隔压到 5ms，避免等 2s
  });
});

test('网络层失败 + ping 也不通 → 升罩', async () => {
  stubPing([false]);
  reportNetworkFailure();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pingCount >= 1, true, '应至少 ping 一次做确认');
  assert.equal(downCalls, 1, '确认不通后应升罩一次');
});

test('网络层失败但 ping 通 → 不升罩（单接口偶发，不是掉线）', async () => {
  stubPing([true]);
  reportNetworkFailure();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pingCount, 1, '应 ping 一次');
  assert.equal(downCalls, 0, 'ping 通就不该升罩');
});

test('升罩后 ping 恢复 → 自动撤罩', async () => {
  stubPing([false, false, true]); // 确认不通 → 重连一次仍不通 → 再重连通了
  reportNetworkFailure();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(downCalls, 1, '应升罩一次');
  assert.equal(upCalls, 1, '恢复后应撤罩一次');
});

test('并发上报去重：只 ping 一次，只升罩一次', async () => {
  stubPing([false]);
  reportNetworkFailure();
  reportNetworkFailure();
  reportNetworkFailure();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pingCount, 1, 'confirming 期间的重复上报应被丢弃');
  assert.equal(downCalls, 1, '只应升罩一次');
});

test('未 arm 时上报直接忽略，且不发 ping（启动阶段归 boot-gate 的启动罩管）', async () => {
  // 传空 deps 即回到「未 arm」：onDown 为 null，reportNetworkFailure 应立刻 return。
  // 这条不能靠「arm 了但 ping 通」来代替 —— 那验的是另一条分支（偶发失败），
  // 会漏掉「启动期 bootstrap 已装好包装、但 app.js 还没接线」这个真实窗口。
  armNetworkGuard({});
  stubPing([false]); // 故意让 ping 不通：真发了 ping 就会升罩，能抓出漏判
  reportNetworkFailure();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pingCount, 0, '未 arm 时不该发 ping');
  assert.equal(downCalls, 0, '未 arm 时不该升罩');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && node --test public/js/net-guard.test.js 2>&1 | tail -20`

Expected: FAIL，报 `Cannot find module './net-guard.js'`

- [ ] **Step 3: 写实现**

创建 `public/js/net-guard.js`：

```js
/**
 * 后端可达性判定：把「某个 fetch 挂了」升级成「后端整体不可达」的判断，并驱动掉线罩。
 *
 * 为什么被动触发而不常态心跳：项目已有 /api/req/list(30s)、conv-notify(5s) 等多路轮询，
 * 它们本身就是天然心跳——掉线时必然有一路先失败并上报，用户不操作也能发现。
 * 再加一路专用心跳属于职责重叠。
 *
 * 为什么失败后还要 ping 确认：单个接口 500 / 偶发超时不等于后端死了，直接升罩会把
 * 好端端的后端说成异常。ping /api/ping 是最轻的整体存活判据。
 *
 * 展示层由 armNetworkGuard 注入，本模块不认识 DOM —— 判定规则因此可纯逻辑单测。
 */

const PING_TIMEOUT_MS = 1500; // 与 boot-gate.js 同值：冷启动时端口可能已 accept 但迟迟不响应
const DEFAULT_RETRY_MS = 2000;

let onDown = null;
let onUp = null;
let retryMs = DEFAULT_RETRY_MS;
let state = 'idle'; // idle | confirming | down
let retryTimer = null;

/**
 * 装上判定逻辑并注入展示层。幂等——重复调用会重置状态机（测试依赖这个性质）。
 * @param {{onDown:()=>void, onUp:()=>void, retryMs?:number}} deps
 */
export function armNetworkGuard(deps) {
  onDown = deps?.onDown ?? null;
  onUp = deps?.onUp ?? null;
  retryMs = deps?.retryMs ?? DEFAULT_RETRY_MS;
  state = 'idle';
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/** 探一次后端存活。__skipGuard 让这次请求本身不再触发上报，否则无限自激。 */
async function ping() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PING_TIMEOUT_MS);
  try {
    const r = await fetch('/api/ping', {
      signal: ac.signal,
      cache: 'no-store',
      __skipGuard: true,
    });
    return !!r?.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 升罩后持续重连，通了就撤罩。 */
function scheduleRetry() {
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    if (state !== 'down') return; // 已被 armNetworkGuard 重置
    if (await ping()) {
      state = 'idle';
      onUp?.();
      return;
    }
    if (state === 'down') scheduleRetry();
  }, retryMs);
}

/**
 * 上报一次网络层失败。由 bootstrap.js 的 fetch 包装调用。
 * confirming / down 期间重复上报直接丢弃：多路轮询会在同一时刻集中失败。
 */
export function reportNetworkFailure() {
  if (!onDown) return; // 尚未 arm：还在启动阶段，由 boot-gate 的启动罩负责
  if (state !== 'idle') return;
  state = 'confirming';
  ping().then((alive) => {
    if (alive) {
      state = 'idle'; // 单接口偶发，后端整体是活的
      return;
    }
    state = 'down';
    onDown();
    scheduleRetry();
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && node --test public/js/net-guard.test.js 2>&1 | tail -20`

Expected: 5 个 test 全 pass

---

## Task 6: fetch 包装无条件装 + 错误分类

本任务改的是全局 fetch，是整个计划里风险最高的一步。改完必须跑全量测试。

**Files:**
- Modify: `public/js/bootstrap.js:71-111`
- Modify: `public/js/boot-gate.js:35`

- [ ] **Step 1: 给 boot-gate 的 ping 加旁路标记**

把 `public/js/boot-gate.js` 的 `ping()` 里这行：

```js
    const r = await fetch('/api/ping', { signal: ac.signal, cache: 'no-store' });
```

改为：

```js
    // __skipGuard：本次失败不上报给 net-guard。启动期后端本来就还没起来，
    // 不排除会让掉线罩和启动罩同时升起打架。
    // 注意仍然走包装后的 fetch —— 打包态下这个相对路径必须被改写成
    // API_BASE + '/api/ping' 才打得到实际端口（bootstrap.js:77-78）。
    const r = await fetch('/api/ping', { signal: ac.signal, cache: 'no-store', __skipGuard: true });
```

- [ ] **Step 2: 改 bootstrap.js —— 包装改为无条件安装**

把 `public/js/bootstrap.js` 从 `if (_isTauriPackaged) {`（`:71`）到文件末尾的
`}`（`:111`）整段替换为：

```js
      // ── fetch 包装：无条件安装 ────────────────────────────────────
      // 原先只在打包态装（为了改写相对路径）。改为无条件装，是为了让「网络层失败」
      // 在所有模式下都能被分类：不分类的话全项目几十处 fetch 的 catch 拿到的都是
      // 浏览器原文 `Failed to fetch`，被拼进业务文案后把系统故障说成功能故障
      //（req-chat.js 的「API 文档上传失败：Failed to fetch」就是这么来的）。
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
          if (e?.name === 'AbortError') throw e;      // 主动取消不是掉线
          if (init?.__skipGuard) throw e;             // boot-gate 启动期 ping 的旁路
          reportNetworkFailure();
          // 带标记而不靠比对消息文本：这里正是「文案会被改」的地方，
          // 字符串比对一改文案就静默失效。
          throw Object.assign(new Error('后端未连接'), { isNetworkError: true, cause: e });
        }
      };

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
        // 非打包模式也探一下
        fetch('/api/ping', { __skipGuard: true }).then(r => r.json()).then(d => {
          console.log('[Diag] /api/ping (相对路径) 成功:', d);
        }).catch(e => {
          console.error('[Diag] ⚠️ /api/ping (相对路径) 失败（后端未就绪？）:', e.message);
        });
      }
```

- [ ] **Step 3: 在 bootstrap.js 顶部加 import**

在 `public/js/bootstrap.js` 第 1 行的文件注释**之后**插入：

```js
import { reportNetworkFailure } from './net-guard.js';
```

无循环依赖：`net-guard.js` 不 import `bootstrap.js`。

- [ ] **Step 4: 验证分类逻辑（不依赖浏览器）**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && node --input-type=module -e "
import fs from 'node:fs';
const s = fs.readFileSync('public/js/bootstrap.js','utf8');
const checks = [
  [/import \{ reportNetworkFailure \} from '\.\/net-guard\.js'/, 'import net-guard'],
  [/const _origFetch = window\.fetch\.bind\(window\);\s*\n\s*window\.fetch = async/, '包装无条件安装（不在 if 里）'],
  [/e\?\.name === 'AbortError'/, 'AbortError 排除'],
  [/init\?\.__skipGuard/, '__skipGuard 旁路'],
  [/isNetworkError: true/, 'isNetworkError 标记'],
];
let bad = 0;
for (const [re, name] of checks) { const ok = re.test(s); if(!ok) bad++; console.log(ok?'OK  ':'FAIL', name); }
process.exit(bad ? 1 : 0);
"`

Expected: 5 行全 `OK`

- [ ] **Step 5: 跑全量测试**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && npm test 2>&1 | tail -20`

Expected: 与 Task 3 结束时一致。若有新失败，大概率是某个测试 stub 的 fetch
被包装二次改写——检查该测试是否在 import bootstrap.js 之后覆写 `globalThis.fetch`。

---

## Task 7: app.js 接线

**Files:**
- Modify: `public/app.js`（import 区 + `hydrateIcons()` 附近）

- [ ] **Step 1: 加 import**

在 `public/app.js` 第 2 行（`import { whenBackendReady, ... } from './js/boot-gate.js';`）
**之后**插入：

```js
import { armNetworkGuard } from './js/net-guard.js';
import { showOfflineOverlay, hideOfflineOverlay } from './js/offline-overlay.js';
```

- [ ] **Step 2: 接线**

在 `public/app.js` 的 `hydrateIcons();` 那一行**之后**插入：

```js
// 掉线守卫接线：判定逻辑在 net-guard，展示在 offline-overlay，此处把两者接起来。
// 必须在 hydrateIcons 之后、任何业务请求之前——arm 之前的上报会被 net-guard 直接丢弃
//（那个阶段还归 boot-gate 的启动罩管）。
armNetworkGuard({ onDown: showOfflineOverlay, onUp: hideOfflineOverlay });
```

- [ ] **Step 3: 验证接线顺序**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && node -e "
const s = require('fs').readFileSync('public/app.js','utf8');
const iArm = s.indexOf('armNetworkGuard({');
const iHydrate = s.indexOf('hydrateIcons();');
const iBootstrap = s.indexOf(\"import './js/bootstrap.js'\");
console.log('bootstrap import 在最前:', iBootstrap === s.indexOf('import'));
console.log('arm 在 hydrateIcons 之后:', iArm > iHydrate, '(arm@'+iArm+', hydrate@'+iHydrate+')');
console.log('arm 已接线:', iArm > 0);
"`

Expected: 三行都是 `true`

- [ ] **Step 4: 跑全量测试**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && npm test 2>&1 | tail -20`

Expected: 与 Task 6 结束时一致

---

## Task 8: 三处上传入口去双重归因

**Files:**
- Modify: `public/js/req-chat.js:559-561`
- Modify: `public/js/req-view.js:1461-1463`
- Modify: `public/js/composer.js:170-173`
- Modify: `public/js/req-chat.apidoc.test.js`（追加用例）

- [ ] **Step 1: 先写失败的测试**

在 `public/js/req-chat.apidoc.test.js` 文件末尾追加：

```js
test('后端不可达时：toast 说系统故障，不叠加业务前缀（回归：Failed to fetch 被当成上传功能坏了）', async () => {
  const data = devReq();
  const input = await mountAndGetFileInput(data);

  // 模拟 bootstrap.js 的 fetch 包装分类后抛出的错误
  globalThis.fetch = async () => {
    throw Object.assign(new Error('后端未连接'), { isNetworkError: true });
  };
  toastCalls = [];

  await pickFile(input);

  const errors = toastCalls.filter(([kind]) => kind === 'error');
  assert.equal(errors.length, 1, `应只弹一条错误，实际：${JSON.stringify(toastCalls)}`);
  const [, msg] = errors[0];
  assert.equal(msg, '后端未连接', `系统故障不该叠业务前缀，实际：「${msg}」`);
  assert.ok(!msg.includes('API 文档上传失败'), '不该把后端掉线说成上传功能失败');
  assert.ok(!msg.includes('Failed to fetch'), '不该把浏览器原文透给用户');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && node --test public/js/req-chat.apidoc.test.js 2>&1 | tail -20`

Expected: FAIL，实际 msg 是 `API 文档上传失败：后端未连接`

- [ ] **Step 3: 改 req-chat.js**

把 `public/js/req-chat.js:559-561` 这段：

```js
    } catch (e) {
      window.toast.error('API 文档上传失败：' + (e?.message || e));
    }
```

改为：

```js
    } catch (e) {
      // 后端整体不可达是系统故障，叠「API 文档上传失败」会把它说成功能故障
      //（掉线罩已由 net-guard 升起，这条 toast 只是补一句就地说明）
      if (e?.isNetworkError) window.toast.error(e.message);
      else window.toast.error('API 文档上传失败：' + (e?.message || e));
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && node --test public/js/req-chat.apidoc.test.js 2>&1 | tail -20`

Expected: 全部 pass（含原有用例）

- [ ] **Step 5: 同样改 req-view.js**

把 `public/js/req-view.js:1461-1463`：

```js
    } catch (err) {
      window.toast.error('上传失败：' + (err?.message || err));
    }
```

改为：

```js
    } catch (err) {
      // 同 req-chat：系统故障不叠业务前缀
      if (err?.isNetworkError) window.toast.error(err.message);
      else window.toast.error('上传失败：' + (err?.message || err));
    }
```

- [ ] **Step 6: 同样改 composer.js**

把 `public/js/composer.js:170-173`：

```js
        } catch (err) {
          chip.remove();
          window.toast.error('文件上传失败：' + (err && err.message ? err.message : err));
        }
```

改为：

```js
        } catch (err) {
          chip.remove();
          // 同 req-chat：系统故障不叠业务前缀
          if (err?.isNetworkError) window.toast.error(err.message);
          else window.toast.error('文件上传失败：' + (err && err.message ? err.message : err));
        }
```

三处的业务前缀刻意保留原样（「API 文档上传失败」/「上传失败」/「文件上传失败」），
只统一分支结构。统一文案属于无关重构，不在本次范围。

- [ ] **Step 7: 跑全量测试**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && npm test 2>&1 | tail -20`

Expected: 全绿，且比 Task 7 多出 11 个通过用例（offline-overlay 5 + net-guard 5 + apidoc 1）

---

## Task 9: 端到端手工验证

单测覆盖不到「真把后端杀掉」这条路径，必须手工走一遍。

- [ ] **Step 1: 起后端**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && node src/entrypoints/web/server.js`

Expected: 打印 `claude 本地执行台 (web) 已启动` + `http://127.0.0.1:3000`

- [ ] **Step 2: 浏览器打开 http://127.0.0.1:3000，确认启动罩正常撤掉**

检查项：
- 启动罩出现后正常淡出，界面可点（验 Task 1 的 `[hidden]` 规则 + Task 2 的改动）
- DevTools Elements 里 `#bootOverlay` 仍在 DOM 中且带 `hidden` 属性（不是被 remove）
- Console 无报错

- [ ] **Step 3: 杀掉后端，观察掉线罩**

在起后端的终端按 `Ctrl+C`，然后在页面上点任意需要请求的操作（如切到「需求」列表）。

Expected:
- 30 秒内（最慢一路轮询周期）自动升起掉线罩
- 罩子显示六芒星**且在旋转**（验 `#offlineStar #obtri1` 动画规则）
- 文案「服务器后台异常」+「正在尝试重新连接…」
- 有「重新加载」按钮，没有「仍然进入」
- 罩子盖住整个界面

- [ ] **Step 4: 重启后端，观察自动撤罩**

Run: `cd "C:/Users/DELL/Desktop/claude-p-web-demo" && node src/entrypoints/web/server.js`

Expected: 2 秒内掉线罩自动消失，界面恢复可用（无需手动刷新）

- [ ] **Step 5: 验证「重新加载」按钮**

再次 `Ctrl+C` 杀后端，等罩子升起，点「重新加载」。

Expected: 页面重载；后端仍不通，所以停在**启动罩**（`正在启动服务…`）而不是掉线罩
——这是对的，此时归 boot-gate 管。

- [ ] **Step 6: 验证误报防护**

重启后端，等界面恢复。然后触发一个必然 4xx/5xx 的业务错误——例如在需求列表里
对一个不存在的 id 发请求（或直接在 Console 跑
`fetch('/api/req/get?id=nope').then(r=>console.log('status',r.status))`）。

Expected: **不升罩**。业务错误（resolve 但 `!r.ok`）不该被当成掉线。

- [ ] **Step 7: 清理**

杀掉手工起的后端进程。检查 `.uploads/` 里有无验证时产生的测试文件，按需清理。

---

## 验收标准

- [ ] `npm test` 全绿，新增 11 个用例
- [ ] Task 9 的 7 步手工验证全部符合 Expected
- [ ] `git status` 里只有本计划「文件结构」表中列出的文件被改动
- [ ] 没有任何 `git commit`（提交时机由用户掌控）

## 已知限制

本次改动在浏览器直访与 `tauri dev` 下立即生效，但**影响不到用户机器上已安装的那个应用**
——它的 identifier 是 `com.claudeagent.desktop`，跑的是
`C:\Program Files\claude-agent-desktop\sidecar\server.js` 的旧快照，而当前
`tauri.conf.json` 已是 `com.vibecoding.desktop`。要让桌面版生效需重新打包安装。

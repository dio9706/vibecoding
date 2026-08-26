# 原生拖拽转路径 与 迁移 opener 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **本仓约定覆盖技能默认**：用户规则明确「不要自动 git 提交，改动留工作区」。因此本计划**不含任何 git commit 步骤**，每个任务以「验证点」收尾。提交时机由用户掌控。

**Goal:** 桌面端拖入文件/文件夹直接转为真实本地路径（零副本），并修复点击路径 chip 报「打开失败：未知错误」。

**Architecture:** 移除 `disable_drag_drop_handler()` 恢复 Tauri 原生拖拽，新增拖拽总线按落点把 `tauri://drag-*` 分派给多个拖拽区；路径打开能力从已废弃的 `shell.open` 迁到 `tauri-plugin-opener` 的 `revealItemInDir`。Web 模式行为完全不变。

**Tech Stack:** Tauri v2（Rust）、原生 ESM 前端（无构建）、Node 内置 `node --test` + jsdom

**Spec:** `docs/superpowers/specs/2026-08-17-native-drag-drop-and-opener-design.md`

---

## 任务顺序说明（重要）

Task 6 之前，`disable_drag_drop_handler()` 仍在生效，`tauri://drag-*` 不会 emit，所以 Task 2/4/5 新增的总线代码处于「已注册但不触发」的休眠态，HTML5 老路线继续工作。**应用在任何一个任务结束时都是可用的**，不存在中间损坏态。Task 6 才是一次性切换。

Task 3 独立于拖拽改造，做完即可单独验证「问题二」已修复。

---

## 文件结构

| 文件 | 职责 | 变更 |
|---|---|---|
| `src/entrypoints/web/routes-files.js` | 文件类 HTTP handler | 新增 `statPaths` / `validateReadPath` 纯函数 + 两个 handler |
| `src/entrypoints/web/routes-files.fs.test.js` | 上述纯函数单测 | 新建 |
| `src/entrypoints/web/server.js` | 路由表 | 注册 2 条路由 |
| `public/js/drag-bus.js` | 原生拖拽事件 → 按落点分派给拖拽区 | 新建 |
| `public/js/drag-bus.test.js` | 坐标换算与命中判定单测 | 新建 |
| `public/vendor/tauri/plugin-opener.js` | opener 的 JS 绑定 | 新建（手工 vendor） |
| `public/js/tauri-init.js` | Tauri API 初始化 | 移除单槽位 `_dropCb`；shell.open → opener |
| `public/js/chat.js` | 聊天体 | chip 点击改 reveal + 修错误提取；接入总线；摘 HTML5 监听 |
| `public/js/composer.js` | 富输入 composer | 新增 `insertDroppedPaths`；`insertPathChip` 接真实 kind |
| `public/js/markdown-tool.js` | Markdown 查看器 | 拆双入口；接入总线；修 history/export/展示 |
| `src-tauri/src/main.rs` | 窗口与插件 | 移除 `disable_drag_drop_handler()`；注册 opener |
| `src-tauri/Cargo.toml` | Rust 依赖 | 加 `tauri-plugin-opener` |
| `src-tauri/capabilities/default.json` | 权限清单 | `shell:allow-open` → `opener:default` |
| `src-tauri/tauri.conf.json` | Tauri 配置 | 放宽 `assetProtocol.scope.allow` |

---

## Task 1: 后端 `/api/fs/stat` 与 `/api/fs/read`

**Files:**
- Modify: `src/entrypoints/web/routes-files.js`
- Modify: `src/entrypoints/web/server.js:55-63`（import）、`:151` 附近（路由）
- Test: `src/entrypoints/web/routes-files.fs.test.js`（新建）

拆出 `statPaths` / `validateReadPath` 两个**纯函数**是为了可测——handler 依赖 req/res，纯函数不依赖，测试不需要起 HTTP server。

- [ ] **Step 1: 写失败测试**

创建 `src/entrypoints/web/routes-files.fs.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { statPaths, validateReadPath } from './routes-files.js';

test('statPaths 区分文件 / 目录 / 不存在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsstat-'));
  const file = path.join(dir, 'a.md');
  fs.writeFileSync(file, 'hello');

  const [rFile, rDir, rMissing] = statPaths([file, dir, path.join(dir, 'nope.md')]);
  assert.equal(rFile.kind, 'file');
  assert.equal(rFile.size, 5);
  assert.equal(rDir.kind, 'dir');
  assert.equal(rMissing.kind, 'missing');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('statPaths 对非字符串与空串归为 missing 而不抛异常', () => {
  // str() 是 fail-closed 的：非字符串归空串。这里确认不会因为脏输入炸掉整个批次
  const r = statPaths([null, 123, '', {}]);
  assert.equal(r.length, 4);
  assert.ok(r.every((x) => x.kind === 'missing'));
});

test('statPaths 无扩展名文件判为 file 而非 dir', () => {
  // 旧的前端启发式（最后一段不含 . 即目录）会把 Dockerfile 判成文件夹，
  // 引入这个接口的首要动机就是消灭这类误判
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsstat-'));
  const file = path.join(dir, 'Dockerfile');
  fs.writeFileSync(file, 'FROM node');
  assert.equal(statPaths([file])[0].kind, 'file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateReadPath 只放行绝对路径的 .md / .markdown', () => {
  assert.equal(validateReadPath('relative.md').ok, false);
  assert.equal(validateReadPath('').ok, false);
  assert.equal(validateReadPath(null).ok, false);

  const abs = process.platform === 'win32' ? 'C:\\tmp\\a.exe' : '/tmp/a.exe';
  assert.equal(validateReadPath(abs).ok, false);

  const ok = process.platform === 'win32' ? 'C:\\tmp\\a.MD' : '/tmp/a.MD';
  assert.equal(validateReadPath(ok).ok, true, '扩展名判定须大小写不敏感');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test 2>&1 | grep -A3 "fs.test"`
Expected: FAIL，报 `statPaths` / `validateReadPath` 不是导出的函数

- [ ] **Step 3: 实现两个纯函数 + 两个 handler**

在 `src/entrypoints/web/routes-files.js` 的 `handleUpload` 定义之前插入：

```js
/** Markdown 读取白名单：只放行这两个扩展名，避免 /api/fs/read 变成通用任意文件读取 */
const READ_EXTS = new Set(['.md', '.markdown']);
const READ_MAX = 10 * 1024 * 1024; // 10MB

/**
 * 纯函数：批量判断路径类型。
 *
 * 设计为批量而非单条——一次拖拽可能带入数十个文件，逐个 HTTP 请求过于碎片化。
 * 任何异常都归为 'missing' 而不上抛：一个脏路径不该让整批拖拽失败。
 *
 * @param {unknown[]} paths
 * @returns {{path:string, kind:'file'|'dir'|'missing', size?:number, mtime?:number}[]}
 */
export function statPaths(paths) {
  return (Array.isArray(paths) ? paths : []).map((raw) => {
    const p = str(raw);
    if (!p) return { path: '', kind: 'missing' };
    try {
      const st = fs.statSync(p); // 跟随符号链接：指向普通文件的软链应视为文件
      if (st.isDirectory()) return { path: p, kind: 'dir' };
      if (st.isFile()) return { path: p, kind: 'file', size: st.size, mtime: st.mtimeMs };
      return { path: p, kind: 'missing' }; // 管道 / 设备等特殊文件按不存在处理
    } catch {
      return { path: p, kind: 'missing' };
    }
  });
}

/**
 * 纯函数：校验 /api/fs/read 的 path 参数。
 * @returns {{ok:true, path:string}|{ok:false, error:string}}
 */
export function validateReadPath(raw) {
  const p = str(raw);
  if (!p) return { ok: false, error: '缺少 path 参数' };
  if (!path.isAbsolute(p)) return { ok: false, error: '仅支持绝对路径' };
  if (!READ_EXTS.has(path.extname(p).toLowerCase())) {
    return { ok: false, error: '仅支持 .md / .markdown 文件' };
  }
  return { ok: true, path: p };
}

/** POST /api/fs/stat —— body { paths: string[] }，批量返回类型。上限 200 条防滥用。 */
export function handleFsStat(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const paths = Array.isArray(data?.paths) ? data.paths.slice(0, 200) : [];
    sendJson(res, 200, { results: statPaths(paths) });
  });
}

/**
 * GET /api/fs/read?path= —— 读 Markdown 内容。
 *
 * 安全边界：扩展名白名单 + 必须是普通文件 + 10MB 上限。大小在读之前用 stat 拦，
 * 不能先 readFileSync 再判——那样 1GB 文件已经进了内存。
 */
export function handleFsRead(url, res) {
  const v = validateReadPath(url.searchParams.get('path'));
  if (!v.ok) return sendJson(res, 400, { error: v.error });
  let st;
  try {
    st = fs.statSync(v.path);
  } catch {
    return sendJson(res, 404, { error: '文件不存在：' + v.path });
  }
  if (!st.isFile()) return sendJson(res, 400, { error: '不是普通文件' });
  if (st.size > READ_MAX) return sendJson(res, 413, { error: '文件过大（>10MB）' });
  try {
    sendJson(res, 200, { content: fs.readFileSync(v.path, 'utf8'), size: st.size, mtime: st.mtimeMs });
  } catch (e) {
    sendJson(res, 500, { error: '读取失败：' + (e?.message || e) });
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: fail 0

- [ ] **Step 5: 注册路由**

`src/entrypoints/web/server.js:55-63` 的 import 块加两个名字：

```js
import {
  handleUpload,
  handleScriptUpload,
  handleBrowse,
  handlePickDir,
  handleSaved,
  handleFsStat,
  handleFsRead,
  serveStatic,
  pruneUploads,
} from './routes-files.js';
```

在 `server.js:151` 的 `/api/upload` 那行之后插入：

```js
  if (url.pathname === '/api/fs/stat') return handleFsStat(req, res);
  if (url.pathname === '/api/fs/read') return handleFsRead(url, res);
```

- [ ] **Step 6: 验证点（不提交）**

Run: `npm start`，另开终端：

```bash
curl -s -X POST http://127.0.0.1:9701/api/fs/stat -H 'Content-Type: application/json' -d '{"paths":["C:/Windows","C:/Windows/notepad.exe","C:/nope"]}'
```
Expected: 依次返回 `dir` / `file` / `missing`

```bash
curl -s "http://127.0.0.1:9701/api/fs/read?path=C:/Windows/notepad.exe"
```
Expected: `{"error":"仅支持 .md / .markdown 文件"}`

---

## Task 2: 拖拽总线 `drag-bus.js`

**Files:**
- Create: `public/js/drag-bus.js`
- Test: `public/js/drag-bus.test.js`

**关键风险点**：`tauri://drag-*` payload 的 `position` 是**物理像素**，`elementFromPoint` 要 CSS 像素。Windows 显示缩放 150% 时不换算会命中错元素。这是本任务测试的第一优先级。

> **实施中发现并修正的致命缺陷（务必保留）**：`tauri://drag-*` 只投递给 target 为**具体 webview label** 的监听器——见 `tauri-2.11.5/src/manager/webview.rs:686-701` 的 `emit_to_webview`，其 `emit_filter` 谓词对 `EventTarget::Any` 返回 `false`。而 vendored `api-event.js` 的 `listen()` 默认 target 正是 `{ kind: 'Any' }`，会被静默挡掉。
>
> 因此四个 `listen` 必须显式传 `{ target: { kind: 'Webview', label } }`，label 取自 `window.__TAURI_INTERNALS__.metadata.currentWebview.label`（对照官方 `@tauri-apps/api/webview.js:203-214` 的 `Webview.listen`）。
>
> 不这么写的后果：Task 6 翻完开关后拖拽**完全无反应且零报错**。项目原有的 `tauri-init.js` 里那个 `event.listen('tauri://drag-drop', ...)` 就是这个错，属遗留问题，Task 4 会一并删除。
>
> 附带收益：target 锁定当前 webview，多窗口（`main`/`win-2`/…）下别的窗口的 drop 不会串扰。

> 相对 spec §3.1 的一处简化：命中判定用 `zone.el.contains(el)` 而非 `closest('[data-drop-zone]')`，等效但不需要给 DOM 加属性。

- [ ] **Step 1: 写失败测试**

创建 `public/js/drag-bus.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { toCssPoint, hitZone } from './drag-bus.js';

test('toCssPoint 按 devicePixelRatio 换算物理像素', () => {
  // Windows 150% 缩放：物理 (300,150) 对应 CSS (200,100)。
  // 不换算的话 elementFromPoint 会取到右下方完全不同的元素
  assert.deepEqual(toCssPoint({ x: 300, y: 150 }, 1.5), { x: 200, y: 100 });
  assert.deepEqual(toCssPoint({ x: 10, y: 20 }, 1), { x: 10, y: 20 });
});

test('toCssPoint 对缺失 position 与 dpr=0 不产生 NaN/Infinity', () => {
  assert.deepEqual(toCssPoint(undefined, 0), { x: 0, y: 0 });
  assert.deepEqual(toCssPoint({}, undefined), { x: 0, y: 0 });
});

test('hitZone 命中子元素时归属其所在拖拽区', () => {
  const dom = new JSDOM('<!doctype html><body><div id="zone"><span id="kid">x</span></div></body>');
  const doc = dom.window.document;
  const zoneEl = doc.getElementById('zone');
  const kid = doc.getElementById('kid');
  doc.elementFromPoint = () => kid; // jsdom 不做布局，直接桩掉

  const zone = { el: zoneEl };
  assert.equal(hitZone(doc, [zone], { x: 1, y: 1 }), zone);
});

test('hitZone 落在任何拖拽区之外返回 null', () => {
  const dom = new JSDOM('<!doctype html><body><div id="zone"></div><div id="other"></div></body>');
  const doc = dom.window.document;
  doc.elementFromPoint = () => doc.getElementById('other');
  assert.equal(hitZone(doc, [{ el: doc.getElementById('zone') }], { x: 1, y: 1 }), null);
});

test('hitZone 在 elementFromPoint 返回 null 时不抛异常', () => {
  const dom = new JSDOM('<!doctype html><body><div id="zone"></div></body>');
  const doc = dom.window.document;
  doc.elementFromPoint = () => null; // 拖到窗口空白处
  assert.equal(hitZone(doc, [{ el: doc.getElementById('zone') }], { x: 0, y: 0 }), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test public/js/drag-bus.test.js`
Expected: FAIL，`Cannot find module ... drag-bus.js`

- [ ] **Step 3: 实现 drag-bus.js**

创建 `public/js/drag-bus.js`：

```js
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
 * 用 elementFromPoint + contains 而不是逐个 getBoundingClientRect 比对：
 * 前者天然处理元素层叠、容器滚动、面板隐藏三种情况。
 */
export function hitZone(doc, zoneList, pt) {
  const el = doc.elementFromPoint(pt.x, pt.y);
  if (!el) return null;
  return zoneList.find((z) => z.el && (z.el === el || z.el.contains(el))) || null;
}

/**
 * 接上 Tauri 事件源。由 tauri-init.js 在拿到 event 模块后调用一次。
 * @param {{listen:Function}} ev Tauri event 模块
 */
export function attachDragBus(ev) {
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

  ev.listen('tauri://drag-enter', onOver).catch((err) => console.error('[DragBus] drag-enter:', err));
  ev.listen('tauri://drag-over', onOver).catch((err) => console.error('[DragBus] drag-over:', err));
  ev.listen('tauri://drag-leave', leaveCurrent).catch((err) => console.error('[DragBus] drag-leave:', err));

  ev.listen('tauri://drag-drop', (e) => {
    leaveCurrent();
    const paths = e.payload?.paths;
    if (!Array.isArray(paths) || !paths.length) return;
    const pt = toCssPoint(e.payload?.position, window.devicePixelRatio);
    const z = hitZone(document, zones, pt);
    if (z) z.onDrop(paths, pt);
    // 落在任何拖拽区之外：什么都不做。不静默也不报错——用户拖到了标题栏之类的地方
  }).catch((err) => console.error('[DragBus] drag-drop:', err));
}

// markdown-tool.js 以传统 <script> 引入（index.html:610），不是 ES module，
// 拿不到 import，只能走 window 桥
window.dragBus = { registerDropZone };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test public/js/drag-bus.test.js`
Expected: 5 个测试全 pass

- [ ] **Step 5: 验证点（不提交）**

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: fail 0（确认没打破既有测试）

---

## Task 3: 迁移到 tauri-plugin-opener（修复问题二）

**Files:**
- Modify: `src-tauri/Cargo.toml:22` 附近
- Modify: `src-tauri/src/main.rs:784` 附近
- Modify: `src-tauri/capabilities/default.json:35`
- Create: `public/vendor/tauri/plugin-opener.js`
- Modify: `public/js/tauri-init.js:39-88`、`:322`、`:343`
- Modify: `public/js/chat.js:975`、`:1005-1019`

**不可删除 shell 插件**：sidecar 启动依赖 `shell:allow-execute`（`capabilities/default.json:25-34` 那条带 validator 的规则）。本任务只替换 open 能力。

- [ ] **Step 1: 装 npm 包并 vendor**

```bash
npm i -D @tauri-apps/plugin-opener
cp node_modules/@tauri-apps/plugin-opener/dist-js/index.js public/vendor/tauri/plugin-opener.js
```

- [ ] **Step 2: 改写 vendor 产物的 import 说明符并确认命令名**

CSP 已收紧为 `script-src 'self'`，裸包说明符与远程 import 都不可用（见 `docs/TAURI_SETUP.md:126-129`）。把 `public/vendor/tauri/plugin-opener.js` 首行的 `from '@tauri-apps/api/core'` 改为 `from './api-core.js'`。

同时读一遍该文件，记下三个实际的 invoke 命令名与参数名，后续步骤要用（预期为 `plugin:opener|open_url` 带参数 `url`、`plugin:opener|reveal_item_in_dir` 带参数 `path`）：

Run: `grep -n "invoke(\|^import\|export {" public/vendor/tauri/plugin-opener.js`
Expected: 首行 import 已指向 `./api-core.js`；能看到 `openUrl` / `openPath` / `revealItemInDir` 三个导出与各自的 invoke 命令名

**若实际命令名或参数名与预期不符，以文件内容为准**，并同步修正 Step 6 的 fallback 代码。

- [ ] **Step 3: Rust 侧加依赖与插件**

`src-tauri/Cargo.toml`，在 `tauri-plugin-shell = "2.0"` 那行下面加：

```toml
tauri-plugin-opener = "2"
```

`src-tauri/src/main.rs:784` 的 `.plugin(tauri_plugin_shell::init())` 下面加一行：

```rust
        .plugin(tauri_plugin_opener::init())
```

- [ ] **Step 4: 换权限**

`src-tauri/capabilities/default.json` 把最后一项 `"shell:allow-open"` 替换为 `"opener:default"`，并在该文件 `description` 字段末尾追加一句说明（该文件是 JSON，注释只能写在 description 里）：

```
opener:default = allow-open-url + allow-reveal-item-in-dir + allow-default-urls(限 http/https/mailto/tel)，
刻意不含 allow-open-path——后者会放开「用默认程序打开任意路径」，.exe/.bat/.lnk 将被直接执行，
等于把 XSS 放大成 RCE。原 shell:allow-open 的 scope 正则只认 URL，本地路径必被拒（这正是
「打开失败：未知错误」的成因），迁 opener 后由 reveal_item_in_dir 承担定位职责，不执行目标文件。
```

- [ ] **Step 5: 编译确认 Rust 侧无误**

Run: `cd src-tauri && cargo check`
Expected: `Finished` 无 error（首次会拉取 tauri-plugin-opener，耗时较长）

- [ ] **Step 6: 改 tauri-init.js**

> 本步连改 6 处，一律用代码锚点搜索定位——改完前几处后行号即失效。

把 `let openPath = null;` 改为：

```js
            // shell.open 自 tauri-plugin-shell 2.1.0 起废弃，且其 scope 正则只认 URL，
            // 本地路径必然被拒。改用 opener：revealItemInDir 走系统文件管理器定位，
            // 不执行目标文件，无 RCE 面。
            let revealPath = null;
            let openUrl = null;
```

把这两行（连同其上方那条「Tauri v2 shell 已拆为独立插件」的注释）：

```js
              // Tauri v2 shell 已拆为独立插件 @tauri-apps/plugin-shell，不在 @tauri-apps/api 内
              openPath = (await import('/vendor/tauri/plugin-shell.js')).open;
```

改为：

```js
              const opener = await import('/vendor/tauri/plugin-opener.js');
              revealPath = opener.revealItemInDir;
              openUrl = opener.openUrl;
```

把 `window.tauriApi = { ... }` 里的 `openPath,` 那一行改为：

```js
              revealPath,
              openUrl,
```

把外链拦截里的这一块（注意撤下 `shell:allow-open` 后这两处 fallback 不改就会静默失效）：

```js
              if (openPath) {
                openPath(url.href).catch((err) => {
                  console.warn('[App] shell.open failed, fallback to invoke:', err);
                  invoke('plugin:shell|open', { path: url.href }).catch(console.error);
                });
              } else {
                // openPath 加载失败时直接 invoke shell 插件命令
                invoke('plugin:shell|open', { path: url.href }).catch(console.error);
              }
```

改为：

```js
              if (openUrl) {
                openUrl(url.href).catch((err) => {
                  console.warn('[App] opener.openUrl failed, fallback to invoke:', err);
                  invoke('plugin:opener|open_url', { url: url.href }).catch(console.error);
                });
              } else {
                // vendor 加载失败时直接 invoke opener 插件命令
                invoke('plugin:opener|open_url', { url: url.href }).catch(console.error);
              }
```

非 Tauri 环境与初始化失败两处降级实现里各有一行 `openPath: null,`（共 2 处，`grep -n "openPath: null" public/js/tauri-init.js` 可定位），各改为：

```js
              revealPath: null,
              openUrl: null,
```

- [ ] **Step 7: 改 chat.js 的 chip 点击**

在 `makePathChip` 里，把 `chip.title = '点击打开目录';` 与 `chip.title = '点击打开所在文件夹';` **两处**都改为：

```js
          chip.title = '点击在文件夹中定位';
```

把同一函数内的 `handlePathChipClick(path, kind);` 改为 `handlePathChipClick(path);`（`kind` 仍用于选图标，只是点击行为不再区分），并把整个 `handlePathChipClick` 函数替换为：

```js
      /**
       * 处理路径 chip 点击：Tauri 在文件管理器中定位，Web 复制路径。
       *
       * 文件与目录都直接 reveal 目标本身（在其父目录中被选中）。不再手工截父目录——
       * 那个写法在根目录、结尾带分隔符时会算出空串。
       */
      async function handlePathChipClick(path) {
        if (!window.tauriApi?.revealPath) {
          // Web 模式：复制路径
          try {
            await navigator.clipboard.writeText(path);
            toast('已复制路径：' + path);
          } catch {
            toast('复制失败');
          }
          return;
        }

        try {
          await window.tauriApi.revealPath(path);
        } catch (err) {
          console.error('revealPath failed:', err);
          // Tauri 命令 reject 回传的是**序列化后的字符串**（插件 Error 的 Serialize
          // 走 serialize_str），对字符串取 .message 恒为 undefined——原先写 err?.message
          // 把 scope 校验失败的真实原因吞成了「未知错误」，正是本 bug 难查的直接原因。
          const msg = typeof err === 'string' ? err : (err?.message ?? JSON.stringify(err));
          toast('打开失败：' + msg);
        }
      }
```

- [ ] **Step 8: 确认没有遗留的 shell.open 引用**

Run: `grep -rn "openPath\|plugin:shell|open" public/js/ | grep -v "plugin:shell|execute"`
Expected: 无输出（`shell:allow-execute` 相关的 sidecar 调用在 Rust 侧，不应出现在这里）

- [ ] **Step 9: 验证点（不提交）—— 问题二到此已可单独验收**

Run: `npm run tauri:dev`

手工验证：
1. 让 Claude 回复一条含本地文件绝对路径的消息（或翻历史会话找一条）
2. 点击文件 chip → **资源管理器打开并选中该文件**，不再弹「打开失败」
3. 点击目录 chip → 在父目录中定位选中（这是 spec §4.4 记录的**有意行为变更**）
4. 点击消息里的 http 外链 → 系统浏览器正常打开（验证 `opener:default` 的 `allow-default-urls` 覆盖 https）
5. 故意点一个已删除的路径 → toast 显示**具体错误原因**，不是「未知错误」

---

## Task 4: composer 接入拖拽总线

**Files:**
- Modify: `public/js/composer.js`（文件末尾的 `insertPathChip`）
- Modify: `public/js/chat.js`（顶部 import 块与紧随其后的 `bindTauriDrop` 调用）
- Modify: `public/js/tauri-init.js`（`_dropCb` 桥与 `tauri://drag-drop` 监听）

本任务结束时总线仍不触发（Task 6 才翻开关），HTML5 老路线继续工作，应用可用。

> **定位方式**：本任务及之后的任务一律用**代码锚点**而非行号——Task 1-3 已经改过这些文件，行号已漂移。每处给出待替换的原文，用编辑器搜索定位。

- [ ] **Step 1: 重写 composer.js 的 insertPathChip 并新增 insertDroppedPaths**

把 `public/js/composer.js` 末尾的 `insertPathChip` 整个替换为：

```js
      /**
       * Tauri 模式：把一批拖入的真实路径转成 chip。
       *
       * 先批量 stat 拿真实类型——旧版用「最后一段不含 . 即目录」的启发式，
       * 会把 README / Dockerfile / LICENSE 判成文件夹。
       */
      export async function insertDroppedPaths(paths) {
        const kinds = new Map();
        try {
          const r = await fetch('/api/fs/stat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths }),
          });
          const d = await r.json();
          for (const it of d.results || []) kinds.set(it.path, it.kind);
        } catch {
          // stat 失败不阻断拖拽：降级到扩展名启发式，chip 照常插入。
          // 拖拽是高频操作，不能因为后端抖动就完全不响应
        }
        for (const p of paths) insertPathChip(p, kinds.get(p));
      }

      /**
       * 插入本地路径 chip（Tauri 模式专用：零副本，Claude 直接读原路径）。
       * @param {string} absPath
       * @param {'file'|'dir'|'missing'} [kind] 来自 /api/fs/stat；缺省时退回扩展名启发式
       */
      export function insertPathChip(absPath, kind) {
        const lastSeg = absPath.split(/[/\\]/).filter(Boolean).pop() || absPath;
        const isDir = kind ? kind === 'dir' : !lastSeg.includes('.');
        const isImage = !isDir && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(lastSeg);
        // 本地图片走 asset 协议预览：原生路径下没有 File 对象，createObjectURL 不再适用。
        // 依赖 Cargo 的 protocol-asset feature 与 tauri.conf.json 的 assetProtocol.scope
        const convert = window.__TAURI__?.core?.convertFileSrc;
        const thumbUrl = isImage && convert ? convert(absPath) : '';
        const chip = makeChip({ path: absPath, name: lastSeg, isImage: !!thumbUrl, thumbUrl });
        if (isDir) {
          const ic = chip.querySelector('.att-ic');
          if (ic) ic.textContent = '📁';
        }
        if (kind === 'missing') {
          chip.classList.add('att-missing'); // 路径已不存在，视觉提示而不是静默丢弃
          chip.title = '路径不存在：' + absPath;
        }
        insertNodeAtCaret(chip);
      }
```

- [ ] **Step 2: 加 missing 态样式**

在 `public/app.css` 的 `.att-chip.uploading` 规则之后（约 :1094）加：

```css
/* 拖入时 stat 判定为不存在：仍插入 chip 但给出视觉警示，避免静默丢弃 */
.att-chip.att-missing {
  border-color: #d97706;
  opacity: 0.75;
}
```

- [ ] **Step 3: chat.js 换成总线注册**

把这一行（`insertPathChip` 在 chat.js 里仅此一处 import、一处调用，都在本步移除）：

```js
import { getPromptText, clearPrompt, handleDrop, insertPathChip } from './composer.js';
```

改为：

```js
import { getPromptText, clearPrompt, handleDrop, insertDroppedPaths } from './composer.js';
```

把 `import { bindTauriDrop } from './tauri-init.js';` 这一行改为：

```js
import { registerDropZone } from './drag-bus.js';
```

把下面这整块（紧跟在 `bindDirPopover(...)` 之后）：

```js
// Tauri 桌面版：文件/目录拖入直接插本地路径 chip，无需上传副本（Web 模式 _dropCb 为 null，不生效）
bindTauriDrop(({ paths }) => {
  const promptEl = document.querySelector('#prompt');
  if (promptEl) promptEl.classList.remove('dragover');
  paths.forEach(p => insertPathChip(p));
});
```

替换为：

```js
// Tauri 桌面版：文件/目录拖入直接插本地路径 chip，无需上传副本。
// 走拖拽总线而非旧的单槽位 bindTauriDrop——Markdown 查看器也要注册，单槽位会互相覆盖。
// Web 模式下总线永不触发（tauri://drag-* 不存在），HTML5 + 上传副本路线继续生效。
{
  const promptZoneEl = document.querySelector('#prompt');
  if (promptZoneEl) {
    registerDropZone({
      el: promptZoneEl,
      onDragOver: () => promptZoneEl.classList.add('dragover'),
      onDragLeave: () => promptZoneEl.classList.remove('dragover'),
      onDrop: (paths, pt) => {
        promptZoneEl.classList.remove('dragover');
        // 光标移到落点，附件插在拖放位置（与旧 HTML5 版行为保持一致）
        const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(pt.x, pt.y) : null;
        if (r && promptZoneEl.contains(r.startContainer)) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        }
        insertDroppedPaths(paths);
      },
    });
  }
}
```

- [ ] **Step 4: 移除 tauri-init.js 里的单槽位拖拽桥**

删除这一块：

```js
// 拖拽桥：Tauri 模式下文件/目录拖入时回调 chat.js 插入路径 chip（避免上传副本）。由 chat.js 注入。
let _dropCb = null;
export function bindTauriDrop(fn) {
  _dropCb = fn || null;
}
```

把这一块：

```js
            // ── 文件 / 目录拖入（Tauri 模式直接用本地路径，无需上传副本）──────────
            // payload: { paths: string[], position: { x, y } }
            event.listen('tauri://drag-drop', (ev) => {
              const paths = ev.payload?.paths;
              if (!Array.isArray(paths) || !paths.length) return;
              if (_dropCb) _dropCb({ paths, position: ev.payload?.position });
            }).catch(err => console.error('[Tauri Event] tauri://drag-drop:', err));
```

替换为（该处位于 `(async () => { ... })()` 内部，可直接用 `await import`）：

```js
            // ── 文件 / 目录拖入：交给拖拽总线按落点分派 ──────────
            // 原先这里是单槽位 _dropCb，第二个消费者注册会静默踢掉第一个
            const { attachDragBus } = await import('./drag-bus.js');
            attachDragBus(event);
```

- [ ] **Step 5: 确认没有遗留引用**

Run: `grep -rn "bindTauriDrop\|_dropCb" public/js/`
Expected: 无输出

- [ ] **Step 6: 验证点（不提交）**

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: fail 0

Run: `npm start`，浏览器开 `http://127.0.0.1:9701`，拖一个文件进输入框
Expected: Web 模式行为不变，仍走上传副本产生 chip（此时开关未翻，总线不触发）

---

## Task 5: Markdown 查看器接入总线 + 补完历史重开

**Files:**
- Modify: `public/js/markdown-tool.js`

> **本任务已于 2026-08-17 按文件现状重新锚定。** 原计划写于并行 session 重构 `markdown-tool.js` 之前，其锚点（`openFile` 内直接构造 `currentFile`、`handleHistoryClick` 用 `new File()` 重渲染当前文件）**已全部失效**，不要再参考旧版步骤。

### 现状变化（重新锚定的依据）

并行 session 已经重构了这个文件，且**顺带修掉了原计划的两个目标缺陷**：

1. 抽出了 `loadDocument({ path, content, modifiedTime, size })`，注释写明「磁盘打开与历史回看共用这一条路径，保证两边行为一致」。这是本任务理想的接入点。
2. `handleHistoryClick` 不再重渲染当前文件了 —— 现在 history 条目里缓存 `content`（带 `MD_CACHE_MAX_ONE` / `MD_CACHE_MAX_TOTAL` 双重配额），点击时从缓存 `loadDocument`。

但他们留了一个明确的口子（`markdown-tool.js` 的注释原文）：

> 正文没缓存（超限或被配额挤掉），浏览器拿不到原路径，只能请用户再选一次

**这个限制只在 Web 模式成立。** Tauri 模式有真实绝对路径，可以直接重新读盘。所以本任务从「重构」降级为「补完」：给 Tauri 模式补上按路径重读的能力。

### 仍然需要做的

| # | 事项 | 原因 |
|---|---|---|
| 1 | 新增 `openFileByPath(absPath)` | 走 `/api/fs/read` 取内容后交给 `loadDocument` |
| 2 | `setupDragDrop` 注册到拖拽总线 | 原生拖拽开启后 HTML5 drop 失效；Web 分支保留 |
| 3 | `handleHistoryClick` 的未缓存分支 | Tauri 下改为 `openFileByPath(item.path)`，不再让用户重选 |
| 4 | `updateHistory` 的 `name: file.path` | 路径变绝对后，侧栏会显示整条长路径 |
| 5 | `renderContent` 的 `fileName.textContent = path` | 同上，应显示短名、完整路径进 `title` |
| 6 | `exportHtml` 的 `a.download` 与 `<title>` | 绝对路径含 `\` 和 `:`，直接当下载名会失败；`<title>` 未转义是既有隐患 |

**不要改 `loadDocument` 的入参契约，也不要改 history 条目的字段结构** —— history 持久化在 localStorage 里，老条目的 `name` 存的是全路径。短名一律在**渲染时**用 helper 现算，这样老数据自动兼容。

### Step 1: 加 basename helper 与 `openFileByPath`

在类里加一个私有 helper（供第 4/5/6 项共用，避免三处各写一遍 split）：

```js
  // 取路径末段。history 持久化在 localStorage，老条目的 name 存的是全路径，
  // 所以短名一律渲染时现算，不改存储结构，老数据自动兼容。
  baseName(p) {
    return String(p || '').split(/[/\\]/).filter(Boolean).pop() || String(p || '');
  }
```

在 `openFile(file)` 之后新增：

```js
  /**
   * Tauri 模式：按绝对路径打开。
   *
   * 与 openFile(File) 的区别是拿得到真实路径，于是历史条目在正文缓存被配额挤掉之后
   * 仍能重新读盘——Web 模式做不到这点（浏览器不给绝对路径），只能请用户重选。
   */
  async openFileByPath(absPath) {
    const name = this.baseName(absPath);
    if (!name.endsWith('.md') && !name.endsWith('.markdown')) {
      this.showToast('仅支持 .md 或 .markdown 文件');
      return;
    }
    try {
      const r = await fetch('/api/fs/read?path=' + encodeURIComponent(absPath));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '读取失败');
      this.loadDocument({
        path: absPath,
        content: d.content,
        modifiedTime: d.mtime,
        size: d.size,
      });
    } catch (err) {
      console.error('文件读取失败', err);
      this.showToast('文件读取失败：' + (err?.message || err));
    }
  }
```

大小上限交给后端（`/api/fs/read` 有 10MB 拦截），不在前端重复判——前端判要先把内容传完才知道超限。

### Step 2: `setupDragDrop` 接总线

把整个 `setupDragDrop()` 替换为：

```js
  setupDragDrop() {
    const panel = document.querySelector('[data-view="markdown"]');
    if (!panel) return;

    // Tauri 原生拖拽：HTML5 drop 在原生模式下不再触发，改由总线按落点分派。
    // 本文件以传统 <script> 引入，不是 ES module，拿不到 import，只能走 window 桥。
    if (window.dragBus) {
      window.dragBus.registerDropZone({
        el: panel,
        onDrop: (paths) => { if (paths[0]) this.openFileByPath(paths[0]); },
      });
    } else if (window.tauriApi?.isTauri) {
      // 桌面版却拿不到总线 = 脚本加载顺序被改坏了。必须喊出来：
      // 否则表现为「Markdown 区拖拽毫无反应」，正是本次要消灭的那类静默失败
      console.error('[MarkdownTool] window.dragBus 缺失，Markdown 拖拽区将失效');
    }

    // Web 模式保留 HTML5 路线：浏览器拿不到绝对路径，只能走 File 对象
    panel.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        this.openFile(files[0]);
      }
    });
  }
```

**加载顺序前提**（已核实，无需改动）：`index.html` 以传统 `<script>` 引入 markdown-tool.js（解析时执行，只定义类），app.js 是 `type="module"`（deferred）。模块图执行时 chat.js 会 import drag-bus.js 从而设好 `window.dragBus`，而 `new MarkdownTool()` 在 DOMContentLoaded 里发生，晚于模块执行，所以 `window.dragBus` 一定已就绪。

### Step 3: 历史条目未缓存时，Tauri 直接重读盘

把 `handleHistoryClick` 里的未缓存分支：

```js
    if (!item.content) {
      // 正文没缓存（超限或被配额挤掉），浏览器拿不到原路径，只能请用户再选一次
      this.showToast(`「${item.name}」正文未缓存，请重新选择该文件`);
      this.promptOpenFile();
      return;
    }
```

改为：

```js
    if (!item.content) {
      // 正文没缓存（超限或被配额挤掉）。Tauri 下 path 是真实绝对路径，直接重读盘；
      // Web 模式浏览器不给绝对路径，只能请用户再选一次。
      if (window.tauriApi?.isTauri) {
        this.openFileByPath(item.path);
      } else {
        this.showToast(`「${this.baseName(item.name)}」正文未缓存，请重新选择该文件`);
        this.promptOpenFile();
      }
      return;
    }
```

### Step 4: 历史列表显示短名

`updateHistory` 里 `name: file.path,` 保持不动（存储结构不改）。改 `renderHistory`，把两处用到 `item.name` 的地方套上 helper：

```js
      name.textContent = this.baseName(item.name);
```

```js
      btn.title = item.content ? item.path : `${item.path}（正文未缓存，点击后需重新选择文件）`;
```

`title` 改用 `item.path`（完整路径）是刻意的：列表里显示短名，悬停才看全路径。

### Step 5: 文件名栏显示短名，完整路径进 title

`renderContent` 里把：

```js
    this.els.fileName.textContent = path;
```

改为：

```js
    // 路径改为真实绝对路径后，整条塞进文件名栏会撑爆布局；完整路径移到 title
    this.els.fileName.textContent = this.baseName(path);
    this.els.fileName.title = path;
```

### Step 6: 导出的文件名与 title

把 `exportHtml` 里的 `const { path } = this.state.currentFile;` 改为：

```js
    const { path } = this.state.currentFile;
    const base = this.baseName(path);
    // 未转义的路径直接进 <title> 是既有 XSS 隐患，路径变长后更值得顺手堵掉
    const safeTitle = base.replace(/[<>&"]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
```

把模板串里的 `<title>${path}</title>` 改为 `<title>${safeTitle}</title>`

把 `a.download = path.replace('.md', '.html');` 改为：

```js
    // 绝对路径含 \ 与 :，直接作为下载名会失败，必须取 basename；
    // 且原写法 replace('.md','.html') 会命中路径中间的 .md 子串
    a.download = base.replace(/\.(md|markdown)$/i, '') + '.html';
```

### Step 7: 验证（不提交）

Run: `grep -n "this.openFile(\|openFileByPath\|baseName" public/js/markdown-tool.js`
Expected: `openFile(` 仅剩 `promptOpenFile` 与 Web drop 两处调用；`openFileByPath` 有定义 + 拖拽 + 历史两处调用。

语法检查（`node --check` 对 `.js` 按 CJS 解析，本文件是传统脚本非 ESM，可直接 check）：

Run: `node --check public/js/markdown-tool.js`
Expected: 无输出

Run: `npm test 2>&1 | tail -15`
Expected: fail 0

Run: `npm start`，浏览器开 `http://127.0.0.1:9701`，切到 Markdown 视图拖入一个 `.md`
Expected: 正常渲染（Web 路线未受影响）；导出 HTML 的文件名正常、不含路径分隔符

---

## Task 6: 翻开关 —— 启用原生拖拽

到此为止所有前置都已就位。本任务同时完成三件必须一起做的事：开原生拖拽、摘掉失效的 HTML5 监听、放宽 asset scope。分开做会留下损坏态。

**Files:**
- Modify: `src-tauri/src/main.rs`（`create_app_window_ctx` 的 builder 链与其上方注释）
- Modify: `src-tauri/tauri.conf.json`（`assetProtocol.scope`）
- Modify: `public/js/chat.js`（`promptEl` 的三个拖拽监听）
- Modify: `public/js/composer.js`（`handleDrop` 头部注释）

- [ ] **Step 1: 移除 disable_drag_drop_handler**

把这两行：

```rust
    .visible(false)  // 防启动白闪：先隐藏，页面加载完成（on_page_load Finished）再显示
    .disable_drag_drop_handler();  // v2 正确 API：解除 Webview 层文件拖入拦截，让 HTML5 drop 事件生效
```

替换为这一行（注意分号原本挂在被删的那行末尾，必须补到 `.visible(false)` 上）：

```rust
    .visible(false);  // 防启动白闪：先隐藏，页面加载完成（on_page_load Finished）再显示
```

同时把 `create_app_window` 上方那段以 `/// disable_drag_drop_handler()：Tauri v2 正确 API` 开头的四行文档注释，连同其首行 `/// 创建一个应用窗口...`，整体替换为：

```rust
/// 创建一个应用窗口（单实例架构下多开共用同一后端/托盘，仅多一个 webview 窗口）。
/// 刻意**不调用** disable_drag_drop_handler()：保留 Tauri 的 Webview IDropTarget 拦截，
/// 让 tauri://drag-* 事件正常 emit，前端才能拿到拖入项的**真实本地绝对路径**（并支持文件夹）。
/// 代价是 webview 内 HTML5 drop 的 dataTransfer.files 恒空——所有文件拖拽区必须
/// 走 public/js/drag-bus.js 的落点分派，不能再绑 DOM drop 事件。
```

- [ ] **Step 2: 放宽 assetProtocol scope**

把 `src-tauri/tauri.conf.json` 的 `assetProtocol.scope.allow` 从 `["$HOME/**"]` 改为：

```json
        "scope": {
          "allow": ["**"],
          "deny": ["$HOME/.ssh/**", "$HOME/.aws/**", "$HOME/.gnupg/**"]
        }
```

改用真实路径后拖入的图片可能落在 `$HOME` 之外（D 盘、外接盘），scope 不放宽时缩略图会**静默**降级成文件 chip（`makeImageElement` 的 `img.onerror` 兜底），无任何报错，排查成本极高。

- [ ] **Step 3: 摘掉输入框的 HTML5 拖拽监听**

把这三个监听（紧跟在 `promptEl` 的 `keydown` 监听之后）：

```js
      promptEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        promptEl.classList.add('dragover');
      });
      promptEl.addEventListener('dragleave', (e) => {
        if (!promptEl.contains(e.relatedTarget)) promptEl.classList.remove('dragover');
      });
      promptEl.addEventListener('drop', handleDrop);
```

改为仅在非 Tauri 时绑定：

```js
      // Web 模式才绑 HTML5 拖拽：Tauri 原生拖拽开启后 dataTransfer.files 恒空，
      // 这三个监听永不触发，留着就是下一批死代码（本次 bug 正是这么产生的）
      if (!window.tauriApi?.isTauri) {
        promptEl.addEventListener('dragover', (e) => {
          e.preventDefault();
          promptEl.classList.add('dragover');
        });
        promptEl.addEventListener('dragleave', (e) => {
          if (!promptEl.contains(e.relatedTarget)) promptEl.classList.remove('dragover');
        });
        promptEl.addEventListener('drop', handleDrop);
      }
```

- [ ] **Step 4: 修掉 composer.js 里那条与现实相反的注释**

把 `handleDrop` 开头这两行：

```js
      export function handleDrop(e) {
        // dragover 样式无论有无文件都清掉（Tauri 模式下 dataTransfer.files 为空但 DOM drop 仍触发）
        promptEl.classList.remove('dragover');
```

改为（原注释描述的是加 `disable_drag_drop_handler()` **之前**的行为，与现实相反）：

```js
      /** Web 模式的 HTML5 拖拽入口：浏览器拿不到本地绝对路径，只能读内容上传副本。
       *  Tauri 模式不会走到这里（原生拖拽已接管，见 drag-bus.js）。 */
      export function handleDrop(e) {
        promptEl.classList.remove('dragover');
```

- [ ] **Step 5: 编译**

Run: `cd src-tauri && cargo check`
Expected: `Finished` 无 error

- [ ] **Step 6: 验证点（不提交）**

Run: `npm run tauri:dev`，然后执行 Task 7 的完整清单。

---

## Task 7: 实机验证清单

原生拖拽无法自动化测试（需真实 OS 拖放），以下逐条手工执行。**任一条失败即回到对应任务修复，不要继续往下走。**

Run: `npm run tauri:dev`

- [ ] **1. 单文件零副本**：拖一个文件进输入框 → chip 显示真实路径；确认 `.uploads` 无新增文件

  Run（拖之前记数，拖之后再记一次）：`ls "$APPDATA/com.vibecoding.desktop/.uploads" | wc -l`
  Expected: 两次数字相同

- [ ] **2. 文件夹**：拖一个文件夹进输入框 → chip 显示 📁 与真实路径（这是原先完全没有的能力）

- [ ] **3. 类型判定**：一次多选拖入 `README`（无扩展名文件）、含中文名的文件、含空格的路径
  Expected: `README` 显示 📄 而非 📁（验证 Task 1 的真实 stat 生效）

- [ ] **4. 跨盘图片缩略图**：拖一张 D 盘（或任意非 `$HOME`）的 png 进输入框
  Expected: 显示缩略图而非文件 chip（验证 Task 6 Step 2 的 scope 放宽）
  失败时先确认 `src-tauri/Cargo.toml` 的 `protocol-asset` feature 在位

- [ ] **5. 高 DPI 落点**（**最高风险项**）：Windows 设置 → 显示 → 缩放改为 **150%**，重启应用，重复第 1-3 条
  Expected: chip 仍插入输入框，且插在光标落点附近
  失败即为 `drag-bus.js` 的 `toCssPoint` 未生效或 `devicePixelRatio` 取值时机不对

- [ ] **5b. 坐标原点校验**（Task 2 实施中发现的未验证假设）：在 150% 缩放下，把文件拖到输入框的**上边缘内侧 20px** 和**下边缘内侧 20px** 分别松手

  Expected: 两处都能命中输入框

  背景：`toCssPoint` 只保证「物理→CSS」的除法正确，但 Tauri 的 `position` 原点究竟是窗口外框还是 webview 客户区，无法静态确认。本应用用自定义标题栏（`decorations(false)` + `data-tauri-drag-region`），推测两者重合，**但这是推测**。若出现「靠上边缘拖不中、要往下偏一点才行」，说明原点是窗口外框，需在 `toCssPoint` 里减去标题栏高度。

- [ ] **6. 落点分派**：切到 Markdown 视图，拖一个 `.md` 到该面板
  Expected: 在 Markdown 查看器中渲染，**不会**跑进输入框

- [ ] **7. 落点在外**：拖文件到顶部标题栏区域松手
  Expected: 什么都不发生，无报错、无 chip

- [ ] **8. 文件 chip 定位**：点击消息里的文件 chip
  Expected: 资源管理器打开并**选中**该文件

- [ ] **9. 目录 chip 定位**：点击目录 chip
  Expected: 在父目录中定位选中（spec §4.4 的**有意行为变更**，不是缺陷）

- [ ] **10. 外链**：点击消息里的 https 链接
  Expected: 系统浏览器打开（验证 `opener:default` 覆盖 https）

- [ ] **11. 错误可读**：点击一个已被删除的路径 chip
  Expected: toast 给出**具体原因**，绝不能再出现「未知错误」

- [ ] **12. token 排序拖拽未被殃及**：设置 → token 列表，拖动条目排序

  该处用的是 webview **内部** HTML5 DnD（`settings-panel.js:161-205`），不经 OLE drop target，理论上不受影响——**但这是推断不是验证，必须实测**。失败则需要为其单独补落点分派。

- [ ] **13. Markdown 历史项**：打开 A.md → 打开 B.md → 点历史里的 A.md
  Expected: 真正重新打开 A.md（旧版此处只会重渲染 B.md）

- [ ] **14. Web 模式无回归**：浏览器开 `http://127.0.0.1:9701`，拖文件进输入框、拖 `.md` 进 Markdown 面板
  Expected: 均走 HTML5 + 上传副本路线，行为与改造前一致

- [ ] **15. 全量单测**

  Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
  Expected: fail 0

---

## 自查：spec 覆盖对照

| spec 章节 | 落点 |
|---|---|
| §3.1 拖拽总线（坐标换算、命中判定、高亮自理） | Task 2 |
| §3.2 数据流 Tauri/Web 分叉 | Task 4 Step 3、Task 5 Step 3 |
| §4.1 输入框（真实 stat、asset 缩略图、摘 DOM 监听） | Task 4、Task 6 Step 3 |
| §4.2 Markdown（双入口、history、export、展示） | Task 5 |
| §4.3 后端两接口 | Task 1 |
| §4.4 opener 迁移（依赖、权限、vendor、两处 fallback、错误提取、目录行为变更） | Task 3 |
| §4.5 assetProtocol 放宽 | Task 6 Step 2 |
| §5 错误处理（不得静默失败） | Task 1 Step 3（stat 降级）、Task 4 Step 1（missing chip）、Task 5 Step 1（read 失败 toast）、Task 3 Step 7（错误提取） |
| §6 验证要点 12 条 | Task 7 的 15 条（拆细了跨盘缩略图与落点在外两项） |

**已知偏离**：spec §4.5 写 `["**"]` 需实测 Windows 跨盘符匹配。若 Task 7 第 4 条失败且确认是 scope 未匹配，改为按盘符枚举 `["C:/**", "D:/**", ...]`，并回写 spec。

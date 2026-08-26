# 后端掉线守卫：全局蒙版 + 网络错误收口 —— 设计

日期：2026-08-26
状态：用户已拍板（探测方式 / 恢复路径 / 逃生口 / fetch 收口范围四项均已确认）

## 1. 背景

### 1.1 触发问题

用户在「需求功能 → 开发阶段 → 后端 API 文档 → 点击上传」时报
`API 文档上传失败：Failed to fetch`。定位结论：**不是上传功能的缺陷，是后端进程已经退出，
前端页面还开着**。

证据链（已实测，非推断）：

| # | 证据 | 来源 |
|---|---|---|
| 1 | 后端是打包版 sidecar，端口 9701，pid 24172 | `logs/backend.log`：`Backend sidecar started on port 9701` |
| 2 | 日志在 09:39:53 后归零输出 | `app-2026-08-26.log` / `backend.log` 末条 |
| 3 | 访问日志止于 09:40:51，`/api/req/list` 的 30s 轮询在此彻底断掉 | `%APPDATA%\com.claudeagent.desktop\event-log.jsonl` |
| 4 | `/api/upload`、`/api/req/apidoc` 零记录 → 请求从未到达后端 | 同上 |
| 5 | 9701 现为 `ECONNREFUSED`（1ms 干净拒绝）→ 无进程监听 | Node TCP 探测 |

已排除的方向（都做过实测，记录在此避免重复走）：

- **服务端 handler 无缺陷**：用同一份 `game_api_contract.md`（12097 B）真打 `/api/upload` → 200 / 1ms / 写盘成功。
- **前端代码路径无缺陷**：puppeteer 真实 Chromium 跑 6 种组合（同源 + 跨源 × `File` 原样
  `text/markdown` / `text/plain` / 空 Content-Type × `input.value=''` / input 已摘除 DOM）→ 全部 200。
  一度怀疑 `req-chat.js:527` 在 fetch 前清空 `fileInput.value`（`req-view.js` / `composer.js` 都没这么写），实测证伪。
- **CORS 预检无缺陷**：`text/markdown` 确实不在 CORS 安全清单内、跨源会触发预检，但 `server.js:128`
  的 OPTIONS 应答正确，预检通过。

### 1.2 真正要修的两件事

1. **没有任何全局信号**告诉用户「后端已经不在了」。前端多路轮询（`/api/req/list` 30s、
   conv-notify 5s）静默失败，界面看起来完好，用户只能靠点按钮撞出报错。
2. **错误提示误导归因**。`req-chat.js:560` 把 `Failed to fetch` 原样拼进「API 文档上传失败」，
   用户合理地以为是上传功能坏了。同款拼装在 `req-view.js:1462`、`composer.js:172` 各有一份。

## 2. 用户拍板口径

| 决策点 | 结论 | 被否方案及原因 |
|---|---|---|
| 掉线探测方式 | **被动触发 + ping 确认**：业务 fetch 出现网络层失败 → ping `/api/ping` 确认 → 确认不通才升罩 | 否「常态主动心跳」：已有 3+ 路轮询，再加一路职责重叠。否「纯被动不确认」：单接口偶发失败会误报 |
| 恢复路径 | **自动重试 + 手动重载**：后台持续 ping，恢复即自动撤罩；同时给「重新加载」按钮走 `location.reload()` | 否「加『重启服务』按钮」：需新增 Rust command + 重新编译打包，范围明显变大（`main.rs` 现只有退出时 kill sidecar 的能力，无 restart） |
| 逃生口 | **不给**「仍然进入」 | 后端不通时所有按钮都是死的，放进去只会让用户对着无反应的界面反复点。与启动闸门的差异是合理的：那是「还没起来，可能马上就好」，这是「已经异常」 |
| fetch 收口范围 | **无条件装全局包装**，全项目所有 fetch 受益 | 否「导出 `apiFetch()` 逐处替换」：本次只会改三处上传，其余几十处照旧报 `Failed to fetch`，问题只解决三分之一 |

## 3. 关键设计决策

### 3.1 不复用启动罩，另起 `#offlineOverlay`

`#bootOverlay` 已具备全部视觉元素（六芒星 `#bootStar` + `vibeSpinPause` 旋转动画 + 文案位
`#bootText` + 罩内标题栏）。复用它是最省的写法，但**不采纳**：

它已经承载两种状态——启动等待，以及经 `setOverlayHandoff`（`boot-gate.js:21`）移交给新用户引导
（引导态把 `.ob-brand` 整体左移、展开 `#obPanel`、隐藏 `#bootStatus`）。再塞进第三种「后端异常」，
一个 DOM 三套状态机。更关键的是掉线罩需要能盖在引导面板**之上**，同一个节点做不到。

独立 `#offlineOverlay`：**JS 懒创建**，CSS 复用 `.boot-overlay` 基类，LOGO 从 `#bootStar`
`cloneNode(true)` 取（不新增素材副本）。

懒创建在这里安全：`index.html:60` 注释要求启动罩必须写静态 HTML（「第一帧就在 DOM 里，无二次挂载抖动」），
但那个理由**只针对首帧**。掉线是运行时事件，触发时 JS 早已就绪，没有抖动代价。

### 3.2 探测与展示拆成两个模块

`net-guard.js` 只管「什么情况下该升罩」，`offline-overlay.js` 只管「罩子长什么样」。
拆开的收益是状态机能纯逻辑单测——不碰 DOM 就能断言判定规则，与仓里
`optimize-fix.logic.js` / `req-map.edges.test.js` 那批同款做法。

### 3.3 撤罩改 `hidden`，不再 `remove`

`boot-gate.js:98` 现在 `overlay.remove()`，罩子撤掉后 `#bootStar` 从 DOM 消失，
掉线罩就没得克隆。改为 `overlay.hidden = true` 保留节点。

**必须配套一条 CSS**：`.boot-overlay[hidden] { display: none; }`。
`.boot-overlay` 是 `display:flex`，会压过 UA 对 `[hidden]` 的 `display:none` —— 这个坑仓里已踩过两次
（`app.css:2833` 的 `.ob-titlebar .win-controls[hidden]`、以及注释提到的 `.token-banner`）。
漏这条的后果是撤罩后罩子一直盖着，等于开机即黑屏。

### 3.4 窗口控制绑定必须改成可重入

`tauri-init.js:107-140` 用 `document.querySelectorAll('.wc-min' / '.wc-max' / '.wc-close')`
**一次性批量绑定**。掉线罩是懒创建的，创建时绑定早已跑完，它的 `.wc-*` 按钮不会有监听器。

窗口是无边框的（`main.rs` 的 `decorations(false)`），`inset:0` 的罩子盖住 `header.topbar` 之后，
用户既拖不动窗口也关不掉，只剩托盘和 Alt+F4 —— 这正是 `index.html:20-23` 注释警告过的情况。

改法：把那段抽成导出函数 `bindWindowControls(root = document)`，掉线罩创建后调
`bindWindowControls(overlayEl)`。这与 `index.html:23` 的原始意图一致（「按钮不给 id、只挂 `.wc-*` 类：
tauri-init.js 按类批量绑定，两处共用同一段窗口控制逻辑」）——原作者已有复用意图，只是用
一次性 `querySelectorAll` 实现的，加第三处就必须可重入。

## 4. 模块与接口

### 4.1 `public/js/net-guard.js`（新增）

```js
/** 装上 fetch 网络层失败监听。在 app.js 早期调用一次（bootstrap 之后）。 */
export function armNetworkGuard(): void

/** 业务侧上报一次网络层失败，内部去重 + ping 确认后才决定升罩。 */
export function reportNetworkFailure(): void

/** 当前是否已判定后端不可达。存在理由是可测性：让 net-guard.test.js 能直接断言
 *  判定结果，不必为了观测状态去 mock offline-overlay 模块（jsdom 下 ESM mock 成本高）。
 *  业务代码不消费它。 */
export function isBackendDown(): boolean
```

内部状态机：`idle → confirming → down → idle`

- `confirming`：ping `/api/ping`（`AbortController` 1500ms 超时，与 `boot-gate.js:6` 的
  `PING_TIMEOUT_MS` 取同值）。期间重复上报直接丢弃，不重复 ping。
- `down`：调 `showOfflineOverlay()`，启动 2000ms 间隔重连轮询。
- ping 通 → `hideOfflineOverlay()`，回 `idle`。

### 4.2 `public/js/offline-overlay.js`（新增）

```js
/** 升起掉线罩（幂等）。首次调用时懒创建 DOM。 */
export function showOfflineOverlay(): void

/** 撤下掉线罩（幂等）。DOM 保留，供下次复用。 */
export function hideOfflineOverlay(): void
```

创建时做三件事：克隆 `#bootStar` 作 LOGO、复制一份 `.ob-titlebar` 结构、
调 `bindWindowControls(el)` 补窗口控制。

### 4.3 `public/js/bootstrap.js`（改）

现在的 fetch 包装只在 `_isTauriPackaged` 分支内安装（`bootstrap.js:71-85`）。
改为**无条件安装**，两种模式行为分岔：

- 打包态：保留现有 URL 改写（`API_BASE + input`）+ 新增错误分类
- 非打包态：跳过 URL 改写，只做错误分类

错误分类逻辑（只在 reject 路径，成功路径与 `!r.ok` 路径一律不碰）：

```
catch (e):
  e.name === 'AbortError'  → 原样重抛（主动取消不是掉线）
  init?.__skipGuard        → 原样重抛（boot-gate 启动期 ping 的旁路，见 4.4）
  否则（TypeError 等网络层） →
      reportNetworkFailure()
      throw Object.assign(new Error('后端未连接'), { isNetworkError: true })
```

`isNetworkError` 标记是给业务侧判分支用的。**不用字符串比对消息文本**——那种写法
一改文案就静默失效，而这里正是「文案会被改」的地方。

### 4.4 `public/js/boot-gate.js`（改）

- `:98` `overlay.remove()` → `overlay.hidden = true`
- `:35` 自身的 ping **必须 opt-out 掉线守卫**。否则冷启动时后端尚未就绪，
  启动罩和掉线罩会同时升起打架。

  实现方式**只能是给 init 加旁路标记**：`fetch('/api/ping', { signal, cache: 'no-store', __skipGuard: true })`，
  包装内读 `init?.__skipGuard` 决定是否上报（`fetch` 会忽略 init 上的未知字段，安全）。

  不能改用「在包装安装前捕获的原始 `fetch` 引用」——打包态下 `/api/ping` 这个相对路径
  **必须**经包装改写成 `API_BASE + '/api/ping'` 才打得到实际端口（`bootstrap.js:77-78`），
  绕过包装等于让启动闸门在桌面版永远探测不到后端。

### 4.5 三处上传入口（改）

`req-chat.js:560`、`req-view.js:1462`、`composer.js:172`。

包装已把消息换成「后端未连接」，但仍要去掉双重归因，避免出现
「API 文档上传失败：后端未连接」这种把系统故障说成功能故障的措辞：

```js
catch (e) {
  if (e?.isNetworkError) window.toast.error(e.message);       // 系统故障：不加业务前缀
  else window.toast.error('API 文档上传失败：' + (e?.message || e));
}
```

三处的业务前缀各不相同（「API 文档上传失败」/「上传失败」/「文件上传失败」），
分支结构一致但文案保留原样，不做统一——那属于无关重构。

## 5. 数据流

```
业务 fetch → bootstrap 包装 → reject
   ├─ AbortError → 原样重抛（不上报）
   └─ TypeError（网络层）
        ├─ net-guard.reportNetworkFailure()
        │     └─ ping /api/ping（1.5s 超时）
        │          ├─ 通   → 忽略，不升罩（单接口偶发）
        │          └─ 不通 → showOfflineOverlay() + 每 2s 重连
        │                      └─ ping 通 → hideOfflineOverlay()
        └─ throw new Error('后端未连接') → 业务 catch 拿到可读消息
```

`fetch` resolve 但 `!r.ok` 的路径完全不介入——那是后端活着的业务错误，不该升罩。

## 6. 边界与陷阱清单

实现时逐条核对，这几条都是调研中确认过的真实陷阱：

1. **`AbortError` 必须排除**。`boot-gate.js:32` 自身就用 `AbortController` 做 ping 超时。
2. **boot-gate 启动期 ping 必须 opt-out**。否则冷启动时两个罩子打架。
3. **`.boot-overlay[hidden] { display: none; }` 必须补**（见 3.3）。
4. **掉线罩创建后必须 `bindWindowControls(el)`**（见 3.4）。
5. **ping 自身失败不得递归上报**，否则 `reportNetworkFailure` 无限自激。
6. **升罩 / 撤罩必须幂等**。多路轮询会在同一时刻集中失败，会有并发上报。

## 7. 视觉

```
        ✦  六芒星（vibeSpinPause 旋转，克隆自 #bootStar）

           VIBE CODING

        服务器后台异常
        正在尝试重新连接…

          [ 重新加载 ]
```

- `z-index: 100001` —— 比启动罩的 `100000` 高一档，盖住引导面板与一切弹窗
  （`app.css:2791` 记录：100000 已高于 toast 的 9999 与启动错误条的 99999）
- 主文案「服务器后台异常」，副文案「正在尝试重新连接…」沿用 `.boot-text` 样式
- 「重新加载」按钮沿用 `.boot-skip` 样式，走 `location.reload()`
- 按拍板结论**不提供**「仍然进入」

## 8. 测试

| 文件 | 用例 |
|---|---|
| `public/js/net-guard.test.js` | fetch 抛 `TypeError` → 断言触发 ping 且升罩；ping 恢复 → 断言撤罩；抛 `AbortError` → 断言**不**升罩；`!r.ok` → 断言**不**升罩；带 `__skipGuard` 的请求失败 → 断言**不**升罩；并发上报 → 断言只 ping 一次；重抛的 error 带 `isNetworkError: true` |
| `public/js/offline-overlay.test.js` | 断言 DOM 结构、LOGO 克隆成功、`bindWindowControls` 被调用、show/hide 幂等 |
| `public/js/req-chat.apidoc.test.js` | 补一例：fetch 抛 `TypeError` 时 toast 文案不含 `Failed to fetch` |

前两个走 node:test + jsdom，与仓里 `req-chat.apidoc.test.js` 同款把 import 链真实拉起来。

## 9. 明确不做（YAGNI）

- **不新增 Rust `restart_backend` command**。需要改 `main.rs` + 重新编译打包才能验证，
  且「重新加载」已覆盖大部分场景。若后续确认后端会频繁异常退出，再单独立项。
- **不查后端为什么退出**。本 spec 只解决「掉线后用户无感知 + 报错误导」。
  进程退出原因（09:39:53 `error_during_execution` 之后静默，无 JS 异常、无 heap limit 记录，
  proc-guard 一条「未捕获异常」都没留 → 更像被外部终止）需要另开一轮排查。
- **不动 `/api/shutdown` 404**。那是旧版打包应用（identifier `com.claudeagent.desktop`）
  在打当前代码库不存在的路由，属另一个问题。

## 10. 影响文件清单

| 文件 | 动作 |
|---|---|
| `public/js/net-guard.js` | 新增 |
| `public/js/offline-overlay.js` | 新增 |
| `public/js/net-guard.test.js` | 新增 |
| `public/js/offline-overlay.test.js` | 新增 |
| `public/js/bootstrap.js` | 改：fetch 包装无条件装 + 错误分类 |
| `public/js/boot-gate.js` | 改：撤罩 `remove` → `hidden`；ping opt-out |
| `public/js/tauri-init.js` | 改：抽出可重入的 `bindWindowControls(root)` |
| `public/app.js` | 改：早期调 `armNetworkGuard()` |
| `public/app.css` | 改：`.offline-overlay` 样式 + `.boot-overlay[hidden]` 修正 |
| `public/js/req-chat.js` | 改：`:560` 去双重归因 |
| `public/js/req-view.js` | 改：`:1462` 去双重归因 |
| `public/js/composer.js` | 改：`:172` 去双重归因 |

## 11. 一个已知的现实前提

用户机器上装的打包应用 identifier 是 `com.claudeagent.desktop`，而当前
`src-tauri/tauri.conf.json` 已是 `com.vibecoding.desktop`，跑的是
`C:\Program Files\claude-agent-desktop\sidecar\server.js` 的旧快照。

**本次改动在浏览器直访与 `tauri dev` 下立即可验证，但不会影响那个已安装的旧应用，
除非重新打包安装。** 这不影响本设计的正确性，但会影响验收方式——验收走浏览器或 tauri dev。

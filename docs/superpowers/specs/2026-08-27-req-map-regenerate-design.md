# 需求地图「重新生成」设计

**日期:** 2026-08-27
**作者:** AI + User
**版本:** 1.0

---

## 需求概述

**痛点：** 需求地图是在评审期（`docgen` 之后）一次性产出的。开发推进过程中逻辑往往会改——改法可能来自需求变动、也可能来自开发时才发现的技术约束——到了开发中后期，最初那张地图与代码里真正实现的东西已经对不上了。地图本来是给非技术人员核对「你理解的需求 = 我要的需求」的，一旦失真就没人敢信。

**目标：** 提供一条「重新生成」链路，**以当前代码实现为准**全量重扫，产出新版地图。

**为什么现有三条链路都不解决这个问题：**

| 链路 | 驱动源 | 输入 | 为什么不够 |
|------|--------|------|-----------|
| `mapgen` | docgen 完成后自动续跑 | resume `docSession`，即评审期的代码理解 | 只在评审期跑一次，且是「开发前」的快照 |
| `mapfix` | 用户逐点标注「有误」 | 上一版地图 + 标注 | 要求用户先自己看出哪里不对，是纠错不是重扫 |
| `mapchange` | 开发期提交「需求变动」 | 上一版地图 + 变动描述 | 只覆盖「用户主动说要改」的部分，开发中自发的逻辑调整照样漏 |

三者的共同点是**都基于上一版地图做增量改写**，且都 `resume: req.docSession`。重新生成必须打破这两点。

---

## 关键决策（已拍板）

### 决策 1：全量重扫，且不 resume `docSession`

其余三条链路都 `resume: req.docSession` —— 省 token、保证同源。但 `docSession` 承载的正是「评审期读代码得到的理解」，而这份理解恰恰是本次要推翻的对象。带着它续跑，模型会倾向确认既有结论（确认偏误），看不见代码已经变了。

**因此 `mapregen` 是四条链路里唯一开全新 session 的。** 代价是要重新读一遍代码，耗时与 docgen 同量级（数分钟到十几分钟），这是「重扫」这件事的固有成本，不是可优化项。

### 决策 2：上一版地图**只带页面名清单**进 prompt

不带任何 `points` 细节。原因是两处隐藏耦合都以**页面名**为键：

- `normalizeMap(raw, { prev })`：已挂载的 Figma 设计稿（`figma` / `restoredAt`）**按页面名**从上一版回迁（`req-map.logic.js:125`）
- `markFreshPoints(prev, next)`：「本轮变化」高亮按 **`页面名 + 逻辑点标题`** 比对（`req-map.logic.js:335`）

页面名一漂，用户已挂的设计稿全丢、整张图全标成「本轮变化」。所以 prompt 里给出旧页面名清单并要求「同一个页面沿用原名」。

只给名字不给 `points`，是为了不让模型照抄旧的逻辑点结论——那样就退化成 `mapfix` 了。

### 决策 3：喂 git 改动文件清单，无分支时静默降级

「全量重扫」若不给范围锚点，模型只能靠开发文档和旧地图里的文件路径去猜，容易漏掉开发中新增的文件。而 `git diff <baseBranch>..<branch> --name-only` 正是「这个需求实际动了哪些文件」的权威证据，归档链路已有现成实现（`requirement-ops.js:698` `defaultRunGitDiff`）。

降级条件（任一命中即跳过该工程，不阻塞重扫）：评审期尚无 `branches`、目录不是 git 仓库、git 调用失败。评审期本来就还没开始写代码，清单为空是正确语义。

### 决策 4：入口放在地图工具栏，两处自动都有

`mountMap` 被两处复用（评审期内嵌报告页签 / 开发期右栏浮层），按钮加在工具栏里一处代码两处生效。附带解决评审期「地图生成歪了只能靠标注一条条纠」的问题。

---

## 数据流

```
用户点「↻ 重新生成」
  → 二次确认（说明耗时与产出新版本）
  → POST /api/req/map/regen { id }
  → 守卫：phase ∈ {review,dev,test} · 有开发文档 · 有工程目录 · 无 busy/排队
  → enqueueSystemTask(id, 'mapregen', {})     [复用现有串行闸]
  → 泵 → dispatch → runMapRegen(req)
        ├─ collectChangedFiles(req)           [git diff，失败降级空数组]
        ├─ buildMapRegenPrompt({...})
        ├─ runReadonlyClaude(req,'mapregen',{ prompt, resume: null })   ← 全新 session
        └─ persistMap(req, text, { prev: 当前版 })
              ├─ normalizeMap(raw, { prev })  → 设计稿按页面名回迁
              ├─ markFreshPoints(prev, map)   → 变化点高亮
              └─ 落 map-v<n+1>.json + 版本登记 + 清 busy
  → 前端 busy 轮询（评审期 req-view / 开发期 req-chat）在 busy 下降沿刷新到新版
```

标注（`annots`）随旧版留在旧文件里，新版天然为空 —— 与 `mapfix` 语义一致，不额外处理。

---

## 后端设计

### 4.1 prompt 构造（`src/entrypoints/web/req-map.logic.js`）

新增纯函数，与现有三个 `build*Prompt` 并列，共用 `mapOutputContract()`：

```js
/**
 * 「重新生成」prompt：以**当前代码实现**为准全量重扫（与 mapgen/mapfix/mapchange 的增量改写相反）。
 *
 * 开发文档降级为「需求意图参考」而非事实来源——开发途中的逻辑调整不会回写文档，
 * 把它当事实来源就等于重扫了一遍旧结论。
 *
 * @param {string} opts.docPath - 最新开发文档路径（必填，让模型现读）
 * @param {string[]} [opts.prevPageNames] - 上一版页面名清单。只给名字不给 points：
 *   设计稿回迁与变更高亮都以页面名为键（见 normalizeMap / markFreshPoints），名字漂了两者皆失效；
 *   而给了 points 模型就会照抄旧结论，退化成 mapfix。
 * @param {string[]} [opts.changes] - 开发期「需求变动」正文（说明意图）
 * @param {string[]} [opts.changedFiles] - git 实际改动文件清单（说明结果）
 */
export function buildMapRegenPrompt({ docPath, prevPageNames = [], changes = [], changedFiles = [] })
```

正文结构（各段有内容才出，不留空标题）：

1. **定调**：「开发已进行了一段时间，代码可能与最初的需求地图不一致。请**以当前代码的实际实现为准**重新扫一遍。」
2. **文档参考**：`请先 Read 开发文档 <docPath>`，明确它只代表需求意图，与代码冲突时**以代码为准**并在逻辑点里写清差异
3. **变动历史**（有则出）：最近 N 条需求变动正文，注明「这些是开发期用户提过的变动，代码里可能已实现、也可能只实现了一部分，需查证」
4. **改动文件清单**（有则出）：`git diff` 结果，注明「这是本需求分支相对基线实际改动的文件，请逐个查证其中的用户可见行为变化」
5. **命名对齐**（有则出）：旧页面名清单 + 「同一个页面请沿用上面的原名；页面已被删除或改名的，在逻辑点里说明」
6. `mapOutputContract()`

**上限**（防 prompt 爆炸，超出时注明「另有 N 项未列出」）：
- `changedFiles` 最多 200 条
- `changes` 最多 20 条，每条截断 300 字
- `prevPageNames` 最多 100 条

### 4.2 改动文件收集（`src/entrypoints/web/requirement-ops.js`）

```js
/**
 * 本需求分支相对基线的改动文件清单——重扫地图的范围锚点。
 * 复用归档链路的 defaultRunGitDiff。任何一个工程失败都只跳过它自己：
 * 清单是锦上添花，绝不能因为某个目录不是 git 仓库就把整次重扫拦下来。
 * 导出供单测注入桩。
 */
export async function collectChangedFiles(req, { runGitDiff = defaultRunGitDiff } = {})
```

逐条遍历 `req.branches`，`r.ok && r.out` 时按行拆分并入结果，异常吞掉。评审期 `branches` 为空数组，天然返回 `[]`。

### 4.3 任务执行（`src/entrypoints/web/requirement-ops.js`）

```js
/** 重新生成地图：以当前代码为准全量重扫，出 v+1。四条链路里唯一不 resume docSession 的。 */
export async function runMapRegen(req)
```

- `docPath` 缺失 → 抛错（无需求意图参考，重扫没有基准）
- `prev = readMapVersion(req)`，**允许为 null**：地图从未生成成功过时也应该能重新生成
- `resume: null` —— 全新 session，见决策 1
- `timeoutMs: MAPREGEN_TIMEOUT_MS = 30 * 60_000`

**为什么给 30 分钟而不是像 docgen 那样无限等：** `runDocgen` 有配套的 `POST /api/req/docgen/stop`（`docgenAborts` 注册表）可以让用户主动中止，`runReadonlyClaude` 没有。无超时 + 无停止手段 = 卡死了只能重启进程。全量重扫比 docgen 更重，15 分钟的 `DOCGEN_TIMEOUT_MS` 偏紧，取 30 分钟。

### 4.4 派发守卫（`dispatch`）

`mapregen` 的 phase 白名单是 `review | dev | test`，与现有任何一组都不同：

- `quizgen/mapgen/mapfix`：仅 `review`
- `mapchange`：仅 `dev|test`
- `mapregen`：三者都要 —— 评审期用于「地图跑歪了重来」，开发/测试期用于「代码变了重扫」

归档中/已归档拒绝（只读阶段）。作废时记 history，与现有分支同款写法。

### 4.5 路由（`src/entrypoints/web/routes-req-v2.js`）

```
POST /api/req/map/regen { id }  → 202 { ok: true }
```

守卫顺序（全部 fail-fast）：

| 条件 | 状态码 | 文案 |
|------|--------|------|
| 需求不存在 | 404 | 需求不存在 |
| phase ∉ {review,dev,test} | 409 | 仅评审/开发/测试期可重新生成需求地图 |
| 无开发文档 | 409 | 请先生成开发文档 |
| 无工程目录 | 400 | `DOCGEN_GUIDE` |
| `busy` 或 `hasQueuedTasks` | 409 | 已有任务在进行或排队 |

**不要求已存在地图** —— 见 4.3。

---

## 前端设计

### 5.1 工具栏按钮（`public/js/req-map.js`）

`.rq-ver` 版本页签之前插入：

```html
<button class="btn rq-regen" title="以当前代码实现为准，重新扫一遍出新版地图">↻ 重新生成</button>
```

`mountMap` 新增可选入参 `opts.busy`（当前 busy 对象或 null）：非空时按钮 `disabled` 且标题提示「系统任务运行中」。两处调用方都拿得到 `req.busy`，传进来即可；不传时靠后端 409 兜底，不会出错。

点击流程：`confirmDialog` → `POST /api/req/map/regen` → 成功后 `window.toast.success` + `onRegen?.()`。

新增 `onRegen` 回调而不复用 `onReload`，是因为两处的收尾动作不同（见下）。

### 5.2 评审期（`public/js/req-view.js`）

`renderReportArea` 的 `mountMap` 调用补 `busy: req.busy` 与 `onRegen: () => loadAndRenderReq(req.id)`。刷新后 `req.busy` 非空，现有 3s 轮询自动接管；busy 下降沿的「回到最新版」逻辑已存在，重扫完成会自动展示新版本。

**要补文案：** `req-view.js:2824` 附近的 busy 卡片目前只特判了 `quizgen`，其余一律显示「开发文档生成中」。`mapregen` 在评审期跑会显示假话，需加分支：「正在重新扫描代码并生成需求地图…」。

### 5.3 开发/测试期（`public/js/req-map-overlay.js` + `public/js/req-chat.js`）

`openMapOverlay` 新增入参 `busy` 与 `onRegen`，透传给 `mountMap`。**overlay 自己不 import `req-chat`**（原有断依赖环的约定，见该文件头注释），回调由调用方注入。

`req-chat.js:625` 的调用处传：

```js
openMapOverlay({
  reqId: data.id,
  phase: data.phase,
  busy: data.busy,
  onRegen: () => mountReqChrome(data.id),   // 重挂以启动 busy 轮询 + 芯片
})
```

用 `mountReqChrome` 而非 `refreshRail`：后者只重画右栏、不启动轮询，用户会看不到任何进度。`mountReqChrome` 会按 `shouldPoll` 重新判定并接管 3s 轮询，busy 结束时 `renderChrome` 整体刷新，右栏地图版本号随之更新。

浮层在触发成功后**关闭** —— 它展示的是旧版数据，留着只会让用户对着一张即将作废的图等。

**顺带修的现存问题：** `BUSY_KIND_LABELS`（`req-chat.js:293`）缺全部 map 系任务，现在 `mapgen`/`mapfix`/`mapchange` 跑起来时顶部芯片直接显示英文 kind。一并补齐四条：

```js
const BUSY_KIND_LABELS = {
  develop: '自动开发', 'api-fix': 'API 对照修正', 'bug-fix': 'BUG 修复',
  docgen: '文档生成', bitable: '表格巡检',
  mapgen: '地图生成', mapfix: '地图修订', mapchange: '地图更新', mapregen: '地图重新生成',
};
```

---

## 对现有代码的影响

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/entrypoints/web/req-map.logic.js` | 新增 `buildMapRegenPrompt`（~45 行） |
| `src/entrypoints/web/requirement-ops.js` | 新增 `collectChangedFiles` / `runMapRegen` / `MAPREGEN_TIMEOUT_MS`，`dispatch` 加 `mapregen` 分支（~60 行） |
| `src/entrypoints/web/routes-req-v2.js` | 新增 `handleMapRegen` + 分发表一行（~25 行） |
| `public/js/req-map.js` | 工具栏按钮 + `busy`/`onRegen` 入参 + 触发逻辑（~35 行） |
| `public/js/req-map-overlay.js` | 透传 `busy`/`onRegen`（~4 行） |
| `public/js/req-chat.js` | 调用处传参 + `BUSY_KIND_LABELS` 补全（~8 行） |
| `public/js/req-view.js` | 调用处传参 + busy 文案分支（~10 行） |
| `public/app.css` | `.rq-regen` 按钮样式（~10 行） |

### 不改动

- **数据模型**：`reqMap.versions` 结构不变，新版本就是普通的 `map-v<n>.json`
- **`normalizeMap` / `markFreshPoints` / `persistMap`**：完全复用，重扫的设计稿回迁与变化高亮由它们天然承担
- **串行闸 / busy 机制 / 崩溃恢复**：`mapregen` 就是一种普通系统任务，`recoverBusyOnBoot`、`healStaleBusy` 自动覆盖（`runReadonlyClaude` 系任务的 busy 无 `runId`，`isBusyStale` 按约定跳过，与 mapgen 等同款）

---

## 测试要点

### 单元测试

**`req-map.logic.test.js`**
- `buildMapRegenPrompt` 含「以当前代码的实际实现为准」定调与 `docPath`
- 给了 `prevPageNames` 时 prompt 含各页面名与「沿用原名」要求；空数组时**不出**该段落
- `changedFiles` 超 200 条时截断并注明剩余数量
- `changes` 逐条截断 300 字
- 产出仍包含 `mapOutputContract()` 的硬性要求（如「不要输出任何坐标字段」）

**`requirement-ops.test.js`**
- `collectChangedFiles`：多工程结果合并；某工程 `ok:false` 时只跳过它、其余照常返回；`branches` 为空返回 `[]`；`runGitDiff` 抛异常时不上抛
- `dispatch({kind:'mapregen'})`：`review`/`dev`/`test` 放行；`archiving`/`archived` 作废并记 history

### 手工验证

1. **开发期主路径**：需求处于 dev、代码已改过 → 浮层点重新生成 → 确认 → 浮层关闭、顶部芯片显示「地图重新生成」→ 完成后右栏版本号 +1 → 打开新版，已挂的 Figma 设计稿仍在，改动过的逻辑点带「本轮变化」高亮
2. **评审期**：地图页签点重新生成 → 主栏 busy 卡片文案正确（不是「正在生成开发文档」）→ 完成后自动切到新版
3. **降级**：工程目录不是 git 仓库 → 重扫照常完成，只是没有文件清单锚点
4. **守卫**：busy 期间按钮禁用；绕过前端直接 POST 返回 409

---

## 后续可做（不在本次范围）

1. **地图生成失败后的重试入口** —— 后端 `runMapRegen` 已允许 `prev` 为 null，但前端入口在地图工具栏里，没有地图就看不到按钮。右栏「需求地图」项在 `hasMap=false` 时是 disabled 的，可改为「点击生成」。
2. **重扫结果的版本间 diff 视图** —— 目前只有逐点的「本轮变化」高亮，没有「相比上一版新增/删除了哪些页面」的汇总。
3. **中止能力** —— 把 `mapregen` 的 `AbortController` 注册进 `docgenAborts` 复用停止接口，届时可去掉 30 分钟超时。

---

## 实现状态

- [x] Task 1: `buildMapRegenPrompt` 纯函数 + 单测
- [x] Task 2: `collectChangedFiles` git 清单收集 + 单测
- [x] Task 3: `runMapRegen` 任务执行 + `dispatch` 守卫 + 单测
- [x] Task 4: `POST /api/req/map/regen` 路由与守卫
- [x] Task 5: `mountMap` 工具栏按钮与触发逻辑 + CSS
- [x] Task 6: 评审期接线（`req-view.js`）含 busy 文案
- [x] Task 7: 开发期接线（`req-map-overlay.js` / `req-chat.js`）含 `BUSY_KIND_LABELS` 补全
- [x] Task 8: 自动化测试与路由守卫验证
- [ ] Task 9: 真实环境手工走查（需在跑起来的应用里点一遍，见下）

**完成日期:** 2026-08-27

**改动文件（约 380 行新增）:**

| 文件 | 改动 |
|------|------|
| `src/entrypoints/web/req-map.logic.js` | +86 行：`buildMapRegenPrompt` + `clipList`/`bulletBlock` + 四个上限常量 |
| `src/entrypoints/web/req-map.logic.test.js` | +49 行：6 个 prompt 单测 |
| `src/entrypoints/web/requirement-ops.js` | +90 行：`MAPREGEN_TIMEOUT_MS` / `collectChangedFiles` / `runMapRegen` / `dispatch` 分支 |
| `src/entrypoints/web/requirement-ops.test.js` | +48 行：5 个单测（3 个收集 + 2 个 phase 守卫） |
| `src/entrypoints/web/routes-req-v2.js` | +23 行：`handleMapRegen` + 分发表 |
| `public/js/req-map.js` | +43 行：工具栏按钮 + `busy`/`onRegen` 入参 + 触发逻辑 |
| `public/js/req-map-overlay.js` | +7 行：透传 `busy`/`onRegen`，触发后关浮层 |
| `public/js/req-view.js` | 评审期接线 + `MAP_BUSY_TEXT` 分支 |
| `public/js/req-chat.js` | 开发期接线 + `BUSY_KIND_LABELS` 补全 |
| `public/css/req-v2.css` | +6 行：`.rq-regen` 样式 |

**验证结果:**
- `npm test` — 1712 项，1710 通过。2 项失败在 `public/js/chat.path.test.js`（markdown chip 图标 📝/📄 期望未同步），**与本次改动无关，动手前即存在**
- 新增单测 11 项全绿（`req-map.logic.test.js` 52 项、`requirement-ops.test.js` 47 项）
- 四个前端模块通过 ESM 语法校验；`routes-req-v2.js` / `requirement-ops.js` 通过真实加载
- 路由六条守卫经 mock 请求逐条验证：404 需求不存在 / 202 齐备 / 409 无文档 / 409 已归档 / 400 无工程 / 409 busy 中

**扩大的范围（两处顺带修复，均属同一 bug 家族）:**
1. `BUSY_KIND_LABELS` 原缺全部 map 系四项，芯片上直接漏出英文 kind
2. `renderBusyBar` 原先只特判 `quizgen`，`mapgen`/`mapfix`/`mapchange`/`mapregen` 全部落到默认分支显示「开发文档生成中…」并给出一个对它们无效的「停止」按钮（该接口只 abort `docgenAborts` 里的 docgen）。新增 `MAP_BUSY_TEXT` 分支，四类各自文案且不出停止按钮

**待手工走查:**
1. 开发期浮层点重新生成 → 浮层关闭、芯片显示「地图重新生成」→ 完成后右栏版本号 +1
2. 新版地图里已挂的 Figma 设计稿仍在（页面名回迁生效）、改动过的逻辑点带「本轮变化」高亮
3. 评审期 busy 卡片文案正确（不是「开发文档生成中」且无停止按钮）

**已知小缺口（有意接受）:** 开发期 rail 在 busy 期间不重画，`mk()` 闭包捕获的 `data.busy` 可能陈旧，导致按钮该禁用却没禁用。此时点击由后端 409 兜底并 toast「已有任务在进行或排队」，符合设计中「不传 busy 时靠 409 兜底」的降级约定。

**未提交说明:** 所有改动留在工作区，提交时机由用户掌控。

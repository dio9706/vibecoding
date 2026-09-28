# 需求阶段切换：会话按阶段隔离（开发 → 测试）

> 日期：2026-09-21 · 状态：设计已拍板，待实现
> 关联：`src/store/requirements.js` 状态机 `PHASE_FLOW`、`docs/ARCHITECTURE.md` 需求工作流

## 1. 背景与问题

需求生命周期为 `review → dev → test → archiving → archived`。当前开发期与测试期**共用同一根会话**：`req.convId` / `req.devSession` 跨阶段延续，侧栏会话树无条件渲染全部 `sessions[]`。由此产生两个缺陷：

**缺陷 A · 流转守卫漏判子会话。** `routes-requirements.js` 的 `phaseGuard` 只检查 `hasActiveRunForConv(r.convId)`，即只管主会话。用户在开发期开的 `kind:'sub'` 子会话正在跑时，点「完成开发」照样放行 —— 需求已进入测试期，而开发期的 run 还在改代码。

**缺陷 B · 测试期不是「新阶段」。** 进入测试期后，聊天区仍挂着开发期整段上下文，侧栏仍列着开发期全部会话。用户预期的是「开发这一页翻过去了，测试期从干净的会话重新开始」。

## 2. 目标

1. 点「完成开发」时，确认该需求当前阶段的**全部会话**都已跑完，否则拦截。
2. 流转到测试期后，开发期会话（含主会话）从侧栏隐藏，测试期自动获得一根干净的新主会话。
3. 不丢数据：归档期的「优化汇总」仍需遍历开发期会话的转录。

## 3. 拍板记录

| 决策点 | 结论 | 放弃的选项与理由 |
|---|---|---|
| 有会话在跑时怎么办 | **拦截并列出**：409 + 运行中会话标题列表，用户自己去停 | 放弃「自动停止」：会打断可能正在收尾的 run；放弃「二次点击强停」：前后端各多一条强制路径，不值当 |
| 隐藏范围 | **全隐 + 测试期开新主会话**：主会话一并换掉 | 放弃「只隐子会话、主会话延续」：测试期聊天里仍挂整段开发历史，不符合「新阶段」语义；放弃「可展开回看」：多一层 UI，当前不需要 |
| 测试期上下文怎么补 | **bug-fix 提示词自带上下文 + 新主会话 seed 待发** | 放弃「测试期自动跑一轮开场」：每个需求多烧一轮额度；放弃「两者都要」：冗余 |

## 4. 数据模型

`src/store/requirements.js`，`sessions[]` 每条增加 `phase` 字段：

```js
sessions: [], // [{convId, sessionId, title, kind, phase, createdAt}]
              // kind: 'main'|'sub'|'retro'；phase: 'dev'|'test'|'archiving'（会话诞生时的阶段）
```

`normalizeSessions(req)` 读侧兜底补齐：缺 `phase` 的补 **`req.phase`（需求当前阶段）**。这与现有的「`convId` → 合成 main 行」走同一条渐进迁移路径：任何一次真实写入顺带把补齐结果落盘。

**为什么是 `req.phase` 而不是字面量 `'dev'`**（2026-09-21 经代码评审修正）：一条会话缺 `phase`，只可能是它诞生于本功能上线之前，也就意味着**这个需求从未经历过阶段拆分**——老流程里 `handleDevDone` 只写 `{phase:'test'}`，`convId` 原样延续，那根会话一路用到测试期。把它标成 `'dev'` 会让一个已在测试期的存量需求的会话树**整棵从侧栏消失**（§6.5 的过滤按 `=== r.phase` 判），且因 `convId` 非空走不到 §6.1 的「清锚点 → 前端自动建新主会话」补救路径；连带 §5 的守卫会遍历到空集、真空通过。标成 `req.phase` 则保持可见、守卫也看得见，语义上也更准——那根会话确实服务到了当前阶段。

走新流程的需求不受影响：§6.1 的物化发生在 `phase` 改写**之前**（读的是旧 `r`），开发期会话照样被钉成 `'dev'` 落盘，此后再不会触发回填。

由此统一一条口径贯穿前后端：**缺 `phase` 一律视为「当前阶段」**（守卫侧 = 纳入检查，渲染侧 = 照常显示）。两边都是安全的失败方向：宁可多拦一次，也不让用户的历史凭空消失。

**为什么不加 `hidden` 布尔**：隐藏是渲染决策，不该写进数据。`phase` 表达的是会话的真实归属，归档期「优化汇总」还要靠完整历史工作。

**为什么不用 `createdAt` 时间戳推断归属**：跨进程时钟差、同毫秒创建、流转瞬间的竞态都会让边界模糊。显式打标是唯一稳的判据。

## 5. 流转守卫

### 5.1 纯函数（`src/entrypoints/web/req-logic.js`）

```js
/**
 * 当前阶段内仍有活跃 run 的会话（阶段流转守卫用）。
 * @param {object[]} sessions - normalizeSessions 的产物
 * @param {string} phase - 当前阶段
 * @param {(convId: string) => boolean} hasActive - 注入 store/runs 的 hasActiveRunForConv
 * @returns {{convId: string, title: string}[]}
 */
export function runningSessions(sessions, phase, hasActive) { ... }
```

判据：`(!s.phase || s.phase === phase)` 且 `s.convId` 非空 且 `hasActive(s.convId)`。零 IO，可直测。缺 `phase` 视为当前阶段 = 纳入检查，是守卫该有的失败方向。

### 5.2 接入（`routes-requirements.js` `phaseGuard`）

`r.busy` / `hasQueuedTasks(id)` 两道守卫保留不动；把 `hasActiveRunForConv(r.convId)` 换成 `runningSessions(...)`。命中时：

```js
{ ok: false, status: 409, error: '有会话正在运行，请先等待完成或停止', running: [{convId, title}] }
```

前端 `phaseAction` 收到 409 且带 `running` 时，弹窗逐条列出会话标题（而非现在的单行 toast）。

守卫对 `dev-done` 与 `test-pass` 同时生效 —— 两者共用 `phaseGuard`，测试期的会话同样不该在流转瞬间还在跑。

## 6. dev → test 的切换

### 6.1 后端流转（`handleDevDone`）

```js
updateRequirement(id, {
  sessions: normalizeSessions(r),  // ★ 先物化
  phase: 'test',
  convId: null,
  devSession: null,
}, '开发完成，进入测试期');
```

**`sessions: normalizeSessions(r)` 这一步不可省，且必须在 `phase` 改写之前求值。** 两个理由，缺一个都会出事：

1. 老需求的 `sessions` 可能为空、主会话靠 `convId` 在读侧合成；一旦先清掉 `convId`，合成路径失效，开发期历史就再也拿不回来了（归档期的优化汇总会直接少一整段）。
2. `normalizeSessions` 的 phase 缺省取的是 `req.phase`（见 §4），所以它**对调用时序敏感**：读未更新的 `r` 得到 `'dev'`，读更新后的记录会得到 `'test'`。写成「先 `updateRequirement({phase:'test'})`、再 `normalizeSessions(getRequirement(id))`」的话，开发期会话会被全部钉成 `'test'`，此后永不被隐藏 —— 整个功能静默退化成空操作，不报错、不掉数据、测试也不红。

第 2 条这个不变量由本层（entrypoints）保证，而 store 层测不到它。plan 里「存量会话物化成 `phase:'dev'`」那条用例是唯一能钉住它的护栏，不要在后续改动中删掉或放宽。

`sessions` 本身不再改动 —— 它们已带 `phase:'dev'`，随阶段推进天然沉为历史。

### 6.2 新主会话的登记（`handleConv`，`POST /api/req/conv`）

`handleConv` 现在只写 `convId`。必须补一步：同时往 `sessions[]` 登记一条当前阶段的 main 会话。

理由：`normalizeSessions` 的路径 1（`sessions` 非空 → 直接返回）会原样返回开发期那批，**不会**为新 `convId` 合成 main 行。不补这一步，测试期新主会话在侧栏根本不出现（也无法重命名、无法被守卫看见）。

三种情形，顺序不能换（2026-09-21 经代码评审修正，原设计只有 1 和 3，漏了 2）：

1. **已有同 `convId` 的行** → 一个字段都不动（它可能已被 run 回填过 `sessionId`、被用户改过标题）。覆盖前端网络重试。
2. **没有该 `convId`、但当前阶段已有 main** → **重指**那一行的 `convId`，不新推一条。
3. **当前阶段还没有 main**（刚流转完，或全新需求）→ 这才是真正该新建的时候：`{ convId, sessionId: null, title: r.title, kind: 'main', phase: r.phase, createdAt: now }`。

**为什么情形 2 必须是重指**：`openRequirementChat`（`req-view.js`）判断 conv 是否存在，查的是**本浏览器的 localStorage**；`createReqConv`（`chat.js`）用 `'c' + Date.now()` 铸新 id，与 `reqId` 无关。所以换浏览器 / 用桌面版 / 清过站点数据后打开同一需求，服务端拿到的必然是一个全新 `convId`。若新推一条，每换一个客户端就多一条同阶段 main —— 而 main 在 `handleSessionDelete` 里被无条件保护、前端也不渲染删除按钮，用户除了手改 `requirements.json` 没有出路。这正是 `requirements.js` 字段注释里写明 `devSession` 存在的那个「换浏览器重建 conv 续接」流程，是一等公民而非边角。

重指还顺带保住该行的 `sessionId` 与用户改过的标题，让新 conv 直接续上原来的 Claude session —— 恰是该流程的设计意图。

> 注意 `handleConv` 是**唯一**会创建 main 的路径：四个前端调用 `/api/req/session` 的点（重命名 / 新建子会话 / retro / `sessionId` 回填）没有一处发 `kind:'main'`。因此 §6.3 里 `handleSession` 的同阶段 main 唯一守卫实际是纯防御（防数据损坏与 API 直调），真正的唯一性由本节保证。

### 6.3 main 唯一性：从全局收窄到阶段内

跨阶段会出现两条 `kind:'main'`（开发期一条、测试期一条），三处约束要跟着改：

- `handleSession:670` 的「不能改变已有会话的 kind」保留；新增会话时打 `phase: r.phase`；同阶段内出现第二个 main → 409，跨阶段共存合法。
- `handleSessionDelete:724` 的 main 删除保护收窄为「**当前阶段**的 main 不可删」，历史阶段的 main 同样不可删（它是归档期汇总的数据源），即：所有 main 都不可删，但 409 文案区分。

  > 结论：删除保护实际维持「任何 main 都不可删」，只是原因从「bug-fix 落点」扩展为「bug-fix 落点 / 归档汇总数据源」。不需要按阶段放开。

- `handleSession:692` 的 `devSession` 回填加判据 `sessions[idx].phase === r.phase`：防开发期某条迟到的 `sessionId` 回填覆盖测试期的 `devSession` 锚点。

### 6.4 前端流转后处置（`public/js/req-chat.js` `phaseAction`）

现有 `after` 两种取值：`'remount'`（原地重挂横幅）/ `'leave'`（卸载转文档模式）。`dev-done` 当前用 `'remount'`，它只调 `mountReqChrome(id)` + `refreshReqList()`，**不会创建新 conv** —— 用户会原地卡在开发期那个 conv 上。

改为两个流转口都走「卸载装饰层 + 重开需求」：

```js
unmountReqChrome();
openRequirement(id);   // → openRequirementChat：convId 为 null → 新建 + 绑定 + openConv
```

**`after` 参数已整个删除**（2026-09-21 经代码评审）：原计划是加第三个分支 `'newconv'`，但落地后发现 `'newconv'` 与 `'leave'` 的代码完全相同——去向差异（进聊天 / 进归档表单页）由 `openRequirement` 内部按 `phase` 自己分流，与参数无关；而 `'remount'` 在 dev-done 改道后已无任何调用方。三路契约零消费者，留着只会误导。

**侧栏刷新不在这里做**：`newconv` 路径上 `refreshReqList()` 会早于 `POST /api/req/conv` 落地，必然刷出空会话树（`refreshReqList` 无序号守卫，是 last-response-wins，输掉竞速时空白会一直留到 30s 轮询）。正确刷新点见 §6.4b。

### 6.4b 侧栏刷新落在 conv 注册成功处

`openRequirementChat` 里 `POST /api/req/conv` 成功后就地 `refreshReqList()`。原因：`applyFetchedReq` **不 await** `openRequirementChat`，所以 `openRequirement` 的 Promise 在那次 POST 发出**之前**就 resolve 了 —— 在调用方加 `await` 也堵不住。放在注册成功处，每条铸新 conv 的路径（阶段流转 / 换浏览器 / 清过站点数据）都一并受益。

`openRequirementChat`（`req-view.js:874`）建 conv 时补两项参数：

- `kind: 'main'`（现在没传，默认落到 `'sub'`）；
- `seedPending: !!data.seed` + `seedText: data.seed` —— `/api/req/get` 在 dev/test 期已返回 `seed`（`buildSeedPrompt` 产物：需求标题 / 分支 / 工程角色 / 开发文档路径 / 设计准则）。沿用子会话现有范式：种子挂着不发，用户首次发言时才带出去，不主动烧额度。

### 6.5 侧栏过滤（`public/js/req-view.js:425`）

```js
const sessions = (r.sessions || []).filter((s) => !s.phase || s.phase === r.phase);
```

会话树本就只在 `dev`/`test` 阶段渲染（`isExpandable` 判据，`req-view.js:371`），归档期不展开，故此过滤不波及归档期的任何逻辑。

## 7. BUG 修复上下文（连带修复）

`req-logic.js:180` 的 `buildBugFixPrompt` 是裸提示词（只有 BUG 标题 + 详情），完全依赖 `req.devSession` 续接开发期上下文。`devSession` 清空后，BUG 修复会在**零上下文的新 session** 里跑，质量必然下降。

- `req-logic.js`：签名改为 `buildBugFixPrompt({ bug, seed })`，`seed` 非空时前置一段「【需求背景】」。
- `requirement-ops.js:372` `dispatchSystemTask`：仅当 `req.devSession` 为空时传 `seed`（`buildSeedPrompt(req, { featureSnapshot })`）。有 session 可续时不重复塞，省 token。

## 8. 测试

| 文件 | 用例 |
|---|---|
| `src/entrypoints/web/req-logic.test.js` | `runningSessions`：空数组 / 只开发期在跑 / 开发+测试混合只回当前阶段 / 会话无 convId 跳过 / 老数据无 phase 视为 dev。`buildBugFixPrompt`：带 seed 含「需求背景」、不带 seed 与现状等值 |
| `src/store/requirements.test.js` | `normalizeSessions` 给无 `phase` 的存量会话补 `'dev'`；已有 `phase` 的不覆盖 |
| `src/entrypoints/web/routes-requirements.test.js` | 子会话在跑 → `dev-done` 409 且响应带 `running` 列表；流转成功后 `convId`/`devSession` 为 null 且 `sessions` 已物化保留；`/api/req/conv` 登记出当前阶段 main 行（幂等）；跨阶段两个 main 共存 200、同阶段第二个 main 409；`devSession` 回填只认当前阶段的 main |

命令：`npm test`。

## 9. 明确不做（YAGNI）

- 不做「展开回看开发期会话」的折叠分组 UI。
- `test → archiving` 不做同类处理 —— 归档期对话本就禁用（`mountReqChrome` 的 phase 守卫，`req-chat.js:122`）。
- 归档期「优化汇总」`runRetroMapReduce`（`req-view.js:2385`）保持遍历全部非 retro 会话（含开发期），隐藏只在渲染层生效。
- 不为 `phase` 字段写一次性迁移脚本 —— 读侧 `normalizeSessions` 兜底 + 写时落盘的渐进迁移已够。

## 10. 已知边角

~~`req-view.js` UI 规范还原的守卫文案在测试期会误导，改成「请先打开需求会话」。~~ **这条经代码评审判定为错误结论，已撤回（2026-09-21）。**

追调用链：该 `onRestore` 所在的 `renderReportArea` ← `renderMainCol` ← `renderWorkbench`，而 `renderWorkbench` **只**在 `renderReqPage` 的 `req.phase === 'review'` 分支被调用。dev/test 的还原是另一个回调（`req-map-overlay.js`），那边没有 `convId` 守卫。所以这句提示**只有评审期可达**，而评审期 `req.convId` 恒为空（全前端唯一写 `/api/req/conv` 的是 `openRequirementChat`，只在 dev/test 跑；`PHASE_FLOW` 单向，不会带 convId 退回评审期）——它是每个评审期用户点还原时必然看到的那句。原文案「请先定稿进入开发期」给的是真实出路，改成阶段无关的措辞反而让人去打开一个那个阶段不可能存在的会话。**保持原样。**

教训：改用户可见文案前先确认该分支的真实可达阶段，别按「理论上也可能发生」来措辞。

## 11. 改动落点汇总

| 文件 | 改动 |
|---|---|
| `src/store/requirements.js` | `sessions[]` 加 `phase` 字段注释；`normalizeSessions` 补齐 `phase:'dev'` |
| `src/entrypoints/web/req-logic.js` | 新增 `runningSessions`；`buildBugFixPrompt` 加 `seed` 参数 |
| `src/entrypoints/web/routes-requirements.js` | `phaseGuard` 换判据 + 回 `running`；`handleDevDone` 物化并清锚点；`handleConv` 登记 main；`handleSession` 打 `phase` + 阶段内 main 唯一 + 回填判据；`handleSessionDelete` 文案 |
| `src/entrypoints/web/requirement-ops.js` | `dispatchSystemTask` 无 `devSession` 时传 `seed` |
| `public/js/req-chat.js` | `phaseAction` 新增 `'newconv'` 分支 + 409 `running` 列表弹窗 |
| `public/js/req-view.js` | 侧栏按 `phase` 过滤；`openRequirementChat` 传 `kind:'main'` + seed；3041 文案 |

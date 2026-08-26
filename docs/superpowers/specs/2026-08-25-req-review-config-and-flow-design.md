# 评审期配置与生成流程改造 —— 设计

日期：2026-08-25
状态：待实现（spec 已拍板，实现计划另出）

## 背景

评审期的三处交互都在「该就地做的事被弹层挡住了」这个共同问题上：

1. 选工程目录要先开「需求配置」弹层，弹层里再调系统文件夹框——两层。
2. 需求文档只能粘文本或传文件，而实际需求几乎都是飞书文档，现在得手工复制粘贴。
3. 点「生成开发文档」弹一个 loading 模态，两分钟后自行消失、回到原样，而后台任务其实还在跑。

三处独立成章，但共用同一批落点（`public/js/req-view.js` 的配置卡与行动区），一起改比分三次改省事，且第一、二块都要删同一个 `openConfigModal`。

## 一、工程目录：按钮直接调系统文件夹框

### 现状

`makeProjSlot` 的「选择工程目录」/「更改」→ `openConfigModal(req)`（`req-view.js:2797`）→ 弹层里点「选择」→ `GET /api/dirs/pick` → PowerShell `FolderBrowserDialog`（`routes-files.js:208`）。

### 改法

按钮 onclick 直接走 `pickProjectDir(req, key)`，跳过弹层：

```
点「选择工程目录」→ GET /api/dirs/pick → 系统框 → 拿到 path → PUT /api/req/config → loadAndRenderReq
```

要点：

- **点击期间按钮 disabled，文案转「选择中…」**。PowerShell 起框有 1~2 秒延迟，`timeout` 设的是 180 秒；没有反馈用户必然连点。
- 用户在系统框点取消 → 响应 `{ path: null }` → 静默返回，不弹 toast。
- 非 Windows 走 501（`routes-files.js:210`），照原样 toast 出来。这台机器是 Windows，不为跨平台再造一套内联目录树（YAGNI）。
- 槽位补「清除」入口。它原本只存在于弹层里，弹层一删就没了。

### 新配置工程的 `dev` 默认值

保持 `false`（只读），与原弹层的 checkbox 默认一致。

理由：选完目录再点一下槽位上现成的「开发 | 只读」二段开关，成本是一次点击；而「误把只读工程当成开发工程」的代价是模型在一个本不该动的工程里改代码。两边不对称，取保守侧。

### 顺带修一处并发缺陷

`makeDevSeg`（`req-view.js:1124`）保存时把 `projects` 全量拼好再 PUT，等于用渲染时的旧快照覆盖另一侧。而 `buildProjectsPatch`（`routes-requirements.js:114`）本来就只处理 `key in input` 的键，单键提交是被支持的。

抽 `saveProjectSlot(req, key, value)`，只传单键，`makeDevSeg` 与 `pickProjectDir` 共用：

```js
// value 为 null 表示清除该槽位
PUT /api/req/config { id, projects: { [key]: value } }
```

## 二、需求文档：支持飞书在线链接

### 取用策略：快照落地 + 手动刷新

保存链接时立刻拉正文，落成本地 `req-doc.md`；`reqDoc` 额外记 `{ url, fetchedAt }`。生成开发文档时读的是快照。

选它而不是「每次生成实时拉」的理由：

- 下游 `runDocgen` / `runQuizGen` 读的是 `fs.readFileSync(req.reqDoc.path)`（`requirement-ops.js:414`、`:879`），同步读。改实时拉要把这条链路改成异步取数，且每次生成都多一个网络与权限失败点。
- 同一份需求多次生成（首版 + 若干次修订）基于同一份正文，结果可复现。文档中途被人改过会导致前后两次生成基于不同输入，问题不好复现。

**已知取舍**：文档在飞书改了而没点刷新，生成的开发文档就是基于旧正文。界面只靠「08-25 14:30 拉取」这行时间戳提示，不主动告警。这是拍板选定的行为。

### 后端：`POST /api/req/doc-from-link { id, url? }`

链路全是现成件的拼装：

```
extractDocLinks(url)[0]            // feishu-normalize.js:68，已被飞书渠道使用
  → kind==='wiki' ? resolveWikiNodeObj(token) : token
  → fetchDocRawContent(docToken)   // lark.js:293
  → buildReqDocPatch(id, { name, text })   // 已支持 text 落盘到 reqDir(id,'req-doc.md')
```

- `url` 省略时取 `r.reqDoc?.url` 重拉。**「刷新」与「首次拉取」是同一个接口**，不写两份。
- 标题取正文首行 30 字（沿用 `feishu/index.js:196` 的做法），`name` 为 `${标题}.md`。
- phase 守卫与 `/api/req/config` 一致：仅 `review` 期。
- 不加 busy 守卫：拉文档不占 claude 额度，与生成任务不冲突。
- `buildReqDocPatch` 扩展为透传 `url` / `fetchedAt`；原有 `{name,text}` 与 `{name,path}` 两条分支行为不变。

**错误必须分类**，否则用户只能看到「拉取失败」而无从下手：

| 情况 | 响应 |
|---|---|
| 不是飞书云文档链接 | 400，说明只支持 docx / wiki 链接 |
| wiki 节点不是 docx（多维表格常见） | 400，带上实际 `objType` |
| 机器人无权限 / 文档不可见 | 透传飞书 msg + 引导「把机器人加为文档协作者」——这是最高频的失败原因 |
| 未配置飞书凭证 | 引导去设置页 |

### 前端：`makeDocSlot` 就地化

未配置时，链接框占主位：

```
📄 需求文档                        [上传文件] [粘贴文本]
┌──────────────────────────────────────┐ ┌──────┐
│ 粘贴飞书文档链接…                    │ │ 拉取 │
└──────────────────────────────────────┘ └──────┘
```

已配置且来源是飞书：

```
📄 需求文档                          [🔄 刷新] [更换]
┌──────────────────────────────────────────────┐
│ 订单批量导出需求.md                          │
└──────────────────────────────────────────────┘
🔗 飞书文档 · 08-25 14:30 拉取
```

- 「上传文件」触发隐藏的 `<input type=file>`，沿用现有 `/api/upload` 逻辑。
- 「粘贴文本」就地把该行换成 textarea + 保存 / 取消。
- 上传与粘贴两种来源不显示「刷新」（没有 url 可刷）。

### 删除 `openConfigModal`

`req-view.js:2785-2921`（`projRowHtml` + `openConfigModal`）整体删除，配套 `.req-config-modal` / `.req-proj-*` / `.req-doc-*` CSS 一并清理。

留着就是两套并行的配置写法，行为迟早走偏。`renderCfgSummaryCard`（文档产出后的右栏只读树）的「编辑」按钮同样指向它，改为**就地展开成主栏那套槽位**（复用 `makeProjSlot` / `makeDocSlot`），而不是另写一套编辑界面——否则「主栏能清除、右栏不能」这类差异会慢慢长出来。

同时把 `makeDevSeg` 的保存改走 `saveProjectSlot`：它原先每次都把 `projects` 全量拼好再 PUT，等于拿渲染那一刻的旧快照覆盖另一侧。

## 三、生成流程：无模态、不超时、状态自动刷新

### 现状与根因

点「生成开发文档」→ `startGenerateFlow`（`req-quiz.js:72`）→ 先 `mountModal(req, null, ...)` 显示等待态 → `POST /api/req/quiz` → `pollQuestions` 轮询等出题。

```js
const POLL_MS = 2000;
const POLL_MAX = 60; // 2 分钟兜底，超时按「分析失败」走降级
```

两分钟一到，`pollQuestions` 返回 `null`，前端当成「分析没找出歧义」，`closeModal()` 后直接 `runDocgenDirect`。而此时 quizgen 往往还在后台跑，`handleDocgen`（`routes-requirements.js:195`）遇 `r.busy` 非空直接回 409「文档生成已在进行或排队」。

于是用户看到：模态转两分钟 → 消失 → 界面回到配置态、什么都没发生 → 后台其实还在跑。**并且这一刻用户的问卷被静默丢弃了。**

### 改法

**A. 删掉超时降级。** 终止判据只留 `!data.busy && !data.queued`（`req-quiz.js:142`）——后端任务结束才清 busy，这条本身就精确覆盖失败场景，`POLL_MAX` 是多余且有害的。

不设超时是安全的，后端有三层兜底：`healStaleBusy()` 每 tick 自愈泄漏的 busy（`requirement-ops.js:96`）、`recoverBusyOnBoot()` 进程重启清残留、`runDocgen` 外层 catch。busy 不会永久挂着。

**B. 全程无模态。** 去掉 `mountModal`。点「生成开发文档」后：

```
POST /api/req/quiz → 202 → 立刻 loadAndRenderReq
  → 后端写的 busy 让现有 busy 条与行动区 loading 自然接管（这一步就是「自动刷新生成状态」）
  → quizgen 结束 → 问卷在主栏就地展开
  → 逐题作答 → 提交 → docgen → 主栏继续 busy 态
```

生成中的视觉效果保持现状，不额外加整页禁用遮罩。

**C. 问卷主栏内联化。** `req-quiz.js` 的 `.rqw-mask` / `.rqw-modal` 外壳换成主栏一张卡，内部结构（进度分段、题目、选项、补充框、底部按钮）不动。

新增模块态 `quizInlineOpen`，`renderMainCol` 的分支变为：

```
quizInlineOpen && 有题  → renderQuizPanel
hasDevDoc(req)         → renderReportArea
否则                    → renderConfigCard + renderPrimeBox
```

- 「取消」= `quizInlineOpen = false`，回到配置卡。题目已存在 store 里，下次点生成复用，不白花额度（与现有 `cancel` 语义一致）。
- 重开需求时 `quizInlineOpen` 复位为 false；此时 `quiz.status === 'ready'`，行动区按钮显示「继续作答」。

**D. 两套轮询合一。** `pollQuestions` 的 2s 轮询与 `startBusyPolling` 的 3s 轮询目前各跑各的。删掉 `pollQuestions`，统一由 `startBusyPolling` 驱动；在 `applyFetchedReq` 已有的 busy 下降沿钩子（`req-view.js:779`）补记 `wasBusyKind`，据此分流：

- `quiz.status === 'ready'` → 打开问卷面板
- `quiz == null` → 降级，直接 `runDocgenDirect`

`req-quiz.js` 的职责随之收敛为「渲染问卷面板 + 提交答案」，轮询与状态管理归 `req-view.js` 一处（SRP）。

**E. busy 文案按 kind 分。** `renderActionCard:1421` 与 `renderBusyBar:2522` 现在把 busy 写死成「正在生成 / 开发文档生成中…」。出题阶段显示这句是假话——它只跑十几秒且不读工程代码，套用「通常几分钟、大型工程更久」会让用户以为卡住了。按 `req.busy.kind` 分：

- `quizgen` → 「正在分析」/「正在分析需求文档中的不确定点…」
- `docgen` → 保持现状

**F. 排队窗口期也要分 kind。** 任务入队到泵派发之间有个 busy 尚未写入的窗口，前端在 `applyFetchedReq` 里合成一个假 busy 来顶上，但 kind 写死成 `'docgen'`（`req-view.js:728`），quizgen 排队时就会显示成「开发文档生成中」。后端 GET 响应补一个 `queuedKind`（取自 `queuedTasks(id)[0]?.kind`），前端据此合成——`queued` 是布尔值，带不出 kind。

## 测试

- `routes-requirements.test.js`：`doc-from-link` 的链接解析与四类错误分支（lark 调用需 mock）；`buildReqDocPatch` 透传 `url` / `fetchedAt`。
- 前端 DOM 层无既有测试惯例，纯逻辑抽在 `*.logic.js`——问卷的纯逻辑已在 `req-quiz.logic.js`，本次不新增可测逻辑。

## 风险

- **飞书快照不自动同步**：已在上文说明，是拍板选定的行为。
- **问卷从模态改内联后，「必答」的约束力变弱**：模态靠遮罩强制聚焦，内联面板用户可以直接滚走。约束仍在（未答时「下一题」禁用），但不再有物理阻挡。
- **删 `openConfigModal` 波及 `renderCfgSummaryCard` 的编辑入口**：文档产出后配置卡降级为右栏只读树，其「编辑」按钮需要改指向，不能漏。

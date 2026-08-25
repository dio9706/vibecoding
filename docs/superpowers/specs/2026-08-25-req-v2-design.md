# 需求功能 v2：需求变动 / 需求地图 / UI 规范还原 —— 设计

日期：2026-08-25
状态：交互原型（`public/proto-req-v2.html`）已经用户确认，本文为落地设计

## 1. 背景

现有「新需求」四阶段工作流跑通后暴露三个问题（用户原话）：

1. **跟正常对话没区别，token 消耗更大** —— 每次需求都要跟 agent 反复对话调整。
2. **需求文档细节失真** —— 文档里描述模糊的地方，模型按自己的猜测实现了；开发文档全是技术细节，
   看不出「哪个页面的哪个逻辑点被改了」。
3. **开发时 UI 未确认** —— 先按文档搭骨架，设计稿到位后没有稳定的还原入口，还原也不守项目规范。

对应三条改造：

| # | 能力 | 落点 |
|---|---|---|
| A | **需求变动** | 开发期右栏按钮 → 多行输入 → 影响预估 → 改地图/改代码 |
| B | **问卷 + 需求地图** | 评审期生成开发文档前先出问卷；产出「开发文档 + 需求地图」双报告；地图可标注，AI 一轮修订 |
| C | **UI 规范还原** | 地图页面节点挂 Figma 稿；按项目级 `ui-spec` 硬约束还原 |

**共同目的**：把「模型自己猜」变成可见、可批注、可一次性纠正，用一次结构化交互替掉多轮自然语言拉扯。

## 2. 用户拍板的交互口径

| 决策点 | 结论 |
|---|---|
| 需求地图形态 | **流程画布 · 节点连线图**（页面=节点，逻辑点挂节点内，连线=页面跳转） |
| 问卷形态 | **分步问卷，一屏一题**，AI 预填猜测并标注「不选就按这个实现」 |
| 标注回流 | **批量攒够一次提交**，生成地图 v2 并高亮本轮变化，可回看 v1 |
| UI 规范来源 | **项目级规范文本**，手动维护 + AI 从 Figma 抽草稿；还原时作硬约束注入 |

## 3. 关键设计决策

### 3.1 地图坐标由前端算，不让 LLM 出

LLM 出 `x/y` 既不稳定又浪费 token。约定 **LLM 只产出 `pages / edges / points` 的语义结构**，
坐标由前端 `req-map-layout.logic.js` 用分层布局算：以入度为 0 的页面为第 0 层，沿 edges BFS 分层，
同层横向等距排开。纯函数，可单测，换布局算法不动数据。

### 3.2 UI 规范落在 APP_DATA_DIR，不写用户工程目录

规范是**项目级**（按工程目录归属），但写进用户工程会污染对方仓库。
存 `APP_DATA_DIR/ui-specs/<dirSlug>.md`，`dirSlug` 由工程目录路径规范化后取尾段 + 短 hash 生成
（避免 `web` / `web` 撞名）。还原时把**全文注入 prompt**，不让模型自己去找。

### 3.3 问卷失败不阻塞主流程

问卷生成是 docgen 的**前置增强**而非前置依赖。生成失败 / 用户点「跳过问卷」时，
直接走原有 docgen 路径。这样新链路挂了不会把老功能一起带走。

### 3.4 地图与开发文档同源、分两次调用

一次 LLM 调用同时产出两份格式迥异的报告，解析脆弱。改为：
docgen（沿用现有实现，prompt 追加问卷答案）→ 落版 → **复用同一 `docSession` resume** 产出地图 JSON。
第二次调用带着第一次的上下文，省 token 且两份报告天然一致。

### 3.5 需求变动复用「消息 + 系统任务」既有范式

不新造执行通道。`POST /api/req/change` 落盘变更记录后：
- 有地图 → 先跑一次**影响预估**（轻量 LLM，只读地图 JSON，不碰代码），返回命中的逻辑点；
- 用户选 `both` → 走 `sendMessageProgrammatically` 发进需求会话（与 apidoc 同款）；选 `map` → 只更新地图。

## 4. 数据模型增量

`requirements.json` 每条记录新增字段（全部可选，老需求读侧降级为 null/[]）：

```js
quiz: {                       // 评审期问卷
  status: 'ready' | 'answered',
  questions: [{ id, title, hint, why, opts: [{ v, lab, desc, guess }] }],
  answers: { [qid]: { v, note } },
  at,
} | null,

reqMap: {                     // 需求地图
  versions: [{ v, path, at, note }],   // path → APP_DATA_DIR/requirements/<id>/map-v<n>.json
} | null,

changes: [{ id, text, scope: 'both' | 'map', hits: [pointId], at }],   // 需求变动记录
```

地图 JSON 文件结构（落盘全文，不塞进 requirements.json —— 单条记录会撑爆）：

```js
{
  v: 1,
  pages: [{
    id, name, file,
    state: 'new' | 'changed' | 'untouched',
    figma: { url, node } | null,
    restoredAt: null,
    points: [{ id, type: 'add'|'mod'|'del', title, before, after, src: [], files: [] }],
  }],
  edges: [{ from, to, label }],
  annots: { [pointId]: { verdict: 'wrong'|'ok', text, at } },   // 提交修订时清空并进下一版
}
```

`figma` / `restoredAt` / `annots` 是**前端写、后端存**的可变部分，改动走 `PUT /api/req/map/*`
就地改当前版文件，不产生新版本；只有「提交标注 → AI 修订」才 +1 版。

## 5. 后端设计

### 5.1 模块划分

| 模块 | 职责 | 类型 |
|---|---|---|
| `src/entrypoints/web/req-quiz.logic.js` | 问卷 prompt 构造、LLM 输出解析与校验、答案 → docgen 片段 | 纯逻辑，单测 |
| `src/entrypoints/web/req-map.logic.js` | 地图 prompt 构造、地图 JSON 规范化与校验、标注 → 修订 prompt、版本号 | 纯逻辑，单测 |
| `src/entrypoints/web/req-uispec.logic.js` | 工程目录 → dirSlug、规范注入片段、还原 prompt | 纯逻辑，单测 |
| `src/entrypoints/web/requirement-ops.js` | 新增 `runQuizGen` / `runMapGen` / `runMapFix` / `runChangeImpact`，接入现有串行闸 | 编排 |
| `src/entrypoints/web/routes-requirements.js` | 新增 8 条路由薄壳 | 路由 |
| `src/store/ui-specs.js` | UI 规范读写（APP_DATA_DIR/ui-specs/） | 存储 |

**边界原则**：所有 prompt 构造与 LLM 输出解析进 `.logic.js`（零 IO、可单测）；
`requirement-ops.js` 只负责「调 runClaude + 落盘 + 写 busy」；路由只做鉴权与 body 校验。

### 5.2 路由

```
POST /api/req/quiz         {id}                        → 202，入队生成问卷
PUT  /api/req/quiz         {id, answers}               → 存答案 → 入队 docgen（带答案）→ 链式 mapgen
GET  /api/req/map          {id, v?}                    → 地图 JSON 原文
PUT  /api/req/map/figma    {id, pageId, url, node}     → 挂/解绑设计稿（就地改当前版）
POST /api/req/map/restore  {id, pageId}                → 按 UI 规范还原（发消息进需求会话）
POST /api/req/map/annotate {id, annots}                → 提交标注 → 入队 mapfix → 出 v+1
POST /api/req/change       {id, text, scope}           → 需求变动（先影响预估，再按 scope 执行）
GET  /api/req/uispec       ?dir=                       → UI 规范全文
PUT  /api/req/uispec       {dir, text}                 → 保存 UI 规范
```

沿用现有约定：长任务走 `enqueueSystemTask` + `busy` 串行闸，返回 202；
`busy` 非空时再次入队返回 409；前端 3s 轮询 `GET /api/req/get` 感知状态。

### 5.3 LLM 任务形态

| 任务 | cwd/工具 | session | 输出契约 |
|---|---|---|---|
| `quizgen` | 同 docgen（只读 Read/Grep/Glob） | 新建，存 `docSession` | 纯 JSON 数组，`[{id,title,hint,why,opts}]`，3–8 题 |
| `docgen` | 沿用现有 | resume `docSession` | 沿用现有三节 markdown（prompt 追加问卷答案节） |
| `mapgen` | 只读 | resume `docSession` | 纯 JSON `{pages,edges}`，不含坐标 |
| `mapfix` | 只读 | resume `docSession` | 纯 JSON `{pages,edges}`（全量重出，前端 diff 高亮） |
| `change-impact` | 无工具（纯推理） | 无 | 纯 JSON `[{pointId, action, why}]` |
| `ui-restore` | 走需求会话（可写） | 需求主会话 | 自然语言，即普通开发消息 |

**JSON 输出鲁棒性**：模型爱裹 ```json 代码围栏。`req-map.logic.js` 的 `parseJsonLoose()`
统一剥围栏 + 取首个 `{`/`[` 到末个 `}`/`]` 再 `JSON.parse`，解析失败抛带原文前 200 字的错误。

## 6. 前端设计

| 模块 | 职责 |
|---|---|
| `public/js/req-quiz.js` | 分步问卷视图（一屏一题、进度条、AI 猜测预选、跳过） |
| `public/js/req-map.js` | 画布渲染、平移缩放、筛选、抽屉（逻辑点 / 页面）、标注、提交修订 |
| `public/js/req-map-layout.logic.js` | 分层自动布局（纯函数，单测） |
| `public/js/req-change.js` | 需求变动弹框（多行输入、影响预估、范围二选） |
| `public/js/req-uispec.js` | UI 规范面板（阅读/编辑/从 Figma 抽草稿） |

挂载点（不改既有渲染主干，只加分支）：
- 评审期：`req-view.js` 的 `renderReqPage()` 在 `phase==='review'` 分支加 tab 切换
  「开发文档 / 需求地图」，问卷态整页接管。
- 开发期：`req-chat.js` 的 `renderDevRail()` 顶部插入「需求管理」段（需求变动 / 需求地图 / UI 规范）。

样式统一进 `public/app.css` 末尾，前缀 `rq-`（**不复用 `.doc` / `.chip` 这类已被占用的通用类名**，
原型阶段已踩过 `.chip.doc` 撞 `.doc` 的坑）。

## 7. 错误处理

- LLM 输出解析失败 → 不落版，`history` 留痕，前端红条提示「重新生成」，老版本仍可看。
- 问卷生成失败 → 降级为直接 docgen（见 3.3）。
- 地图缺失时点「需求变动」→ 跳过影响预估，退化为纯文本提交（功能不阻塞）。
- 还原时会话未就绪 → 显式 toast 报错（对齐 apidoc 的既有守卫，不静默丢消息）。

## 8. 测试

沿用仓库 `node --test` + `*.logic.test.js` 约定，纯逻辑全覆盖：
问卷解析（含围栏/缺字段/题数越界）、地图 JSON 规范化（孤儿 edge、重复 id、type 非法）、
分层布局（无边、成环、多根）、dirSlug 撞名、标注 → 修订 prompt 拼装。

编排层与路由层不写单测（沿用仓库现状），靠手动跑通验证。

## 9. 不做（YAGNI）

- 不做 Figma MCP 深度对接（先存 URL + 人工确认，还原靠规范注入）。
- 不做地图节点手动拖拽持久化（自动布局够用，拖拽是下一轮的事）。
- 不做地图 v1/v2 的逐字段 diff（只高亮「本轮被改过的点」）。
- 不做 UI 规范的版本历史（单文件覆盖写）。

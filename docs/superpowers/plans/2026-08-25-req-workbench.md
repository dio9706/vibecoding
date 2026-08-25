# 需求评审页工作台改版 · 实现计划

原型：`public/proto-req-review.html`（含 5 态切换，落地后可删）

## 目标

1. **修留白**：`#reqPage` 限宽 880 却未居中，宽屏右侧大片空白 → 限宽 1280 + 居中 + 右侧 300px 辅助栏。
2. **修主次**：工程配置从横排 chips 提为配置阶段主栏主角；文档产出后降级为右栏只读摘要。
3. **问卷改模态**：问卷是「点生成之后」才发生的事，不是独立阶段 → 从整页接管改为生成动作的模态前置。阶段轨由四步收为三步。
4. **问卷必答**：每题必选，逃生口是每题的「不确定」选项而非整体跳过。移除「按 AI 猜测跳过」与「跳过问卷直接生成」。
5. **每题自主补充**：选项穷举不完，保留自由文本；默认收起，选「不确定」时自动展开。
6. **生成前补充背景**：新增 prime 输入，随「生成」一并生效，不设独立提交按钮。

## 关键设计决定

### prime 用独立字段，不并入 supplements

`req.prime = { text, files, at }`，新接口 `PUT /api/req/prime` 只落盘不入队。

理由：`supplements` 是 append-only 历史，`supplementLines` 语义为「按时间序，后者优先级更高」；prime 是**一份可反复编辑的草稿**，只有一份，且需自动保存。并入会产生重复条目、破坏时间序语义，且 `handleSupplement` 每次提交都会 `enqueueSystemTask('docgen')` —— 背景不该触发生成。

### 「不确定」用保留值 `__unsure__`

不是 LLM 生成的选项（`parseQuiz` 要求每题恰好一个 `guess`），由前端注入。

`answersToPromptPart` 区分三态，措辞不同：
- 选了实质项 → `→ <选项>`
- 选了不确定 → `→ <guess项>（用户明确表示不确定，按默认猜测执行）`
- 未作答 → `→ <guess项>（用户未作答，按 AI 默认猜测执行）`

**未作答分支必须保留**：必答规则只约束新提交，已落盘的历史 answered 问卷仍可能缺题，删掉会让老数据渲染出错。

### prime 要同时喂给 quizgen

原型文案承诺「你说清楚的地方就不会再问」。若只喂 docgen 不喂 quizgen，用户写了半页背景还被问同样的问题，这个承诺就成了 bug。

## 任务

### 后端（逻辑层先行，有单测保护）

- [ ] **T1** `store/requirements.js`：新增 `prime: null` 字段
- [ ] **T2** `req-quiz.logic.js`：导出 `UNSURE_VALUE`；`buildQuizPrompt` 加 `primeText` 参数并注入「已说清的不要再问」；`answersToPromptPart` 区分三态 + 测试
- [ ] **T3** `req-logic.js`：`buildDocgenPrompt` 加 `prime` 参数与独立 prompt 节 + 测试
- [ ] **T4** `requirement-ops.js`：docgen / quizgen 调用处传 `prime`
- [ ] **T5** `routes-req-v2.js`：新增 `PUT /api/req/prime`；`handleQuizAnswers` 加必答校验（缺题回 400）并放行 `__unsure__`
- [ ] **T6** 跑 `npm test`

### 前端

- [ ] **T7** 新建 `public/css/req-workbench.css`，`index.html` 引入
- [ ] **T8** `req-view.js`：拆出 `renderStepsBar` / `renderConfigCard` / `renderPrimeBox` / `renderSidebar`，`renderReqPage` 重组为双栏；删 `renderDocEmptyState`
- [ ] **T9** `req-quiz.js`：改模态 `mountQuizModal`，必答校验 + 不确定选项 + 补充框收起展开 + 分析等待态
- [ ] **T10** 验证：`npm test` + 手工过 5 态

## 不做

- 需求地图画布（已有 `rq-map` 实现，仅接入页签）
- 归档/开发/测试期视图（本次只动评审期）

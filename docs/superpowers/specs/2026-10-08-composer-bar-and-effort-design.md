# 输入区工具栏 + 强度体系（composer bar & effort）· 设计

- 日期：2026-10-08
- 状态：已拍板（2026-10-08，四处决策经确认）；实现中，进度见 §8
- 关联：`public/index.html`（composer / 弹层）、`public/app.css`、`public/js/chat.js`、`public/js/conv-notify.js`、`src/entrypoints/web/{run-openai,routes-run,conv-inbox}.js`、`src/providers/openai-compat{,-model}.js`、`src/store/settings.js`（模型元数据）、`entrypoints/web/provider-models.logic.js`
- 背景：自「凭证多模型」落地后，模型弹层里的列表可能很长（openrouter 级端点几百个模型）；同时强度/通知/编排等常控件散在悬浮弹层里。要求：**把模型选择、模型强度、飞书通知、Ultracode 移入输入框底部**，输入框加高、发送按钮内嵌；强度下拉化并**适配自定义模型的强度档位**（如 DeepSeek low/high/max），不支持的选择性置灰。

## 1. 拍板记录（2026-10-08 已确认）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 悬浮控件去留 | **权限模式也下移**（进输入框底栏）；悬浮按钮仅保留「工具」弹层（工具开关/技能/MCP） |
| 2 | Ultracode 语义 | **作最高一档**：选中 = 开编排 + 强制「极高（xhigh）」档；退出编排选其他档即可（仅 Claude；自定义模型整项置灰） |
| 3 | 自定义强度选项 | **「关闭思考」(none) + `/models` 返回的 `effort.supported_levels`**；初始选中模型的 `default_level`，无则第一档；**无 effort 元数据的模型整体置灰** |
| 4 | 模型下拉筛选 | 不加搜索框；限高滚动 + 按凭证分组 |

## 2. 目标与非目标

**目标**

1. Composer 重构：加高输入区（min-height 86px / max-height 260px），发送/停止按钮**内嵌**到输入框底栏右侧；
2. 底栏控件（自左向右）：模型下拉、强度下拉（含 Ultracode）、权限模式下拉、设计稿还原、🔔 飞书通知、发送/停止；
3. 三个下拉均为**向上展开**的面板，模型面板限高滚动（Claude 分节 + 自定义按凭证分组，沿用多模型分组渲染）；
4. 强度体系打通：Claude 五档（low/medium/high/xhigh/max，对齐 SDK `EffortLevel` 与设置页选单）+ Ultracode 档；自定义模型按发现到的 `effort.supported_levels`（+ none）出档，选中值经 `reasoning_effort` 透传到 OpenAI 兼容请求；
5. 悬浮「工具」按钮保留：弹层只含工具开关区（内置工具/MCP/技能）。

**非目标（本期不做）**

- 模型面板搜索/过滤；模型能力元数据（context_window 等）展示；
- Claude 每模型 `supportedEffortLevels` 过滤（保持全档位，SDK 负责静默降级）；
- 自定义模型的强度档位来自 provider 静态表（来源只有 `/models` 元数据）。

## 3. UI 结构（index.html + app.css）

```html
<footer class="composer">
  <div class="composer-box">                     <!-- 唯一的圆角边框体 -->
    <div id="prompt" class="composer-input" contenteditable …></div>  <!-- 加高、可长 -->
    <div class="composer-bar">
      <div class="bar-menu">…模型 chip + #modelPop（Claude pills + 自定义分组，限高滚动）…</div>
      <div class="bar-menu">…强度 chip + #effortPop（JS 渲染档位 + Ultracode）…</div>
      <div class="bar-menu">…权限 chip + #modePop（四个模式行）…</div>
      <button class="bar-icon" id="figmaRestoreBtn">…</button>
      <button class="bar-icon" id="notifyBtn" title="飞书通知">🔔</button>
      <span class="spacer"></span>
      <button class="btn primary" id="sendBtn">发送</button>
      <button class="btn stop" id="stopBtn" hidden>停止</button>
    </div>
  </div>
</footer>
```

- 悬浮工具按钮：`#toolsFabBtn`（原 #modelFabBtn 改名），弹层 `#toolsPop`（原 #modelPop 的工具区）；`.fab-row` 仍随 composer 高度动态上移（现有 ResizeObserver 逻辑不动）。
- `#modelPills`（Claude 静态 pills）与 `#customModelPills`（按凭证分组）搬进新模型面板，ID 不变（既有绑定/测试改动最小）。
- 触发标签：模型 chip = 当前模型名；强度 chip = `强度 · 档位名`（Ultracode 时显示 `✨ Ultracode`；不支持时置灰）；权限 chip = 模式名。
- 点击外部/互斥：任一 chip 打开时关掉其他面板；`document` 级外部点击收起（沿用现有范式）。

## 4. 强度体系

### 4.1 Claude

- 档位 = `['low','medium','high','xhigh','max']`（与 SDK `EffortLevel`、设置页「默认模型强度」对齐；原 UI 只有 4 档、设置页的 max 实际被前端白名单丢掉——本次统一）；
- Ultracode 作最高一档：选中 → `chatUltracode=true` + `chatEffort='xhigh'`；选任一亮档 → `chatUltracode=false`；
- 模型为 `auto` 时强度控件置灰（分类器决定），沿用现状。

### 4.2 自定义模型（openai-compat）

- 发现元数据：`/models` 条目的 `effort.supported_levels` / `effort.default_level` 随模型列表一并存储（`models: [{id, name?, efforts?, defaultEffort?}]`，`store/settings.js#normalizeModelList` 归一）；
- 选项 = `关闭思考(none)` + `supported_levels`；初始值 = `default_level` ∈ 选项，否则第一档；
- 无 `efforts` 的模型：强度控件置灰（tooltip「该模型不支持强度选择」）；
- Ultracode 行对自定义模型置灰（tooltip「自定义模型不支持 Ultracode」）；
- 发送：`effort` 值经 `/api/run/start` → `startOpenAiRun` → provider `input.effort` → `streamTextToModelRun` 的 `providerOptions: { 'openai-compat': { reasoningEffort } }`（AI SDK openai-compatible 已具备该选项字段）；`none` 原样透传（DeepSeek 语义 = 关闭思考）；
- 摘要调用（T7 rolling summary）不带 effort（廉价一次性调用）。

### 4.3 状态与校验

- `chatEffort` 仍单值；切换模型/provider、还原会话时校验：非法值回落（Claude → 'medium'；自定义 → default/第一档；无档位 → 保留但控件置灰、发送不带）；
- 会话偏好 `effort`/`ultracode` 的 recordMessage 快照 / persistPrefsToConv / applySessionPrefs 流程不变，仅校验函数改为 provider 感知；
- 强度变化时：持久化（Claude 走 `saveUiPrefs`；自定义只在会话内）+ 运行中提示「下一条消息生效」。

## 5. 后端链路（effort 透传）

| 位置 | 变化 |
|---|---|
| `routes-run.js` | openai 分支把已解析的 `effort` 传给 `startOpenAiRun` |
| `run-openai.js` | `startOpenAiRun`/`resumeOpenAiRun` 接收 effort → `run.effort`（journal/index 的 `effort` 不再写 null）→ `runOpenAiSession` → provider run input；`buildFollowUpItem` 已快照 `run.effort`，`conv-inbox.js` openai 分支补传 |
| `openai-compat.js` | `input.effort` → `buildModelRun` → `createOpenAiCompatModelRun({ reasoningEffort })` |
| `openai-compat-model.js` | `streamTextToModelRun(lm, tools, signal, reasoningEffort)` → `providerOptions: { 'openai-compat': { reasoningEffort } }`（仅非空时） |
| `provider-models.logic.js` | `extractModels` 增读 `effort.supported_levels`/`default_level` → `efforts`/`defaultEffort` |
| `store/settings.js` | `normalizeModelList` 保留 `efforts`/`defaultEffort`（空则省略） |

## 6. 兼容与边界

| 场景 | 行为 |
|---|---|
| 老会话/老凭证 | 无 effort 元数据 → 自定义强度置灰；Claude 档位行为不变（新增 max 可选） |
| `default_effort` 值不在 supported_levels | 回落第一档 |
| 运行中切换（模型/强度/模式） | 沿用「下一条消息生效」提示；模式仍走 `/api/run/set-mode` 即时切换 |
| Workflow 工具被禁用时选 Ultracode | 复用 `canEnableUltracode` 守卫：toast 提示 + 不生效 |
| 自定义模型会话还原 up to 无缓存 | 首次需要档位时拉一次 `/api/credentials`（有缓存）；面板打开时强制刷新缓存 |
| e2e | `e2e-panels-smoke`（弹层触发/结构）、`e2e-conv-notify`（通知按钮直达点击）需更新 |

## 7. 测试策略

- `public/js/effort.logic.test.js`（新纯层）：档位计算（Claude/自定义/无元数据）、标签映射、初值回落、`none` 处理、Ultracode 语义；
- `provider-models.logic.test.js`：effort 元数据解析（有/无/坏形状）；
- `store/settings.test.js`：`normalizeModelList` 保留 efforts/defaultEffort；
- `openai-compat.test.js` / `openai-compat-model.test.js`：effort → `providerOptions['openai-compat'].reasoningEffort`（MockLanguageModelV4 捕获）；
- `run-openai.resume.test.js`：start/resume 的 effort 落到 provider 与 run 记录；
- `conv-inbox.test.js`：openai 排队排空带 effort；
- `conv-notify.test.js`：新按钮结构下的绑定；
- `e2e-panels-smoke.mjs`：新模型入口 + 工具弹层；`e2e-conv-notify.mjs`：通知按钮直达；
- 全量 `npm test` + `npm run test:e2e`。

## 8. 实施状态

- [x] spec 拍板（2026-10-08，四处决策见 §1）
- [x] 后端 effort 透传（provider/run/routes/conv-inbox）+ 元数据解析
- [x] 前端纯层 `effort.logic.js`
- [x] 布局重构（index.html/app.css）
- [x] chat.js / conv-notify.js 接线
- [x] e2e 更新 + 全量验证 + 文档同步（`npm test` 3724 全绿；`npm run test:e2e` 12/12——复跑实锤并修复了 settings-panel 误删 `EDIT_ICON_SVG` 导入的页面错误）

### 迭代（2026-10-08 晚，用户反馈）

- **强度控件最终形态（用户手改定型）**：**chip + hover tooltip**——底栏显示「强度 · 档位」chip（Ultracode 时 chip 与轨道流光），悬停 120ms 弹出 tooltip：当前档 + 一句话说明（`effortDesc`）+ 滑块 + **刻度标签**（`effortTickLabel`，点击跳档）；点击钉住（触屏/键盘）、Esc 收起、拖拽中不移出收起；档位 = 当前模型 options（自定义 none→low→…→max；Claude low→…→max→Ultracode），`✨ Ultracode` 选中时轨道**横向流光**（meteors 风格 CSS 动画，reduced-motion 降级）；
- 弃用键修复：`providerOptions` 从 `openai-compat` 换 `openaiCompat`；
- 档位归一加固：`ensureEffortValid()` 在每次 `syncModelUI` 前执行（切模型瞬间纠正非法遗留值）；
- 事故复盘见 `2026-10-08-openai-run-empty-output-fix.md`；**步数预算随后按用户拍板改为默认无上限 + 强制收尾（OpenCode 式）**，见 `2026-10-08-unlimited-steps-and-forced-wrapup.md`；
- 工具弹层按 provider 展示真实工具集，见 `2026-10-08-per-provider-tool-list.md`。

## 9. 追加需求（2026-10-08）：强度 = chip + hover tooltip 里的滑块

用户口头需求两步走：① 强度别用下拉列表，改成一根滑块条（none 不思考 → … → Max → ✨ Ultracode），选到 Ultracode 要有**横向**流光（meteors 风格）；② 滑块别常驻底栏，收进 tooltip。

**结论（已实现）**

- 底栏只留 chip：`强度 · 中` / `强度 · ✨ Ultracode` / `强度 · Auto` / `强度 · —`；Ultracode 时 chip 自带发光 + 渐变色边框（tooltip 收起也看得出编排已开）。
- 滑块、当前档位名、一句话描述、刻度都在 `#effortPop`（`.bar-pop` 同款面板）里：
  - hover 打开（120ms 延迟，扫过不算），移出 200ms 收起；**点击钉住**（触屏 / 键盘走这条）；Esc 收起并把焦点还给 chip；拖滑块或滑块聚焦时不收起；
  - 刻度 = `effortOptions()`，点一下直接跳档；Ultracode 不可达时（「工作流」工具被禁）刻度褪色但仍可点 → toast 解释后回弹；
  - 可用态不挂原生 `title`（原生气泡会和面板打架），只有置灰态才用 title 解释原因。
- 档位集合不变（`effort.logic.js` 为准）：Claude = low/medium/high/xhigh/max + ✨ Ultracode；自定义 = none(不思考) + `/models` 的 `supported_levels`。**Claude 没有「不思考」档**——SDK `EffortLevel` 最左就是 low，滑块最左端即「低」。
- Ultracode 特效 = **横向 meteors**（照抄 inspira-ui `special-effects/meteors`，只掰方向）：14 颗流星，2px 圆头（`#94a3b8` + 1px 白描边 + 柔光）+ **1px×50px 拖尾**（`linear-gradient(90deg, #64748b, transparent)`），随机 `top` / 延迟 0.2~1s / 时长 2~10s / 行程 340~420px，`@keyframes meteor-h` linear infinite。方向：参考实现的 `rotate(215deg) + translateX(-500px)` 是「斜向下落、拖尾在上方」，这里等价掰成 `rotate(180deg)` → 左进右出、拖尾在身后。流星铺满整个 tooltip 面板（`.effort-meteors` 绝对定位层，文字 `z-index:1` 浮在上面），仅在 `.ultra` 时 `display:block`；`prefers-reduced-motion` 下关动画。
  - 上一版把「流光」做成贴在 6px 轨道上的 `repeating-linear-gradient` 扫光，用户反馈**「跟 meteors 完全不一样」**——正解是容器级特效 + 独立圆头/拖尾元素，轨道只留彩色渐变与发光。
- 新增纯层函数 `effortDesc()` / `effortTickLabel()`（tooltip 描述行 / 刻度短标签），单测在 `public/js/effort.logic.test.js`。

## 10. 追加需求（2026-10-08，用户反馈三条）：点击弹出 / 斜 35° 流星 / 强度默认空

用户原话：①「强度默认似乎是空的，需要重新打开模型选择，强度才会自动回填」；②「强度跟其他的弹框一样点击弹出，不要移上去就弹出」；③「Ultracode 模式的流星效果改为斜 35° 坠落」。

**① 强度默认空（真 bug，已复现）**

- 现象（本地 stub 后端 + playwright 复现）：自定义模型会话启动后 chip = `强度 · —`、面板刻度为空；**点开一次「模型选择」后自动填成 `强度 · 高`**。
- 根因：自定义模型的档位元数据挂在**凭证下的模型条目**上，读取要 `credId` + `model` 双命中；而「老用户没存过 credId → 按 model 唯一认领」这段逻辑**只写在 `refreshCustomModelPills`（模型弹层）里**，启动与还原会话都不做 → 凭证查不到 → 档位查不到 → 控件只能是空的。
- 修复：
  - 认领逻辑收敛成纯函数 `effort.logic.js#rehomeCustomCred`（含单测），`reconcileCustomCred()` 在**启动 / 还原会话 / 打开模型弹层**三处同源调用；
  - `ensureCustomCreds` 取失败**不写缓存**（写 `[]` 等于把「没取到」记成「没有凭证」，之后永不重试 —— 用户报的「非得点一次模型选择」正是这条）；非 2xx 也按失败处理，避免一次 500 把自定义会话踢回 Claude；
  - 凭证**未知**（不是「不支持」）时 chip 显示 `强度 · …` 并 `scheduleCredsRetry()` 自动补拉（1.5s 一次、上限 3 次），后端恢复即自愈；`强度 · —` 只留给「该模型确实没有档位元数据」。
- 边界（保留原有取舍）：凭证被删 / 模型已不在任何凭证 → 回落 Claude；同名模型挂多条凭证（归属无法判定）→ 不认领也不回落，等用户自己选。

**② 点击弹出（不再 hover）**

- 强度面板改与模型 / 权限面板同款：`toggleBarMenu(effortPop, refreshEffortOnOpen)` —— 点击开、再点关、点外部或 Esc 收起；
- 删掉 `effortPinned` / `effortHoverTimer` / `effortDragging` 三个 hover 时代的状态与 mouseenter/mouseleave/pointerdown 监听（含「拖滑块时不收起」的补丁：面板不再自动收起，补丁本身失去意义）；
- 打开面板时若档位元数据未知，顺手补拉一次凭证（`refreshEffortOnOpen`），面板打开即出档。

**③ 流星斜 35° 坠落**

- `rotate(180deg)` → `rotate(215deg)`：215° = 180° + 35°，即参考实现的原角度（本地 +x 指屏幕左上、位移取反 → 向右下坠落，拖尾留在左上方）；
- 起点改铺在面板**左上外侧**（`top: -40%~0%`、`left: -140~-20px`），行程 380~560px（斜向要跨过面板宽度），否则 35° 斜落会在面板中间就飞出可视区；
- 实测（playwright 采样圆头位移）：`dx>0, dy>0, atan2 ≈ 34.9°`。

**验证**：`npm test` 3763 全绿（新增 `rehomeCustomCred` 5 例）；`npm run test:e2e -- panels-smoke composer-draft steer-bubble ask-chip approval-badge` 5/5。

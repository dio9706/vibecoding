# 项目优化面板：细粒度修复与多轮操作 · 设计

> 状态：待实现 ｜ 日期：2026-09-17 ｜ 影响面：`src/features/project-optimize/`、`src/entrypoints/web/optimize-ops.js`、`public/js/optimize-*`

## 一、背景与目标

当前面板的修复是**按维度整体触发**的：勾一个「复杂度与函数规模」，这一维的 9 条问题要么全修、要么不修；风险是**按钮档位**（低风险 / 中高风险两个按钮），与维度而非具体问题挂钩。

用户要的是把决策权还给人：**看到每一条能修什么、有多大风险，自己勾**。配套四件事——按钮统一移到顶部、体检可中止、修复完成后能继续多轮操作、修完弹一份带复测建议的报告。

### 关键判断：这不是新造机制，是把已有能力暴露出来

调研后端后确认三件事，它们决定了本设计的形状：

1. **风险三档早就存在**。`fix-engine.logic.js` 的 `STRATEGY_RISK` / `RISK_META` 已定义 low/medium/high，注释明确写着「**风险属于策略，不属于维度**」，连给 UI 的文案都备好了（"文案放这里而不是前端，免得两处措辞漂移"），只是从未有接口把它送到前端。
2. **执行层天然支持子集**。`runFixForDim({ dim, issues })` 收的就是 issues 数组，传子集即可——细粒度勾选对执行层是**零改动**。
3. **中止的底座已具备**。`audit-engine.js` 与 `llm-readonly-agent.js` 都已接受 `signal`，缺的只是 checkup job 上的 `AbortController`（fix job 早有）。

所以本设计的工作量集中在「**暴露 + 编排 + 交互**」，而不是「重写修复引擎」。任何要求改写 `fix-engine` / 各 `strategies/` 内部逻辑的做法都属于走偏。

## 二、拍板记录

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 风险确认方式 | **勾选驱动 + 命中中高风险时二次确认**。取消风险按钮档位，「一键修复」执行用户勾了什么就修什么 |
| 2 | 复测清单生成 | **规则化**：改动文件 → 反查最近 `CLAUDE.md` 的模块职责。零 LLM、零额度 |
| 3 | 中止体检语义 | **保留已完成维度**，未跑的标 `cancelled`（不是 error），文案「已取消，重新体检可续」 |
| 4 | 「全部修完」判据 | **必须重新体检才重算**。修复后分数/问题数/维度状态一律不动 |
| 5 | advisory 项的位置 | **同一棵树**，用动作标签区分（改源码/改文档/新建测试/改配置/只出清单） |
| 6 | 交付节奏 | **一次性完整交付**，按「后端契约先行 → 前端跟进」顺序推进 |

## 三、核心抽象：修复计划（FixPlan）

在体检报告与修复执行之间插一层。它不发明分类，只把后端已有的分派结果摊平：

```
report.dims[*].issues
   │
   │  buildFixPlan()          纯函数，复用既有 claims() + riskOf()
   ▼
[{ id, dim, category, file, line, message, severity, action, risk, fixable }]
   │
   │  用户勾选
   ▼
{ items: ["complexity#3", "docs#0", ...], reportAt }
   │
   │  resolveSelection()      后端还原成 issue 子集
   ▼
runFixForDim({ dim, issues })    ← 执行层零改动
```

### `action` 与 `risk` 是同一来源的两面

两者都从**策略**派生，不是两套独立分类。这是本设计最重要的一致性保证——它意味着「标签」和「实际会发生什么」不可能漂移：

| 策略 | 动作标签 | 风险 | 来源 |
|---|---|---|---|
| `deterministic` | 改配置 / 删重复行 | 低 | `STRATEGY_RISK` |
| `llm-create` | 新建测试 | 低 | `STRATEGY_RISK` |
| `advisory` | 只出清单 | 低 | `STRATEGY_RISK` |
| `llm-rewrite` | 改文档 | 中 | `STRATEGY_RISK` |
| `llm-refactor` | 改源码 | 高 | `STRATEGY_RISK` |
| `map`（bespoke） | 生成/改写地图 | 中 | `registry.js` 的 `risk` 字段 |
| `rules`（bespoke） | 降级为技能（删文件+改写全仓引用） | 高 | `registry.js` 的 `risk` 字段 |

`map` / `rules` 走专用流程（`fix-map.js` / `fix-rules.js`），不经 `partitionIssues`，所以它们的风险显式声明在注册表上——`registry.js` 里已有注释说明这个例外的理由，计划构建器必须走这第三条路径，不能想当然按策略表推。

### 计划项的粒度：一律是 issue

**所有计划项都是「报告里的一条 issue」**，包括 `map` / `rules` —— 它们的专用流程本就是从 `report.dims.map.issues`（M1~M4）和 `report.dims.rules.issues` 派生的，不是另一套数据源。

统一粒度的理由是 id 格式能保持单一形态（见第四节）。差别只在**还原之后怎么执行**：

| 维度 | 选中 issue 子集后的执行路径 |
|---|---|
| 通用引擎的 15 维 | 直接喂给 `runFixForDim({ dim, issues })` |
| `rules` | 子集喂给 `selectFixableRules` 的子集变体，再走 `demoteOne` |
| `map` | 子集喂给 `selectFixableMap` 的子集变体，再走 `fixDeadLinks` / `writeGeneratedMap` / `writeStaleAudit` |

因此 `selectFixableRules(report)` / `selectFixableMap(report)` 需要增加一个「只看这些 issue 下标」的入参（默认全选，保持既有调用点行为不变）。这是本设计对这两个函数的**唯一**改动。

被检测器判 `fixable: false` 的 issue 照常进计划，但动作固定为「只出清单」——它们不会被跳过，这是 `fix-engine.logic.js` 开头「没有 issue 会被静默丢掉」那条铁律的延续。

## 四、id 设计与安全边界

### 契约

```
id       = "<dimId>#<issueIndex>"        例：complexity#3、map#0、rules#2
提交体    = { dir, items: [id...], reportAt }
```

**所有维度同一格式**，`map` / `rules` 也不例外（见第三节「计划项的粒度」）。下标指向 `report.dims[dimId].issues` 的位置。

`reportAt` 取 `report.at`。后端在 `startFix` 入口比对：与当前落盘报告不一致即返回 409，让前端重拉计划。这道校验防的是「用户拿着旧计划去打新报告」——下标会错位，修到不相干的文件上。

### 明确否决的方案：前端回传 issue 对象

更省事的做法是前端把勾选的 issue 原样 POST 回来，后端不必做下标还原。**否决，这是安全边界**：

那等于让前端指定「要改哪个文件」。修改一下请求体的 `file` 字段，就能让 `llm-refactor` 去重构仓库里任意路径的源码——而这个功能本身持有 bypassPermissions 级的写权限。**修复引擎的输入必须来自后端自己落盘的报告，前端只能传下标。**

同理，`resolveSelection` 必须对下标做边界校验（越界、非整数、重复一律丢弃并记日志），不能信任前端传来的任何数字。

## 五、模块落点

严格遵循既有分层（`entrypoints → features → capabilities → store → shared`），不新建目录：

| 文件 | 性质 | 职责 |
|---|---|---|
| `features/project-optimize/fix-plan.logic.js` | **扩展** | 新增 `buildFixPlan(report, dimensions)` / `resolveSelection(report, ids)`。纯函数，零 IO。该文件本就叫「选材与提示」，职责天然吻合 |
| `features/project-optimize/retest.logic.js` | 新增 | `buildRetestList(changedFiles, moduleDocs)` 纯函数 |
| `features/project-optimize/retest.js` | 新增 | 读各级 `CLAUDE.md` 的薄 IO 层（对齐本目录 `X.js` + `X.logic.js` 铁律） |
| `entrypoints/web/optimize-ops.js` | 改 | checkup job 挂 `AbortController`；`startFix` 接受 `items`；`cancelCheckupJob` |
| `entrypoints/web/routes-optimize.js` | 改 | 新增 `GET /api/optimize/fix-plan`、`POST /api/optimize/checkup/cancel` |
| `public/js/optimize-plan.logic.js` | 新增 | 勾选树纯逻辑：三态、默认低风险、计数、分组汇总。可单测 |
| `public/js/optimize-report.js` | 新增 | 修复报告弹窗 |
| `public/js/optimize-view.js` | 改 | 顶部按钮状态机、勾选树渲染 |
| `public/app.css` | 改 | 优化面板段落内新增样式（见第十节） |

### 为什么 `buildFixPlan` 放 features 而不是 web 层

它要 import `claims` / `riskOf` / `strategiesOf`（`fix-engine.logic.js`）与注册表。放 web 层等于让 entrypoints 直接依赖修复引擎内部；放 features 层则 `optimize-ops.js` 只调一个函数拿结果，依赖方向与现有 `selectFixableRules` / `selectFixableDims` 完全一致。

## 六、顶部按钮状态机

底部 `.opt-actions` 整块删除，按钮统一收进顶部分数卡右侧。

| 状态 | 按钮 |
|---|---|
| 无报告 | `[开始体检]` |
| 体检中 | `[中止体检]` |
| 有报告，计划**尚有未处理项** | `[重新体检]` `[一键修复(N)]` |
| 有报告，计划**全部项都已处理** | `[重新体检]` + 提示「本轮可修项已全部处理，重新体检确认结果」 |
| 修复中 | `[停止修复]` |

两个数必须分清，它们决定两件不同的事：

- **隐藏 / 显示**「一键修复」看的是**计划里还有没有未处理项**（与勾选无关）。用户只勾低风险修完后，中高风险项仍未处理，按钮照常在。
- **按钮上的 `N` 与可点性**看的是**当前勾选且未处理的项数**。全部取消勾选时 `N = 0`，按钮 **disabled 但不隐藏**——隐藏会让用户以为没东西可修了。

按钮状态一律由一个纯函数 `topButtonsState(...)` 算出（`optimize-plan.logic.js`），前端只负责按结果渲染——避免又一次出现「状态变量改了但某个渲染分支没跟上」那类事故（上一轮的 `checkupBusy` 就是这么漏的）。

### 「本轮已处理」的语义边界

修复完成后，本轮 `status === 'done'` 的计划项打上「本轮已处理」：灰显、取消勾选、禁用勾选框，**但不从树里移除**。

这不违反拍板 #4。**它只是防重复勾的 UI 标记，不是重算**：分数、等级、问题数、维度状态、issue 列表全部保持修复前的值，必须重新体检才更新。提示文案必须说清这一点，否则用户会以为分数已经反映了修复结果。

## 七、中止体检

### 实现

1. checkup job 挂 `AbortController`（照抄 fix job 已有写法，含 `abort()` / `signal` 两个字段）。
2. `signal` 透传：`runAsyncDims` → `collectEvidence` / `runAudit` / 四个专属 `check-*`。底座已支持，只需接线。
3. 新增 `POST /api/optimize/checkup/cancel {checkupId}`，对齐 `fix/cancel` 的返回约定（找不到 job 回 404，前端据此提示「任务已结束」）。
4. 未落地的维度写 `{ status: 'cancelled', reason: '已取消，重新体检可续' }`。

### 为什么必须是新状态 `cancelled` 而不是复用 `error`

它们的**处置不同**：`error` 是「出问题了，要看原因」，`cancelled` 是「你自己停的，随时可以继续」。复用 error 会让用户以为体检失败了——这正是上一轮刚修掉的那类误导（把「正在进行」显示成「分析失败」）。

前端 `dimListFrom` 要加 `cancelled` 分支，卡片文案与配色按「中性」处理（`--muted`），不用 `--red`。

### 续跑是天然的

`saveLlmCache` 只在 `status === 'done'` 时写缓存（检测器自己把关）。所以已完成的维度重新体检时缓存命中直接返回，被取消的重跑——不需要额外的「断点续传」机制。

## 八、复测清单（规则化）

```
buildRetestList(changedFiles, moduleDocs) → [{ dir, responsibility, files }]
```

算法：改动文件按目录归拢 → 向上找最近的 `CLAUDE.md` → 取模块职责首段 → 组装。

本仓库每级目录都有 `CLAUDE.md`（根 + `src/app` + `src/entrypoints` + `src/features` + `src/plugins` + `src/store` 等），这条路径的产出质量有保障。**地图缺失的目录降级为只列文件**，不编造职责——宁可少说，不可错说。

零 LLM 调用，所以修复完成后报告立刻可出，不需要再等一次模型往返。

## 九、修复报告弹窗

新建 `public/js/optimize-report.js`。内容四块：

1. **改了什么**：按动作类型分组（改源码 / 改文档 / 新建测试 / 改配置 / 只出清单），每条给文件路径与结果状态。
2. **需要复测**：第八节的产出。
3. **未处理的**：`blocked` 项与 `buildFixNotes` 的 notes——这些是「不说就会被误以为已处理好」的内容，必须在报告里，不能只留在内联区域。
4. **底部**：`[还原本次优化]` `[重新体检]` `[关闭]`。

### 不扩展 `confirmDialog`

`ui.js` 的 `confirmDialog` 是「纯文本 message + 两个按钮」的原语。塞进富结构会把它变成胖接口（ISP 违背），且它的 `message` 走 `textContent`，天然渲染不了分组列表。新建独立模块，复用 `.mask` / `.modal` 的 **CSS**（而非 JS），是成本最低且不污染原语的做法。

## 十、样式契约（硬约束）

> 本节是用户明确要求：必须采用当前项目风格，不允许为省事随手写样式。实现时逐条对照。

### 复用清单

| 元素 | 复用 | 说明 |
|---|---|---|
| 树的勾选框 | `.pretty-check` | 项目已有的样式化复选框（18px / radius 5px / accent 填充 / 白勾 / `:focus-visible` accent 光晕） |
| 折叠分组 | `.opt-group` + `.opt-group-head::before` | 旋转箭头与折叠态已有，直接沿用 |
| 「中止体检」 | `.btn.stop` | 项目为「停止」语义定制的低饱和暖橙，**不要用 `.danger`** |
| 「一键修复」 | `.btn.primary` | — |
| 「重新体检」 | `.btn` | — |
| 风险 / 动作标签 | 照 `.t-badge` 形制 | `font-size: 11px; padding: 1px 7px; border-radius: 10px` |
| 报告弹窗 | `.mask` + `.modal` + `.head` / `.body` / `.foot` | 用 `.modal` 默认宽度 `min(560px, 92vw)`，不自定义尺寸 |
| 下拉（如需要） | `select.set-select` | 该类注释写明刻意不挂容器前缀，可直接用 |
| 输入框（如需要） | `.set-field input` 的形制 | `padding: 8px 10px; border-radius: 8px; background: var(--bg)` |

### 必须新增的一条样式

`.pretty-check` **没有半选（indeterminate）态**，而三层树的域/维度节点需要它。按同一套视觉语言补：accent 底色 + 白色横杠（而非勾），复用相同的圆角、边框、过渡与 focus 光晕。**不允许另起一套视觉**。

### 顺带修正

现有维度卡片的勾选框是裸 `input[type="checkbox"]`（`app.css:4463` 只给了 `cursor: pointer`），渲染成浏览器原生控件，与项目风格不符。本次一并换成 `.pretty-check`。

### 三条硬规矩

1. **颜色一律走变量**：低 `--green` / 中 `--amber` / 高 `--red`，底色用同色 15% alpha。禁止硬编码色值（`.t-badge.healthy` 那样的 `#37b24d` 是历史遗留，不要照抄）。
2. **不用内联 `style`**：新样式全部进 `public/app.css` 的优化面板段落。
3. **不指定 `font-family`**：`body` 已是 `--mono`，任何覆盖都是偏离。

## 十一、测试策略

纯逻辑全部可单测，这是本项目「`X.js` + `X.logic.js`」铁律的要求：

| 测试文件 | 覆盖 |
|---|---|
| `fix-plan.logic.test.js`（扩展） | `buildFixPlan` 的动作/风险派生（含 map/rules 走注册表 `risk` 而非策略表的例外）、`fixable:false` 落到「只出清单」、id 格式对全部维度一致 |
| `fix-plan.logic.test.js`（扩展） | `selectFixableRules` / `selectFixableMap` 加子集入参后，**不传入参时行为与改动前完全一致**（回归护栏） |
| `fix-plan.logic.test.js`（扩展） | `resolveSelection` 的越界/非整数/重复下标一律丢弃；`reportAt` 失配拒绝 |
| `retest.logic.test.js`（新增） | 目录归拢、向上找 `CLAUDE.md`、地图缺失时只列文件不编职责 |
| `optimize-plan.logic.test.js`（新增） | 三态勾选传播（勾域→全维度→全 issue）、默认只勾低风险、计数、`topButtonsState` 五种状态 |

**闸口**：现有 2767 个测试必须保持全绿。

已知 flaky：`src/entrypoints/web/routes-memory.test.js:294` 在全量并发跑时偶发失败（单独跑三次均通过），与本功能无关，不作为阻塞项。

## 十二、不做什么（YAGNI）

- **不做筛选器**（按动作/风险过滤树）。`advisory` 兜底项可能是真改动项的数倍，树会很长；这一版靠「域→维度」两级折叠 + 默认只展开有真改动项的维度来压。实际用起来仍嫌长再加。
- **不做勾选状态持久化**。关掉面板再回来重新按「默认勾低风险」初始化。
- **不做跨体检的勾选记忆**。id 是下标制，跨报告本就不稳定。
- **不改任何 `strategies/` 内部逻辑**。本设计只改「选谁」，不改「怎么修」。

## 十三、风险与已知局限

| 风险 | 处置 |
|---|---|
| 下标 id 跨报告失效 | `reportAt` 校验 + 409 让前端重拉 |
| 树过长影响可用性 | 两级折叠 + 默认展开策略；筛选器留作下一轮 |
| 复测清单质量依赖地图新鲜度 | 地图缺失时只列文件不编职责；地图过期本身是 `map` 维度会报的问题 |
| 中止后 signal 未覆盖到的慢调用仍在跑 | 已落地维度照常保留；`cancelled` 文案说明「重新体检可续」，不承诺立即停止 |
| 用户误勾高风险项 | 二次确认弹窗列出**具体**将改写的文件清单，不是泛泛一句「有风险」 |

## 十四、提交约定

按项目 `CLAUDE.md`：**不自动 git 提交**，本设计文档与后续实现一律留在工作区，提交时机由维护者掌控。

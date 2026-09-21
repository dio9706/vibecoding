# 体检二期 · 设计文档

> 日期：2026-09-18 ｜ 状态：已拍板，待实现
> 关联代码：`src/features/project-checkup/`、`src/features/project-optimize/`、`src/entrypoints/web/optimize-ops.js`、`public/js/optimize-view.js`

## 0. 范围

六项改动，三项功能 + 三项体验修缮：

| # | 需求 | 类型 |
|---|---|---|
| 1 | 问题项「这不是问题」豁免：填备注 → 落单独文档 → 下次体检规避 | 功能 |
| 2 | 体检进行中，侧栏「项目优化」卡片挂 `[体检中]` 标签 | 功能 |
| 3 | 点中止立即停掉进行中维度的额度消耗（给 `llm-classify` 加外部 signal） | 功能 |
| 4 | 顶部操作按钮重新设计 | 体验 |
| 5 | 勾选项从底部计划树上移到维度卡片，与打分/详情同处 | 体验 |
| 6 | 修复「勾选/反选时莫名收起或展开」 | 缺陷 |

**明确不做**（避免实现时范围蔓延）：

- 优化侧 `describe-skill` 的 signal 透传（属修复链路，不在本轮三条需求内）；
- `tests` / `hygiene` 的子进程中止（它们起子进程，不烧 LLM 额度）；
- 其余 9 个 `llm-classify` 调用点接入 signal（不传即行为不变）。

---

## 1. 需求 1 · 「这不是问题」豁免机制

### 1.1 忽略键

`dim + code + file` 三元组。

- **为什么不含行号**：行号会随任何编辑漂移，下一次体检就对不上，豁免等于没记。
- **为什么不细到代码单元**：17 维里只有部分维度的候选带稳定符号名（`complexity`/`deadcode` 有，`structure`/`docs` 没有），细到单元会让一半维度的豁免无法表达。
- **已知代价**：同文件同类型的其他问题会被一起免掉。这是刻意接受的——用户点「这不是问题」时的心理模型通常就是「这个文件里这类事就是这样」。

三元组全维度可用：已核对 17 个维度的 issue 产出点，`code` 字段全部存在（audit 维度来自 `registry.js` 的 `verdicts[*].code`，六个专属检测器各自硬编码 `M1_*`/`P1_*`/`S1_*`/`H1_*`/`R1_*`/`C*` 等码）。

### 1.2 存储：结构化真相源 + 渲染文档

**真相源**：新建 `src/store/checkup-ignores.js` → `checkup-ignores.json`

```jsonc
{
  "projects": {
    "C:/Users/DELL/Desktop/kxmall-app-ui": {
      "items": [
        {
          "dim": "structure",
          "code": "A1_DEP_VIOLATION",
          "file": "src/api/request.js",
          "message": "…原始 issue 文案（留档用，不参与匹配）",
          "note": "这是历史商城遗留的兼容层，下个版本整体删除，不值得现在解耦",
          "at": "2026-09-18T10:22:31.000Z"
        }
      ]
    }
  }
}
```

写入一律走 `updateJson`（本项目 store 硬性约定：跨进程文件锁 + 原子写）。同一三元组重复提交时**覆盖**而非追加，并刷新 `at`、保留最新 `note`。

**渲染产物**：`.claude/optimize/IGNORED.md`（项目内，`ADVISORY_DIR` 已由 advisory 策略建立，路径一致）

每次写入/删除后整份重渲染，不做增量拼接（增量拼接必然漂移，而整份重渲染是纯函数 + 一次写盘，成本可忽略）。

**写盘落点与分层**：新增 `src/features/project-checkup/ignore.js` 作为薄 IO 层（与本目录 `check-X.js` + `check-X.logic.js` 成对出现的纪律一致），对外只暴露三个口：

```js
export function getIgnores(dir);              // 读 store
export function addIgnore(dir, rule);         // 写 store → 重渲染 md → dropLlmCache(dir, rule.dim)
export function removeIgnore(dir, key);       // 同上反向
```

依赖方向：`routes-optimize → features/project-checkup/ignore.js → {store/checkup-ignores, store/optimize, ignore.logic}`，不反向、不跨层。

`advisory.js` 里已有一个同形状的 `writeUnder(dir, rel, body)`（三行 mkdir + write），但它是 `project-optimize` 下的**私有**函数——复用它要么导出后造成 `project-checkup → project-optimize` 的反向依赖（当前方向是 optimize 依赖 checkup，反过来即成环），要么把它下沉到 shared。两者都为三行代码付出过高代价，`ignore.js` 自己写这三行。

文档形状：

```markdown
# 体检豁免清单

> 本文件由「项目优化 → 这不是问题」自动生成，手工修改会在下次豁免操作时被覆盖。
> 真相源在应用数据目录的 checkup-ignores.json；此处是给人和 AI 读的副本。

## 分层与依赖方向（structure）

### src/api/request.js · A1_DEP_VIOLATION
- **原始判定**：…
- **豁免理由**：这是历史商城遗留的兼容层，下个版本整体删除，不值得现在解耦
- **登记时间**：2026-09-18 10:22
```

**为什么两份都要**：JSON 是体检读的（解析 md 脆弱，用户手改格式就失效）；md 是人和 AI 读的（可进 git、团队共享、AI 读项目时能看到这些判断）。md 顶部那句「手工修改会被覆盖」是必须的，否则用户会在里面写东西然后丢失。

### 1.3 生效点（两处，分工明确）

**第一处 · 召回阶段排除（省额度）**

落点：`src/features/project-checkup/audit-engine.js` 的 `runAudit`，在 `normalizeRecall(dim.recall(evidence))` 之后、分批之前。

矛盾与解法：召回时**还不知道 verdict code**（code 是判定的产物），而忽略键含 code。规则定为——

> 只有当某 `(dim, file)` 的**全部「会产生 issue 的 code」**都已被忽略时，才剔除该文件的候选。

有权重 code 集合是确定性的：`Object.values(dim.verdicts).filter((v) => v.weight).map((v) => v.code)`。覆盖不全时保留候选，交给第二道。

纯函数落点：`audit-engine.logic.js` 新增 `excludeIgnoredCandidates(candidates, dim, ignores)`，带单测。

**第二处 · 落地前兜底过滤（覆盖全 17 维）**

落点：`src/entrypoints/web/optimize-ops.js`，`settleDim` 返回之后、`land` 写进报告之前，统一过滤 `dim.issues`。

这一道的价值：
- 覆盖不走召回器的四个专属检测器（`prompts`/`comments`/`tests`/`hygiene`）与两个静态维度（`map`/`rules`）；
- 天然不受指纹缓存影响——缓存命中返回的是旧 `result`，过滤发生在它之后。

纯函数落点：`src/features/project-checkup/ignore.logic.js` 新增 `filterIgnoredIssues(dim, issues, ignores)` + `matchesIgnore(issue, rule)`，带单测。

### 1.4 缓存失效

**不动指纹逻辑**。新增/删除一条忽略时，直接删掉该 `dim` 的 `llmCache` 条目——`store/optimize.js` 新增 `dropLlmCache(dir, key)`（`saveLlmCache` 的反向操作）。

- 为什么不把忽略清单 hash 纳入指纹：那会让「加一条忽略」作废全部维度缓存，下次体检十几分钟 + 一整轮额度。
- 为什么要作废：不作废的话，缓存里的 `score` 仍是按未排除候选算的，而新体检（未命中缓存）会算出不同分数——同一份代码两个分数，这种不一致是长期的隐性错误。精确作废一个维度是最小代价。

### 1.5 分数口径（必须对用户讲清）

| 维度类型 | 豁免后分数 |
|---|---|
| audit 维度（10 个，走召回排除） | 候选减少 → 分数自然变高，口径与 issue 一致 |
| 专属检测器 + 静态维度（7 个，只走兜底过滤） | 分数不变，issue 减少 |

第二类会出现「0 个问题但分数 72」的观感矛盾。处置：该维度的 `reason` 追加「已豁免 N 条，本维度分数未重算」。**不藏、不估算回补**——估算回补会让分数失去跨次可比性，趋势线虚高。

### 1.6 交互

- 每条 issue 行右侧「这不是问题」按钮（次要样式，hover 才明显，避免喧宾夺主）；
- 点击弹 `ui.js` 已有的 `textareaDialog`（多行输入，理由往往不止一句），**备注必填**——空备注等于没记录，下次没人知道为什么豁免；
- 提交成功后该行就地移除 + toast 提示；
- 面板顶部（分数卡右下）加「已豁免 N 项」入口，点开列出全部豁免项，每项可撤销；撤销同样触发 `dropLlmCache` + 重渲染 md。

### 1.7 HTTP 接口（`routes-optimize.js` 单入口内新增三条）

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/api/optimize/ignores?dir=` | — | `{items:[…]}` |
| POST | `/api/optimize/ignore` | `{dir, dim, code, file, message, note}` | `{ok:true, count}` |
| POST | `/api/optimize/ignore/remove` | `{dir, dim, code, file}` | `{ok:true, count}` |

删除用 POST 子路径而非 `DELETE` + body：本文件既有九条路由全是 GET/POST，且 DELETE 带 body 在部分中间层会被丢弃。与 `/api/optimize/checkup/cancel` 同一范式。

`note` 为空串时回 400（服务端也要卡，前端必填只是第一道）。路由注册顺序：`/api/optimize/ignore/remove` 必须排在 `/api/optimize/ignore` 之前——本文件用的是 `pathname ===` 精确比较，理论上不会遮蔽，但既有代码已为 `checkup/cancel` 留下同样的顺序约定与注释，保持一致以免下一个人改成前缀匹配时踩坑。

---

## 2. 需求 2 · 侧栏「体检中」标签

### 2.1 DOM

`public/index.html` 的 `#toolOptimize` 标题节点后挂标签位：

```html
<span class="tool-item-title">项目优化<span class="tool-item-tag" id="optToolTag" hidden></span></span>
```

文案两态：`体检中` / `修复中`（`busy.kind` 分别为 `checkup` / `fix`）。样式复用 `.opt-stale-badge` 的观感（小号、描边、accent 色），新建 `.tool-item-tag`。

### 2.2 状态来源（新建 `public/js/optimize-badge.js`）

不把侧栏 DOM 逻辑塞进 `optimize-view.js`——那个文件已经 1036 行，且侧栏标签在面板关闭时也要工作。

两条驱动路径：

1. **面板开着**：`optimize-view.js` 在 `openCheckupStream` / `closeCheckupStream` / `openFixStream` / `closeFixStream` 四处调 `setOptimizeBadge(kind)`，SSE 状态直接驱动，零延迟；
2. **面板没开 / 刚刷新**：应用启动与 cwd 切换时探测一次 `/api/optimize/report?dir=`，读 `busy`：
   - `busy.alive && busy.kind` → 打标签并**开 30s 轮询**；
   - 轮询到 `busy` 为空 → 摘标签、**停轮询**。

**只在探测到活跃任务时轮询**，不做常驻轮询：体检是低频操作，常驻轮询等于给一个一天跑一次的功能加一条永久心跳。

模块接口：

```js
export function setOptimizeBadge(kind);   // kind: 'checkup' | 'fix' | ''
export function probeOptimizeBadge(dir);  // 探测一次，必要时启动轮询
```

`chat.js` 在 cwd 变化处调 `probeOptimizeBadge(cwd)`（与 `bindOptimizeCwd` 同一范式，不反向 import）。

---

## 3. 需求 3 · 中止即停额度

### 3.1 `llm-classify` 加外部 signal

`src/capabilities/llm-classify.js` 的 `runClassifierDetailed(opts)` 新增可选 `opts.signal`：

```js
// 进入即判：已中止就别发起注定要被丢弃的调用
if (signal?.aborted) return classifyOutcome({ externalAbort: true });

// 链接外部 signal 到内部 AbortController
const onAbort = () => abort.abort();
signal?.addEventListener('abort', onAbort, { once: true });
try { /* …既有调用… */ }
finally {
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);  // 必须摘
}
```

**listener 必须摘**：一个 job 的 signal 会被几十个批次挂载（`deadcode` 实测 19 批 × 多维度），不摘就是长跑进程里的泄漏。用 `{ once: true }` 只覆盖「真触发了」的情况，正常结束的那几十个仍挂在 signal 上。

`classifyOutcome` 增加一档归因：

```js
export function classifyOutcome(o) {
  const { exhausted = false, aborted = false, externalAbort = false, text = '' } = o || {};
  if (exhausted) return { data: null, reason: 'exhausted' };
  // 外部中止优先于解析：用户已经不要这个结果了
  if (externalAbort) return { data: null, reason: 'aborted' };
  // …既有逻辑不变…
}
```

**为什么 `aborted` 要与 `timeout` 分开**：调用方对两者的处置相反——超时值得重试（`audit-engine.judgeBatch` 就重试一次），用户中止绝不该重试。混为一谈会让「点中止」额外烧一轮重试额度，正好是本需求要消灭的东西。

**为什么外部中止判定优先于「先尝试解析」**：既有逻辑刻意把解析放在超时判定之前（模型常早早吐完 JSON 而流迟迟不收尾，丢掉等于白烧）。但外部中止语义不同——用户已经明确不要这个结果了，此时解析出来也只会被上层 `land` 的守卫丢弃，没有价值。

### 3.2 透传链

```
optimize-ops.runAsyncDims
  ├─ LEGACY_RUNNERS 调用处：run(dir, { cache, force, signal: job.signal })
  │    ├─ checkPrompts(projectDir, { cache, force, signal })  → 批循环 → runClassifierOnce({…, signal})
  │    └─ checkComments(projectDir, { cache, force, signal }) → 批循环 → runClassifierOnce({…, signal})
  └─ audit-engine.runAudit（已收 signal）
       └─ judgeBatch({…, signal}) → runClassifierOnce({…, signal})   ← 新增透传
```

`audit-engine.judgeBatch` 现在只在**批之间**检查 `signal.aborted`，批内那 300s 预算是停不掉的。把 signal 传给 `runClassifierOnce` 后才真正可中断。

`checkTests` / `checkHygiene` 不接 signal（起子进程，不烧额度，见 §0 范围外）。

### 3.3 注释同步

`optimize-ops.js` 两处注释明确写着「`llm-classify` 不接受外部 signal」，必须一并改掉：

- `land()` 函数头的守卫说明（`optimize-ops.js:336` 附近）；
- `cancelCheckupJob()` 的「已知代价」段（`optimize-ops.js:505` 附近）。

留着过期注释比没有注释更糟——下一个人会据此得出错误结论。

---

## 4. 需求 4 · 顶部按钮重做

**问题诊断**：`#optRunCheckup` 与 `#optFix` 都是 `.btn.primary`（实心 accent），两个同权重实心橙块并排，没有主次层级；截图里并排占据视觉重心，把分数环压了下去。

**改法**（改 `public/app.css` 的 `.opt-score-actions` 作用域内，不动全局 `.btn`）：

| 按钮 | 新样式 | 理由 |
|---|---|---|
| 一键修复（N 项） | 保持实心 accent | 主动作，用户点进面板的最终目的 |
| 重新体检 / 开始体检 | 降为描边幽灵（`--border` 边 + 透明底，hover 浮出 `--panel`） | 次动作 |
| 中止体检 / 停止修复 | 沿用 `.btn.stop` | 低饱和暖橙，视觉语言已正确 |

尺寸收敛：`padding: 7px 16px`、`font-size: 12.5px`、按钮间距 `gap: 8px`（现为 10px）、加 12px 前置图标（体检 🩺 / 修复 ✨）。

**首次体检例外**：没有报告时只有「开始体检」一个按钮，此时它是唯一主动作，应保持实心。用 `#optRunCheckup.is-primary` 类由 `refreshButtons()` 按 `!currentReport` 切换。

---

## 5. 需求 5 · 勾选上移

### 5.1 目标形状

维度卡片展开后，每条 issue 行变为：

```
[☑] error  src/api/request.js:12   反向依赖：api 层直接 import store   [只出清单·低]  [这不是问题]
```

维度卡片头部加三态复选框（全选 / 部分 / 无）+ 「已勾 3/12」计数。

底部 `#optPlan` 整块移除：`renderFixPlan()`、`renderPlanItem()`、`categoryLabel()` 删除，`index.html` 的 `#optPlan` 容器删除，对应 CSS 清理。

**为什么移除而不保留双向同步**：同一状态两处渲染，同步 bug 的长期成本远高于横向筛选带来的便利；且「一处勾选、一处真相」消除了「以哪个为准」的困惑。

### 5.2 必须处理的下标错位坑

计划项 id 是 `${dim}#${报告里 issues 数组的原始下标}`（`buildFixPlan` / `resolveSelection` 双向依赖它，后者还是安全边界）。

而 `dimListFrom()` 对 issues 做过 `sortIssues()` 排序——**排序后的位置已不是原始下标**。直接用渲染序号拼 id 会把修复动作打到不相干的文件上。

解法：`optimize-view.logic.js` 的 `dimListFrom` 在排序**之前**给每条 issue 附上 `planId`：

```js
const raw = Array.isArray(d?.issues) ? d.issues : [];
const withId = raw.map((it, index) => ({ ...it, planId: `${meta.key}#${index}` }));
// …再 sortIssues(withId)
```

`sortIssues` 保持纯排序不变。渲染时 issue 行的勾选直接用 `it.planId` 查 `plan.items`——只有在 `plan.items` 里存在对应项的 issue 才渲染复选框（`buildFixPlan` 只收 `status === 'done'` 的维度，`analyzing`/`partial` 维度的 issue 本就不可勾）。

这一条**必须补单测**（`optimize-view.logic.test.js`）：构造一个 issues 顺序与排序后不同的报告，断言 `planId` 仍指向原始下标。

### 5.3 保留的既有机制

- `selected` / `handled` 两个模块级 Set 语义不变；
- `defaultSelection(plan.items)` 默认只勾低风险，不变；
- `topButtonsState` / `riskyPicks` / `toggleNode` / `nodeCheckState` 四个纯函数全部复用，不改签名；
- 提交仍走 `items: picked.map(i => i.id)` + `reportAt` 快照校验。

---

## 6. 需求 6 · 折叠态缺陷

### 6.1 根因

`renderFixPlan()` 里折叠态是**每次 render 从 `selected` 现推**的：

```js
// optimize-view.js:414
if (!dimIds.some((id) => selected.has(id))) itemsBox.classList.add('is-folded');
```

而任何勾选都调 `render()` 重建整棵树。于是：

- 勾掉某维度的最后一条 → 重建时该维度无勾选 → 被加 `is-folded` → **莫名收起**；
- 点域级全选 → 重建时原本没勾的维度有了勾选 → 不加 `is-folded` → **莫名展开**。

同类问题还有两处，一并修：

- 域级 `section.classList.toggle('is-folded')`（`:395`）——折叠态只存在 DOM 上，任何 render 都丢失，用户折叠的域会在下次勾选后弹回展开；
- 维度卡片 `card.classList.toggle('is-open')`（`:288`）——同理，展开的问题清单会在 render 后收起。批级进度事件已经为此做过定点更新的规避（`:706`），但勾选路径没有。

### 6.2 修法

折叠/展开是**用户意图**，必须显式持有，不能从别的状态派生：

```js
/** 用户手动展开的维度卡片 key。显式持有——从 selected 派生会让勾选连带折叠（已修缺陷） */
let openCards = new Set();
/** 用户手动折叠的域 key */
let foldedGroups = new Set();
```

- `render()` **只读**这两个 Set，不写；
- 只有用户点击 handler 才写；
- 初始值：首次载入报告时，把「有勾选项的维度」写进 `openCards`（保留「展开的正好是本轮会动的那些」这个既有好处），之后不再被勾选影响；
- 换项目 / 重新体检（`loadPlan` 重置 `handled` 处）一并重置这两个 Set。

---

## 7. 改动文件清单

### 新增

| 文件 | 职责 |
|---|---|
| `src/store/checkup-ignores.js` | 忽略清单持久化（`readIgnores` / `addIgnore` / `removeIgnore`） |
| `src/store/checkup-ignores.test.js` | 上述单测 |
| `src/features/project-checkup/ignore.logic.js` | 纯函数：`matchesIgnore` / `filterIgnoredIssues` / `ignoredCodesFor` / `renderIgnoredMd` |
| `src/features/project-checkup/ignore.logic.test.js` | 上述单测 |
| `src/features/project-checkup/ignore.js` | 薄 IO 层：`getIgnores` / `addIgnore` / `removeIgnore`（store 读写 + md 落盘 + 缓存作废），见 §1.2 |
| `public/js/optimize-badge.js` | 侧栏标签状态机 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/capabilities/llm-classify.js` | `runClassifierDetailed` 收 `signal`；`classifyOutcome` 加 `aborted` 归因 |
| `src/capabilities/llm-classify.test.js` | 补 `externalAbort` 归因用例 |
| `src/features/project-checkup/audit-engine.js` | `judgeBatch` 透传 signal；`runAudit` 召回后排除已忽略候选 |
| `src/features/project-checkup/audit-engine.logic.js` | 新增 `excludeIgnoredCandidates` |
| `src/features/project-checkup/audit-engine.logic.test.js` | 上述单测 |
| `src/features/project-checkup/check-prompts.js` | 签名收 `signal` 并透传 |
| `src/features/project-checkup/check-comments.js` | 同上 |
| `src/store/optimize.js` | 新增 `dropLlmCache(dir, key)` |
| `src/entrypoints/web/optimize-ops.js` | 兜底过滤接入；LEGACY_RUNNERS 传 signal；两处过期注释订正 |
| `src/entrypoints/web/routes-optimize.js` | 三条 ignore 接口 |
| `src/entrypoints/web/routes-optimize.test.js` | 三条接口的路由分发用例 |
| `public/index.html` | `#optToolTag` 标签位；删 `#optPlan` |
| `public/js/optimize-view.js` | 勾选上移、计划树移除、折叠态显式持有、豁免按钮与弹窗、badge 联动 |
| `public/js/optimize-view.logic.js` | `dimListFrom` 附 `planId` |
| `public/js/optimize-view.logic.test.js` | `planId` 下标正确性用例 |
| `public/js/chat.js` | cwd 变化时调 `probeOptimizeBadge` |
| `public/app.css` | 按钮层级、`.tool-item-tag`、issue 行复选框与豁免按钮、清理 `.opt-plan-*` |
| `src/features/CLAUDE.md` / `src/store/CLAUDE.md` / `src/capabilities/CLAUDE.md` | 模块地图同步（三份都维护文件清单与改动入口） |

> `docs/ARCHITECTURE.md` **不需要改**：它不维护 store 文件清单或 HTTP 接口清单，只写分层约定，而本轮新增的两件事都已被现有条款覆盖——`ignore.js` 写用户项目文件落在 §3「持久化」正当例外的第二条（`features/project-checkup` 写用户项目的文件），`checkup-ignores.js` 经 store 落盘正是 §3 的主干要求。实施时只需跑一遍该节的验证命令核对。

---

## 8. 测试策略

遵循本项目既有纪律：IO 层薄、判定收进 `*.logic.js` 纯函数并单测。

| 测试 | 断言要点 |
|---|---|
| `ignore.logic.test.js` | 三元组精确匹配；`code` 不同不误杀；`file` 分隔符归一（`\` → `/`）；`ignoredCodesFor` 只取有权重的 code；md 渲染含备注原文 |

> `file` **只归一分隔符，不归一大小写**：比较两侧的 `file` 都来自同一次体检的产出（`git ls-files` / fs 遍历），大小写本就一致；而强行小写会在大小写敏感的文件系统上把 `src/Api/x.js` 和 `src/api/x.js` 误判成同一个文件。分隔符归一仍要做——md 可被手工编辑，不同来源可能混入 `\`。
| `audit-engine.logic.test.js` | 有权重 code 全覆盖才剔除候选；部分覆盖时候选保留 |
| `checkup-ignores.test.js` | 同三元组覆盖而非追加；跨项目隔离；空 note 拒绝 |
| `llm-classify.test.js` | `externalAbort` 归因为 `aborted` 且优先于解析；`aborted` 与 `timeout` 不混 |
| `optimize-view.logic.test.js` | 排序后 `planId` 仍指原始下标（核心回归） |
| `routes-optimize.test.js` | 三条 ignore 接口分发正确；空 note 回 400 |

手工验收（跑 `npm test` 覆盖不到的）：

1. 体检中切走页面再回来，侧栏标签仍在，面板 loading 恢复；
2. 点中止后观察日志，确认不再出现新的 `判定批次开始`；
3. 豁免一条后重新体检，确认该 dim 的候选数下降、issue 不再出现；
4. 勾选/反选十次，确认没有任何非用户触发的折叠或展开。

---

## 9. 风险与取舍

| 风险 | 处置 |
|---|---|
| 豁免粒度过粗，误免同文件其他问题 | 接受（§1.1）。md 里完整记录被免掉的原始判定，可追溯可撤销 |
| 两类维度分数口径不一致 | 在维度 `reason` 明示「已豁免 N 条，分数未重算」，不估算回补 |
| `IGNORED.md` 写进用户仓库 | 顶部声明自动生成；路径与既有 `.claude/optimize/` 产物一致，用户已有预期 |
| signal listener 泄漏 | `finally` 中 `removeEventListener` + `{ once: true }` 双保险，测试覆盖 |
| 计划树移除后失去横向筛选 | 顶部「一键修复（N 项）」保留全局计数；如后续确有需要，再按「一行汇总条」方案补 |
| `optimize-view.js` 已 1036 行，本轮还要加 | 净增有限（删 ~90 行计划树、加 ~120 行）；侧栏标签拆到独立模块，不进这个文件 |

---

## 10. 实施顺序

1. **需求 3**（signal）——独立、零 UI 依赖，先落地可单独验证；
2. **需求 6**（折叠缺陷）——独立缺陷，修完立即可验；
3. **需求 1 后端**（store + 纯函数 + 两处生效点 + 接口）；
4. **需求 5 + 1 前端**（勾选上移与豁免按钮同属 issue 行改造，一起做避免两次重排）；
5. **需求 2**（侧栏标签）；
6. **需求 4**（按钮样式）——纯 CSS，最后做便于整体观感调优。

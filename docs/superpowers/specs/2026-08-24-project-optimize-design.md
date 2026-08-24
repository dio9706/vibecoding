# 「项目优化」工具 · 设计文档

> 日期: 2026-08-24 · 状态: 待评审 · 所属: claude-p-web-demo web 执行台

## 1. 背景与目标

### 要解决什么

同一个需求在配置良好和配置糟糕的项目里，AI 的执行耗时能差一个数量级。实测案例（kxmall-app-ui，2026-08-24）：一个「点击按钮跳转到某 tab」的定点改动跑了 20 分钟，事后归因出三个原因：

1. `禁止做出假设——具体结论必须给出 文件:行号 依据` 这条规则没有范围限定，被执行成「每个结论都要现场取证」，连用户在需求里直接给定的 agent code 都跑去后端仓库反查
2. `.claude/rules/` 里四份大规范（合计 38KB）的 `paths` 写得过宽（`src/**`），纯逻辑改动也被全量注入，且中途注入打断 KV cache
3. 项目地图存在但部分条目已过期，引用路径失效

这三类问题有共同特征：**隐蔽、复利、且人工排查成本高**。它们不会报错，只会让每次开发都慢一点。

### 目标

在 web 执行台中提供一个工具，对指定项目做「体检」，量化上述问题并支持一键修复。交互参照 360 安全卫士：一键扫描 → 分维度报告 → 勾选 → 一键优化。

### 成功标准

- 静态维度体检在 1 秒内出分
- 体检报告的每一条问题都能定位到 `文件:行号`
- 一键优化对高风险维度必须经用户逐项确认才落盘
- 优化后可一键还原

## 2. 非目标（v1 明确不做）

- **不做「无用代码」维度**：静态扫描在大仓库误报率高，LLM 复核成本不可控。v1 在 UI 上以置灰卡片呈现，标注「即将支持」，不参与评分
- 不做多项目批量体检（一次一个项目）
- 不做体检结果的团队共享 / 云端同步（数据落本机 JSON）
- 不自动 git 提交任何改动（遵循项目既有约定，改动只留工作区）
- 不支持非 Claude Code 项目（无 `CLAUDE.md` / `.claude/` 的项目仍可体检，但维度①③会直接给出「未建立」结论）

## 3. 用户流程

```
选择项目（下拉，复用 saved-dirs）
    ↓
点击 [体检]
    ↓
维度①③ 立即出分（静态扫描 <1s）
维度②⑤ 显示「分析中」，SSE 逐个回填
维度④ 置灰
    ↓
总分环滚动到最终分数，展示 4 张维度卡片（默认全部勾选）
    ↓
展开任一卡片可看问题清单（文件:行号 + 说明）
    ↓
点击 [一键优化]
    ↓
低风险维度（①③）直接执行
高风险维度（②⑤）生成 diff，逐项确认
    ↓
执行完毕，展示改动摘要 + [重新体检] / [还原]
```

## 4. 维度定义与检测规则

### 维度① 项目地图（权重 35%，纯静态）

**检测项**

| 编号 | 检测内容 | 实现方式 |
|---|---|---|
| M1 | 根 `CLAUDE.md` 或 `.claude/CLAUDE.md` 是否存在 | 文件存在性 |
| M2 | 模块地图覆盖率 | 扫 `src/` 下一级目录（排除 `node_modules`、点开头目录、文件数 < 3 的目录），统计其中含 `CLAUDE.md` 的比例 |
| M3 | 地图新鲜度 | 对每个有地图的目录，比较 `CLAUDE.md` 的 mtime 与该目录下代码文件（`.js/.ts/.vue/.py/.go` 等）的最新 mtime。代码比地图新超过 **14 天** 判为过期 |
| M4 | 死链 | 提取地图正文中所有反引号包裹的、形如路径的字符串（含 `/` 且带已知扩展名，或以 `src/`、`.claude/`、`docs/` 开头），逐个校验文件是否存在 |
| M5 | 体积 | 根 `CLAUDE.md` 行数（官方建议 < 200 行） |

**判分**

```
M1 不存在 → 该维度直接 0 分，其余检测项跳过
基础分 60
+ M2 覆盖率 × 20            (0~20)
- M3 每个过期模块 -4        (下限 -20)
- M4 每条死链 -3            (下限 -15)
- M5 根地图 200~300 行 -5；> 300 行 -10
最终 clamp 到 [0, 100]
```

**输出结构**：每条问题给出 `{ code, severity, file, line, message, fixable }`。M4 的 `line` 为死链所在行号。

### 维度② 提示词质量（权重 30%，规则库捞候选 + LLM 判定）

**扫描范围**：`CLAUDE.md`（各级）、`.claude/rules/*.md`、`.claude/skills/*/SKILL.md`

**阶段一 · 规则库捞候选（静态）**

匹配「绝对化指令词」：`禁止`、`必须`、`一律`、`所有`、`永远不`、`任何情况下`、`不允许`、`严禁`、`MUST`、`NEVER`、`ALWAYS`

判定为候选的条件：**该行（或该 bullet 所在段落）命中绝对化指令词，且同段落内不含范围限定词**。范围限定词白名单：`但`、`除非`、`仅当`、`范围`、`例外`、`不适用于`、`以下情况`、`unless`、`except`。

同时静态检测：
- 单个规则文件行数 > 200（官方建议上限）
- 同一文件内出现内容高度重复的条目（编辑距离相似度 > 0.85）

**阶段二 · LLM 判定**

把候选条目连同上下文（前后各 3 行）打包，交给一个只读 Claude run，要求它对每条判断：

- `verdict`: `over-broad`（过度宽泛，会导致 AI 做无用功） / `acceptable`（合理的硬约束） / `conflicting`（与另一条规则矛盾）
- `reason`: 一句话说明，必须给出「这条会导致 AI 做什么多余的事」的具体场景
- `suggestion`: 改写建议（保留原意，补上范围限定）

判定提示词中要给出 kxmall 的真实反例作为 few-shot：

> 反例：`禁止做出假设——具体结论必须给出 文件:行号 依据`
> 问题：没区分「代码事实」和「需求输入」。实际后果是 AI 把用户在需求里给定的 agent code 也当成待验证假设，跑到后端仓库翻数据库实体定义。
> 改法：限定为「关于代码如何工作的结论」，并显式声明「用户给定的值是输入不是假设」。

**判分**

```
基础分 100
- 每条 verdict=over-broad  -8
- 每条 verdict=conflicting -12
- 每个超 200 行的规则文件  -5
- 每组重复条目            -3
clamp [0, 100]
```

**降级策略**：LLM 阶段失败（超时/额度耗尽）时，该维度标记为「仅静态结果」，分数按候选数量给保守估计（每个候选 -4），并在 UI 上标注未深度分析。

### 维度③ rules → skill 降级（权重 15%，纯静态，结论确定）

**检测逻辑**

对 `.claude/rules/*.md` 逐个计算：

- `size`: 文件字节数
- `pathsWidth`: 解析 YAML frontmatter 的 `paths` 字段，计算「宽度等级」
  - 无 `paths` 字段 → 宽度 = `unconditional`（启动即全量加载，最宽）
  - 含 `src/**`、`**/*` 这类不限扩展名的全目录 glob → `wide`
  - 含 `src/**/*.vue` 这类限定扩展名的 glob → `medium`
  - 仅匹配特定子目录或特定文件名模式 → `narrow`

**判定「应降级」**：`size > 5KB` 且 `pathsWidth ∈ {unconditional, wide}`

**估算注入成本**：对每个「应降级」文件，输出 `预估每次注入 ${size/1024}KB ≈ ${size/4} tokens`（按中文 md 约 4 字节/token 粗估，UI 上标注为估算值）。

**判分**

```
无 .claude/rules 目录 → 该维度 N/A，不计入总分，其余权重按比例放大
基础分 100
- 每个「应降级」文件按体积扣分: min(20, size_KB × 1.5)
clamp [0, 100]
```

**修复动作**（低风险，可自动执行）：
1. 在 `.claude/skills/<name>/SKILL.md` 创建文件，剥离原 `paths` frontmatter，写入 `name` + `description`（description 由 LLM 根据文件内容的章节标题生成，需覆盖「是什么」+「什么时候调」）
2. 删除原 `.claude/rules/<name>.md`
3. 全仓扫描 `.claude/rules/<name>.md` 的引用并替换为 `/<name>` 技能（排除 `docs/migration`、`docs/plans`、`docs/specs` 等归档目录）
4. 在根 `CLAUDE.md` 的规范索引表中同步条目

### 维度④ 无用代码（v1 置灰，不参与评分）

UI 上呈现为灰色卡片，文案「即将支持」，勾选框禁用。

### 维度⑤ 注释合理性（权重 20%，纯 LLM，抽样）

**抽样策略**：按 git 最近修改时间排序，取前 **30 个** 源码文件（可在设置中调整，范围 10~100）。排除测试文件、`node_modules`、构建产物、`.min.js`。

**检测三类问题**

| 类型 | 说明 |
|---|---|
| `restates-code` | 注释只是把代码翻译成中文，没有解释「为什么」 |
| `stale` | 注释描述的行为与当前代码不符 |
| `dead-code` | 被注释掉的代码块（非文档性注释） |

**判分**

```
基础分 100
- 按问题密度扣: (问题数 / 抽样文件数) × 60
clamp [0, 100]
```

**降级策略**：LLM 失败时该维度标 N/A 不计入总分，权重按比例放大到其余维度。

## 5. 评分模型

**权重**（④ 置灰后重新分配）

| 维度 | 权重 |
|---|---|
| ① 项目地图 | 35% |
| ② 提示词质量 | 30% |
| ③ rules 降级 | 15% |
| ⑤ 注释合理性 | 20% |

权重理由：①② 影响的是「以后每一次开发的速度」，有复利效应；③ 是一次性配置问题；⑤ 是代码卫生，影响可读性但不直接拖慢 AI。

**N/A 处理**：任一维度 N/A 时，其权重按剩余维度的原权重比例重新分配。例如 ③ N/A，则 ①②⑤ 权重变为 `35/85`、`30/85`、`20/85`。

**总分档位**（UI 配色）

| 分数 | 档位 | 色 |
|---|---|---|
| 90-100 | 健康 | `var(--green)` |
| 70-89 | 良好 | `var(--accent-hi)` |
| 50-69 | 需优化 | `var(--amber)` |
| 0-49 | 较差 | 红色（需新增 CSS 变量 `--danger`） |

## 6. 一键优化：风险分级与安全约束

### 风险分级

| 维度 | 风险 | 执行方式 | 理由 |
|---|---|---|---|
| ① 建/更新地图 | 低 | 勾选即执行 | 新增文件或追加内容，不破坏现有代码 |
| ③ rules 降级 | 低 | 勾选即执行 | 移动文件 + 替换引用，可完全还原 |
| ② 改提示词 | **高** | 生成 diff，逐项确认 | 改的是用户亲手写的规则，语义判断可能出错 |
| ⑤ 改注释 | 中 | 生成 diff，逐项确认 | 触碰源码文件 |

### 三条硬约束

1. **工作区检查**：开跑前执行 `git status --porcelain`。若非空，弹窗警告「工作区有 N 个未提交改动，优化产生的改动会和它们混在一起，难以区分」，提供 [仍然继续] / [取消]。非 git 仓库跳过此检查并提示无法还原到 git 状态。
2. **不自动提交**：所有改动只留工作区。
3. **快照备份**：执行前把所有将被修改/删除的文件复制到 `.claude/optimize-backup/<ISO时间戳>/`，保留目录结构。同目录写 `manifest.json` 记录原路径。UI 提供 [还原本次优化]，按 manifest 逐个复制回去。备份保留最近 5 次，超出自动清理。

### 执行编排

一键优化 = 按维度顺序**串行**起 Claude run（并行会撞同一批文件）。照 `src/entrypoints/web/requirement-ops.js` 的 pump 模式：在 `optimize.json` 的项目记录上写 `busy: { dimension, runId, startedAt }` 做落盘串行闸，进程崩溃重启后能识别孤儿任务并恢复。

两个低风险维度对 LLM 的依赖程度不同：

- **③ 几乎不需要 LLM**：文件移动、frontmatter 剥离、全仓引用替换都是确定性代码逻辑，只有生成 skill 的 `description` 一句话需要 LLM
- **① 必须依赖 LLM**：无论「建立地图」还是「更新地图」，都要读代码写摘要

之所以仍把 ① 划为低风险直接执行：地图类改动不影响代码运行，写错了下次体检会以死链/过期的形式再次暴露，且有快照可还原。

维度②⑤ 必须 LLM 生成改写内容，产出 diff 后暂停等待用户确认，确认后由后端落盘（不让 LLM 直接写文件，避免它顺手改别的）。

## 7. 架构与数据流

```
[前端 optimize-view.js]
   │ POST /api/optimize/checkup {dir}
   ↓
[routes-optimize.js]
   │ 同步执行静态检测器 → 立即返回 {checkupId, dims:{map, rules}}
   │ 异步起两个只读 Claude run (prompts / comments)
   ↓
[features/project-checkup/*.js]  静态检测器，纯函数，可单测
   │
[integrations/claude.js runClaude]  LLM 检测器
   ↓
   │ GET /api/optimize/stream?checkupId  (SSE)
   ↓
[前端逐维度回填，总分滚动更新]
   │
   │ POST /api/optimize/fix {dir, dimensions:[...]}
   ↓
[快照备份 → 串行 pump → 低风险直接落盘 / 高风险产出 diff]
   │ SSE 推进度
   ↓
[高风险: 前端展示 diff → POST /api/optimize/apply {checkupId, patches:[...]}]
```

## 8. 数据结构

**`optimize.json`**（项目根，经 `src/store/index.js` 的 `readJson/updateJson` 读写）

```json
{
  "projects": {
    "C:\\Users\\DELL\\Desktop\\kxmall-app-ui": {
      "lastCheckup": {
        "checkupId": "ck_1756...",
        "at": "2026-08-24T06:30:00.000Z",
        "score": 72,
        "dims": {
          "map":      { "score": 80, "status": "done", "issues": [] },
          "prompts":  { "score": 65, "status": "done", "issues": [] },
          "rules":    { "score": 55, "status": "done", "issues": [] },
          "deadcode": { "score": null, "status": "disabled", "issues": [] },
          "comments": { "score": 88, "status": "done", "issues": [] }
        }
      },
      "history": [{ "at": "...", "score": 72 }],
      "busy": null,
      "backups": [
        { "at": "2026-08-24T06:35:00.000Z", "dir": ".claude/optimize-backup/2026-08-24T06-35-00", "fileCount": 7 }
      ]
    }
  }
}
```

`history` 保留最近 20 条，仅存 `{at, score}` 用于画趋势线。`backups` 保留最近 5 条。

**issue 对象**

```json
{
  "code": "M4_DEAD_LINK",
  "severity": "warn",
  "file": "src/pages-community/CLAUDE.md",
  "line": 24,
  "message": "引用的 .claude/rules/popup-pattern.md 不存在",
  "fixable": true,
  "fixHint": "替换为 /popup-pattern 技能"
}
```

## 9. API 契约

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/api/optimize/report?dir=` | — | 最近一次体检报告，无则 `{report: null}` |
| POST | `/api/optimize/checkup` | `{dir}` | `{checkupId, dims: {map, rules}}`（静态部分同步返回） |
| GET | `/api/optimize/stream?checkupId=` | — | SSE：`dim` 事件逐个推 LLM 维度结果，`done` 事件推最终总分 |
| POST | `/api/optimize/fix` | `{dir, checkupId, dimensions: []}` | `{runId, backupDir}` |
| GET | `/api/optimize/fix-stream?runId=` | — | SSE：进度 + 高风险维度的 diff 载荷 |
| POST | `/api/optimize/apply` | `{runId, patches: [{file, content}]}` | `{applied: n}` |
| POST | `/api/optimize/rollback` | `{dir, backupAt}` | `{restored: n}` |

所有响应用 `src/entrypoints/web/http-util.js` 的 `sendJson`，入参用 `body.js` 的 `withJsonBody` + `input.js` 的 `str` 做规范化。

## 10. UI 规格

挂载在 `public/index.html` 的 `<div class="panel-page" data-view="optimize" hidden>`，侧栏「工具」组加 `.tool-item#toolOptimize`。

**布局（自上而下）**

1. **面板头**：`<div class="panel-head"><h3>项目优化</h3><button class="panel-close">✕</button></div>`（沿用既有结构）
2. **项目选择行**：下拉选择器（数据源 `/api/dirs/saved`）+ [浏览…] 按钮（复用 `dir-popover.js`）
3. **分数区**：
   - 左侧圆环进度（SVG，`stroke-dasharray` 动画，数字从 0 滚动到目标分）
   - 右侧：档位文案 + 「发现 N 项问题」+ 上次体检时间 + 迷你趋势线（最近 10 次）
   - 未体检时圆环显示 `--`，中央是 [体检] 按钮
4. **维度卡片列表**：5 张卡片（④ 置灰）
   - 每张：勾选框（默认选中）+ 维度名 + 分数 + 问题数 + [展开]
   - 展开后显示问题清单，每条一行：`severity 图标` + `file:line`（可点击，调已有的文件打开逻辑）+ `message`
   - LLM 维度未完成时显示转圈 + 「分析中」
5. **底部操作条**：[一键优化]（主按钮，禁用条件：无体检结果 / 无勾选 / 正在执行）+ [重新体检] + [还原上次优化]（有备份时才显示）

**diff 确认弹层**：高风险维度产出 diff 后，用 `ui.js` 的 `confirmDialog` 模式弹出，逐文件展示 before/after 对比，每项独立勾选，底部 [应用选中项] / [全部跳过]。

**安全约定**：渲染 LLM 产出的任何文本一律 `createElement + textContent`，禁 `innerHTML`（项目既有硬性约定）。diff 高亮用 DOM 结构 + class，不拼 HTML 字符串。

## 11. 错误处理

| 场景 | 处理 |
|---|---|
| 目录不存在 / 无读权限 | 体检接口返回 400，前端 toast 提示 |
| 目录不是 Claude Code 项目（无 CLAUDE.md 且无 .claude/） | 正常体检，维度①③ 给出「未建立」结论并列为可修复项 |
| LLM run 超时（> 5 分钟） | 该维度标 `status: "timeout"`，分数 N/A，权重重分配，UI 显示 [重试该维度] |
| LLM 返回非法 JSON | 重试一次；仍失败则该维度标 `status: "error"` |
| 一键优化中途进程崩溃 | 重启后 pump 检测到 `busy` 且 runId 已死 → 标记为中断，UI 提示「上次优化未完成」+ [还原] |
| 快照目录写入失败 | 中止优化，不做任何改动，报错 |
| 优化过程中文件被外部修改 | 落盘前比对文件 hash 与快照时是否一致，不一致则跳过该文件并在结果中标注 |

## 12. 测试策略

遵循项目既有约定：纯逻辑拆到 `*.logic.js`，配 `*.test.js`，用 `node --test` 跑。

**必须有单测的部分**

- `check-map.logic.js`：覆盖率计算、新鲜度判定、死链提取的正则、判分公式
- `check-rules.logic.js`：frontmatter 解析、`pathsWidth` 分级、应降级判定
- `check-prompts.logic.js`：绝对化指令词匹配、范围限定词白名单、段落切分
- `score.logic.js`：加权总分、N/A 权重重分配、档位映射
- `backup.logic.js`：manifest 生成与还原路径映射

**测试夹具**：在 `tests/fixtures/projects/` 下造三个假项目——`healthy`（各项达标）、`no-map`（无任何地图）、`kxmall-like`（复刻本次实测出的三类问题），用于端到端验证判分。

**不写单测的部分**：LLM 检测器（输出不确定），改为断言「提示词模板包含必需的字段说明」+ 「JSON schema 校验函数正确拒绝非法载荷」。

## 13. 落点清单

```
public/index.html                          加 .tool-item#toolOptimize + panel-page[data-view=optimize]
public/app.js                              绑点击 + showView 分支 initOptimizePanel()
public/js/optimize-view.js                 新建 · 面板渲染、SSE 接流、diff 弹层
public/js/optimize-view.logic.js           新建 · 纯逻辑(分数格式化/档位映射/问题分组)
public/js/optimize-view.logic.test.js      新建
public/app.css                             追加 .optimize-* 样式 + 新增 --danger 变量

src/entrypoints/web/routes-optimize.js     新建 · handleOptimizeRoutes(req,res,url)
src/entrypoints/web/server.js              加一行: startsWith('/api/optimize/') 分发
src/entrypoints/web/optimize-ops.js        新建 · 业务编排 + startOptimizePump()

src/features/project-checkup/index.js      新建 · 统一入口 runCheckup(dir)
src/features/project-checkup/check-map.js          + check-map.logic.js + .test.js
src/features/project-checkup/check-prompts.js      + check-prompts.logic.js + .test.js
src/features/project-checkup/check-rules.js        + check-rules.logic.js + .test.js
src/features/project-checkup/check-comments.js     (纯 LLM，无 logic 拆分)
src/features/project-checkup/score.logic.js        + .test.js
src/features/project-checkup/prompts/               LLM 提示词模板 (md 文件)
src/features/project-optimize/backup.js            + backup.logic.js + .test.js
src/features/project-optimize/fix-map.js
src/features/project-optimize/fix-rules.js         rules→skill 降级的确定性文件操作
src/features/project-optimize/fix-prompts.js
src/features/project-optimize/fix-comments.js

src/store/optimize.js                      新建 · readJson/updateJson('optimize.json')

tests/fixtures/projects/{healthy,no-map,kxmall-like}/   测试夹具
```

复用而非新造：项目选择用 `saved-dirs.js` + `dir-popover.js`；跑 Claude 用 `createRun()` + `startClaudeRun()`；SSE 照 `routes-run.js` 的 `handleRunAttach` 模式；串行闸照 `requirement-ops.js` 的 pump。

## 14. 开放问题

无。所有设计决策已在评审中确认：

- 体检架构：混合并行（静态秒出 + LLM 回填）
- 维度④：v1 置灰
- 评分范围：连带常规代码质量，单一总分（不拆分）
- 权重：35 / 30 / 15 / 20

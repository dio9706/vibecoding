# 项目优化：全方位维度体系 · 设计

- 日期：2026-09-03
- 状态：**已实施**（实现落点见 §10；与本文的偏差见 §7 末与 §12）
- 前序：`2026-08-27-project-optimize-map-design.md`（维度①地图自动修复）

## 1. 背景与本次要解决的问题

「项目体检 / 一键优化」目前有 6 个维度，其中只有 `rules`、`map` 具备自动修复能力
（`fix-plan.logic.js` 的 `SUPPORTED_DIMENSIONS`）。用户诉求是把它做成**面向任意项目的全方位优化**：
低频执行、允许多花 token 和时间、依据权威工程实践、每个维度都要有 LLM 参与、
并在最后追加一项由模型对项目整体做智能评估。

重新评审现有实现，发现三个**结构性**缺陷——它们不是「少做了几个维度」，而是照当前形状再加维度会越加越糟：

### 缺陷 A：维度粒度与权威实践对不上

`comments` 一个 key 混装了「注释复述代码」「注释已过期」「死代码注释」三类成因和修法都不同的问题，
判分被摊平成密度，用户看不出该先修哪类。反过来，公认的头等问题——架构依赖方向、错误处理与超时、
依赖健康、硬编码密钥——**一个维度都没有**。

### 缺陷 B：「每维度四文件」的范式撑不到十几个维度

`check-prompts.js` 有 530 行，其中提示词质量**特有**的只有约 80 行（候选召回规则 + 判据文案）。
剩下约 450 行是分批、限并发、失败重试、全有或全无校验、指纹缓存、判定重锚定——
**每个 LLM 维度都要重写一遍的同构逻辑**。`check-comments.js` 已经是它的一份近似拷贝。
再加 10 个维度就是 10 份拷贝，违反 DRY，且每份都会独立漂移（超时预算、批大小、重试次数各不相同）。

### 缺陷 C：修复能力没有与检测能力对称的抽象

`fix-rules` / `fix-map` 是两份手写编排，`optimize-ops.js` 的 `runFix` 里各占一段。
加第三个维度就要再插一段 if——违反 OCP。而各维度的修复动作其实只有**五种形状**（见 §5）。

## 2. 设计目标与非目标

**目标**

1. 维度细分到「一个维度 = 一类成因 + 一种修法」，并显式标注权威出处。
2. 新增维度 = 注册表里加一条声明，不新建文件、不动编排（OCP）。
3. 同构管线只此一份（DRY）：分批 / 限并发 / 重试 / 校验 / 缓存 / 重锚定。
4. 每个维度都有 LLM 参与（§7 说明既有静态维度如何满足）。
5. 跨项目通用：召回层不依赖单一语言或框架的语法树。
6. 追加 `holistic` 维度：模型读全部维度结论 + 项目结构，给出优先级行动计划。

**非目标（明确不做）**

- **不加成本护栏**。地图维度已就此拍板过（实测全量 $9.90，用户明确选择「什么都不加」）：
  不做成本预估确认、不做条目上限、不做模块勾选。本次沿用。
- 不重写 `check-prompts.js` / `check-comments.js`。它们的判据是多次实测校准出来的
  （模型档位、超时预算、批大小都有事故记录），换引擎会把这些校准丢掉。新引擎只服务新维度。
- 不做跨项目的历史趋势对比、不做 CI 集成。

## 3. 维度体系

五个域、17 个维度。`权重` 列为总分权重（`score.logic.js` 的 `WEIGHTS`）。

### 域 A · AI 协作配置（权重合计 25）

| id | 名称 | 权重 | 判据要点 | 权威依据 |
|---|---|---|---|---|
| `map` | 项目地图 | 10 | 地图是否建立、是否过期、引用是否失效 | 既有 |
| `prompts` | 提示词质量 | 11 | 规则是否过度宽泛、是否互相冲突、是否重复 | 既有 |
| `rules` | 规范加载方式 | 4 | 大块规范是否该从 rules 降级为 skill | 既有 |

> 权重与判据出处的权威声明在 `src/features/project-checkup/dimensions/registry.js`，
> 本表是它的说明性摘要。两者不一致时以注册表为准（`score.logic.js` 的 `WEIGHTS` 从它派生，
> 前端 `DIM_META` 的一致性由 `optimize-view.logic.test.js` 的交叉校验钉住）。

### 域 B · 代码质量（权重合计 24）

| id | 名称 | 权重 | 判据要点 | 权威依据 |
|---|---|---|---|---|
| `complexity` | 复杂度与函数规模 | 7 | 长函数、深嵌套、参数过多、巨型文件 | 《代码整洁之道》ch3；《代码大全》ch19 |
| `duplication` | 重复实现 | 6 | 同一逻辑多处实现（DRY 违背） | 《重构》Duplicated Code；《程序员修炼之道》DRY |
| `naming` | 命名与意图表达 | 4 | 命名是否揭示意图、是否用无信息量的缩写 | 《代码整洁之道》ch2；《编写可读代码的艺术》 |
| `comments` | 注释合理性 | 4 | 注释是否解释「为什么」、是否已过期 | 既有；《代码整洁之道》ch4 |
| `deadcode` | 死代码与未使用导出 | 3 | 零引用的导出、被注释掉的代码块 | YAGNI；《重构》Speculative Generality |

### 域 C · 架构（权重合计 12）

| id | 名称 | 权重 | 判据要点 | 权威依据 |
|---|---|---|---|---|
| `structure` | 分层与依赖方向 | 12 | 反向依赖、循环依赖、跨层直连 | 《架构整洁之道》依赖规则；SOLID-D |

### 域 D · 健壮性（权重合计 25）

| id | 名称 | 权重 | 判据要点 | 权威依据 |
|---|---|---|---|---|
| `tests` | 测试健康度 | 12 | 测试是否全绿、大文件是否缺测试 | 既有；《Google 软件工程》ch11 |
| `errors` | 错误处理与稳定性 | 7 | 空 catch、吞异常、外部调用缺超时 | 《Release It!》稳定性模式；《Effective Java》ch10 |
| `security` | 敏感信息与危险用法 | 6 | 硬编码凭证、危险 API、注入面 | OWASP Top 10 |

### 域 E · 工程化（权重合计 14）

| id | 名称 | 权重 | 判据要点 | 权威依据 |
|---|---|---|---|---|
| `hygiene` | 仓库卫生 | 4 | 运行数据 / 临时脚本是否误入版本库 | 既有 |
| `deps` | 依赖健康 | 4 | 未使用依赖、缺失依赖、功能重复的库 | 《Google 软件工程》ch21 |
| `config` | 配置与环境收口 | 3 | 硬编码地址 / 端口 / 路径，env 是否收口 | 12-Factor App §3 |
| `docs` | 文档可上手性 | 3 | README 的上手命令是否与真实脚本一致 | 《Google 软件工程》ch10 |

### 域 F · 综合（不计入加权）

| id | 名称 | 权重 | 说明 |
|---|---|---|---|
| `holistic` | 整体智能评估 | 不参与 | 读全部维度结论 + 项目结构，产出「最该先做的几件事」与跨维度矛盾 |

`holistic` **不进 `WEIGHTS`**。它是对其他维度的元评估，计入总分等于把同一批问题数两遍；
而 `aggregateScore` 只遍历 `WEIGHTS` 的 key，不在表里的维度天然被排除，无需额外分支。

## 4. 通用审计引擎

### 4.1 统一管线

所有新维度共享同一条管线，形状抽取自 `check-prompts.js` 的实测校准结果：

```
recall(dir, ctx) → candidates[]        零 LLM，只 grep / stat / 读清单
      ↓  candidates 为空 → 直接满分，不发 LLM 请求
computeFingerprint → 命中缓存则直接返回上次结果
      ↓
分批（BATCH_SIZE=12）→ 限并发（MAX_CONCURRENCY=4）→ 每批失败重试 1 次
      ↓
validateVerdicts：条数必须相等、verdict 必须在词表内 → 否则整批作废
      ↓  任一批作废 → 整维度 partial（不计入总分）
reanchor：以本地候选表为准覆盖模型回填的 file/line
      ↓
evaluateAudit：按 verdict 的扣分表算分、产出 issues
```

沿用的既有校准值及其理由（都写在 `check-prompts.js` 的注释里，不要擅自改动）：

- `BATCH_SIZE = 12`：20 条一批时模型会动「先去读原文件」的念头，一轮用光 `maxTurns`。
- `MAX_CONCURRENCY = 4`：每批一个 Claude 子进程，10 批全并发本机吃不消。
- `BATCH_TIMEOUT_MS = 300_000`：默认模型每批实测 60~127s，122s 预算会在模型已成功返回后放弃。
- `JUDGE_MODEL = null`（跟随会话默认模型）：haiku 实测判定不稳（同输入三次跑出 4/8/6 条）。
- 全有或全无校验：挑着用等于把噪声当结论展示，比报 partial 危险得多。

### 4.2 维度声明的形状

```js
{
  id: 'complexity',
  label: '复杂度与函数规模',
  hint: '长函数、深嵌套、参数过多、巨型文件',   // 前端卡片副标题
  category: 'quality',
  weight: 7,                                  // 省略即不参与总分加权
  source: '《代码整洁之道》ch3；《代码大全》ch7 / ch19',
  engine: 'audit',                            // 'legacy' = 有专属检测器
  recall: recallOversizedUnits,               // 召回器函数（evidence/selectors-*.logic.js）
  rubric: RC.complexity,                      // 判据文案（rubrics-*.js）
  fingerprintScope: 'sources',                // 吃哪一份指纹，决定缓存何时失效
  verdicts: {                                 // 词表 + 扣分表 + issue 码表，三者唯一来源
    'must-split':   { weight: 8, code: 'X1_MUST_SPLIT',   severity: 'warn' },
    'should-split': { weight: 3, code: 'X2_SHOULD_SPLIT', severity: 'info' },
    acceptable:     { weight: 0 },            // weight 0 = 只进 verdictLog，不产出 issue
  },
  scoring: { mode: 'density', factor: 40, maxDeduct: 70 },
  fixOrder: 42,                               // 修复管线次序（见 §5.2）
  fix: 'llm-refactor',                        // 字符串或数组（prompts 是复合策略）
}
```

`verdicts` 同时充当**校验白名单**、**扣分表**和**issue 码表**——分开写过就一定会漂移
（`check-prompts.js` 的 `VALID_VERDICTS` 注释记录过：新增 verdict 必须同时改提示词和白名单，
漏一处就是整批失败）。

`augments: '<宿主维度id>'` 是第二种条目形态：不单独成维度、不参与加权，结论并进宿主
（当前只有 `hygiene-audit` 用它给零误报的 `hygiene` 补召回率）。

### 4.3 召回器（`evidence/selectors-code.logic.js` 与 `selectors-project.logic.js`）

两个文件的分野：前者逐行扫**文件内容**，后者看**文件之间的关系**与项目根上的清单。
两类取材的输入形状与聚合粒度都不同，混在一起会让「候选是逐行的还是逐边的」需要读代码才知道。

召回层必须**语言无关**：不依赖任一语言的语法树，只用行级正则 + 文件度量。
判定的准确性由 LLM 那一步负责，召回只求「不漏」且「候选量可控」。

| 召回器 | 产出候选 | 用于维度 |
|---|---|---|
| `recallOversizedUnits` | 超阈值的函数单元（有效行 >60 / 嵌套 >4 / 参数 >5）与巨型文件（>600 有效行） | `complexity` |
| `recallSimilarBlocks` | **函数体**归一化后指纹相同的组（≥2 处、≥6 有效行）。指纹跳过声明行，否则「复制一份改个名」永远匹配不上 | `duplication` |
| `recallVagueNames` | 低信息量的导出符号名（通用词全名 / ≤2 字符 / 无元音缩写 / 仅数字后缀区分） | `naming` |
| `recallDeadCode` | 零引用或只被自己测试引用的导出；连续 ≥3 行被注释掉的代码 | `deadcode` |
| `recallCatchBlocks` | 无处置代码或只打日志的异常块（**证据含块内注释**——那句注释常常就是「为什么可以忽略」的论证） | `errors` |
| `recallRiskyPatterns` | 硬编码凭证 / 注入面 / 不安全反序列化 / 弱哈希 / 明文传输 | `security` |
| `recallImportGraph` | 聚合到**目录对**的跨层依赖边 + 文件级 import 环 | `structure` |
| `recallDepManifest` | 依赖清单与全仓 import 名的差集 + 一条整体「功能重复」候选 | `deps` |
| `recallHardcodedConfig` | 硬编码绝对路径 / IP / 端口 + 一条聚合的「env 读取点分散」候选 | `config` |
| `recallOnboardingDocs` | README 里的命令块（或其缺失），以真实 scripts 为判据 | `docs` |
| `recallSuspiciousTracked` | git 追踪的非源码扩展名 / 临时语义命名 / 异常体积文件 | `hygiene-audit` |

**召回精度是靠实测调出来的，不是想出来的。** 首轮在本仓库跑出 993 条候选，
逐类核对后发现四类系统性误判并修正：`.exec(` 被当命令执行（`exec` 的 `` 在 `.` 后成立）、
`http://www.w3.org` 命名空间被当明文传输（每段内联 SVG 都带它）、回环地址被当硬编码、
测试夹具里的路径被当配置问题；另外 vendor 与压缩产物未排除。修正后 581 条，
`security` 从 203 降到 27、`config` 从 206 降到 3。

共同约束：

- 只看 `git ls-files` 的结果（`git-tracked.js`）。构建产物里的副本会重复计分并重复烧额度。
- 目录排除走 `scan-dirs.logic.js` 的 `shouldSkipDir`（已有维度共用，不另立清单）。
- 每个召回器返回 `{file, line, text, meta}` 的统一形状，引擎才能一视同仁地分批与重锚定。

## 5. 通用修复引擎

五种修复策略，覆盖全部 17 个维度：

| 策略 | 动作 | 安全性来源 | 使用维度 |
|---|---|---|---|
| `deterministic` | 机械编辑，无 LLM | 判定确定、可逆 | `hygiene` + `hygiene-audit`（gitignore+untrack）、`prompts`(P4 去重) |
| `llm-rewrite` | LLM 定点改写已有**文档**。扩展名白名单（`.md` 类）是这条路径的唯一闸 | 不碰源码 + 快照 | `docs`、`prompts`(P1/P2/P3) |
| `llm-create` | LLM **新建**文件，产出物须真跑通才保留 | 只新建；跑不通就删除（留红测试会堵死后续所有源码修复） | `tests`(S2) |
| `llm-refactor` | 单文件源码重构 agent | **测试闸**：改前绿 → 改后重跑 → 红了回滚该文件 | `complexity`、`duplication`、`deadcode`、`errors`、`comments` |
| `advisory` | 只产出可执行的整改清单文件，不改任何现有文件 | 零写入风险 | `security`、`structure`、`naming`、`deps`、`config`、`holistic`，以及**任何策略都不认领的 issue 与全部降级目标** |

`map` / `rules` 不在此表：它们保留各自校准过的专用流程（`fix-map.js` / `fix-rules.js`），
边界记在 `fix-engine.logic.js` 的 `BESPOKE_DIMS`。

`naming` / `config` 从初稿的自动改写降为 `advisory`，理由与 `security` / `structure` 同类：
改名要动全部调用点，而调用点里可能有字符串引用（路由表、插件清单），静态改写会漏；
配置外部化要同时建配置模块并改调用方，是跨文件设计决策。

**核心规则：没有 issue 会被静默丢掉。** 任何策略都不认领的、以及被测试闸挡下的，
一律落进整改清单。原来的行为是给一句「勾选的 X 维度暂无自动修复能力」——诚实但产出为零。

### 5.1 测试闸：源码重构的准入条件

**《Working Effectively with Legacy Code》的核心论点：没有测试就不该重构。** 本设计把它落成硬闸：

```
llm-refactor 执行前：
  1. 项目有可跑的测试命令？          否 → 整个策略降级为 advisory
  2. 跑一遍，全绿？                  否 → 整个策略降级为 advisory（红着改会分不清是谁弄红的）
  3. 记录基线（命令、耗时、退出码）
每改完一个文件：
  4. 重跑测试
  5. 红了 → 用备份把**该文件**回滚，记为 reverted，继续下一个（不中止整批）
  6. 绿了 → 记为 done
```

降级不是失败，是如实告知：降级时 `advisory` 会把「本维度因缺少测试安全网未自动修改」写进清单首行。
这条降级规则同时定出了修复管线的顺序（§5.2）。

### 5.2 修复管线顺序

顺序不是审美，每一步都为后一步创造前提：

1. **`hygiene` / `deps` / `config`** —— 机械与配置层，无 LLM 或只改配置，最快且零源码风险。
2. **`tests`** —— 建立安全网。必须在任何源码重构之前，否则第 4 步整批降级。
3. **`map` / `rules` / `prompts` / `docs`** —— 文档层。放在源码之前是因为改源码会让地图更过期。
4. **`deadcode` → `duplication` → `complexity` → `naming` → `comments` → `errors`** —— 源码层，需绿灯。
   内部顺序按「改动面从大到小」：先删死代码（可能让后面几项无事可做），再合并重复，
   再拆长函数，最后才是改名和注释。反序会做白工——先改好名字的函数下一步就被删了。
5. **`security` / `structure`** —— 只产出清单。安全与架构的修法涉及跨文件设计决策，
   由人拍板；机器给出证据和方案，不动手。
6. **`holistic`** —— 最后跑，读前五步的**实际结果**（而非体检时的旧结论）产出行动计划。

## 6. holistic 维度

与其他维度形状不同：它没有静态召回，输入是「其他 16 个维度的结论 + 项目结构轮廓」。

- **检测**：用只读 agent（`llm-readonly-agent`，600s 预算）读项目结构与各维度 issue 摘要，产出
  `{score, verdict, topActions[], contradictions[], strengths[]}`。
  - `topActions`：最该先做的 3~5 件事，每条带「为什么现在做」「预计影响哪些文件」「完成判据」。
  - `contradictions`：跨维度矛盾（例：`prompts` 要求补充边界说明，而 `docs` 判定文档已过载）。
  - `strengths`：做得好的地方。只报问题会让用户失去判断基准，也无从知道哪些约定该保持。
- **修复**：`advisory` —— 写 `.claude/optimize/PLAN.md`。这是整个功能的收口产物：
  一份带优先级、有出处、可直接执行的行动计划。逐维度的整改清单落在同目录的
  `.claude/optimize/<维度id>.md`。**全部产出物集中一个目录**，便于整体 review 或整体 gitignore。
- **分数不计入总分**（§3 域 F）。

## 7. 「每个维度都有 LLM 参与」如何满足

| 维度 | LLM 参与形式 |
|---|---|
| 10 个新维度 | 检测走通用审计引擎（LLM 逐条判定）；修复按策略调 LLM |
| `prompts` | 检测已是 LLM 判定（既有）；修复：P1/P2/P3 走 LLM 文档改写，P4 走确定性去重 |
| `comments` | 检测已是 LLM 判定（既有）；修复走 LLM 源码重构（过测试闸） |
| `map` | 修复走只读 agent 生成地图正文（既有 `gen-map.js`） |
| `rules` | 修复走 LLM 生成 skill description（既有 `describe-skill.js`） |
| `tests` | 修复走 LLM 生成测试文件（新增，产出物须真跑通才保留） |
| `hygiene` | 检测新增 `hygiene-audit` augment 条目：`suspiciousTracked` 召回 + LLM 判定，补上确定性规则刻意放弃的召回率 |
| `holistic` | 全程 LLM（只读 agent） |

**一处如实的偏差**：spec 初稿曾计划给 `map` 增加「地图正文与代码是否相符」的 LLM 检测
（现有 M3 只比 mtime，是个已知弱点）。实现时没做——它需要为每份地图各跑一次只读 agent
读代码核对，成本与地图生成同量级，属于独立一期的工作量。`map` 的 LLM 参与仍在修复侧。
该项已记入 §11 后续。

`hygiene` 的 LLM 深化值得单说：现有规则刻意做成**零误报**（只认 `.jsonl`/`.log` 和
`tmp-`/`temp-`/`debug-` 前缀），代价是召回极低——`cobe-probe.tmp.mjs` 这类命名就抓不到。
加一层 LLM 判定后，可以把「非源码扩展、异常体积、临时语义命名」全都作为候选交给模型判，
既提高召回又不牺牲误报率（模型判 `keep` 的不产出 issue）。

## 8. 数据结构与兼容性

### 8.1 报告结构不变

`report.dims[key] = {score, status, issues, verdictLog, reason, cached}` 形状不动。
新维度只是多了几个 key。`recomputeReport` / `aggregateScore` / SSE 回填全部无需改动。

新增可选字段（只 `holistic` 用）：`report.dims.holistic.plan = {topActions, contradictions, strengths}`。

### 8.2 缓存

`store/optimize.js` 的 `saveLlmCache(dir, key, entry)` 已经按维度 key 存，**无需改动 store**。

### 8.3 前端

`optimize-view.logic.js` 的 `DIM_META` 从平表改为**带 `category` 的平表**（不改成嵌套结构：
`dimListFrom` 的调用方按数组消费，改形状会牵动全部渲染与测试）。渲染时按 category 分组插入组标题。

`selectable = status === 'done'` 的判据不变；`holistic` 卡片额外渲染 `plan` 区块。

### 8.4 向后兼容

旧的 `optimize.json` 里没有新维度的缓存与分数。表现为新维度 `status: 'pending'` → 不计入总分 →
用户点一次体检就补齐。不需要迁移脚本。

## 9. 风险与取舍

| 风险 | 处置 |
|---|---|
| 一次全量体检的 LLM 成本大幅上升（10 个新维度 × 分批判定） | 按已有拍板不加护栏；靠指纹缓存让重复体检近乎免费；候选为 0 的维度不发请求 |
| `llm-refactor` 改坏源码 | 三重：测试闸（红了回滚该文件）+ 全量备份可还原 + 脏工作区二次确认 |
| 无测试项目的源码维度全部降级为清单 | 如实告知；`tests` 维度先跑，为下一轮解锁 |
| 10 份新判据未经实测校准，首轮判定质量可能不稳 | `verdictLog` 全量留档（含 `acceptable`），让每轮结果可逐条回溯与横向对比 |
| 维度多了，界面变成一面墙 | 按域分组 + 组级折叠；`holistic` 置顶，它就是「先看哪儿」的答案 |
| `naming` / `duplication` 这类判定天然主观，误报率高于静态维度 | 扣分表给低权重；`must-*` 才产出 issue，`should-*` 只进 `verdictLog` |

## 10. 实现落点

| 关注点 | 文件 |
|---|---|
| 维度声明（唯一来源） | `src/features/project-checkup/dimensions/registry.js` |
| 判据文案 | `dimensions/rubrics-code.js` / `rubrics-project.js` |
| 通用审计引擎 | `project-checkup/audit-engine.js` + `.logic.js` |
| 取材与召回 | `project-checkup/evidence/`（`collect.js` / `units.logic.js` / `symbols.logic.js` / `selectors-*.logic.js`） |
| 整体评估 | `project-checkup/check-holistic.js` + `.logic.js` |
| 通用修复引擎 | `project-optimize/fix-engine.js` + `.logic.js` |
| 五种策略 | `project-optimize/strategies/`（`advisory` / `deterministic` / `llm-edit`） |
| 测试闸 | `project-optimize/test-gate.js` + `.logic.js` |
| 受限写 agent | `src/capabilities/llm-write-agent.js` |
| 编排 | `src/entrypoints/web/optimize-ops.js` |
| 前端 | `public/js/optimize-view.logic.js`（`DIM_META` / 分组）+ `optimize-view.js`（分组渲染 / 计划块） |

## 11. 验收判据

- `npm test` 全绿，新增的每个 `*.logic.js` 都有配套单测。
- 注册表新增一条声明即可跑通一个新维度，无需改 `optimize-ops.js`（用一个假维度验证）。
- 在本仓库跑一次全量体检：17 个维度都有结论（`done` / `na` / `partial`，不出现 `error`）。
- `holistic` 产出的 `.claude/optimize-plan.md` 里每条 action 都能对应到具体文件。
- 无测试的项目上跑一键优化：源码级维度全部如实报「已降级为清单」，不产生任何源码改动。
- 「还原」能把本次全部改动干净撤回（含新建的测试文件与清单文件）。

## 12. 后续（本期未做，已知且刻意留下）

1. **`map` 的内容新鲜度 LLM 检测**。现有 M3 只比 mtime，存在「分数变好、实际变差」的已知形状
   （`describe-skill.js` 开头的警告）。补它需要为每份地图各跑一次只读 agent 读代码核对，
   成本与地图生成同量级，应独立一期。
2. **判分系数实测校准**。10 份新判据的 `factor` / `maxDeduct` / verdict 权重都是首轮估值。
   校准手段已就位：`verdictLog` 留了每一轮的全量判定（含未扣分档），可逐条回溯与横向对比。
3. **`git rm --cached` 的还原缺口**。备份层只管文件内容，没有「索引快照」概念，
   所以还原不会把文件加回 git 索引。当前处理是在 fix notes 里如实告知；
   要真正补上得改 `backup.js` 的 manifest 格式与还原流程。
4. **`structure` / `security` 的 absolute 判分容易饱和**。4 条 violation 就打满 80 分扣分上限，
   而 `structure` 是权重最高的单维度（12）。是否改成分档递减，等第 2 项校准出真实分布后再定
   ——现在改属于没有依据的调参。

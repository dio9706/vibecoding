# Repo Map（代码地图）· 设计

- 日期：2026-09-30
- 状态：已实现（Phase 1 + Phase 2，2026-09-30）；Phase 3（Claude 路径注入）评估备忘见 §9，待实测拍板
- 关联：`docs/superpowers/specs/2026-09-02-project-map-design.md`（**区别见 §1**：那是 LLM 生成的功能模块地图，本方案是符号级、确定性、常驻注入的代码地图）
- 外部参考：Aider repo map（tree-sitter 符号 + 图排序 + token 预算）、90 天路线图第 2 项「自主找线索」

## 1. 背景与目标

**定位诉求**：「下发任务 → 自动识别、追踪、处理，自己去寻找开发线索」。当前 agent 找线索只有两条路：Claude 路径靠 Claude Code 自带探索 + CLAUDE.md；openai 路径（自定义模型）只有 Read/Grep/Glob 工具，**模型对仓库一无所知，每一步都在盲搜**。

**与 `project-map` 的边界**：`project-map` 是给需求工作流看的「功能模块地图」（LLM 生成、按需刷新、喂给文档生成）；本方案是给**每一次 agent 运行**喂的「代码地图」——确定性的（零 LLM）、符号级的（文件 + 关键导出 + 引用重要度）、有预算的上文（默认 ~6k 字符）。两者不互相替代。

**目标**：

1. 构建确定性的仓库地图：git 追踪的源文件清单 + 每个文件的导出符号（含签名行）+ 重要度排序 + 字符预算裁剪；
2. 在 openai 路径起步注入（system prompt 一段），让模型**先看地图再动手**；
3. 缓存 + 增量重建（mtime/size 指纹 + 按文件缓存解析结果），缓存命中时零感知，源文件变了只重解析变化文件；
4. 全程 fail-open：地图构建失败/超时 → 照常运行（地图是增强不是依赖）。

**非目标**：

- 不引入 tree-sitter/@babel 等解析依赖——复用 `project-checkup/evidence` 已验证的抽取器（见 §3.2）；
- 不做语义级调用图（regex 抽取只认导出符号与 import 边，够「找线索」用）；
- 不改 Claude 路径（Phase 3 再评估注入方式，Claude Code 自带探索能力更强）；
- 不做跨仓库/依赖库的地图。

## 2. 拍板记录（2026-09-30 已确认）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 注入范围 | 仅 openai 路径起步（Claude 路径 Phase 3 实测后再定） |
| 2 | 开关策略 | 默认开 + 设置页「基础设置」开关（`repoMap.enabled`） |
| 3 | 字符预算 | 默认 6000 字符，常量起步、实测再调 |
| 4 | 查询个性化 | **Phase 1 就做**：按任务 prompt 关键词加权（中文词无法匹配英文标识符，只取 ASCII 词并拆 camelCase） |
| 5 | 非 git 仓库 | **仅 git 仓库启用**（`gitTrackedFiles` 返回 null → 不出图，不做目录遍历降级） |

## 3. 架构

### 3.1 流程

```
run-openai.js（workspace 已知）
  └─ getRepoMap({ cwd })
       ├─ 读缓存（store/repo-map-cache.json，按 repoPath 哈希分桶）
       ├─ stat 全部 git 追踪源文件 → fingerprint（复用 project-checkup/fingerprint.logic.js）
       │    ├─ 指纹未变 → 直接用缓存（毫秒级）
       │    └─ 变了 → 只重解析 mtime/size 变化的文件（其余复用 per-file 记录）
       ├─ 排序（引用度）+ 裁剪（字符预算/文件数上限）→ 格式化
       └─ 失败/超时（4s 上限）→ 返回旧缓存或空串（fail-open，记日志）
  └─ buildAgentSystemPrompt({ cwd, repoMap }) → 追加「## 仓库地图」段
```

### 3.2 复用件（零新依赖，这是本方案能小的关键）

| 能力 | 来源 | 复用方式 |
|---|---|---|
| 「什么算源码」 | `project-checkup/git-tracked.js#gitTrackedFiles` | 直接调用（.gitignore 感知；非 git 返回 null） |
| 目录跳过 | `project-checkup/scan-dirs.logic.js#shouldSkipDir` | 直接调用（`skipHidden`），叠加 `vendor/test/tests/__tests__/spec/e2e` |
| 导出符号 + 引用计数 | `project-checkup/evidence/symbols.logic.js#collectExports` | 直接调用（返回 `{name,kind,line,decl,file,refs,refFiles,refsFromTestsOnly}`，内部自带 token 索引） |
| import 边 | `project-checkup/evidence/selectors-project.logic.js#extractImports` | 直接调用（`{spec,relative,target}`） |
| 缓存指纹 | `project-checkup/fingerprint.logic.js#computeFingerprint` + `isCacheValid` | 直接调用（mtime+size、md5 16 位） |

**给 `evidence/*` 加新逻辑必须克制**：`symbols.logic.js` 被 naming/deadcode 两个体检维度共用，改抽取规则会连带改体检结果。本方案 Phase 1 **不改它**；类方法等增强走 repo-map 自己的附加抽取器（Phase 2，纯增量，不碰共享件）。

### 3.3 新增/改动文件

| 文件 | 职责 |
|---|---|
| `src/features/repo-map/repo-map.logic.js` | 纯函数：查询词/标识符提取、引用与入度、排序（含查询加权）、预算裁剪、格式化、增量合并决策 |
| `src/features/repo-map/index.js` | IO + 编排：git 清单/stat/读文件/调抽取器/缓存读写/超时兜底；依赖注入便于测试 |
| `src/store/repo-map-cache.js` | 缓存落 store（`repo-map-cache.json`）：按 repoPath 哈希分桶、LRU 上限 5 仓、走 updateJson 文件锁 |
| `src/features/repo-map/repo-map.logic.test.js` / `repo-map.fs.test.js` | 纯函数 + 临时 git 仓库真文件系统测试 |
| `src/providers/builtin-tools.js` | `buildAgentSystemPrompt({ cwd, platform, repoMap })` 追加地图段 |
| `src/entrypoints/web/run-openai.js` | 起 run 时取地图（try/catch fail-open）并传入 |
| `src/store/settings.js` / `routes-settings.js` / `public/{index.html,js/settings-panel.js}` | `repoMap.enabled` 开关（默认 true）后端 + UI |

> **为什么放 `features/` 而不是 `capabilities/`**：本方案复用 `features/project-checkup/evidence` 的符号/import 抽取器，而分层约定禁止 capabilities → features 的上行依赖；features 之间互相引用已有先例（`project-map/collect-facts.js` 同样引用 checkup 的 git-tracked 与抽取器），并在文件头注明理由。

## 4. 详细设计

### 4.1 排序（重要度）

```
symbolScore = refs（引用它的**文件数**；由 per-file 标识符集合聚合，口径同 evidence 的
              buildTokenIndex：按文件集合、只高估不高报）
              +（refsFromTestsOnly ? 0.5 : 0）   // 只有测试引用 → 降权
fileScore   = Σ_topK(symbolScore)（K=8） + inDegree × 2   // inDegree = 多少文件 import 它
boost       = queryBoost（Phase 1）：符号名命中任务关键词 +4/个（上限 5 个）；
              路径段命中 +1 项（上限 3）——保证「按任务找相关文件」生效但不过度偏置
最终分       = fileScore + boost
```
- 任务关键词只取 ASCII 词（长度 ≥3、滤停用词），并拆 camelCase/snake_case（`repo-map` → `repo`、`map`）；纯中文 prompt 提不出词 → 自然退化为全局排序。
- 稳定排序：分数相同按路径字典序（结果可复现，测试可钉）。
- 测试文件不进地图（`isTestFile` 过滤）。

### 4.2 格式化（Aider 风格，控制单行长度）

```
# 仓库地图（自动生成：文件 + 关键导出符号，按引用重要度排序；可能略旧，以实际文件为准）
src/store/runs.js  (18)
│ export function createRun(...)
│ export function finishRun(run)
⋮
src/providers/builtin-tools.js  (12)
│ export function createBuiltinTools({ cwd, signal } = {})
```
- 每文件最多 8 个符号；`decl` 截断 100 字符（保留签名可读性）；文件头标注分数。
- 预算裁剪：按 fileScore 降序装文件；装不下的文件整体丢弃（不做半个文件——地图是索引不是正文）；末尾附一行 `（已按预算裁剪，共 N 个源文件）`。

### 4.3 缓存与增量

```js
// store/repo-map-cache.json
{ [repoKey]: {
    repoPath, builtAt, fingerprint,
    files: { [rel]: { mtimeMs, size, symbols:[{name,kind,line,decl}], imports:[target...] } },
    map: '格式化后的最终文本',
  } }
```
- 刷新时：`gitTrackedFiles` → stat 全部 → 与各记录 `mtimeMs/size` 比对 → **只重读/重解析变化与新文件**；删除的文件从记录中剔除；然后全量重算排序与格式化（纯函数，微秒级）。
- 单文件上限 256KB（超过跳过并在日志标注）；文件数上限（默认 1200）按目录序截断。
- LRU：缓存里最多保留 5 个仓库，超出按 `builtAt` 最旧淘汰。

### 4.4 注入（openai 路径）

- `run-openai.js` 在 `buildAgentSystemPrompt` 之前 `await getRepoMap({ cwd: workspace })`，包 try/catch；超时上限 **4s**（复用 `AbortSignal.timeout` 思路，解析循环里查 deadline）。
- `buildAgentSystemPrompt` 追加段（仅当 repoMap 非空）：
  ```
  ## 仓库地图（自动生成，按引用重要度排序）
  先用它定位线索，再用 Read/Grep 深入；地图可能略旧，以实际文件为准。
  <repoMap>
  ```
- 与内置工具的配合：地图回答「大概去哪」，Read/Grep/Bash 回答「具体是什么」——系统提示词里把这条分工写明（model 少走弯路）。

### 4.5 设置与开关（Phase 2）

- `settings.repoMap = { enabled: true }`（normalize 补默认；导入导出透传）；关掉 → run-openai 不取地图。
- UI：设置页「基础设置」tab 一个开关（复用现有 switch 组件）。

## 5. 边界与风险

| 风险 | 缓解 |
|---|---|
| 解析/排序拖慢 run 起步 | 缓存命中毫秒级；冷启动/大改 4s 上限，超时用旧缓存或空串（fail-open） |
| 地图误导（过期/漏符号） | 注入文案明说「可能略旧、以实际文件为准」；每次指纹校验保证「文件变了就重建」 |
| regex 抽取的局限（只认导出符号、类方法缺失） | 地图定位为「对外接口骨架」，够找线索；类方法 Phase 2 以附加抽取器补，不动共享件 |
| 缓存膨胀 | per-file 记录只存符号/import 摘要（不存源码正文）；LRU ≤5 仓 |
| 隐私 | 只包含 git 追踪文件的**路径与符号名**，无正文；.gitignore 文件（.env 等）天然不在清单 |
| 体检结果被连带影响 | Phase 1 零改动 `evidence/*`；新增测试断言 checkup 既有用例全绿（回归门） |

## 6. 验收

**单测**

- `repo-map.logic.test.js`：重要度公式（refs/测试降权/inDegree）、稳定排序、预算裁剪（永不超预算、整文件丢弃、末尾注明）、格式化（截断/省略）、增量合并决策（新增/变更/删除/未变四象限）、记录结构校验。
- `repo-map.fs.test.js`（真文件系统 + 注入桩）：临时 **git** 仓（3~5 个文件带 import 关系）→ 地图含排序后的文件与符号；第二次调用命中缓存（spy 计数文件读取为 0）；改一个文件 → 只重解析 1 个；删一个文件 → 从地图消失；**非 git 目录 → 返回空串（仅 git 仓库启用）**；构建失败 → fail-open 返回空串。
- `builtin-tools.test.js`：`buildAgentSystemPrompt` 带 repoMap 时包含段头与内容、缺省时不含。
- 回归：`npm test` 全绿（含 project-checkup 既有用例，证明共享件未被波及）。

**手测**

1. 起一个自定义模型会话（cwd 选一个真实项目）→ 问「这个项目的入口和核心模块在哪」→ 模型回答应引用地图里的文件/符号，而不是盲目 Grep。
2. 改一个文件再起 run → 地图里该文件行内容更新（增量生效）。
3. 断点：删掉缓存文件 → 第一次 run 稍慢但正常出图，第二次恢复毫秒级。

## 7. 分阶段

- **Phase 1（核心，已实现）**：`features/repo-map`（logic + io）+ store 缓存 + openai 路径注入 + `repoMap.enabled` 开关（后端 + 设置页 UI）+ 查询个性化 + 测试。
- **Phase 2（已实现，2026-09-30）**：类方法附加抽取器（`extra-symbols.logic.js`：JS/TS 类体词法扫描 + Python 缩进法；**不碰** checkup 共享件）；缓存记录带 `version`（抽取器口径变化即整体作废）；`RepoMap` 工具（按 query 过滤、12000 字符预算、`refresh=true` 强制重建；仅在开关开启时装配）；预算与权重留待实测调优。
- **Phase 3（评估待拍板）**：Claude 路径注入——见 §8 评估备忘。

## 8. Phase 3 评估备忘：Claude 路径是否注入地图（未实现）

**现状**：Claude 路径有 Claude Code 自带的探索能力（Glob/Grep/Read + CLAUDE.md），找线索本就不弱；地图注入是「加速器」而不是「开眼」。硬塞还可能挤占它自己的探索策略。

**两种落点**（spec 原文提到的方向）：

| 落点 | 做法 | 代价 |
|---|---|---|
| auto-dev `develop` 的 prompt 前缀 | `task-ops.js#develop` 拼一段地图（复用 `getRepoMap({cwd, query})`） | 只覆盖 auto-dev，交互式会话没有；prompt 在 auto-dev 下会被长任务反复重放 |
| SDK `systemPrompt` 追加 | `run-claude.js` 在 `systemPrompt.content` 后追加地图段 | 全路径覆盖；SDK 的 `systemPromptSnapshot` 会把它固化成会话开头（地图陈旧后不会更新），需要决定是否关闭快照 |

**风险**：地图与 Claude Code 自有探索重复 → 无收益还烧上下文；地图过期而系统提示词快照不更新 → 误导；auto-dev 每次失败重试都会重放同一份地图（4s 构建预算 + 字符预算必须更省）。

**建议的实测方法（拍板前必需）**：挑 5~10 条历史任务（覆盖「找入口」「改一处调用方」两类），对同一任务跑 A/B——A=现状（不注入）、B=注入地图；比较回合数、token 用量、找错文件次数。若 B 没有稳定优势（或只有 map 类任务有），结论就是**不做**，把预算留给 openai 路径（那里地图是 0 → 1 的收益）。

**倾向**：先不做；待 T5 内部 benchmark 落地后，把「注不注入」作为一个可开关的实验项再测。

## 9. 与 90 天路线图的关系

本条 = 路线图「2. Repo map 服务」；后面的「3. Run 事件流 v2」「4. 内部 benchmark」「5. 策略引擎 + 容器」仍待排期。本方案不改 run 架构，是纯增量能力，可先行。

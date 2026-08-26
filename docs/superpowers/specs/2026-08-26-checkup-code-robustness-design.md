# 体检扩展为「项目代码健壮性」— 设计文档

- 日期：2026-08-26
- 范围：体检定位从「AI 协作配置健康度」扩展为「项目代码健壮性」。新增 `tests`（测试健康度）
  与 `hygiene`（仓库卫生）两个维度，重分配权重，并修掉实测暴露的扫描范围缺陷。
- 前置：`prompts` 口径矛盾、`SKIP_DIR` 三份不一致、`.worktrees` 匹配失效三项已修完（见 §0）。

## 0. 本次之前已完成的修复

| 项 | 修法 | 验证 |
|---|---|---|
| `prompts` 的「无提示词文件 = 满分且计入」 | `check-prompts.js` 在 cache 检查后早退判 `na`，与 `comments` 的 `sampled===0` 口径对齐 | 本仓库体检 **46 → 0 分**（虚高的 30 点权重消失） |
| 三个维度各持一份不一致的 `SKIP_DIR` | 抽出 `scan-dirs.logic.js`（`SKIP_DIR` + `shouldSkipDir(name,{skipHidden})`），三处接线；`check-map` 的「刻意不跳点目录以索引 `.claude/`」语义靠 `skipHidden` 参数保留 | 8 个新单测 + project-checkup 163 测试全绿 |
| `SKIP_DIR` 写 `'worktrees'` 而实际目录是 `'.worktrees'` | 两种写法都排除 | 同上 |
| 测试夹具被当真实配置评分 | `fixtures` / `__fixtures__` 加入排除 | 新增 fs 测试：夹具目录下的 CLAUDE.md 不再让 `prompts` 变成「有数据」 |

## 1. 实测新发现（本次必须一并处理）

### D1（必修）体检扫进了 `.gitignore` 的构建产物，同一问题重复计分

`comments` 维度实跑结果里，`app-paths.js:37` 被报了 **3 次**：

```
src/shared/app-paths.js:37                              ← 真实源码（git 追踪）
src-tauri/target/debug/sidecar/src/shared/app-paths.js  ← Rust 构建产物（已 gitignore）
src-tauri/resources/sidecar/src/shared/app-paths.js     ← 打包副本（已 gitignore）
```

后果有三重：用户看到 3 条一模一样的问题；`comments` 的分数公式
`100 - (findings/sampled)*MAX_DEDUCT` 两端同时被副本抬高、评分失真；**每个副本都被送进 LLM 判定，白烧额度**。

**修法：扫描改为「只看 git 追踪的文件」。** 项目自己的 `.gitignore` 就是「什么不是源码」的权威来源，
比手工维护 `SKIP_DIR` 列表准确且零维护——它能一次性覆盖 `target/`、打包副本以及未来任何构建输出。

```
gitTrackedFiles(projectDir) → string[] | null     // git ls-files；非 git 仓库返回 null
```

- 非 git 仓库（`git ls-files` 失败）→ 返回 `null`，**降级**为现有 `shouldSkipDir` 遍历，行为不变。
- `SKIP_DIR` 仍然保留且仍然生效：`fixtures` 是被 git 追踪的真实文件，只有它挡得住。
  两者是叠加关系，不是替代关系。
- 复用 `git-guard.js` 已有的执行范式：`execFile('git', [...], { cwd, windowsHide, maxBuffer })`，
  失败一律降级不抛。

**应用范围必须限定在「读取文件内容做分析」的两个维度（`comments`、`prompts`）。**

不动 `check-map.js` 的 `buildPathIndex`：它的语义是「地图里引用的这个路径在仓库里存不存在」，
一个被 gitignore 的目录**确实存在于磁盘上**。改用追踪清单会把这类引用误判成死链——
那是行为退化，不是修复。`check-map` 的 `scanDir`（mtime 统计）同理保持不变。

### D2（附带修）非法路径在 `optimize.json` 里留下垃圾条目

实测 `optimize.json` 里有一条 key 为 `C:UsersDELLDesktopclaude-p-web-demo`（反斜杠被吞掉的畸形路径）
的项目条目。成因：`acquireBusy(dir)` 先写持久化，`runStaticCheckup` 才校验目录存在性——
请求最终返回 400，但垃圾条目已经落盘。

**修法**：目录合法性校验前移到 `acquireBusy` 之前。顺带清掉已有的畸形条目。

### D3（可选调参，非 bug）`busy` 闸的陈旧阈值偏长

实测 `optimize.json` 里残留 `busy: { kind:'checkup', at:'…', jobId:null }`——上一次体检的
LLM 维度还在 `analyzing` 时进程被杀，闸没人释放。

**更正**：初稿把它写成「永久残留、无法自愈」是错的。`store/optimize.js:91` 已有 `isStale()`
陈旧接管，且在 `acquireBusy` 与 `getBusy` 两处都生效——残留会自动失效，不需要新增机制。

剩下的只是阈值问题：`BUSY_STALE_MS = 60 * 60 * 1000`（1 小时）。异常终止后用户要等最多
1 小时才能重新体检。LLM 维度实测最慢在分钟级，1 小时过于保守。

**可选改动**：降到 15 分钟。属调参而非修复，**优先级最低**，可以不做。

## 2. 新增维度

### 2.1 `tests` — 测试健康度

| 检查项 | 级别 | 判定 |
|---|---|---|
| **T1** 测试未全绿 | `error` | 执行项目测试命令，退出码非 0 |
| **T2** 超过 500 行的源文件无对应测试 | `info` | 每个文件一条 |
| **T3** 项目完全没有测试文件 | `warn` | 一条；与 T2 互斥（无测试文件时 T2 无意义） |

**T1 执行测试（用户拍板：默认开启）。** 这是体检里唯一会执行项目代码的检查项，
必须写死三重防护：

1. **超时 120s，且超时判 `partial` 而不是「失败」。**
   超时是「无法判断」，不是「测试红了」。混为一谈会让所有大项目永久不及格。
2. **占位 test 脚本必须识别为 `na`。**
   `npm init` 生成的默认脚本是 `echo "Error: no test specified" && exit 1`——
   不识别的话，**每个没写测试的项目都会被报成 error 级「测试失败」**，这是最容易踩的误报。
   判定：`package.json` 无 `scripts.test`，或其内容匹配 `no test specified` → 该项判 `na`。
3. **只读退出码，不解析输出。** 解析测试框架输出格式不通用且脆弱；退出码是唯一可靠信号。
   `maxBuffer` 设上限防输出爆内存。

T2 的阈值 **500 行**（用户拍板）。本仓库命中 6 个：`chat.js`(3343)、`req-view.js`(3303)、
`req-chat.js`(845)、`req-map.js`(768)、`lark.js`(618)、`markdown-tool.js`(614)。
配对规则沿用项目既有约定：`x.js` 的测试是 `x.test.js` 或 `x.logic.test.js`。

### 2.2 `hygiene` — 仓库卫生（落地现有 `deadcode` 槽位）

用户拍板把 `deadcode` 的 disabled 空槽重定义为 `hygiene`——语义相容（误入库的一次性脚本
就是无用代码），且不在面板上长期挂一个「即将支持」。

| 检查项 | 级别 | 判定 |
|---|---|---|
| **H1** 运行数据/日志被 git 追踪 | `warn` | `git ls-files` 命中 `*.jsonl` / `*.log`，排除 `fixtures` 下的 |
| **H2** 一次性脚本被 git 追踪 | `info` | **仅项目根目录**下前缀为 `tmp-` / `temp-` / `debug-` 的文件 |

H2 刻意收窄到「根目录 + 这三个前缀」：它们是临时文件的通用命名约定，零误报。
我实测发现的 `verify-css.mjs`、`brainstorm-visual.html` **不会**被这条规则命中——
`verify-*` 在别的项目里可能是正经的校验工具，为抓这两个文件放宽规则不值得。

## 3. 权重重分配

体检定位变了，权重要体现「代码健壮性」而非只有配置健康度：

| 维度 | 原 | 新 | 说明 |
|---|---|---|---|
| `map` | 35 | 25 | 仍是最高权重（影响每次开发的起步成本） |
| `prompts` | 30 | 20 | |
| `rules` | 15 | 10 | 一次性配置问题，权重最低 |
| `comments` | 20 | 15 | |
| `tests` | — | **20** | 测试是健壮性的核心信号 |
| `hygiene` | — | **10** | 问题明确但影响面小 |
| 合计 | 100 | 100 | |

`aggregateScore` 的既有语义不变：只有 `status==='done'` 且 `score` 是数字的维度参与加权，
其余按比例分摊权重。

## 4. 明确排除的检查项（不做，且记录理由）

用户要求「不要为了发现问题而发现问题，不要对项目做过度设计」。我整站检查发现的 9 项里，
以下 3 项**刻意不做成体检项**：

| 不做的项 | 理由 |
|---|---|
| 文档时效（根文档 N 天未更新） | 文档不改往往就是不需要改。做成检查项每次体检必亮红灯，是纯噪音 |
| 重复代码检测 | 我是逐行读代码看出 `review-log` 与另两个 JSONL store 语义同构的；通用实现需要相似度比对，假阳性率高 |
| 并发缺锁检测（「读全量+rename+无锁」启发式） | 判错代价高（把正常代码报成 bug）。它是一个具体 bug，值得直接修，不值得为它造检测器 |

其中 `store/review-log.js:52` 的 `compact()` 缺锁是**真实 bug**（跨进程压缩会吞掉对方追加的行，
`event-log.js:71-77` 用整段注释警告过这个场景），作为独立修复项处理：收敛到
`store/jsonl.js` 的 `compactJsonl`，顺带获得加锁保护。

## 5. UI 影响

前端**硬编码维度列表**：`public/js/optimize-view.logic.js:5` 的 `DIM_META` 是渲染的唯一来源
（`dimListFrom` 基于它 map，而非遍历 `report.dims`）。**新维度不加进 DIM_META 就完全不显示**，
即使后端已经产出数据。

需改两处：

```js
// public/js/optimize-view.logic.js
{ key: 'deadcode', label: '无用代码', hint: '即将支持' },
  ↓ 重定义
{ key: 'hygiene',  label: '仓库卫生', hint: '运行数据、临时脚本是否误入版本库' },
// 并新增
{ key: 'tests', label: '测试健康度', hint: '测试是否全绿、大文件是否缺测试' },
```

`deadcode` → `hygiene` 是**换 key**，不是改 label：`optimize.json` 里历史报告的
`dims.deadcode` 会成为孤儿数据。它原本恒为 `disabled`（无分数、无 issues），
丢弃无损失，不做迁移。

`DIM_META` 的顺序即面板展示顺序。建议 `tests` 紧随 `map` 之后（两者都是高权重的健壮性信号），
`hygiene` 排在末位。

## 6. 测试策略

| 目标 | 测试 |
|---|---|
| `gitTrackedFiles` | fs 测试：真实 git 仓库取到追踪清单；非 git 目录返回 `null` 触发降级 |
| T1 三重防护 | 占位 test 脚本 → `na`；退出码非 0 → `error`；超时 → `partial` 不是失败；无 `package.json` → `na` |
| T2 配对逻辑 | 纯函数：>500 行有测试/无测试；`.logic.test.js` 也算配对；≤500 行不报 |
| H1 / H2 | 纯函数：给定追踪清单 → 命中项；`fixtures` 下的 `.jsonl` 不报；非根目录的 `tmp-` 不报 |
| 权重重分配 | `score.logic.test.js` 更新：6 维度加权、部分 `na` 时按比例分摊 |
| `busy` 陈旧接管 | 构造超过阈值的 `busy` → 可被接管；未超过 → 仍然 409 |
| 回归 | project-checkup 现有 163 测试必须全绿 |

## 7. 切片

- **切片 1**：`review-log.js` 收敛到 `jsonl.js`（独立 bug 修，与新维度无依赖）
- **切片 2**：D1 扫描范围改为 git 追踪清单（修正现有维度的准确性，先于新维度）
- **切片 3**：D2（`optimize.json` 数据卫生：目录校验前移 + 清理畸形条目）。D3 降为可选调参，附在本切片末尾
- **切片 4**：`tests` 维度 + 权重重分配
- **切片 5**：`hygiene` 维度（落地 `deadcode` 槽位）+ 前端标题映射

## 8. 风险

1. **T1 默认开启会执行陌生项目的测试命令。** 已有三重防护，但对 `npm test` 会启 dev server
   或连数据库的项目，体检会挂到 120s 超时才返回。我在设计阶段建议过默认关闭，用户明确选择
   默认开启——记录在此，若实际使用中体检变慢，第一个该调的就是这个开关。
2. **改用 git 追踪清单会改变现有维度的扫描范围**，`comments` / `prompts` 的分数会变（变准）。
   历史 `llmCache` 的 fingerprint 会失效并触发重算，属预期。
3. **权重重分配会让所有项目的历史分数不可直接比较**。`optimize.json` 的 `history` 里存的是
   旧口径分数，趋势图会有一个台阶。可接受，不做数据迁移。

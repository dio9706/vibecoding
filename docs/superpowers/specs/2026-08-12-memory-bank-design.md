# 记忆库（Memory Bank）设计文档

> 2026-08-11 · 状态：待实现
> 关联：`2026-08-11-requirement-session-group-design.md`（优化汇总 / pitfalls —— 边界与共用基础设施见 §3）

## 1. 背景与目标

每天在 web 执行台和飞书 bot 里跟 Claude 干活，纠正、驳回、返工都发生过无数次，但这些信息随会话沉没。下一次对话，AI 依然不知道「注释要写中文」「大改前必须先问」「commit 用 `feat:` 前缀」。

**目标**：从已落盘的会话转录里持续提炼用户偏好，形成结构化的个人偏好库，并自动回喂给后续对话，使 AI「越用越懂我」；同时该库可整体导出，作为未来「数字分身」的输入。

**非目标**（第一版明确不做，见 §16）：团队协作、实时埋点、数字分身对接。

**成败判据**：注入生效后，用户对同类问题的重复纠正次数下降。若做不到这一点，本功能只是一份漂亮的日志摘要。

## 2. 用户拍板记录

| 议题 | 决策 |
|------|------|
| 核心用途 | **自动注入为主，可导出为辅**。资产必须回喂进对话形成飞轮，导出是附加约束 |
| 内核形态 | **中性结构化 JSON 为唯一真相源**，Markdown 只是渲染目标之一。为「数字分身」预留 |
| 分类与处置 | 注入组＝代码风格 / 协作习惯 / 写作习惯；仅记录组＝对话风格 / 技术偏好。差别只是条目上一个 `inject` 字段 |
| 晋升机制 | **B+C 混合**：未达阈值 → 候选列表等人工确认；达阈值 → 自动晋升生效 **+ 红点提醒**（可事后否掉） |
| 提炼时机 | **定时批量**，不做会话结束即跑。跨会话合并证据，天然支持阈值计数 |
| 调度窗口 | ①额度重置前 30 分钟且额度正常（用本要作废的额度）②凌晨 3:00–8:00（起止可配）。①不可用时静默降级为② |
| 成本控制 | **两级过滤**：零成本规则预筛出高信号片段 → LLM 只吃片段，不吃全文 |
| 落盘方式 | 独立文件 `.claude/memory-bank.md` + `CLAUDE.md` 追加 `@` 引用行。**绝不改写用户手写内容**（对齐 pitfalls 范式，§9.2） |
| 作用域 | 条目带 `scope`：`global` → `~/.claude/`；`project` → 工程目录 |
| 注入预算 | 默认 40 条 / 3000 字符封顶，超出按排序截断，**被截断者必须在面板显式提示** |
| 冲突与失效 | 冲突不自动覆盖，标记后由用户裁决；90 天无新证据降级 `dormant`（停注入但保留数据）；用户否掉的进黑名单永不复活 |

## 3. 与「优化汇总 / pitfalls」的边界

两者都读会话转录、都用 LLM 提炼、都写 `.claude/*.md`，必须划清，否则重复建设。

| 维度 | 优化汇总 → `pitfalls.md` | 记忆库 → `memory-bank.md` |
|------|--------------------------|---------------------------|
| 提炼对象 | **AI 犯过的错**（避坑清单） | **人的偏好**（我是怎样的开发者） |
| 触发 | 需求归档时，用户点按钮 | 定时批量，无人值守 |
| 范围 | 单个需求下的会话组 | 全部会话，跨需求跨时间 |
| 作用域 | 工程项目级 | 个人级（含 `scope=project` 的项目特化条目） |
| 生命周期 | 一次性写入，人工维护 | 有状态机：候选→生效→休眠 |

**共用基础设施（本 spec 负责抽出，pitfalls 侧改为复用）**：

- `src/shared/claude-md.js` —— `CLAUDE.md` 的 `@` 引用行幂等挂接。两个功能都要往 `CLAUDE.md` 追加引用行，逻辑完全一致（已有引用→不动；无→追加；无 `CLAUDE.md`→创建）。抽成一处，避免两份实现对同一文件并发追加时互相覆盖。
- `src/store/transcript.js` —— 按 sessionId / cwd 读取 `~/.claude/projects/<encode(cwd)>/<sessionId>.jsonl` 并解析为事件数组。`src/store/history.js` 已有目录定位与 JSONL 解析能力，抽出可复用部分，不新写一套。

**若 pitfalls 尚未实现**：本 spec 先建这两个共用模块，pitfalls 实现时直接用。

## 4. 架构总览

```
 ~/.claude/projects/**/*.jsonl        ← 已有数据，零改造
   │
   ├─[游标扫描] 只读 mtime > lastScannedAt 的会话
   ↓
 prefilter.js（纯函数，零成本）
   │  规则捞高信号片段：纠正措辞 / 显式指令 / 驳回 / 返工
   ↓  一次会话数百条消息 → 通常剩 3–5 段
 extract.js（LLM，复用 runClassifierOnce）
   │  片段 → 候选条目 JSON（category / scope / statement / evidence）
   ↓
 promote.js（纯函数，状态机）
   │  与既有条目合并去重 → evidenceCount 累加 → 冲突检测 → 阈值判定
   ↓
 memory-bank.json（唯一真相源，走 store/index.js 文件锁）
   │
   ├─→ render.js → .claude/memory-bank.md ──→ CLAUDE.md @引用 ──→ 注入
   ├─→ 导出包 JSON（全量五类，数字分身用）
   └─→ 前端面板（候选确认 / 红点 / 编辑 / 手动提炼）
```

模块落点（纯函数与 IO 分离，沿用 `req-logic.js` / `req-pitfalls.js` 的先例）：

| 文件 | 职责 | 可单测 |
|------|------|:---:|
| `src/features/memory-bank/prefilter.js` | 事件数组 → 高信号片段 | ✅ |
| `src/features/memory-bank/extract.js` | 片段 → 候选条目（LLM 调用） | ❌ |
| `src/features/memory-bank/promote.js` | 条目合并 / 晋升 / 冲突 / 失效状态机 | ✅ |
| `src/features/memory-bank/render.js` | 条目 → Markdown（含预算截断） | ✅ |
| `src/features/memory-bank/schedule.js` | 给定 now / settings / token 状态 → 是否该跑 | ✅ |
| `src/features/memory-bank/index.js` | 胶水：定时 tick、跑一轮、写盘、挂接 CLAUDE.md | ❌ |
| `src/store/memory-bank.js` | `memory-bank.json` 读写 | ✅ |
| `src/entrypoints/web/routes-memory.js` | `/api/memory/*` | ✅ |
| `public/js/memory-view.js` | 面板 | ❌ |

## 5. 数据模型

### 5.1 `memory-bank.json`

```js
{
  version: 1,
  lastScannedAt: 0,          // epoch ms，扫描游标（按 JSONL mtime）
  lastExtractAt: 0,          // 上次成功提炼时刻，防重复跑
  items: [ /* 见 5.2 */ ],
  blacklist: [               // 用户否掉的，永不复活
    { fingerprint: 'code-style:注释语言', statement: '...', rejectedAt: 0 }
  ]
}
```

### 5.2 条目结构

```js
{
  id: 'mem_20260811_a1b2',
  category: 'code-style' | 'collaboration' | 'writing' | 'dialogue' | 'tech-pref',
  scope: 'global' | 'project',
  projectDir: '',            // scope==='project' 时的工程绝对路径，否则空
  statement: '代码注释写中文，只解释「为什么」，不复述「做了什么」',
  fingerprint: 'code-style:注释语言',  // 语义键，用于跨轮合并与黑名单比对（§8.1）

  status: 'candidate' | 'active' | 'dormant' | 'conflict',
  inject: true,              // 是否参与注入。由 category 决定默认值，用户可改
  source: 'explicit' | 'inferred',   // 显式指令 vs 推断（权重不同，§8.2）

  evidenceCount: 3,
  evidenceSessions: ['sess-a', 'sess-b', 'sess-c'],  // 去重后的 sessionId
  evidence: [                // 最多保留 5 条，超出丢最旧（防膨胀）
    { sessionId, at, quote, kind: 'correction' | 'explicit' | 'denial' | 'rework' }
  ],

  promotedBy: 'auto' | 'manual' | null,
  acked: true,               // 自动晋升后是否已读 —— 红点数据源
  conflictWith: null,        // 冲突对方 id

  createdAt, updatedAt, lastSeenAt,
}
```

**`inject` 的默认值由 category 决定**（`code-style` / `collaboration` / `writing` → `true`；`dialogue` / `tech-pref` → `false`）。仅记录组照常提炼、照常计数、照常导出，只是不渲染进 Markdown —— 成本几乎为零，且用户可随时手动开启。

**证据必须留 `quote`**。没有原话，用户无法判断这条是不是 LLM 编的，整个人工确认环节就失去意义。

## 6. 采集与预筛（零成本规则层）

`prefilter.js` 纯函数，输入一次会话的事件数组，输出片段列表。**这是成本控制的关键**：一次会话数百条消息，全喂 LLM 每天要烧掉可观额度；预筛后通常只剩 3–5 段。

捕获的信号（按价值降序）：

| kind | 识别规则 | 为什么高价值 |
|------|----------|--------------|
| `explicit` | 用户消息含「记住」「以后」「每次」「都要」「不许」「下次」 | **显式偏好声明**，几乎不会误判 |
| `correction` | 用户消息含否定/纠正措辞：不对、不是、别、不要、应该、改成、重来、错了、回退、我说过 | 高浓度信号，紧邻的上下文就是被纠正的行为 |
| `denial` | 权限审批被拒绝（`runs.js` 的 deny 决策 / `review-log.js`） | 用户用行动表达的边界 |
| `rework` | 同一文件在短窗口内被 Edit/Write ≥3 次 | 反复返工＝AI 没摸对路子 |

每个片段携带**触发消息 + 前后各 2 条消息**作为上下文（纠正的价值在于「纠正了什么」，孤立一句「不对」毫无信息量）。

**片段上限**：单次提炼最多取 N 段（默认 30），按 kind 优先级排序后截断，并 log 丢弃数量。宁可这轮少提炼，不可一次撑爆预算。

## 7. 提炼器（LLM 层）

复用 `src/features/llm-classify.js` 的 `runClassifierOnce` —— 它已封装本场景需要的全部防护：

- **额度耗尽 fail-fast**（`isPoolExhausted` 早退，不发注定失败的调用）
- 30s 超时 + abort 双保险
- 单轮禁全部工具（防分类模型把内容当真任务执行）
- 首个 JSON 块提取

模型走便宜档（设置项 `memoryBank.model`，缺省与现有分类点一致）。

**Prompt 契约**（片段 → 候选条目数组）：

```
输入：若干高信号对话片段（含 kind 标注与上下文）
输出：JSON { items: [{ category, scope, statement, fingerprint, source, quote }] }

约束（写进 prompt）：
- statement 必须是可执行的具体规则，禁止「用户喜欢清晰的代码」这类无操作性的空话
- 提炼不出确定偏好时返回空数组，宁缺毋滥
- quote 必须逐字来自输入片段，不得改写
- scope：规则只对某工程成立 → project，跨工程通用 → global
```

解析失败 / 超时 / 返回 null → 本轮静默跳过，不推进 `lastScannedAt` 游标（下轮重试）。

## 8. 状态机（`promote.js`，纯函数）

### 8.1 合并去重

新条目按 `fingerprint` 与既有条目比对：

- 命中 `blacklist` → **直接丢弃**（用户否过的不再骚扰）
- 命中既有条目 → `evidenceCount++`、`evidenceSessions` 并集、`evidence` 追加（保留最近 5）、`lastSeenAt` 更新；`statement` **不覆盖**（用户可能已编辑过）
- 未命中 → 新建，`status='candidate'`

### 8.2 晋升阈值

```
自动晋升条件：evidenceCount >= 3 且 evidenceSessions.length >= 2
显式偏好例外：source==='explicit' 时，evidenceCount >= 1 即晋升
```

**「≥2 个不同 session」这条约束是必须的**：否则用户在一次会话里因为 AI 反复犯错而连说三遍「别加注释」，会被当成三份独立证据。同一次会话里的重复是同一个事件。

显式偏好走例外通道：用户直说「以后都用 ESM」时，还要等他说三次才生效是荒谬的。

晋升时置 `status='active'`、`promotedBy='auto'`、**`acked=false`**（红点数据源）。

### 8.3 冲突检测

新条目与既有 `active` 条目 `fingerprint` 相同但 `statement` 语义相反时（由提炼器在输出中标注 `contradicts` 字段，或 fingerprint 同 + statement 显著不同），**不自动覆盖**：

- 两条都置 `status='conflict'`，互填 `conflictWith`
- 冲突条目**暂停注入**（宁可没有规则，不可有错误规则）
- 面板红点提醒，用户二选一或改写

人是会变的，去年的偏好今年可能正好相反 —— 静默覆盖和静默保留都是错的，只能让人裁决。

### 8.4 失效

`lastSeenAt` 超过 90 天（可配）→ `status='dormant'`：停止注入，**但保留全部数据**（导出与数字分身仍需要）。若之后又出现新证据 → 复活为 `active`。

## 9. 渲染与注入

### 9.1 Markdown 渲染（`render.js`）

按 `scope` 分两份产出：

| scope | Markdown 落点 | 挂接的 CLAUDE.md | 引用行 |
|-------|---------------|------------------|--------|
| `global` | `~/.claude/memory-bank.md` | `~/.claude/CLAUDE.md` | `@memory-bank.md` |
| `project` | `<projectDir>/.claude/memory-bank.md` | `<projectDir>/CLAUDE.md` | `@.claude/memory-bank.md` |

（全局侧 `~/.claude/` 本身已是配置目录，不再嵌套一层 `.claude/`，故引用行路径不同。）

只渲染 `status==='active' && inject===true` 的条目，按 category 分节：

```markdown
<!-- 由记忆库自动生成，勿手工编辑；改动请在执行台「记忆库」面板操作 -->

## 代码风格
- 代码注释写中文，只解释「为什么」，不复述「做了什么」
- 单文件超过 300 行即考虑拆分

## 协作习惯
- 大范围重构前先给方案，等我拍板再动手
- 不要自动 git commit，提交时机由我掌控
```

**预算截断**：默认 40 条 / 3000 字符。超出时按 `source==='explicit'` 优先 → 权重降序 → 截断。权重为**运行时计算、不落盘**的合成值：`evidenceCount` 越高、`lastSeenAt` 越近则越高（避免又一个需要维护一致性的持久化字段）。被截断的条目数写入渲染结果元信息，**面板必须显式展示「N 条因预算未注入」**。静默丢弃会让用户以为规则生效了，实际没有 —— 这是最难排查的一类问题。

**空串语义**：某 scope 无任何可注入条目时，`renderMarkdown` 返回 `text: ''`。调用方（`index.js` 的 `writeRenders`）**必须把对应的 `memory-bank.md` 写成空文件，不能跳过写盘**——否则用户在面板上否掉最后一条条目后，磁盘上的旧文件原封不动，`CLAUDE.md` 的 `@` 引用继续生效，刚被否掉的规则会在此后每一轮对话里静默地照常注入，且用户完全无法察觉。（项目级 scope 例外：若该工程从未生成过 `memory-bank.md`，允许跳过，避免凭空造一个空文件；一旦文件已存在，同样必须写空。）

### 9.2 CLAUDE.md 挂接（`src/shared/claude-md.js`）

首次写入 `memory-bank.md` 时，检查同级 `CLAUDE.md`：

- 已含 `@.claude/memory-bank.md` 引用行 → 不动
- 无引用 → **追加**一行
- 无 `CLAUDE.md` → 创建，仅含该引用行

**块外内容一个字都不碰。** 用户全局 `CLAUDE.md` 现有「Always respond in Chinese-simplified」等手写内容必须原样保留。该模块与 pitfalls 共用（§3），实现时需注意两个功能可能并发追加，走 `store/index.js` 同款文件锁。

### 9.3 注入路径（单一路径，已由探针 §14-b 定案）

**唯一路径：文件。** `CLAUDE.md` 的 `@` 引用被 Claude Code 原生加载，web / 飞书 / 终端三个入口全覆盖，零注入代码、零 token 额外开销。

依据：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1866-1870` —— *"When omitted, all sources are loaded (matches CLI defaults). Must include `'project'` to load CLAUDE.md files."*，而 `src/integrations/claude.js:144` 未传 `settingSources`，故 SDK 会话已按 CLI 默认加载 CLAUDE.md。

**明确禁止**在 `run-claude.js` 做显式 `systemPrompt` 注入 —— 那会让同一份规则进两次上下文。若将来有人给 `claude.js` 加上 `settingSources: []`（SDK 隔离模式），本功能会静默失效，需同步调整；已在 §15 加一条防回归测试。

## 10. 调度（`schedule.js` 纯函数 + `index.js` tick）

web 入口启动时挂一个 10 分钟 tick，每次调用 `shouldRun(now, settings, tokenState, activeRuns, lastExtractAt)`：

**共同前置条件**（全部满足才继续）：

- 功能开关 `memoryBank.enabled === true`
- 当前**无活跃 run**（`store/active-runs.js`）—— 绝不跟用户抢额度
- `now - lastExtractAt > minIntervalHours`（默认 6h）
- 该 provider（提炼实际用的 `claude-agent`，即 `DEFAULT_PROVIDER_ID`）下的 token 池非全耗尽

**触发窗口（任一命中）**：

| 窗口 | 条件 |
|------|------|
| ①窗口末尾（首选） | `windowResetsAt - now < 30min`，且该 provider 的活动 token 优先取 `status==='healthy'`、退而取 `status==='warning'` |
| ②凌晨（保底） | 本地时间落在 `[nightStart, nightEnd]`，默认 `03:00`–`08:00`，设置页可配 |

**选号与耗尽判定均对齐 `src/features/token-rotation.js` 的既有 token 语义**（而非只认 `healthy`）：

- **选号先按 `providerId` 过滤，再 `healthy` 优先、退而取 `warning`**（与 `pickActive` 一致）。`getTokens()` 返回的是跨 provider 混放的全量池，不按 `providerId` 过滤会拿到别的 provider（如 `openai-compat`）的窗口重置时刻来判断 `claude-agent` 该不该跑。`warning` 状态意味着该号额度利用率已经很高、马上要作废——这恰恰是窗口①设计意图里**最该跑**的时刻，只认 `healthy` 会让功能在最该生效的时刻反而失效。
- **耗尽判定同样先按 `providerId` 过滤**（对齐 `isPoolExhausted`）：只看该 provider 下是否还有 `healthy`/`warning` 的号，不能被别的 provider 的健康状态掩盖。否则 `claude-agent` 池全耗尽时仍会被判定为可跑，一旦放行到 `claudeAuthOpts()` 该 provider 无可用号会返回 `{}`，最终无人值守地回落到烧用户主账号额度。

**`windowResetsAt` 是新字段**（§14-a）：`src/features/token-rotation.js:45-49` 在 `status==='allowed'` 时把 `resetsAt` 清成 `null`，导致「额度正常」与「知道何时重置」互斥。需在 `allowed` 分支额外记录 `windowResetsAt` 且**不随状态清空**。语义上它与 `resetsAt` 不同：后者是「被限流后何时解禁」，前者是「当前计费窗口何时结束」，分开字段比复用更清晰。

**降级**：若探针证实 SDK 在 `allowed` 状态不提供重置时刻，窗口①静默失效，只跑窗口②。功能不残废，只是省得没那么极致。

## 11. 导出

`GET /api/memory/export?format=json|md`

```json
{
  "schema": "memory-bank/v1",
  "exportedAt": "2026-08-11T12:00:00Z",
  "stats": { "total": 42, "active": 30, "byCategory": { "code-style": 12 } },
  "items": [ /* 全量五类，含 dormant 与 candidate，含完整 evidence */ ]
}
```

导出**含仅记录组与证据链** —— 这正是为数字分身准备的原料，注入时用不上不代表导出时不要。`format=md` 输出人类可读的完整档案（含仅记录组），区别于注入用的精简版。

## 12. 前端面板

侧栏新增「记忆库」入口，沿用既有 `showView(name)` 内嵌面板范式（`panel-page`），不做新弹层。

- **入口带红点角标**：`items.filter(i => i.status==='active' && !i.acked).length` + 冲突数
- **三个分区**：待确认（candidate）／ 已生效（active，新晋升的高亮）／ 休眠+已否（折叠）
- **每条展示**：statement、category、scope、证据数、**可展开看原话 quote 与来源会话**
- **操作**：✓ 确认 · ✗ 否掉（进黑名单）· ✎ 编辑 statement/category/scope/inject
- **顶部提示**：「N 条因预算未注入」（§9.1）
- **按钮**：立即提炼（手动补跑）· 导出

## 13. API 契约

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/memory/list` | `{ items, unackedCount, conflictCount, budget:{used,total,truncated} }` |
| POST | `/api/memory/confirm` | `{ id, statement?, category?, scope?, inject? }` → 置 `active` + `promotedBy:'manual'`，重渲染 |
| POST | `/api/memory/reject` | `{ id }` → 移出 items，`fingerprint` 入 blacklist，重渲染 |
| POST | `/api/memory/ack` | `{ id }` 或 `{ all:true }` → 清红点 |
| POST | `/api/memory/extract` | 手动触发一轮，`202` 立即返回，前端轮询 list |
| GET | `/api/memory/export` | `?format=json\|md` |

设置项并入既有 `settings.json`（新增 `memoryBank` 段：`enabled` / `nightStart` / `nightEnd` / `model` / `threshold` / `budget` / `dormantDays`），走现有 `/api/settings`，不另开接口。

## 14. 探针结论（三项均已实测，2026-08-11）

**a. `rate_limit_info` 在 `allowed` 状态带 `resetsAt` —— ✅ 窗口①可行**

`logs/` 中 452 条限流事件实证，`status:'allowed'` 时字段完整：

```
{"status":"allowed","resetsAt":1785412800,"rateLimitType":"five_hour",
 "overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false}
```

`resetsAt` 为 epoch 秒，`rateLimitType:'five_hour'` 表明是 5 小时滚动窗口。数据一直都在，只是 `reduceRateLimit` 的 `allowed` 分支把它丢了。**结论：只需在该分支加一行保留到 `windowResetsAt`。**

**b. Agent SDK 自动加载 `CLAUDE.md` —— ✅ 无需显式注入**

`sdk.d.ts:1866-1870`：*"When omitted, all sources are loaded (matches CLI defaults). Must include `'project'` to load CLAUDE.md files."*；`src/integrations/claude.js:144` 未传 `settingSources`。**结论：§9.3 收敛为单一文件路径，禁止显式注入。**

**c. JSONL 事件结构 —— ✅ 识别规则已确定**

实读转录确认（顶层 `type` + `message.content` 块类型）：

| 目标 | 判定 |
|------|------|
| 真用户消息 | `type==='user'` 且 `message.content` 为字符串，或块数组中含 `type==='text'` |
| 工具结果 | `type==='user'` 且 `content[0].type==='tool_result'`（**不是独立 type**），`is_error` 标失败，`tool_use_id` 关联 |
| 工具调用 | `type==='assistant'` 且块 `type==='tool_use'`，带 `name` / `input` |
| 助手文本 | `type==='assistant'` 且块 `type==='text'` |

共有字段：`uuid` / `parentUuid` / `timestamp` / `sessionId` / `cwd` / `gitBranch`。

**关键含义**：工具结果伪装成 `type==='user'`，`prefilter.js` **必须先排除 `tool_result` 才能识别真用户消息**，否则会把工具输出当成用户发言去提炼偏好 —— 这是本功能最容易写错的一处。

## 15. 测试策略

单测（`node --test`，沿用项目现有范式）：

- `prefilter.test.js`：构造事件数组，验证四类信号识别、上下文窗口、片段上限截断
- `promote.test.js`：**重点** —— 同会话重复不累计跨会话计数、显式偏好单证据晋升、黑名单拦截、冲突置位不覆盖、dormant 降级与复活
- `render.test.js`：分类分节、预算截断顺序、`inject:false` 不渲染、截断数上报
- `schedule.test.js`：两窗口命中/不命中、活跃 run 时不跑、`windowResetsAt` 缺失时降级
- `claude-md.test.js`：已有引用不重复追加、无文件则创建、**手写内容原样保留**
- **防回归**：断言 `src/integrations/claude.js` 未设置 `settingSources`（§9.3 的注入前提）。若有人加上 `settingSources: []`，本功能会静默失效而无任何报错 —— 必须让测试先红

不测 LLM 提炼质量（不可确定性），但 `extract.js` 的 JSON 解析失败路径要测。

## 16. 不做（YAGNI）

- **多人 / 团队偏好汇总** —— 单人版跑通再说
- **实时埋点** —— 继续离线扫 JSONL，不侵入执行链路
- **数字分身对接** —— 只保证导出格式够用
- **执行链路改造** —— 全部改动限于：`token-rotation.js` 加一个字段、`run-claude.js` 可能加注入点（视探针 b）
- **偏好的自动 A/B 效果验证** —— 想过，但需要长期数据，第一版靠人工体感
- **git diff / commit 历史作为证据源** —— 第一版只用会话转录，成本可控

## 17. 验收清单

1. 定时窗口内自动跑完一轮，日志可见片段数与产出条目数，**用户无感知**（不抢额度、不打断）
2. 候选条目在面板可见，展开能看到**逐字原话**与来源会话
3. 同一偏好在 2 个以上会话出现 3 次 → 自动晋升，侧栏出现红点
4. 用户显式说「以后都要 X」→ 单次即晋升
5. 用户否掉的条目，后续轮次不再出现
6. `~/.claude/CLAUDE.md` 中手写内容**逐字未变**，仅新增一行 `@.claude/memory-bank.md`
7. `memory-bank.md` 只含注入组三类，`dialogue` / `tech-pref` 不出现
8. 超预算时面板显示「N 条因预算未注入」
9. 导出 JSON 含全部五类与证据链
10. 手动「立即提炼」可用，额度耗尽时 fail-fast 不卡死
11. 新对话中 AI 行为体现已生效偏好（真机走查）

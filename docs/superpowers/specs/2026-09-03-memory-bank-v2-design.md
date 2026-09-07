---
title: 记忆库 v2：两阶段会话分析与真实记忆生成
date: 2026-09-03
status: draft
---

# 记忆库 v2：两阶段会话分析与真实记忆生成

## 概述

将现有记忆库从"个人措辞偏好提炼"重构为"开发知识积累"系统。旧管线基于用户自己打的字（`user-log`），新管线基于完整会话转录（包含助手回复、工具调用、纠错来回）。通过两阶段流水线——**逐条分析会话** → **总结生成真实记忆**，自动从开发过程中提炼易错点、反复问题、解决方案与项目偏好，显化在面板中供人工审视，最终记入 CLAUDE.md 让后续对话生效。

## 数据流与核心变化

### 旧管线（已退役）

```
user-log（用户打的字）
  ↓ 按字节偏移游标读取
prefilter → extract（LLM） → promote（证据累计/晋升）
  ↓ 条件：同一话题 ≥3 条证据 ≥2 个会话
→ items（自动注入）
```

痛点：
- 用户高价值偏好（决策、约束、期望）以陈述句形式出现，不带纠正措辞，正则无法捞出
- 只见用户一方，看不到 AI 走偏之处，无法提炼"易错点"和"解决方案"
- 证据晋升需跨会话重复，一次性的高价值信号（如"这条规则以后记住"）却要等很久

### 新管线

```
会话转录（~/.claude/projects/**/*.jsonl）
  ↓ Phase 1：逐条分析未分析会话
  findings[]
    · [易错点] ...
    · [解决方案] ...
    · [反复问题] ...
    · [偏好] ...
  ↓ 显化在面板：用户可展开每个会话查看
  ↓ Phase 2：一批完成后总结
  all_findings + existing_memories
  ↓ LLM 去重/归并/泛化
  → memories[]（支持手工移除）
  → 注入 CLAUDE.md
```

优点：
- 完整的对话上下文，模型能看到问题、AI 错误、用户纠正的完整过程
- 一次分析即产出，不必等多个会话重复
- 显化中间步骤（findings），用户可及时调整或确认
- 最终记忆支持手工审查与移除，零误伤

---

## 架构设计

### 1. 数据模型（memory-bank.json v2）

```javascript
{
  version: 2,
  lastExtractAt: 0,                    // 上次 Phase 1/2 完成时刻
  // 会话扫描游标
  lastSessionScanAt: 0,                // 上次扫描 ~/.claude/projects 的时刻
  // 已分析会话索引（防重复）
  sessions: [
    {
      id: "mem_session_20260903_abc123",  // 会话唯一标识（日期+随机）
      path: "~/.claude/projects/xxx/xxx.jsonl",  // 文件路径
      mtime: 1725355200000,              // 文件修改时间，判重与变更检测
      title: "记忆库重构讨论",            // 首条用户消息截断（≤100 字）
      analyzedAt: 1725355200000,
      findings: [
        {
          type: "bug|solution|pattern|preference",
          text: "飞书长连接断线不触发 onClose，导致漂流连接堆积",
          context: "发生于……的会话中",
          quote: "..."                  // 原文引用片段
        }
      ]
    }
  ],
  // 最终记忆（真相源）
  memories: [
    {
      id: "mem_20260903_a",
      statement: "改 schedule 前先看配套 .test.js，否则纯函数判定可测性被破坏",
      category: "collaboration",
      createdAt: 1725355200000,
      fromFindings: [                   // 溯源：来自哪些 findings
        "mem_session_20260903_abc123",
        "mem_session_20260903_def456"
      ]
    }
  ]
}
```

**关键变化**：
- 去掉 `items` / `blacklist` / `userLogOffset` / `lastScannedAt`
- `sessions` 用作中间产物缓存与去重；不在 sessions 里的旧会话，但其对应的 .jsonl 被删除，下次扫描无需处理
- `memories` 是最终唯一出口，字段精简：仅 `statement` + `category` + 溯源链

---

### 2. Phase 1：逐条会话分析

#### 输入
- 未分析会话列表（通过对比 `sessions[].path` + `mtime` 与当前文件系统）
- 一轮最多 10 个会话（防首次启用烧穿额度）

#### 处理流程

**2.1 会话转录读取**  
调用 `store/transcript.js` 的 `readTranscriptEvents(path)`，返回原始事件数组。

**2.2 内容清洗**  
```js
events
  ↓ 过滤 tool_use / tool_result / 系统消息
  ↓ 保留用户消息 + 助手消息（完整文本）
  ↓ 去空行、截断过长消息（>2000 字按省略号提示）
  → cleaned_messages[]
```

**2.3 LLM 分析**  
调用单次 LLM（复用 `runClassifierOnce`），系统 prompt：

```
你是开发知识提炼器。输入是一段完整的开发对话（用户 + AI 来回）。
分析并输出 JSON，形如：

{
  "findings": [
    {
      "type": "bug|solution|pattern|preference",
      "text": "...",
      "context": "..."
    }
  ]
}

四种类型定义：
- bug：开发过程中遇到的坑或问题（含复现条件、错误现象）
- solution：用来解决 bug 的方法或技巧
- pattern：反复出现或容易出错的场景模式
- preference：用户对工具流程/代码风格/协作方式的稳定表达

每条 finding 必须满足：
1. 可在对话中逐字找到原文支撑（引用准确）
2. 足够具体，不是"喜欢清晰代码"这样的空话
3. 不混淆"这一次任务指令"和"跨工程适用规则"
   判据：换个工程、同样的规则还成立吗？

findings 找不到就返回 []，绝不凑数。
```

**2.4 产出归一**  
```js
sanitizeFindings(json) {
  // 检查 type 合法性
  // quote 必须逐字来自 cleaned_messages
  // 去掉超长消息（>500字）
  // 返回格式一致的数组或错误
}
```

#### 输出
```js
{
  session: {
    id, path, mtime, title, analyzedAt,
    findings: [...]
  },
  cursor: offset                    // 本轮已消费到哪
}
```

---

### 3. Phase 2：批量总结生成真实记忆

#### 触发条件
- 仅在 Phase 1 产出了新 findings 时才跑
- 一轮 Phase 1 完成后立即检查是否需要 Phase 2

#### 输入
```js
{
  newFindings: [{type, text, context}],   // 本轮新增
  existingMemories: [...]                  // 已有记忆
}
```

#### 处理流程

**3.1 去重与分组**  
LLM 接收：`newFindings + existingMemories`，任务：

```
输入是本次新提炼的发现与已有的记忆。

分析并产出修正后的 JSON：

{
  "memories": [
    {
      "statement": "改 schedule 前先看配套 .test.js…",
      "category": "collaboration",
      "merged_from": ["finding_id_1", "finding_id_2"]
    }
  ],
  "unused_findings": ["finding_id_3"],  // 本批没入选的（太细碎或一次性任务）
  "notes": "..."
}

指导原则：
1. 同一主题重复出现的 findings → 单一 memory，statement 泛化
2. 与既有 memory 内容冲突时，置信度高的赢（显式说法 > 推断；跨会话 > 单次）
3. 宁缺毋滥：单次任务指令、临时方案、工具 bug 描述，都不算 memory
4. 每条 statement 必须是可执行的规则，不是抽象描述

category 分类：
  collaboration：怎么和 AI 配合
  code-style：代码怎么写
  writing：怎么写字
  dialogue：对话风格
  tech-pref：技术选型倾向
```

**3.2 产出归一**  
```js
synthesizeMemories(json) {
  // 校验 category 合法
  // statement 去重与长度检查（≤200 字）
  // 保留 merged_from 溯源链
  // 返回新增 memories 数组
}
```

#### 输出
```js
{
  newMemories: [...],      // 本轮新增或修改的
  injectReady: true        // 是否已准备好注入 CLAUDE.md
}
```

---

### 4. 注入与渲染

**4.1 选择入选条目**  
```js
selectForInjection(memories, {maxItems=40, maxChars=3000})
  // 按 category 分节
  // 排序（保留最新且证据多的）
  // 截断到预算内
```

**4.2 渲染 Markdown**  
```markdown
<!-- 由记忆库自动生成，勿手工编辑；改动请在执行台「记忆库」面板操作 -->

## 协作习惯
- 改 schedule 前先看配套 .test.js，否则纯函数判定可测性被破坏
- 大范围重构前先出方案，等我拍板再动手

## 代码风格
- 注释写中文，只解释「为什么」，不复述「做了什么」
```

**4.3 落盘与挂接**  
- 全局：`~/.claude/memory-bank.md` + `~/.claude/CLAUDE.md` 挂 `@memory-bank.md`
- 项目级：`<projectDir>/.claude/memory-bank.md` + `CLAUDE.md` 挂 `@.claude/memory-bank.md`

---

## 调度

### 窗口判定

沿用现有 `shouldRun`（`src/features/memory-bank/schedule.js`），无改动。

### Phase 1 节流

```js
MAX_SESSIONS_PER_RUN = 10

runPhase1() {
  const unanalyzed = scanForUnanalyzedSessions();
  const batch = unanalyzed.slice(0, MAX_SESSIONS_PER_RUN);
  for (const session of batch) {
    const findings = analyzeSession(session);
    saveSessionWithFindings(session, findings);
  }
  return batch.length;
}
```

首次启用时有约 236 个会话，约 24 轮分析完毕。

### Phase 2 触发

```js
runOnce() {
  const batchSize = await runPhase1();
  if (batchSize > 0 || hasUnmergeable Findings) {
    await runPhase2();
  }
}
```

---

## UI 设计

### 侧栏

- 红点角标：未移除的 memories 数量（仅展示新增，打开面板即清 acked）

### 面板布局

```
┌─ 记忆库 ──────────────────────────────────────────┐
│                                                      │
│  开启闲时提炼  [●──]                                 │
│               凌晨 3:00 ~ 8:00 自动分析本地会话      │
│                                            [ 立即提炼 ]│
├──────────────────────────────────────────────────────┤
│ 真实记忆 (3 条)                                       │
│                                                      │
│  • 改 schedule 前先看 .test.js       [移 除]        │
│  • vendor 不手改，走 sync:vendor     [移 除]        │
│  • 游标字节偏移不可复用……           [移 除]        │
│                                                      │
├──────────────────────────────────────────────────────┤
│ 会话 (28 待分析 / 208 已分析)                         │
│                                                      │
│  ▸ 记忆库重构讨论         待分析                    │
│  ▸ project-map 调试       待分析                    │
│                                                      │
│  ▾ feishu-relay 实现      已分析  3 个发现  ▾       │
│    · [易错点] 飞书长连接断线不触发 onClose          │
│    · [解决方案] 用心跳包 + 重连间隔指数退避         │
│    · [偏好] 飞书通知失败降级纯文本不抛错            │
│                                                      │
│  ▾ 会话历史记忆库讨论     已分析  1 个发现  ▾       │
│    · [反复问题] 每次开新项目都要……                  │
│                                                      │
│ ⚙ 设置  📤 导出                                      │
└──────────────────────────────────────────────────────┘
```

### 交互

- **开关**：`POST /api/memory/toggle` 切换 `settings.memory.enabled`
- **立即提炼**：`POST /api/memory/extract` 触发 `runOnce()`，202 返回，前端 5s 轮询一次直到完成
- **会话列表**：`GET /api/memory/sessions` 返回 `{unanalyzed, analyzed, stats}`
- **移除记忆**：`POST /api/memory/remove {id}` 从 memories 删除（不落黑名单）
- **展开会话**：点击会话行 → 展示 findings 列表，每个 finding 可复制原文 quote

---

## 迁移与兼容

### v1 → v2 迁移

服务启动时，`src/store/memory-bank.js` 的 `readBank()` 检测 `version` 字段：

```js
if (bank.version === 1) {
  // 备份 v1：~/.claude/memory-bank.v1.bak.json
  // 产生一条 v2 的空框架：{version: 2, sessions: [], memories: []}
  // 用户之前的 CLAUDE.md 内容保留，后续 Phase 1 会重新生成
}
```

旧的 `user-log.jsonl` 不处理，保留作为历史数据，但记忆库不再消费。

### 功能开关

`settings.memory.enabled` 仍然生效，false 时 ticker 不跑。

---

## 错误处理与复原

### Phase 1 失败

- LLM 调用超时 / 额度耗尽 → 本会话不标记 `analyzedAt`，下轮继续处理
- 返回非法 JSON → 本会话标记 `analyzedAt` 但 `findings: []`，下轮跳过

### Phase 2 失败

- LLM 调用失败 → 本轮新 findings 暂存，下轮重试（不覆盖已有 memories）

### 数据损坏

- `memory-bank.json` 解析失败 → `store/index.js` 备份为 `.corrupt.bak`，抛错；用户手动介入或管理员恢复

---

## 测试清单（非实现细节，仅作设计验收）

- Phase 1 单会话分析的 LLM prompt 是否清晰准确
- Phase 2 去重合成逻辑（同主题多 findings → 单 memory）
- UI 展开/折叠会话 findings 的交互流畅度
- 移除 memory 后 CLAUDE.md 是否同步清除
- 首次启用时（236 会话）的额度消耗与分析进度可视性

---

## 关键约定

1. **显化即承诺**：findings 在面板展示给用户看，代表系统认可这些信息是可用的；不能悄悄改动或删除
2. **一次性删除**：memories 被移除就彻底删除，不落黑名单；下次 Phase 2 若模型又产出同样内容，用户需再次移除
3. **溯源链不断**：memories 的 `fromFindings` 永远指向来源会话，便于追溯与复查
4. **CLAUDE.md 自动维护**：新 memories 自动注入，移除则自动清除，用户不手改

---


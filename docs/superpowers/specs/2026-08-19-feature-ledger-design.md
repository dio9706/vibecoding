# 功能账本（Feature Ledger）—— 设计

日期：2026-08-19
状态：已确认（用户逐项拍板）

## 1. 背景与目标

现有「新需求」工作流每次开发都从零开始全局扫码，两个问题：
1. **重复探索**：开发过「宝宝辅食」的改动文件已被 git 记录，下次再改还得全局检索一遍。
2. **文档海量冗余**：README/CLAUDE.md/docs 大量重叠，AI 每次读大量与当前任务无关的内容。

目标：在需求工作流中增加「功能模块标签 + 历史文件索引」，让 AI 开发时直接命中已知文件，而非全局扫描。

## 2. 用户拍板决策

| 决策点 | 结论 |
|--------|------|
| 功能标签来源 | AI 在 docgen 时自动推断，评审期展示给用户可手动修改 |
| 标签粒度 | 单标签，大模块级（宝宝辅食/盘子需求/生活方式/家常托管等） |
| 允许多标签 | 否，强制单标签，大板块颗粒度 |
| 文件索引来源 | 归档时从真实 git diff --name-only 收割（非 AI 猜测），零 token |
| 自愈机制 | AI 发现快照文件不存在时回复开头标注「[快照过期]」，索引靠频次自然衰退+新归档覆盖 |

## 3. 核心数据

### 3.1 feature-index.json（新文件，DATA_DIR 根）

```json
{
  "宝宝辅食": {
    "tag": "宝宝辅食",
    "files": [
      { "path": "src/views/BabyFood.vue", "count": 3 },
      { "path": "src/api/babyFood.js", "count": 2 }
    ],
    "lastHarvestedAt": "2026-08-19T..."
  }
}
```

- `files` 按 `count` 降序——频次越高即历史改动越集中，置信度越高。
- 每次归档从 `git diff baseBranch..branch --name-only` 收割，同路径 count +1，新路径 count=1。

### 3.2 requirements.json 新增字段

```js
featureTag: null | string,  // 如 '宝宝辅食'，docgen 自动推断或用户手改
```

## 4. 生命周期

```
创建需求
    │
    ▼
评审期 docgen 运行
    │  AI 输出 §三·功能模块标签（从已有标签中选或新建）
    │  requirement-ops 解析 → req.featureTag 写盘
    │  前端展示标签 chip，用户可修改（PUT /api/req/feature-tag）
    ▼
开发/测试期
    │  GET /api/req/get 返回 seed（buildSeedPrompt）
    │  featureTag 有索引 → 注入【功能快照】文件列表 + 范围约束
    │  AI 先读快照文件，范围不足才局部探索，禁止全局扫
    ▼
归档
    │  git diff baseBranch..branch --name-only（逐分支）
    │  → harvestFiles(req.featureTag, files) → feature-index.json
    │  → 下次同功能需求的快照自动更新
```

## 5. 各层设计

### 5.1 store/feature-index.js（新文件）

纯 CRUD，零 AI，依赖 store/index.js 的 readJson/updateJson 文件锁。

导出：
- `getFeatureIndex()` → `{ tag: entry }` 全量
- `getFeature(tag)` → entry | null
- `listFeatureTags()` → string[]（供 docgen prompt 注入已有列表）
- `harvestFiles(tag, filePaths)` → void（合并频次，自动排序，updateJson 锁保护）
- `getTopFiles(tag, n=20)` → `[{path, count}]` | null（供 buildSeedPrompt 注入）

### 5.2 req-logic.js 改动（纯函数，零 IO）

**docOutputContract({ existingTags, currentTag })**：新增 §三·功能模块标签节：
```
## 三、功能模块标签
已有功能模块：宝宝辅食、盘子需求（从中选或新建 2-4 字名称）
本需求所属功能模块：
```

**parseFeatureTag(docText)**：从 §三 解析标签值，失败返回 null。

**buildDocgenPrompt({ ..., existingTags })**：透传 existingTags 给 docOutputContract。

**buildRevisePrompt({ ..., existingTags, currentTag })**：revise 也重输出 §三，支持修订时更正标签。

**buildSeedPrompt(req, { featureSnapshot })**：有快照时注入：
```
【功能快照·宝宝辅食】基于历史开发记录，本功能模块涉及以下文件（按改动频次排序）：
- src/views/BabyFood.vue（出现 3 次）
- src/api/babyFood.js（出现 2 次）
开发规范：先读快照文件定位实现，范围不足时再局部探索；禁止全局 glob/grep 扫整个工程。
若快照中有文件不存在，请在首条回复标注「[快照过期]」并说明。
```

### 5.3 requirement-ops.js 改动

**runDocgen**：docgen 完成后 `parseFeatureTag(resultText)` → 非 null 写 `req.featureTag`。同时把 `listFeatureTags()` 注入 `buildDocgenPrompt`，让 AI 从已有标签中选。

**archiveRequirement**：新增 `runGitDiff` 注入（对齐 runGit 已有范式），归档时逐分支 `git diff baseBranch..branch --name-only` → `harvestFiles`。runGitDiff 失败降级静默跳过，不阻塞归档主流程。

### 5.4 routes-requirements.js 新路由

- `PUT /api/req/feature-tag { id, tag }` — 手动设置/清除标签
- `GET /api/feature-index` — 返回全量索引（供调试/未来 UI）
- `handleGet` 改动：lookup `getTopFiles(r.featureTag)` → 传入 `buildSeedPrompt(r, { featureSnapshot })`

### 5.5 前端 req-view.js

评审期配置芯片条增加功能标签 chip（位于项目配置芯片之后）：
- 未知（docgen 尚未完成）→ 不显示
- 已知 → 「功能模块：宝宝辅食 ✏️」chip
- 点 ✏️ → 内联输入框 + 保存，调 `PUT /api/req/feature-tag`

## 6. 非目标

- 多标签（已决策不做）
- AI 开发完成后自动回写快照（开发完没有 git diff，只有归档时才有铁证）
- 文档腐烂的主动清理（索引绕开冗余文档，治标；彻底治文档是后续独立任务）
- 快照过期的主动修复（被动自愈：新归档刷新，开发期 AI 自报 [快照过期]）

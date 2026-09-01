# 项目优化维度② ⑤ 自动改进设计

**日期**：2026-08-31  
**状态**：设计确认  
**关联**：[2026-08-24 总设计](2026-08-24-project-optimize-design.md) · [2026-08-27 地图修复设计](2026-08-27-project-optimize-map-design.md)

---

## 概述

当前项目优化功能已支持维度①（项目地图 35%）和维度③（rules→skill 降级 15%）的自动优化。本设计扩展支持：

- **维度② 提示词质量**（30%）：skills 的 description/trigger/参数文档深度改进
- **维度⑤ 注释合理性**（20%）：源代码注释的完整性和质量提升

两个维度在 checkup 阶段独立检测，fix 阶段**串行改进**（②→⑤），各维度的改动相互隔离，支持独立回滚。

---

## 改进策略

### 维度② 提示词质量

**改进原则**：积极深度改进  
**范围**：`.claude/skills/` 下所有 SKILL.md 文件  
**判据**：规则（快速检查）+ LLM 分析（逐个评估）  
**改动类型**：description / trigger / 参数文档段落 / 结构重组

**具体改进**：
1. description 补充/重写：确保单句清晰表述 skill 用途，≥15 字
2. trigger 补充：无 trigger 说明或正文无 TRIGGER 段落时，LLM 推断并补充
3. 参数文档：检出有 args 但无「参数」段落的 skills，补充参数表
4. 结构优化：补充缺失的「何时使用」「示例」等标准段落
5. 措辞改进：LLM 优化现有 description/段落的清晰度和准确性

**质量闸**：LLM 生成的改进必须通过人工抽检（事后验证）

---

### 维度⑤ 注释合理性

**改进原则**：全面整齐化  
**范围**：`src/` / `public/` / `src-tauri/`（所有代码文件）  
**判据**：规则（导出无注释检查）+ LLM 采样分析（注释过时性/冗余性）  
**改动类型**：补充缺失注释 / 删除过时或冗余注释 / 改进注释措辞

**具体改进**：
1. 补充缺失块注释：导出函数/类/常量无顶部块注释时自动添加
2. 删除过时注释：通过 LLM 采样识别的已无效注释
3. 删除冗余注释：复述代码而不是解释意图的注释
4. 改进措辞：现有注释措辞不清晰时优化表述

**采样策略**：按优先级抽检（`src/features/` → `src/plugins/` → `src/capabilities/` → 其他），样本量 = min(20, 总文件数 / 5)

**质量闸**：LLM 生成的改进必须通过人工抽检（事后验证）

---

## 架构设计

### 整体流程

```
optimize-ops.js（编排核心）
├─ checkup 阶段
│  ├─ runStaticCheckup（现有）→ report
│  ├─ runCheckPrompts（新）→ report.dimensions.prompts
│  └─ runCheckComments（新）→ report.dimensions.comments
├─ startFix（串行两轮）
│  ├─ 轮次① 维度②（提示词改进）
│  │  ├─ selectFixablePrompts(report) → plan
│  │  ├─ createBackup('prompts')
│  │  ├─ applyPromptsFix(plan)
│  │  ├─ recordPostState
│  │  └─ SSE 推 done:prompts-fixed
│  │
│  └─ 轮次② 维度⑤（注释改进）
│     ├─ selectFixableComments(report) → plan
│     ├─ createBackup('comments')
│     ├─ applyCommentsFix(plan)
│     ├─ recordPostState
│     └─ SSE 推 done:comments-fixed
│
└─ rollback 支持维度级隔离（仅回滚维度② 或 维度⑤）
```

### 新增文件清单

#### src/features/project-optimize/

| 文件 | 职责 |
|---|---|
| `check-prompts.js` + `.logic.js` | 维度② 规则检查 + LLM 分析 |
| `check-comments.js` + `.logic.js` | 维度⑤ 规则检查 + LLM 采样分析 |
| `fix-prompts.js` + `.logic.js` | 维度② 改进应用（description/trigger/参数文档） |
| `fix-comments.js` + `.logic.js` | 维度⑤ 改进应用（补充/删除/改进注释） |
| `fix-plan.logic.js`（扩展） | 新增 selectFixablePrompts / selectFixableComments |

#### src/entrypoints/web/

| 文件 | 改动 |
|---|---|
| `optimize-ops.js` | 新增 runCheckPrompts / runCheckComments / applyPromptsFix / applyCommentsFix |
| `routes-optimize.js` | 现有接口兼容（/api/optimize/checkup 返回值增字段） |

#### src/store/

| 文件 | 改动 |
|---|---|
| `optimize.js` | 扩展 backup 结构支持维度隔离（dimension 字段） |

---

## 检测阶段设计

### checkPrompts

**输入**：projectDir、已解析的 CLAUDE.md

**处理流程**：

```
① 扫 .claude/skills/ 下所有 SKILL.md
  ↓
② 规则检查（快速）
  - P1: description 缺失或 < 15 字 → fixable:true
  - P2: trigger 缺失或正文无 TRIGGER 段 → fixable:true
  - P3: 有 args 但无「参数」段落 → fixable:true
  ↓
③ LLM 分析（针对 fixable:true 的 skills）
  - runReadonlyAgent 逐个评估
  - 返回改进建议列表（description/trigger/参数/结构）
  ↓
④ 生成评分 + 报告
  score = 100 - (缺项数 × 权重) - (LLM 判「表述不清」数 × 5)
```

**报告格式**：

```js
{
  dimensions: {
    prompts: {
      issues: [
        { code, fixable, file, severity }
      ],
      llmAnalysis: {
        skills: [
          { file, description, trigger, improvements: [{type, newValue, confidence}] }
        ]
      },
      fixable: true,
      score: number
    }
  }
}
```

**LLM 提示词包含**：
- skill 列表（frontmatter + 前 200 字正文）
- 评估维度：description 清晰度、trigger 推断、参数完整性、段落结构
- 改进建议格式：JSON 数组，包含 type / newValue / confidence（0-100）

**超时**：600s（复用现有 READONLY_AGENT_TIMEOUT_MS）

---

### checkComments

**输入**：projectDir

**处理流程**：

```
① 扫源文件（src/**/*.{js,ts}、public/**/*.js、src-tauri/**/*.{js,ts,rs}）
  ↓
② 规则检查（快速）
  - C1: 导出函数/类/常量无块注释 → fixable:true
  ↓
③ 优先级采样
  - 按目录优先级排序（features → plugins → capabilities → 其他）
  - 样本量 = min(20, 总文件数 / 5)
  ↓
④ LLM 采样分析
  - runReadonlyAgent 逐个扫描采样文件
  - 返回操作列表（delete/add/improve）
  ↓
⑤ 生成评分 + 报告
  score = 100 - (导出无注释数 × 5) - (采样发现过时/冗余注释数 × 2)
```

**报告格式**：

```js
{
  dimensions: {
    comments: {
      issues: [
        { code, fixable, file, lineNo, severity }
      ],
      llmAnalysis: {
        files: [
          { file, actions: [{type:'delete|add|improve', line, suggestion, confidence}] }
        ],
        sampledFileCount: number,
        totalFileCount: number
      },
      fixable: true,
      score: number
    }
  }
}
```

**LLM 提示词包含**：
- 采样文件列表（相对路径 + 文件内容或代码片段）
- 扫描目标：过时注释、冗余注释、缺失注释、不清晰注释
- 操作格式：JSON 数组，包含 type / line / suggestion / confidence

**超时**：600s

---

## 修复阶段设计

### selectFixablePrompts

从 report 中提取 `dimensions.prompts.llmAnalysis.skills`，筛选 `improvements.length > 0` 的 skills，去重。每个 skill 最多取 5 项改进（按 confidence 降序）。

**返回**：

```js
{
  skills: [
    {
      file: string,
      improvements: [{type, newValue, confidence}]
    }
  ]
}
```

### selectFixableComments

合并两个来源：
1. LLM 采样分析的 actions（report.dimensions.comments.llmAnalysis.files）
2. 规则检查的 C1 issues（report.dimensions.comments.issues）

按文件分组去重，按 confidence 排序。

**返回**：

```js
{
  files: [
    {
      file: string,
      actions: [{type, line, suggestion, confidence}]
    }
  ]
}
```

### applyPromptsFix

```
for each skill in plan.skills:
  ① 读入 SKILL.md，解析 frontmatter + body
  ② 逐个应用 improvements
     - type: 'description' → 更新 frontmatter.description
     - type: 'trigger' → 更新 frontmatter.trigger
     - type: 'add_section' → 在 body 中注入新段落
     - type: 'improve_section' → 替换现有段落
  ③ 写回 SKILL.md（原子操作）
  ④ SSE 推进度（current/total/file）
```

**错误处理**：
- 若 parseSkillFrontmatter 失败 → 记录错误，跳过此文件
- 若写入失败 → 记录错误，触发当前轮备份还原

**并发**：串行（一个接一个），避免同时修改同一文件

### applyCommentsFix

```
for each file in plan.files:
  ① 读入源文件，逐行解析
  ② 按行号倒序处理 actions（避免行号漂移）
     - type: 'add' → 在行上方插入块注释
     - type: 'delete' → 删除该行
     - type: 'improve' → 替换该行注释内容
  ③ 写回源文件（原子操作）
  ④ SSE 推进度（current/total/file）
```

**块注释格式**（JS/TS）：

```js
// <建议文本，自动折行 ≤ 100 字符>
```

或多行：

```js
// <第一行>
// <第二行>
```

（Rust 则用 `//`，不用 `/* */`）

**错误处理**：同上

**并发**：串行

---

## 备份和还原

### 备份结构

```js
{
  dimension: 'prompts' | 'comments',
  timestamp: number,
  entries: [
    {
      file: string,
      content: string,        // 原文件内容
      mtime: number,          // 原文件修改时间
      action: 'created' | 'modified'  // 标记为新建还是修改
    }
  ]
}
```

### 存储位置

`store.optimize.json` 中新增 `backups` 数组，每轮 fix 对应一条快照。

### 还原逻辑

支持三种模式：
- `rollback('prompts')`：只还原维度②
- `rollback('comments')`：只还原维度⑤
- `rollback('all')`：还原两个维度

还原时恢复文件内容和 mtime（确保下次 checkup 的 M3 stale 判定不受影响）。

---

## 前端集成

### SSE 事件扩展

新增事件类型：

```js
// 维度② 进度
{type: 'progress', phase: 'prompts', current, total, file}

// 维度⑤ 进度
{type: 'progress', phase: 'comments', current, total, file}

// 维度② 完成
{type: 'done', phase: 'prompts', changes: number, ...}

// 维度⑤ 完成
{type: 'done', phase: 'comments', changes: number, ...}

// 整体完成（两个维度都做完）
{type: 'done', phase: 'all', ...}
```

### 前端展示

修改 `public/js/optimize-view.js`：
- 进度条分段显示（提示词 / 注释）
- 支持按维度还原按钮

---

## 质量保障

### 审核策略

- **事后抽检**：改动完成后用户随机抽几个文件（维度②取 3-5 个 skills，维度⑤ 取 3-5 个源文件）
- **无逐文件审批**：不支持「分文件同意」，要么全部接受要么全部回滚

### 检验清单

改动完成后自动生成检验清单：

#### 维度②

- [ ] 选中的 skills 总数
- [ ] 平均改动项数（description/trigger/参数等）
- [ ] 总增加字数 / 总删除字数
- [ ] 建议抽检文件列表（3-5 个）

#### 维度⑤

- [ ] 修改的源文件总数
- [ ] 补充的块注释数 / 删除的注释行数 / 改进的注释行数
- [ ] 涉及的顶级目录（src/features / src/plugins 等）
- [ ] 建议抽检文件列表（3-5 个）

---

## 风险与应对

| 风险 | 等级 | 应对 |
|---|---|---|
| LLM 改坏 description | 高 | 备份 + 还原；事后抽检 |
| 删错注释 / 补充错注释 | 中 | 备份 + 还原；采样 LLM 分析降低误删率 |
| 改维度② 时维度⑤ 无法进行 | 中 | 维度隔离备份，一个失败不影响另一个 |
| 全仓扫描耗时过长 | 中 | LLM 超时保护（600s）；采样策略（维度⑤ 仅 20 个文件） |
| mtime 变化影响下次 M3 判定 | 低 | 还原时恢复 mtime（已在地图维度③中验证） |

---

## 单一维度优先级

- 先改维度②（skills 风险相对可控）
- 再改维度⑤（源代码注释，涉及面更广）
- 两个维度串行，一个完成后才进行下一个

---

## 成功标准

- ✅ checkup 阶段正确识别维度②、⑤ 的所有 fixable 项
- ✅ fix 阶段逐项应用改进，SSE 正常推送进度
- ✅ 备份和还原正确隔离维度，可独立回滚
- ✅ 事后抽检时，LLM 改进的质量 ≥ 80% 合理度（即 3-5 项中至少 4 项无误或有益）
- ✅ 前端展示分段进度，用户能清楚看到两个维度的执行阶段


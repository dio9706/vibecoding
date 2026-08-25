# 「项目优化」工具 · 阶段三设计文档(一键优化 · rules 降级)

> 日期: 2026-08-24 · 状态: 待评审 · 前置: 阶段一(静态体检)已完成
> 上游: `2026-08-24-project-optimize-design.md`(总设计)

## 1. 目标与范围

阶段一交付了体检能力,但「一键优化」按钮是 disabled 占位。本阶段打通第一个完整的优化闭环:

```
体检 → 勾选「规范加载方式」维度 → 一键优化 → 重新体检看分数变化 → 不满意可还原
```

### 本期做什么

- **维度③ rules 降级的自动执行**:把体积大、paths 宽的 `.claude/rules/*.md` 转成 `.claude/skills/<name>/SKILL.md`
- **快照备份与还原**:所有破坏性操作的安全底座
- **工作区 git 检查**:开跑前拦截脏工作区

### 本期不做(明确排除)

- **维度① 地图的自动生成/更新** —— 纯 LLM 产出,不确定性高,单独一期
- 维度②⑤(提示词、注释)—— 属阶段二,尚未实现检测
- diff 逐项确认交互 —— 那是高风险维度(②⑤)才需要的,rules 降级是低风险,直接执行 + 可还原

### 为什么先做 rules 降级

| | rules 降级 | 地图生成 |
|---|---|---|
| 确定性 | 高(文件移动 + 文本替换,仅一句 description 需 LLM) | 低(纯 LLM 读代码写摘要) |
| 已验证 | 2026-08-24 手工对 kxmall-app-ui 完整做过一遍 | 无 |
| 价值可验证性 | 强(对 `kxmall-app-ui.auto` 跑一次,rules 分应 60 → 100) | 弱(生成质量要人读) |

## 2. rules 降级的完整流程

以 `.claude/rules/design-system.md` 为例,降级为 `/design-system` 技能:

### 步骤

1. **前置校验**
   - 目标 `.claude/skills/<name>/` 已存在 → 跳过该文件,记为 `skipped`,原因「同名 skill 已存在」
   - 源文件不可读 → 跳过,记为 `failed`

2. **生成 skill description**(唯一需要 LLM 的环节)
   - 输入:文件的一级标题 + 全部二级/三级标题 + 正文前 500 字
   - 输出:一句话 description,必须同时覆盖「是什么」和「什么时候调用」
   - LLM 失败时降级为机械生成(见 §3)

3. **写 skill 文件**
   - 剥掉原 frontmatter(整个 `---` 块)
   - 写入新 frontmatter:`name` + `description`
   - 正文原样保留
   - 落到 `.claude/skills/<name>/SKILL.md`

4. **删除原 rules 文件**

5. **全仓替换引用**
   - 扫描范围:仓库内所有 `.md` 文件
   - 排除:`node_modules`、`.git`、`docs/migration/`、`docs/plans/`、`docs/specs/`、`.claude/optimize-backup/`
   - 替换规则:反引号包裹的 `` `.claude/rules/<name>.md` `` → `` `/<name>` 技能 ``
   - 顺带修掉替换后可能产生的「技能 的」这类多余空格

### 为什么排除 docs/migration|plans|specs

这些是**历史存档**,记录的是当时的事实。把里面的路径改掉会篡改历史记录。这条规则来自 2026-08-24 手工降级时的判断。

### 不做的两件事

**不自动改根 CLAUDE.md 的规范索引表结构。** 表格里的路径引用会被步骤 5 的机械替换处理掉,但「把条目从『自动加载』表移到『按需调用』表」是语义级重构,机械做不了,LLM 做又要改根地图(风险高)。改为在优化结果里提示用户手工调整,并给出建议文案。

**不替换 `.md` 以外文件里的引用。** 代码注释里引用 rules 路径的概率极低,扩大扫描面得不偿失。

## 3. description 生成

**LLM 路径**(默认):用 `src/integrations/claude.js` 的 `runClaude` 一次性调用,不走 run 注册表——这是个短任务,不需要流式和中断恢复。

**必须禁用所有工具。** 输入是已经读好的文本片段,输出是一句话,LLM 不需要任何文件读写能力。不禁用的话,它可能"顺手"去读或改项目文件——而这个调用发生在破坏性操作的中途,多余的写入会绕过快照备份。

提示词要求产出的 description 必须包含两部分:
- 是什么:一句话概括规范内容
- 什么时候调:列出触发场景,这直接决定 skill 能否被正确唤起

**机械降级路径**(LLM 失败时):`<一级标题> —— 覆盖 <前三个二级标题,顿号分隔>。修改相关内容时调用。`

降级产出的 description 质量较差,必须在优化结果里标注「description 为自动生成,建议人工复核」。

## 4. 备份与还原

### 备份时机

**任何写操作之前**,一次性把本次将要改动的所有文件快照到:

```
.claude/optimize-backup/<ISO时间戳>/
├── manifest.json
└── files/
    └── <按原相对路径保留目录结构>
```

### manifest.json

```json
{
  "at": "2026-08-24T08:00:00.000Z",
  "dir": "C:\\path\\to\\project",
  "dimensions": ["rules"],
  "entries": [
    { "path": ".claude/rules/design-system.md", "action": "deleted", "backed": true },
    { "path": "CLAUDE.md", "action": "modified", "backed": true },
    { "path": ".claude/skills/design-system/SKILL.md", "action": "created", "backed": false }
  ]
}
```

`action` 三种:`deleted`(原文件被删)、`modified`(内容被改)、`created`(新建,无需备份但还原时要删掉)。

### 还原

按 manifest 逆向执行:
- `deleted` / `modified` → 从 `files/` 复制回原路径
- `created` → 删除该文件;如果所在目录随之变空,一并删除空目录

还原前校验:如果目标文件当前内容与备份**不一致**(说明优化后又被人改过),该条**跳过**并在结果里标注,避免覆盖用户的手工修改。

### 保留策略

每个项目保留最近 5 次备份,超出的按时间从旧到新删除。

## 5. 安全约束

1. **工作区检查**:执行前跑 `git status --porcelain`。非空则返回 `needsConfirm: true` + 脏文件数,前端弹确认框说明「优化产生的改动会和已有改动混在一起,难以区分」,用户确认后带 `force: true` 重新请求。非 git 仓库跳过此检查,但在结果里提示「无法通过 git 还原,仅可用快照还原」。
2. **绝不自动提交**:任何 git 写操作都不做。
3. **串行执行**:同一项目同时只能有一个优化任务。用 `optimize.json` 项目记录上的 `busy: {kind, runId, startedAt}` 做落盘串行闸,进程重启后能识别孤儿任务。
4. **核心操作失败即停**:某个文件的「写 skill / 删原文件」失败时,停止处理后续文件,已完成的部分保留(有备份可还原),结果里说明停在哪一步。

   注意区分:**引用替换失败不算核心失败**,不阻断流程。引用没替全只是文档里留了旧路径,skill 本身照常可用;而写 skill / 删原文件失败意味着文件系统处于半完成状态,继续下去会越错越多。

## 6. 数据结构增量

在阶段一的 `optimize.json` 项目记录上补两个字段(阶段一已预留):

```json
{
  "busy": { "kind": "fix", "runId": "run_xxx", "startedAt": "..." },
  "backups": [
    { "at": "2026-08-24T08:00:00.000Z", "dir": ".claude/optimize-backup/2026-08-24T08-00-00", "fileCount": 7, "dimensions": ["rules"] }
  ],
  "lastFix": {
    "at": "...",
    "dimensions": ["rules"],
    "results": [
      { "file": ".claude/rules/design-system.md", "status": "done", "skillName": "design-system", "refsUpdated": 6, "descriptionSource": "llm" }
    ],
    "notes": ["根 CLAUDE.md 的规范索引表需手工调整：把 design-system 从「自动加载」表移到「按需调用」表"]
  }
}
```

## 7. API 增量

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| POST | `/api/optimize/fix` | `{dir, dimensions: ["rules"], force?: boolean}` | `{runId, backupDir}` 或 `{needsConfirm: true, dirtyCount}` |
| GET | `/api/optimize/fix-stream?runId=` | — | SSE:`step` 事件推进度,`done` 推最终结果 |
| POST | `/api/optimize/rollback` | `{dir, backupAt}` | `{restored, skipped: [{path, reason}]}` |
| GET | `/api/optimize/backups?dir=` | — | `{backups: []}` |

## 8. UI 增量

- 底部「一键优化」按钮**解除禁用**,条件:有体检结果 且 至少勾选一个 `selectable` 维度 且 无进行中任务
- 阶段一的「阶段一仅支持体检」提示文案改为:仅当勾选了尚不支持自动修复的维度时,提示「维度 X 暂不支持自动修复,本次将跳过」
- 点击后:先弹工作区确认框(如需),再显示进度条 + 逐步骤日志(SSE 驱动)
- 完成后:展示改动摘要(每个文件的处理结果)+ `notes` 提示 + 两个按钮 [重新体检] [还原本次优化]
- 面板顶部若存在备份,显示 [还原上次优化]

## 9. 错误处理

| 场景 | 处理 |
|---|---|
| 目标 skill 目录已存在 | 跳过该文件,`status: "skipped"`,不算失败 |
| 快照备份写入失败 | 中止整个优化,不做任何改动 |
| LLM 生成 description 失败 | 降级为机械生成,标注 `descriptionSource: "fallback"` |
| 引用替换时某文件不可写 | 记 `refsFailed`,继续处理其余文件(引用替换不完整不影响 skill 可用) |
| 还原时文件已被人工改动 | 跳过该文件并在 `skipped` 里说明原因 |
| 优化过程中进程崩溃 | 重启后 pump 检测到 `busy` 且 runId 已死 → 标记中断,UI 提示并提供还原 |

## 10. 测试策略

**必须单测的纯逻辑**

- `fix-rules.logic.js`:frontmatter 剥离与重写、引用替换的文本变换、skill 名推导、「技能 的」空格清理
- `backup.logic.js`:manifest 生成、还原路径映射、`created` 条目的删除判定
- `git-guard.logic.js`:`git status --porcelain` 输出的解析

**端到端夹具**:新增 `tests/fixtures/projects/demote-target/`,含两个应降级的 rules 文件和三个引用它们的 md(其中一个在 `docs/specs/` 下,用于验证归档目录被正确排除)。测试对夹具副本执行完整降级 + 还原,断言文件系统状态。

**真实验证**:对 `kxmall-app-ui.auto`(未优化副本)执行一次,rules 维度分数应从 60 涨到 100;随后还原,应回到 60。

## 11. 开放问题

无。范围已在评审中确认:本期只做 rules 降级 + 备份还原,不做地图生成。

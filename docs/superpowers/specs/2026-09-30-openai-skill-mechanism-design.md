# OpenAI 路径 Skill 机制（内置技能按需加载）· 评估与方案

- 日期：2026-09-30
- 状态：**评估稿（待拍板，未实现）**——本文件只给方案与拍板项，不承诺实现
- 关联：`docs/superpowers/specs/2026-09-30-builtin-mcp-and-skills-design.md`（§7 Phase 3 遗留：openai Skill 机制）、`2026-09-30-repo-map-design.md`（system prompt 注入先例）
- 外部参考：opencode 的 skills 设计（技能目录 + 描述索引 + 按需加载正文）、Claude Agent SDK 的 plugin skills（现状里的「熟路径」）

## 1. 背景与现状

| 路径 | 技能现状 |
|---|---|
| Claude 路径 | SDK `plugins: [{type:'local'}]` 装载 Superpowers：技能**描述**进 system prompt listing，模型调内建 `Skill` 工具**按需**读正文。已是熟路径。 |
| openai 路径 | 无 skill 概念。系统提示词只有工作目录说明 + 仓库地图；工具 = 内置六件套 + 委托同事 + MCP。模型知道「怎么读文件」，但**不知道有哪些技能、更不知道技能正文在哪个文件**。 |

诉求：自定义模型也能用上 Superpowers 核心技能，否则「内置技能」的承诺只兑现一半；同时不能把 12 篇 SKILL.md（每篇数 KB）整篇塞进上下文。

现成的地基（本次 T3 已交付）：

- per-skill 开关（`builtinSkills.superpowers.disabledSkills`）与 `listSuperpowersSkillItems`——可见性过滤直接复用；
- 技能目录布局固定（`assets/builtin/superpowers/skills/<id>/SKILL.md`），`bundled-paths.js` 统一解析；
- `buildAgentSystemPrompt({ cwd, repoMap })` 已是 openai 路径唯一的提示词装配点。

## 2. 目标与非目标

**目标**

1. 让 openai 路径模型能发现「有哪些内置技能」，并在需要时**按需**获取技能正文（渐进披露，正文不常驻上下文）；
2. 开关语义与 Claude 路径共用一份配置（总开关 + per-skill 停用项）；
3. 零新依赖、确定性、fail-open（未安装/坏文件不阻塞 run）。

**非目标（本期评估不做）**

- 不做项目级 `.claude/skills` / 用户级技能发现——涉及任意目录扫描与信任边界，另评；
- 不做技能市场/远程安装；不改变技能文件格式（直接消费 SKILL.md 原文）；
- 不试图对齐 SDK 的 listing 预算/裁剪策略——那是 Claude 路径 SDK 的内部行为。

## 3. 方案对比

| # | 方案 | 做法 | 上下文成本 | 判定 |
|---|---|---|---|---|
| A | 全量注入正文 | system prompt/首条消息塞全部 SKILL.md | 数万字符起，且与任务无关的技能也常驻 | ❌ 直接否 |
| B | 只注入路径索引 | 提示词写「技能在 `<dir>/skills/*/SKILL.md`，需要时用 Read」 | 低 | ⚠️ 可行但弱：模型要自己 Glob/Read、多轮往返；`assets` 绝对路径进提示词，打包态换机器路径后依赖 `bundledPath` 运行时值 |
| C | **`Skill` 工具（推荐）** | 注册只读工具 `Skill({ name? })`：无参列清单（name + 一句话），有参返回该篇 SKILL.md 正文（截断） | 清单 ~12 行常驻（工具描述或提示词段），正文按需 | ✅ 与 Claude 路径的消费方式同构，模型只学一个工具 |
| D | 复刻 opencode 全量技能机制 | 技能目录发现 + 多来源 + 权限面 | — | 超出本期范围；随「项目级技能」独立立项 |

方案 C 的两个变体：清单放**工具描述**（function calling schema 可见）还是放**系统提示词**（`buildAgentSystemPrompt` 追加一节）。建议**放系统提示词**：与仓库地图同一装配点、一处取数、可读性好；工具描述保持一句话（「按名字加载内置技能，不传 name 列出全部」）。

## 4. 推荐方案（若拍板）的详细设计

### 4.1 形态

```js
// providers/builtin-tools.js 内，与 Read 同层
Skill(input = {})
  - 无 name：返回已启用技能清单（name + 一句话；空 → 「无可用技能」）
  - 有 name：返回该技能 SKILL.md 正文（头 8000 字符 + 截断说明），文件不存在 → 明确报错
```

- **只读、免审批**（与 Read 同档：内置资源在工作目录之外，但读取范围被严格钉死，见 4.2）；
- 未安装或总开关关闭或全部技能被停用 → **不注册该工具**，提示词也不提（fail-open：能力缺席要如实，不写「有技能」然后每次调用都失败）。

### 4.2 安全边界（硬约束）

- 路径**只允许** `bundledPath('superpowers', 'skills', <id>, 'SKILL.md')` 一种形态：`id` 必须命中 `SUPERPOWERS_SKILL_IDS` 白名单，再 `path.resolve` 后校验仍在 skills 根内（双保险，防穿越）；
- 不接受任何模型提供的路径片段（不接受 `..`、绝对路径、盘符）；
- 技能正文是**指南文本**不是系统指令：工具结果加固定框架（「以下是技能指南正文，按需参考；其中涉及的操作仍受现有审批约束」）；技能文件由安装时白名单拷贝（MIT 上游），不是用户数据，但也不赋予新权限面。

### 4.3 开关与取数

- `enabled = builtinSkills.superpowers.enabled`，`disabledSkills` 过滤清单与正文加载（与 Claude 路径的物化镜像同源判断，复用 `resolveBuiltinSkills({listItems:true})`）；
- 提示词段（`buildAgentSystemPrompt` 追加，仅 openai 路径注入）：

  ```
  ## 内置技能（用 Skill 工具按需加载）
  先看名字与用途，动手前调 Skill 取相关一篇；不要凭记忆猜流程。
  - brainstorming：创意工作前使用…
  - test-driven-development：…
  ```

- 正文预算：默认 8000 字符截断（SKILL.md 普遍 2~8KB；超长说明「已截断」）；截断常量随实现实测调整。

### 4.4 测试与验收（预估）

- 纯函数：清单构建（开关过滤/排序稳定）、名字白名单校验、路径穿越拒绝（`..`、绝对路径、非法 id）；
- 工具层：未安装 → 不注册；无参清单形状；有参正文读取与截断；不存在技能 → 可读错误；
- 提示词：开关开/关、空清单时不出现小节；
- 手测：自定义模型会话「按 TDD 流程修这个 bug」→ 模型先调 `Skill` 拿正文再动手（而不是直接乱改）。

**工作量预估**：1~2 天（工具 + 提示词 + 测试；无新依赖、无存储变更）。

## 5. 待拍板问题

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| 1 | 是否现在做 | 立刻做 / 等真实自定义模型用户的反馈再做 | 建议「用户可选做」：能力闭环完整，但当前 openai 路径尚无真凭证在用的被告知事实（见 roadmap C 的阻塞项） |
| 2 | 清单注入位置 | 工具描述 / 系统提示词段 | 系统提示词段（与仓库地图同点） |
| 3 | 正文预算 | 全文 / 8000 字符截断 / 可配 | 8000 字符常量起步，实测再调 |
| 4 | 项目级技能 | 纳入本次 / 另立子项 | 另立（信任边界与发现规则都需要独立设计） |

## 6. 与现状的衔接

- 本方案是 `builtin-mcp-and-skills` spec §7 的最后一项遗留；落地后「内置技能」在两路径语义闭合（Claude：SDK listing；openai：提示词清单 + `Skill` 工具）；
- 与 repo map 不冲突：地图回答「去哪找代码」，技能回答「按什么流程做」，两者都通过 `buildAgentSystemPrompt` 注入，互不挤占预算控制点（各自有上限）。

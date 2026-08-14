# 设计：owner 强前缀提交放行 + 可信提交人名单入设置页

- 日期：2026-07-31
- 分支：feat/unattended-mode（不做 git 提交）
- 前置：`2026-07-31-feishu-trusted-bypass-review-card-design.md`（可信直通 + 评审否定挽回，已实施）

## 背景与问题

1. **owner 提不了需求，材料池对 owner 失效**。`claude-exec.match = role==='owner'` 在路由第 2 步全量接管 owner 消息，永远到不了 feedback。后果：
   - owner 无法用「提交需求：」立案（必须把自己从 `OWNER_OPEN_IDS` 挪走，代价是失去完整 Claude 能力）；
   - 单发图片/文件已入材料池（入口层，与身份无关），但 owner 的后续文字被 claude-exec 吞掉 → `drainMaterials` 永不执行 → 材料 10 分钟静默过期（旧遗留项 I5）。
2. **可信名单只能改 env 重启**，无法在 web 设置页按机器人配置。

## 决策

| 决策点 | 结论 |
|---|---|
| owner 与提交能力的矛盾 | owner 的**强前缀提交**（bug/feature）放行到 feedback，其余消息仍由 claude-exec 全接 |
| owner 是否算可信提交人 | 是。owner 提交等同可信直通（不评审、直接自动开发） |
| 可信名单存放 | per-bot 设置字段（textarea 每行一个 open_id）+ 空值回退 env `TRUSTED_OPEN_IDS` |
| 判定放在哪 | `claude-exec.match` 自己排除强提交前缀（不在 dispatch 里硬编码 feature 名） |

## 设计

### 1. claude-exec 让路强提交前缀

`features/claude-exec/index.js` 的 match 改为：owner 且**不是**强提交前缀（`matchStrongIntent(text)` 命中 bug/feature）。

- 用 `app/intent-keywords.js` 的 `matchStrongIntent`（纯正则、零成本、已单测），不引入新判定逻辑，避免两处漂移。
- 只排除 bug/feature 两类；`question` 前缀不排除（owner 问问题继续走完整 Claude，能力更强，且 L1 的 question 还要让路动作关键词，语义复杂）。
- 其余 owner 消息（`/new`、闲聊、任意指令）行为完全不变。
- task-triage（order=10，触发词 match）仍在 claude-exec 之前，不受影响。

### 2. feedback 接受 owner

`feedback.permission`: `'guest'` → `'any'`。

- dispatch 的 `permOK = permission==='any' || permission===role`，改后 owner 的 bug/feature/material 意图可进 feedback。
- 语义正确：谁提交需求/故障都该被收集，收集流程与角色无关。

### 3. owner 自动可信直通

feedback 的直通判定扩为：`ctx.user.role === 'owner' || 可信名单命中`。owner 提交不做合理性评审，直接进自动开发队列（合并仍需管理员确认）。

### 4. 可信名单 per-bot 化

- `store/settings.js`：`makeBotEntry` 增 `trustedOpenIds`（字符串数组，`strList` 归一：trim + 去空）；`addBot` 解构与转发同步补齐（漏一处即「新建丢字段」，有既有回归测试守此坑）。
- `routes-settings.js`：`cleanBotInput` 收 `trustedOpenIds`（数组或换行字符串都归一为数组，逐项长度上限）；`botView` 回读。
- 前端：`index.html` bot 表单加 textarea（`#botTrustedOpenIds`，placeholder 示范每行一个）；`bots-panel.js` 的 `openBotForm` 回填（`join('\n')`）、`saveBot` 提交（`split('\n')` 归一）。模式抄全局设置里 MCP `autoAllow`。
- 读取出口收敛成一个函数（放 `feedback/logic.js`，纯函数可单测）：
  `resolveTrustedOpenIds(bot, envList)` → bot 配置非空取 bot，否则取 env。**不做并集**（并集会让「设置页清空」无法覆盖 env，语义不可预期）。
- feedback 两个读取点（直通判定、卡片鉴权）都改走该函数。

## 兼容与风险

- 未配 bot 字段的存量机器人：回退 env，行为与现状一致。
- owner 发「提交故障：xxx」从此立案并自动开发（不再是让 Claude 当场改码）——这是本次有意的行为变更，也是用户诉求。
- owner 只发「提交需求」无正文 → 走 feedback 的追问分支，不建任务（既有逻辑）。

## 测试

- `matchStrongIntent` 驱动的 claude-exec match 判定：owner+强前缀 → false；owner+普通文本/`/new` → true；guest → false。抽 `shouldOwnerExec(text, role)` 纯函数入 `claude-exec/logic.js` 并单测。
- `resolveTrustedOpenIds`：bot 有值取 bot；bot 空数组/undefined 取 env；两者皆空 → `[]`。
- `makeBotEntry`：`trustedOpenIds` 显式透传、非数组归空（对齐既有 `strList` 测试风格）。
- `cleanBotInput`：换行字符串与数组两种入参都归一；超长条目被拒/截断按既有惯例。

## 不做的事

- 不改意图分类四层短路、不改评审门语义、不动 task-triage。
- 不做「材料 intent 对 owner 放行」（纯长文本材料仍走 claude-exec；图片/文件/云文档在入口层入池已覆盖主要动线）。
- 不做名单并集、不做全局（非 per-bot）设置项、不做 UI 校验 open_id 格式（后端 strList 归一足够）。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `src/features/claude-exec/logic.js`（新） | `shouldOwnerExec` 纯函数 |
| `src/features/claude-exec/logic.test.js`（新） | 上述单测 |
| `src/features/claude-exec/index.js` | match 改用 `shouldOwnerExec` |
| `src/plugins/team-tools/feedback/index.js` | permission→any；直通判定含 owner；读取走 `resolveTrustedOpenIds` |
| `src/plugins/team-tools/feedback/logic.js` + `.test.js` | `resolveTrustedOpenIds` + 单测 |
| `src/store/settings.js` + `settings.test.js` | `makeBotEntry`/`addBot` 增 `trustedOpenIds` + 单测 |
| `src/entrypoints/web/routes-settings.js` | `cleanBotInput`/`botView` |
| `public/index.html`、`public/js/bots-panel.js` | 表单字段 + 回填/提交 |
| `docs/CONFIGURATION.md` | 说明 per-bot 优先、env 兜底 |

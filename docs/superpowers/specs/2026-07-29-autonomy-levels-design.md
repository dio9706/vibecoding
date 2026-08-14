# 机器人托管程度（轻度/中度/完全托管）设计

## 一、目标

给机器人新增**托管程度**配置（类 effort-row 三档步进器），控制需求/故障的自动化处理深度，最终支撑"与 AI 对话即可完成开发人员 95% 工作"的方向。核心机制：**AI 评审门（打分制，判决在代码）+ 每任务虚拟分支 + owner 确认合并**。

已确认决策：三档一次做完；托管程度接管并退役「无人值守」开关（编译二维码能力并入托管流程，群播报随开关退役，改为回复来源会话）；完全托管的项目问答开放 guest+owner。

## 二、三档语义

| 档位 | 值 | 行为 |
|---|---|---|
| 轻度托管 | `light`（默认） | 现状：脚本动作 + 需求/故障收集 + 自动分析，开发需人工确认，原地改码（不建分支） |
| 中度托管 | `medium` | 收集后先过 **AI 评审门**；确认的 BUG **自动修复**（任务分支）；需求生成方案后**等 owner 确认**再自动开发（任务分支）；合并需 owner 点击确认 |
| 完全托管 | `full` | 中度基础上：评审通过的需求**直接自动开发**；未命中脚本/需求/故障的消息走**项目问答**（只读）；合并仍需 owner 确认 |

红线（三档一致）：**合并主分支永远人工确认**。

## 三、数据模型

### bot 新增字段
- `autonomy: 'light' | 'medium' | 'full'`，默认 `'light'`；UI 为三档滑块（复用 effort-row 样式），档位说明随滑动切换。

### Task 新增字段（store/tasks.js）
- `auto: true` — 由托管流程自动开发的标注（UI 徽标 [自动完成]）
- `branch` — 任务分支名 `auto/<taskId>`
- `baseBranch` — 建分支时项目当前分支快照（= 合并目标"主分支"）
- `merged: bool` / `mergedAt` — 合并态；`mergeError` — 最近一次合并失败原因
- `review` — 评审结果 `{ verdict, belongs, located, complexity, benefit, risk, confidence, counterArgument, reasons }`

### 状态机扩展
```
new → reviewing → challenged（质疑，等用户答复）→（坚持）→ 修复/方案流程
              ↘ rejected（评审拒绝，回复理由）
              ↘ analyzing → analyzed →（medium 等确认 / full 直接）→ developing → done
BUG 评审通过：reviewing → developing（自动，任务分支）→ done
done && auto && !merged = 待合并（筛选/按钮据此）；合并成功 → merged:true
```

### 判例库 `review-log.jsonl`
每次评审记 `{ at, taskId, type, title, scores, verdict, override? }`；用户对 challenged 回复"坚持修改"、或 owner 对被质疑/拒绝任务手动点「开始开发」→ 记 `override:'proceed'`。评审 prompt 自动注入**最近 N=5 条 override 判例**做 few-shot 校准——人工纠偏沉淀为评审经验。

## 四、评审门（核心，抑制"倾向修改"偏置）

模块 `src/plugins/team-tools/review/`（共享模块，非 feature）：

1. **AI 只打分不判决**：`reviewTask(task)` 只读调用（Read/Grep/Glob，cwd=bot.projectDir，注入工程说明），强制 JSON 输出：
   `{ belongs(bool+证据), type, located(bug 须定位到具体文件/原因), complexity 1-5, benefit 1-5, risk 1-5, confidence 0-1, counterArgument(必填，先写"为什么应拒绝"), reasons }`
2. **判决矩阵为纯函数** `decideVerdict(r)`（可单测，AI 无权直接说"改"）：
   - `!belongs` 或证据为空 → `reject`
   - `confidence < 0.6` → `ask`（默认保守：不确定一律问）
   - bug：`located ? 'fix' : 'ask'`（定位不到具体原因绝不自动修）
   - feature：`benefit - complexity >= 0 ? 'plan' : 'ask'`
   - JSON 解析失败 → `ask`
3. **verdict 处置**：
   - `reject` → 任务 rejected + 回复来源"不属于本项目/证据不足 + 理由"
   - `ask` → 任务 challenged + 回复质疑理由 +「如仍需处理，回复"坚持修改"」；用户肯定答复 → override 进流程并记判例；否定 → rejected
   - `fix` → 自动开发管线（BUG）
   - `plan` → analyze 生成方案 → analyzed；medium 等 owner 确认（飞书 triage /「开始开发」按钮），full 直接进自动开发管线

challenged 的答复识别：feedback feature 增加 `hasPending(ctx)`——存在该用户同会话 30 分钟内的 challenged 任务，且文本命中肯定词（坚持/继续/确认修改/是）或否定词（算了/不用了/取消）才接管，否则放行正常分流。

## 五、自动开发管线（medium/full 共用）

模块 `src/plugins/team-tools/auto-dev/`（吸收原 unattended 的 git.js/compile.js 与 buildCommitMessage）：

**队列模型（审查后修订）：「任务状态即队列」**——入队 = 锁内把任务置 `status:'queued'`（tasks.json 跨进程安全），
泵（`startAutoDevPump`，5s 轮询）**只在 claude-web 进程跑**，feishu 进程只标记状态不执行；
彻底避免 web/feishu 双进程并发操作同一 git 工作区，状态落盘天然获得崩溃/重启续跑（`recoverOnBoot`：
developing+auto 任务退回 analyzed 并尽力把工作区切回 baseBranch）。任务同时快照 `repo` 字段，
合并永远在开发时的仓库上执行，不受此后切换启用机器人影响；基线守卫拒绝把 `auto/*` 分支当基线。

```
autoDevelop(task):
  repo = activeBot.projectDir || config.feedback.frontendDir
  baseBranch = currentBranch(repo)   // 快照为合并目标
  ensureBranch(repo, `auto/<taskId>`)
  updateTask(developing, { branch, baseBranch, auto:true })
  develop(task)（task-ops，工程边界/说明已注入）
  commitAll(repo, buildCommitMessage(task, ok))
  checkout 回 baseBranch              // 关键：防止下一任务把 auto 分支快照成 base
  compileDevQrcode({repo, branch})    // 可用则附二维码（push + 编译脚本）
  replySource(task, ok, qrUrl)        // 回复来源会话（原 unattended 群播报退役）
  updateTask(done, { auto:true, merged:false })
```

task-triage / web「开始开发」在 medium/full 下改走此管线；light 保持原地 develop 现状。

## 六、合并到主分支

git.js 新增：
- `isClean(repo)` — `git status --porcelain` 为空
- `mergeBranch(repo, source, target)` — 校验 source/target 存在、工作区干净 → checkout target → `merge --no-ff source` → 冲突则 `merge --abort` 并切回原分支，返回 `{ ok:false, conflict:true }`，绝不留半合并状态

API：`POST /api/tasks/action { id, action:'merge' }` → 校验 `auto && done && !merged && branch && baseBranch` → mergeBranch → 成功 `merged:true, mergedAt`；失败写 `mergeError`。

UI（tasks-panel）：
- [自动完成] 徽标（auto）；done && auto && !merged 显示 **[合并到主分支]** 按钮
- 点击弹确认框，**明示 `auto/xxx` → `<baseBranch>` 分支名**（防合错的二次提醒），danger 样式
- 顶部新增筛选 chip **[自动处理]**：过滤 `auto && done && !merged`
- 状态徽标补 `reviewing 评审中`、`challenged 已质疑`；merged 显示"已合并"

## 七、完全托管项目问答

新 feature `project-qa`（team-tools 内，`permission:'any'`，`intents:['other']`，order 在 feedback 之后）：
- `autonomy==='full'`：只读 runClaude（Read/Grep/Glob，cwd=projectDir，persona+工程说明注入），基于项目回答；单轮无状态
- 否则回落 `msg('welcome')`（原兜底行为不变）
- owner 不经此路（claude-exec 已全接）；中途提出需求/故障由现有分流优先捕获（顺序天然保证）

## 八、无人值守退役清单

- UI：tasks 面板胶囊开关 + unattendedInfo 移除（index.html + tasks-panel.js 的 uaEnabled 逻辑与「开始开发」隐藏条件）
- 路由：`/api/unattended` 删除；`GET /api/tasks` 不再返回 unattended 态
- 启动：web 入口 `resumeOnBoot()` 调用移除
- 模块：`unattended/index.js`、`store/unattended.js`（含测试）删除；git.js/compile.js/buildCommitMessage 迁入 `auto-dev/`；pickNext/buildGroupMessage/buildBranchName 随批量模式删除
- config：`config.unattended` 改名 `config.autoDev`（保留 compileScript；groupId 删除）

## 九、测试

- `decideVerdict` 判决矩阵全分支单测（默认 ask / 未定位 ask / 低收益 ask / 非本项目 reject / JSON 失败 ask）
- 评审 JSON 解析容错、判例库读写与 few-shot 注入拼装
- `mergeBranch`：临时 git 仓库真实单测（成功 / 冲突 abort / 脏工作区拒绝）
- tasks store 新字段透传；bot autonomy 归一与校验
- 手动：三档行为逐一走查（脚本、收集、评审拒绝/质疑/坚持、BUG 自动修、需求确认、合并、冲突、项目问答）

## 十、本期不做

- 多机器人并发在线（沿用单启用）
- 项目问答多轮会话记忆
- PR 流程（合并为本地 merge --no-ff）
- 评审阈值可配置（先固定：confidence 0.6、benefit-complexity ≥ 0；判例库先行积累）

# 无人值守模式（Unattended Mode）设计

- 日期：2026-07-27
- 状态：已与用户确认 4 项关键决策，待评审
- 范围：需求/故障面板新增「无人值守」胶囊开关，开启后自动串行处理任务、逐条回飞书、全部完成后 DEV 编译并把二维码+标题清单发到指定群。

## 1. 背景与目标

现状（核对自代码）：飞书收到需求/BUG → 意图识别 → `feedback` 插件建 `Task`（`new`）→ 自动 `analyze`（只读）→ `analyzed`；此后必须**人工**在飞书回「待处理/开始处理」（`task-triage`）或在 web 面板点「开始开发」才会 `develop`（`bypassPermissions` 真改码，cwd = `getUiPrefs().taskProjectDir || kxmall-app-ui`）→ `done`。web 触发的完成**不回飞书**；任务 `source` 只存 `openId`、**不存 chatId**。

目标：在需求/故障面板加一个默认关闭的「无人值守」胶囊开关。开启后系统**主动**把待办处理完，逐条向来源会话回「处理完成」，并在**全部处理完**时自动 DEV 编译无人值守分支、把二维码 + 本轮标题清单发到群 `oc_24f041c3815632e4b475a5f269cac34a`。

### 已确认的 4 项决策
1. **处理范围**：存量待办（`new/analyzing/analyzed`）+ 开启后新到的，直到队列清空。
2. **分支与提交**：开启时基于当前 HEAD 新建并切到 `unattended/<YYYYMMDD-HHmm>`；每个任务开发完在该分支上自动 `git commit`。
3. **编译方式**：仅 DEV。编译**无人值守分支**（push 分支 → 触发 CI 以该分支为 ref → 轮询 OSS 取二维码 URL），复用现有 `get_qrcode.py` 的 dev 触发/轮询逻辑，为其增加 `--branch` 覆盖。用户确认 CI/push「应该支持」（实现期需真机核验）。
4. **完成回复**：逐条回**来源会话**（需补存 chatId）；最终二维码+标题清单固定发到群 `oc_24f041c3815632e4b475a5f269cac34a`。

## 2. 总体架构与进程落位

- **控制器循环**跑在 **claude-web** 进程（开关在 web 面板；`task-ops.develop` 已在 web 侧被调用）。
- **feedback 补存 chatId** 改动在 **claude-feishu** 进程生效（需 `pm2 restart claude-feishu`）。
- **共享底座**：`tasks.json`（web 与飞书都读写，带锁）。控制器靠轮询 `getTasks()` 感知新任务，无需跨进程事件总线。
- **飞书发消息**：`src/integrations/lark.js` 的 `sendText` / `sendImageByUrl` 可从 claude-web 直接调用（凭证走 `getLarkCredentials()`，settings.json/env 共享）。实现期需确认 claude-web 进程能读到飞书凭证。

数据流：
```
开启开关 → 建/切 unattended 分支 → 控制器 pump() 循环:
  取下一个可处理任务 →（必要时 analyze）→ develop（在分支上真改码）
    → git commit → 回来源会话「✅ 处理完成」
  队列清空且本轮≥1条 → push 分支 → CI DEV 编译 → 取二维码 URL
    → 发群: 标题清单(仅标题) + 二维码图片
关闭开关 → 处理完当前一条后停止取新任务（不触发编译）
```

## 3. 组件设计（隔离、单一职责）

### 3.1 新增：状态存储 `src/store/unattended.js`
落盘 `unattended.json`（经 `store/index.js` 的 `readJson/writeJson`，与其它 store 一致；文件加入 `.gitignore`）。字段：
```
{
  enabled: boolean,            // 开关
  repo: string,                // 目标仓库绝对路径（快照自开启时）
  branch: string,              // 无人值守分支名
  startedAt: ISOString,
  batch: [{ taskId, title, type, ok }],  // 本轮已处理（编译后清空）
  compiledAt: ISOString|null
}
```
导出：`getState()` / `setEnabled(bool)` / `setBranch()` / `addToBatch(item)` / `clearBatch()` / `markCompiled()`。纯读写，无业务逻辑。

### 3.2 新增：纯逻辑 `src/plugins/team-tools/unattended/logic.js`（可单测，无副作用）
- `pickNext(tasks)` → `{ action:'develop'|'analyze'|'wait'|'idle', task? }`
  - 有 `analyzed` → develop（排序：bug 优先、createdAt 升序，复用 triage 的 `sortForTriage` 思路）
  - 否则有 `new/confirmed` 且无 `analyzing` → analyze
  - 否则有 `analyzing/developing` → wait（feedback 自身的 analyze 在途）
  - 否则 → idle（已清空）
- `isDrained(tasks)` → 无任务处于 `{new,confirmed,analyzing,analyzed,developing}`
- `buildBranchName(date)` → `unattended/YYYYMMDD-HHmm`
- `buildCommitMessage(task, ok)` → `"<type>: <title> (task <id>)"`（失败附 `[failed]`）
- `buildGroupMessage(batch)` → 群文本：标题头 + **仅标题**逐行（`🐞 <title>` / `✦ <title>`）
- `parseQrUrl(stdout)` → 从脚本输出提取最后一个图片直链（png/jpg，允许 `?t=` 尾参），无则 null

### 3.3 新增：git 助手 `src/plugins/team-tools/unattended/git.js`
封装子进程 git（`src/integrations/shell.js runScript` 或 `execFile`，`windowsHide:true`）：
- `currentBranch(repo)` → string
- `ensureBranch(repo, branch)`：不在该分支则 `checkout -b`（已存在则 `checkout`）；返回是否新建
- `commitAll(repo, message)`：`git add -A` → 有暂存变更才 `commit`；返回是否有提交
- `pushBranch(repo, branch)`：`git push -u origin <branch>`
命令参数拼装抽成纯函数便于单测；实际执行有错不抛，返回 `{ok, out, err}`，由控制器决策。

### 3.4 新增：编译适配器 `src/plugins/team-tools/unattended/compile.js`
契约：`compileDevQrcode({ repo, branch }) → { ok, qrUrl, log }`
1. `pushBranch(repo, branch)`（失败则 `ok:false`，log 记录）
2. 经 `runScript` 调用 DEV 编译脚本（路径 `config.scripts.dir`，脚本名 `config.unattended.compileScript`，默认 `get_qrcode.py`），参数 `--env dev --branch <branch>`
3. `parseQrUrl(stdout)` 取二维码 URL
说明：`get_qrcode.py` 现在会自取最新 `v*` 分支；需为其**新增 `--branch` 覆盖**（该文件 git-ignored、含硬编码后台凭证，属用户侧配套改动，实现期一并改）。其 `trigger-build` API 本就按 `ref=branch` 参数化，OSS 轮询与 URL 也按 `{branch}` 组织，故按分支构建可行。

### 3.5 新增：控制器 `src/plugins/team-tools/unattended/index.js`
职责：编排循环，串行、单飞。
- `enable()`：`setEnabled(true)` → 快照 `repo = getUiPrefs().taskProjectDir || config.feedback.frontendDir` → `branch = buildBranchName(now)` → `ensureBranch` → 启动 `pump()`
- `disable()`：`setEnabled(false)`（`pump` 在下一步自然退出）
- `getStatus()`：给 web 面板回显 `{enabled, branch, batch, running}`
- `resumeOnBoot()`：claude-web 启动时若 `enabled` 则 `ensureBranch` + `pump()`（batch 从盘恢复，续报）
- `pump()`（`pumping` 布尔单飞，防重入）：
  ```
  while (getState().enabled):
    next = pickNext(getTasks())
    develop → runDevelop(task); continue
    analyze → await analyze(task); continue
    wait    → await sleep(POLL); continue
    idle    → if batch.length && !compiledThisBatch: await compileAndReport()
              await sleep(POLL)
  ```
- `runDevelop(task)`：`ensureBranch` → `updateTask(status:'developing','无人值守开发')` → `{ok,log}=await develop(task)`（task-ops 置 done）→ `commitAll(repo, buildCommitMessage(task,ok))` → 回来源会话 → `addToBatch({...})`
- `compileAndReport()`：`compileDevQrcode` → `sendText(groupId, buildGroupMessage(batch))` → 有 URL 则 `sendImageByUrl(groupId, qrUrl)`，否则发「⚠️ 编译未产出二维码」→ `markCompiled()` + `clearBatch()`
- 回来源会话：仅当 `task.source.chatId` 存在且 `via==='feishu'`：`sendText(chatId, ok?"✅ 已处理完成：<title>":"❌ 处理失败：<title>\n<log 末尾500字>")`；无 chatId 记 `logger.warn` 跳过。

### 3.6 修改点
- `src/plugins/team-tools/feedback/index.js`：`source` 增加 `chatId: ctx.meta?.chatId || ctx.sessionKey`（claude-feishu）。
- `src/entrypoints/web/routes-ops.js`：`handleTasks` 响应改为 `{ tasks, unattended: getStatus() }`（面板已轮询 `/api/tasks`，零新增轮询）；新增 `handleUnattended(req,res)`（GET 回状态、POST `{enabled}` 切换 → `enable()/disable()`），受 `getPluginEnabled('team-tools')` 门控。
- `src/entrypoints/web/server.js`：注册 `/api/unattended`；`listen` 回调调用 `unattended.resumeOnBoot()`。
- `public/index.html`：任务面板 `panel-head`（第 325-328 行）在 `<h3>需求 / 故障</h3>` 旁加胶囊开关容器 + 分支/进度行。
- `public/js/tasks-panel.js`：`loadTasks` 读 `unattended` 字段渲染开关态/分支/本轮进度；胶囊点击 → `POST /api/unattended`；开启时隐藏各卡片「开始开发」按钮（避免与控制器并发）。
- `public/app.css`：胶囊开关样式（滑块、开=强调色/关=灰）。
- `src/shared/config.js`：新增 `config.unattended = { groupId: process.env.UNATTENDED_GROUP_ID || 'oc_24f041c3815632e4b475a5f269cac34a', compileScript: process.env.UNATTENDED_COMPILE_SCRIPT || 'get_qrcode.py', branchPrefix: 'unattended' }`。
- `scripts/get_qrcode.py`（git-ignored 配套）：新增 `--branch <name>` 覆盖自取 `v*` 的行为。

## 4. UI

任务面板 `panel-head` 内，标题右侧：
```
需求 / 故障   [ 无人值守 ●——○ ]        ✕
             分支 unattended/20260727-1430 · 本轮已处理 3
```
- 胶囊：关=灰底左滑块；开=强调色右滑块。点击即时 `POST /api/unattended`，成功后由下一轮 `loadTasks` 回显（乐观更新可选）。
- 开启态下卡片隐藏「开始开发」（补充/移除保留），提示「由无人值守自动处理」。

## 5. 错误处理与边界

- 开启时目标仓库有未提交改动：`checkout -b` 会带过去，首个任务提交时一并纳入；记 `logger.warn` 提示。
- 分支名同分钟碰撞：`ensureBranch` 若已存在同名则直接 checkout 复用（同一分钟重复开启视为续用）。
- `develop` 失败（`ok:false`）：task-ops 仍置 `done`；控制器照常 `commitAll`（隔离半改动，commit message 标 `[failed]`）+ 回来源会话失败文案，循环继续。
- push / CI / 编译失败：`compileAndReport` 仍发标题清单，附「⚠️ 编译未产出二维码 + log 摘要」；不崩循环；`markCompiled` 仍置位避免死循环（下一轮新任务到来再触发新一轮编译）。
- 无 chatId 的存量任务：跳过逐条回复，记 warn。
- 跨进程并发：控制器（web）与 `task-triage`（feishu）都会改同一仓库；单飞仅保证 web 侧串行。**已知限制**：无人值守开启期间不要在飞书走 `待处理/开始处理` 人工流程。web 侧靠隐藏「开始开发」按钮规避。
- 关闭开关：`pump` 处理完当前一条后退出；未清空则**不编译**（编译只在自然清空时触发，契合「全部处理完」）；分支/batch 保留，再次开启续跑。
- 二维码 DEV URL 有效期约 20 分钟：编译成功后立即发群。

## 6. 测试

- `unattended/logic.test.js`（node --test，离线）：`pickNext` 各分支、`isDrained`、`buildBranchName`、`buildCommitMessage`、`buildGroupMessage`（仅标题、bug/feature 图标）、`parseQrUrl`（含/不含 URL、带 `?t=`）。
- `git.js` 命令参数拼装纯函数单测。
- `compile.js`：`parseQrUrl` 覆盖已在 logic；脚本调用与 push 走注入/mock。
- 真机验证（实现末尾）：web 开开关 → 确认分支创建 → 观察串行 develop + 每条 commit + 来源会话回复 → 清空后 DEV 编译 → 群里收到标题清单 + 二维码；关开关后不再取新任务。

## 7. 部署

- 改 web（控制器/路由/前端/config/store）→ `pm2 restart claude-web`。
- 改 feedback（chatId）→ `pm2 restart claude-feishu`。
- `get_qrcode.py` 加 `--branch`（git-ignored 配套，随实现落地）。

## 8. 非目标（YAGNI）

- prod/trial 编译（本期仅 DEV）。
- 无人值守分支的自动合并 / 建 PR / 清理。
- 修复既有 web 与 triage 的跨路径并发（既存问题，超范围）。
- 二维码本地生成（沿用 CI+OSS 产物）。

## 9. 成功标准

1. 面板出现「无人值守」胶囊，默认关，状态持久化（重启 web 后保持）。
2. 开启即在目标仓库建 `unattended/<日期>` 分支。
3. 存量 + 新到任务被串行自动开发，每条一次 commit，来源会话收到「处理完成」。
4. 队列清空 → DEV 编译该分支 → 群 `oc_24f041c3815632e4b475a5f269cac34a` 收到「仅标题」清单 + 二维码图片。
5. 关闭开关后不再拾取新任务。

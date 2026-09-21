# 自动合并 + 放弃语义分叉 + 巡检缺图人工兜底 · 设计

日期：2026-09-19
状态：已拍板，待实现

## 背景

BUG 巡检功能实测通过，每条 BUG 已各自修在独立任务分支上。当前合并是**人工触发**的：任务落 `done` 后停在待合并态，等维护者在行为态势面板或飞书卡片上点「合并到主分支」。

维护者要把这一步自动化：**新建分支改 → 改完自动合并回当前分支**。随之而来的是「放弃改动」的语义变化——分支已进主干，删分支不再等于撤销。

同时补一条巡检出口：遇到「需要新增 UI 但图片资源拿不到」的 BUG，AI 修不了（只会编占位资源），必须交人工。

## 现状（改动前）

| 环节 | 现状 | 落点 |
|---|---|---|
| 改码 | 常驻 `<repo>.auto` worktree 上 `checkout -B fix/xxx <当前分支>` | `auto-dev/index.js#runOne` |
| 完成 | `status='done'`、`merged=false`，等人工 | 同上 |
| 合并 | 人工点按钮 → `mergeBranch`（路径 A 原地 / 路径 B 临时 worktree） | `task-actions.js#mergeTaskById`、`auto-dev/git.js` |
| 放弃 | `git branch -D` 删未合并的任务分支 | `task-actions.js#discardTaskById`、`git.js#deleteBranch` |
| 巡检出口 | 前端自动修 / 后端转派 两条 | `bug-patrol/index.js#runPatrolRound` |

## 拍板结论

1. **自动合并适用全部 auto-dev 任务**（不只巡检）——一套行为一个心智模型，面板与飞书卡片逻辑不分叉。
2. **放弃 = 先试 `git revert`，冲突了才调 LLM 收拾**——revert 是确定性操作，绝大多数情况一步到位且零额度消耗。
3. **缺图 BUG 的出口 = 不建任务、多维表格保持指派给维护者、汇报里单列「待人工处理」**。
4. **缺图判定扒进现有归属判定**，并补一条「无需求关联时也跑」的精简路径，保证全覆盖。
5. **缺图记录记入 `seen`**，同一轮 12 小时循环里不重扫。

---

## 一、自动合并

### 1.1 落点与顺序

`auto-dev/index.js#runOne` 中 `updateTask(task.id, { status: 'done' }, ...)` 之后、`notifyTaskDone` 之前，插入一次 `await mergeTaskById(task.id)`。

**复用 `task-actions.js#mergeTaskById` 而非另写**：`merged` / `mergedAt` / `mergeError` 的写法、提交钩子被绕过时的留痕文案、失败时不改状态的纪律，全部继承。另写一份必然与人工路径分叉。

依赖方向：`auto-dev/index.js → task-actions.js → auto-dev/git.js`。无环——`task-actions.js` 只 import `git.js`，不 import `auto-dev/index.js`；且 `auto-dev/index.js → task-notify.js → task-actions.js` 这条链本就存在。

顺序约束：必须在 `status='done'` **之后**调，因为 `isAwaitingMerge` 谓词要求 `status==='done'`。

### 1.2 新增字段 `mergeCommit`

`git.js#runMergeIn` 合并成功后追加一次 `git -C <dir> rev-parse HEAD`，把 merge commit 的 sha 随结果返回；`mergeTaskById` 成功分支把它写进任务。

**这是「放弃」能精确 revert 的唯一锚点**。合并那一刻不记，事后无从反推——baseBranch 上可能已经叠了别的任务的合并提交。

`rev-parse` 失败（理论上不会）不算合并失败：合并已经成功，只是丢了锚点，`mergeCommit` 留空，放弃时降级为「无锚点，直接转 LLM 处理」。

### 1.3 新增字段 `autoMerged`

`mergeTaskById` 增加一个可选参数标识调用来源（自动 / 人工），成功时写 `autoMerged: true|false`。仅供面板与卡片区分文案，不参与任何判定。

### 1.4 失败即降级回现状

合并冲突、工作区脏、目标分支不存在等一切失败：任务停在 `status='done'` + `mergeError`，`merged` 仍为 `false`。面板与飞书卡片照旧给 [合并到主分支][放弃改动]，放弃走删分支老路径。**不写任何新分支逻辑**。

### 1.5 文案

- `auto-dev/index.js#replySource`：成功且已自动合并 → 「✅ [故障]「X」已自动完成并合并到 `<baseBranch>`（分支 `<branch>`）。」；合并失败 → 保留原「等待管理员确认合并」文案并附失败原因。
- `task-notify.logic.js#buildTaskDoneCard`：已自动合并的任务不再渲染 [合并到主分支] 按钮，改为展示「已自动合并到 `<baseBranch>`」，保留 [补充][放弃改动]。

---

## 二、放弃的语义分叉

### 2.1 谓词放宽

```js
// task-actions.js
export function isDiscardable(task) {
  return !!(task && task.auto && task.status === 'done' && task.branch && !task.discarded);
}
```

去掉 `!task.merged`：合并前后都可放弃。`discarded` 的任务 `status` 已是 `'rejected'`，`status==='done'` 天然排除重复放弃，加 `!task.discarded` 是双保险（防历史脏数据）。

`isAwaitingMerge` 不动——它只服务于「合并失败降级态」下的 [合并到主分支] 按钮。

### 2.2 三条路径

`discardTaskById` 按 `task.merged` 分流：

| 前置状态 | 处理 | 终态 |
|---|---|---|
| `merged=false` | `git branch -D <branch>`（现状不变） | `rejected` + `discarded` |
| `merged=true` + 有 `mergeCommit` | `git revert -m 1 <mergeCommit> --no-edit` → 成功则删任务分支 | `rejected` + `discarded` + `revertedAt` |
| revert 冲突 / 无 `mergeCommit` | `git revert --abort` → 起 Claude 撤销 → `commitAll` → 删任务分支 | 同上，另记 `revertedBy: 'llm'` |

任一步失败都**不改任务状态**，原样上报错误——绝不留「已放弃但改动还在」的半放弃态（与现有 `deleteBranch` 失败时的纪律一致）。

### 2.3 执行目录：抽 `withBranchWorktree` 共用

`mergeBranch` 现有的路径 A/B 分流（主工作区在目标分支则原地、否则建临时 worktree）对 revert 完全同构，抽成通用高阶函数：

```js
// git.js
export async function withBranchWorktree(repo, target, fn) // → fn(dir) 的返回值
```

- 路径 A：`currentBranch(repo) === target` → `fn(repo)`
- 路径 B：`worktree prune` → `worktree remove --force <tmpDir>`（幂等清残留）→ `worktree add <tmpDir> <target>` → `fn(tmpDir)` → `finally` 删除临时 worktree

`mergeBranch` 与新增的 `revertMerge` 都走它。临时目录后缀区分：合并用 `.merge-tmp`（现状），revert 用 `.revert-tmp`，避免两个操作撞目录。

### 2.4 LLM 兜底

新建 `auto-dev/revert.js`，导出 `revertMergeCommit(repo, { task, mergeCommit })`：

1. `withBranchWorktree(repo, task.baseBranch, dir => …)` 内执行 `git -C dir revert -m 1 <mergeCommit> --no-edit`
2. 成功 → 返回 `{ ok: true, by: 'git' }`
3. 失败 → `git -C dir revert --abort`，起 Claude：
   - `cwd: dir`、`permissionMode: 'bypassPermissions'`（要改码）
   - prompt 要点：给出 merge commit sha、任务标题与描述；要求**只撤销该次合并引入的改动，保留此后其他提交对同一文件的修改**；改完不要自己 commit（由调用方 `commitAll` 统一提交，与 auto-dev 管线一致）
   - 超时沿用 `SIDE_TIMEOUT_MS` 同档（5 分钟），超时按失败处理
4. Claude 返回后 `commitAll(dir, 'revert: 放弃「<title>」的自动改动')`；无改动产生视为失败
5. 返回 `{ ok: true, by: 'llm' }` 或 `{ ok: false, error }`

prompt 与输出判定抽 `revert.logic.js` 纯函数（`buildRevertPrompt`、`revertCommitMessage`），对齐 `side-review` 的分层。

### 2.5 必须写进文档的边界

**路径 A 下，revert 与 LLM 兜底直接作用在维护者的主工作区**——因为它就在目标分支上，git 不允许同一分支被两个 worktree 检出。这与自动合并本身的影响面一致（自动合并在路径 A 下同样直接改主工作区文件），不是新增风险，但必须让人知道。

---

## 三、巡检缺图人工兜底

### 3.1 判定扩展

`side-review.logic.js`：

- `buildSidePrompt` 增加判定维度与输出字段：
  ```json
  {"side":"...","evidence":"...","advice":"...","blocked":"|need-assets","blockReason":"缺什么资源"}
  ```
  判据写清：BUG 要求新增或替换 UI 元素（图标 / 插画 / banner / 背景图等），而**记录附件里没有可用设计稿或切图、代码库里也不存在对应资源**时填 `need-assets`；能用现有资源或纯样式改动完成的**不算**。
- `parseSideJson` 解析新字段，非法值一律归 `''`（沿用「判不准就走保守路径」的铁律；此处保守 = 不拦截，照常修）。
- 新增 `buildAssetOnlyPrompt`：只判缺图、不判前后端的精简 prompt，输出 `{"blocked":"...","blockReason":"..."}`。

### 3.2 覆盖全量

`bug-patrol/index.js#runPatrolRound` 现在只在 `canJudgeSide`（关联测试期需求 + 前后端目录齐备）时跑归属判定，无关联就漏判缺图。补路径：

- `canJudgeSide === true` → 跑完整 `reviewSideWithTimeout`，同时拿 `side` 与 `blocked`
- `canJudgeSide === false` → 跑 `reviewSideWithTimeout(..., { assetOnly: true })`，cwd 用 `getActiveBot()?.projectDir || config.feedback.frontendDir`，只拿 `blocked`，`side` 恒为 `'frontend'`

`side-review.js#reviewSideWithTimeout` 增加 `assetOnly` 选项，走精简 prompt；超时与异常兜底不变（落 `{ side:'unknown', blocked:'' }`——判不准不拦截）。

成本：无需求关联的巡检，每条确认缺陷的记录多一次只读调用。这是拍板接受的代价，换取全覆盖。

### 3.3 出口

**只在 `verdict === 'fix'` 路径上生效**（归属判定之后、写表之前短路）。`reject` 那条支线本就不修，只做「是不是后端的活」判断，不需要缺图兜底，也不该为它多付一次判定。

`blocked === 'need-assets'` 时：

- **不写表**：状态保持「待处理」、人员字段保持指派给维护者
- **不建任务**、不入自动开发队列
- `markSeen(rec.record_id, { verdict: 'fix', blocked: 'need-assets' })`
- `pushReport('needHuman', { title, reason: blockReason })`

### 3.4 store 与汇报

**`store/patrol-loop.js` 必须改两处，漏一处 `needHuman` 每次读盘都会被静默抹掉**：

1. `DEFAULT_LOOP.report` 加 `needHuman: []`
2. `normalizeLoop` 的 `report` 字面量加 `needHuman: arr(rep.needHuman)`

（`pushReport` 靠「`cur.report[kind]` 已是数组」做隐式白名单，`normalizeLoop` 不透传就等于永远不是数组。）

`loop.logic.js`：

- `hasAnything` 的 kind 列表加 `'needHuman'`
- `buildRoundReport` 加一节：`🙋 待你人工处理（N 条）`，每条渲染 `${title} —— ${reason || '缺少图片资源'}`，排在「已转后端」之后、「归属判不准」之前

---

## 四、行为态势面板

`public/js/tasks-panel.js`：

- 自动完成徽标：`t.merged` 时按 `t.autoMerged` 分文案——`'自动完成 · 已自动合并'` / `'自动完成 · 已合并'`；未合并仍为 `'自动完成'`
- 新增前端谓词 `isDiscardable(t)`，与后端同口径：`!!t.auto && t.status==='done' && !!t.branch && !t.discarded`
- `actionsFor`：已合并任务当前返回 `null`（无操作），改为渲染 [放弃修改]
- `discardTask` 的二次确认按已合并与否分文案：已合并 → 「将撤销已合并进「`<baseBranch>`」的改动（自动 revert，冲突时交由 AI 处理）」；未合并 → 保留现文案
- 分支信息行：已放弃时按 `t.revertedAt` 是否存在分文案——有 → 「分支 `<branch>` 的改动已从 `<baseBranch>` 撤销（已放弃）」；无 → 保留现「分支 `<branch>` 已删除（已放弃改动）」

## 五、测试

| 文件 | 新增覆盖 |
|---|---|
| `auto-dev/git.test.js` | `withBranchWorktree` 两条路径；`runMergeIn` 回填 `mergeCommit`；`revertMergeCommit` 的 git 成功路径与冲突路径（真实 git 仓库，LLM 注入桩） |
| `task-actions.test.js` | `isDiscardable` 放宽后的边界；已合并任务放弃走 revert；revert 失败不改状态 |
| `side-review.logic.test.js` | `blocked` 字段解析（合法 / 非法 / 缺失）；`buildAssetOnlyPrompt` 形状 |
| `loop.logic.test.js` | `hasAnything` 纳入 `needHuman`；`buildRoundReport` 新分组渲染与排序 |
| `patrol-loop.test.js` | `normalizeLoop` 透传 `needHuman`；`pushReport('needHuman')` 写盘 |

## 六、明确不做（YAGNI）

- 不加「是否自动合并」的设置开关——统一行为，需要时再加
- 不做合并前的自动化测试闸（`project-optimize/test-gate.js` 那套不并入本链路）
- 不做「放弃」的时间窗限制——只要任务在 `done` 且未放弃就一直可撤
- 不回写多维表格状态（沿用现状：维护者自行修改）

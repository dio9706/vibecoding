# 自动开发自检门（Verify Gate）· 设计

- 日期：2026-09-30
- 状态：已实现（Phase 1 + Phase 2，2026-09-30）；Phase 3 待排期
- 关联：`docs/superpowers/specs/2026-07-29-feishu-conversation-and-autodev-design.md`（auto-dev 管线）、`2026-09-18-patrol-loop-design.md`（失败重试/升级先例）
- 外部参考：mini-swe-agent（把「完成」交给外部验证器，agent 只负责改到测试过）、OpenHands（任务终态如实汇报）、pi/pi-durable 分析（任务检查点与提交先于展示）

## 1. 背景与目标

现状（`src/plugins/team-tools/auto-dev/index.js#runOne`）：自动开发的「完成」判据是「`develop()` 没抛错 + `commitAll` 有代码改动」——没有任何客观验证。模型说完成就 `status='done'` 进合并队列。

无人值守会把错误放大：**改坏了测试、破坏了构建，照样合并进主分支**。这是「质量 + 自主」定位下最贵的一类事故。

本设计要达成：

1. 「完成」由**可配置的验证命令**（测试/构建/lint）判定，而不是模型自述；
2. 验证不通过 → 带着失败输出自动重试开发（1 次）→ 仍失败则如实退回 `analyzed` 并通知 owner（卡片带失败摘要）；
3. 验证能力做成通用 capability（`src/capabilities/verifier.js`），为 openai 路径（自定义模型）与后续「先复现再修复」复用预留接口。

**非目标**（本期不做）：

- 不做「先写失败用例复现」——那是下一步，依赖本期的验证器基建；
- 不做多命令数组/并行验证——单行命令，可 `&&` 串联；
- 不改 openai 路径（Phase 3 单独接线）；不改 `req-inspect` / `patrol` / `task-actions` 的既有行为。

## 2. 拍板记录（2026-09-30 已确认）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 配置形态 | 机器人级 `verifyScript` 单行 shell 命令，与 `setupScript` 同构（多命令数组留到有需求时） |
| 2 | 未配置时的行为 | 跳过验证，卡片注明「未配置自检」（命令无法启动同样 fail-open 跳过） |
| 3 | 失败重试次数 | 1 次（共 2 次尝试），常量不做配置 |
| 4 | 失败现场 | 照旧 `commitAll` 提交留痕 + 退回 `analyzed`（沿用现状语义） |
| 5 | 自动发现（Phase 2） | 要：检测到 `package.json` 有 `test` 脚本且未显式配置 → 用 `npm test`；命令无法启动时 fail-open 跳过 |
| 6 | openai 路径（Phase 3）时机 | 下期接；本期只预留 capability 接口 |

> 决策 4 的理由：现状 `develop()` 失败也会走 `commitAll`（把半成品提交留痕，避免下次任务自愈时混入）。验证失败同样不能丢现场——卡片给「补充」按钮，人工可基于提交继续交代。

## 3. 架构

### 3.1 流程（`runOne` 改动焦点）

```
runOne(task)
  ├─ develop(task, { cwd: autoDir, deferStatus: true, verifyCommand, verifyFeedback? })
  ├─ [新] verifyWithRetry(task, autoDir)          ← 仅 r.ok 时执行
  │     ├─ runVerify() 通过 → 记录 + 继续
  │     └─ 失败 → develop(task, { …, verifyFeedback: 失败摘要 }) 重试一次 → 再验证
  ├─ commitAll(autoDir, …)                        ← 保持现状：验证失败也提交留痕
  ├─ r.ok / c.committed 判定                      ← 保持现状
  ├─ [新] 验证最终不通过 → updateTask(analyzed) + notifyTaskDone(false) + replySource → return
  └─ status=done → mergeTaskById → …              ← 保持现状
```

验证与提交的顺序：**先验证、后提交**。验证命令自身产生的改动（如快照测试产物）与开发改动一并提交，符合「提交出来的是完成态」。

### 3.2 新增文件

| 文件 | 职责 | 依赖方向 |
|---|---|---|
| `src/capabilities/verifier.js` | `runVerify({ cwd, command, timeoutMs, signal })`：跑验证命令，归一结果（跳过/通过/失败/超时） | → `integrations/shell.js`（`runScript`）/ `verifier.logic.js` / `shared/logger` |
| `src/capabilities/verifier.logic.js` | 纯函数：输出截断（头+尾）、摘要构建、ok 判定、跳过语义 | 零 IO |
| `src/capabilities/verifier.test.js` | 真 shell 冒烟（参照 `providers/builtin-tools.test.js` 的 tmp 工作区做法） | — |
| `src/capabilities/verifier.logic.test.js` | 截断/摘要/判定的单测 | — |
| `src/plugins/team-tools/auto-dev/verify.logic.js` | 纯函数：重试 prompt 片段构造、重试决策、验证文案 | 零 IO |
| `src/plugins/team-tools/auto-dev/verify.logic.test.js` | 上者的单测 | — |

### 3.3 改动文件

| 文件 | 改动 |
|---|---|
| `auto-dev/index.js` | `runOne` 插入验证 + 重试 + 失败路径；新增内部 `verifyWithRetry` |
| `team-tools/task-ops.js#develop` | opts 新增 `verifyCommand` / `verifyFeedback`；prompt 追加【完成标准】/【上次未通过自检】段 |
| `store/settings.js` | `makeBotEntry` / `addBot` 收录 `verifyScript`（string，trim） |
| `entrypoints/web/routes-settings.js` | bot PATCH 白名单收录 `verifyScript`（与 `setupScript` 同校验风格，长度上限 500） |
| `team-tools/task-notify.logic.js` | 卡片与降级纯文本增加「自检」行 |
| `public/js/bots-panel.js` ✅（Phase 2） | 设置页字段：自检命令（一行 shell；留空=自动发现或跳过） |
| `public/js/tasks-panel.js` ✅（Phase 2） | 面板展示 `verify.summary` |

## 4. 详细设计

### 4.1 `runVerify` 契约

```js
/**
 * @returns {{
 *   ok: boolean,          // 最终判定：true=通过或跳过
 *   skipped: boolean,     // true=未配置/命令不可用（fail-open）
 *   command: string,
 *   reason?: string,      // skipped 原因 / 失败摘要短语
 *   exitCode?: number|null,
 *   timedOut?: boolean,
 *   durationMs: number,
 *   output: string,       // 截断后的输出（头 2000 + 尾 4000 字符）
 *   summary: string,      // 单行摘要（进卡片/任务字段）
 * }}
 */
```

- **未配置**（`command` 空）→ `{ ok: true, skipped: true, reason: '未配置验证命令' }`。
- **执行**：`runScript(command, [], { cwd, shell: true, timeoutMs: VERIFY_TIMEOUT_MS })`。
  - `shell: true` 的依据与 `setupScript` 相同：命令是 **owner 在设置页手写的受信配置**。**硬约束：任何模型输出、任务数据、同事消息都不得拼接进该命令**——否则等于给模型开了一条绕过审批的任意命令通道。此约束写进模块头注释与测试用例。
  - 命令**无法启动**（ENOENT 等）→ `skipped`（fail-open）：把「命令本身不可用」与「验证失败」分开，否则配错一条命令会让所有任务永远失败。
- **超时** → `ok: false, timedOut: true`；输出取已收集部分。
- **非零退出** → `ok: false, exitCode: N`。

### 4.2 任务字段

```js
verify: {
  ok: false, skipped: false, command: 'npm test',
  attempts: 2, exitCode: 1, timedOut: false,
  durationMs: 135_000,
  summary: 'npm test 失败（退出码 1）：12 passed, 2 failed',
  at: '2026-09-30T…',
},
verifyLog: '…截断输出…',   // 落盘排查用（面板/日志）；卡片只用 summary
```

`store/tasks.js` 的 `updateTask` 是展开合并，新字段自然透传，**不需要改 store**。

### 4.3 重试与 prompt 注入

常量（模块内写死，不做配置——YAGNI）：`MAX_VERIFY_ATTEMPTS = 2`（首次 + 1 次重试）、`VERIFY_TIMEOUT_MS = 10 * 60_000`。

**首次 develop prompt 追加**（`buildVerifySection`）：

```
【完成标准】本次改动完成后，必须让以下命令通过：
  <command>
你可以自行运行它来检查；最终由系统复跑判定，未通过会要求你修复。
```

**重试 prompt 追加**：

```
【上一次未通过自检】命令：<command>（退出码 N）
输出（截断）：
<output>

请修复到通过。禁止通过删除/改写测试、修改验证配置来绕过验证。
```

**防作弊**：验证命令由 owner 配置、系统复跑；重试 prompt 明确禁止绕过。增强项（可选，本期不做）：重试后若 diff 删除了测试文件，给 `verify` 打 `suspicious` 标记并在卡片提示人工复核。

### 4.4 失败路径与通知

- 任务状态：退回 `analyzed`（与 `develop()` 失败同路径，可人工重试；`recoverOnBoot` 语义不受影响）。
- `task.history` 事件：「自检未通过（第 1/2 次）」「自检重试」「自检通过」。
- 通知：`notifyTaskDone(getTask(task.id), false)`（卡片头 ❌ 处理失败）+ 验证行；`replySource(task, false, null, '自检未通过')`。
- 成功路径：`notifyTaskDone` 卡片追加通过行。

### 4.5 卡片与降级文本（`task-notify.logic.js`）

| 场景 | 卡片（lark_md） | 降级纯文本 |
|---|---|---|
| 通过 | `\n🔍 自检通过：npm test（2m13s）` | 同文（去掉标记） |
| 未通过 | `\n⚠️ **自检未通过**：npm test 退出码 1（已重试 1 次）` | `自检未通过：…` |
| 跳过（未配置） | `\n🔍 未配置自检命令（可在设置页补充）` | 同文 |
| 跳过（命令不可用） | `\n🔍 自检已跳过：命令无法启动（<reason>）` | 同文 |

文案进卡片前一律 `summarize(…, 200)`；与 `mergeStatusOf` 同纪律：**两条通道共用同一份取数逻辑**，防文案分叉。

### 4.6 配置与校验

- `verifyScript`：string、trim、长度 ≤ 500、空串 = 未配置；与其他 bot 字段一样走 `makeBotEntry` / PATCH 白名单，导入导出链路自动透传。
- 不在保存时做「命令存在性冒烟」：可能耗时或有副作用（真实的测试可能跑几分钟）；只在运行时 fail-open。

## 5. 边界情况

- **worktree 依赖没装**：验证会真实失败（命令能启动）——这是有效失败，不 fail-open。失败摘要带 stderr，卡片提示检查 `setupScript`。
- **验证命令会改文件**（快照测试等）：跑在 auto 工作区，产物随 `commitAll` 一并提交（先验证后提交）。
- **develop 失败**（`r.ok === false`）：不跑验证（没意义），保持现状路径。
- **无代码改动**：保持现状（在验证之前就退回）。
- **验证很慢**：10 分钟上限；超时算失败（可重试一次）。
- **并发**：auto-dev 泵单并发，验证期间不会有第二个任务占用工作区。
- **飞书卡片按钮**：验证失败的任务卡片不带「合并」按钮（状态回到 `analyzed`，`isAwaitingMerge` 天然为假），只有「补充」——与现有降级语义一致。

## 6. 验收

**单测**

- `verifier.logic.test.js`：截断（头+尾+省略标记）、摘要（成功/失败/超时/跳过）、空命令判定。
- `verifier.test.js`：tmp 工作区真跑 `node -e "process.exit(1)"`（失败）、`node -e ""`（成功）、不存在的命令（skipped）、超时（`timeoutMs` 调小）；断言 `ok/skipped/exitCode/output` 形状。
- `auto-dev/verify.logic.test.js`：重试 prompt 包含命令与输出摘要、决策表（通过→不再重试；失败且 attempts<2→重试；失败且 attempts≥2→终态）。
- `auto-dev` 编排测试：注入假 `develop`/`runVerify` 桩件，钉住三条链——首次通过→done；失败→重试→通过→done；失败→重试→仍失败→`analyzed` + 通知。
- `settings.test.js`：`makeBotEntry` 收录 `verifyScript`（字符串 trim；非字符串归空）。
- `task-notify` 文案测试：四种场景的卡片/降级文本。

**手测**

1. 测试仓库配置 `verifyScript: "npm test"`，任务故意改坏一个测试 → 观察：重试 1 次 → 退回 `analyzed` + 飞书卡片带失败摘要。
2. 正常任务 → 卡片出现「🔍 自检通过」。
3. 清空 `verifyScript` → 卡片出现「未配置自检命令」，行为回到现状。

## 7. 分阶段

- **Phase 1（核心）**：capability + auto-dev 集成 + 重试 + 配置字段（含后端路由）+ 通知 + 测试。完成后 auto-dev 的「完成」即由验证器判定。
- **Phase 2** ✅（2026-09-30）：设置页字段（`bots-panel.js`「自检命令」输入框）+ 自动发现（决策 5：`verifier.logic.js#discoverVerifyCommand` + `verifier.js#resolveVerifyCommand`，读任务工作区 `package.json`，剔除 npm init 占位脚本）+ 任务面板展示 `verify.summary`。
- **Phase 3**：openai 路径接同一 capability——内置工具新增 `RunVerify`（无参数/仅返回结果，命令来源与 auto-dev 同规：显式配置 > 自动发现 > 明确返回「未配置」），系统提示词加「宣称完成前先自检」。本 spec 只锁接口方向，细节另出 spec。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 验证命令不稳定（flaky）导致无辜重试/失败 | 失败摘要进卡片供人工判断；owner 可随时清空配置回到现状；重试上限 1 次防烧额度 |
| 命令注入（模型/数据被拼进验证命令） | 硬约束 + 模块头注释 + 测试用例：验证命令只来自 owner 配置 |
| fail-open 被利用（把命令写错伪装成跳过） | 跳过会在卡片明确标注「未配置」或「命令无法启动」，主机遇得到 |
| 验证拖慢管线 | 10 分钟上限；重试仅在失败时发生 |

## 9. 与后续工作的衔接

- 「先复现再修复」：复现命令与验证命令共用 `runScript` 与结果归一体系，本期把结果形状（`ok/skipped/timedOut/output`）定为公共契约，复现阶段直接复用。
- repo map / 自主找线索：与本 spec 独立，另出 spec。

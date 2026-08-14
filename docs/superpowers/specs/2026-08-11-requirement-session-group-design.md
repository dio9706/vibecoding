# 需求会话组 + 优化汇总 设计文档

> 2026-08-11 · 状态：待实现
> 前序：`2026-08-04-requirement-workflow-design.md`（四阶段工作流）、`2026-08-05-dev-phase-conversation-model.md`（开发期改客户端会话）

## 1. 背景与目标

当前一个需求 = 一个会话（`req.convId`）。开发期打开需求会自动发送 develop 提示词，此后所有开发对话都堆在这唯一的会话里。

问题：
- 长需求的会话上下文无限增长，额度消耗大；
- 不同主题（样式调试 / 接口联调 / 排查问题）混在一条时间线里，难以回看；
- 需求结束后，踩过的坑随会话一起沉没，下个需求 AI 照样犯同样的错。

目标：
1. 把「一个需求一个会话」改成「一个需求一组会话」，支持在需求下新建子会话，用于换话题、重开上下文省额度、分主题记录；
2. 归档时提供「优化汇总」，跨会话分析反复出现的错误，沉淀成可被 AI 自动读取的避坑清单，闭环减少后续开发犯错。

## 2. 用户拍板记录

| 议题 | 决策 |
|------|------|
| 并发模型 | **允许并行，不加锁、不做 worktree 隔离**。多会话共享同一 cwd 与需求分支，由用户自行保证不改同一文件 |
| 子会话上下文 | **轻量种子**：需求标题/分支/工程角色/文档路径/设计准则，不含开发文档全文 |
| 汇总产出去向 | **报告 + 清单双份**：完整报告存归档档案，精简规则条目回灌 |
| 清单存储 | 写进各工程仓库 `<dir>/.claude/pitfalls.md`，由 `CLAUDE.md` 以 `@` 引用自动加载 |
| 会话文件夹 UI | 侧栏「本次需求」下的需求行可展开为会话树 |
| 增量捕获 | **不做**。只在归档时一次性跨会话汇总（单会话样本小，易提炼假规则） |

## 3. 数据模型

### 3.1 requirements.json 字段变更

`src/store/requirements.js` 的 `createRequirement` 骨架新增一个字段，原有字段语义收窄但保留：

```js
convId: null,      // 语义收窄为「主会话」convId —— 自动开发所在会话，也是 bug-fix 的固定落点
devSession: null,  // 主会话的 sessionId
sessions: [],      // 新增：[{ convId, sessionId, title, kind, createdAt }]
                   //   kind: 'main' | 'sub' | 'retro'
```

### 3.2 渐进迁移（不写迁移脚本）

读取时若 `sessions` 为空且 `convId` 非空，就地合成主会话记录：

```js
{ convId: req.convId, sessionId: req.devSession, title: '自动开发', kind: 'main', createdAt: req.createdAt }
```

合成发生在读侧（`getRequirement` 的调用方或一个 `normalizeSessions(req)` 纯函数），**不回写磁盘**，避免给历史数据做批量迁移。任何一次 `sessions` 的真实写入（新建子会话、回填 sessionId）会顺带把合成结果落盘。

### 3.3 sessionId 回填（关键缺口）

**问题**：`2026-08-05-dev-phase-conversation-model.md` 把开发期改为客户端会话后，`devSession` 失去了回填者（原先由服务端系统任务的 `onInit` 写入）。sessionId 现在只存在于前端 localStorage 的 `conv.session`。

**影响**：归档汇总要读磁盘转录 `~/.claude/projects/<encode(cwd)>/<sessionId>.jsonl`，**sessionId 是唯一钥匙**。没有它，子会话内容无法找回，优化汇总不成立。

**方案**：新增 `POST /api/req/session`

```
请求：{ id, convId, sessionId?, title?, kind? }
      sessionId 允许为 null —— 新建子会话时先登记占位，首轮拿到 session_id 后再次上报补齐
      kind 仅在首次登记时生效（'sub' | 'retro'，缺省 'sub'）；后续上报不得改写已有 kind
行为：在 req.sessions 中按 convId upsert（补 sessionId / 更新 title）；
      若该条 kind==='main'，同步回写 req.devSession
响应：{ ok: true }
```

前端调用时机：会话拿到 session_id 之后（`chat.js` 现有 `onInit` / session 落库路径），若当前 conv 带 `meta.reqId` 则上报。幂等：同 convId 重复上报只更新不新增。

### 3.4 并行的影响面（结论：后端几乎不用改）

- 客户端会话的 run 走 `/api/run/start`，**不经过 `req.busy`**，服务端本就不拦并行；
- `req.busy` 现仅由 bug-fix / docgen 两个系统任务使用，继续保持独占语义，不变；
- `canDispatch`（busy 空 + conv 无活跃 run）中的「conv」明确为**主会话**（`req.convId`）。子会话在跑不阻塞 bug-fix 派发。

## 4. 后端改动

| 文件 | 改动 |
|------|------|
| `src/store/requirements.js` | 骨架加 `sessions: []`；新增 `normalizeSessions(req)` 纯函数（读侧合成主会话） |
| `src/entrypoints/web/req-logic.js` | 新增纯函数：`buildSeedPrompt`（种子上下文，§5.2）、`buildRetroMapPrompt` / `buildRetroReducePrompt`（§6.2）、`extractPitfalls`（标记块提取，§6.3）、`splitPitfallsByProject`（按 `[前端]`/`[后端]` 前缀分流）、`mergePitfalls`（去重合并 + 上限） |
| 新增 `src/entrypoints/web/req-pitfalls.js` | `.claude/pitfalls.md` 与 `CLAUDE.md` 的文件读写（§6.5）。独立成文件是为了让 `req-logic.js` 保持纯函数无 IO，两侧各自可测 |
| `src/entrypoints/web/routes-requirements.js` | 新增 `POST /api/req/session`（upsert）、`DELETE /api/req/session`（移除子会话，禁删 main）、`POST /api/req/pitfalls`（确认后写盘）；`handleGet` 响应带 `sessions`（已 normalize） |

**不动 `requirement-ops.js`**——其 `dispatch` 仅认 `docgen` / `bug-fix`，新增 kind 会被静默作废；优化汇总因此走客户端会话（§6.1）。沿用 Task 11 另落 `req-inspect.js` 的先例。

## 5. 前端改动

| 文件 | 改动 |
|------|------|
| `public/js/conv-store.js` | 新增 `convSetTitle` / `convDelete` / `convSetMeta`（现有模块只有消息级与 session 字段级操作，无会话删改函数） |
| `public/js/chat.js` | 新增 `isConvRunning(convId)` 导出（`runningJobs` 是模块私有，侧栏运行灯需要它）；`session` SSE 事件回填 `/api/req/session`；`send()` 前置拼接种子（§5.2） |
| `public/js/req-view.js` | 侧栏会话树（§5.1）、新建/重命名/删除子会话（§5.2/§5.3）、归档期 [优化汇总] 按钮与编排（§6） |
| `public/js/ui.js` | 新增 `textareaDialog`（多行可编辑 + 确认/取消）。现有 `promptDialog` 是单行 `<input>`，不适合条目预览 |
| `public/app.css` | 会话树行样式；预览框复用既有 `.req-archive-note-textarea` |

### 5.1 侧栏会话树（`public/js/req-view.js`）

```
本次需求
  ▾ 📌 我的菜谱                    · dev
      ⚡ 自动开发            ●        ← kind='main'，不可删
      💬 侧边栏样式调试
      💬 接口联调
      ＋ 新会话
  ▸ 📌 另一个需求                  · test
```

**数据源是前端 `loadConvs()` 按 `meta.reqId` 过滤，不依赖后端 `sessions`。** 侧栏本就是本地 conv 的导航，这样 `/api/req/list` 无需扩字段。后端 `req.sessions` 只服务于归档汇总（读 sessionId 定位磁盘转录）。代价即 §7 第三条已接受的降级。

会话的 `kind` 存于 `conv.meta.kind`（`createReqConv` 写入），与后端 `sessions[].kind` 同值。

- `makeReqRow(r)` 增加折叠箭头与展开态。展开态存内存（切页面不保留），当前打开的需求默认展开；
- 会话行：标题 + 运行中指示灯（查 `runningJobs[convId]`）；hover 出重命名 / 删除；
- `kind==='main'` 的行带 ⚡ 标记，**不提供删除**（bug-fix 落点必须存在）；
- 点击会话行 → `openConv(convId)`。横幅与右侧面板是**需求级**装饰，跨会话不变，`mountReqChrome` 逻辑不受影响；
- 仅 `phase` 为 `dev` / `test` 时渲染会话树（评审期是文档视图，归档期对话已禁用）。

### 5.2 新建子会话与种子上下文

**新建流程**：调 `createReqConv({ reqId, cwd, session: null, title: '新会话' })` → `POST /api/req/session` 登记（此时 sessionId 为 null，待首轮回填）→ `openConv`。

**种子挂起，不自动发送。** 新建会话立即发种子会白起一个 run（Claude 只会回一句「好的」），与省额度目的相悖。改为：

- 新 conv 打标 `meta.seedPending = true`，种子正文存 `meta.seedText`；
- 用户发出第一条消息时前置拼上种子，随后清除标记；
- 若用户建了会话没说话就关掉，零额度消耗。

**拼接位置：`chat.js` 的 `send()` 中 `launchRun(job, text, sessionId, runCwd)` 这一行，只改传给 `launchRun` 的文本**，不改 `addMessage` / `recordMessage` 的入参。这样用户气泡与本地历史保留用户原话（界面干净），种子只进模型上下文与 Claude session 转录。

`send()` 开头的 `steer` 早退分支不受影响：新建会话不可能有进行中的 run，首条消息必走新起一轮的路径。

**种子内容**（`buildSeedPrompt`，约 200–300 token）：

```
【需求】<标题> · 分支 <reqBranchName>
【工程】前端 <dir>（开发） / 后端 <dir>（只读，禁止修改）
【开发文档】<最新版本 path>（需要时自行 Read）
【设计准则】<designGuidelines，为空则省略>
```

**不含避坑清单**——清单已写入 `<dir>/.claude/pitfalls.md` 并由仓库 `CLAUDE.md` 以 `@` 引用，Claude Code 启动时自动加载，无需注入成本，且对终端手开的会话同样生效。

### 5.3 会话删除

只删本地 conv 记录 + `req.sessions` 条目，**不删磁盘转录**。已删会话的 sessionId 从 sessions 移除后不再参与汇总（视为用户主动放弃该条时间线）。

## 6. 优化汇总

### 6.1 触发与执行方式

归档期（`phase === 'archiving'`）界面新增 **[优化汇总]** 按钮（落在 `req-view.js` 的 `renderArchivingPage`，与现有备注框同区）。

**走客户端会话，不走服务端系统任务。** 理由：`requirement-ops.js` 的 `dispatch` 仅认 `docgen` / `bug-fix` 两种 kind，新增 kind 会被静默作废，而该文件已过审、本设计不动它（§4）。客户端会话另有两项实得好处：分析过程可见，且用户可随时插话纠正跑偏的结论。

流程：新建 `kind: 'retro'` 子会话 → `openConv` 切到聊天视图 → 前端拉取转录并分批喂入。该会话本身不参与后续汇总。

归档期的需求装饰层（横幅/右栏）由 `mountReqChrome` 的 phase 守卫拦下，retro 会话呈现为干净的聊天视图。这是预期行为，不需额外处理。

### 6.2 map-reduce（前端编排，分批喂入）

一个长需求可能有五六个会话、每个数百轮，全量塞入必爆上下文。分两阶段：

1. **Map** —— 遍历 `req.sessions` 中 `kind !== 'retro'` 且 `sessionId` 非空的条目，逐个经 `GET /api/history/:sid?cwd=` 拉转录（`src/store/history.js` 的 `getHistorySession`，已过滤成 role+content 纯文本，比原始 jsonl 小一个量级）。每个会话作为**一条消息**发进 retro 会话，要求只回精简小结、不要展开；
2. **Reduce** —— 全部喂完后发一条聚合指令，要求**重点识别跨会话反复出现的错误**。只出现一次的可能是偶然，出现多次的才是本仓真坑。

**截断保护**：单会话转录超 30000 字符时取首尾各半截断，中间以 `…（已截断 N 字符）…` 标记。截断必须在 UI 上明示（toast + retro 会话内可见），不得静默——否则汇总结果会被误读为「已覆盖全部对话」。

### 6.3 双份产出与提取

Reduce 阶段的提示词要求 Claude 在回答末尾输出一个固定标记块：

```
<!-- PITFALLS-BEGIN -->
- 条目一
- 条目二
<!-- PITFALLS-END -->
```

- 标记块**之外**的全部正文 = 完整回顾报告 → 写入**顶层字段 `req.retro`**（含前因后果，供人查阅）。

  刻意不放 `req.archive.retro`：`archiveRequirement` 会整体覆写 `req.archive`（`{ note, summary, archivedAt }`），而优化汇总发生在归档**之前**，塞进去会被后续归档动作抹掉。
- 标记块**之内**的条目 → 经预览确认后追加进 `<工程目录>/.claude/pitfalls.md`。
前端在 retro 会话的 run 结束后扫描最后一条 assistant 消息提取该块。提取失败（无标记块）时给出明确提示，用户仍可从会话正文手工复制——不静默失败。

条目要求：每条可执行、带定位信息，并以 `[前端]` / `[后端]` 前缀标注归属。示例：

```markdown
- [前端] 改 `.req-*` 相关样式前先查 `[hidden]` 是否被 `display:flex` 覆盖，本仓已踩过两次。
```

**归属分流**：按前缀分别写入各自仓库。**只写 `projects[*].dev === true` 的工程**，只读参考工程绝不写入；若某侧工程不存在或非开发工程，该侧条目在预览框中提示丢弃。

### 6.4 三道闸（不可省略）

1. **落盘前预览确认**。AI 提炼的规则可能错误或过度泛化，一旦写入 `pitfalls.md` 会污染此后**所有**会话——错误规则的伤害大于没有规则。出可编辑确认框，用户删改后才写；
2. **去重合并 + 30 条上限**（`mergePitfalls`）。追加前读现有条目合并同类项，超限强制压缩，防止清单自身变成上下文垃圾；
3. **不碰 git**。只写工作区文件，是否提交由用户决定（与本项目「全程零 git 提交」一致）。

### 6.5 CLAUDE.md 引用挂接

首次写入 `pitfalls.md` 时，检查目标仓库 `CLAUDE.md`：

- 已含 `@.claude/pitfalls.md` 引用行 → 不动；
- 无引用 → 追加一行 `@.claude/pitfalls.md`；
- 仓库无 `CLAUDE.md` → 创建，仅含该引用行。

此步同样纳入 §6.4 的预览确认范围（会改用户仓库根文件，需明示）。

## 7. 边界与不做的事

- **并行冲突不设防**。多会话共享同一 cwd 与分支，同时改同一文件会互相覆盖，由用户保证不撞。不做锁、不做 worktree；
- **转录只有文字叙述与结果**，不含 Edit/Write/Bash 工具级细节（`getHistorySession` 既有边界）。汇总能看到「AI 说它改了什么、用户如何纠正」，看不到逐次工具调用。这对识别「反复犯的错」够用；
- **清空 localStorage 后子会话丢失**。conv 存于前端；`req.sessions` 里仍有 sessionId 记录，汇总不受影响，但侧栏树会看不到该会话（可接受降级）；
- **不做增量捕获**。仅归档时汇总一次；
- **不改 `requirement-ops.js`**，汇总编排落独立新文件。

## 8. 验收清单（真机走查）

1. 打开已有需求 → 侧栏需求行可展开，显示一条 ⚡ 自动开发（老数据合成成功），无删除按钮；
2. 点「＋ 新会话」→ 出现新行，主体区空白，**未起 run**（不烧额度）；
3. 在新会话发第一句话 → 实际发出的内容前置了种子上下文；Claude 明确知道需求、分支、工程角色；
4. 发第二句话 → 不再重复种子；
5. 主会话与子会话**同时**各跑一个任务 → 两行都亮运行灯，互不阻塞，各自流式输出正常；
6. 刷新页面 → 会话树恢复，运行中的会话可重新接流；
7. 测试期触发 bug-fix → 仍发到主会话，子会话在跑不影响其派发；
8. 归档期点「优化汇总」→ 新开 retro 会话，逐会话小结后聚合，产出报告与条目；
9. 条目预览框可编辑删改 → 确认后写入正确工程的 `.claude/pitfalls.md`，只读工程未被写入；
10. 目标仓库 `CLAUDE.md` 出现（或已有）`@.claude/pitfalls.md` 引用行；
11. 再次汇总 → 同类条目被合并而非重复堆积，总数不超 30；
12. 归档档案中可查到完整回顾报告。

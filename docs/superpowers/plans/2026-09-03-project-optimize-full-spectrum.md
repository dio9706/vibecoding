# 项目优化：全方位维度体系 · 实施记录

- 日期：2026-09-03
- 设计：`docs/superpowers/specs/2026-09-03-project-optimize-full-spectrum-design.md`
- 状态：**编码完成，改动留在工作区未提交**（按仓库约定不自动 git 提交）

## 做了什么

把「项目体检 / 一键优化」从 6 个维度、2 个可自动修，扩成 **17 个维度、全部有修复策略**，
并把「加维度」的成本从「改四处 + 写四个文件」降到「注册表加一条声明」。

### 新增的 11 个维度

| 域 | 维度 | 权重 | 判据出处 |
|---|---|---|---|
| 架构 | `structure` 分层与依赖方向 | 12 | 《架构整洁之道》依赖规则；SOLID-D |
| 代码质量 | `complexity` 复杂度与函数规模 | 7 | 《代码整洁之道》ch3；《代码大全》ch7/ch19 |
| 代码质量 | `duplication` 重复实现 | 6 | 《重构》Duplicated Code；《程序员修炼之道》DRY |
| 代码质量 | `naming` 命名与意图表达 | 4 | 《代码整洁之道》ch2；《编写可读代码的艺术》 |
| 代码质量 | `deadcode` 死代码与未使用导出 | 3 | YAGNI；《重构》Dead Code |
| 健壮性 | `errors` 错误处理与稳定性 | 7 | 《Release It!》；《Effective Java》ch10 |
| 健壮性 | `security` 敏感信息与危险用法 | 6 | OWASP Top 10 |
| 工程化 | `deps` 依赖健康 | 4 | 《Google 软件工程》ch21 |
| 工程化 | `config` 配置与环境收口 | 3 | 12-Factor App §3 |
| 工程化 | `docs` 文档可上手性 | 3 | 《Google 软件工程》ch10 |
| 综合 | `holistic` 整体智能评估 | 不参与加权 | 综合全部维度 |

另加 `hygiene-audit`（augment 型条目，给零误报的 `hygiene` 补 LLM 召回）。

### 三个新抽象

1. **维度注册表**（`dimensions/registry.js`）——权重表、体检占位、`LLM_DIM_KEYS`、
   修复管线顺序、前端展示全部从它派生。原来这些是四张各自手写的表，漏改任一张都是静默失效。
2. **通用审计引擎**（`audit-engine.js`）——分批 / 全局限并发 / 重试 / 全有或全无校验 /
   指纹缓存 / 重锚定这套同构管线只此一份，抽自 `check-prompts.js` 的 450 行。
3. **通用修复引擎**（`fix-engine.js`）+ 五种策略——`optimize-ops.js` 不再为每个维度插一段 if。

### 安全设计

- **测试是重构的许可证**：`llm-refactor` 要求改前测试全绿、改完重跑、红了回滚该文件；
  没有可跑的测试命令时整个策略降级为只出清单。这条也定出了修复管线顺序（`tests` 在源码层之前）。
- **受限写 agent**（`capabilities/llm-write-agent.js`）：三层防线，第 2 层是
  「工具名 + **目标路径**」双重白名单——写入范围必须等于回滚范围，否则单文件回滚的保证不成立。
- **没有 issue 会被静默丢掉**：任何策略都不认领的、以及被降级的，一律进整改清单。

## 已验证

- `npm test`：**2151 / 2165 通过**。
  剩余 14 个是 `public/js/req-view.*` 的 `ReferenceError: ResizeObserver is not defined`，
  属**本次改动之前就存在**的失败：`public/js/chat.js` 于 15:00 被改动并引入了 HEAD 上没有的
  `ResizeObserver` 用法，而 jsdom 没有这个 API；本次未触碰该文件及其依赖。
- 新增测试 **101 条**，覆盖：单元切分（14）、代码级召回（14）、项目级召回（17）、
  符号与引用（9）、审计引擎纯逻辑（20）、审计引擎免 LLM 路径（10，真读盘）、
  整体评估纯逻辑（9）、修复分派（12）、修复引擎真写盘（10）、前后端维度表交叉校验等。
- **召回精度实测校准**：本仓库首轮 993 条候选 → 逐类核对修掉四类系统性误判 → 581 条
  （`security` 203→27、`config` 206→3、`code-injection` 34→4、`cleartext-transport` 33→1）。
- **全链路演练**（合成判定替代 LLM，在本仓库真实取材）：17 维报告正常装配，
  总分 / 等级 / 计入维度数 / 问题计数全部正确；真跑约 54 批判定。
### 自查发现并修掉的四个缺陷

1. **备份缺口**：`planEngineEntries` 规划时按「闸会放行」算，但执行时闸可能是关的，
   那一刻写出的降级清单没进备份计划 → 成为「还原撤不掉」的文件。
   已改为「含源码重构策略的维度一律登记其清单路径」。
2. **`fixable` 变成了假话**：`comments` / `prompts` / `tests` / `hygiene` 的检测器把
   `fixable` 硬编码成 `false`（写于它们还没有修复能力的年代），而新引擎照样自动修它们。
   字段无人消费 → 没有功能故障，但代码和注释与实际行为矛盾。
   已让引擎重新尊重该字段（`claims` 里 `fixable === false` 一律不认领），并逐条改成如实值。
3. **真 bug（由第 2 条根因暴露）**：`tests` 的 S1_TESTS_FAILING 的 `file` 是 `package.json`
   ——那是测试命令的所在处，不是待补测试的文件。它会被 `llm-create` 认领，
   目标算成 `package.test.json`，然后让模型给 package.json 写单元测试。
   现在 S1 保持 `fixable: false` → 直接落进整改清单。
4. **`docs` 改写拿不到项目事实**：它的 rubric 明写「以真实脚本清单为准」，
   但那段共享上下文由召回器在**判定期**产出，而修复期没有召回步骤 → 拿到空白。
   已加注册表字段 `fixContext: (evidence) => string`（目前只有 `docs` 用），
   由引擎求值注入，而不是让编排层逐维度硬传。

## 未做（刻意留下，见 spec §12）

1. `map` 的内容新鲜度 LLM 检测（现有 M3 只比 mtime）——成本与地图生成同量级，应独立一期。
2. 10 份新判据的判分系数实测校准——`verdictLog` 已留全量判定作为校准依据。
3. `git rm --cached` 的还原缺口——当前在 fix notes 里如实告知，真补要改 backup manifest 格式。
4. `structure` / `security` 的 absolute 判分容易饱和——等第 2 项拿到真实分布后再定。

## 需要人工验收的部分

自动化测试覆盖不到「真花额度跑一遍」，以下要在 UI 上人工确认：

1. 在本仓库点一次体检，看 17 张卡片按域分组、逐个回填，`holistic` 卡片默认展开且计划可读。
2. 点一键优化，看进度流的阶段文案（测试闸 / 各策略 / 降级）是否说得清在做什么。
3. 确认 `.claude/optimize/PLAN.md` 与各维度清单的内容质量，以及每条 action 能否对应到具体文件。
4. 在一个**没有测试**的项目上跑，确认源码级维度全部如实报「已降级为清单」且零源码改动。
5. 点「还原」，确认本次全部改动（含新建的测试文件与清单文件）被干净撤回。
6. 观察 `llm-write-agent` 的 `denied` 日志是否为空——非空说明提示词没把「只能改这一个文件」说清。


---

## 第二轮：真实运行数据与据此做的修复（2026-09-03 晚）

在桌面版上跑通一次完整体检，拿到第一组真实数据。

### 实测数据

| 指标 | 值 |
|---|---|
| 判定批次 | 51 批成功；中位 **79s**、p90 **143s**、最长 169s |
| 串行等价耗时 | 71.3 分钟 → 全局并发 4 → **约 17 分钟** |
| 整体评估 | 6.3 分钟，**失败**（`status: partial, actions: 0`） |
| 总耗时 | 约 25 分钟 |
| 失败批次 | 极少，且是「模型返回了但结构不合法」而**不是**超时 |
| 各维得分 | structure 20 / errors 64 / complexity 73 / duplication 85 / deadcode 90 / config 92 / security 92 / naming 100 |
| 问题总数 | 约 147 条（complexity 66、deadcode 30、errors 29、duplication 12、structure 10） |

### 修掉的四个缺陷

1. **维度粒度太粗导致「看起来死了」**（我引入的）。一个维度要全部批次跑完才落地，
   `deadcode` 19 批 × 55s → 卡片转圈 13 分钟、盘上零变化。
   → 加批级 SSE `progress` 事件，卡片显示「第 6/19 批」；日志逐批留痕（含耗时与失败归因）。
2. **体检完成后 loading 不消失**（我引入的）。`renderScore` 被我改成依赖 `checkupBusy`，
   但 `closeCheckupStream()` 清空它时只调 `refreshButtons()`——**只刷按钮不刷分数环**。
   而 `applyCheckupDone()` 的 `render()` 发生在清空**之前**，画的是 loading。
   → 所有改动 `checkupBusy` / `fixRunning` 的地方一律改调 `render()`。
   教训记在 `closeCheckupStream` 的注释里：**凡是参与渲染的状态变量，清理它的地方就必须触发渲染**。
3. **SSE 在整体评估的 6.3 分钟里完全静默**。中间层会把长静默连接当死连接掐掉，
   而服务端还以为订阅者在，`done` 就发进了断管。→ `openStream` 加 20s 心跳（`: ping`，对前端透明）。
4. **holistic 失败但日志看不出原因**。只有 `reason: null`——那表示调用成功、JSON 也解析出来了，
   只是 `validatePlan` 不认。而「模型没返回」和「字段没对上」的修法方向完全相反
   （调超时 vs 改 prompt）。→ 失败时打 `gotKeys` / `actionCount` / `got` 片段。

### 新增：风险分级优化

用户要求「一键优化只做低风险，中高风险单独按钮」。**风险定在策略上而不是维度上**——
`prompts` 一个维度里 P4 去重是机械删行（低），P1/P2 规则改写要理解语义（中），
按维度定就只能一刀切成保守档，本来安全的去重也被挡住。

| 档位 | 判据（改错了的后果范围） | 策略 |
|---|---|---|
| low | 不动既有代码：只新增文件或改配置，且都可逆 | `advisory`、`deterministic`、`llm-create` |
| medium | 改既有**文档**，不影响运行时但会静默误导 | `llm-rewrite`；`map`（改各级 CLAUDE.md） |
| high | 改既有**源码** | `llm-refactor`；`rules`（**本功能唯一的破坏性操作**：删文件 + 改写全仓引用） |

- `map` / `rules` 是专用流程维度，策略表管不到它们，在注册表里显式声明 `risk`。
- API：`POST /api/optimize/fix {risk: 'low'|'elevated'}`，缺省与乱传一律 **fail-closed 到 low**。
- `elevated` = medium + high，**不含 low**——那部分第一个按钮已经做过，重复做只会重复写清单。
- 低风险档位下**不为源码重构开测试闸**（跑一遍全量测试是纯浪费）。
- 被风险档位挡下的 issue 仍然进整改清单，并在清单首屏写明「点中高风险优化才会执行」——
  否则用户看到清单里躺着源码问题，会以为工具没能力修。

### 另外修的三个（自查发现）

5. `fixable: false` 在 comments/tests/prompts/hygiene 里成了假话（引擎照样自动修）。
   → 让 `claims` 重新尊重该字段，并把四个检测器的值改成如实。
6. **真 bug**：`tests` 的 S1（file 是 `package.json`）会被 `llm-create` 认领，
   目标算成 `package.test.json`。第 5 项修好后它自动落进清单。
7. `docs` 的文档改写拿不到真实脚本清单（rubric 明写「以它为准」却是空的）。
   → 注册表新增 `fixContext: (evidence) => string`，由引擎求值注入。

### 服务重启导致的死锁

占用记录落盘、job 注册表在内存，进程被杀后记录残留最多 1 小时，
用户点体检只会反复得到「该项目正在体检或优化中」。
→ `healAllBusyOnStartup()`（新进程必然没有在跑的任务，无条件释放安全）+
`report` 接口返回 `busy.alive` 让前端区分「重连」还是「解锁」+ `POST /api/optimize/busy/heal`。


---

## 第三轮：整体评估失败归因 + 判分分辨力（2026-09-04）

### 1. 整体评估失败的根因：JSON 抽取抓错了对象

日志里只有 `reason: null`——那**证明有一个 JSON 被成功解析了**，只是 `validatePlan` 不认。
`extractFirstJsonObject` 取的是**第一个**配平的 `{...}`，而 holistic 是多轮工具调用：
模型探索期只要引用过一段带花括号的代码、或写过任何中间结果对象，就会被抢先抓走。
整维度白跑 6.3 分钟，而日志无法区分「模型没返回」和「抓错了对象」——
这两者的修法方向完全相反（调超时 vs 改 prompt）。

**修法两层：**

- `llm-classify.js` 新增 `extractJsonObjects`（扫出全部配平块）与
  `pickJsonObject(text, requireKeys)`（**从后往前**找含指定键的那个，因为最终答案总在最后；
  一个都匹配不上时退回最后一个能解析的，而不是第一个）。
  `extractFirstJsonObject` **行为一字未变**——单轮分类点的既有校准依赖它。
- 两个 agent 骨架都改用 `pickJsonObject`：holistic 传 `requireKeys: ['topActions']`，
  写 agent 默认 `['changed']`。
- holistic 的 system prompt 新增「输出纪律」段：探索过程中不要输出任何 JSON、
  不要贴带花括号的代码片段，想记中间想法用纯文本。

### 2. structure 20 分：结论是对的，饱和才是缺陷

逐条核对了那 10 条判定，**8 条 violation 全是真违规**，判定分布也很健康
（53 条候选 → 43 acceptable / 2 smell / 8 violation，模型没有滥报）：

- `shared/bot-activity.js` → `store` **且** → `integrations/lark.js`：最底层反向依赖两个上层，
  还与 `store → shared` 构成环
- `features/claude-exec/logic.js` → `app/intent-keywords.js`：features 反向 import app
- `plugins/action-runner` → `app/signals.js`；`plugins/feishu-card-actions-example.js` → `entrypoints/feishu`
- `team-tools`：`task-ops → task-notify → auto-dev → task-ops` 三文件环 + `task-notify ⇄ auto-dev` 二文件环

对照项目自己 CLAUDE.md 的「下层不得 import 上层」，20 分是诚实的，**没有下调信号强度**。

真缺陷是**饱和**：`violation` 权重 20、上限 80 → **4 条就触顶**，8 条与 4 条同为 20 分。
**用户修掉一半却看不到任何变化**，而这个维度的全部价值就是「改了有没有进步」。

三个 absolute 判分维度重新校准（只改刻度，不改结论强度）：

| 维度 | 旧（单条 / 上限） | 新 | 新曲线（1/2/4/8 条） |
|---|---|---|---|
| structure | 20 / 80 | 9 / 85 | 91 → 82 → 64 → 28 |
| security | 30 / 100 | 22 / 95 | 78 → 56 → 12 → 5 |
| docs | 25 / 80 | 18 / 85 | 82 → 64 → 28 → 15 |

「一条可利用漏洞就该让这一维很难看」的口径保留了（单条直接扣到 78）。
新增一条**通用护栏测试**：任何 absolute 维度在最严重档连出 4 条时，分数必须仍高于底线——
它正是在这轮抓出了 `docs` 的同类饱和。

### 3. 并发保持 4

用户拍板「不用那么快」。实测中位 79s、p90 143s，长尾不算失控，
瓶颈是并发而非单批；但没有依据支持提高并发上限（`check-prompts` 校准过 4 是单机上限），
不动。


---

## 第四轮：structure 结论复核 + 修掉真问题（2026-09-04）

### 先更正上一轮的结论

上一轮我写「8 条 violation 全是真违规」并特别点了 `shared/bot-activity.js`。**逐条实地核对后，
那句话错了两处，而且两处都是我转述模型的判断却没自己验证**：

| 模型的说法 | 实地核实 |
|---|---|
| 「构成 `shared ↔ store` 的 import 环」 | **不存在文件级环**。`bot-activity` / `config` / `messages` 三个入口的可达图全部无环 |
| 「config/logger 一旦被引入就顺带拖入飞书 SDK」 | **不成立**。`logger.js` 可达 2 个文件、`config.js` 可达 5 个，都不含 lark；只有 `bot-activity.js` 拖入 lark，而它只被 2 处 import，两处都本来就需要 lark |

8 条的真实构成：

| 条目 | 核实结果 |
|---|---|
| `shared/bot-activity` → `store` / → `integrations/lark`（2 条） | **误报**——`src/shared/CLAUDE.md` 明写「刻意反向 import…为了让埋点只有一个出口」 |
| `plugins/action-runner` → `app/signals.js` | **误报**——`src/app/CLAUDE.md` 明写 `signals.js` 是「叶子模块，禁止 import 任何东西（打破 ESM 循环）」，它存在的全部目的就是让下层能 import 它 |
| `feishu-card-actions-example.js` → `channels` / → `entrypoints/feishu`（2 条） | 真反向依赖，但这是**没有任何人 import 的示例文件**，属死代码而非架构问题（一个死文件被算了两条违规） |
| `features/claude-exec/logic.js` → `app/intent-keywords.js` | **真违规但性质轻**：import 的是零依赖纯函数叶子 |
| `team-tools` 三文件环 + 二文件环（2 条） | **真环**（`findCycles` 机器检出，非推断） |

### 根因是取材缺口，已修

模型只看到根 CLAUDE.md（本仓库 3424 字），而**分层例外全写在 10 份模块级 `CLAUDE.md` 里，
它一份都没看到**。架构文档写得越用心的项目，这个误判越多——因为例外恰恰是被认真记录的那部分。

1. `collect.js` 新增 `moduleConventions`：按 `layerOf` 口径收各模块自己的 `CLAUDE.md`（每份截 1600 字）。
2. `recallImportGraph` 只带出**本轮候选真正涉及**的那几份（全量 10 份会挤掉判据本身的注意力）。
3. sharedContext 新增「候选形状说明」：**`A → B` 与 `B → A` 两条目录级边不等于 import 环**，
   真环会作为独立候选单独给出——不要据此推断环，更不要描述「环导致的后果」。
4. `structure` rubric 补两档 acceptable：模块文档写明是刻意设计的反向依赖；
   以及**发起边的文件没人 import**（示例/演示/归档）——那属 deadcode 维度。
   判 violation 前加硬性两问：例外查过没有、环是真的还是推断的。

### 修掉两个真环（team-tools）

环的成因不是谁写错一行，而是**入队 API 和执行管线住在同一个文件里**这个结构必然导出的结果：
通知模块要入队 → 只能 import 整个执行管线 → 而执行管线完成后要发通知卡片。

拆出 `src/plugins/team-tools/auto-dev/queue.js`（`requestAutoDevelop` + `isOverrideStart`，
**只依赖 `store/tasks.js`**），5 个引用方全部改指向它。**刻意不在 `index.js` 里 re-export**
——留一条通往重依赖链的旧路径，只会让下一个人把环拖回来。

顺带修了一个真实的依赖面问题：5 个引用方里 4 个只要「入队」，却因此拖进了
git / compile / lark / shell / notify / task-ops / task-notify 整条链。
最刺眼的是 `entrypoints/web/routes-ops.js`——一个 HTTP 路由模块把整个自动开发管线拉进了自己的模块图。

验证：**全仓 import 环由 2 降到 0**。

### 第二条真问题按项目既有范式处理

`features/claude-exec/logic.js → app/intent-keywords.js`：`signals.js` 已经是同一形状的先例
（留在 `app/`、用文档声明成零依赖叶子供下层 import）。照它办——在 `src/app/CLAUDE.md` §C
把 `intent-keywords.js` 一并声明为刻意允许的例外并写明理由（词表必须只有一份，
否则 intent 层识别了、claude-exec 的让路判断没识别，消息会被 owner 全接吞掉），
同时修掉那句已过期的「仅被 `intent.js` 调用」。

### 新增架构护栏（`src/import-graph.test.js`）

结构性问题会以同样的形状复发——下一个人只要图省事从 `auto-dev/index.js` 引一次入队，环就回来。
靠人盯不住，所以钉成测试：

1. **src 下不存在 import 环**（失败时打印完整环路径 + 断环手法指引）
2. `signals.js` 与 `intent-keywords.js` **必须保持零 import**（那是「下层可 import 上层」这条例外成立的唯一前提）
3. `auto-dev/queue.js` **只许依赖 `store/tasks.js`**
4. 一条自检：确认护栏自己的路径口径没错——口径错了会丢边，而丢边的表现是「护栏永远绿」，最坏的那种失效

复用了 `structure` 维度的 `extractImports` / `findCycles`，所以**护栏与体检用的是同一份实现**，
不会出现「护栏绿而体检报环」的自相矛盾。

**已验证护栏有牙**：把环放回去 → 立刻检出 2 个并打印完整路径；还原 → 恢复绿。

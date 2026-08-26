# 「项目优化」工具 · 交接文档

> 日期: 2026-08-26 · 用途: 新会话接手剩余工作
> 相关文档: `docs/superpowers/specs/2026-08-24-project-optimize-design.md`(总设计)、
> `-phase2-design.md`(LLM 维度)、`-phase3-design.md`(一键优化)、`-phase3.md`(阶段三 12 task 计划)

---

## 一、现状一句话

体检功能(四个维度)**已完整可用**;一键优化**做了一半**(12 个 task 完成 6 个),剩余 6 个 task。

## 二、这个工具是什么

web 执行台(`claude-p-web-demo`)里的一个面板:选一个本地项目 → 点「体检」→ 出分 + 问题清单 → 勾选维度 → 点「一键优化」自动修复。交互参照 360 安全卫士。

**起因**是一次实测事故:某项目的 `CLAUDE.md` 写着「禁止做出假设——具体结论必须给出 `文件:行号` 依据」,这条没区分「代码事实」和「需求输入」,导致 AI 把用户在需求里直接给定的 agent code 也当成待验证假设,跑到另一个仓库翻数据库定义,一个「改个跳转」的定点任务跑了 20 分钟。这类问题**隐蔽、复利、人工排查成本高**——不报错,只让每次开发都慢一点。

## 三、已完成状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| 一 | 静态体检:维度① 项目地图、维度③ rules 降级检测 | ✅ 完成 |
| 二 | LLM 维度:维度② 提示词质量、维度⑤ 注释合理性 + SSE 异步回填 | ✅ 完成 |
| 三 | 一键优化:rules 降级 + 备份还原 | **8/12** |

维度④(无用代码)v1 明确不做,UI 上置灰。

### 已完成模块清单

```
src/features/project-checkup/          ← 五个检测器，全部定型，逐字别动
├── frontmatter.logic.js  (+test)      18 测试  YAML frontmatter 极简解析
├── check-map.logic.js    (+test)      28 测试  地图完备性/新鲜度/死链
├── check-map.js                                文件系统层
├── check-rules.logic.js  (+test)      15 测试  rules 降级判定
├── check-rules.js                              文件系统层
├── check-prompts.logic.js(+test)      46 测试  提示词候选捞取 + 判分
├── check-prompts.js                            LLM 判定层
├── check-comments.logic.js(+test)     23 测试  注释抽样与提取
├── check-comments.js                           LLM 判定层
├── fingerprint.logic.js  (+test)      11 测试  指纹缓存
├── score.logic.js        (+test)      11 测试  加权总分
└── index.js                                    编排入口

src/features/project-optimize/         ← 阶段三，做了一半
├── fix-rules.logic.js    (+test)      21 测试  ✅ 降级文本变换
├── backup.logic.js       (+test)       6 测试  ✅ 备份纯逻辑
├── backup.js                                   ✅ 快照/还原/保留策略
├── git-guard.logic.js    (+test)       6 测试  ✅ porcelain 解析
├── git-guard.js                                ✅ 工作区检查
├── describe-skill.js     (+test)      28 测试  ✅ description 生成 + YAML 纯量净化
└── fix-rules.js      (+fs.test)      18 测试  ✅ 降级执行层（扫盘/写盘/删盘/失败分级）

src/entrypoints/web/
├── routes-optimize.js                          体检两个接口已通，fix 相关待加
└── optimize-ops.js                             体检 SSE 编排已通，fix 编排待加

src/store/optimize.js                           数据层，setBusy/saveFixResult 已写但未接
public/js/optimize-view.js / .logic.js          面板，体检部分已通
public/js/optimize-fix.logic.js (+test)  9 测试 ✅ 一键优化前端纯逻辑
tests/fixtures/projects/                        healthy / no-map / kxmall-like / demote-target
```

**全套测试当前 1499 条,1497 通过。** 那 2 条失败是既有的、与本工具无关(`public/js/chat.path.test.js` 断言 `.md` 图标是 📄,而 `chat.js` 实际给 📝——两个文件在 git 中均未修改,是 HEAD 内容漂移)。

> 注:总数会随其它会话的并发改动浮动。跑全量时若看到 `public/js/` 下的额外失败(如
> `req-chat.apidoc.test.js` 报 `ResizeObserver is not defined`),先确认那些文件是否正被别人改——
> `public/` 里没有任何代码引用 `project-optimize`,本工具不可能影响它们。

### 实测效果(可信的基线)

| 项目 | 分数 | 说明 |
|---|---|---|
| `kxmall-app-ui`(已优化过) | rules 100 / map 64 | 死链检出 2 条,其中 1 条是真失效引用 |
| `kxmall-app-ui.auto`(未优化副本) | rules 60 | 自动捞出 `design-system.md` 14KB、`keyboard-input-pattern.md` 20.5KB——正是人工判断该迁的那两个 |
| `claude-p-web-demo`(本仓库) | 0 | 根本没有 CLAUDE.md |

---

## 四、⚠️ 必读:踩过的坑

**这一节是本文档最重要的部分。** 下面每一条都是实测撞出来的,而且大多**反直觉**。新会话如果不知道这些,极可能重蹈覆辙。

### 坑 1:`allowedTools` 不是白名单(spec 里写错了,必须改)

阶段三 spec `§3` 写的是 `allowedTools: []`,意图「禁用所有工具」。**这是错的。** 官方文档:

> `allowedTools` — Tools to auto-approve without prompting. **This does not restrict Claude to only these tools.**

它只是「免确认列表」,不构成限制。传空数组 = 没有工具被免确认,而全部工具依然可用。`describe-skill.js` 里如果照 spec 写,那个 LLM 调用会拥有**全部工具**——而它执行在删文件、改写全仓引用的**中途**。

**正确写法**:`disallowedTools: ['*']`。文档:「Every tool definition is removed from the request」——从请求里移除,模型压根看不见。

**已经修过的地方**:`src/features/llm-classify.js`、`src/entrypoints/web/tier.js` 都已改成 `disallowedTools: ['*']`(原来是列名黑名单,漏了 `ToolSearch`,实测 haiku 会调 ToolSearch 把被禁的 Read 捞回来,吃掉 `maxTurns: 1` 唯一一轮导致整批作废)。

**顺带**:项目里四处 `allowedTools: ['Read','Grep','Glob']` + `permissionMode: 'default'` 的组合,注释写着「物理上无法改码」——那也不成立,已全部改成 `permissionMode: 'dontAsk'`(文档推荐的锁定写法)。

### 坑 2:超时预算是模型速度的依赖变量

`BATCH_TIMEOUT_MS` 原本 120s 是按 haiku 校准的。换成默认模型后每批实测 127s,日志里 `✔ runClaude {"ms":127093}` 说明**模型成功返回了**,但 race 在 122s 就放弃 → 拿到半截流 → JSON 大括号配不平 → 整批废 → 整个维度 `partial` → 被 `aggregateScore` 踢出总分 = 功能等于没有。

**教训**:换模型档位必须同步重校准超时,否则测到的是超时扛不住,不是模型能力。现在 `check-prompts.js` / `check-comments.js` 都用 300s。

### 坑 3:`validateVerdicts` 必须校验条数

只校验「非空 + 每条结构合法」的话,模型只判 12 条里的 3 条也照样放行,剩下 9 条被**静默当成没问题**,而 `status` 仍是 `done`。这个组合能通过大括号计数(JSON 对象本身完整,只是条目不全)。

现在两个判定层都是 `validateVerdicts(raw, batch.length)`,条数不符直接返回 null 触发重试。

### 坑 4:判定结果必须留档(`verdictLog`)

只有「有问题」的判定会变成 issue,判为「没问题」的连同理由一起被丢弃 → 出现「0 个问题」时**无法区分「模型认真判了且都合格」和「模型摆烂/漏判」**。因为这个盲区白跑了一整轮验证。

现在 `evaluatePrompts` / `evaluateComments` 都返回 `verdictLog`(全部判定,含无问题的,`text` 截 200 / `reason` 截 300),不产 issue、不扣分,纯供审计与回归对比。落盘约 3KB。

### 坑 5:验证样本必须跨来源

死链检测调优时,前三轮只拿**根 `CLAUDE.md`** 做样本,把误报率从 90% 压到 50%,自我感觉良好。一接上**模块级 CLAUDE.md**,153 条死链里 152 条是误报——因为两者的路径书写习惯完全不同(根地图写全路径,模块地图写省略中间层级的片段)。

**教训**:单测只能证明「代码符合我的预期」,证明不了「我的预期符合现实」。任何检测规则都要跨样本验证(根地图 / 模块地图 / rules / 多个项目)。

**2026-08-26 又撞了一次,同一个形状。** `isArchivedPath` 按 `docs/specs/` 前缀匹配,15 条单测全绿——因为夹具 `demote-target` 就是照着这个布局造的。一接真实项目才发现 kxmall-app-ui 和**本仓库**都用 `docs/superpowers/specs|plans/`,中间隔一层,一条都匹配不上,当场改写了 13 份历史设计文档。

**推论**:夹具是照着某一个项目的布局造的,会把那个项目的布局假设一起固化进判定规则,而单测**永远不会**报出来——夹具和规则出自同一个人的同一份想象。凡是「按路径/命名约定判定」的规则,单测之外必须拿真实项目跑一遍。

### 坑 6:`out_of_credits` 不是停止信号

日志里的 `overageStatus: "rejected"` / `out_of_credits` 是**「本账户没开通按量付费兜底」的静态配置标志**,在 418 次 `status:"allowed"`(请求正常放行)的事件里都带着。

**真正的耗尽信号是 `status: "rejected"`**(全库历史只出现 9 次)。次级信号是 `status: "allowed_warning"` 且 `utilization > 0.85`。

曾经把前者当停止条件写进验证任务,结果**永久阻断了这个账户的每一次跑测**。

### 坑 7:haiku 在判定类任务上不够用

实测三个症状同源:
- 判定不稳:同输入三次跑,over-broad 为 4/8/6,**逐条一致率仅 11%**
- 抽象判据学不会:只会照抄 few-shot 里的示例,换一条没见过的同类条目就误判
- 指令遵循度差:明确要求 over-broad 必须给改写建议,6 条里 3 条没给

换默认模型(`JUDGE_MODEL = null`)后:**逐条一致率 100%**,泛化正确,建议齐全。

成本:维度② 单次约 $0.87(39 条候选 / 4 批),维度⑤ 单次约 $0.5-1。有指纹缓存,文件没变直接复用。

### 坑 8:静态层分不出「描述」与「规则」

`sid 归属校验必须先确认 uid 已就绪`(描述代码既有行为)和 `v-show 必须套在原生 <view> 上`(要求作者行为)在**任何静态特征上都完全同构**——同一节、同为列表项、同为粗体开头祈使、义务词位置几乎相同。区别只在主语是代码还是作者。

**当前的处理**:静态层靠「章节分层」绕过去了(`容易踩的坑` 这类经验区不参与召回,但带 ⛔/✅ 强制标记的仍会捞出)。**这是绕过不是解决**——换个不用这种小节命名的项目,问题会回来。LLM 判定层加了 `not-a-rule` 这一档兜底。

### 坑 9:验收样本不能和 few-shot 重合

P3-6 原定的验收判据是「拿 `popup-pattern` 的正文测,人工核对生成的 description」。但 `popup-pattern` 的 description **就是提示词里那条 few-shot 范本**——拿它当样本,模型只要照抄示例就能得满分,而这恰恰**证明不了**它对没见过的规范能不能写好。这类验收会稳定地给出「效果很好」的假信号。

**教训**(与坑 5 同源):选验收样本时先问一句「模型有没有可能是在复述我喂给它的东西」。真值配对要找**独立于提示词**的来源——这次用的是 `.auto` 里的 rules 原文件 × 已优化仓库里人工写的同名 skill。

---

## 五、剩余 4 个 Task

原计划见 `docs/superpowers/plans/2026-08-24-project-optimize-phase3.md`,但**有两处已过时**,以本文档为准。

### ~~P3-6: `describe-skill.js`~~ ✅ 已完成(2026-08-26)

导出 `outlineOf` / `fallbackDescription` / `toYamlScalar` / `describeSkill`,28 测试全绿。

**验收方式改过一处**:原判据说拿 `popup-pattern` 做样本,但**它的 description 正是提示词里的 few-shot**——测它等于让模型抄答案,证明不了泛化。改用 `.auto/.claude/rules/` 的 5 份原文件,其中 3 份在已优化仓库里有**人工写的同名 skill**,构成真值配对。

| 样本 | source | 字数 | 耗时 | 有人工版对照 |
|---|---|---|---|---|
| `figma-restore.md` | llm | 118 | 58.9s | ✅ 持平 |
| `design-system.md` | llm | 117 | 61.5s | ✅ 持平 |
| `keyboard-input-pattern.md` | llm | 170 | 28.3s | ✅ 持平(超 120 字,按设计只告警不截断) |
| `components.md` | llm | 107 | 26.0s | — |
| `style-system.md` | llm | 131 | 37.8s | — |

5/5 走 LLM 路径(无一落兜底),两部分「是什么 + 什么时候调」全部说清、触发场景都用了动作词。单次约 $0.22。
另做了衔接校验:5 份产出喂给 `buildSkillFile` 后 frontmatter 均合法、正文与原文剥 frontmatter 后逐字节一致。

**过程中修掉的一个真缺陷**:`sanitize`(现 `toYamlScalar`)声称「压成可安全写进 YAML 的单行纯量」,但只挡了 `: `,漏掉三种同样危险的写法——

1. **结尾的 `:`**。YAML 里 `:` 只有紧跟非空白字符时才是普通字符;跟着空白**或行尾**都是键值分隔符。原正则 `/:\s/` 要求冒号后有空白,结尾冒号正好从底下漏过去 → `description: 适用于:` 直接抛语法错误 → skill 加载不了。
2. **空白后的 `#`**。YAML 注释起始,`处理 #tag 语法时使用` 会被静默截成「处理」——比加载失败更阴险,skill 照常加载,只是「什么时候调」那半句没了。
3. **开头的指示符**(`[` `-` `#` `>` `*` 等)。模型偶尔回 `[弹框规范] ……` 这种带前缀的写法。

三条都补齐了,并把函数导出以便单测(10 条新测试)。**判断依据是 YAML 规范推演,不是实测**——项目里没有 YAML 库(依赖克制,不该为此加一个),Claude Code 自己的 skill 加载器才是真正的消费者。若日后有条件,值得拿真解析器回归一次。

### ~~P3-7: `fix-rules.js` — 降级执行层~~ ✅ 已完成(2026-08-26)

导出 `collectMarkdown` / `planDemote` / `demoteOne`,18 个 fs 测试(`fix-rules.fs.test.js`,夹具拷进临时目录再动手)。

**签名与原计划有三处出入,都是实现时发现必须改的**:

1. `demoteOne(projectDir, fileName, { onStep, describe })` —— 第三参从裸 `onStep` 改成选项对象,多一个 `describe` 注入点。**不是为了好看**:不注入的话每跑一次测试就是一次真实 LLM 调用($0.22 + 一分钟),而这一层要验的是流程不是文案质量。默认值仍是 `describeSkill`,生产路径不变。
2. 返回值多一个 `fatal:boolean`。原计划说「写 skill / 删原文件失败要停止处理后续文件」,但 `status:'failed'` 同时也表示「源文件读不到」这种**什么都还没写**的情况——后者不该中断整批。不给 `fatal`,P3-8 只能去解析 `reason` 字符串猜。
3. `fix-rules.logic.js` 新增 `hasRuleRef(md, name)` 导出(见下)。

**实测(kxmall-app-ui.auto 副本,真实 LLM 调用)**:

| 阶段 | 结果 |
|---|---|
| 体检前 | rules **60**,两个可修项(design-system.md / keyboard-input-pattern.md) |
| 计划 | 6 项(2 deleted + 2 created + 2 modified),扫描范围 112 份 md |
| 执行 | 两个都 `done`,`descriptionSource: llm`,2 处引用改写,0 失败 |
| 体检后 | rules **100** |
| 还原 | `restored=6 skipped=0 overwritten=0` → rules 回到 **60** |

正文与原文剥 frontmatter 后逐字节一致;`docs/specs/` 三份归档一个字未动。

**实测暴露并修掉的两个真缺陷**:

**① `isArchivedPath` 认不出真实的归档布局(严重)。** 原实现按前缀匹配 `docs/specs/`、`docs/plans/`,而 kxmall-app-ui **和本仓库**都把设计文档放在 `docs/superpowers/specs|plans/` 下,中间隔了一层,完全匹配不上。第一次实测时它改写了 **13 份历史设计文档**——那些文档里写的「见 `.claude/rules/xxx.md`」在当时是事实,改掉就是伪造历史记录。修成「有 `docs` 祖先 + 路径中含 `specs`/`plans`/`migration` 段」后:计划项 21 → 6,改写文件 17 → 2,扫描范围 275 → 112 份。

要求必须有 `docs` 祖先是刻意收窄:业务代码里正常会有叫 `plans` 的目录(订阅套餐、行程计划),连它一起保护只会留下失效引用。

**② `replaceRuleRefs` 会改到没有引用的文件。** 它末尾那两条空格清理(`技能 的` → `技能的`)是**全局替换**,而这三个字在任何一篇讲 skill 的文档里都会自然出现。于是一次降级会顺手改掉全仓所有含该字串的 md,这些改动既不在计划里(所以没进备份)也和本次降级无关。修法是无引用时整个短路,并抽出 `hasRuleRef` 让「判断要不要改」和「实际怎么改」共用同一个口径(有单测把两者钉在一起)。顺带把正则改成 `split/join`,省掉元字符转义。

**保留的设计**(与原计划一致):降级五步、核心失败即停、`SKIP_DIR` 另加 `worktrees`(往 worktree 里写等于污染别的分支的工作区,且改动落在备份之外)。

### P3-8: fix 编排 + 串行闸

⚠️ **计划文档过时**:原计划说「新建 `optimize-ops.js`」,但**该文件在阶段二已创建**(体检的 SSE 编排,含 `startCheckup`/`getCheckupJob`/`attachCheckupJob`)。你要**加进现有文件**,复用它的 job 注册表模式。

**要做**:
- `startFix({dir, dimensions, force})` → `{jobId}` 或 `{needsConfirm: true, dirtyCount, isRepo}`
- 开跑前 `checkWorkspace(dir)`(`git-guard.js`),脏工作区且非 force → 返回 `needsConfirm`
- 只处理体检报告里 `fixable: true` 的项 —— **必须尊重 `R2_DEMOTE_UNCERTAIN`**(「有 frontmatter 但解析不出 paths」的文件故意标成不可自动修)
- `planDemote` → `createBackup` → 逐个 `demoteOne` → 重新体检
- SSE 推进度(`step` 事件)+ 最终结果(`done` 事件)
- **串行闸**:用 `store/optimize.js` 的 `setBusy` 落盘,防止同一项目并发优化

**顺带修一个阶段二遗留**:体检本身也没有串行闸,同一目录并发体检会白烧一倍额度。接在同一个 `busy` 机制上。

**`recordPostState` 待接**:`backup.js` 导出了它但没有调用方。要在 `demoteOne` 循环结束后、重新体检之前调一次,记录「优化后内容哈希」。没有它的话还原会退化成「无条件覆盖 + 上报 overwritten 列表」(安全但保护弱)。

**这条链路已在 P3-7 实测里手工串过一遍并跑通**(`planDemote` → `createBackup` → 循环 `demoteOne` → `recordPostState` → `checkRules` → `restoreBackup`),结果见上面 P3-7 的实测表:还原时 `skipped=0 overwritten=0`,说明 postHash 基准生效了。P3-8 照这个顺序接即可。

**停止条件用 `demoteOne` 返回的 `fatal`**,别去解析 `reason` 字符串:`status:'failed'` 同时覆盖「什么都没写就失败」(不该中断)和「写到一半失败」(必须中断),只有 `fatal` 分得开。

### P3-9: 路由扩展

在 `src/entrypoints/web/routes-optimize.js` 加四个接口(照现有两个的写法):

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/optimize/fix` | `{dir, dimensions, force?}` → `{jobId, backupDir}` 或 `{needsConfirm}` |
| GET | `/api/optimize/fix-stream?jobId=` | SSE 进度 |
| GET | `/api/optimize/backups?dir=` | 备份列表 |
| POST | `/api/optimize/rollback` | `{dir, dirName}` → `{restored, skipped}` |

注意:`logger` 签名是 `logger.warn(tag, msg, extra)` **三段式**。

### P3-11: 前端接线

`public/js/optimize-fix.logic.js` 已完成(9 测试),导出 `canFix` / `fixButtonLabel` / `summarizeResults` / `scoreDelta`。

**要做**:
- `#optFix` 解除禁用,条件用 `canFix({hasReport, selected, running})`
- 点击 → `POST /api/optimize/fix`;若返回 `needsConfirm` 用 `ui.js` 的 `confirmDialog` 弹确认(文案:「工作区有 N 个未提交改动,优化产生的改动会和它们混在一起,难以区分」),确认后带 `force: true` 重发
- 接 `EventSource('/api/optimize/fix-stream?jobId=')`,`step` 事件追加进度行,`done` 渲染结果区
- 结果区展示:每个文件的处理结果 + **生成的 description 全文 + skill 文件路径**(用户拍板的 A 方案:让用户当场看到并能手工改)
- `notes` 逐条展示(根 CLAUDE.md 索引表需手工调整的提示等)
- [重新体检] / [还原本次优化] 两个按钮

**硬约束**:所有来自后端的文本一律 `createElement` + `textContent`,**禁 innerHTML**(项目硬性约定,渲染的是 LLM 产出)。

### P3-12: 真实项目验证

**先复制副本再动**,不要直接改 `kxmall-app-ui.auto`:

```bash
node -e "const fs=require('fs'),os=require('os'),path=require('path');const t=path.join(os.tmpdir(),'kxmall-fix-test');fs.rmSync(t,{recursive:true,force:true});fs.cpSync('C:/Users/DELL/Desktop/kxmall-app-ui.auto',t,{recursive:true,filter:(s)=>!s.includes('node_modules')&&!s.includes('.git')});console.log(t)"
```

对副本:体检(rules 应为 60)→ 一键优化 → 重新体检(rules 应涨到 100)→ 还原 → 应回到 60。**逐项记录实际数字。**

**人工检查生成的 skill 质量**(这步不能跳):打开生成的 `SKILL.md`,读 description 是否说清「是什么」+「什么时候调」;正文是否与原 rules 文件除 frontmatter 外完全一致。

---

## 六、协作约定(用户明确要求)

1. **不要自动 git 提交**。所有改动留工作区,提交时机由用户掌控。当前 `HEAD` 是 `68b548c`,本工具的全部代码都是未提交状态。
2. **大改动前先出 spec 和实现计划,等用户拍板再动手。**
3. 文档和注释用中文,注释解释「为什么」而不是复述代码。
4. **派 subagent 时明确告知「发现规则/方案有问题就报告,不要硬做」** —— 这一轮 subagent 多次推翻了错误的指令(包括上面坑 1、坑 6 的发现),价值极高。

## 七、给 subagent 的 prompt 模板要点

这轮总结出的有效做法:

- **给完整任务文本,不让它读计划文件**(省一次文件读取,且能精确控制上下文)
- **给「为什么」不只给「做什么」** —— 它需要判断力时才有依据
- **验收判据要可判定**,不能是「跑通不报错」。最好给真值(比如「这条必须被捞出、那条必须被排除」)
- **明确范围边界**,列出不许碰的文件(这轮多个 agent 并行,靠这个避免冲突)
- **要求拿真实数据验证 + 人工核对**,不能只跑单测
- **明确停止条件**,并说清什么**不是**停止信号(见坑 6)
- **禁止 git 写操作**要每次都写

---

## 八、已知局限(记录在案,非缺陷)

1. **注释维度的抽样有系统性偏差**:`extractCommentBlocks` 取文件的**前 10 块**而非随机 10 块,而文件头通常是写得最认真的模块 JSDoc → 对大文件天然偏乐观,埋在函数体中段的死代码/过时注释**系统性采不到**。另有 `MAX_TOTAL_BLOCKS = 48` 的成本闸,30 个采样文件里实际只有 5 个被判定,score 密度口径偏宽松。
2. **抽样浪费在文件副本上**:`SKIP_DIR` 没有 `target`,也没有跨文件内容去重,同一文件的三份拷贝会各吃一份配额。
3. **提示词维度的章节判据带项目语汇色彩**:`DESCRIPTIVE_HEADING` 词表是从 kxmall 的文档模板归纳的,换个命名习惯的项目效果打折。已在代码注释里用 ⚠️ 标注,并留了两个安全阀(⛔/✅ 直通、义务词开头的祈使句)。
4. **失败降级只做了推演验证**:`partial`/`error` 路径的正确性靠 `aggregateScore` 排除逻辑的实测 + 单测覆盖,没有真跑出一次 LLM 失败来端到端确认。
5. **`verdictLog` 跟着 SSE 和报告一起下发**,一次几 KB。候选量大时 `optimize.json` 单项目记录会变胖。

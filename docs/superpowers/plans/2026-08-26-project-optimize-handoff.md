# 「项目优化」工具 · 交接文档

> 日期: 2026-08-26 · 用途: 新会话接手剩余工作
> 相关文档: `docs/superpowers/specs/2026-08-24-project-optimize-design.md`(总设计)、
> `-phase2-design.md`(LLM 维度)、`-phase3-design.md`(一键优化)、`-phase3.md`(阶段三 12 task 计划)

---

## 一、现状一句话

体检功能(四个维度)和一键优化(rules 降级 + 备份还原)**都已完整可用**,阶段三 12 个 task 全部完成,并在真实项目上跑通「体检 → 优化 → 还原」闭环。

## 二、这个工具是什么

web 执行台(`claude-p-web-demo`)里的一个面板:选一个本地项目 → 点「体检」→ 出分 + 问题清单 → 勾选维度 → 点「一键优化」自动修复。交互参照 360 安全卫士。

**起因**是一次实测事故:某项目的 `CLAUDE.md` 写着「禁止做出假设——具体结论必须给出 `文件:行号` 依据」,这条没区分「代码事实」和「需求输入」,导致 AI 把用户在需求里直接给定的 agent code 也当成待验证假设,跑到另一个仓库翻数据库定义,一个「改个跳转」的定点任务跑了 20 分钟。这类问题**隐蔽、复利、人工排查成本高**——不报错,只让每次开发都慢一点。

## 三、已完成状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| 一 | 静态体检:维度① 项目地图、维度③ rules 降级检测 | ✅ 完成 |
| 二 | LLM 维度:维度② 提示词质量、维度⑤ 注释合理性 + SSE 异步回填 | ✅ 完成 |
| 三 | 一键优化:rules 降级 + 备份还原 | ✅ 完成 (12/12) |

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

src/features/project-optimize/         ← 阶段三，已完整可用
├── fix-rules.logic.js    (+test)      21 测试  ✅ 降级文本变换
├── fix-rules.js       (+fs.test)      18 测试  ✅ 降级执行层（扫盘/写盘/删盘/失败分级）
├── fix-plan.logic.js     (+test)      12 测试  ✅ 选材（含 R2 拦截）+ 手工待办提示
├── describe-skill.js     (+test)      28 测试  ✅ description 生成 + YAML 纯量净化
├── backup.logic.js       (+test)       6 测试  ✅ 备份纯逻辑
├── backup.js                                   ✅ 快照/还原/保留策略
├── git-guard.logic.js    (+test)       6 测试  ✅ porcelain 解析
└── git-guard.js                                ✅ 工作区检查

src/entrypoints/web/
├── routes-optimize.js  (+test)        21 测试 ✅ 六个接口全通
└── optimize-ops.js                             ✅ 体检 + 优化 + 还原编排（含串行闸）

src/store/optimize.js  (+test)          10 测试 ✅ 串行闸 acquireBusy/releaseBusy + 优化历史
public/js/optimize-view.logic.js                维度列表摊平（体检部分）
public/js/optimize-fix.logic.js (+test) 15 测试 ✅ 一键优化前端纯逻辑
public/js/optimize-view.js                      ✅ 面板：体检 + 优化 + SSE + 结果区
tests/fixtures/projects/                        healthy / no-map / kxmall-like / demote-target
```

**全套测试当前 1605 条,1603 通过。** 那 2 条失败是既有的、与本工具无关(`public/js/chat.path.test.js` 断言 `.md` 图标是 📄,而 `chat.js` 实际给 📝——两个文件在 git 中均未修改,是 HEAD 内容漂移)。

> 注:总数会随其它会话的并发改动浮动。跑全量时若看到 `public/js/` 下的额外失败(如
> `req-chat.apidoc.test.js` 报 `ResizeObserver is not defined`),先确认那些文件是否正被别人改——
> `public/` 里没有任何代码引用 `project-optimize`,本工具不可能影响它们。

### 实测效果(可信的基线)

| 项目 | 分数 | 说明 |
|---|---|---|
| `kxmall-app-ui`(已优化过) | rules 100 / map 64 | 死链检出 2 条,其中 1 条是真失效引用 |
| `kxmall-app-ui` 优化前快照<br>(`git archive 212c76ad^`) | 总分 **56**<br>map 64 / prompts 57<br>rules 41 / comments 52 | P3-12 的验收对象。rules 捞出 4 个该降级的(13.7 / 14.6 / 7.0 / 5.8 KB),<br>2 个小文件正确地没动。优化后 rules **41 → 100**,还原后回到 41。 |
| `claude-p-web-demo`(本仓库) | 0 | 根本没有 CLAUDE.md |

> `kxmall-app-ui.auto` 那份副本已被删除,原表里基于它的 rules 60 基线不再可复现;
> 上面这行用 git 里的真实历史快照替代,数字更可信(是当时的原样,不是合成的退化副本)。

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

**2026-08-26 P3-12 又原样撞了一次,连数字都一样。** `describe-skill.js` 的 `DESCRIBE_TIMEOUT_MS` 是按「单独跑一次 54.5s」校准到 120s 的,看起来余量翻倍很安全。真实项目验收时 `keyboard-input-pattern` 那次日志赫然是 `✔ runClaude {"ms":127091}` —— 模型成功返回,race 在 122s 放弃,答案晚到 5 秒,静默落了机械兜底。同一次跑里另外三个是 91.6s / 34.9s / 35.3s,**波动接近 4 倍**。

**教训升级**:超时预算不能按「单次实测值 + 一点余量」定,要按**连续跑 / 并发时的长尾**定 —— 单独跑一次测到的是最好情况,而线上永远是连着跑的。已提到 300s 并复跑验证(107s、`source: llm`)。

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

## 五、12 个 Task 的落地记录

**全部完成。** 下面按 task 记录实际做法、与原计划的出入、以及实测数字——
出入都是实现/验收过程中被真实数据推翻的,不是随意改的。

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

### ~~P3-8: fix 编排 + 串行闸~~ ✅ 已完成(2026-08-26)

`optimize-ops.js` 新增 `startFix` / `getFixJob` / `attachFixJob`;`store/optimize.js` 新增串行闸与优化历史。

⚠️ **交接文档自己写错了一处**:上一版说「`setBusy`/`saveFixResult` 已写但未接」——**代码里根本没有这两个函数**,是本轮补的(实现为 `acquireBusy`/`releaseBusy`/`getBusy`/`saveFixResult`)。

**`startFix(dir, {dimensions, force})` 的四种返回**:

| 返回 | 含义 | 路由应给的状态码 |
|---|---|---|
| `{jobId}` | 已开跑,去接 SSE | 200 |
| `{needsConfirm, dirtyCount, isRepo, files}` | 工作区脏,要用户确认 | 200 |
| `{nothing: true, blocked}` | 没有可自动修的项 | 200 |
| `{busy: {kind, at, jobId}}` | 该项目正被占用 | 409(`busy.jobId` 可直接拿去接 SSE) |
| 抛错 | 还没体检过 | 400 |

**串行闸的实现要点**:

- **落盘而非进程内变量**。PM2 同时跑 claude-web 和 claude-feishu 两个进程,进程内的锁拦不住另一个进程。`updateJson` 是同步的且带跨进程文件锁,所以「检查 + 占位」写在同一个回调里天然是一次原子 CAS。
- **闸必须抢在 `checkWorkspace` 之前**。那一步要起 git 子进程(几十毫秒起步),等它期间足够第二个请求把前面的只读检查整个跑完 —— 实测两个并发 `startFix` 确实是一个拿 jobId、一个被挡。
- **`needsConfirm` 要先放闸**,否则用户点「确认」重发时会被自己挡住。
- **`BUSY_STALE_MS = 60min` 的过期兜底**。没有它,一次崩溃就把该项目永久锁死。取 60 分钟是按最坏情况估的(每文件一次 description 最长实测 82s + 体检单批预算 300s)。
- **job id 先生成再抢闸**,写进占用记录 —— 被挡下的第二个标签页因此能拿着 `busy.jobId` 接同一条 SSE,而不是只被告知「有人在跑」。
- 体检也接上了同一把闸(原来没有,同一目录并发体检会白烧一倍额度)。为此把 `startCheckup` 拆成「闸 + `runCheckup` 内核」:优化结束要重跑体检,而那时优化自己正持着闸,走 `startCheckup` 会被自己挡在门外。

**⚠️ 与原计划的一处实质分歧:优化后不自动重跑 LLM 维度。**

原计划写的是「重新体检」。照做的话每次优化都要额外等几分钟、花约 $0.9。改成只重算静态维度,并把两个 LLM 维度标成 `pending` + reason「规则已变动,请重新体检以刷新 AI 分析」。

为什么不能把上一轮的 LLM 结论原样留着:那些 issue 指向的文件可能已经被移走了,展示出来就是在报不存在的问题。指纹缓存不受影响 —— 注释维度的源码没动,用户点「重新体检」时会直接命中缓存,不会重复计费。

**连带影响**:总分口径在优化前后不一致(优化前 LLM 维度参与加权,优化后被 `aggregateScore` 排除并重新分摊权重),所以 `done` 事件里给的是 **rules 维度的 before/after**(`{rules: {before, after}}`),不是总分。P3-11 的 `scoreDelta` 要喂这一对。

**SSE 事件**:`step`(phase 为 `plan`/`backup`/`describe`/`write-skill`/`delete-rule`/`replace-refs`/`abort`)、`file`(单个 `demoteOne` 结果)、`done`。与体检的 replay 不同,优化存的是**有序事件流**(`job.events`)而不是「按维度覆盖」,因为进度有先后语义。

**顺带修的契约冲突**:`public/js/optimize-fix.logic.js` 的 `summarizeResults` 按数字读 `refsUpdated`,而 `demoteOne` 返回的是文件路径**数组** —— `Number(['a','b'])` 是 NaN,统计恒为 0。这个契约是在 `demoteOne` 实现之前先写好的,猜错了生产者的形状。已改成按数组长度计,并补了 `refsFailedTotal`(引用改写失败意味着文档里留了指向已删除文件的路径,不能只统计成功数)。

**实测(kxmall-app-ui.auto 副本,真实 LLM 调用,数据目录隔离到临时目录)**——22 项断言全过:

| 场景 | 结果 |
|---|---|
| 未体检就优化 | 抛「请先跑一次体检」 |
| 脏工作区(git init + 1 个未提交文件) | `needsConfirm`,`dirtyCount=1`,`isRepo=true`,闸已释放 |
| 两个 `startFix` 并发 | 一个拿 jobId,另一个 `busy.kind='fix'` 且 `busy.jobId` 指向前者 |
| 事件流 | `plan → backup → (describe → write-skill → delete-rule → replace-refs) × 2` |
| 结果 | 两个文件都 `done`,rules **60 → 100**,闸已释放,历史已落盘 |
| notes | 「勾选的 comments 维度暂无自动修复能力」 |
| SSE replay | 已完成的 job 立刻 `end()`,不把连接挂在 subs 里干等 |
| 还原 | `restored=6 skipped=0 overwritten=0` → rules 回到 60 |

`overwritten=0` 说明 `recordPostState` 生效了(有 postHash 基准,不必退化成无条件覆盖)。

### ~~P3-9: 路由扩展~~ ✅ 已完成(2026-08-26)

`routes-optimize.js` 现有六个接口,21 个路由测试(`routes-optimize.test.js`,真起 HTTP server + fetch)。

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/optimize/report?dir=` | `{report, history}` |
| POST | `/api/optimize/checkup` | `{report, checkupId}` / **409** `{busy}` |
| GET | `/api/optimize/checkup-stream?checkupId=` | SSE |
| POST | `/api/optimize/fix` | `{jobId}` / `{needsConfirm,dirtyCount,isRepo,files}` / `{nothing,blocked}` / **409** `{busy}` / 400 未体检 |
| GET | `/api/optimize/fix-stream?jobId=` | SSE,未知 id → 404 |
| GET | `/api/optimize/backups?dir=` | `{backups:[{at,dirName,fileCount,dimensions,postRecorded}]}` |
| POST | `/api/optimize/rollback` | `{restored,skipped,overwritten,report}` / **409** `{busy}` / 400 |

⚠️ **原计划表里写的 `POST /fix` → `{jobId, backupDir}` 做不到**:备份目录是在 `runFix` 里创建的,POST 返回时还不存在。`backupDir` 走 SSE 的 `backup` 步骤事件和最终 `done` 载荷下发。

**三处原计划没提、但必须有的东西**:

1. **`POST /rollback` 也要走串行闸**。优化跑到一半时还原,两边交错写同一批文件——还原把文件写回旧版,紧接着降级又把它删掉,最终状态既不是优化后也不是优化前,比「不让还原」糟得多。
2. **`dirName` 要按「本项目已有快照之一」做白名单**。它来自请求体且要拼进 `path.join(dir, '.claude/optimize-backup', dirName)`,`'../../evil'` 正好退回项目根再进 `evil/` —— 那里放一份 `manifest.json` 就能让还原照着攻击者写的清单往任意位置写文件。用白名单卡比过滤 `../` 的黑名单可靠。
   > 这条的测试一开始是**空洞的**:只传 `'../../etc'`,那个位置本来就没有 manifest,不加校验也照样报「备份不存在」。改成真埋一份可达的 manifest 后,用突变测试确认过——去掉白名单该用例即失败(攻击成功)。
3. **`POST /checkup` 要处理 `{busy}`**。这是 P3-8 给体检加闸引入的新分支,原代码直接解构 `{report, checkupId}`,被挡时回 `200 + report: undefined`,前端会当成「体检完成但没结果」把已有报告清空。

**统一口径**:凡是被串行闸挡下的一律 **409**,绝不回 200 加空结果。

**入参卫生**:`dimensions` 只认字符串数组(`Array.isArray(...) ? map(str).filter(Boolean) : []`)。传成 `'rules'` 这种裸字符串时当作没勾任何维度——否则脏形状会被原样写进备份 manifest。

注意:`logger` 签名是 `logger.warn(tag, msg, extra)` **三段式**。

**路由测试怎么做到不发 LLM 调用**:happy path 用「报告里标了可修、但磁盘上没有」的规则文件(`ghost.md`)。`demoteOne` 在第一步前置校验就返回 `failed`(非核心失败),整条管线照常跑完并产出真实的 jobId 与可测的已完成 job,但一次 `describeSkill` 都不会发生。真实降级的验证在 P3-8 的实测里做过。

### ~~P3-11: 前端接线~~ ✅ 已完成(2026-08-26)

`optimize-view.js` 接上四个接口 + SSE;`optimize-fix.logic.js` 补 `stepLabel` / `dirtyConfirmMessage`(15 测试);`index.html` 加进度区与结果区;`app.css` 加对应样式。

**先补了一个后端缺口**:P3-11 要展示「生成的 description 全文」,但 `demoteOne` 只返回了 `descriptionSource`,**没返回 description 本身**。已加 `description` 和 `skillFile` 两个字段——只给 source 的话,用户想复核还得自己去翻文件,那就等于没人会复核。

**真实浏览器验证**(playwright,对 kxmall-app-ui 的临时副本人为退化成未优化态):

| 检查项 | 结果 |
|---|---|
| 点击后按钮态 | 一键优化「优化中…」禁用、体检同步禁用 |
| 进度流 | `规划要处理的文件 → 创建还原快照 → (生成技能描述 → 写入技能文件 → 删除原规则文件 → 改写文档引用) × 2` |
| 结果区 | 3 个文件三种状态(2 done / 1 skipped),左边框按状态染色 |
| 分数 | 「规范加载方式 49 → 80（+31）」 |
| notes | 「勾选的 map 维度暂无自动修复能力」 |
| 按钮 | [重新体检] [还原本次优化] 都在 |

**顺手修的三个前端问题**:

1. **体检按钮在 AI 分析期间可以重复点**(用户反馈的真 bug)。原来只在 POST 期间禁用,而 POST 几百毫秒就返回,LLM 维度还要跑好几分钟——用户看到按钮恢复,会以为体检结束或以为卡住又点一次,每点一次都是一整轮额度。改成三态 `checkupBusy`(`''`/`posting`/`analyzing`),`analyzing` 由 SSE 开合驱动。
2. **`hidden` 属性被 `display:flex` 盖掉**。`.opt-progress` / `.opt-result` 默认带 `hidden`,但 CSS 的 `display:flex` 优先级更高,空盒子会一直占着一条带边框的空白(截图里看到才发现)。补 `[hidden] { display: none; }`。
3. **勾选状态存 DOM 会被冲掉**。`render()` 每次重建全部卡片,一次 SSE 维度回填就把用户的勾选重置。改成模块级状态,且记的是**「被主动取消」的集合**而不是「被勾选」的——这样异步回填刚落地的维度会自动纳入、变得不可选的会自动剔除,不需要额外重算逻辑去追。

**样式调整**(用户要求「按钮大一些、美化一下」):两个主操作按钮 14px/10px×26px,分数区做成带背景的卡片,维度卡加 hover 态,问题清单加左侧竖线。

### ~~P3-11 原始要求~~(存档)

`public/js/optimize-fix.logic.js` 已完成(9 测试),导出 `canFix` / `fixButtonLabel` / `summarizeResults` / `scoreDelta`。

**要做**:
- `#optFix` 解除禁用,条件用 `canFix({hasReport, selected, running})`
- 点击 → `POST /api/optimize/fix`;若返回 `needsConfirm` 用 `ui.js` 的 `confirmDialog` 弹确认(文案:「工作区有 N 个未提交改动,优化产生的改动会和它们混在一起,难以区分」),确认后带 `force: true` 重发
- 接 `EventSource('/api/optimize/fix-stream?jobId=')`,`step` 事件追加进度行,`done` 渲染结果区
- 结果区展示:每个文件的处理结果 + **生成的 description 全文 + skill 文件路径**(用户拍板的 A 方案:让用户当场看到并能手工改)
- `notes` 逐条展示(根 CLAUDE.md 索引表需手工调整的提示等)
- [重新体检] / [还原本次优化] 两个按钮

**硬约束**:所有来自后端的文本一律 `createElement` + `textContent`,**禁 innerHTML**(项目硬性约定,渲染的是 LLM 产出)。

### ~~P3-12: 真实项目验证~~ ✅ 已完成(2026-08-26)

**验证对象换了**:计划里说的 `kxmall-app-ui.auto` 已不存在,而 `kxmall-app-ui` 本身早就优化过了(rules 100)。改用 `git archive 212c76ad^`(那次优化提交的父提交)导出的**真实未优化快照**——比上一轮临时合成的退化副本可信得多:它的 rules 文件、docs 里的引用写法、CLAUDE.md 索引表都是当时的原样。

全程走 HTTP 接口,数据目录未隔离(就是真实的 optimize.json),验完已清掉记录;真实仓库全程只被 `git archive` 只读访问,`git status` 确认 `.claude/rules`、`.claude/skills` 零改动。

**逐项数字**:

| 阶段 | 结果 |
|---|---|
| 完整体检(含两个 LLM 维度) | 217s;总分 **56**(needs-work)、45 项问题<br>map 64(9) / prompts 57(8) / rules 41(4) / comments 52(24) |
| rules 可修项 | 4 个:design-system 13.7KB、popup-pattern 14.6KB、keyboard-input-pattern 7.0KB、style-system 5.8KB<br>components(2.7KB)、figma-restore(1.7KB)未达阈值,正确地没动 |
| 一键优化 | 4 个全 `done`,**rules 41 → 100**,18 处引用改写、0 失败 |
| 备份 | 20 个文件,`postRecorded: true` |
| 还原 | `restored=20 skipped=0 overwritten=0` → **rules 回到 41**,六份 rules 内容逐字节一致 |

**人工检查生成的 skill**:3 份 LLM 产出「是什么 + 什么时候调」两部分齐全、触发场景都用了动作词,与仓库里人工写的同名 description 质量相当。注意 `popup-pattern` 是**被污染的样本**(它的人工 description 正是提示词里的 few-shot,见坑 9),不能拿它当泛化证据;`style-system` 在真实仓库里没有对应 skill,是干净样本,质量同样合格。

**跨规则引用的处理顺序在真实项目上得到验证**:`.claude/rules/popup-pattern.md` 引用了另外两个待降级的规则,它在自己被降级**之前**先被改写了引用;之后 style-system 降级时又改写了已生成的 `.claude/skills/popup-pattern/SKILL.md`。最终 popup-pattern 的正文与原文有且只有 **3 行**不同,全是引用替换——这说明原验收判据「正文与原 rules 文件完全一致」**是不完整的**,没考虑规则之间互相引用的情况。

#### 实测揪出的两个缺陷

**① `DESCRIBE_TIMEOUT_MS = 120s` 太紧 —— 坑 2 的原样重演(重要)。**

`keyboard-input-pattern` 的 description 落了机械兜底。查日志:调用 08:50:05 发起,`✔ runClaude {"ms":127091}` —— **模型成功返回了**,但 race 在 122s(budget+2s)就放弃,答案晚到 5 秒。127091 这个数字和 `check-prompts` 当初撞的**完全一样**。

同一次跑里另外三个是 91.6s / 34.9s / 35.3s,**波动接近 4 倍**:模块注释里那个 54.5s 是单独跑一次测出来的,而连续多次调用、赶上限流排队时的长尾远超它。已提到 300s(对齐 `BATCH_TIMEOUT_MS`),并用同一份输入复跑验证:**107s、`source: llm`、119 字、质量合格**,确认根因是超时而非内容。

**教训补充**:超时预算不能按「单次实测值 + 一点余量」定,要按**并发/连续跑的长尾**定。

**② 引用替换后的空格清理是按助词枚举的,补不完。**

原实现只有 `技能 的` → `技能的` 和 `技能 「` → `技能「` 两条写死规则。真实项目里撞到第三种:popup-pattern.md 写的是「以 \`xxx.md\` 为准」,替换后留下「技能 为准」。改成按字符类判定(后接中日韩文字或中文标点就收紧,跟拉丁字母时保留空格),两条特例合并成一条通则。

#### 附带确认

- **兜底路径有了第二次真实观测**。它**没有任何刺眼信号**——分数照涨、状态照样 `done`,唯一线索是结果区里那句读起来像模板的描述。这正是把 description 全文摊在 UI 上的理由。
- **`notes` 的索引表提示在真实项目上命中**:根 CLAUDE.md 里四个规则的裸文件名都还在(那是一张「规则文件 | 覆盖范围」的表格),自动替换只认带反引号的完整路径,确实需要人工处理。

### ~~P3-12 原始要求~~(存档)

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
4. ~~**失败降级只做了推演验证**~~ **2026-08-26 撞到一次真的**:P3-11 浏览器验证期间,`keyboard-input` 的 description 生成失败(日志 `LLM 未产出 description，改用机械兜底`,reason 为「调用失败/超时/额度耗尽」),`describeSkill` 如设计落了 `fallbackDescription`,兜底文案一路正常传到 UI 并渲染出来,降级本身照常完成。至此这条路径有了一次端到端的真实观测。
   注意它**没有任何刺眼的信号**——分数照涨、状态照样 `done`,唯一的线索就是结果区里那句读起来像模板的描述和 `⚠️ 提示` 行。这正是 `describe-skill.js` 开头说的那种失败,也是把 description 全文摊在 UI 上的理由。
   `partial`/`error` 维度路径仍只有单测覆盖,没真跑出来过。
5. **`verdictLog` 跟着 SSE 和报告一起下发**,一次几 KB。候选量大时 `optimize.json` 单项目记录会变胖。

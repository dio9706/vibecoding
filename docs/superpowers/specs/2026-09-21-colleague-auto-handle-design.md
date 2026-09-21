# 后端同事消息自动处理（同事中继四期）· 设计

> 状态：待实现 ｜ 日期：2026-09-21 ｜ 影响面：`src/plugins/colleague-relay/`、`src/entrypoints/feishu/index.js`、`src/entrypoints/web/`（新增 `colleague-auto*.js`，改 `requirement-ops.js` / `routes-requirements.js`）、`src/store/colleague-messages.js`、`public/js/req-view.js` / `chat.js` / `req-chat.js`

## 一、背景与目标

三期把「后端同事 ↔ 机器人」的飞书对话归入了需求（`colleague-relay` 插件 + `feishu/index.js#relayColleagueAttachment`），消息落 `colleague-messages.json`，回一句「已收到，信息会同步发送给主机！」，剩下的全靠主机在 web 端手动看、手动处理。`store/colleague-messages.js` 文件头当时就写明：条目带 `role` / `files[].path` / `handledBy`，是「为四期让 AI 按职位自动处理留的形状（后端发接口文档 → `/api/req/apidoc`）」。

本设计就是那个四期，范围**只限后端同事**：

- **发文件**：识别是否接口文档 → 是则登记为需求的 API 文档、新开子会话让 Claude 对照文档修正调用、回复「接口文档已收到，开始接入开发」；不是则维持三期行为。
- **发文字**：LLM 判断这段话是否含需要前端改代码配合的具体信息 → 是则新开子会话、发 LLM 组织好的提示词；不是则维持三期行为。
- 子会话跑完回同事一句简报，主机在 web 端能看到 AI 替他说了什么、做了什么。

### 关键判断：能复用的都已存在，缺的是三段接线

| 已有件 | 位置 | 复用方式 |
|---|---|---|
| API 文档登记 | `routes-requirements.js#handleApidocPost` | 抽出 `registerApiDoc` 供路由与自动处理共用 |
| api-fix 提示词 | `req-logic.js#buildApiFixPrompt` | 原样用 |
| 系统任务串行闸 + 泵 | `requirement-ops.js#enqueueSystemTask / dispatch` | 加一个 kind |
| LLM 单轮分类 | `capabilities/llm-classify.js#runClassifierOnce` | 两个分类点 |
| docx → 文本 | `integrations/docx.js#docxToMdFile` | 喂分类器前转一次 |
| 飞书私聊回发 | `integrations/lark.js#sendTextToUser` | 与 `handleColleagueSend` 同一条路 |
| 跨进程直送范式 | `create-session` / `bug-patrol#postStart` | 3s 超时 + 非 JSON 不抛穿 |
| 子会话数据 | `req.sessions[] kind:'sub'` | 服务端也能 push |

缺的三段：① 飞书进程归属确定后通知 web；② web 进程的分类与编排；③ 前端对「服务端建的子会话」的打开能力（目前 `openConv` 对 localStorage 里没有的 conv 直接 return）。

## 二、拍板记录

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 分类与编排落在哪个进程 | **web 进程统一编排**；飞书进程只 fire-and-forget 一个 POST。起 run 必须在 web（泵在那里），分类也放 web 就一条链路一处日志 |
| 2 | 新会话与主会话 / bug-fix 的并发 | **走需求串行闸**（`enqueueSystemTask` 新 kind）。绝不两个 Claude 同时改同一工作区；代价是同事收到「开始接入」后可能排队几分钟才真开跑 |
| 3 | 文字「是否需要处理」由谁判、判后授权 | **LLM 判 + 自动改**（`bypassPermissions`，与 bug-fix 同一授权级）。需要 → 起子会话；不需要 → 只归档 + 现状 ACK |
| 4 | 子会话跑完是否回同事 | **要，回一句简报**（取 run 结果截 200 字）。对后端来说这才算闭环，否则他不知道该不该联调 |
| 5 | 三期 ACK 是否改文案 | **不动**。「已收到，信息会同步发送给主机！」语义永远成立，且 web 不可达时同事至少收到这一句；自动处理**触发时**才追加第二句 |
| 6 | 新会话形态 | **需求子会话**（`sessions[] kind:'sub'`，挂会话树、用需求工程目录），**新 session 上下文**（不 resume `devSession`，不打断主会话） |
| 7 | 是否加设置开关 | **不加**。跟随 `colleague-relay` 插件启停；授权级与 bug-fix 一致 |

## 三、数据流

```
飞书进程                                            web 进程
────────                                            ────────
后端同事发文字 / 文件
  ↓
resolveTargets → 单需求直归 ／ 多需求选卡→flush
  ↓（归属确定，三处汇合）
appendMessage / flushPending（拿到 msgIds）
  ↓
notifyAutoHandle(reqId, colleagueId, msgIds)
  = POST /api/req/colleague-messages/auto ──跨进程──→ handleColleagueAuto（四道校验后 fire-and-forget）
  （3s 超时，失败只 warn；消息已落盘不丢）                ↓
                                                  autoHandleMessages 逐条：
                                                    ├ 有 files → 接口文档识别（§4.1）
                                                    │    是 → registerApiDoc → enqueue('colleague-dev')
                                                    │         → 回「接口文档「x」已收到，开始接入开发」
                                                    │    否 → 无动作
                                                    └ 无 files → 文字判定（§4.2）
                                                         需要 → enqueue('colleague-dev') → 回「已收到，正在接入处理：<summary>」
                                                         不需要 → 无动作
                                                              ↓
                                                  泵 dispatch('colleague-dev') → dispatchColleagueDev（§5）
                                                    → sessions[].push 子会话 → busy={kind,runId,convId}
                                                    → startClaudeRun(bypass, 新 convId, 新 session)
                                                    → onSettle：清 busy / 回填 sessionId / markHandled / 回简报
```

## 四、分类（web 进程）

新文件 `src/entrypoints/web/colleague-auto.js`（编排，有 IO）+ `colleague-auto.logic.js`（纯逻辑：扩展名白名单、两个 prompt、输出解析、简报截取）。

### 4.1 接口文档识别（两级）

1. **本地快路**：`files[0].name` 扩展名 ∉ `{md, txt, json, yaml, yml, docx}` → 不是接口文档，结束。pdf 本仓无文本抽取能力，归「无法识别」走三期行为；图片同理。
2. **docx** 先 `docxToMdFile(path, name)` 得 md 路径（失败 → 视同无法识别）。
3. 读文本前 **4000 字**喂 `runClassifierOnce`（Haiku，`logTag:'colleague-auto/apidoc'`）：

   > 下面是后端同事发给前端的一份文件的开头。判断它是否是**后端接口 / API 文档**（描述 HTTP 接口、请求/响应字段、协议契约的文档）。只输出 JSON：`{"isApiDoc": true|false}`

4. `isApiDoc === true` → `registerApiDoc(req, { name: files[0].name, path: md 路径或原路径 })` → `prompt = buildApiFixPrompt({ action, doc })` → `enqueueSystemTask(reqId, 'colleague-dev', { msgId, colleagueId, prompt, title: '接入接口文档：' + name })`。

`registerApiDoc` 从 `handleApidocPost` 抽出（同名更新 / 否则新增 + history 留痕），路由自己也改调它 —— 两处各写一份迟早漂移。

### 4.2 文字判定（一次调用同时产出判定与提示词）

`runClassifierOnce`（Haiku，`logTag:'colleague-auto/text'`），prompt 带需求标题与该同事的角色：

> 这是需求「{title}」的后端开发同事对前端说的一句话：「{text}」
> 判断它是否包含**需要前端修改代码才能配合**的具体信息（接口变更、字段调整、联调问题、返回结构改动等）。纯沟通、确认、提问、闲聊都算不需要。
> 只输出 JSON：`{"needsAction": true|false, "summary": "一句话概括（≤30字）", "prompt": "若需要处理，给前端开发 AI 的任务描述：说清后端改了什么、前端要对应改什么、注意什么；不需要则空串"}`

- `needsAction && prompt` → `enqueueSystemTask('colleague-dev', { msgId, colleagueId, prompt, title: '后端沟通：' + summary })`
- 否则无动作。

### 4.3 分类的失败语义

超时 / 额度耗尽 / 解析不出 / 缺字段 → **一律视同「不处理」**，warn 留痕，不重试、不回复第二句。warn 必须打在本层：默认 `classify` 用 `runClassifierDetailed` 拿 `reason`（exhausted / aborted / timeout / unparsable）—— `llm-classify` 对「超时后流优雅收尾」与「unparsable」两条路径是静默的，只看它的日志会把「Haiku 违约带换行导致 JSON.parse 抛错」误读成「模型判定不需要」。同事手里已有三期那条 ACK，主机 web 端也能看到原消息 —— 退化到三期行为，不会更糟。

## 五、系统任务 `colleague-dev`（`requirement-ops.js`）

`dispatch` 加一支，phase 守卫只放 `dev`（`/api/req/apidoc` 本身只在开发期开放；`resolveTargets` 也只认 dev）：

```
dispatchColleagueDev(req, payload)
  1. convId = 'c' + Date.now() + 3 位随机   ← 前端 createReqConv 是纯 14 位数字，天然不撞
  2. sessions[].push({ convId, sessionId: null, title: payload.title, kind: 'sub', phase: req.phase, createdAt })
     （phase 字段对齐同日 spec 2026-09-21-req-phase-session-isolation）
  3. run = createRun()
     busy = { kind: 'colleague-dev', runId: run.id, startedAt, convId }   ← busy 新增 convId，原因见 §7.2
  4. run.onSettle = buildColleagueDevOnSettle(req, payload, convId)
  5. startClaudeRun(run, { prompt, cwd, addDirs, mode: 'bypassPermissions', convId, session: undefined })
```

`onSettle(ok, run)`：
1. 清 busy —— 复用 `buildSystemTaskOnSettle` 的归属校验逻辑（`fresh.busy.runId === run.id` 才清），避免击穿串行闸
2. `sessions[]` 中该 convId 的条目回填 `sessionId = run.session_id`
3. `markHandled(reqId, colleagueId, msgId, { handledBy: 'ai', handledNote: (ok ? '已处理 · ' : '处理失败 · ') + title })`
4. 回同事简报（§6）

`run.result || run.text` 在 onSettle 时已可读（`settleRun` 先调 onSettle 再 `finishRun`）。

## 六、回复与留痕

三个时点都走 `sendTextToUser({appId, appSecret}, colleague.feishuOpenId, text)` + `appendMessage(reqId, colleagueId, { dir: 'out', text, role, status: 'read' })` —— **主机在 web 端同事面板能看到 AI 替他说了什么**，与 `handleColleagueSend` 完全同一条路。

| 时点 | 进程 | 文案 |
|---|---|---|
| 收到 | 飞书（三期现状，不动） | 已收到，信息会同步发送给主机！ |
| 触发自动处理 | web，enqueue 成功后 | 接口文档「{name}」已收到，开始接入开发 ／ 已收到，正在接入处理：{summary} |
| 完成 | web，onSettle | ok →「已处理完成：{run.result 截 200 字}」；失败 →「接入遇到问题，已转主机处理」 |

消息条目：触发时**不改 `status`**（主机仍看到未读红点，知道后端说过话），`handledBy:'ai'` + `handledNote` 在 onSettle 写。需求 `history` 逐步留痕（`系统任务 colleague-dev 启动 / 完成 / 失败`，同 bug-fix 口径）。

`sendTextToUser` 自身对凭证缺失 / open_id 空返回 `false` 不抛，回复失败不阻塞其余步骤。

## 七、前端（两处）

### 7.1 hydrate 缺失 conv（`public/js/req-view.js#makeSessionRow` 点击处）

`sessions[]` 有、localStorage 无 → 先补建再打开：

```js
if (!loadConvs().some((c) => c.id === session.convId)) {
  // 必须带 session：否则回放出来之后用户追问一句，会新开一个对刚才内容一无所知的 Claude 会话
  createReqConv({ id: session.convId, reqId, cwd, title: session.title, kind: session.kind, session: session.sessionId || null });
}
await openConv(session.convId);
// 回放只在会话不在跑时做：mountReqChrome 的接流不被 await，紧接着发的 /api/history 若先回，
// 半截转录会灌进去再叠上实时流（跨标签页点开正在跑的子会话就是这个场景）。
// 判「在跑」两条：本页 runningJobs（isConvRunning），或需求 busy 正落在这个子会话上（另一标签页在接流）
const liveHere = isConvRunning(session.convId) || (req.busy?.runId && (req.busy.convId || req.convId) === session.convId);
if (session.sessionId && session.kind !== 'main' && !liveHere) await loadReqTranscript(session.convId, session.sessionId, cwd);
```

`/api/req/get` 回非 2xx（需求在轮询与点击之间被删）时不 hydrate —— 否则会留下一个指向已删需求的孤儿 conv。

`cwd` 取 `req.projects?.frontend?.dir || req.projects?.backend?.dir || ''`（与 `addNewSession` 同一取法）。`chat.js#createReqConv` 加可选 `id` 参数（不传则沿用 `'c' + Date.now()`）。打开后复用现有机制：跑着 → `mountReqChrome` 的 `ensureConvRunAttached`；跑完 → `loadReqTranscript(convId, session.sessionId, cwd)`（`openRetroConv` 已是同款用法）。

### 7.2 防错接（`public/js/req-chat.js#mountReqChrome` 与 3s 轮询两处）

现状无条件 `ensureConvRunAttached(data.convId, data.busy.runId)` 把 busy 的 run 接到**主会话**。`colleague-dev` 跑在子会话，接错了会把子会话的输出画进主会话。改为把 busy 的真实 convId 传进去：

```js
if (data.busy?.runId) ensureConvRunAttached(data.busy.convId || data.convId, data.busy.runId);
```

`ensureConvRunAttached` 内部已有 `convId !== currentConvId → return` 的护栏（chat.js:2770），所以：用户在主会话时子会话的 run 被自然忽略（不错接）；用户点开子会话时 `currentConvId` 就是它，正常接流。bug-fix 的 busy 无 `convId`，回落 `data.convId`，行为不变。

同文件 `BUSY_KIND_LABELS` 加 `'colleague-dev': '后端沟通接入'`：用户在主会话时，busy 芯片是感知「子会话正在跑」的唯一信号，缺了这一项芯片会露出原始英文 key。

## 八、数据契约变更

| 文件 | 变更 |
|---|---|
| `store/colleague-messages.js` | 新增 `markHandled(reqId, colleagueId, msgId, { handledBy, handledNote })`（锁内单条 patch）；`flushPending` 返回值从 `count` 改为 `{ count, ids }`（`onPickCardAction` 日志仍取 count） |
| `store/requirements.js` | `busy` 注释补 `convId?`（可选，系统任务落在非主会话时才有）。**双重契约**：既是前端接流的依据（§7.2），也是 `isBusyStale` 查待续跑登记的依据 —— 额度续跑的 pending 挂在 run 自己的 conv 上，拿主会话 convId 去查会把正在续跑的子会话任务误判成泄漏、清 busy 击穿串行闸 |
| `requirement-ops.js#isBusyStale` | `hasPendingResume(busy.convId \|\| convId)`：优先按 busy 自带的 convId 查 |
| `requirement-ops.js#taskDiscriminator` | 判别键链加 `payload.msgId`。`enqueueSystemTask` 对同需求同 kind 的排队任务按判别键去重（last-writer-wins），colleague-dev 的 payload 没有 bug.id / doc.id / changeId → 键恒为空 → 后端连发两条「需要处理」的消息，第一条任务会被第二条静默顶掉、同事却已收到「正在接入 A」 |
| `routes-requirements.js` | 新增 `POST /api/req/colleague-messages/auto {reqId, colleagueId, msgIds}`；`handleApidocPost` 改调 `registerApiDoc` |
| `requirement-ops.js` | 导出 `registerApiDoc`；`dispatch` 加 `colleague-dev` 支；新增 `dispatchColleagueDev` / `buildColleagueDevOnSettle` |

## 九、边界（刻意不做）

- 只对 `role === 'backend'`。产品的需求变动（`/api/req/change`）、测试的 BUG（bitable 巡检）是另两条路，本次不碰。
- 只在 `phase === 'dev'`。
- pdf / 图片 / 其它扩展名不识别，走三期归档。
- web 未运行时不做补偿扫描；消息已落盘，主机 web 端可见。
- 不加新设置开关。
- 一条消息只处理其自身：不合并同事连发的多条文字（每条独立判定；多条都「需要」则各起一个任务顺序排队 —— 可接受，且 LLM 判定会自然把「补充说明」类短句判成不需要）。

## 十、错误处理

| 故障 | 处置 |
|---|---|
| 跨进程 POST 失败（web 未起 / 超时） | 飞书侧 warn；消息已落盘，同事已收 ACK |
| `/auto` 校验不过（插件停用 / 需求不存在 / 非 dev / 同事不存在 / 非 backend / msgIds 空或不属于线程或已 handled） | 409 / 404 / 409 / 400 / 400 / 400。飞书侧 400/409 记 info（按规则不该处理，非后端同事每条都会命中，全 warn 是噪音）、其它 warn |
| 插件 `colleague-relay` 停用 | **只能在 web 路由认**：附件链路 `relayColleagueAttachment` 是三期刻意绕过插件开关的，飞书侧不判；路由第一道校验 `getPluginEnabled('colleague-relay')` 不过 → 409 |
| web 重启中断 colleague-dev run | `recoverPendingAndOrphans` 先把孤儿 run 登记为待续跑（convId = 子会话），`recoverBusyOnBoot` 对**有待续跑登记的 busy 不清**（否则 `canDispatch` 只查主会话，子会话上续跑的 run 会与新任务并发改同一目录），交给 `healStaleBusy` 在续跑链结束后清 |
| 入队后 web 重启 | 内存队列丢失，同事收到过「正在接入」却无下一句 —— **既有属性**（所有系统任务同），记为已知限制 |
| 起跑前作废（排队期间离开 dev / 无工程目录） | `abandonColleagueDev`：history 留痕 + `markHandled(handledBy:'ai', handledNote:'作废（原因） · title')` + 回同事「已转主机处理」 |
| 分类超时 / 额度耗尽 / 解析失败 | 视同不处理，warn |
| docx 解析失败 | 视同无法识别，warn |
| `registerApiDoc` 失败（文件不存在） | warn，不入队，不回第二句 |
| run 失败（onSettle ok=false） | 清 busy、回「已转主机处理」、`handledNote` 记失败 |
| 同事 open_id 缺失 | `sendTextToUser` 返 false 跳过，其余照常 |
| 需求在排队期间离开 dev | `dispatch` 的 phase 守卫作废任务并留痕（同 bug-fix） |
| 起跑同步抛错（settings.json 损坏等） | catch：`failRun`、清 busy、**撤掉刚 push 的子会话条目**（否则前端 hydrate 出空壳）、回「已转主机」 |
| run 经历额度续跑 / 异常重试 | **已知限制（既有，bug-fix 同）**：`doResume` 起的新 run 不继承 `onSettle`（回调是函数，落盘的 pending 登记带不走），最终收尾时不会 `markHandled`、不回简报；busy 由 `healStaleBusy` 在续跑链结束后清掉。表现为消息保持未处理、主机在面板看到红点 —— 作为兜底语义可接受 |

## 十一、测试

- `colleague-auto.logic.test.js`：扩展名白名单（大小写 / 无扩展名 / 多个点）；两个 prompt 含必要字段；输出解析对缺字段 / 脏 JSON / `needsAction:true` 但 `prompt` 空 → 一律归「不处理」；简报截取 200 字与空结果兜底
- `colleague-messages.test.js`：`markHandled` 只改目标条目、未知 id 不写盘；`flushPending` 返回 ids 与 count 一致
- `requirement-ops.test.js`：`dispatch('colleague-dev')` 在 test/review 期作废留痕；`canDispatch` 对 `busy.kind==='colleague-dev'` 排队
- `routes-requirements.test.js`：`/auto` 四道校验各一例；通过后 202
- `colleague-relay/logic.test.js` 不变；`auto-notify` 的 POST 封装以「web 不可达时不抛」为唯一断言
- 前端 `createReqConv({id})` 幂等（同 id 二次调用不重复插入）

## 十二、改动落点汇总

| 文件 | 性质 |
|---|---|
| `src/plugins/colleague-relay/auto-notify.js` | 新增：跨进程 POST 封装 |
| `src/plugins/colleague-relay/feature.js` | 单需求直归后调 `notifyAutoHandle` |
| `src/plugins/colleague-relay/index.js` | `onPickCardAction` flush 后调 `notifyAutoHandle` |
| `src/entrypoints/feishu/index.js` | `relayColleagueAttachment` 单需求直归后调 `notifyAutoHandle` |
| `src/store/colleague-messages.js` | `markHandled`；`flushPending` 返回 ids |
| `src/entrypoints/web/colleague-auto.js` | 新增：分类编排 + 回复 |
| `src/entrypoints/web/colleague-auto.logic.js` | 新增：纯逻辑 |
| `src/entrypoints/web/requirement-ops.js` | `registerApiDoc` / `colleague-dev` 支 / `dispatchColleagueDev` |
| `src/entrypoints/web/routes-requirements.js` | `/auto` 端点；`handleApidocPost` 改调 `registerApiDoc` |
| `public/js/chat.js` | `createReqConv` 可选 `id` |
| `public/js/req-view.js` | 会话树点击前 hydrate |
| `public/js/req-chat.js` | `busy.convId` 防错接（两处） |

## 十三、并行会话提醒

本仓同日有另一会话在改 `requirements.js` / `routes-requirements.js` / `req-view.js`（spec `2026-09-21-req-phase-session-isolation`）。实施时**每次 Edit 前重新 Read**，绝不 `git checkout` 还原文件。

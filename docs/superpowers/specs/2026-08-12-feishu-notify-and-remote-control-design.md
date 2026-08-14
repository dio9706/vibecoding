# 设计：飞书通知 + 飞书回控（web 会话 / 需求故障任务）

- 日期：2026-08-12
- 状态：设计已由用户确认（2026-08-12）
- 规则：本项目所有工作**不做 git 提交**，提交时机由用户掌控

## 背景与目标

两个独立但同构的诉求：

1. **web 执行台会话**：输入框上方加一个按钮，点击激活/取消激活。激活后该会话的任务**结束或失败**要在飞书通知；飞书侧可 `[补充内容]` `[结束会话]`——发补充内容则自动送回该会话继续跑，发结束会话则不做动作。
2. **记录的需求/故障任务**：同样加飞书通知开关。激活后任务**处理完成**要在飞书通知；飞书侧可 `[合并到主分支]` `[补充]` `[放弃改动]`。

两者共用同一套"通知卡片 → 按钮 → 回控"骨架，但域不同（会话 vs 任务），因此**动作执行各自落在自己的域里**，只共享一个极小的"等待补充"挂起态模块。

## 现状事实（已核验，决定了设计形态）

| 事实 | 出处 | 对设计的约束 |
|---|---|---|
| 飞书入站消息与卡片回调**只在 `claude-feishu` 进程**落地；web 进程能发不能收 | `channels/feishu.js:192-209`、`entrypoints/feishu/index.js:38-66`、`feedback/index.js:166-168` 注释 | 回控必须跨进程送达 web |
| 一体化 sidecar（根 `server.js`）把 web + 飞书跑在**同一进程**；PM2 则是两进程 | 根 `server.js`、`ecosystem.config.cjs` | 通道必须两种形态都成立 → 走 `http://127.0.0.1:${config.web.port}`（两模式下该值都正确；`claude-feishu` 无 PORT env → 默认 3000 = `claude-web` 端口） |
| origin 守卫对**无 Origin 头**放行 | `entrypoints/web/origin.js:52-57` | 飞书进程直接打本机接口不需要额外放行 |
| 普通聊天会话的 `session` 权威副本**只在前端 localStorage**（`conv.session`），服务端无 convId→session 长期映射 | `conv-store.js:56-62`、`store/conv-messages.js` 头注释 | **激活开关时前端必须上报 `{convId,title,session,cwd,model,effort,mode}` 落盘**，否则飞书补充无法续接原会话 |
| run 的终结**只有四个函数**，均先判 `status!=='running'` 早退、再置 `subtype`、再 `fanout('done')`；Claude 与 openai-compat 两个 provider 都收敛到这四个 | `runs.js:391`(finish)/`403`(fail)/`437`(block)/`450`(stop)、`run-openai.js:99-101` | 通知落点选在这里（而非 `settleRun`）才能全 provider 覆盖且天然不重复 |
| `settleRun` 只在 Claude 路径；额度撞墙分支 `return` 前走 `blockRun` | `run-claude.js:230-286` | 额度场景经 `subtype:'quota_blocked'` 过滤掉，不需要在 settleRun 特判 |
| `run.onSettle` 是**单播 + 用后即焚**，已被 requirement-ops 占用 | `run-claude.js:275-283`、`requirement-ops.js:284` | 不得抢占该字段，另开监听器接缝 |
| `stopRun`/`abortRun` 置终态后 `is_error` 对 stopped 仍为 `false` | `runs.js:450-466` | 必须按 `run.subtype` 分流，否则"手动停止"被报成"成功完成" |
| `run.convId` 在两个 provider 的起跑处都会写入 | `run-claude.js:57`、`run-openai.js:24` | 监听器仅凭 run 对象即可定位会话，无需 params |
| 卡片 kind 注册表已存在，按钮 value 自带上下文 → 重启后旧卡片仍有效 | `shared/card-actions.js`、`feedback/index.js:121-168` | 直接复用该范式 |
| `sendTextToUser(botCreds, openId, text)` 是唯一"指定机器人 + 私聊 open_id"的推送原语，**只支持纯文本** | `lark.js:451-479` | 需补 `sendCardToUser` |
| dispatch 竞争按 order 升序；`claude-exec` 在 order 20 且对 owner **全接** | `plugins/index.js`、`features/index.js:9`、`app/dispatch.js:57-100` | 新 feature 必须 `order < 20`，否则用户（owner）的补充内容被 claude-exec 吞掉 |
| 任务"处理完成"= `status:'done'`，全仓只有两个 done 写入点 | `task-ops.js:128-132`（轻度托管）、`auto-dev/index.js:157`（自动管线） | 通知挂这两处即全覆盖、不重复 |
| auto-dev 泵**只在 web 进程**常驻，飞书进程只标记状态 | `server.js:199`、`auto-dev` 注释 | 飞书侧"补充"只需把任务置队列，无需跨进程调用 |
| merge/discard 的编排（校验 + repo 解析 + git + updateTask + 错误分级）目前**内联在 web 路由里** | `routes-ops.js:86-134` | 飞书要复用必须先抽共享模块，否则两条入口分叉 |

## 决策记录（用户已确认）

| 决策点 | 结论 |
|---|---|
| 会话通知开关粒度 | **会话级**，跟随当前会话；发件=设置页启用中的机器人，收件=`settings.myFeishuOpenId` 私聊；任一未配置则点亮时 toast 指路，不静默失败 |
| 会话通知触发范围 | 仅 `done`（正常完成）与 `error/exception`（异常失败）。`subtype:'stopped'`（手动停止）、`'quota_blocked'`（额度等待续跑）**不通知**；续跑真终结时才通知 |
| 飞书交互形式 | **按钮卡片为主 + 文本兜底**（会话域）。任务域**只走卡片按钮**（见下"文本兜底边界"） |
| 回控送达方式 | **即时直送**：飞书进程 HTTP 打 web 台接口。web 台未运行 → 机器人立刻回「执行台未运行，稍后再发」，不静默丢 |
| 任务通知开关粒度 | 任务面板**全局开关**（逐条勾选太碎），落 `settings.uiPrefs.taskNotifyFeishu` |
| 任务「补充」语义 | 写 `fixNote` + `requestAutoDevelop` 置队列，由 web 进程 auto-dev 泵在任务分支上再跑一轮（web 台没开也不丢，起来自动跑） |
| 「结束会话」语义 | 卡片转终态 + 清除等待态。**不中断运行、不取消激活开关** |
| 现有通知去留 | `auto-dev` 发给**提交人**的纯文本通知保留不动；本次新增的是发给**管理员本人**的卡片通知，两者并存 |

## 架构

### 模块划分与依赖方向

```
内核（两进程都加载，无业务）
  src/shared/pending-supplement.js   等待补充挂起态（Map + TTL + 闭包执行器）★新
  src/shared/card-actions.js         卡片 kind 注册表（已存在）
  src/store/conv-notify.js           会话通知登记表 + 注入收件箱 ★新
  src/store/runs.js                  + registerRunSettleListener() 接缝 ★改
  src/integrations/lark.js           + sendCardToUser() ★改

web 进程（会话域）
  src/entrypoints/web/conv-notify.js        通知发送 + 注入编排（注册终结监听器）★新
  src/entrypoints/web/routes-conv-notify.js /api/conv-notify/* ★新
  public/js/conv-notify.js                  开关按钮 + 收件箱轮询 ★新
  public/index.html / app.css / js/chat.js  接缝 ★改

飞书进程（会话回控）
  src/plugins/feishu-relay/index.js   order 16 feature + conv-settled 卡片处理器 ★新
  src/plugins/feishu-relay/logic.js   纯函数（卡片构造/解析/文本指令/权限）★新

两进程（任务域，team-tools 插件内）
  src/plugins/team-tools/task-actions.js   merge/discard 共享编排（从 routes-ops 抽出）★新
  src/plugins/team-tools/task-notify.js    完成通知 + task-done 卡片处理器 ★新
  src/plugins/team-tools/task-notify.logic.js 纯函数 ★新
  auto-dev/index.js · task-ops.js · routes-ops.js · public/js/tasks-panel.js 接线 ★改
```

**依赖铁律**：插件之间不互相 import。会话域与任务域唯一的共享物是内核的 `pending-supplement.js`；它存的是**闭包执行器**（`onText`），由 arm 的一方提供，因此消费方（feishu-relay 的 feature）对 tasks / convs 一无所知。`team-tools` 停用时 `task-done` 处理器不注册（回调落空仅记 warn），会话域不受影响。

### 为什么挂起态可以是内存态

卡片本身**无状态**（value 自带 convId / taskId → 机器人重启后按钮仍有效）。只有"点了补充内容，等你下一条消息"这一瞬态在内存里（TTL 10 分钟，单 openId 单槽，后 arm 覆盖前）。重启丢失的后果被两条路兜住：会话域有文本兜底；任务域重新点一次按钮即可（卡片永久有效）。

## 功能 1：会话级飞书通知 + 回控

### 1.1 UI 与开关

`public/index.html` 在 `#fabRow` 内、`#modelFab` **之前**插入：

```html
<div class="notify-fab" id="notifyFab">
  <button class="model-fab-btn" id="notifyFabBtn" title="任务结束/失败后飞书通知">
    <span id="notifyFabLabel">🔔 飞书</span>
  </button>
</div>
```

- 复用 `.model-fab-btn` 药丸样式；激活态加 `.on` 类（`app.css` 新增 ~6 行：激活时描边/背景高亮）。`#fabRow` 已 `position:absolute; bottom:96px`（"让出 composer 区"），天然就在输入框上方右侧。
- `.app.in-panel .fab-row`、`.app.req-rail-open .fab-row` 等既有收窄规则自动适用，无需改。
- 会话激活标记存 `conv.meta.notifyFeishu`（复用 conv-store 现成的守护 API `convSetMeta`，不新增顶层字段、不动 `updatedAt`），`applySessionPrefs()` 时还原按钮态。

### 1.2 激活/取消（前端 → 服务端登记）

- 激活：`POST /api/conv-notify/on {convId, title, session, cwd, model, effort, mode}`
  - 服务端前置校验：`getMyFeishuOpenId()` 与 `getActiveBot()` 凭证齐全。缺则回 `{ok:false, error:'...'}`，前端 toast 指路设置页并**不点亮按钮**。
  - `session` 允许为空（新会话还没跑过）；后续经 sync 补齐。
- 取消：`POST /api/conv-notify/off {convId}` → 删除条目（连带丢弃未认领的注入项）。
- 同步：`POST /api/conv-notify/sync {convId, session, title, cwd, model, effort, mode}`——**仅当该 conv 已激活才写盘**。前端调用时机：SSE `session` 事件回填后、模型/模式/目录变更后。

### 1.3 登记表结构（`conv-notify.json`，经 `updateJson` 文件锁，gitignore）

```js
{
  "c_1723...": {
    convId, title, session, cwd, model, effort, mode,
    enabledAt,                 // ISO
    lastNotifiedAt,            // ISO|null，文本兜底选目标会话用
    inbox: [                   // 待前端认领的注入项，上限 20（超限丢最旧）
      { id, text, runId, mode: 'steer'|'run', at }   // at = epoch ms
    ]
  }
}
```

`src/store/conv-notify.js` 导出：`getEntry(convId)` / `getAll()` / `enable(entry)` / `disable(convId)` / `patch(convId, patch)` / `pushInjection(convId, item)` / `claimInjections(convId, ids)` / `pickLatestNotified(maxAgeMs)`。

### 1.4 通知发送（web 进程）

**落点 = `runs.js` 的终结监听器接缝**（不是 `settleRun`）。理由：四个终结函数是全 provider（Claude + openai-compat）、全路径（正常/异常/看门狗/手动停止/额度阻塞）的唯一收口；每个 run 只会终结一次（`status!=='running'` 早退），天然无重复通知；`subtype` 此时已置好。

`src/store/runs.js` 新增极小接缝（store 层不 import lark/settings，避免层级倒置）：

```js
const settleListeners = [];
export function registerRunSettleListener(fn) { settleListeners.push(fn); }
function emitSettled(run) {                       // 在四个终结函数的 fanout('done') 之后调用
  for (const fn of settleListeners) {
    try { fn(run); } catch (e) { logger.warn('runs', '终结监听器异常', { err: e?.message || String(e) }); }
  }
}
```

`src/entrypoints/web/conv-notify.js` 导出 `startConvNotify()` 完成注册，由 `server.js` 在 `server.listen` 回调里显式调用（与 `startAutoDevPump()` / `startRequirementPump()` 同范式）——比依赖 import 副作用更显式、更好测。

`onRunSettled(run)`：

1. `run.convId` 为空 → 返回；`getEntry(run.convId)` 无条目 → 静默返回。
2. `['stopped','quota_blocked'].includes(run.subtype)` → 静默返回。
3. `getMyFeishuOpenId()` / `getActiveBot()` 缺失 → `logger.info` 后返回。
4. 组卡片：纯函数 `buildConvSettledCard(entry, run)` 放 `src/entrypoints/web/conv-notify.logic.js`。**卡片构造只在 web 侧，飞书侧只解析 value**——两侧靠 value 契约耦合，不共享构造代码（web 进程不 import 插件模块）。
5. `sendCardToUser(botCreds, myOpenId, card)`；抛错则降级 `sendTextToUser` 发纯文本（含文本指令说明）。
6. `patch(convId, { lastNotifiedAt })`。

整体 try/catch + `.catch(logger.warn)` 三层兜住（照抄 `sendDocgenNotify` 的纪律），任何失败都不影响 run 结算。

卡片内容：会话标题 · ✅完成/❌失败（`run.is_error` 或 `subtype==='exception'` 为失败）· 耗时（`run.startedAt`）· 结果摘要（`run.text` 截断 300 字）· 若该会话权限模式为「询问」再加一行提示（见 1.6）· 两个按钮
`[📝 补充内容]` `[🛑 结束会话]`，value = `{ kind:'conv-settled', convId, action:'supplement'|'end' }`。

### 1.5 飞书侧回控（`src/plugins/feishu-relay/`）

**卡片处理器** `registerCardKindHandler('conv-settled', onConvCardAction)`：

- 权限：`operator.open_id === getMyFeishuOpenId()` 或 ∈ ownerOpenIds ∪ 可信名单，否则忽略 + 记日志（不回文本）。
- `supplement` → `armSupplement(openId, { label:'会话《'+title+'》', onText: (text) => injectToConv(convId, text) })` + `updateCard('⌛ 等待补充内容…')` + `sendTextToUser(creds, openId, '请直接发送要补充的内容')`。
- `end` → `clearSupplement(openId)` + `updateCard('🛑 已结束本次通知交互（未做任何动作）')`。**不中断运行、不取消开关**。
- `updateCard` 用全局单例凭证（= 启用中的机器人）。若用户在通知与点击之间切换了启用机器人，更新会失败 → warn，**动作照常执行**（照抄 feedback 的 `done()` 容错）。

**dispatch feature**（`order: 16`，`permission:'any'`，`intents: []`）：

- `hasPending(ctx)`：`peekSupplement(ctx.user.id)` 存在 → 整条消息作为补充内容交给闭包执行器。
- `match(ctx)`：文本兜底
  - `补充内容` 前缀（沿用 `intent-keywords.js` 纪律：**只匹配消息开头**、正则不加 `g`；「补充内容」是完整说法而非裸词，故分隔符用 `SEP`（空白/标点/零长皆可），但要求**剥掉前缀后正文非空**才命中——避免「补充内容我等下发」被当成正文）→ 目标 = `pickLatestNotified(24h)` 命中的会话；机器人回执**写明送到了哪个会话标题**，让选错能被发现；无命中 → 回「近 24 小时没有收到通知的会话，请在网页端激活」。
  - `结束会话` 全等（trim 后）→ 清等待态 + 回执，不做动作。
- 命中后统一走 `injectToConv`。

**为什么 order 16**：必须抢在 `claude-exec(20)` 之前——用户是 owner，claude-exec 对 owner 全接。16 落在 `status-report(14)` 与 `claude-exec(20)` 之间，不影响既有 10/12/14 的可信人指令。

### 1.6 注入到会话（web 进程）

飞书进程 → `POST http://127.0.0.1:${config.web.port}/api/conv-notify/inject {convId, text}`：

- 无条目/未激活 → 404 `{error:'该会话未激活飞书通知'}`。
- 该 conv 有活跃 run（`hasActiveRunForConv`）→ 复用现成插话持有 `holdMsg(run, text)`，`mode:'steer'`。
- 否则 `createRun()` + `startClaudeRun({ prompt:text, session:entry.session, cwd:entry.cwd, model, effort, mode, convId })`，`mode:'run'`。无 `session` 时不 resume（等价开新会话上下文），仍照常执行。
- `pushInjection(convId, {id, text, runId, mode, at})` → 回 `{ok:true, runId, mode}`。
- 飞书侧对连接失败（ECONNREFUSED/超时 3s）回「执行台未运行，稍后再发」；对 4xx 回具体错因。

**权限模式（不静默提权）**：注入 run **沿用会话记录里的 `mode`**，绝不因为"远程操作"就偷偷改成 `bypassPermissions`。代价是：`mode==='default'`（询问）的会话，注入 run 遇到 Write/Edit/Bash 会挂在审批上等人（`WAIT_MAX` 到点按默认值兜底）。因此：
- 通知卡片与注入回执在该情况下**显式提示**「该会话为询问模式，需审批的工具会等待网页端确认」；
- 想要全自动就在网页端把该会话的权限模式调成「接受编辑」或「自动」（FAB 现成能力，已会写穿会话记录）。

**前端认领**：`public/js/conv-notify.js` 在当前会话已激活时每 5 秒轮询 `GET /api/conv-notify/inbox?convId=`；另外 `openConv` 切到一个已激活会话时**立即单次拉取**（后台会话在别处收到的注入不会漏）：

- 对每个未认领项：`convPushMessage(convId,'user',item.text)` 上屏（保住"存储=DOM=_bubbleMap 三方同序"不变量，走 conv-store 守护 API），再 `ensureConvRunAttached(convId, item.runId)` 接流（该函数已幂等：同 runId 已接、或会话里已有该 runId 的 pending 气泡都会跳过）。
- `POST /api/conv-notify/claim {convId, ids}` 认领，避免重复上屏。
- **离线补跑的已知边界**：若注入的 run 已跑完且超出 `runs.js` 的 `KEEP_MS=30min` 保留窗（run 已被 GC），`attachStream` 会报 run 不存在。此时只上屏用户气泡 + 一条助手气泡「（该补充已在离线期间执行完成，完整结果见飞书通知）」，**不自动重灌转录**。要看完整过程仍可用既有历史检索。

## 功能 2：需求/故障任务完成通知 + 三操作

### 2.1 开关

`public/js/tasks-panel.js` 的 `renderFilterBar` 旁加一个 chip「🔔 飞书通知」（复用 `.btn.task-filter-chip[.active]`），点击 `POST /api/settings {section:'ui-prefs', taskNotifyFeishu:bool}`；默认值加在 `store/settings.js` 的 `uiPrefs`。两进程都经 `getUiPrefs()` 读，即时生效（不需重启）。

### 2.2 通知发送

`src/plugins/team-tools/task-notify.js` 的 `notifyTaskDone(task, ok)`，挂在**唯二**的 done 写入点之后：

- `task-ops.js:128-132`（轻度托管；仅 `!opts.deferStatus` 分支，`ok` 取 develop 的返回）
- `auto-dev/index.js:157`（自动管线；该处只在 `r.ok && c.committed` 时执行，`ok=true`）

两处互不重叠（auto-dev 调 develop 时传 `deferStatus:true`，那条路径不写 done）→ 不会双发。

守卫顺序（廉价判定在前）：`getUiPrefs().taskNotifyFeishu` → `getMyFeishuOpenId()` → `getActiveBot()` 凭证。全部 fire-and-forget + try/catch。

卡片：`[需求]/[故障]` · 标题 · ✅完成/❌失败 · 分支 `branch → baseBranch`（有则显示）· `devLog` 摘要 200 字 · 按钮：

- 待合并态（`auto && done && !merged && branch && baseBranch`）→ `[✅ 合并到主分支] [📝 补充] [🗑 放弃改动]`
- 其他（轻度托管无分支 / 开发失败）→ 仅 `[📝 补充]`

value = `{ kind:'task-done', taskId, action:'merge'|'supplement'|'discard' }`。

### 2.3 共享编排：`task-actions.js`

把 `routes-ops.js:86-134` 的 merge/discard 编排整体搬入 `src/plugins/team-tools/task-actions.js`：

```js
mergeTaskById(id)   → { ok, code: 200|400|404|409, error?, task? }
discardTaskById(id) → { ok, code: 200|400|404|409, error?, task? }
```

语义**逐字保留**：前置校验条件、`task.repo || getActiveBot()?.projectDir || config.feedback.frontendDir` 的 repo 兜底、`r.error` 不再套前缀、`hookBypassed` 追加 history 文案、失败写 `mergeError` 回 409、删分支失败**不改状态**。`routes-ops.js` 的两个分支改为薄壳：调用 + `sendJson(res, r.code, ...)`。飞书卡片处理器直接调同一对函数（git 操作在飞书进程本地执行，不需要跨进程）。

### 2.4 卡片处理器（team-tools 内）

`registerCardKindHandler('task-done', onTaskDoneCardAction)`：

- 权限同 1.5（本人/owner/可信名单）；非授权忽略 + 日志。
- `merge` → `mergeTaskById` → `updateCard`：成功「✅ 已合并 X → Y」（含钩子绕过提示）；409「⚠️ 合并冲突：…（请到网页端处理）」；400「ℹ️ 任务已不在待合并态」。
- `discard` → `discardTaskById` → 同构文案。
- `supplement` → `armSupplement(openId, { label:'任务《title》', onText: (text) => { updateTask(id,{fixNote:text}); requestAutoDevelop(id, '飞书补充后重新开发'); } })` + `updateCard('⌛ 等待补充内容…')` + 私聊提示。
  - 轻度托管完成的无分支任务经此路径会进入自动管线（产出分支、可合并/放弃）——**有意为之**，与 web 台中度/完全托管下点「开始开发」的行为一致。
- 幂等：动作前重读盘上任务状态；已合并/已放弃 → 只更新卡片提示，不重复执行（并发双击靠状态判定收口，与 feedback 的 `confirmed` 抢占同思路）。
- **任务域无文本兜底**：卡片 value 才携带 taskId，文本无法无歧义定位任务。等待态若因重启丢失，重新点一次按钮即可。

## 数据流

```
[web 会话]
 前端点亮按钮 ──POST /on(convId,session,cwd…)──> conv-notify.json
 run 终结 ──runs.js emitSettled──> onRunSettled(subtype 过滤) ──sendCardToUser──> 飞书私聊卡片
 点[补充内容] ──> armSupplement(闭包=injectToConv) ──> "请直接发送补充内容"
 下一条消息 ──feature.hasPending──> POST /inject ──> holdMsg 或 startClaudeRun(resume session)
 前端 5s 轮询 /inbox ──> 上屏用户气泡 + ensureConvRunAttached ──> /claim
 新 run 结束 ──> 再次通知（闭环）

[需求/故障任务]
 done 写入 ──notifyTaskDone──> 飞书私聊卡片
 点[合并/放弃] ──task-actions──> git + updateTask ──> updateCard 终态
 点[补充] ──armSupplement──> 下一条消息 ──> fixNote + requestAutoDevelop(queued)
                                        ──> web 进程 auto-dev 泵接手（web 没开则起来自动跑）
```

## 错误处理与降级

- **通知发送失败**：三层兜底（内层 `.catch` warn、外层 try/catch warn、调用点 `.catch` warn），绝不影响 run 结算或任务状态。卡片发送抛错 → 降级纯文本（含文本指令说明）。
- **updateCard 失败**（切换过启用机器人 / 网络）：warn，业务动作照常执行。
- **web 台未运行**：飞书回明确文案，不静默丢；用户稍后重发即可（等待态 TTL 10 分钟内有效）。
- **等待态丢失（机器人重启）**：会话域走文本兜底；任务域重新点按钮。
- **注入的 run 已被 GC**：上屏占位说明，不自动重灌转录（见 1.6）。
- **凭证/openId 未配置**：前端激活时前置校验并 toast 指路；服务端侧一律 `logger.info` 跳过，不抛。

## 安全

- `/api/conv-notify/inject` 无鉴权，仅绑回环（`config.web.host`）。风险面与既有 `/internal/notify`、`/api/run/start` 同级（本机任意进程可调），**接受**并记入已知代价。浏览器跨源读取由既有 origin 白名单挡住。
- 卡片操作一律校验 `operator.open_id`（本人 / owner / 可信名单），非授权静默忽略 + 日志（不回文本，避免噪音）。
- 通知正文含会话标题与结果摘要（可能含代码片段），只发**私聊自己**，不进群。

## 测试

**单元测试**（`node --test`，沿用"纯逻辑抽 logic.js + 单测"模式）：

- `shared/pending-supplement.test.js`：arm/peek/take/clear；TTL 过期不命中；同 openId 后 arm 覆盖前；take 后即清空。
- `store/conv-notify.test.js`（临时 `APP_DATA_DIR`）：enable/disable/patch；inbox 上限 20 丢最旧；claim 只删指定 id；`pickLatestNotified` 窗口与排序；disable 连带丢弃未认领项。
- `plugins/feishu-relay/logic.test.js`：value 解析（对象/JSON 字符串/畸形）；权限判定（本人/owner/可信/他人）；`补充内容` 前缀匹配（只匹配开头、无正文不命中、"我补充内容如下"不命中）；`结束会话` 必须全等。
- `entrypoints/web/conv-notify.logic.test.js`：卡片结构与 value 契约；`subtype` 过滤矩阵（done/error/stopped/quota_blocked）；摘要截断。
- `plugins/team-tools/task-notify.logic.test.js`：按钮集合随待合并态变化；`[需求]/[故障]` 文案；value 契约。
- `plugins/team-tools/task-actions.test.js`：校验分支（非 auto / 已合并 / 无分支 / 任务不存在）返回码；git 层用注入替身验证 409 与"不改状态"。

**e2e**（Playwright，沿用自起服务 + `APP_DATA_DIR` mkdtemp 范式，不碰 pm2）：

- 通知按钮：点亮/熄灭、切会话状态还原、未配置凭证时不点亮且有 toast。
- 注入闭环：用**页面级 fetch stub** 拦 `/api/conv-notify/inbox` 返回一条注入项 → 断言前端把用户气泡上屏、调用 `/claim`、重复轮询不重复上屏。**不在 e2e 里跑真实注入**（那会真起 Claude run 烧额度），真实注入放进真机走查。
- 现有四道门禁（steer-bubble / ask-chip / one-window / panels-smoke 中仍有效者）保持通过。

**真机走查（需用户执行）**：真实私聊收卡片 → 点补充内容 → 发一句 → 网页出现气泡并继续跑 → 再次收到通知；点结束会话确认无副作用；任务卡片三个按钮各走一次（含一次故意冲突验证 409 文案）；关掉 `claude-web` 后点补充内容验证「执行台未运行」回执。

## 部署

改后端与插件需 **`pm2 restart claude-web` 与 `pm2 restart claude-feishu` 两个都重启**才完整生效（前端每次请求实时读盘）。桌面版走一体化 sidecar，需重启应用/重新打包。`conv-notify.json` 加入 `.gitignore`。

## 不做的事（YAGNI）

- 不做群聊 @ 回控（通知只发私聊自己）。
- 不做机器人下拉选择（用设置页启用中的机器人；单启用互斥已是既有不变量）。
- 不动 `auto-dev` 发给提交人的现有纯文本通知，不动意图四层短路、评审门、triage 流程。
- 「结束会话」不附带中断运行或取消开关。
- 不做通知历史面板、不做通知节流/合并、不做任务侧逐条开关。
- 不给注入接口加鉴权（回环 + 与既有接口同风险等级）。
- 不为离线期间跑完的 run 自动重灌转录。

## 已知代价

- 会话通知依赖前端上报的 `session/cwd` 快照：用户在别的浏览器/设备上换过 cwd 而未触发 sync 时，飞书补充可能跑在旧目录。缓解=每次 SSE `session` 事件与偏好变更都 sync。
- 等待补充态在机器人重启后丢失（见降级）。
- **看门狗误杀会被报成"失败"**：`SILENCE 15min / HARD 2h` 触发的 `abortRun→failRun` 走的就是失败通知，而底层 CLI 可能仍在跑（既有认知，abort 是优雅关闭、砍不停底层）。属 UI 语义一致，不额外特判。
- **询问模式的注入 run 会等审批**（见 1.6），有提示但确实需要回到网页端点一下。
- 任务「补充」会让轻度托管任务升级进自动管线（产出分支），是有意的语义变化。
- 每次 run 结束都推一条飞书私聊：长会话里连续多轮会有多条通知（用户可随时熄灭按钮）。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `src/shared/pending-supplement.js` | 新增：等待补充挂起态（+ 单测） |
| `src/store/conv-notify.js` | 新增：会话通知登记表 + 注入收件箱（+ 单测） |
| `src/integrations/lark.js` | 新增 `sendCardToUser(botCreds, openId, card)` |
| `src/store/runs.js` | 新增 `registerRunSettleListener`，四个终结函数 `fanout('done')` 后 `emitSettled(run)`（+ 单测补一例） |
| `src/entrypoints/web/conv-notify.js` / `conv-notify.logic.js` | 新增：通知发送 + 注入编排（+ logic 单测） |
| `src/entrypoints/web/routes-conv-notify.js` | 新增：`/api/conv-notify/{on,off,sync,inbox,claim,inject}` |
| `src/entrypoints/web/server.js` | 注册新路由 + import `conv-notify.js` 确保监听器注册 |
| `src/plugins/feishu-relay/index.js` / `logic.js` | 新增插件：order 16 feature + `conv-settled` 处理器（+ 单测） |
| `src/plugins/index.js` | MANIFEST 登记 `feishu-relay` |
| `src/plugins/team-tools/task-actions.js` | 新增：merge/discard 共享编排（+ 单测） |
| `src/plugins/team-tools/task-notify.js` / `task-notify.logic.js` | 新增：任务完成通知 + `task-done` 处理器（+ logic 单测） |
| `src/plugins/team-tools/auto-dev/index.js` | done 写入后调 `notifyTaskDone` |
| `src/plugins/team-tools/task-ops.js` | 轻度托管 done 写入后调 `notifyTaskDone` |
| `src/entrypoints/web/routes-ops.js` | merge/discard 分支改薄壳调 `task-actions` |
| `src/store/settings.js` | `uiPrefs.taskNotifyFeishu` 默认值 |
| `src/entrypoints/web/routes-settings.js` | ui-prefs 透传新字段 |
| `public/index.html` | `#fabRow` 内新增通知按钮 |
| `public/app.css` | `.model-fab-btn.on` 激活态样式 |
| `public/js/conv-notify.js` | 新增：按钮绑定 + 收件箱轮询（`bindConvNotify` 注入范式） |
| `public/js/chat.js` | 接缝：`applySessionPrefs` 还原按钮态、session 事件 sync、切会话启停轮询 |
| `public/js/tasks-panel.js` | 筛选条新增飞书通知 chip |
| `.gitignore` | `conv-notify.json` |
| `tests/e2e-conv-notify.mjs` | 新增 e2e |

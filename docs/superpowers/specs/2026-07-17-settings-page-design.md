# 设置页面（飞书凭证 + 备用 Token 轮换）设计

- 日期：2026-07-17
- 范围：Spec A（本文档）。Spec B「执行中追加消息」另文设计。
- 目标：在 web 执行台新增设置页，支持 ① 配置飞书 App ID/Secret（改后热重连长连接）② 管理多个备用 `CLAUDE_CODE_OAUTH_TOKEN`，即将耗尽时自动切换到充足备用号、标记各号重置时间、重置后自动切回原账号，并在前端提醒开启新会话。

## 背景与既有机制（复用而非重造）

- 无构建静态前端：`public/index.html`（骨架）+ `public/app.css` + `public/app.js`。
- 后端分层：`shared/config`（唯一 env 入口）· `store/*`（JSON 持久化，`readJson/writeJson`）· `integrations/*`（外部系统封装）· `features/*`（业务逻辑）· `entrypoints/*`（web / feishu 入口）。
- 两个 PM2 进程：`claude-web`（端口 3000）与 `claude-feishu`（飞书长连接）。二者进程隔离。
- 额度机制现状：`integrations/claude.js` 的 `onRateLimit` 已消费 SDK `rate_limit_event`；`store/pending-resume.js` 落盘额度耗尽待续跑，`server.js` 的 `scheduleResume/doResume` 在 `resetsAt` 后自动新建 run、resume 同 session 发「继续」，并在 `server.listen` 回调里跨重启重排。**Token 轮换建立在这套之上。**

## SDK 事实核验（决定可行性）

- Lark `WSClient` 具备 `close({force})` + `start({eventDispatcher})` + `getConnectionStatus()` → **进程内热重载可行**，无需自重启兜底。
- Agent SDK `query({ options.env })` 按次覆盖子进程环境变量；**语义为整体替换而非合并**（须自行 spread `process.env`）→ **每个 run 选用哪个 token 可行**。
- `SDKRateLimitInfo.status ∈ {allowed, allowed_warning, rejected}`，附 `utilization`(0~1) / `resetsAt`(epoch 秒) / `rateLimitType`(five_hour|seven_day|...) → 轮换判定信号齐全；`allowed_warning` 即「即将耗尽」。

## 一、模块边界与改动清单

| 模块 | 改动 | 职责 |
|---|---|---|
| `src/store/settings.js` | 新增 | 唯一设置持久化入口（`settings.json`）：飞书凭证 + token 池读写 |
| `src/shared/config.js` | 改 | 加 `getLarkCredentials()`：settings 优先、env 兜底；保留现有 `config` 不破坏引用 |
| `src/integrations/lark.js` | 改 | `createWsClient(creds)` 收显式凭证；加 `resetApiClient(creds)` 让 `sendText` 等换新号 |
| `src/entrypoints/feishu/index.js` | 改 | WS 启动封装成 `startWs()`；`fs.watch(settings.json)` 防抖 → 凭证变则热重连 |
| `src/features/token-rotation.js` | 新增 | 轮换引擎（纯逻辑 + switch-back 定时器）：`pickActive()` / `noteRateLimit()` / `getStatus()` / `consumeNotice()` |
| `src/integrations/claude.js` | 改 | `runClaude` 透传 `env` 到 `query({options.env})`（当前未透传） |
| `src/entrypoints/web/server.js` | 改 | 设置 API + `/api/tokens/status` 轮询；起跑注入 token env；`settleRun` 撞墙用备用号续跑；`server.listen` 重排 switch-back 定时器 |
| `public/index.html` `app.css` `app.js` | 改 | ⚙ 设置弹层 + token 切换横幅/徽标 |
| `.gitignore` | 改 | 加 `settings.json`、`feishu-status.json`（含明文密钥，仅本机） |

### API 面（消除职责歧义）

| 端点 | 用途 | 返回 |
|---|---|---|
| `GET /api/settings` | 打开设置弹层时一次性加载 | `{ lark:{appId, appSecretMasked}, feishu:{state,at,error}, tokens:[掩码列表] }` |
| `POST /api/settings` | 保存飞书凭证 / token 池增删改与排序 | `{ ok, ... }`（写 `settings.json`，触发 feishu fs.watch 热重载） |
| `GET /api/tokens/status` | 轻量轮询（并入现有 pending 轮询节奏），驱动顶栏横幅/徽标 | 见 §4.5 |

`GET /api/settings` 与 `GET /api/tokens/status` 的 token 均为**掩码**；完整 token 只经 `POST` 写入、绝不回传。

## 二、数据模型

### `settings.json`（`claude-web` 写，两进程读）

```jsonc
{
  "lark": { "appId": "cli_xxx", "appSecret": "xxx" },
  "tokens": [                        // 列表顺序 = 偏好顺序，第 0 个即“原/主账号”
    { "id": "tk_ab12", "label": "主账号",
      "token": "sk-ant-oat01-...",
      "status": "healthy",           // healthy | warning | exhausted
      "resetsAt": null,              // exhausted/warning 的重置 epoch 秒
      "rateLimitType": null,         // five_hour | seven_day | ...
      "utilization": null,           // 0~1，来自 allowed_warning
      "updatedAt": "..." }
  ]
}
```

**关键设计：active token 不落显式字段，由 `pickActive()` 实时计算 = 偏好最高的可用 token。**
「重置后切回原账号」由此自然涌现（主账号恢复 healthy 后立即重新成为 active），无需专门的切回逻辑。

### `feishu-status.json`（`claude-feishu` 写，`claude-web` 只读）

```jsonc
{ "state": "connected", // connected | reconnecting | failed
  "at": "...", "error": null }
```

独立文件避免与 `settings.json` 的跨进程写竞争（web 只写 settings，feishu 只写 status）。

## 三、功能① 飞书凭证热重载

1. 设置页填 App ID/Secret → `POST /api/settings` → `store/settings.js` 写 `settings.json`（`claude-web`）。
2. `claude-feishu` 进程 `fs.watch(settings.json)`（300ms 防抖）→ 读 `getLarkCredentials()` 与当前生效值比对；变化则：`ws.close({force:true})` → `createWsClient(新凭证)` → `startWs()` → `resetApiClient(新凭证)`。日志 `logger.info('feishu','凭证热重载')`。
3. `claude-web` 不受影响（不使用飞书凭证）。
4. 跨进程健康反馈：feishu 在每次 WS 状态迁移时把 `getConnectionStatus()` 写入 `feishu-status.json`；设置页读它显示 🟢连接正常 / 🔴重连中 / ⚠️凭证错误。
5. 非法凭证：`start()` reject → `feishu-status.json` 置 `failed + message`、日志报错，尽量保留旧连接不断流。

## 四、功能② 备用 Token 轮换

### 4.1 每个 run 选号 + 归因

`startClaudeRun` 起跑前 `const {id, token} = pickActive()`：

```
env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token }   // token 为 null 时不传 env → 完全同现状
```

run 上固化本次 `tokenId`，供 `onRateLimit` 归因（限流记到「发起该 run 的号」，不受期间 active 变化影响）。

### 4.2 状态迁移 `noteRateLimit(tokenId, info)`

由 `onRateLimit` 回调驱动：

| 收到 | 对该 tokenId | 对 active |
|---|---|---|
| `allowed` | 恢复 healthy、清 resetsAt | 若偏好更高 → active 自然切回它 |
| `allowed_warning` | 标 warning + 记 utilization/resetsAt/type | 重算（跳过 warning）→ 下个 run 用备用号 |
| `rejected` | 标 exhausted + resetsAt，起 switch-back 定时器 | 重算 |

active 变化时记一条 `notice = { kind:'switch', from, to, at }`。

`pickActive()` 选择序：healthy 中偏好最高 → 无则 warning 中偏好最高 → 全 exhausted 返回 null。

### 4.3 撞墙自动续跑（改 `settleRun`）

```
rejected 时：
  noteRateLimit(用的 tokenId, lastRate)      // 撞墙号标 exhausted
  const backup = pickActive()                // 重算可用号
  if (backup && backup.id !== 用的 tokenId)  // 有健康/warning 备用
      → 立即 doResume：新建 run、resume 同 session、注入 backup token、发「继续」（不等重置）
  else                                       // 全 exhausted
      → 沿用现状：addPending + scheduleResume 等最早 resetsAt
```

session 历史存本机磁盘、与账号无关，故换号 resume 成立。无备用时优雅退化回原有等待机制。

### 4.4 Switch-back（自动切回原账号）

沿用 `resumeTimers` 同款模式：token `rejected` 时按 `resetsAt(+30s)` 起定时器 → 到点恢复 healthy → 下次 `pickActive()` 自然选回偏好最高者（主账号）。跨 node 重启：`server.listen` 回调里对所有 `status!=='healthy'` 且有 `resetsAt` 的 token 重排定时器。

### 4.5 前端提醒开新会话

`GET /api/tokens/status`（并入现有 pending 轮询节奏）：

```jsonc
{ "active": {"id","label"},
  "tokens": [{"label","status","resetsAt","utilization"}],  // 掩码，不含完整 token
  "notice": {"kind":"switch","from":"主账号","to":"备用A","at":...} | null }
```

- 有 `switch` notice → 顶栏横幅「已切换到备用账号「X」，建议开启新对话继续」+ ⚙ 徽标红点。
- 「知道了」→ `consumeNotice()`。
- 切号只对新 run 生效；4.3 撞墙续跑会自动用备用号接着跑，横幅用于知情 + 引导后续新对话。

### 4.6 边界

- 池空/未配置 → `pickActive()` 返回 null → 不注入 env、行为同现状（零侵入）。
- 只有 1 个号 → 无备用，撞墙退化回原有 pending-resume 等重置。
- 全部 exhausted → 取最早 `resetsAt` 等待（现有机制）。
- token 明文安全：仅本机 127.0.0.1；`settings.json` 进 `.gitignore`；`/api/tokens/status` 与设置页只回显掩码（`sk-ant-…末4位`），完整值不出后端。

## 五、设置页 UI（复用现有 modal 模式）

topbar 加 `⚙` 按钮 → `settingsMask` 弹层，两分区：

```
┌─ 设置 ───────────────────────────────── ✕ ─┐
│  飞书凭证                    🟢 连接正常     │
│    App ID      [ cli_xxxxxxxxxxxx      ]    │
│    App Secret  [ ••••••••••••  👁 ]         │
│                              [ 保存并重连 ] │
│  ─────────────────────────────────────────  │
│  Claude 账号（备用 token）      当前：主账号 │
│    ⠿ 主账号   ✓健康    sk-ant…a1b2   ✎ 🗑   │  ← 拖拽排序=偏好
│    ⠿ 备用A    ⚠即将耗尽 87% ·重置18:30      │
│    ⠿ 备用B    ⛔耗尽 ·重置 20:15            │
│  [ ＋ 添加账号 ]                            │
└─────────────────────────────────────────────┘
```

- 飞书区：App ID/Secret 输入 + 掩码 + 「保存并重连」；右上角连接状态徽标（读 `feishu-status.json`）。
- 账号区：label / 状态徽章 / 掩码尾号 / 重置时间 / utilization；拖拽调偏好序；添加/改名/删除；「当前」= `pickActive()`。
- 沿用现有 CSS 变量与 `$`/`fetch`/`toast`/mask 工具函数，不引框架。

## 六、错误处理

- 保存凭证：`POST /api/settings` 校验非空 + `appId` 弱前缀校验（`cli_`）；写盘失败 → 500 + toast。
- 热重载失败：feishu `start()` reject → `feishu-status.json` 置 failed + message；设置页红徽标 + 悬浮显因；旧连接尽量不断。
- token 注入：`env` 缺 `PATH`/`HOME` 会导致 SDK 子进程起不来——必须 `{...process.env, CLAUDE_CODE_OAUTH_TOKEN}`（整体替换语义，claude.js 注释警示）。
- 归因竞态：run 起跑即固化 `tokenId`，`onRateLimit` 只认它。
- 轮询降级：`/api/tokens/status` 失败前端静默重试，不打断对话。

## 七、测试策略

- 纯逻辑单测（沿用现有 `*.test.js` 风格）：`token-rotation.js` 的 `pickActive()`（healthy/warning/exhausted 组合、空池、单号）、`noteRateLimit()` 三档迁移、switch-back 恢复后重选。本 spec 唯一值得单测的纯函数域。
- 手动验证：① 改飞书凭证 → 看 `feishu-status.json` 与飞书日志确认重连；② 真实触达 `allowed_warning`/`rejected` 一次校准字段（对应 memory「待观测项」）；③ 掩码不泄漏完整 token。
- 真实限流、飞书长连接等无法自动化项，明确列为手动，不假装覆盖。

## 八、非目标（YAGNI）

- 不做多用户/账号权限体系（仅本机 owner 自用）。
- 不做 token 用量图表/历史曲线，仅显示当前状态 + 重置时间。
- 不做飞书之外的其它 IM 凭证配置。
- 不改动 `claude-web` 与 `claude-feishu` 的 PM2 拓扑。

# 架构设计文档 · claude-agent-web-demo

> 实现 7 大特性的**完整技术架构**：模块拆分、数据流、特性落地、设计模式、故障排查。
> 
> **核心思想**：后端进程常驻 + 状态持久化 + 多路复用流 + 渐进式权限询问，
> 让 Claude Code 走出终端，进入网页与飞书，并补上企业级运维能力。

---

## 全景架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  【入口层】Web UI + 飞书 Bot（两个协议适配器）                       │
│  ┌──────────────────┐      ┌──────────────────┐                     │
│  │ Web UI           │      │ 飞书 Bot         │                     │
│  │ 127.0.0.1:3000   │      │ 长连接 + 消息    │                     │
│  │ (public/app.js)  │      │ (WSClient)       │                     │
│  └────────┬─────────┘      └────────┬─────────┘                     │
│           │                         │                                │
│           │  SSE/POST /api/*        │  WS /event                   │
│           ▼                         ▼                                │
│  ┌──────────────────────────────────────────────┐                   │
│  │ src/entrypoints/                             │                   │
│  │ ├─ web/server.js (路由表；handler 见       │                   │
│  │ │   routes-*.js / run-*.js 域模块)          │                   │
│  │ └─ feishu/index.js (组装：channels/feishu   │                   │
│  │     收信→Context→dispatch)                  │                   │
│  └──────────────┬───────────────────────────────┘                   │
│                 │  统一分发                                           │
│                 ▼                                                     │
│  ┌──────────────────────────────────────────────┐                   │
│  │ app/dispatch.js  (路由分发核心)              │                   │
│  │ ├─ /api/run/start      [特性①②⑥⑦]        │                   │
│  │ ├─ /api/run/abort                           │                   │
│  │ ├─ /api/run/decision   [权限询问]           │                   │
│  │ ├─ /api/run/set-mode                        │                   │
│  │ ├─ /api/run/pending    [特性⑥]             │                   │
│  │ ├─ /api/history        [特性②]             │                   │
│  │ ├─ /api/settings       [特性③④⑤]          │                   │
│  │ ├─ /api/tokens/status  [特性④⑦]           │                   │
│  │ ├─ /api/actions        [特性⑤]             │                   │
│  │ ├─ /api/tasks                               │                   │
│  │ └─ /api/logs                                │                   │
│  └──────────────┬───────────────────────────────┘                   │
│                 │                                                     │
│  ┌──────────────┴─────────────────────────────────────┐             │
│  │                                                     │             │
│  │  【核心业务层】src/features/                       │             │
│  │  ├─ token-rotation.js  (特性④⑦: 多账号轮换)       │             │
│  │  ├─ claude-exec/       (执行编排)                 │             │
│  │  ├─ task-ops.js        (任务分析)                 │             │
│  │  ├─ task-triage/       (owner 待办分诊)           │             │
│  │  ├─ action-runner/     (特性⑤: 脚本执行)         │             │
│  │  ├─ feedback/          (故障反馈)                 │             │
│  │  └─ notify.js          (通知/表情)                │             │
│  │                                                     │             │
│  │  【状态管理层】src/store/                          │             │
│  │  ├─ runs.js            (task 管理 + 权限队列)    │             │
│  │  ├─ active-runs.json   (执行中状态)              │             │
│  │  ├─ pending-resume.json (特性⑥: 额度续跑)       │             │
│  │  ├─ history.js         (特性②: 会话归档)         │             │
│  │  ├─ settings.js        (特性③④: token 池)       │             │
│  │  ├─ action-configs.js  (特性⑤: 脚本配置)       │             │
│  │  ├─ tasks.json, event-log.jsonl, ...            │             │
│  │  └─ ...其他运行时状态                             │             │
│  │                                                     │             │
│  │  【集成层】src/integrations/                       │             │
│  │  ├─ claude.js          (特性①②⑥: Agent SDK)    │             │
│  │  │  └─ onRateLimit → pending-resume            │             │
│  │  │  └─ hooks.PreToolUse → 权限询问              │             │
│  │  ├─ lark.js            (特性③: 飞书 SDK)       │             │
│  │  ├─ shell.js           (命令执行)                │             │
│  │  └─ notify.js          (系统通知)                │             │
│  │                                                     │             │
│  │  【共享层】src/shared/                             │             │
│  │  ├─ config.js          (env 读取)                │             │
│  │  └─ logger.js          (日志记录)                │             │
│  │                                                     │             │
│  └─────────────────────────────────────────────────────┘             │
│                              │                                       │
│                              ▼                                       │
│           Claude Agent SDK (@anthropic-ai/claude-agent-sdk)         │
│                  (headless Claude Code)                             │
│                              │                                       │
│                              ▼                                       │
│         ~/.claude（CLI 订阅登录）或 ANTHROPIC_API_KEY               │
│                              │                                       │
│                              ▼                                       │
│              💰 Anthropic 额度池（Claude Code 订阅）                │
│                                                                       │
│  【后端进程守护】PM2 ecosystem.config.cjs                           │
│  ├─ claude-web (端口 3000)                                          │
│  └─ claude-feishu (飞书长连接)                                      │
│  ↓ 崩溃自动重启 + 跨重启状态恢复 (特性①)                           │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 七大特性的实现

### 特性① 关闭窗口后继续运行

**关键模块**：`store/runs.js` + `active-runs.json` + `integrations/claude.js` + PM2

**原理**：任务登记到 `active-runs.json` 落盘，后端进程被 PM2 守护，关窗不影响执行；重开页面通过 `/api/run/pending` 查询进行中的任务并接回流。

**流程**：
```
POST /api/run/start {prompt, cwd}
  ↓
registerRun() → active-runs.json 写入 {id, convId, state: 'running', ...}
  ↓
runClaude() → SDK query() 流式执行
  ↓
关窗 ✗：后端继续跑（PM2 守护进程）
  ↓
重开页面 → GET /api/run/pending
  ↓
activeRuns.readPending() → 找到 {id, convId, state: 'running'}
  ↓
前端 openConv(convId) + attachStream(runId) 接流
  ↓
finishRun() → state 变 'done' + active-runs.json 清除
```

**看门狗保护**：
- 静默 15min 无消息 → `abortRun()` 中断
- 硬超时 2h → `failRun()` 强制结束
- 日志记录：`[WARN][web]看门狗中断 {runId, reason}`

---

### 特性② 快速查询历史对话

**关键模块**：`store/history.js` + `/api/history` 端点 + `public/app.js` 侧栏

**原理**：会话按项目归档到 `tasks.json`，侧栏可检索、点开恢复上下文继续。

**流程**：
```
对话创建
  ↓
history.saveConv({convId, projectId, title, messages, ...})
  ↓
tasks.json 追加
  ↓
前端 GET /api/history?projectId=xxx&search=yyy
  ↓
返回 [{convId, title, updatedAt}, ...]
  ↓
侧栏渲染 + 点击 GET /api/history/:convId
  ↓
前端 paintMessages() + resumeHistorySession(prompt)
```

**配置**：
- `CLAUDE_PROJECT_ID` 固定所属项目（默认按目录名推导）
- 多项目隔离，侧栏按 projectId 聚合

---

### 特性③ 接入飞书

**关键模块**：`entrypoints/feishu/index.js` + `integrations/lark.js` + `store/settings.js`

**凭证配置** 二选一（后者优先）：
1. `.env`：`LARK_APP_ID` / `LARK_APP_SECRET`
2. Web 设置页 ⚙ → 飞书凭证 tab
   - 保存到 `settings.json`
   - 飞书进程 `fs.watch` 热重载，**无需重启**

**数据流**：
```
飞书消息 → WSClient.onMessage
  ↓
群聊过滤：chat_type=group 且未 @ 机器人 → 静默忽略
  ↓
权限判定 OWNER_OPEN_IDS
  ├─ owner → match 兜底（task-triage / claude-exec，不走意图识别）
  └─ guest → 意图识别
  ↓
意图识别（app/intent.js，逐层短路）
  L0 寒暄 → other
  L1 强意图前缀（app/intent-keywords.js，零成本）
     「提交需求/提个需求/需求：」 → feature
     「提交故障/提交BUG/提个bug/故障：」 → bug
     「问个问题/请问/有个疑问」    → question
  L2 动作关键词单命中 → action（action-configs 配置驱动）
  L3 一次 Haiku 合并分类（bug/feature/question/material/action，10s 超时）
  L4 都不是 → other
  ↓
feature 分发（features/index.js 注册顺序）
  ├─ feature/bug → feedback（即时应答 → 建任务 → 按托管档位评审/分析/自动开发）
  ├─ question    → project-qa（即时应答 → 只读查代码 → 回答）
  ├─ action      → action-runner（脚本 + 槽位填充）
  ├─ material    → feedback（材料入池，等下一条文字立案）
  └─ other       → 引导文案（msg('welcome')）
  ↓
result 回复到飞书会话（群聊自动 @ 提问人）
```

**权限配置**：
- `OWNER_OPEN_IDS` owner 白名单（完整能力）
- `TRIAGE_OWNER_OPEN_ID` 待办专属白名单（可用 guest 身份触发，避免 owner 全量接管）

---

### 特性④ 多 Claude 订阅账户

**关键模块**：`store/settings.js` + `features/token-rotation.js` + `integrations/claude.js`

**配置**：Web 设置页 ⚙ → Claude 账号 tab
- 添加多个 token（`sk-ant-oat01-xxx`）
- 起别名，保存到 `settings.json`（永不入库）

**自动选号机制**：
```
features/token-rotation.pickActive()
  ├─ 扫描 settings.json 里所有 token
  ├─ 按健康度排序：healthy > warning > rejected
  ├─ 同级按 updatedAt 最近排序
  └─ 返回排名第一的 {token, id}

任务起跑时：
  claudeAuthOpts() → {ANTHROPIC_API_TOKEN: active.token}
  ↓
  SDK env 注入
```

**覆盖范围**：
- Web 任务、飞书任务（每 run 实时 `pickActive()`）
- 内部调用：task-ops、intent、triage、classifyTier 全部走 `claudeAuthOpts()`
- 重置后自动切回（无需手动操作）

**状态更新**：
```
任务执行报限流
  ↓
claude.js onRateLimit(rateLimitInfo)
  ↓
token-rotation.noteRateLimit({id, status, resetsAt, utilization, ...})
  ↓
settings.json 更新 token 状态
```

---

### 特性⑤ 自定义脚本

**关键模块**：`features/action-runner/` + `store/action-configs.js` + `/api/actions` 端点

**配置步骤**：

1. 脚本放进 `scripts/`（或 `SCRIPTS_DIR` 指向目录）
2. 编写 `action-configs.json`：
   ```json
   [{
     “id”: “reset_onboarding”,
     “trigger”: “清理 onboarding|重置数据”,
     “slots”: [{“name”: “app_name”, “type”: “string”, ...}],
     “script”: “reset_onboarding.py”,
     “action”: “python”,
     “enabled”: true
   }]
   ```

**执行流程**：
```
对话 → intent 关键词分类
  ↓
匹配 action 触发词
  ↓
前端任务面板弹「执行动作」卡片 + 槽位输入
  ↓
用户填参数 + 点「执行」
  ↓
POST /api/actions/{actionId}/run {slots: {...}}
  ↓
action-runner/script-runner.js
  ├─ env 注入（从 .env 读取敏感值）
  ├─ 参数透传
  ├─ 子进程执行
  ↓
实时流式输出 → 前端任务面板
  ↓
action-log.jsonl 记录历史
```

**安全约束**：
- 脚本必须在 `scripts/` 内（路径校验）
- 不硬编码密钥，改从 `.env` 读
- 权限审批：卡片弹出才执行

---

### 特性⑥ 额度耗尽后等待重置续跑

**关键模块**：`store/pending-resume.json` + `integrations/claude.js onRateLimit` + `server.js` 定时器

**原理**：撞限流后记录断点，到重置时间自动续跑，跨进程重启也能恢复。

**流程**：
```
任务执行报限流（SDK onRateLimit 回调）
  ├─ status: 'rejected'
  ├─ resetsAt: Unix timestamp
  ↓
settleRun() 调用 pending-resume.addPending({
  convId, runId, params, timestamp, resetsAt, attempts: 0
})
  ↓
pending-resume.json 写入（跨重启持久化）
  ↓
前端轮询 GET /api/run/pending
  ├─ 展示等待横幅 ⏳
  ├─ 顶栏徽标 “暂停中”
  ↓
定时器：每 30s 扫描 pending-resume.json
  ↓
到达 resetsAt + 30s
  ├─ shouldAbandonResume(attempts, MAX_RESUME_ATTEMPTS=3)?
  │
  ├─ NO：doResume()
  │  ├─ 新建 run
  │  ├─ 发 intent “继续 [原 context]”
  │  ├─ resumeHistorySession 恢复原 session
  │  ├─ 前端自动接流
  │  └─ 成功 → finishRun() + removePending()
  │
  ├─ YES：attempts ≥ 4
  │  ├─ 标记 status: 'abandoned'
  │  ├─ 前端展示终结提示
  │  └─ POST /api/run/pending/dismiss 清除
  ↓
跨进程重启：
  server.listen 回调
    ├─ loadActiveRuns() [孤儿恢复]
    ├─ loadPending() [重排定时器]
    └─ 无 off-by-one bug
```

**熔断机制**：
- 同一 pending 连续续跑 ≥4 次失败 → 标记 `abandoned` → 不再复活
- 防死循环（重启 → 续跑失败 → 再重启）
- 日志：`[WARN][web]续跑熔断 {convId, attempts:4, reason:”连续 3 次失败，超过上限”}`

---

### 特性⑦ 额度耗尽后新窗口自动切下一个账号

**关键模块**：`features/token-rotation.js pickActive()`

**原理**：特性④ 已是「多账号 + 自动选号」；特性⑦ 就是「当当前号限流时，pickActive() 返回下一个可用号」。

**前提**：token 池 ≥2 个且状态不同

**示例场景**：
```
token 池：
  ① 主号（queenie）status: healthy
  ② 备用号（我）   status: warning (utilization > 0.8)

第一个任务 POST /api/run/start：
  pickActive() → ① healthy（最优）
  执行 → 烧额度 → 报限流（status → rejected）
  settings.json 更新 ① 的 status

第二个任务（新窗口）POST /api/run/start：
  pickActive()
    ├─ ① rejected → 跳过
    ├─ ② warning → 可用（降级选用）
    ↓
  env 注入 ② 的 token
    ↓
  继续跑（不中断，无需等重置）

原账号重置时间到：
  ① status 恢复 healthy
    ↓
  pickActive()
    ├─ ① healthy → 重新最优
    ↓
  新任务自动切回 ①（无需手动）
```

---

## 模块依赖与数据流

```
┌─────────────────┐
│ public/app.js   │
│   前端 UI       │ ◄── 用户交互
└────────┬────────┘
         │ SSE / POST /api/*
         ▼
┌─────────────────────────────────────────────────────┐
│ src/entrypoints/                                    │
│ ├─ web/server.js        (路由表；handler 拆至     │
│ │   routes-*.js，run 编排在 run-claude/openai.js)  │
│ └─ feishu/index.js      (组装层；渠道细节在        │
│ │   channels/feishu.js，契约见 channels/registry)  │
└────────┬────────────────────────────────────────────┘
         │ 统一分发
         ▼
┌─────────────────────────────────────────────────────┐
│ app/dispatch.js                                     │
│ └─ router: 按 intent/permission 选 feature        │
└────────┬────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ src/features/ (各特性自包含逻辑)                    │
│ ├─ token-rotation.js     (④⑦)                     │
│ ├─ claude-exec/          (执行编排)                 │
│ ├─ action-runner/        (⑤)                      │
│ ├─ task-ops.js           (分析)                    │
│ ├─ task-triage/          (owner 待办分诊)           │
│ └─ ...                                              │
└────────┬────────────────────────────────────────────┘
         │
    ┌────┴──────────────────┐
    │                       │
    ▼                       ▼
┌──────────────────┐  ┌──────────────────┐
│ integrations/    │  │ store/ (状态)    │
│ ├─ claude.js     │  │ ├─ runs.js       │
│ │  └─ query()    │  │ ├─ history.js    │
│ │  └─ onRate     │  │ ├─ settings.js   │
│ │     Limit      │  │ ├─ *.json        │
│ ├─ lark.js       │  │ └─ ...           │
│ ├─ shell.js      │  │                  │
│ └─ notify.js     │  │ shared/          │
│                  │  │ ├─ config.js     │
│                  │  │ └─ logger.js     │
└──────────────────┘  └──────────────────┘
    │
    └────► Claude Agent SDK
           @anthropic-ai/claude-agent-sdk
            │
            └────► ~/.claude 或 ANTHROPIC_API_KEY
                   │
                   └────► 💰 Anthropic 额度池
```

---

## 设计模式

### 1. 状态持久化 + 跨进程恢复

```javascript
// 写状态
store/runs.js writeActiveRuns(runs) → active-runs.json

// 读状态（进程重启时）
server.listen → {
  loadActiveRuns() // 恢复孤儿任务
  loadPending()    // 重排续跑定时器
}
```

→ **特性①⑥⑦** 的基础。

### 2. 流式多路复用

```javascript
// SDK query() 返回 AsyncIterable<message>
for await (const msg of query(...)) {
  if (msg.type === 'message') { /* 文本块 */ }
  if (msg.type === 'tool_use') { /* 工具活动 */ }
  if (msg.type === 'result') { /* 最终结果 */ }
  // 逐 token 推给前端 SSE
}
```

→ **特性①②** 的基础。

### 3. 权限询问序列化

```javascript
// 多个并行 tool_use 可能并发触发 canUseTool
// runs.js 用 pendingQueue 串行化

askUser(toolName)
  ├─ 前端返回 decision
  ├─ resolveDecision() 弹出下一个
  └─ 最后一个 advanceAsk() 自动放行
```

→ 防竞态（第二个工具权限覆盖第一个）。

### 4. 自动选号与降级

```javascript
// token-rotation.pickActive()
// 按健康度排序，偏好：healthy > warning > rejected

const candidates = tokens.sort((a, b) => {
  const scoreA = score(a.status) // healthy:3, warning:2, rejected:1
  return scoreB - scoreA // 降序
})
return candidates[0]
```

→ **特性④⑦** 的基础。

---

## 故障排查速查表

| 现象 | 根因 | 修复 |
|------|------|------|
| 关窗后任务消失 | PM2 未守护 或 `active-runs.json` 被删 | `pm2 start ecosystem.config.cjs` 或检查 `store/active-runs.js` 写入逻辑 |
| 重开页面接不回任务 | 前端 `attachStream` 逻辑错 | 检查 `/api/run/pending` 返回 + 前端 `openConv(convId)` 调用 |
| 飞书凭证改了但长连接没更新 | `fs.watch` 未触发 或 `WSClient.start()` 未调用 | 手动 `pm2 restart claude-feishu` |
| token 池有号但始终只用第一个 | `pickActive()` 逻辑错 或 status 未更新 | 检查 `onRateLimit` 是否被调用；手动改 `settings.json` 验证 |
| 额度续跑失败（pending 不清除） | 续跑超过熔断上限（≥4 次） | 清除 `pending-resume.json` 并 POST `/api/run/pending/dismiss` |
| 权限卡片不弹（工具直接执行） | `.claude/settings.json` 全局 `permissions.allow` 优先级更高 | `server.js` 注入 SDK `hooks.PreToolUse` 返回 `permissionDecision: 'ask'` 强制交回 |
| Web 设置页改凭证后没生效 | 飞书进程未热重载 | 手动 `pm2 restart claude-feishu` 或等 `fs.watch` 触发 |

---

## 总结

claude-agent-web-demo 通过以下设计实现 7 大特性：

| 特性 | 核心技术 | 关键文件 |
|------|---------|---------|
| ① 关窗续跑 | 后端进程 + PM2 + 状态落盘 | `store/active-runs.json`, `ecosystem.config.cjs` |
| ② 历史检索 | 会话归档 + 侧栏搜索 | `store/history.js`, `/api/history` |
| ③ 飞书接入 | WSClient 长连接 + 热重载 | `entrypoints/feishu/`, `integrations/lark.js` |
| ④ 多账号 | token 池 + 自动选号 | `store/settings.js`, `features/token-rotation.js` |
| ⑤ 自定义脚本 | 触发词 + action-runner | `action-configs.json`, `features/action-runner/` |
| ⑥ 额度续跑 | 定时器 + 熔断机制 | `store/pending-resume.json`, `server.js` 定时器 |
| ⑦ 自动切号 | `pickActive()` + status 更新 | `features/token-rotation.js` |

**核心设计思想**：
- **后端进程常驻**（PM2 守护）→ 关窗续跑
- **状态持久化**（JSON 落盘）→ 跨重启恢复
- **流式多路复用**（SSE / WS）→ 实时感知执行
- **权限询问序列化**（pendingQueue）→ 防竞态
- **自动选号与降级**（token 池）→ 多账号无缝切换

既保留了 Claude Code 的完整能力，又让它适应团队级、生产级的协作场景。
  intents: string[];                       // 关注的意图，如 ['cleanup']
  match?: (ctx) => boolean;                // 可选：自定义命中（如 owner 的兜底全接）
  handle: (ctx, intentResult) => Promise<void>;
}
```

**加新功能的完整步骤**：
1. `features/<name>/index.js` 导出 `Feature`；
2. 在 `features/index.js` 注册；
3. 若需新意图，在 `intent` 的分类提示里加一类（关键词可留空，靠 Claude + 自学习）。

**不改** 入口、router、store、集成。这就是「加功能 = 加模块」。

---

## 6. 任务状态机（规划 3 / 4 的地基）

bug / 需求 / 大开发都是一个 **Task**，落在 `store/tasks`：

```ts
interface Task {
  id: string;
  type: 'bug' | 'feature' | 'big-feature';
  title: string; detail: string;
  source: { via: 'feishu'; openId: string };
  status: 'new' | 'confirmed' | 'analyzing' | 'analyzed'
        | 'developing' | 'done' | 'rejected';
  docs?: { feishuDoc?: string; figma?: string; apiDoc?: string; notes?: string[] };
  analysis?: { suggestion: string; files: string[] };  // Claude 产出
  history: { at: string; event: string }[];
}
```

- **状态迁移**由 feature（`feedback`/`dev-task`/`doc-driven`）驱动，web 管理台展示与操作（确认/补充/触发）。
- **文档驱动（规划4）**：`doc-driven` 监听某 Task 的 `docs` 补充事件 → 判断「可开发部分」→ 调 `integrations/claude` 开发 → 更新 `status`/`history`。文档分批到、会变化，都只是往 `task.docs` 追加 + 触发一次评估。

---

## 7. 目录结构（目标）

```
src/
├── entrypoints/
│   ├── web/        server.js(瘦)、routes/(run/dirs/logs/tasks 各一文件)、public/
│   └── feishu/     长连接入口、ctx 适配（含表情 react 实现）
├── app/
│   ├── dispatch.js router：权限 + 意图 + 分发
│   └── intent.js   关键词+Claude+自学习
├── features/
│   ├── index.js    注册表
│   ├── claude-exec/    (owner 完整 Claude)
│   ├── data-cleanup/   (现有清理，迁入)
│   ├── qrcode/         (规划1)
│   ├── feedback/       (规划2)
│   ├── dev-task/       (规划3)
│   └── doc-driven/     (规划4)
├── integrations/
│   ├── claude.js       (=现 run-claude)
│   ├── lark.js         (发消息/表情/文件，从 feishu.js 抽出)
│   ├── shell.js        (python/CLI 执行，从 data-cleanup 抽出)
│   ├── miniprogram.js  (规划1：小程序 CLI)
│   ├── notify.js       (规划2：系统通知)
│   └── figma.js        (规划4)
├── store/
│   ├── index.js        (json 读写基座，最多 N 条、原子写)
│   └── <domain>.js     (bindings/cleanupLog/feedback/tasks/docs/…)
└── shared/  config.js · logger.js · util.js
```

---

## 8. 四个规划功能的落位（验证架构够用）

| # | 功能 | feature | 依赖的 integrations / store |
|---|------|---------|------------------------------|
| 1 | 二维码 | `qrcode`（intent: qrcode） | `miniprogram`(CLI 生成) + `lark`(发图) |
| 2 | 需求/bug 记录 | `feedback`（intent: bug/feature） | `store/tasks`(存) + `notify`(系统提示) + web 管理台展示 |
| 3 | 确认→分析→开发 | `dev-task` | `store/tasks`(状态机) + `claude`(分析代码/开发) + web(确认/补充) |
| 4 | 文档驱动开发 | `doc-driven` | `store/tasks.docs` + `claude` + `figma`/飞书文档；docs 补充即触发评估 |

四个都只是「新增一个 feature + 复用集成/存储」，印证架构不需为它们改公共层。

---

## 9. 迁移路线（增量，每步可验证，不推倒重来）

> 现功能全程保持可用；每阶段跑 `node --check` + 手测关键路径。

- **阶段 0（准备）**：建 `src/` 骨架 + `store` 基座 + `shared/config`。
- **阶段 1（抽集成）**：`run-claude`→`integrations/claude`；飞书发消息/表情→`integrations/lark`；python spawn→`integrations/shell`。各 JSON 读写→`store/<domain>`。**行为不变**，只是搬家 + 改引用。
- **阶段 2（抽核心）**：`app/intent`(把 data-cleanup 里的意图/自学习提出来) + `app/dispatch`(权限+路由)。`data-cleanup` 改造成 `features/data-cleanup`（符合 Feature 契约）。
- **阶段 3（瘦入口）**：`feishu.js`/`server.js` 只保留协议适配 + 产出 Context + 调 dispatch；owner 逻辑变 `features/claude-exec`。
- **阶段 4（web 管理台）**：web 从「纯聊天」扩展出 tab：对话 / 清理日志 / 需求任务 / 目录设置（为规划 2/3/4 铺路）。
- **阶段 5+**：按你逐个细化，依次落地 `qrcode`→`feedback`→`dev-task`→`doc-driven`。

---

## 10. 关键约定

- 依赖单向向下；`features` 之间不互相 import（要协作走 `store`/事件）。
- 外部系统只经 `integrations`；持久化只经 `store`；env 只经 `shared/config`。
- 每个 feature 自包含、可独立读懂与测试。
- 破坏性/外呼操作（清理、开发改码、发消息）在 feature 层显式确认或留痕（`store/*-log`）。
- 增量提交可工作的代码；单文件过大即拆。

---

_本文件为架构蓝图。功能细节随你逐个细化时，补到各 `features/<name>/README.md`。_

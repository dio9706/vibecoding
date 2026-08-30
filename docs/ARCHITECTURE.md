# 架构设计文档 · Principal

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
│  │  【能力层】src/capabilities/ (通用，无业务语义)     │             │
│  │  ├─ token-rotation.js  (特性④⑦: 多账号轮换)       │             │
│  │  ├─ llm-classify.js    (LLM 分类)                 │             │
│  │  └─ llm-readonly-agent.js (只读 agent)            │             │
│  │                                                     │             │
│  │  【功能层】src/features/ (内核) + src/plugins/      │             │
│  │  ├─ features/claude-exec/  (内核: owner 全接)     │             │
│  │  ├─ features/memory-bank/  (记忆库)               │             │
│  │  ├─ features/project-*/    (项目体检 / 优化)      │             │
│  │  └─ plugins/  (业务插件，settings 可启停)          │             │
│  │      ├─ team-tools/    (需求/故障/待办/埋点)       │             │
│  │      ├─ action-runner/ (特性⑤: 脚本执行)         │             │
│  │      └─ feishu-relay/  (会话飞书回控)             │             │
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
│  ├─ principal-web (端口 3000)                                          │
│  └─ principal-feishu (飞书长连接)                                      │
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

**关键模块**：`store/settings.js` + `capabilities/token-rotation.js` + `integrations/claude.js`

**配置**：Web 设置页 ⚙ → Claude 账号 tab
- 添加多个 token（`sk-ant-oat01-xxx`）
- 起别名，保存到 `settings.json`（永不入库）

**自动选号机制**：
```
capabilities/token-rotation.pickActive()
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

**关键模块**：`plugins/action-runner/` + `store/action-configs.js` + `/api/actions` 端点

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

**关键模块**：`capabilities/token-rotation.js pickActive()`

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
| 飞书凭证改了但长连接没更新 | `fs.watch` 未触发 或 `WSClient.start()` 未调用 | 手动 `pm2 restart principal-feishu` |
| token 池有号但始终只用第一个 | `pickActive()` 逻辑错 或 status 未更新 | 检查 `onRateLimit` 是否被调用；手动改 `settings.json` 验证 |
| 额度续跑失败（pending 不清除） | 续跑超过熔断上限（≥4 次） | 清除 `pending-resume.json` 并 POST `/api/run/pending/dismiss` |
| 权限卡片不弹（工具直接执行） | `.claude/settings.json` 全局 `permissions.allow` 优先级更高 | `server.js` 注入 SDK `hooks.PreToolUse` 返回 `permissionDecision: 'ask'` 强制交回 |
| Web 设置页改凭证后没生效 | 飞书进程未热重载 | 手动 `pm2 restart principal-feishu` 或等 `fs.watch` 触发 |

---

## 七大特性总结

Principal 通过以下设计实现 7 大特性：

| 特性 | 核心技术 | 关键文件 |
|------|---------|---------|
| ① 关窗续跑 | 后端进程 + PM2 + 状态落盘 | `store/active-runs.json`, `ecosystem.config.cjs` |
| ② 历史检索 | 会话归档 + 侧栏搜索 | `store/history.js`, `/api/history` |
| ③ 飞书接入 | WSClient 长连接 + 热重载 | `entrypoints/feishu/`, `integrations/lark.js` |
| ④ 多账号 | token 池 + 自动选号 | `store/settings.js`, `capabilities/token-rotation.js` |
| ⑤ 自定义脚本 | 触发词 + action-runner | `action-configs.json`, `plugins/action-runner/` |
| ⑥ 额度续跑 | 定时器 + 熔断机制 | `store/pending-resume.json`, `server.js` 定时器 |
| ⑦ 自动切号 | `pickActive()` + status 更新 | `capabilities/token-rotation.js` |

**核心设计思想**：
- **后端进程常驻**（PM2 守护）→ 关窗续跑
- **状态持久化**（JSON 落盘）→ 跨重启恢复
- **流式多路复用**（SSE / WS）→ 实时感知执行
- **权限询问序列化**（pendingQueue）→ 防竞态
- **自动选号与降级**（token 池）→ 多账号无缝切换

既保留了 Claude Code 的完整能力，又让它适应团队级、生产级的协作场景。

---

## Feature 契约与装配

上面「七大特性」讲的是纵向能力，这一节讲横向扩展点：**加一个新的对话功能要往哪落。**

### Feature 契约

`app/dispatch.js` 消费的就是这个形状（以代码为准，勿照抄本表去改 dispatch）：

```ts
interface Feature {
  name: string;                                 // 日志里的标识
  permission: 'any' | 'owner' | 'guest';        // 与 ctx.user.role 比对
  intents: string[];                            // 关注的意图，如 ['bug', 'feature']
  hasPending?: (ctx) => boolean;                // 有未完成会话（如追问中）→ 抢在意图识别之前接管
  match?: (ctx) => boolean;                     // 自定义命中，用于 owner 兜底全接
  handle: (ctx, intentResult) => Promise<any>;  // 可返回 PASS 把消息交还 dispatch
}
```

### dispatch 的四段顺序

```
0. hasPending 命中        → 交给它；若返回 PASS 则交还，继续往下
1. match 命中             → 交给它（owner 兜底走这条）
2. 意图识别 → permission + intents 双匹配 → 交给第一个命中的
3. 都不匹配               → 回欢迎卡
```

`hasPending` 是**同步**判定，判不出「这条到底是不是在回答追问」，所以必须有 `PASS`
这条退路 —— 否则一次动作追问会把该用户后续所有消息都粘住（已发生过的事故）。

### 装配路径

```
src/features/index.js
  ├─ CORE：claude-exec（order 20，owner 全接）
  └─ loadEnabledPluginFeatures()  ← 业务功能全部从这里来
       └─ src/plugins/index.js  PLUGIN_MANIFEST
```

- **业务功能一律是插件**，不再往 `features/index.js` 登记。内核只留 `claude-exec`。
- 停用的插件**不 import**（动态 `load()`）——「内核更纯」是实打实的：进程根本不载入那段业务代码。
- 启停走 `settings.json` 的 `plugins` 节，缺省为启用（向后兼容）。
- 单个插件加载失败会被隔离并告警，不拖垮内核启动。
- `order` 决定匹配优先级，小者先。**业务插件的 order 必须小于 claude-exec 的 20**，
  否则对 owner 发的消息，`claude-exec` 的 `match` 会先全部接走，插件永远等不到。
  现有取值见各插件 `index.js` 顶部注释（都写明了为什么占那个数）。

### 加一个新功能

1. 建 `src/plugins/<id>/index.js`，default 导出 `{ id, features: [{ order, feature }] }`；
2. 在 `src/plugins/index.js` 的 `PLUGIN_MANIFEST` 登记（id + description + 动态 `load`）；
3. 需要新意图时，在 `app/intent.js` 的分类里加一类；
4. **不改** dispatch、入口、store、集成 —— 「加功能 = 加插件」。

---

## 关键约定

约定必须**可判定**，否则迟早退化成装饰 —— 2026-08-28 的体检就发现原来那版
「持久化只经 store」在实测里有 21 处越界，其中大多数其实是正当的，
但约定没写清边界，导致既无法判断谁违规、也就无人再当回事。
所以下面每条都给出**怎么验**和**正当例外**。

### 1. 分层与依赖方向

```
entrypoints → app → features / plugins → capabilities → integrations / store → shared
```

**下层不得 import 上层。** 验（应全部为空）：

```bash
grep -rn "from '.*\(features\|plugins\|entrypoints\|app\)/" src/store src/shared src/integrations src/capabilities --include="*.js" | grep -v test
```

**插件之间不得互相 import**（要协作走 `store` 或事件）。验：

```bash
grep -rn "from '.*plugins/" src/plugins --include="*.js" | grep -v test
```

> 注意匹配的是 **import 路径**里的 `plugins/`，不是文件所在路径 ——
> 写成 `grep "plugins/"` 会把每一行 `../../shared/...` 都算进去（因为文件本身就在 `src/plugins/` 下），
> 得到一份全是误报的清单。

插件**可以**依赖 `capabilities/` —— 那是共享能力，不是别人的业务。

### 2. `features` / `capabilities` / `integrations` 的分工

这三个最容易混。判据：

| 目录 | 放什么 | 判据 |
|---|---|---|
| `features/` | 内核 feature（`claude-exec`，走 dispatch）+ 不走 dispatch 的独立功能模块（`memory-bank`、`project-checkup`、`project-optimize`） | 是产品功能；**不被其它 feature / 插件 import** |
| `capabilities/` | 通用能力：`llm-classify`（LLM 分类）、`token-rotation`（账号轮换）、`llm-readonly-agent`（只读 agent） | 换个业务场景仍能原样复用；**自身不 import 任何 feature / plugin / entrypoint**（可 grep 验证，见上）。判据是性质而非使用次数 —— `llm-readonly-agent` 目前只有一个调用方，但它是通用机制 |
| `integrations/` | 外部系统适配：Claude SDK、飞书、shell、系统通知 | 有对外 IO |

> 历史教训：`llm-classify` / `token-rotation` 原先放在 `features/` 里，被 7 处插件依赖，
> 使得「feature 之间不互相 import」这条约定**必然失效**。它们本就是基础能力而非业务功能，
> 2026-08-28 迁至 `capabilities/`，约定才重新自洽。

### 3. 持久化

**本项目自身的状态**一律经 `store/`（它负责跨进程文件锁与 tmp+rename 原子写）。

**正当例外**（不算违规）：

- `shared/logger.js` 写日志 —— 它自己就是基础设施，不能反过来依赖 store；
- `features/project-optimize`、`features/project-checkup` 写**用户项目**的文件 —— 那是功能本身；
- `integrations/` 落临时文件（如 lark 下载的附件）。

验：下面命中的每一项都必须落在上述例外内。

```bash
grep -rn "writeFileSync\|appendFileSync" src --include="*.js" | grep -v test | grep -v "^src/store/"
```

### 4. 环境变量

业务代码只经 `shared/config`。

**正当例外**：`APP_DATA_DIR` 的路径解析（`store/index.js`、`shared/app-paths.js`）——
`config` 自身依赖它们，不可能反过来。

### 5. 其它

- 破坏性 / 外呼操作（清理、改码、发消息）在 feature 层显式确认或留痕（`store/*-log`）。
- 单文件过大即拆。
- 前端渲染任何来自后端或模型的文本，一律 `createElement` + `textContent`；
  必须渲染 markdown 时走 `util.js` 的 `renderMarkdown`（内含强制消毒），**禁裸 innerHTML**。
- `public/vendor/` 的三方库由 `npm run sync:vendor` 从 node_modules 同步，
  版本见 `public/vendor/VERSIONS.md`，**不要手工替换**（构建前的 `--check` 会拦下漂移）。
- 卡片回调的 kind 处理器由**各插件自注册**（`registerCardKindHandler`），
  `shared/card-actions.js` 只提供注册表机制、不含任何 kind 的实现 ——
  这样插件停用时对应 kind 自然没有处理器。

---

_2026-07 期的迁移路线与规划功能落位（已完成的历史蓝图）见
`archive/ARCHITECTURE-legacy-sections-6-10.md`。_

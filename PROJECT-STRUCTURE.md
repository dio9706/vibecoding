# 📁 claude-p-web-demo 项目目录结构完整指南

**项目路径**: `C:\Users\DELL\Desktop\claude-p-web-demo`

---

## 🎯 项目概述

这是一个基于 Claude Agent SDK 的 Web 应用 + 飞书机器人集成项目，具有以下核心特性：

- 🤖 **Claude 智能代理**：支持多种模型和思考强度配置
- 🔄 **Token 轮换机制**：自动管理多个 API Token，支持降级和转换
- 📊 **任务管理系统**：包括任务分类、分析、开发等功能
- 💬 **Web + 飞书双渠道**：同时支持 Web UI 和飞书机器人交互
- 📝 **会话持久化**：完整的历史记录和恢复机制

---

## 📂 完整目录树

```
claude-p-web-demo/
│
├─ 【根目录配置文件】
├── .env                          # 环境变量（本地，不入库）
├── .env.example                  # 环境变量示例
├── .gitignore                    # Git 忽略规则
├── package.json                  # NPM 项目配置 + 依赖声明
├── package-lock.json             # NPM 依赖版本锁定
├── ecosystem.config.cjs          # PM2 进程管理配置
│
├─ 【启动脚本】
├── server.js                     # Node.js 服务器启动入口
├── start.bat                     # Windows 快速启动脚本
├── stop.bat                      # Windows 停止脚本
├── feishu.js                     # 飞书机器人启动脚本
│
├─ 【测试和验证脚本】（.mjs）
├── test-anim.mjs                 # 动画基础测试
├── test-anim-full.mjs            # 完整动画测试
├── test-wait-longer.mjs          # 延长等待时间测试
├── test-with-tools.mjs           # 工具集成测试
├── check-anim.js                 # 动画检查脚本
├── check-run-status.mjs          # 运行状态检查
├── extended-tool-test.mjs        # 扩展工具测试
├── final-acceptance-test.mjs      # 最终验收测试
├── inspect-dom.mjs               # DOM 检查脚本
├── verify-anim.mjs               # 动画验证脚本
│
├─ 【数据存储文件】（JSON）
├── tasks.json                    # 任务列表数据
├── active-runs.json              # 当前活跃运行
├── event-log.json                # 事件日志（JSON 格式）
├── event-log.jsonl               # 事件日志（JSONL 流式格式）
├── feishu-status.json            # 飞书连接状态
├── cleanup-log.json              # 数据清理日志
├── bindings.json                 # Token / 账户绑定
├── pending-resume.json           # 待恢复的会话
├── saved-dirs.json               # 保存的工作目录
│
├─ 【其他文件】
├── README.md                     # 项目说明文档
├── QUICK-REFERENCE.txt           # 快速参考指南
├── settings.json                 # 项目设置（自动生成）
│
├─ 📂 src/                        # *** 核心源代码目录 ***
│   │
│   ├─ 📂 app/                    # 应用核心逻辑
│   │  ├── dispatch.js            # 请求分发和路由
│   │  └── intent.js              # 用户意图识别
│   │
│   ├─ 📂 entrypoints/            # 应用入口（支持多种部署）
│   │  ├── 📂 feishu/
│   │  │   └── index.js           # 飞书机器人入口
│   │  └── 📂 web/
│   │      └── server.js          # Web 服务器入口（HTTP + SSE）
│   │
│   ├─ 📂 features/               # 业务功能模块
│   │  ├── index.js               # 功能导出汇总
│   │  ├── task-ops.js            # 任务操作（分析、开发）
│   │  ├── token-rotation.js      # Token 轮换管理 ⭐ 降级机制核心
│   │  ├── token-rotation.test.js # Token 轮换测试
│   │  │
│   │  ├── 📂 claude-exec/        # Claude 执行器
│   │  │  └── index.js            # 执行任务和生成代码
│   │  │
│   │  ├── 📂 data-cleanup/       # 数据清理和维护
│   │  │  └── index.js            # 清理日志、缓存等
│   │  │
│   │  ├── 📂 feedback/           # 反馈系统
│   │  │  └── index.js            # 收集和管理反馈
│   │  │
│   │  └── 📂 task-triage/        # 任务分类和分级
│   │     ├── index.js            # 分类模块入口
│   │     ├── logic.js            # 分类算法逻辑
│   │     └── logic.test.js       # 分类逻辑单元测试
│   │
│   ├─ 📂 integrations/           # 外部服务集成
│   │  ├── claude.js              # Claude Agent SDK 封装 ⭐ 核心
│   │  ├── claude.test.js         # Claude 集成测试
│   │  ├── lark.js                # 飞书 Open API 集成
│   │  ├── notify.js              # Windows 通知集成（降级 console）
│   │  └── shell.js               # Shell 命令执行
│   │
│   ├─ 📂 shared/                 # 共享工具和工具函数
│   │  ├── config.js              # 配置管理（从 .env 读取）
│   │  ├── logger.js              # 统一日志系统
│   │  ├── messages.js            # 消息格式化和预处理
│   │  └── messages.test.js       # 消息工具单元测试
│   │
│   └─ 📂 store/                  # 数据持久化层（JSON 文件存储）
│      ├── index.js               # 存储基础工具（读写锁）
│      ├── active-runs.js         # 当前活跃运行管理
│      ├── bindings.js            # Token / 账户绑定管理
│      ├── cleanup-log.js         # 清理日志记录
│      ├── event-log.js           # 事件日志记录
│      ├── history.js             # 会话历史记录
│      ├── history.test.js        # 历史记录单元测试
│      ├── learned-keywords.js    # 学习到的关键词存储
│      ├── pending-resume.js      # 待恢复会话队列
│      ├── runs.js                # 运行管理（连接、订阅）
│      ├── runs.test.js           # 运行管理单元测试
│      ├── saved-dirs.js          # 保存的工作目录
│      ├── settings.js            # 用户设置和偏好
│      └── tasks.js               # 任务列表管理
│
├─ 📂 public/                     # 静态资源目录（HTML, CSS, JS 等）
│
├─ 📂 docs/                       # 项目文档目录
│
├─ 📂 logs/                       # 日志输出目录
│
├─ 📂 .serena/                    # Serena 集成配置
│
├─ 📂 .spec-workflow/             # Spec Workflow 配置
│
├─ 📂 .uploads/                   # 上传文件临时存储
│
└─ 📂 .git/                       # Git 版本控制目录
```

---

## 🏗️ 核心模块详解

### 1️⃣ **app/** - 应用路由和意图识别
```
app/
├── dispatch.js       处理请求的分发逻辑
└── intent.js         识别用户意图（Haiku 快速分类）
```
- **职责**：解析用户输入，识别意图档位，路由到对应处理器
- **关键函数**：`dispatch()`, `classifyTier()`

### 2️⃣ **entrypoints/** - 应用入口（多渠道支持）
```
entrypoints/
├── web/
│   └── server.js     HTTP + SSE + 管理 API 服务器
└── feishu/
    └── index.js      飞书机器人消息处理
```
- **web/server.js**：
  - 监听 127.0.0.1 的 HTTP 服务
  - 支持 SSE 流式输出
  - 提供 REST API 管理接口
  - 处理用户对话、任务管理等

- **feishu/index.js**：
  - 消息事件处理
  - 卡片富文本交互
  - 与 web 服务器共享数据存储

### 3️⃣ **features/** - 业务功能实现

#### 📌 **token-rotation.js** - Token 轮换与降级机制 ⭐
```javascript
// 核心降级流程
getActiveToken()        // 获取当前可用 Token
noteRateLimit()         // 记录限流事件 → 触发转换
scheduleAllSwitchBacks() // 定时恢复失效 Token
```

**降级场景**：
1. **限流**: 当前 Token 触发速率限制 → 自动切换备用 Token
2. **超时**: 请求超时 → 记录并在下次切换
3. **恢复**: 失效 Token 在冷却时间后自动恢复

**配置文件**: `bindings.json`
```json
{
  "tokens": [
    { "id": "token1", "status": "active", "errorCount": 0 },
    { "id": "token2", "status": "backoff", "backoffUntil": 1234567890 }
  ]
}
```

#### 📌 **task-triage/logic.js** - 任务分类逻辑
```javascript
// 根据关键词快速判断任务档位
classifyTier(prompt)
// 返回: { model: 'claude-opus-4-1', effort: 'max' }
```

#### 📌 **claude-exec/index.js** - Claude 代码执行
- 调用 `runClaude()` 执行任务
- 解析 Markdown 代码块
- 存储执行结果

#### 📌 **data-cleanup/index.js** - 数据维护
- 清理过期日志
- 压缩事件日志
- 回收磁盘空间

#### 📌 **feedback/index.js** - 反馈收集
- 用户反馈管理
- 问题上报

### 4️⃣ **integrations/** - 外部服务集成

#### 📌 **claude.js** - Claude Agent SDK 核心包装 ⭐
```javascript
runClaude(prompt, {
  model: 'claude-opus-4-1',      // 模型选择
  effort: 'high',                 // 思考强度：low|medium|high|xhigh|max
  settings: { autoCompactEnabled: true }, // 长会话自动压缩
  onText: (text) => {},           // 逐字回调
  onActivity: (activity) => {},   // 工具调用事件
  onResult: (result) => {},       // 最终结果
  ...
})
```

**降级特性**：
- `effort` 参数：模型不支持时 SDK 自动降级
- `autoCompactEnabled`: 长会话自动压缩节省额度
- `supportedDialogKinds`: 声明支持的对话类型，不支持时忽略

#### 📌 **lark.js** - 飞书 API 集成
- 发送消息和卡片
- 接收事件和命令
- 管理机器人状态

#### 📌 **notify.js** - 系统通知（跨平台降级）
```javascript
// Windows: 弹窗通知
// 其他平台: 降级为 console.log
notify('标题', '消息');
```

#### 📌 **shell.js** - 命令执行
- 安全执行 Shell 命令
- 返回输出和错误码

### 5️⃣ **shared/** - 共享工具库

#### 📌 **config.js** - 配置管理
```javascript
// 从 .env 读取
const { LARK_BOT_ID, CLAUDE_MODEL } = config;
```

#### 📌 **logger.js** - 统一日志系统
```javascript
logger.info('tag', 'message', { ...data });
logger.warn('tag', 'warning message', {});
logger.error('tag', 'error message', { err: error });
```

#### 📌 **messages.js** - 消息处理
- 消息格式化
- 敏感信息脱敏
- 文本清理

### 6️⃣ **store/** - 数据持久化层

所有数据存储在 `appdata/` 目录（JSON 文件），使用文件锁防止并发冲突。

#### 📌 **index.js** - 底层存储工具
```javascript
// 原子读取
const data = readJson('tasks.json', []);

// 原子更新（读-改-写，带文件锁）
updateJson('tasks.json', [], (current) => {
  current.push(newTask);
  return current;
});
```

#### 📌 **active-runs.js** - 活跃运行管理
- 记录当前执行中的任务
- 支持暂停/恢复/取消

#### 📌 **runs.js** - 运行状态管理（核心）
```javascript
createRun()      // 创建新运行
getRun()         // 获取运行详情
subscribe()      // 前端 SSE 订阅
sendTo()         // 发送插话消息（steering）
finishRun()      // 标记为完成
failRun()        // 标记为失败
```

#### 📌 **history.js** - 会话历史
- 保存完整的对话历史
- 支持搜索和过滤
- 恢复到历史会话

#### 📌 **pending-resume.js** - 待恢复队列
- 应用崩溃时保存进度
- 重启后自动恢复

---

## 🔄 降级机制详解 ⭐

项目内置多层降级机制，确保服务可用性：

### 1. **Token 轮换降级**
**文件**: `src/features/token-rotation.js`

```javascript
// 当前 Token 限流 → 自动切换备用 Token
noteRateLimit(token) 
  → setTokenStatus('backoff')  // 冷却该 Token
  → getActiveToken()           // 返回下一个可用 Token
```

**状态转换**:
```
active → 限流 → backoff(冷却中) → 恢复定时器 → active
```

### 2. **Effort 降级**
**文件**: `src/integrations/claude.js`

```javascript
runClaude(prompt, {
  effort: 'high'  // 模型不支持 → SDK 自动降级到 'medium'
})
```

**SDK 行为**: 模型不支持的 `effort` 参数会自动降级，无需应用层处理。

### 3. **Model 降级**
**文件**: `src/entrypoints/web/server.js` - `classifyTier()`

```javascript
// 快速 Haiku 分类失败/超时 → 降级到 medium effort
async function classifyTier(prompt) {
  const quick = quickTier(prompt);  // 本地规则快速判断
  if (quick) return quick;           // 有匹配返回
  
  try {
    // Haiku 超快速分类
    return await runClaude(prompt, {
      model: 'claude-haiku-4-6',
      effort: 'low',
      timeout: 3000  // 3秒超时
    });
  } catch (err) {
    logger.warn('分类超时', err);
    return { effort: 'medium' };  // ⬅️ 降级！
  }
}
```

### 4. **通知平台降级**
**文件**: `src/integrations/notify.js`

```javascript
// Windows: PowerShell 气泡通知
// 其他: console.log
export function notify(title, message) {
  if (process.platform === 'win32') {
    // Windows 通知逻辑
  } else {
    console.log(`${title}: ${message}`);  // 降级
  }
}
```

### 5. **会话恢复降级**
**文件**: `src/store/pending-resume.js`

```javascript
// 应用崩溃 → 保存 pending 状态 → 下次启动恢复
// 如果恢复失败 → 从历史会话中重新加载
getPending()
  → runClaude(resume: sessionId)  // 恢复
  → catch → 重新开始新会话
```

### 6. **自动压缩降级**
**文件**: `src/entrypoints/web/server.js`

```javascript
settings: {
  autoCompactEnabled: true  // 长会话自动压缩
}
// 当上下文膨胀 → 自动压缩历史消息 → 节省 Token
```

---

## 📊 文件类型统计

```
总体统计:
├─ 源代码文件      35+ .js 文件
├─ 测试文件        6 个 .test.js 文件  
├─ 测试脚本        8+ .mjs 脚本
├─ 数据文件        JSON 配置和状态文件
├─ 配置文件        .env, package.json, ecosystem.config.cjs
└─ 文档文件        README.md, QUICK-REFERENCE.txt
```

---

## 🎯 关键文件速查

| 文件 | 用途 | 关键函数 |
|------|------|---------|
| `src/entrypoints/web/server.js` | Web 服务器核心 | `createRun()`, `runSend()` |
| `src/integrations/claude.js` | Claude 调用接口 | `runClaude()` |
| `src/features/token-rotation.js` | Token 管理 | `getActiveToken()` |
| `src/store/runs.js` | 运行状态管理 | `subscribe()`, `finishRun()` |
| `src/app/dispatch.js` | 请求分发 | `dispatch()` |
| `src/features/task-triage/logic.js` | 任务分类 | `classifyTier()` |

---

## 🔧 数据存储位置

所有应用数据存储在项目根目录的 JSON 文件中：

```
project-root/
├── tasks.json              # 任务列表
├── active-runs.json        # 活跃运行
├── event-log.jsonl         # 事件流
├── bindings.json           # Token 绑定
├── pending-resume.json     # 恢复队列
├── history.json            # 会话历史（如存在）
└── settings.json           # 用户设置
```

**数据访问统一走 `src/store/` 模块**，通过文件锁防止并发冲突。

---

## 🚀 项目启动流程

```
1. npm start / node server.js
   ↓
2. src/entrypoints/web/server.js 启动 HTTP 服务
   ↓
3. 监听 127.0.0.1:3000（或配置端口）
   ↓
4. 前端连接 → SSE 订阅
   ↓
5. 用户输入 → POST /api/run → createRun()
   ↓
6. 分发到 runClaude() 执行
   ↓
7. 通过 SSE 流式返回结果
```

---

## 📝 建议的工作流

1. **查看功能**：先看 `src/features/` 下的对应模块
2. **调用流程**：追踪 `src/integrations/claude.js` 的 `runClaude()`
3. **数据管理**：所有读写都通过 `src/store/index.js` 的工具函数
4. **添加新功能**：在 `src/features/` 创建新目录，导出到 `src/features/index.js`
5. **修复 Bug**：查看 `event-log.jsonl` 和 `logs/` 目录的日志

---

## ✅ 项目完整度检查

- ✅ **多渠道部署**：Web + 飞书同步
- ✅ **Token 轮换**：自动降级和恢复
- ✅ **会话恢复**：支持中断续接
- ✅ **流式输出**：SSE 实时推送
- ✅ **任务分类**：快速意图识别
- ✅ **权限管理**：细粒度工具审批
- ✅ **日志系统**：完整的事件追踪
- ✅ **数据持久化**：文件锁保证并发安全

---

**最后更新**: 2026-07-19  
**项目作者**: 您的团队  
**维护者**: 点击右上角 ⚙️ 查看当前设置

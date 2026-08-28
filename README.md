# Principal · 让任何终端成为你的员工

> 名字取自委托代理理论（principal–agent）：**你是委托人（Principal），每个终端里跑的是代理人（Agent）。**
> 你的角色从「敲键盘的人」变成「签字的人」——派活、看结果、审计过程。

在**浏览器**（以及**飞书 bot**、**桌面客户端**）里调用本地 Claude，实时流式看到它读文件、跑命令、写代码的全过程。
后端基于 **Claude Agent SDK**（`@anthropic-ai/claude-agent-sdk`，= headless 版 Claude Code），
走本机订阅登录，具备完整 Claude Code 能力（读写文件、执行命令、指定工作目录），
额度与交互式 Claude Code 共用同一订阅池。

> 一句话：把 Claude Code 从终端搬进网页，并补上「关窗续跑 / 历史检索 / 飞书接入 / 多账号轮换 / 额度自愈 / 自定义脚本」等工程能力。

---

## ✨ 相比原生 Claude Code 的增强

| # | 增强特性 | 说明 | 原生 Claude Code |
|:-:|----------|------|:---------------:|
| 1 | **关闭窗口后继续运行** | 任务在后端进程里跑，关掉网页/浏览器不影响执行；重开页面自动接回正在跑的任务流 | ❌（关终端即断） |
| 2 | **快速查询历史对话** | 侧栏按项目/时间检索历史会话，点开即恢复上下文继续对话 | ⚠️（仅 `--resume`，无检索 UI） |
| 3 | **接入飞书** | 飞书 bot 长连接接入，可在飞书里直接给 Claude 发任务、收结果，支持图片、分级授权 | ❌ |
| 4 | **多 Claude 订阅账户** | 设置页维护一个 token 池，多个订阅账号统一管理、按健康度自动选号 | ❌（单账号） |
| 5 | **自定义脚本** | 用触发词把本地 Python/Shell 脚本挂成「动作」，对话中一句话即可带参执行 | ⚠️（需手动跑命令） |
| 6 | **额度耗尽后等待重置续跑** | 撞到限流后自动记录断点，到重置时间自动新建任务、恢复会话发「继续」 | ❌（直接失败） |
| 7 | **额度耗尽后自动切下一个账号** | 主账号撞墙时，新任务自动切换到 token 池里下一个可用账号，重置后自动切回原号 | ❌ |

此外还有：token 级流式打字机输出、模型/思考强度选择器（Auto 关键词判档）、交互式权限审批卡片（Write/Edit/Bash 前端弹「允许/拒绝」）、工具活动转录 + TodoWrite 任务面板、全链路排障日志。

---

## 🚀 快速开始

```bash
# 1. 装依赖
npm install

# 2.（可选）生成本地环境变量；仅用 Web 可跳过
cp .env.example .env          # Windows: copy .env.example .env

# 3a. 只用 Web（不接飞书）——无需 .env
node server.js                # 打开 http://127.0.0.1:3000

# 3b. 接飞书 bot——需要 .env 里的凭证
node --env-file=.env feishu.js
```

**前置条件**
- Node.js LTS（≥ 20，飞书入口用到 `--env-file`）
- 本机已登录 `claude` CLI（`claude --version` 有输出）；后端复用其**订阅登录**，无需 `ANTHROPIC_API_KEY`
- 服务固定绑定 `127.0.0.1`，⛔ 切勿绑到 `0.0.0.0` 或暴露公网

### 生产守护（推荐 PM2）

用 PM2 同时守护 web + 飞书两个入口，崩溃自动重启、支持开机自启，这也是**特性 1「关窗续跑」的落地方式**：

```bash
pm2 start ecosystem.config.cjs   # 启动（或双击 start.bat）
pm2 save && pm2 startup          # 开机自启
pm2 logs                         # 看日志
pm2 restart principal-web           # 改后端后重启 web
pm2 stop ecosystem.config.cjs    # 停止（或 stop.bat）
```

> 进程名：`principal-web`（端口 3000）、`principal-feishu`（飞书长连接）。用 PM2 前先停掉手动起的实例，避免端口/长连接冲突。

---

## 🖥️ 桌面版本（Tauri）

本项目已支持 **Tauri 桌面应用**，支持 Windows + macOS 双平台，无需打开浏览器，具备系统级能力：

| 功能 | 说明 |
|------|------|
| 📋 系统托盘 | 右键托盘快速访问、新建任务、设置、退出 |
| 🔔 原生通知 | 任务完成时弹出系统通知 |
| ⌨️ 全局快捷键 | `Ctrl+Shift+P`（Win）/ `Cmd+Shift+P`（Mac）从任意应用唤起窗口 |
| 🎯 智能最小化 | 点「×」隐藏到托盘，而非退出；从托盘恢复窗口 |
| 🚀 开机自启 | 可配置开机后自动启动（设置页面控制） |

### 下载安装

访问 [Releases](../../releases) 页面下载对应平台安装器。

### 本地开发（桌面模式）

```bash
npm run tauri:dev
```

首次编译约 5-10 分钟（下载并编译 Rust 依赖），后续约 1-2 分钟。

### 打包发布

```bash
# 本地打包
npm run tauri:build:win    # Windows .exe + .msi
npm run tauri:build:mac    # macOS .dmg（需在 macOS 上执行）

# 自动发布（推送 tag 触发 GitHub Actions CI）
git tag v1.0.0
git push origin v1.0.0
```

详细文档：
- [Tauri 开发环境设置](docs/TAURI_SETUP.md)
- [打包与分发指南](docs/DISTRIBUTION.md)

---

## 🔧 七大特性：如何配置

### 1. 关闭窗口后继续运行
- **原理**：任务在后端进程内执行并登记到 `active-runs.json`；前端只是订阅流。关窗后任务照跑，重开页面通过 `/api/run/pending` 自动接回。
- **配置**：无需额外配置。**强烈建议用 PM2 守护**（见上），否则手动 `node server.js` 的进程随终端关闭而退出。
- **相关**：看门狗（静默 15min / 硬超时 2h 兜底）+ 手动停止按钮。

### 2. 快速查询历史对话
- **原理**：会话按项目归档，侧栏可检索、点开恢复上下文继续。
- **配置**：默认按当前目录名推导项目 ID；如需固定，设 `.env` 的 `CLAUDE_PROJECT_ID`。
- **接口**：`GET /api/history`、`GET /api/history/:id`。详见 [docs/HISTORY_FEATURE.md](docs/HISTORY_FEATURE.md)。

### 3. 接入飞书
1. 到[飞书开放平台](https://open.feishu.cn/)建**自建应用**，拿 `App ID` / `App Secret`。
2. 两种配置方式（二选一，设置页优先）：
   - **`.env`**：填 `LARK_APP_ID` / `LARK_APP_SECRET`；
   - **Web 设置页 ⚙ → 飞书凭证 tab**：填入后写入 `settings.json`，飞书进程 `fs.watch` **热重载**，无需重启。
3. 首次留空 `OWNER_OPEN_IDS` 启动，给 bot 发条消息，终端会打印 `sender_open_id`，回填后重启即获得 owner 完整能力。
4. 启动飞书入口：`node --env-file=.env feishu.js`（或 PM2 的 `principal-feishu`）。
- **权限**：应用需开通消息、`im:resource`（收图）等 scope。分级授权：owner 完整能力 / 其他人受限只读。
- **相关 env**：`OWNER_OPEN_IDS`、`TRIAGE_OWNER_OPEN_ID`（待办 triage 专属白名单）、`TRIAGE_TRIGGER`、`REACTION_EMOJIS`。

### 4. 多 Claude 订阅账户
- **配置**：Web 设置页 **⚙ → Claude 账号 tab**，添加多个订阅 token（`sk-ant-oat01-…`，可在 Claude Code 里生成），每个可起别名。存入本地 `settings.json`（**永不入库**）。
- **选号策略**：`pickActive()` 实时计算「偏好最高的可用号」，无需手动切换；每个任务起跑时按当前活动号注入 token env。
- **覆盖范围**：web 任务、飞书任务、意图识别 / triage / 判档等所有内部调用**全部走轮换**（不再固定烧主账号）。

### 5. 自定义脚本（动作）
把本地脚本挂成「触发词 → 带参执行」的动作：
1. 把脚本放进 `scripts/`（或 `SCRIPTS_DIR` 指向的目录）。⚠️ 该目录默认已被 `.gitignore` 忽略，clone 后为空，需自行提供。
2. 配置 `action-configs.json`（同样已忽略）声明脚本的**触发词、参数槽位、权限**（也可在设置页维护）。
3. **安全**：脚本内不要硬编码密码/密钥，改从环境变量读取（写进本机 `.env`）：
   ```python
   import os
   ADMIN_PASSWORD = os.environ["ADMIN_PASSWORD"]
   ```
- **相关 env**：`SCRIPTS_DIR`（默认 `scripts`）、`PYTHON_BIN`（默认 `python`）。
- **文档**：[docs/action-config.md](docs/action-config.md) / [快速清单](docs/action-config-quick-checklist.md)。

### 6. 额度耗尽后等待重置续跑
- **原理**：SDK 报限流（`status:'rejected'` + `resetsAt`）时，当前任务被中性终结并落盘到 `pending-resume.json`；到 `resetsAt`(+30s) 自动新建任务、恢复原 session 发「继续」。跨进程重启也会在启动时重排定时器。
- **前端**：等待横幅 + 顶栏徽标，续跑开始自动接回流。
- **熔断**：连续续跑上限 `MAX_RESUME_ATTEMPTS=3`，超过标记 `abandoned` 不再复活，防死循环。
- **配置**：无需配置，自动生效。

### 7. 额度耗尽后新窗口自动用下一个账号
- **原理**：撞墙时若 token 池里**有其它可用号**，立即切号续跑（无需等重置）；只有全部撞墙才走特性 6 等重置。原账号重置后 `pickActive()` 自然切回。
- **配置**：只要在设置页（特性 4）配了 ≥2 个 token 即自动生效。

---

## ⚙️ 配置速查

### 环境变量（`.env`，唯一读取入口 `src/shared/config.js`）

| 变量 | 必填 | 默认 | 说明 |
|------|:---:|------|------|
| `LARK_APP_ID` | 飞书必填 | — | 飞书开放平台凭证 |
| `LARK_APP_SECRET` | 飞书必填 | — | 同上，**密钥勿泄露** |
| `OWNER_OPEN_IDS` | 建议 | 空 | owner open_id（完整能力），多个逗号分隔 |
| `TRIAGE_OWNER_OPEN_ID` | 可选 | 沿用 owner | 待办 triage 专属白名单（单人） |
| `PORT` | 可选 | `3000` | Web 端口（固定绑 `127.0.0.1`） |
| `SCRIPTS_DIR` | 可选 | `scripts` | 动作脚本目录 |
| `PYTHON_BIN` | 可选 | `python` | Python 解释器 |
| `CLASSIFY_MODEL` | 可选 | `claude-sonnet-4-6` | 意图/triage 兜底轻模型 |
| `FRONTEND_DIR` / `BACKEND_DIR` | 可选 | ⚠️原作者路径 | 需求分析只读的代码目录，**换机务必覆盖** |
| `TRIAGE_TRIGGER` | 可选 | 内置正则 | 待办触发词 |
| `REACTION_EMOJIS` | 可选 | 5 个内置 | 处理中随机表情 |
| `CLAUDE_PROJECT_ID` | 可选 | 按目录名 | 历史归属项目 ID |

### 运行时敏感文件（自动生成、已忽略，**无需手动创建**）

| 文件 | 内容 |
|------|------|
| `settings.json` | 飞书凭证 + **Anthropic token 池** + 文案 + UI 偏好（设置页写入） |
| `active-runs.json` / `pending-resume.json` | 关窗续跑 / 额度续跑状态 |
| `tasks.json` / `event-log.jsonl` | 会话 / 事件数据 |
| `action-configs.json` / `action-log.jsonl` | 动作配置 / 执行记录 |
| `saved-dirs.json` / `user-vars.json` / `bindings.json` / `feishu-status.json` | 常用目录 / 用户变量 / 绑定 / 飞书状态 |

> 完整配置、敏感文件来源、提交前安全自查见 **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**。

---

## 🏗️ 架构

```
浏览器 / 飞书 bot                本地 Node 服务(127.0.0.1)              Claude Agent SDK
    │  SSE / 长连接                       │                                   │
    │ ──────────── prompt ─────────────► │  dispatch → claude-exec → query()  │
    │ ◄──────── 流式 token / 工具活动 ──── │  复用本机订阅登录 + token 池轮换     │
```

- 入口：`server.js`（Web 薄启动器 → `src/entrypoints/web/server.js`）、`feishu.js`（→ `src/entrypoints/feishu/index.js`）
- 前端：`public/index.html` + `app.css` + `app.js`（无构建，静态托管）
- 核心：`src/integrations/claude.js`（SDK 封装）、`src/store/*`（运行时状态）、`src/features/token-rotation.js`（多账号轮换）
- 详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [PROJECT-STRUCTURE.md](PROJECT-STRUCTURE.md)。

---

## ⚠️ 用量提示

每次「运行」都真实调用一次 Claude：
- **走订阅**（本机已登录 Pro/Max，未设 API Key）：消耗订阅**用量额度**（与交互式 Claude Code 同池），不按 `cost_usd` 真实扣款——那是"等值 API 成本"参考值。
- **走 API**（设了 `ANTHROPIC_API_KEY`）：按量真实计费。

---

## 🤖 把本文档交给 Claude 自动部署

将本仓库连同这份 README 交给 Claude（Claude Code 或本执行台），可用如下指令让它自动完成部署：

> 请阅读 README.md 与 docs/CONFIGURATION.md，在当前机器上部署本项目：
> 1. 确认 Node.js ≥ 20 与 `claude` CLI 已登录（`node -v`、`claude --version`）；
> 2. 执行 `npm install`；
> 3. 若我要接飞书：`cp .env.example .env`，提示我填 `LARK_APP_ID`/`LARK_APP_SECRET`，其余用默认值；只用 Web 则跳过 `.env`；
> 4. 用 PM2 守护：`pm2 start ecosystem.config.cjs && pm2 save`，并告诉我 `pm2 startup` 的开机自启命令；
> 5. 打开 http://127.0.0.1:3000 验证 web 已启动，飞书入口检查 `pm2 logs principal-feishu` 无报错；
> 6. 提醒我到设置页 ⚙ 配置：飞书凭证（如未走 .env）、多个 Claude 订阅 token（特性 4/7 需 ≥2 个）；
> 7. 部署完成后输出：访问地址、进程名、下一步待我手动填的凭证清单。
> 注意：服务只能绑 `127.0.0.1`，绝不暴露公网；不要把 `.env`/`settings.json` 等敏感文件提交到 git。

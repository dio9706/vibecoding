# Claude 自动部署指南

> 面向 Claude Code / Claude Web 的完整部署指南。
> 把这份文档和项目仓库交给 Claude，它可以自动完成部署、配置、验证。

---

## 概览

**claude-agent-web-demo** 是一个**后端常驻、支持关窗续跑、多账号轮换、飞书接入、自定义脚本**的 Claude Code 执行台。
部署分为两部分：

1. **环境准备** ← 需要你手动检查的东西
2. **自动化部署** ← Claude 可以完成

---

## 第一步：环境准备（你来检查）

### ✓ 必要条件

- **Node.js** ≥ 20（含 `--env-file` 支持）
  ```bash
  node --version  # 应输出 v20.x.x 或更高
  npm --version
  ```

- **Claude CLI 已登录**（复用订阅额度）
  ```bash
  claude --version  # 应有输出且无 "not found" 错误
  ```

- **PM2 全局安装**（可选但**强烈推荐** —— 这是「关窗续跑」的必要条件）
  ```bash
  npm install -g pm2
  pm2 --version
  ```

- **项目根目录可写**（需要写入 `settings.json`, `tasks.json`, 日志等）

### 🔑 凭证准备（按需）

**仅用 Web 执行台**（不接飞书）：
- ✓ 无需额外凭证，只要 Claude CLI 已登录

**接飞书 Bot**：
1. 到[飞书开放平台](https://open.feishu.cn/)创建**自建应用**
2. 获取 `App ID` 和 `App Secret`
3. 应用权限需开通：
   - `im:message:create` （发消息）
   - `im:resource` （收图片）
   - 等其它消息相关权限
4. 启用事件订阅：配置 `WebSocket URL` 和事件（见后续部署步骤）

### 🔐 敏感信息说明

以下文件已被 `.gitignore` 忽略，**clone 后不存在是正常的**，部署时会自动生成：

| 文件 | 含敏感信息 | 何时生成 |
|------|:--:|---------|
| `.env` | 飞书凭证 | 手动复制 `.env.example` 后填写 |
| `settings.json` | Anthropic token 池 + 飞书凭证 | Web 设置页配置后自动写入 |
| `active-runs.json` | 当前执行的任务 ID | 任务起跑时自动生成 |
| `pending-resume.json` | 待续跑的任务信息 | 额度耗尽时自动生成 |
| `logs/` | 应用日志（含执行细节） | 启动时自动创建 |
| `scripts/` | 你的自定义脚本（可能含密钥） | 手动放入，该目录已忽略 |

**提交前务必检查**（见 [docs/CONFIGURATION.md](CONFIGURATION.md) 第五节）。

---

## 第二步：指示 Claude 自动部署

将以下 **7 步部署指令**复制粘贴给 Claude（Claude Code 或本执行台都可）：

```
我需要在当前机器部署 claude-agent-web-demo 项目。
请按照 README.md 与 docs/ 目录的文档完成以下步骤：

【第 1 步】环境验证
□ 执行 node --version，确认 ≥ 20
□ 执行 claude --version，确认 CLI 已登录
□ 执行 npm list -g pm2，确认 PM2 全局已装（若无，提示用户 npm install -g pm2）
□ 执行 ls -la .env 检查 .env 是否存在；如不存在继续
□ 若我说"接飞书"，检查已准备好飞书 App ID/Secret（我会在后续步骤提供）

【第 2 步】依赖安装
□ 执行 npm install
□ 无报错则继续；有报错停止并报告详情

【第 3 步】配置文件生成
□ 检查 .env.example 是否存在
□ 若我说"只用 Web"（默认）：无需生成 .env，继续
□ 若我说"接飞书"：
  ├─ 执行 cp .env.example .env（Windows: copy .env.example .env）
  ├─ 打开 .env 文件
  ├─ 我会给你飞书 App ID/Secret，填入 LARK_APP_ID / LARK_APP_SECRET
  ├─ 其余行保持默认（或按我的额外要求填）
  ├─ 保存 .env 并停止编辑
  └─ 继续

【第 4 步】PM2 守护启动
□ 执行 pm2 start ecosystem.config.cjs
□ 等待输出稳定，应显示：
  ├─ claude-web  (online|starting) 
  ├─ claude-feishu (online|starting)，或仅 claude-web（若只用 Web）
□ 执行 pm2 list 验证两个（或一个）进程在线
□ 执行 pm2 save（保存进程列表）
□ 执行 pm2 startup（生成系统开机自启脚本，按提示复制命令到终端）
□ 输出给我："PM2 已启动，进程状态如上，开机自启已配置"

【第 5 步】Web 服务验证
□ 等待 3 秒
□ 执行 curl http://127.0.0.1:3000/ 或用浏览器打开 http://127.0.0.1:3000
□ 若看到 HTML 页面（或无 "Connection refused"），说明 Web 正常
□ 若 claude-feishu 进程在线，检查 pm2 logs claude-feishu，应无报错（初次可能等待几秒）
□ 输出给我："Web 服务正常运行，地址 http://127.0.0.1:3000"

【第 6 步】Web 设置页配置
□ 打开浏览器访问 http://127.0.0.1:3000
□ 点击右下角 ⚙ 设置图标
□ 按以下顺序完成配置：
  
  【选项 A】若我说"只用 Web"（或跳过飞书）：
  │ └─ 跳过飞书凭证 tab，直接做 B
  │
  【选项 B】若要多账号轮换（特性④⑦）：
  │ └─ 进入 Claude 账号 tab
  │ └─ 点「添加」
  │ └─ 我会给你一个或多个订阅 token（sk-ant-oat01-xxx），逐个贴入
  │ └─ 每个可起别名（如"主账号" / "备用号"）
  │ └─ 点「保存」，应看到 token 列表刷新
  │ └─ 关闭设置页，Web 会保存到本地 settings.json
  │
  【选项 C】若我说"接飞书"且未走 .env 路线：
  └─ 进入飞书凭证 tab
    └─ 填入 App ID / App Secret
    └─ 点「保存」
    └─ 飞书进程会自动热重载（watch fs 变化），无需重启
    └─ 检查 pm2 logs claude-feishu，应无新错误

□ 所有配置完成后，输出给我清单和接下来的验证步骤

【第 7 步】最终验证
□ 执行 pm2 status，输出完整表格给我
□ 执行 pm2 logs --lines 20，抓取最后 20 行日志，查看是否有 ERROR 或 FATAL
□ 若有 error，读完整日志帮我分析（执行 pm2 logs）
□ 若无 error：
  ├─ Web 验证：curl http://127.0.0.1:3000（应返回 HTML）
  ├─ 若接飞书：点开飞书 bot 会话，给它发一条消息"测试"，看是否有回复或日志反应
  └─ 输出给我："部署完成，所有服务正常"

【汇总输出】
最后，给我一份汇总清单：
- ✓ 环境检查结果（Node.js 版本、CLI 登录状态、PM2 状态）
- ✓ 启动的进程（claude-web / claude-feishu）和端口
- ✓ Web 服务地址：http://127.0.0.1:3000
- ✓ 已配置的特性（多账号数量、飞书接入是否启用、脚本目录位置等）
- ✓ 下一步待你手动做的（如无新 token 导入 / 测试第一个任务等）
- ✓ 故障排查快速链接（见本仓库 docs/ARCHITECTURE.md 故障排查表）

---

注意：
1. 如果中途报错，我会停止并输出完整错误信息、日志路径、建议修复方案。
2. 不要把 .env 或 settings.json 提交到 git（已 .gitignore）。
3. 后续如需改动（改脚本、加 token、改飞书凭证），都可在 Web 设置页操作，无需重启。
4. 如有使用问题（关窗续跑、token 轮换、脚本执行等），参考 README.md 的「七大特性」和 docs/ARCHITECTURE.md 的「故障排查」。
```

---

## 部署后的常见操作

### 启动 / 停止 / 重启

```bash
# 启动所有进程
pm2 start ecosystem.config.cjs

# 看进程状态与日志
pm2 list
pm2 logs              # 实时日志

# 重启 web（改了源码后）
pm2 restart claude-web

# 重启飞书（改了凭证后）
pm2 restart claude-feishu

# 停止所有进程
pm2 stop ecosystem.config.cjs
```

### 查看日志

```bash
# 实时日志
pm2 logs

# 某个进程的日志
pm2 logs claude-web
pm2 logs claude-feishu

# 应用日志（调试用）
tail -f logs/app-$(date +%Y-%m-%d).log

# 事件日志
tail -f event-log.jsonl
```

### Web 设置页操作

1. 浏览器打开 http://127.0.0.1:3000
2. 点击右下角 ⚙ 设置
3. 修改任何配置（token、飞书凭证、文案等）
4. 点「保存」
   - token / 飞书凭证更改 → 飞书进程 fs.watch 自动热重载，无需重启
   - UI 偏好（模型/强度/权限模式）→  立即生效，仅影响后续任务

### 添加自定义脚本（特性⑤）

1. 脚本放入 `scripts/` 或 `SCRIPTS_DIR` 目录
2. 编写 `action-configs.json`：
   ```json
   [{
     "id": "my_action",
     "trigger": "关键词1|关键词2",
     "slots": [{"name": "param1", "type": "string", "required": true}],
     "script": "my_script.py",
     "action": "python",
     "enabled": true
   }]
   ```
3. 对话中提到关键词，任务面板会弹出「执行动作」卡片
4. 输入参数后执行

---

## 故障排查快速链接

部署后遇到问题？按顺序检查：

1. **Web 打不开**（http://127.0.0.1:3000 无响应）
   - 检查 `pm2 list`，`claude-web` 是否 online
   - 检查端口占用：`lsof -i :3000` 或 Windows `netstat -ano | findstr :3000`
   - 看日志：`pm2 logs claude-web`

2. **任务起不了 / 报错**
   - 看应用日志：`tail -f logs/app-$(date +%Y-%m-%d).log`
   - 检查 Claude CLI 登录：`claude --version`
   - 检查额度：访问 claude.ai 看余额

3. **飞书 bot 无响应**
   - 检查 `pm2 list`，`claude-feishu` 是否 online
   - 检查飞书凭证：`cat settings.json | grep lark`（敏感信息，仅本机看）
   - 看日志：`pm2 logs claude-feishu`
   - 确认应用权限已开通（见"凭证准备"一节）

4. **多账号轮换不工作**
   - 检查 token 池：Web 设置页 Claude 账号 tab，确认 ≥2 个 token
   - 检查 token 状态：各 token 的 status 是否正常（healthy / warning / rejected）
   - 如需手动测试，改 `settings.json` 的第一个 token 的 `status` 为 `"rejected"`，然后触发新任务

5. **关窗后任务消失**
   - 检查 PM2：`pm2 list`，`claude-web` 是否还在线
   - 检查 `active-runs.json` 是否存在且非空
   - 重开页面后 GET `/api/run/pending` 是否返回任务列表

详细排查方案见 **[docs/ARCHITECTURE.md](ARCHITECTURE.md)** 末尾的「故障排查速查表」。

---

## 二次部署 / 更新代码

如果后续需要更新项目代码（拉最新版本）：

```bash
# 1. 停止进程（防止文件冲突）
pm2 stop ecosystem.config.cjs

# 2. 更新代码
git pull

# 3. 重新安装依赖（如有 package.json 变化）
npm install

# 4. 启动进程
pm2 start ecosystem.config.cjs

# 5. 监控日志
pm2 logs
```

**不会丢失的**：
- `settings.json`（已 .gitignore）
- `active-runs.json` / `pending-resume.json`（运行时状态）
- `scripts/`（自定义脚本）
- `.env`（已 .gitignore）

---

## 小结

1. **Claude 可以自动化完成**：npm install → pm2 start → Web 验证 → 设置页配置
2. **你需要手动提供**：飞书凭证（可选）、Anthropic token（可选，但多账号轮换需要）
3. **部署后立即可用**：Web 执行台 http://127.0.0.1:3000，后端进程 PM2 守护
4. **后续操作无需命令行**：所有配置都可在 Web 设置页完成，改完自动生效（飞书凭证支持热重载）
5. **故障排查**：日志都在 `logs/` 和 `pm2 logs`，有问题先看日志

祝部署顺利！🚀

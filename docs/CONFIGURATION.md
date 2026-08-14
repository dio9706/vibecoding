# 配置与敏感信息说明

本项目把**凭证 / 个人信息 / 本机运行时状态**全部通过 `.gitignore` 排除在版本库之外。
本文说明：clone 后**需要配置哪些内容**、每个敏感文件**从哪来 / 怎么填**，以及提交前的**安全自查**。

---

## 一、快速开始（新机器 clone 后）

```bash
# 1. 装依赖
npm install

# 2. 生成本地环境变量
cp .env.example .env          # Windows: copy .env.example .env
#   编辑 .env，至少填入飞书 LARK_APP_ID / LARK_APP_SECRET

# 3a. 只用 Web（不接飞书）——无需 .env
node server.js                # 打开 http://127.0.0.1:3000

# 3b. 接飞书 bot——需要 .env 里的凭证
node --env-file=.env feishu.js
```

> Web 入口 (`server.js`) 本机自用，无需任何凭证即可跑；
> 飞书入口 (`feishu.js`) 必须有 `LARK_APP_ID` / `LARK_APP_SECRET`。

---

## 二、需要配置的环境变量（`.env`）

复制 `.env.example` 为 `.env` 后按下表填写。代码里所有 env 的唯一读取入口是
`src/shared/config.js`。

| 变量 | 必填 | 默认值 | 说明 / 从哪来 |
|------|:---:|--------|--------------|
| `LARK_APP_ID` | 飞书必填 | — | 飞书开放平台「凭证与基础信息」页 |
| `LARK_APP_SECRET` | 飞书必填 | — | 同上，**密钥，切勿泄露** |
| `OWNER_OPEN_IDS` | 建议 | 空 | 你的 open_id（完整能力）。首次留空启动，给 bot 发消息，终端打印 `sender_open_id`，复制回填再重启。多个用逗号分隔 |
| `TRIAGE_OWNER_OPEN_ID` | 可选 | 空→沿用 owner | 「待处理/待办」流程专属白名单（单人）。填这里可用 guest 身份触发，避免被 owner 全量接管 |
| `TRUSTED_OPEN_IDS` | 可选 | 空 | 可信提交人白名单：这些人提交的需求/故障**跳过 AI 评审**直接进自动开发队列（独立分支，合并仍需管理员确认）。多个用逗号分隔。机器人设置页可按机器人覆盖（可信提交人 open_id 列表），设置页非空时优先，留空回退本项。**`OWNER_OPEN_IDS` 里的人无需再填这里**——owner 用「提交需求：/提交故障：」强前缀提交时自动视为可信直通（其余消息仍走完整 Claude） |
| `PORT` | 可选 | `3000` | Web 端口；服务固定绑 `127.0.0.1` |
| `SCRIPTS_DIR` | 可选 | `scripts` | 动作脚本目录（该目录已被忽略，见第四节） |
| `PYTHON_BIN` | 可选 | `python` | Python 解释器路径 |
| `CLASSIFY_MODEL` | 可选 | `claude-sonnet-4-6` | 意图识别 / triage 兜底轻模型 |
| `FRONTEND_DIR` | 可选 | ⚠️ 原作者本机路径 | 需求分析只读的前端代码目录，**换机务必覆盖** |
| `BACKEND_DIR` | 可选 | ⚠️ 原作者本机路径 | 需求分析只读的后端代码目录，**换机务必覆盖** |
| `TRIAGE_TRIGGER` | 可选 | 内置正则 | 待处理触发词正则覆盖 |
| `REACTION_EMOJIS` | 可选 | 5 个内置表情 | 处理中随机表情 |
| `CLAUDE_PROJECT_ID` | 可选 | 按目录名推导 | 历史记录归属项目 ID |

---

## 三、运行时敏感文件（自动生成，已忽略，**无需手动创建**）

以下文件由程序运行时生成，含真实凭证 / PII / 本机状态，已在 `.gitignore` 中排除。
clone 后**不存在是正常的**，跑起来会自动生成。

| 文件 | 内容 | 怎么产生 |
|------|------|---------|
| `settings.json` | 飞书 appId/appSecret + **Anthropic OAuth token 池** + 文案 + UI 偏好 | 通过 Web 设置页配置后写入；飞书凭证也可由 `.env` 兜底 |
| `bindings.json` | open_id ↔ 手机号 绑定 | 运行时绑定 |
| `cleanup-log.json` | 清理动作记录（含手机号 / open_id） | 动作执行时追加 |
| `user-vars.json` | 用户变量缓存（手机号 / 邮箱等 PII） | 交互中缓存 |
| `feishu-status.json` | 飞书长连接状态 | 飞书入口运行时 |
| `saved-dirs.json` | 常用工作目录历史（绝对路径） | Web 端使用时 |
| `tasks.json` / `event-log.json(l)` / `active-runs.json` / `pending-resume.json` / `learned-keywords.json` / `action-log.jsonl` | 会话 / 事件 / 任务运行时数据 | 运行时 |

> **Anthropic token** 在 Web 设置页添加（`sk-ant-oat01-…` 订阅 token），仅存于本地
> `settings.json`，永不入库。

---

## 四、动作脚本 `scripts/`（已整目录忽略）

`scripts/` 存放动作执行脚本（如清理 onboarding 数据的 `reset_onboarding.py`），
**整个目录已被 `.gitignore` 忽略**，原因：脚本可能硬编码后台管理员账密、内网域名等。

因此 clone 后 `scripts/` 为空，动作配置功能需要你**自行提供脚本**：

1. 在 `scripts/`（或 `SCRIPTS_DIR` 指向的目录）放入你的脚本；
2. 配置 `action-configs.json`（同样已忽略）声明脚本的触发词、参数、权限；
3. **强烈建议**：脚本内不要硬编码密码/密钥，改从环境变量读取，例如：

   ```python
   import os
   ADMIN_USERNAME = os.environ["ADMIN_USERNAME"]
   ADMIN_PASSWORD = os.environ["ADMIN_PASSWORD"]
   BASE_URL       = os.environ["BACKEND_BASE_URL"]
   ```

   对应值写进本机 `.env`（已忽略），既保功能又不泄露。

---

## 五、提交前安全自查

提交前跑一遍，确认没有敏感文件 / 明文密钥混入：

```bash
# 1. 确认关键敏感文件确实被忽略（应全部输出匹配行）
git check-ignore -v .env settings.json bindings.json scripts/ .serena/

# 2. 扫描「将要提交的文件」里是否残留明文密钥（应无输出）
git grep -nI -e "sk-ant-" -e "app_?secret" -e "password\s*=" \
  $(git ls-files) 2>/dev/null

# 3. 查看本次实际会提交的文件清单
git status --short
```

若第 2 步命中真实密钥，**先移除再提交**；已误提交进历史的，需用 `git filter-repo`
或 BFG 清理历史，并**立即轮换泄露的凭证**。

---

## 六、`.gitignore` 覆盖速查

| 类别 | 忽略项 |
|------|--------|
| 依赖 | `node_modules/` |
| 环境变量 | `.env`、`.env.*`（保留 `.env.example`） |
| 敏感状态 | `settings.json`、`bindings.json`、`cleanup-log.json`、`user-vars.json`、`feishu-status.json`、`saved-dirs.json` |
| 运行时数据 | `tasks.json`、`event-log.json(l)`、`active-runs.json`、`pending-resume.json`、`learned-keywords.json` |
| 动作配置/脚本 | `action-configs.json`、`action-log.jsonl`、`scripts/` |
| 日志/临时 | `logs/`、`*.log`、`*.json.lock`、`*.tmp` |
| 上传 | `.uploads/` |
| 工具产物 | `.serena/`、`.spec-workflow/` |
| 系统/编辑器 | `.DS_Store`、`Thumbs.db`、`.vscode/`、`.idea/`、`*.swp` |

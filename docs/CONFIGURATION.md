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
node feishu.js                # .env 自动加载，不必再写 --env-file
```

> Web 入口 (`server.js`) 本机自用，无需任何凭证即可跑；
> 飞书入口 (`feishu.js`) 必须有 `LARK_APP_ID` / `LARK_APP_SECRET`。
>
> 三个入口（`server.js` / `feishu.js` / `src/entrypoints/console/index.js`）都会自动加载 `.env`，
> `--env-file=.env` 仍然可用且优先级更高，但不再是必须的 —— 见下节「`.env` 从哪里被读取」。

---

## 二、需要配置的环境变量（`.env`）

复制 `.env.example` 为 `.env` 后按下表填写。代码里所有 env 的唯一读取入口是
`src/shared/config.js`。

### `.env` 从哪里被读取

加载由 `src/shared/load-env.js` 统一负责，按下表**取第一个存在的文件**，不叠加：

| 顺序 | 位置 | 适用形态 |
|:---:|------|---------|
| 1 | `$APP_DATA_DIR/.env`，Windows 桌面版即 `%APPDATA%\com.principal.desktop\.env` | 打包版（安装目录只读，配置必须放可写目录，改配置无需重装） |
| 2 | 仓库根 `.env` | 开发态 |

两条重要性质：

- **不覆盖已有变量。** 底层是 `process.loadEnvFile`，它不改写进程里已存在的键。所以显式
  `--env-file`、Tauri 注入的 `APP_DATA_DIR`/`PORT`、CI 里的外部变量一律优先，文件只做兜底。
- **`.env` 不会被打进安装包**（`scripts/prepare-sidecar.mjs` 的拷贝清单里没有它），
  生产库密码不随包分发。因此**桌面版首次使用需手工放一份 `.env` 到上表位置 1**。

> 为什么要有这套兜底（2026-08-26 事故）：桌面版由 Tauri 拉起，只注入 `APP_DATA_DIR` + `PORT`；
> 飞书凭证另有来源（基础设置里的机器人配置，存在 `APP_DATA_DIR`），于是**机器人一切正常，
> 只有依赖纯环境变量的埋点统计在运行期报「缺少 `TRACKING_DB_*`」**。同一个坑在开发态也有：
> `npm start` 就是裸 `node server.js`，漏掉 `--env-file` 会静默丢掉全部配置。
> 两种失效都不在启动时报错，而是等功能被用到才炸 —— 排查成本极高。

| 变量 | 必填 | 默认值 | 说明 / 从哪来 |
|------|:---:|--------|--------------|
| `LARK_APP_ID` | 飞书必填 | — | 飞书开放平台「凭证与基础信息」页 |
| `LARK_APP_SECRET` | 飞书必填 | — | 同上，**密钥，切勿泄露** |
| `OWNER_OPEN_IDS` | 建议 | 空 | 你的 open_id（完整能力）。首次留空启动，给 bot 发消息，终端打印 `sender_open_id`，复制回填再重启。多个用逗号分隔 |
| `TRIAGE_OWNER_OPEN_ID` | 可选 | 空→沿用 owner | 「待处理/待办」流程专属白名单（单人）。填这里可用 guest 身份触发，避免被 owner 全量接管 |
| ~~`TRUSTED_OPEN_IDS`~~ | **已废弃** | — | ⚠️ **当前版本不生效**：没有任何代码读取它，填了不会有效果、也不会有日志。可信提交人改由 web 设置页「我的飞书身份 → 我的飞书 open_id」单人指定，详见下方说明 |
| `PORT` | 可选 | `3000` | Web 端口；服务固定绑 `127.0.0.1` |
| `SCRIPTS_DIR` | 可选 | `scripts` | 动作脚本目录（该目录已被忽略，见第四节） |
| `PYTHON_BIN` | 可选 | `python` | Python 解释器路径 |
| `CLASSIFY_MODEL` | 可选 | `claude-sonnet-4-6` | 意图识别 / triage 兜底轻模型 |
| `FRONTEND_DIR` | 可选 | ⚠️ 原作者本机路径 | 需求分析只读的前端代码目录，**换机务必覆盖** |
| `BACKEND_DIR` | 可选 | ⚠️ 原作者本机路径 | 需求分析只读的后端代码目录，**换机务必覆盖** |
| `TRIAGE_TRIGGER` | 可选 | 内置正则 | 待处理触发词正则覆盖 |
| `REACTION_EMOJIS` | 可选 | 5 个内置表情 | 处理中随机表情 |
| `CLAUDE_PROJECT_ID` | 可选 | 按目录名推导 | 历史记录归属项目 ID |
| `TRACKING_DB_HOST` / `TRACKING_DB_PORT` / `TRACKING_DB_NAME` / `TRACKING_DB_USER` / `TRACKING_DB_PASSWORD` | 埋点统计必填 | 见 `.env.example` | 生产埋点库连接（只读账号）。**密码只走环境变量，不得写进源码** |
| `COMPASS_AGENT_DIR` | 可选 | 空 | compass-agent 仓库路径，仅埋点索引同步脚本 `node scripts/sync-event-dict.mjs` 使用 |

### 关于「可信提交人」

可信提交人的需求/故障**跳过 AI 评审**直接进自动开发队列（独立分支，合并仍需管理员确认）。

**唯一来源**：web 管理台「设置 → 我的飞书身份 → 我的飞书 open_id」，**只支持一个人**；另外 `OWNER_OPEN_IDS`
里的 owner 用「提交需求：/ 提交故障：」强前缀提交时同样视为可信直通（其余消息仍走完整 Claude）。

环境变量 `TRUSTED_OPEN_IDS` 与机器人设置页的 per-bot 可信名单**都已废弃并从代码中移除**，
现在没有任何代码读取它们。之所以特意写明：此前文档承诺「设置页优先、留空回退 env」，
而实际两条路都断了 —— 一个「看起来在工作、实际没有」的开关，比没有这个开关更贵。

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

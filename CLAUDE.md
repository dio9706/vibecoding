# Principal · CLAUDE.md

## 项目定位

Principal 把 headless Claude Code（`@anthropic-ai/claude-agent-sdk`）从终端搬进**网页 / 飞书 bot / 桌面客户端**：后端进程常驻执行、状态落盘，你从「敲键盘的人」变成「派活、看结果、审计过程的人」。复用本机 `claude` CLI 的订阅登录，并补上关窗续跑、历史检索、飞书接入、多账号轮换、额度自愈、自定义脚本等工程能力；模型侧同时支持 Claude Agent SDK 与 OpenAI 兼容 provider。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm start`（= `node server.js`） | 启动后端：web HTTP+SSE 于 `127.0.0.1:3000`，并后台连飞书长连接 |
| `node --env-file=.env feishu.js` | 只启动飞书 bot（需 `.env` 凭证） |
| `npm run chat:console` | 控制台跑通 dispatch 全链，本地调试意图/feature（不接飞书） |
| `npm test` | 单元测试（`node --test`，跑 `src/**`、`public/**` 的 `*.test.js`） |
| `npm run test:e2e` | 端到端（`scripts/run-e2e.mjs` 驱动 `tests/e2e-*.mjs`） |
| `npm run sync:vendor` / `check:vendor` | 同步 / 校验 `public/vendor/` 三方库 |
| `npm run tauri:dev` / `tauri:build[:win|:mac]` | Tauri 桌面开发 / 构建 |
| `npm run build:release:win` / `:mac` | 打发行包（`scripts/build-*.sh`） |
| `pm2 start ecosystem.config.cjs` | 生产守护（`principal-web` + `principal-feishu`，崩溃自重启） |

**前置**：Node LTS（≥20）；本机已登录 `claude` CLI（复用其订阅登录，无需 `ANTHROPIC_API_KEY`）；服务固定绑 `127.0.0.1`，⛔ 勿暴露公网。

## 模块路由表

改动前先定位目录；权威架构图、数据流与七大特性落点见 `docs/ARCHITECTURE.md`。

| 目录 | 职责 | 要改 X 去这里 |
|---|---|---|
| `src/entrypoints/web/` | web 服务：HTTP+SSE+管理 API | 路由表在 `server.js`，handler 拆到 `routes-*.js`，执行编排在 `run-claude.js` / `run-openai.js` |
| `src/entrypoints/feishu/` | 飞书入口（组装：收信→Context→dispatch） | 飞书消息流程 |
| `src/entrypoints/console/` | 控制台入口 | 本地调试 dispatch 全链 |
| `src/channels/` | 渠道适配：收信归一化 / 回发 | `feishu.js` / `console.js`，契约见 `registry.js` |
| `src/app/` | 分发与意图 | `dispatch.js`（feature 路由）、`intent.js` / `intent-keywords.js`（意图识别） |
| `src/features/` | 内核 feature + 不走 dispatch 的功能 | `claude-exec`（owner 全接）、`memory-bank`、`project-checkup`、`project-optimize` |
| `src/plugins/` | 业务插件（`settings.plugins` 可启停） | **加对话功能来这**：`team-tools` / `action-runner` / `feishu-relay` / `tracking-stats`；清单见 `index.js` |
| `src/capabilities/` | 通用能力（无业务语义，可复用） | `token-rotation`（多账号轮换）、`llm-classify`、`llm-readonly-agent` |
| `src/providers/` | 模型 provider 注册表 | `claude-agent`（Agent SDK）、`openai-compat`；新 provider 在 `index.js` 注册 |
| `src/integrations/` | 外部系统适配 | `claude.js`（SDK 封装）、`lark.js`、`shell.js`、`notify.js` |
| `src/store/` | 持久化层（文件锁 + 原子写） | 本项目所有状态读写走这里（`runs` / `history` / `settings` / `requirements` …） |
| `src/shared/` | 共享基础设施 | `config.js`（env）、`logger.js`、`messages.js`、`load-env.js` |
| `public/` | 前端 | `app.js` + `js/`（功能模块）+ `css/` + `vendor/`（`sync:vendor` 生成，勿手改） |
| `src-tauri/` | Tauri 桌面壳 | sidecar 复用根 `server.js`；配置 `tauri.conf.json` |
| `scripts/` | 动作脚本 + 构建/同步/e2e | 自定义动作脚本、`prepare-sidecar.mjs`、`run-e2e.mjs` |
| `docs/` | 文档 | 架构与关键约定 `ARCHITECTURE.md`；卡片/动作/构建等专题 |

## 关键约定（判据与验证命令见 `docs/ARCHITECTURE.md`「关键约定」）

- **分层单向依赖**：`entrypoints → app → features/plugins → capabilities → integrations/store → shared`，下层不得 import 上层；插件之间不互相 import（协作走 `store` 或事件）。
- **加功能 = 加插件**：建 `src/plugins/<id>/index.js`（default 导出 `{ id, features:[{order, feature}] }`）+ 在 `src/plugins/index.js` 的 `PLUGIN_MANIFEST` 登记；不改 dispatch / 入口 / store。新意图在 `src/app/intent.js` 加类。
- **持久化经 store**：本项目状态一律走 `src/store/`（跨进程文件锁 + tmp+rename 原子写）；环境变量只经 `src/shared/config.js`。
- **前端安全渲染**：后端/模型文本禁裸 `innerHTML`，走 `public/js/util.js` 的 `renderMarkdown`（内含消毒）。
- **vendor 不手改**：`public/vendor/` 由 `npm run sync:vendor` 同步，构建前 `--check` 拦漂移。

## 协作约定

- 不自动 `git` 提交，改动留工作区，提交时机由维护者掌控；大改动先出 spec / 实现计划再动手。
- 文档与注释用中文，注释解释「为什么」而非复述代码。

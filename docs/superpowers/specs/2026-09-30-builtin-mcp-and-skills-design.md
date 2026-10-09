# 内置 MCP 与内置 Skills（Superpowers）· 设计

- 日期：2026-09-30
- 状态：已实现（2026-09-30：内置 MCP context7/Figma 双形态、开关与 API/UI、双路径接线；Superpowers 安装时拉取与 Claude 路径装载）；chat 工具弹层合并与 per-skill 开关已收尾（2026-09-30）；openai Skill 机制为评估稿（`2026-09-30-openai-skill-mechanism-design.md`，待拍板）
- 关联：`docs/superpowers/specs/2026-07-23-provider-abstraction-phase3d-mcp-tools-design.md`（MCP 接入现状）、`2026-09-22-colleague-agent-design.md`（进程内 MCP 先例）、`2026-09-02-project-map-design.md`（团队已有 skills 心智）
- 外部参考：Context7 MCP（`@upstash/context7-mcp`）、Figma Dev Mode MCP / Framelink `figma-developer-mcp`、obra/superpowers（MIT）

## 1. 背景与目标

**MCP 现状**：`settings.mcpServers` 是用户手动维护的 stdio 列表，**只有 openai 路径消费**（`run-openai.js` 经 `providers/mcp.js` 连接）。Claude 路径的 MCP 完全依赖用户自己给 Claude Code 配（`.mcp.json` / `~/.claude.json`），产品内既无感知也无开关。

**Skills 现状**：Claude 路径由 SDK 在 cwd 自动发现 `.claude/skills/`（团队项目里可能有，但产品不内置）；`project-optimize` 会把 rules 降级为项目内 skills，说明团队已有 skill 心智。openai 路径没有任何 skill 机制。

**诉求**：产品内置常用 MCP（context7、figma 等）与 superpowers skills，**都支持开关**，开箱可用、可随时关。

**目标**：

1. 内置 MCP 注册表（首期 context7 + figma），带逐项开关；Claude 路径与 openai 路径分别接线，能力差异如实标注；
2. 内置 Superpowers skill 包（vendor 固定版本，MIT 署名），经 Claude Agent SDK 的 `plugins: [{ type:'local', path }]` 装载，带总开关；
3. 开关落 `settings`（`builtinMcp` / `builtinSkills`），设置页可见可改，导入导出透传；
4. 打包形态（Tauri sidecar resources / PM2）能找到内置资源，路径解析走统一 helper。

**非目标**：

- 不做 MCP HTTP/SSE 传输（openai 路径的 `@ai-sdk/mcp@2.0.16` 只带 stdio transport；Figma 官方 Dev Mode 的 http 端点只对 Claude 路径可达）；
- 不做第三方 MCP 市场；用户自定义 MCP 仍走现有 `/api/mcp-servers` CRUD；
- 不做 openai 路径的 skill 机制（Phase 3 另评：Skill 工具 + 按需加载，对齐 opencode 的做法）；
- 首期不做 per-skill 粒度开关（总开关；数据结构留扩展位）。

## 2. 拍板记录（2026-09-30 已确认）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | Figma 接入形态 | 两个都内置：本地 Dev Mode（http，仅 Claude 路径）+ Framelink（stdio + `FIGMA_API_KEY`，双路径），UI 标注可用条件 |
| 2 | 用户自定义 `mcpServers` 是否注入 Claude 路径 | 只注入内置（用户 MCP 全路径统一另立子项再评估） |
| 3 | Superpowers 内置范围 | 核心技能集（brainstorming / writing-plans / executing-plans / TDD / systematic-debugging / verification-before-completion 等，约 8~12 个 SKILL.md） |
| 4 | 更新策略 | **安装时实时拉取**（上游最新；拉取脚本 + 失败 fail-open；`SUPERPOWERS_REF` 可钉版本） |
| 5 | 开关粒度 | 内置 MCP 逐项开关 + Skills 总开关（per-skill 留 Phase 3） |
| 6 | 内置 MCP 默认值 | context7 默认开；figma 默认关 |
| 7 | 执行顺序 | 先实现验证门（已拍板），再按本 spec 开工 |

## 3. 架构

### 3.1 内置 MCP

**注册表** `src/capabilities/builtin-mcp.js`（无业务语义、可复用 → capabilities 层）：

```js
export const BUILTIN_MCP = [
  {
    id: 'context7',
    label: 'Context7（最新文档）',
    desc: '按库名实时检索最新官方文档与用法示例',
    transport: 'stdio',
    resolve: (cfg) => ({
      command: npxCmd(),                       // win32 → cmd.exe /c npx …（见下）
      args: ['-y', '@upstash/context7-mcp'],
      env: cfg.apiKey ? { CONTEXT7_API_KEY: cfg.apiKey } : {},
    }),
    needsKey: { env: 'CONTEXT7_API_KEY', optional: true },  // 不填也能用（限速）
    autoAllow: ['resolve-library-id', 'get-library-docs'],   // 只读工具，openai 路径免审批
    paths: ['claude', 'openai'],
  },
  {
    id: 'figma-devmode',
    label: 'Figma（本地 Dev Mode）',
    desc: '读取 Figma 桌面端 Dev Mode 输出的设计上下文（需 Figma 桌面运行且开启 MCP）',
    transport: 'http',                         // 仅 Claude 路径
    url: 'http://127.0.0.1:3845/mcp',
    paths: ['claude'],
    probe: 'http://127.0.0.1:3845/mcp',        // UI 状态探测
  },
  {
    id: 'figma-framelink',
    label: 'Figma（Framelink API）',
    desc: '经 Figma REST API 读设计（需 FIGMA_API_KEY）',
    transport: 'stdio',
    resolve: (cfg) => ({
      command: npxCmd(),
      args: ['-y', 'figma-developer-mcp', '--stdio'],
      env: cfg.apiKey ? { FIGMA_API_KEY: cfg.apiKey } : {},
    }),
    needsKey: { env: 'FIGMA_API_KEY', optional: false },
    paths: ['claude', 'openai'],
  },
];

/** 按开关 + 目标路径过滤，产出各消费方要的形态 */
export function resolveBuiltinMcp({ settings, provider, platform }) → [{ id, config, autoAllow }]
```

- **npx 平台解析**：openai 路径的 stdio transport 不走 shell，Windows 上 `npx` 是 `npx.cmd`——统一用 `cmd.exe /c npx …`（win32）/ `npx`（其他平台）。Claude 路径也走同一形态（SDK 的 stdio 与 CLI 行为一致，避免两套）。
- **密钥**：仅 `FIGMA_API_KEY` 这类必需项需要落到 settings（`builtinMcp.figma-framelink.apiKey`，走现有掩码/不透出机制）；context7 的 key 可选。
- **注入**：
  - **Claude 路径**：`integrations/claude.js#runClaude` 新增 `mcpServers` 透传 → `startClaudeRun` 构造 `mcpServers`（启用的内置，`paths` 含 claude 的）。工具调用走现有 `canUseTool`（默认询问；只读白名单 Phase 2 再评估是否加入）。
  - **openai 路径**：`run-openai.js` 把 `resolveBuiltinMcp(...)` 结果与 `getMcpServers()` 合并（同名：用户自定义优先，沿用 MCP 覆盖本地工具的现有语义）。`autoAllow` 直接进 `buildAutoAllowSet` 的同类机制（每个内置 server 自带只读工具白名单）。
  - 连接失败隔离沿用现状：不阻塞 run，activity 行提示。

### 3.2 内置 Skills（Superpowers）

**资源布局**（Claude Code plugin 结构，SDK `plugins: [{type:'local'}]` 直接可载）：

```
assets/builtin/superpowers/
  .claude-plugin/plugin.json     # name / version / description
  skills/<name>/SKILL.md         # 每个技能一个目录（正文不改）
  LICENSE                        # MIT 原文
  VERSION                        # 上游 tag/commit（更新脚本写入）
```

- **拉取脚本** `scripts/superpowers-fetch.mjs`（安装时执行）：
  - 触发：`package.json` 的 `postinstall`（`npm install` 后自动跑；同时提供显式 `npm run setup:superpowers` 供重跑），`prepare-sidecar.mjs` 打包前**校验目录存在**（不存在则告警并在 UI 标注未安装，不阻断构建）。
  - 行为：从上游（GitHub 固定 repo，`main` 或 `SUPERPOWERS_REF` 指定的 tag/commit）下载 → 只保留白名单技能 → 落盘 `assets/builtin/superpowers/`（**gitignored**，不进仓库）→ 写 `VERSION`（解析到的 commit）。
  - **失败 fail-open**：离线/上游不可达时只打 warning，不 fail 安装；功能在设置页显示「未安装」、开关禁用，其他功能不受影响。
  - 版本控制：默认跟随上游最新；CI/打包环境可用 `SUPERPOWERS_REF` 钉版本，保证可复现。
- **装载**：`runClaude` 新增 `plugins` 透传 → `startClaudeRun` 在 `builtinSkills.superpowers` 开启**且目录存在**时传
  `plugins: [{ type: 'local', path: bundledPath('builtin', 'superpowers'), skipMcpDiscovery: true }]`。
  - 与项目自带 `.claude/skills` 并存（SDK 两者都加载）；技能名带 plugin 前缀（`superpowers:brainstorming`），与项目 skill 重名冲突风险低——落地时实测确认一次。
  - 分类/记忆库等内部调用（传干净 cwd 的那些）**不注入**，避免拖慢（对齐 `memory-bank/sandbox.js` 的既有结论）。
- **打包**：`scripts/prepare-sidecar.mjs` 的 staging 清单加 `assets/`（Tauri `{"resources/":""}` 整目录搬运已覆盖），并在 staging 的 `package.json` 里**剥掉生命周期脚本**——根仓库的 `postinstall`（安装时拉取技能）在侧车目录里没有 `scripts/`，会让 `npm ci` 直接 `MODULE_NOT_FOUND` 拖挂打包链（2026-09-30 实测修复）。
- **路径 helper** `src/shared/bundled-paths.js`：`bundledPath(...segments)` 开发态 = 仓库根相对路径，打包态 = sidecar 资源根（与 `app-paths.js` 同范式、单测钉住）。所有内置资源只经它解析，禁止 `__dirname` 直拼。

### 3.3 开关（存储 / API / UI）

- **存储**：`settings.builtinMcp`（`{ [id]: { enabled, apiKey? } }`）与 `settings.builtinSkills`（`{ [id]: boolean }`）。
  - `normalizeSettings`：补默认（决策 6）、剔除未知 id、类型归位、密钥字段不随 GET 透出（沿用 `botView` 掩码范式）。
  - 配置导入导出：整份 settings 走现有链路，自动透传；导入时同样过 normalize。
- **API**：`/api/builtins`（单入口范式，对齐 routes-* 纪律）：
  - `GET` → `{ mcp: [{id,label,desc,enabled,paths,probe?,hasKey}], skills: [{id,label,desc,enabled}] }`；
  - `PUT { kind:'mcp'|'skill', id, enabled?, apiKey? }` → 校验 id 在白名单、布尔/字符串形状，写盘并返回最新态。
- **UI**：
  - 设置页「MCP 服务器」tab 顶部加**内置 MCP** 区（复用现有 toggle 行样式、复用 CRUD 卡片风格；figma 显示探测状态：「未检测到本地服务」/「已连接」）；
  - 新增「Skills」区（或并入基础偏好 tab）：Superpowers 总开关 + 内置技能清单（名称+一句话，只读）；
  - chat 工具弹层（`public/js/chat.js#refreshToolsSection`）：MCP 列表把内置项一并渲染（同一份全局状态、同 toggle 行为）。

### 3.4 能力矩阵（如实标注，UI 同步展示）

| 内置项 | Claude 路径 | openai 路径（自定义模型） |
|---|---|---|
| Context7（stdio） | ✅ | ✅ |
| Figma 本地 Dev Mode（http） | ✅ | ❌（客户端仅 stdio） |
| Figma Framelink（stdio + key） | ✅ | ✅ |
| Superpowers skills | ✅（SDK plugins） | ❌（Phase 3 另评） |

## 4. 风险

| 风险 | 缓解 |
|---|---|
| npx 首次下载慢 / 离线不可用 | 连接失败 fail-open 只提示；文档建议预装或全局安装；figma 默认关 |
| Figma Dev Mode 端口/桌面未启 | UI 状态探测 + 卡片式指引；不阻塞其他内置项 |
| superpowers 上游漂移 | 固定 tag + `--check` 构建门禁；VERSION 落盘 |
| 内置 skill 与项目 skill 重名 | plugin 前缀天然隔离；落地实测确认一次并记录 |
| 打包后路径失效 | `bundled-paths` 单测 + `tauri:dev` 冒烟（对齐历史上"打包后图片链路全废"的教训） |
| 密钥泄露 | `apiKey` 入库但不随 GET 透出（掩码）；导入导出含密钥按既有整份导出语义处理并在文档标注 |

## 5. 验收

**单测**

- `builtin-mcp.test.js`：注册表形状；`resolveBuiltinMcp` 的开关过滤/路径过滤/平台 npx 形态/密钥注入；未知 id 不产出。
- `bundled-paths.test.js`：开发态与打包态两种解析。
- `settings`：`builtinMcp`/`builtinSkills` normalize（默认值、未知 id 剔除、类型归位、掩码）。
- `routes`：`/api/builtins` GET/PUT（校验、404、形状）。
- `sync-superpowers` 脚本：`--check` 在未漂移/漂移两种仓库状态下的退出码（fixture 目录）。

**手测**

1. 开 context7 → Claude 会话里问「用 context7 查 xxx 的最新文档」能触发工具；openai 自定义模型会话同样；关掉后工具消失。
2. 开 superpowers → 会话里触发 brainstorming（或 `/skills` 能看到 `superpowers:*`）；关掉后不再出现。
3. figma 本地 Dev Mode：Figma 桌面未开 → 设置页显示「未检测到本地服务」；开启后 Claude 路径可出现 figma 工具。
4. `tauri:dev` 打包冒烟：superpowers 目录在打包资源内可达。

**改动文件（预估）**：`integrations/claude.js`（mcpServers/plugins 透传）、`run-claude.js`（构造注入）、`run-openai.js`（合并内置 MCP）、`store/settings.js`、`routes-settings.js` 或新 `routes-builtins.js`、`settings-panel.js` / `chat.js`（UI）、`scripts/sync-superpowers.mjs`、`scripts/prepare-sidecar.mjs`（assets staging）、`shared/bundled-paths.js`、`assets/builtin/superpowers/**`。

## 6. 分阶段

- **Phase 1**：`builtin-mcp` 注册表 + Context7 + 双路径接线 + 开关（存储/normalize/API/设置页 UI）+ 测试。
- **Phase 2**：Figma（按拍板形态）+ 状态探测；Superpowers vendor（sync 脚本）+ `plugins` 接线 + 打包路径 + 开关 UI + 测试。
- **Phase 3**（收尾 2026-09-30）：**per-skill 开关** ✅（`disabledSkills` 存储 + `/api/builtins` 的 `skillId` 分支 + 设置页折叠明细 + Claude 路径「启用视图」镜像物化——SDK 无 per-skill 禁用项，allowlist 会连带隐藏项目技能，故按需拷贝镜像）；**chat 工具弹层合并内置项** ✅（`chat.js#refreshToolsSection` 同源渲染内置 MCP/Skills，同 toggle）；**openai 路径 Skill 机制** → 评估稿 `docs/superpowers/specs/2026-09-30-openai-skill-mechanism-design.md`（方案 C：`Skill` 工具 + 提示词清单，待拍板）。更多内置按需。

## 7. 与后续工作的衔接

- 内置 MCP 的"只读工具自动放行"与「验证门」spec 的审批纪律同源：工具白名单是**配置面**的能力，不是模型可写的运行态。
- 若未来支持 MCP HTTP 传输（openai 路径），Figma 本地 Dev Mode 即可双路径，能力矩阵随之更新。

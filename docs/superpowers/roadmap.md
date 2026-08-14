# 转型 Roadmap（剩余工作 + 优先级）

> 面向"AI Coding 编辑器 / 多渠道 / 多模型源"转型。已完成：Provider 抽象全链（Phase 1 → 2a → 3a → 3b → 3c，后端+前端，自定义 OpenAI 兼容模型可管理、可选、可跑）。本文件跟踪剩余工作，按优先级/风险组织。分支 `feat/config-import-export`。

## ✅ 已完成（本轮）
- Provider 契约 + 注册表（Phase 1）；凭证池 `providerId`（2a）；openai-compat provider + SDK 无关 agent-loop（3a）；abort/错误通道加固、`/api/credentials` CRUD、`startOpenAiRun`+run 路由（3b）；前端自定义模型 tab + model-fab 选择器（3c）。真机 e2e 验证 plumbing 全通。

---

## A. 快赢 / 低风险（先做，闭合审查欠债）
- [x] **3c-2 删除在用凭证的回退** ✅（`9b92290`）：`refreshCustomModelPills` 对账，删掉在用自定义模型后回退 claude-agent。
- [x] **`getStatus().active` 语义统一** ✅：`getStatus(providerId = DEFAULT_PROVIDER_ID)` 按 provider 算 active，与 `getActiveToken/getActiveTokenId` 一致（openai 凭证排序靠前不再误报为 Claude 池 active）。
- [x] **`DEFAULT_PROVIDER_ID` 常量** ✅：新增 `src/shared/provider-ids.js`，token-rotation（5 处）/settings（3 处）/server（5 处）改引常量；`claude-agent.js` 的 intrinsic id 与测试断言字面量有意保留。
- [x] **`mergeMessages(max=0)` 守卫** ✅：`slice(-max)` → `slice(next.length - max)`（TDD，新增 max=0 用例）。
- [x] **可靠 `npm test`** ✅：`node --test "src/**/*.test.js"`（Node 24 原生 glob，避开 tests/archive）；`user-vars.test.js` 改临时 APP_DATA_DIR（动态 import 前设 env）；`slot-filler.test.js` 改走正则兜底路径（无必填变量不触发 Claude 真调用）。122 用例全绿、离线 <5s。

## B. 工程卫生 / 地基（中等，独立于转型，收益立竿见影）
- [x] **根目录清理** ✅（`001b9b5`）：33 个一次性脚本/报告归 `tests/archive/` + `docs/archive/`（纯 rename）。
- [x] **拆上帝文件（后端半）** ✅（2026-07-24）：`src/entrypoints/web/server.js` 1765→152 行，按域拆 9 个模块（http-util / tool-summary / tier / run-claude〔含续跑机器+孤儿恢复 recoverPendingAndOrphans〕/ run-openai / routes-run / routes-settings / routes-files / routes-ops），纯移动零行为变更（settleRun↔doResume 互调须同文件）。验收：129 测试全绿 + 全路由冒烟 200 + MCP tab e2e + steer-bubble 回归 e2e 全过。
- [~] **拆上帝文件（前端半）P2 完成**（2026-07-24）：原生 ES modules（`<script type="module">`，无构建），app.js **4342 → 2169 行（-50%）**，`public/js/` 11 模块：bootstrap（API_BASE+fetch/ES 补丁）/ tauri-init / ui / anim / util（$/escapeHtml/debounce/fmtTime/renderMarkdown）/ json-tool / logs-panel / settings-panel（480）/ actions-panel（221）/ tasks-panel（278，含 bindTasksNav 视图桥注入）/ sidebar（90）。安全网=新增 `tests/e2e-panels-smoke.mjs`（全景遍历+零 pageerror 断言）+ steer-bubble + mcp-tab 三道门禁，每步全绿。spec 与**抽离检查清单**（id 隐式全局、读取型引用漏扫等实战坑）见 `docs/superpowers/specs/2026-07-24-appjs-split-design.md`。**P3 全部完成（含终局壳/体反转，2026-07-24 用户拍板执行）**：app.js **4342 → 108 行壳**，`public/js/` 16 模块（chat.js 1742 行=聊天体本体，接缝 initChat/chatOnShow/bindChatNav；conv-store 三方同序不变量收敛；其余面板/原语各归其位）。四道 e2e 门禁（panels-smoke/sidebar-groups/steer-bubble/mcp-tab）+ 145 后端测试全绿。**前后端双上帝文件均已终结**（server.js 1765→152、app.js 4342→108）。

## C. Provider 能力补完（中大，让自定义模型更强）
- [x] **接 MCP 工具（后端）** ✅ Phase 3d（`8a2023f`→`f5caf85`）：MCP 集成层 `mcp.js`（连 stdio server、工具定义/执行分离）+ `startOpenAiRun` 接线（tools/executeTool + canUseTool 审批 + close）+ capabilities 翻开 + `settings.mcpServers` 读取。管线冒烟已验；配置目前经 settings.json。
- [x] **3d-3 前端 MCP 配置 tab** ✅：设置页「MCP 服务器」tab（增删改停 stdio server；args 每行一个防空格路径歧义；表单复用编辑态）+ `/api/mcp-servers` CRUD（env 不透出/不可注入；`ensureMcpServerIds` 给手改存量条目补 id）+ settings.js `makeMcpServerEntry` 等 setter（2 个纯函数单测）。curl CRUD 冒烟 + Playwright 全链 e2e（添加/停用/编辑/删除）通过。
- [ ] **MCP 真实端点 e2e**：模型真的调用工具→审批→执行→回灌。**阻塞在用户侧**：token 池现无 openai-compat 真凭证（2026-07-24 核验），需在设置页「自定义模型」添加真实端点（如 DeepSeek）后跑一轮带 MCP 工具的对话即可闭合。
- [x] **MCP 连接可中断 + 自动放行白名单** ✅：`@ai-sdk/mcp@2.0.16` 的 StdioConfig/MCPClientConfig 均不收 signal（类型核验）→ 在 `connectAbortable` 外层包 abort：中断立即拒绝 + `transport.close()` 杀挂起子进程（防孤儿，测试实证：套件 30.7s→0.86s）。`autoAllow` 白名单：settings 条目字段 + `buildAutoAllowSet` 并集 + `startOpenAiRun.canUseTool` 命中直接放行 + UI 表单/徽标。新增 4 个测试（预中断/中途中断/白名单并集/归一化）。
- [x] **真 abort 端到端测试** ✅：真 streamText + 真 AbortController 中途打断（仅 mock 语言模型本体），钉住链路：ai@7.0.35 abort 时 fullStream 发 `{type:'abort'}` part 干净收流（不抛）、finishReason/responseMessages 以 AbortError 拒绝 → agent-loop `await finished` 抛 → `signal.aborted` 静默收尾。断言：`{aborted:true}`、不触发 onResult、流被截断（3/40）、141ms 即返。
- [x] **openai 会话关窗重连**：**决策=不做**（2026-07-24）。进程内重连本就可用（runs 注册表+SSE replay）；跨重启 openai 无 session 锚点、半途输出未落盘，但 conv-messages 历史完整、重发即续上，前端「run 不存在」已有兜底 dismiss。为罕见场景引入 pending-resume 级机器不划算（孤儿续跑曾出死循环事故）。
- [ ] **上下文压缩**：**决策=暂缓**（2026-07-24）。摘要式压缩需加 LLM 调用+摘要标记存储，自定义模型现为次要路径（尚无真凭证在用）；等真实长会话质量反馈再做。现状=最近 200 条截断。

## D. 转型下一大块（大，另立子项目）
- [~] **Channel 层 Phase 1** ✅（2026-07-24）：`src/channels/` 契约+注册表（registry 家风同 providers）+ feishu 适配器（WS 生命周期/热重载/代次守卫/去重/报文解析/图片下载全部迁入，逐字符保留）+ `feishu-normalize.js` 纯函数（真实报文样例单测）+ 入口瘦身为组装层（244→70 行：角色判定/业务特例/ctx/dispatch）。ctx 契约字段不变（全仓 grep 核验：reply/user.id/text/user.role/source/sessionKey/meta）。139 测试全绿。**注意：claude-feishu 进程未重启，新代码未生效——下次维护窗口 `pm2 restart claude-feishu` 部署**。**Phase 2** ✅（2026-07-24）：第二渠道=console 开发渠道（`channels/console.js`，stdin/stdout，流注入离线单测收发闭环）+ `entrypoints/console`（接 dispatch 全链，`npm run chat:console`，CONSOLE_ROLE=guest 模拟访客）——契约双实现成立，本地调试 features 不再依赖飞书。QQ/微信=真实第三渠道，接入时按契约实现+register 即可。设计见 `docs/superpowers/specs/2026-07-24-channel-layer-design.md`。
- [ ] **前端"会话目录编辑器"改版**：Cursor 式外壳（子项目 3）。**决策简报已备**（2026-07-24）：`docs/superpowers/specs/2026-07-24-frontend-editor-redesign-brief.md`——5 个待拍板问题（会话目录组织维度/多会话 Tab/工具 Dock/移动端/范围）+ 推荐组合（1A+2A+3A 纯外壳起步）。前置工程（app.js 模块化+e2e 门禁）已就绪，用户拍板即可立项。
- [x] **业务插件化 Phase 1** ✅（2026-07-24）：`src/plugins/` 清单制——team-tools（task-triage+feedback）与 action-runner 两插件；`features/index.js` 改装配（core=claude-exec + 启用插件 features 按 order 合并，TLA）；**停用即不动态 import（内核不载业务代码）**；settings.plugins 启停（缺省全开=行为不变，normalize/replaceSettings/导入导出全链透传）；web 任务路由加插件守卫（停用→404）。双态装配真机验证：全开顺序与插件化前逐字一致、停用时业务模块零加载。144 测试全绿。**Phase 2** ✅（2026-07-24）：①业务代码物理搬迁完成（git mv 保历史）——`src/features/` 只剩内核（claude-exec/token-rotation/index），task-ops+task-triage+feedback → `plugins/team-tools/`、action-runner → `plugins/action-runner/feature/`；②`/api/plugins` GET/PUT + 设置页基础 tab 插件开关区（重启生效提示；web 任务路由守卫即时生效，冒烟实证停用→404→恢复→200）；③feishu 单图特例随 team-tools 停用降级为不支持提示。143 测试 + 三门禁全绿。

---

## 建议顺序
1. **A 快赢**（闭债、低风险）→ 2. **B 地基**（根目录清理 + 可靠测试门禁）→ 3. **C 接 MCP 工具**（自定义模型 agentic，转型最大能力增量）→ 4. **拆上帝文件**（在大改前止血）→ 5. **D**（Channel / 前端编辑器 / 插件化，各自子项目）。

## E. 用户 2026-07-24 提出的桌面版问题/优化（六项）
- [x] **①启动闪窗加固**：窗口 `visible(false)` + `on_page_load(Finished)` 再显示（防白闪）+ 3s 兜底强显；dev node spawn 补 `CREATE_NO_WINDOW`（prod sidecar 经 plugin-shell 2.3.5 已带该旗标，源码核验）。cargo check 通过，**待下次打包真机确认闪烁消失**；若仍闪，请观察闪的是黑色控制台还是白色窗体再回报。
- [x] **③动作脚本静默执行**：根因=`integrations/shell.js` spawn 缺 `windowsHide`（全仓唯一缺口，其余 spawn 点已带）。已修，桌面版下次跑动作脚本验证。
- [x] **④粘贴降纯文本**：composer.js 拦 paste → `insertText` 纯文本（保撤销栈）；panels-smoke 增合成 ClipboardEvent 断言（HTML 标签不进输入框）。已验证。
- [x] **⑤顶栏拖拽区扩展**：`.topbar` 背景 + `#ratelimit`/`#pendingChip`（纯展示）划入 `data-tauri-drag-region`；最大化态拖拽由 JS 接管（还原 + `win_start_dragging` 系统拖拽跟随鼠标）。**待桌面真机验证**。
- [x] **⑥子代理执行 UI**：探针实锤 SDK 0.3.210+ 子代理不透流内消息（background task 模式），改接 `system task_started/task_progress/task_notification` 事件 → `↳ 子代理(类型)启动/正在X·已N次工具/完成` 活动行；`Agent` 工具名补进 summarizeTool 与 READONLY_TOOLS（旧名 Task 已弃用会误拦审批）。**端到端验证通过**（真实 run 全生命周期可见）。展示形态仍是「最新一行」，完整转录在 run.activities（50 条 cap）——如需展开面板另提。
- [x] **②一窗一项目 + 侧栏项目分组** ✅（2026-07-24）：Rust `win_new(query)` 命令（校验后透传 `?cwd=`，复用 create_app_window_with_query）；前端每窗 cwd=URL 优先（`_urlCwd`，且不被 uiPrefs.defaultCwd 覆盖）；`selectDir` 本窗已有项目→`openProjectWindow` 开新窗（Tauri invoke / 浏览器 window.open）；侧栏「当前项目平铺如旧 + 其他项目折叠分组」（组内最近排序、运行中强制展开+呼吸点、展开态 localStorage 持久化、跨项目点击带 `?cwd&conv` 定向新窗、启动时 lastConv 限本窗项目）。专项 e2e `tests/e2e-sidebar-groups.mjs` 全链过 + 三门禁 + 143 后端测试全绿。**Tauri win_new 真机路径待桌面打包验证**。

_本文件随进度勾选/追加。_

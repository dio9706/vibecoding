# agent `taskkill` 自灭后端事故 · 复盘与修复

- 日期：2026-10-08
- 状态：已定位并修复；测试与文档见 §5
- 关联：`src/capabilities/tool-policy.logic.js`（危险命令表）、`src/providers/builtin-tools.js`（Bash）、`entrypoints/web/run-openai.js`（策略门）
- 事件：用户在桌面版里让 app 的 agent（DeepSeek 自定义模型，档位=自动）改本仓 UI；任务执行中**后端静默消失**，前端显示「服务器后台异常 正在尝试重新连接…」。

## 1. 现象与证据

| 证据 | 内容 |
|---|---|
| app/backend 日志 | 到 `[agent-loop] 模型步完成 step:35`（11:30:20）**戛然而止**：无 JS 异常栈、无 V8 OOM、无任何后续心跳 |
| Windows 事件日志 | 11:30 前后**无 WER/Application Error**（对比 11:19 装 MSI 时有 0xc0000409 记录）→ 不是崩溃，是**被外部终止** |
| 进程状态 | `principal-desktop.exe`（shell+WebView）仍存活；`node.exe`（后端 sidecar，pid 21948）消失 |
| conv-messages（该轮对话第 76 条 tool-call） | agent 执行了 **`taskkill /f /im node.exe /fi "WINDOWTITLE eq *" >nul 2>&1 & taskkill /f /im node.exe >nul 2>&1`** —— 它想清理自己刚起的探针服务器（`tmp-probe/stub-server.mjs`） |

## 2. 根因

- agent（Bash 工具、**自动档免审批**）为善后自己的临时探针进程，写下了**按镜像名全量击杀**的命令；
- `taskkill /f /im node.exe` 会杀死本机**所有** node 进程——包括承载它自己的后端 sidecar（Tauri 打包版后端就是 `C:\Program Files\Principal\node.exe`）→ 后端自杀，任务随之中断；
- 危险命令表（全档位 deny 的兜底）只覆盖删根/毁盘/关机/炸弹/全盘改权限，**没有进程击杀类**，所以自动档下这道命令无任何拦截。

## 3. 修复

`DANGEROUS_RULES` 增两条（危险命令在**所有档位**（含 bypassPermissions / 无人值守）无条件 deny）：

| id | 命中 | reason 摘要 |
|---|---|---|
| `kill_process` | `taskkill` / `pkill` / `killall` / `Stop-Process`（含 `cmd /c` 与 `&&` 链式） | 批量结束本机进程可能杀死其它程序（含本服务自身）；清理自己的进程应在脚本内自行退出或按 PID 精准处理 |
| `kill_signal` | `kill -9/-TERM/...` | 向进程发信号可能误杀其它程序 |

误杀防线：`echo "taskkill..."`、`grep taskkill` 这类「提及而非执行」不命中（锚点要求行首或 `;&|` 之后）。

## 4. 边界与恢复

- **Claude 路径已知边界**（T6 已记）：`bypassPermissions` 档下 SDK 不调 `canUseTool`，本表拦不到；该路径不建议用于无人值守。openai 路径的 `canUseTool` 全程在线 → 新规则即刻生效。
- **恢复路径正常**：崩溃 run 保留在 run-index（status running）→ 下次启动 reconcile 自动续跑；悬空修复会给 taskkill 调用补「未执行」合成结果，模型继续（修复后若重试该命令会被 deny 并在工具结果里看到引导文案）。

## 5. 验证与后续

- 单测：危险命令正/反例扩充（taskkill/pkill/killall/Stop-Process/kill -9 必拦；提及型命令不误杀）——`tool-policy.logic.test.js` 22/22；
- 全量 `npm test` 见交接单；
- 建议：重建桌面版**再**启动（否则续跑的任务可能再次执行同一命令）；`tmp-probe/`（agent 遗留探针，自带「跑完即删」注释）可手动删除。

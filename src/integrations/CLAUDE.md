# `src/integrations` · 模块地图

**定位**：全项目对外部系统的适配层。每个外部依赖（Claude Agent SDK、飞书、子进程、docx）都由**单一文件收口成唯一入口**，上层一律只 import 这里，绝不直接引第三方 SDK。本层处于分层链 `entrypoints → app → features/plugins → capabilities → integrations/store → shared` 的下游，只依赖 `src/shared/`（`config.js` / `logger.js` / `app-paths.js`），不反向依赖任何上层。

**一句话判断**：适配器文件（`claude.js` / `lark.js` / `shell.js` / `notify.js` / `docx.js`）之间**互不调用、无编排关系**——它们是并列的适配器，不是一条流水线；`claude.logic.js` 是 `claude.js` 的纯逻辑层，只被它 import。所谓「流程」指的是每个文件内部如何把一次调用翻译成对外部系统的交互，而非文件间的数据传递。要找编排逻辑，应上溯到 `entrypoints` / `features` 层。

## 文件清单

- `claude.js` — Claude Agent SDK 封装，全项目唯一的 Claude 调用入口。导出 `runClaude`（流式执行 + 重试）、`createInputQueue`（插话/steering 输入队列）。**本模块唯一有复杂控制流的文件**。
- `claude.logic.js` — `claude.js` 的纯逻辑层（零 IO、零 import）：`describeTaskEvent` 把 SDK task_* 系统事件翻成活动转录文案，按 task_id 在 per-attempt 的 Map 里记住「工作流 / 子代理 / 后台任务」类型与 skip 标记（只有 task_started 带 workflow_name，progress 只带 subagent_type，notification 两者都不带，所以只能查表）；`isTaskEvent` 供 `claude.js` 判断分派。
- `lark.js` — 飞书（Lark）API 封装，全项目唯一的飞书调用入口。导出 client/WSClient 工厂、发消息（文本/Markdown/卡片/图片/文件）、表情、资源下载、docx/wiki/bitable 读取、凭证热切换。文件最长、API 面最广。
- `shell.js` — 本地脚本/CLI 执行封装，全项目唯一的子进程入口。导出 `runScript`、`DEFAULT_TIMEOUT_MS`。
- `notify.js` — 系统级通知（Windows 气泡/Toast），fire-and-forget。导出 `systemNotify`。
- `docx.js` — docx → 纯文本（mammoth.extractRawText）。导出 `docxToMdFile`。
- `claude.test.js` / `claude-retry.test.js` / `claude.logic.test.js` — `createInputQueue` 队列语义、`runClaude` 重试逻辑、task_* 事件标签（含常驻任务压制、回落、变异守护）单测。
- `lark.file.test.js` / `lark.username.test.js` — 飞书文件上传约束、用户姓名解析缓存单测。
- `shell.test.js` — `runScript` 子进程行为单测。

## 关键流程

### 1. `claude.js`：流式消费 + 插话 + 重试（本模块唯一的复杂主链路）
`runClaude(prompt, opts)`：
1. 若传了 `opts.onInputHandle` → `createInputQueue(prompt)` 建流式输入队列（首条为初始 prompt，运行中可 `push` 插话）；否则 prompt 按字符串直传。
2. `query({ prompt, options })` 创建 SDK 查询；随即把 `{ push, close, interrupt }` 句柄回交调用方（`interrupt` 直接绑 `q.interrupt()`，做到轮内打断而 run 不死）。
3. `for await (message of q)` 消费 SDK 消息流，按 `message.type`/`subtype` 分派到回调：`init→onInit`、`task_*→isTaskEvent→describeTaskEvent→onActivity`（子代理 / 工作流 / 后台任务进度，类型按 task_id 查表，见 claude.logic.js）、`rate_limit_event→onRateLimit`、`stream_event→onText`（token 级增量）、`assistant→onText/onActivity`、`result→onResult`；每条消息都先调 `onPulse` 喂看门狗（子代理静默期也算存活）。
4. `result` 到达 → `inputQueue.autoClose()`：无积压则关流收尾，有刚插入的插话则继续同一 run 的下一轮。
5. `catch`：仅 `stalled`/`mid-stream` 类网络错误才重试，指数退避（1s→2s→4s，上限 10s），重试前重建 `inputQueue`；权限/请求非法等其他错误直接抛。

### 2. `lark.js`：双层懒加载 + 懒单例 client + 发送/下载/读取分支
- **两级按需加载**：飞书 SDK 单独占约 40MB RSS，故**不在文件顶部静态 import**，首次真用时才经 `sdk()` 动态 `import`；API client 也懒实例化——所有导出函数最终都走 `getClient()`（凭证优先取 `resetApiClient` 存下的 `_overrideCreds`，否则读 `getLarkCredentials()`）。
- **凭证热切换**：`resetApiClient(creds)` 只清缓存（`_client` / `_botOpenId` / 姓名缓存）并记下新凭证，真正的 `new` 延后到下次 `getClient()`；多账号轮换即靠它换号。
- **发送分支与降级**：`sendMarkdown → sendCard`（交互卡片）失败时降级 `sendText`（纯文本）；私聊通知 `sendTextToUser` / `sendCardToUser` 用临时 client，不污染全局单例。
- **资源下载**：`downloadMessageResource*` 拉流 → 写入 `appDataPath('.uploads','feishu')`（`RESOURCE_DIR`）→ 返回本地绝对路径；提供 `downloadMessageResource`（失败返 null）与 `downloadMessageResourceWithError`（失败返 `{file,error}` 供上层按错误码提示）两个同构版本。
- **缓存策略**：`getBotOpenId`（群聊 @ 过滤用）与 `getUserName`（日志展示用）都带正缓存 + 负缓存 + 60s 负缓存 TTL，取不到一律返回 null 让调用方降级，绝不因查不到而失声或抛错。

### 3. `shell.js` / `notify.js`：一次性子进程封装
- `runScript(bin, args, opts)`：`spawn` → 立刻 `stdin.end()`（防 git 问凭证 / python `input()` 死等）→ 原始 Buffer 累积到 `close` 再整体 UTF-8 解码（防中文跨 chunk 乱码）→ `close`/`error` 经 `done()` 去重 resolve → 超时走 `killTree`（Windows 用 `taskkill /T` 连杀子孙进程）。默认 `shell:false`（元字符不被解释，防命令注入）。全程不抛异常，返回结构化结果。
- `systemNotify(title, message)`：非 Windows 打 console 降级；Windows 下把 PowerShell NotifyIcon 脚本 base64 编码后 `detached` spawn，`unref` 后不阻塞主流程，失败静默。

### 4. `docx.js`：单步解析
`docxToMdFile(path, title)`：按需 `import('mammoth')` → `extractRawText` → 空结果抛错 → 在原文件旁写 `.md` → 返回 md 路径。失败由调用方降级为附原文件。

## 常见改动入口

- 要给 `runClaude` 加参数 / 改消息类型分派 / 调重试策略，就改 `claude.js` 的 `runClaude`（新 opts 在解构处加、透传在 `query({ options })` 处加）；要改 task_* 事件的文案或类型判定，改 `claude.logic.js`（有单测，先改测试）。
- 要改插话（steering）队列语义（何时关流、如何续轮），就改 `claude.js` 的 `createInputQueue` 与 `runClaude` 里的 `autoClose` 调用点。
- 要给飞书加一类新 API（发某种消息、读某类文档/表格），就在 `lark.js` 新增导出函数，复用 `getClient()`，业务码校验照抄 `if (r?.code) throw`。
- 要改多账号轮换 / 凭证失效逻辑，就改 `lark.js` 的 `resetApiClient`（决定清哪些缓存）。
- 要改群聊 @ 过滤或用户姓名的缓存与降级，就改 `lark.js` 的 `getBotOpenId` / `getUserName`（含负缓存 TTL）。
- 要改飞书资源下载的落盘目录 / 命名 / 错误信息，就改 `lark.js` 的 `RESOURCE_DIR` 与 `downloadMessageResource*`。
- 要改发送失败的降级链（卡片→纯文本），就改 `lark.js` 的 `sendMarkdown`。
- 要改子进程超时 / shell 安全 / 杀进程方式，就改 `shell.js` 的 `DEFAULT_TIMEOUT_MS` / `runScript`（`shell` 参数）/ `killTree`。
- 要改系统通知的渠道或文案，就改 `notify.js` 的 `systemNotify`。
- 要换 docx 解析器或输出格式，就改 `docx.js` 的 `docxToMdFile`。

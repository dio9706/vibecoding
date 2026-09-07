# src/app · 模块地图

> 分发与意图层。职责单一：把「入口层已归一化的统一 Context」判成一个意图，再路由到某个 feature 执行。**本层不含任何业务逻辑**——业务是 `src/features/` 与 `src/plugins/`，本层只决定「这条消息该交给谁」。

## 文件清单

- `dispatch.js` — 路由核心。把统一 Context 分发到某个 feature；并提供异常兜底包装 `dispatchSafely`。导出 `dispatch` / `dispatchSafely`。**本模块唯一入口**。
- `intent.js` — 意图识别。收缩为四类显式意图（bug/feature/question/action，另加 material/other），逐层短路。导出 `classify` / `isChitchat` / `INTENT_CLASSIFY_TIMEOUT_MS`。（曾有个 `extractEnv`，全仓无调用方且只认 dev/test 不认 prod，2026-09-04 随变量契约改造删除 —— 环境识别现在完全由 `plugins/action-runner/feature/` 的变量声明驱动。）
- `intent-keywords.js` — 强意图前缀词表（纯函数，零 LLM 成本的快路）。导出 `matchStrongIntent`。**零依赖叶子，可被下层 import**（现由 `intent.js` 与 `features/claude-exec/logic.js` 共用，理由同 `signals.js`，见下文 §C）。
- `signals.js` — dispatch 分发信号量，仅导出 `PASS`（一个 Symbol）。**叶子模块，禁止 import 任何东西**（打破 ESM 循环，见下文）。
- `dispatch.test.js` / `intent.test.js` / `intent-keywords.test.js` — 对应单测。

## 关键流程

### A. 分发主路径（`dispatch.js` 的 `dispatch`）

入口是 `dispatchSafely(ctx)`，它 `try` 调 `dispatch(ctx)`，任何异常都在这一层用 `ctx.reply(FAILURE_TEXT)` 回告用户，**绝不重抛、绝不静默**——因为再往上（飞书入口 `finally` 无 catch、SDK 已回 200 ack、去重表已标记 messageId）没有任何补救机会，冒泡等于消息永久丢失。

`dispatch` 内部按四步**顺序短路**，命中即 return：

1. **未完成会话优先**：遍历 `featureList`，若某 feature 的 `f.hasPending(ctx)`（同步判定）为真，先交给它 `f.handle(ctx, null)`。若返回值 `=== PASS`（来自 `signals.js`），说明它发现「这条不是回答我的追问」，把消息还回来继续走后续步骤。
2. **owner 兜底**：遍历，若 `f.match(ctx)` 命中直接 `f.handle(ctx, null)`（owner 全接的 claude-exec 走这里）。
3. **意图匹配**：调 `classify(ctx.text, { hasMaterials: !!ctx.meta?.hasMaterials })` 得到 `intent`，把 `intent.body` 写回 `ctx.body`，再遍历按 `f.permission`（`'any'` 或等于 `ctx.user.role`）+ `f.intents.includes(intent.intent)` 匹配，命中则 `f.handle(ctx, intent)`。
4. **无匹配**：`getActiveBot()` → `buildWelcomeCard` → `ctx.sendCard` 回引导卡片。

控制流：`dispatch.js` → `intent.js`（`classify`）、`signals.js`（`PASS`）、`../features/index.js`（`features` 装配表，feature 的先后顺序即匹配优先级）。

### B. 意图分层短路（`intent.js` 的 `classify`）

数据从 `dispatch` 传入原始 `text`，逐层下探，任一层命中即返回统一形状 `{ intent, body, strong, env, keyword, actionId?, actionName? }`：

- **L0 寒暄**：`isChitchat(text)` 命中 → `other`（免 LLM）。此函数先卡 `CHITCHAT_MAX_LEN`(60) 再跑 `CHITCHAT_RE`——长度护栏是为防带 `+` 的多选择支正则对长输入灾难性回溯占死事件循环（真实事故，勿删）。
- **L1 强前缀**：调 `intent-keywords.js` 的 `matchStrongIntent(text)`。命中 bug/feature 直接短路返回（`strong:true`，`body` 为剥掉前缀的正文）；命中 question 则**先不返回**，让路给 L2。
- **L2 动作关键词单命中**：`enabledActions()`（动态 import `../store/action-configs.js` + `../store/settings.js`，取当前启用 bot 的动作）按 `keywords.includes` 匹配。恰好单命中 → `action`。L1 判 question 时用剥好的 `body` 在此再匹配一次，命中即改判 action（避免「请问能帮我清一下 test 环境吗」被 question 劫持）；未命中才落回 question 返回。
- **L3 语义分类**：`quickClassify` 拼 prompt 后调 `../capabilities/llm-classify.js` 的 `runClassifierOnce`（一次 Haiku 合并分类，`INTENT_CLASSIFY_TIMEOUT_MS`=10s）。命中且非 other → 返回对应类型。
- **L4 兜底**：L3 失败/超时/other 一律返回 `other`——**不退回全文关键词兜底**（那正是旧版误立案的来源），交给 dispatch 回引导文案。

控制流：`intent.js` → `intent-keywords.js`（`matchStrongIntent`）、`../capabilities/llm-classify.js`（`runClassifierOnce`）、`../shared/config.js`（`config.intent.classifyModel`），并动态 import `../store/action-configs.js` / `../store/settings.js`。

### C. 为什么 `PASS` 单独成文件 —— 以及本模块的两个「零依赖叶子」

`PASS` 需被 `dispatch.js` 与各 plugin 的 feature 同时引用，而 `dispatch.js → features/index.js → plugins/… → feature` 本就是一条 import 链。若把 `PASS` 定义在 `dispatch.js`，feature 反向 import 会成环；而 `features/index.js` 带**顶层 await**，ESM 循环 + 顶层 await 会死锁在模块图上。故 `signals.js` 必须保持零依赖的叶子。

**`intent-keywords.js` 是同一形状的第二个叶子。** 它被 `features/claude-exec/logic.js` 反向 import
（`shouldOwnerExec` 要用同一套强前缀词表判断「提交需求 / 提交故障」该让路给 feedback）。
按根 `CLAUDE.md` 的通则「下层不得 import 上层」这是一条违规，但它是**刻意允许的例外**，理由与 `PASS` 完全一致：

- 词表必须**只有一份**。让 features 自己抄一份，两处词表迟早分叉——而分叉的后果是
  同一句「提交需求：xxx」在 intent 层被识别、在 claude-exec 的让路判断里没被识别，
  消息被 owner 全接吞掉，用户看不到任何评审流程。
- 它零依赖，**不可能成环**（这也是环检测器实测确认过的：全仓 import 环为 0）。

所以这两个文件的纪律是硬性的：**`signals.js` 与 `intent-keywords.js` 禁止 import 任何东西**。
一旦其中任何一个开始 import（哪怕只是 `logger`），下层对它的 import 就立刻变成真实的反向依赖，
上面那条例外的前提也就不成立了。

## 常见改动入口

- **要改分发顺序 / owner 兜底 / 权限判定 / 异常回告** → 改 `dispatch.js`（四步顺序、`FAILURE_TEXT`、`permission` 匹配都在此）。
- **要加 / 改零成本的强前缀说法**（如新增「提交需求」类前缀词）→ 改 `intent-keywords.js` 的 `GROUPS`。⚠️ 新增候选前务必确认它不能由其他候选拼出，否则触发灾难性回溯。
- **要改意图分层逻辑 / 分类超时 / 寒暄规则 / L3 分类 prompt** → 改 `intent.js`。
- **要新增一个业务对话意图 / 动作**：**不改本模块**。走插件（`src/plugins/<id>/`）+ 动作配置（`store/action-configs`）——`intent.js` 顶部已明确「新增动作意图无需改此文件」。新意图类目才回到 `intent.js`。
- **要改 feature「放弃接管」的语义** → 改 `signals.js`（并保持它零 import）。
- **要注入替身做单测**：`dispatch(ctx, { featureList, classifyFn })`、`dispatchSafely(ctx, { run })` 均预留了注入口。

# Provider 抽象 · Phase 3b-2 片 C（startOpenAiRun + run 路由）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `POST /api/run/start {provider:'openai-compat', ...}` 真正在后端跑起来——`handleRunStart` 加早返回路由分支；新增 `startOpenAiRun`（取 openai 凭证 → 从 conv-messages 重放历史 → 走 openai-compat provider → hooks 接 runs.js 回调复用 SSE/停止/流式 → 结果落 conv-messages）。**不传 provider = 走 Claude，逐字不变。**

**Architecture:** 在 `handleRunStart` 里 `const run = createRun()` 之后加一个 `if (provider==='openai-compat'){ sendJson; return startOpenAiRun(...); }` 早返回，Claude 分支（auto 判档/sendJson/startClaudeRun）**完全不进、零改动**。`startOpenAiRun` 复用 runs.js 的 `runText/runActivity/runResult/runPulse/finishRun/failRun` + `run.abortController`（片A 已让 openai-compat 消费 abortController）+ conv-messages（片3b-1）+ `pickActive(getTokens(),'openai-compat')`。openai run **不 `addActiveRun`**（resume=false、不参与跨重启孤儿恢复，避免重启误按 Claude session 续接）。

**Tech Stack:** Node.js ESM；http。

## 前置
- 片 A（provider abort/错误通道）✅、片 3b-1（conv-messages + 凭证字段）✅、片 B（凭证 CRUD）建议先落（本片用 `pickActive('openai-compat')` 读凭证；无凭证时 `failRun` 提示去设置里加）。

## 本期范围
run 路由 + startOpenAiRun。**不含** MCP 工具（v1 纯对话，provider `tools=false`）、前端选择器（3c）、openai 关窗续跑/额度续跑（非目标）。

## 验证说明（诚实）
server.js run 编排无单测惯例；provider/loop/adapter 已被 28 个 provider 单测覆盖（用 mock 模型证明逻辑）。本片验证 = `node --check` + provider 全量单测不回归 + **真端到端需一个真实 OpenAI 兼容端点凭证**（baseURL+apiKey+model，用户提供）；无端点时逻辑闭环靠 review + 单测，真机联调留用户。

## 文件结构
- Modify `src/entrypoints/web/server.js` — 导入加 `getMessages/appendMessages`（conv-messages）+ `pickActive`（token-rotation）；`handleRunStart` 加 provider 路由分支；新增 `startOpenAiRun`。

---

### Task 1: 导入 + 路由分支 + startOpenAiRun

**Files:**
- Modify: `src/entrypoints/web/server.js`

- [ ] **Step 1: 加导入**

(a) 在 `import * as providers from '../../providers/index.js';`（约第 15 行）之后加一行：
```js
import { getMessages, appendMessages } from '../../store/conv-messages.js';
```

(b) 在 `from '../../features/token-rotation.js'` 的解构里加 `pickActive,`（放在 `getActiveToken,` 之前）：

找到：
```js
import {
  getActiveToken,
  claudeAuthOpts,
```
改为：
```js
import {
  pickActive,
  getActiveToken,
  claudeAuthOpts,
```

- [ ] **Step 2: handleRunStart 加 provider 路由分支**

在 `handleRunStart` 内，找到读取字段处：
```js
    const mode = (data.mode || '').trim();
    const convId = (data.convId || '').trim();
```
在其后加一行：
```js
    const provider = (data.provider || 'claude-agent').trim();
```

然后找到：
```js
    const run = createRun();
    const auto = model === 'auto';
```
在这两行**之间**插入 openai 早返回分支（Claude 分支完全不变）：
```js
    const run = createRun();
    if (provider === 'openai-compat') {
      sendJson(res, 200, { runId: run.id, model });
      return startOpenAiRun(run, { prompt, model, convId });
    }
    const auto = model === 'auto';
```

- [ ] **Step 3: 新增 startOpenAiRun** — 在 `startClaudeRun` 函数结束（其 `.catch((err) => settleRun(run, err, lastRate, params));` 后的 `}`，约第 453 行）之后插入：

```js
/** openai-compat run 路径：无 Claude session，历史走 app 自持 conv-messages 重放；
 *  hooks 接 runs.js 回调复用现有 SSE/停止/流式。openai resume=false → 不 addActiveRun（不参与跨重启孤儿恢复）。 */
function startOpenAiRun(run, { prompt, model, convId }) {
  run.convId = convId || run.convId || null;
  const cred = pickActive(getTokens(), 'openai-compat'); // { id, token=apiKey, baseURL, model, ... } | null
  if (!cred) return failRun(run, '未配置可用的自定义模型凭证——请到设置页添加 OpenAI 兼容凭证（baseURL + apiKey + model）');
  appendMessages(convId, [{ role: 'user', content: prompt }]);
  const priorMessages = getMessages(convId); // 含刚追加的 user 消息 = 完整历史
  const handle = providers.get('openai-compat').run(
    {
      messages: priorMessages,
      model: model || cred.model,
      apiKey: cred.token,
      baseURL: cred.baseURL,
      abortController: run.abortController, // 停止/看门狗 → abort → streamText+loop 真中断（片A）
    },
    {
      onText: (t) => runText(run, t),
      onActivity: (a) => runActivity(run, summarizeTool(a)),
      onResult: (info) => runResult(run, info),
      onPulse: () => runPulse(run),
    },
  );
  handle.done
    .then((out) => {
      // 持久化本轮新增的 assistant/tool 消息（out.messages = priorMessages + 新增）
      if (out && Array.isArray(out.messages)) {
        appendMessages(convId, out.messages.slice(priorMessages.length));
      }
      finishRun(run);
    })
    .catch((err) => failRun(run, `自定义模型执行失败：${err?.message || String(err)}`));
}
```

- [ ] **Step 4: 语法检查** — Run: `node --check src/entrypoints/web/server.js` — Expected: 无输出（成功）。

- [ ] **Step 5: provider 单测不回归** — Run: `node --test "src/providers/*.test.js" "src/store/conv-messages.test.js" "src/store/settings.test.js"` — Expected: 全绿（provider 28 + conv-messages 4 + settings 7 = 39），确认本片未破坏 provider 层。

- [ ] **Step 6: 路由回归冒烟（确认 Claude 路径默认不变 + openai 无凭证时优雅失败）** — 临时数据目录起服务：

```bash
cd "C:/Users/DELL/Desktop/claude-p-web-demo"
export APP_DATA_DIR="$(mktemp -d)"; export PORT=3998
node server.js & SRV=$!; sleep 2
echo "--- openai 无凭证 → 应优雅失败（runId 正常返回，随后 run 变 error）---"
curl -s -X POST localhost:3998/api/run/start -H 'Content-Type: application/json' -d '{"provider":"openai-compat","prompt":"hi","convId":"c_smoke"}'
echo
kill $SRV 2>/dev/null; rm -rf "$APP_DATA_DIR"
```
Expected: 返回 `{"runId":"run_...","model":""}`（分支走通、未抛异常）。附一条 openai 凭证（经片 B 的 `/api/credentials` 或直接写临时 settings.json）再发一次即进入真实调用——**真端到端需真实端点**，无端点则到此为止，报告注明。若 `server.js` 起不来（缺依赖等），退化为仅 Step 4+5 通过 + 人工核对，注明。

- [ ] **Step 7: 提交**
```bash
git add src/entrypoints/web/server.js
git commit -m "feat(web): startOpenAiRun + handleRunStart 按 provider 路由（默认 Claude 不变）"
```

## 自检
- **Claude 路径零回归**：openai 早返回在 `const auto=...` 之前，`provider` 缺省='claude-agent' → 不进分支 → 原逻辑逐字执行。
- **历史无重复**：先 `appendMessages(user)` 落库 → `getMessages` 取全量 → loop 返回 `prior+新增` → 只 append `slice(prior.length)`（新增），不重复存 user。
- **中断/错误**：`run.abortController` 传入 provider（片A 消费）→ 停止/看门狗真中断；loop 失败 onResult(error)+reject → `.catch`→`failRun` 广播（带消息）。
- **不 addActiveRun**：openai resume=false，避免重启孤儿恢复误按 Claude session 续接（spec 非目标）。
- 命名一致：`startOpenAiRun`；hooks 用 runs.js 现有 `runText/runActivity/runResult/runPulse/finishRun/failRun`。
## 提交纪律：只 add `server.js`，不用 `git add -A`；分支 `feat/config-import-export`。
## 遗留（记入后续）：真 abort 端到端测试、openai 关窗重连（内存 runs.js 进程内有效）、接 MCP 工具翻 tools/agentic。

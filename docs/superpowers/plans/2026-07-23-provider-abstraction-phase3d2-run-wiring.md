# Provider 抽象 · Phase 3d-2（startOpenAiRun 接 MCP 工具 + 审批 + 能力翻开）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `startOpenAiRun` 连上配置的 MCP server（3d-1 的 `connectMcpServers`），把工具定义/执行接进 openai-compat provider、每次工具调用经 `canUseTool` 审批（复用 runs.js pendingQueue + 审批卡）、run 结束/失败 close MCP；翻开 openai-compat 的 `tools/agentic/fileIO/permissions` 能力位；settings 增 `mcpServers` 读取。无 MCP 配置时自然降级为纯对话（片 C 行为不变）。

**Architecture:** `openai-compat.js` 早已把 `input.tools`（→adapter→streamText）与 `input.executeTool`（→agent-loop）透传就绪（3a）。本期在 `startOpenAiRun` 里：读 `getMcpServers()` → `connectMcpServers(configs,{cwd,signal})` → 把 `toolDefs`/`executeTool` 塞进 `provider.run` 的 input、装 `canUseTool`（askUser 审批，复用 Claude 路径逻辑）→ `handle.done.finally(close)`。capabilities 静态翻 true（配了 MCP 才真有工具，没配就无 tools 纯对话，行为自然降级）。MCP server 配置来自 `settings.mcpServers`（本期加 getter + normalize 默认；完整 CRUD API + 前端 = 3d-3）。

**Tech Stack:** Node.js ESM；3d-1 的 `src/providers/mcp.js`；`node:test`。

## 本期范围（对照 3d spec 模块 2/3 的存储读取部分）
run 接线 + 审批 + capabilities + `settings.mcpServers` 读取。**不含** MCP 配置的写 API + 前端 MCP 设置 tab（3d-3）。

## 关键不变量
- **无 MCP 配置 → 纯对话，与片 C 行为一致**（`toolDefs` 为空 → 不装 canUseTool → provider 无 tools）。
- **每个工具调用必过审批**（`canUseTool` → askUser → pendingQueue；复用 Claude 路径的"允许/拒绝"卡与并发串行化）。
- MCP client 无论成功/失败/abort 都 `close()`（`.finally`）。
- Claude 路径完全不受影响。

## 文件结构
- Modify `src/store/settings.js` — DEFAULTS + normalizeSettings 加 `mcpServers`；`getMcpServers()`；replaceSettings 带上。
- Modify `src/providers/openai-compat.js` — capabilities 翻 `tools/agentic/fileIO/permissions=true`。
- Modify `src/providers/openai-compat.test.js` — 更新 capabilities 断言。
- Modify `src/entrypoints/web/server.js` — import；handleRunStart 分支传 cwd；`startOpenAiRun` 改为 async + MCP 接线 + canUseTool + close。

---

### Task 1: settings 增 mcpServers 读取

- [ ] **E1 — DEFAULTS.** 在 `src/store/settings.js` 找到：
```js
  tokens: [],
  messages: {},
```
（这是 `DEFAULTS` 里的）在 `tokens: [],` 之后加一行 `mcpServers: [],`：
```js
  tokens: [],
  mcpServers: [],
  messages: {},
```

- [ ] **E2 — normalizeSettings.** 找到 normalizeSettings return 里的 messages 行：
```js
    messages: s.messages && typeof s.messages === 'object' && !Array.isArray(s.messages) ? s.messages : {},
```
在其**前**加一行：
```js
    mcpServers: Array.isArray(s.mcpServers) ? s.mcpServers : [],
```

- [ ] **E3 — getter + replaceSettings.** 找到 `export function getTokens() {`，在其**前**插入：
```js
/** 读取已配置的 MCP server 列表（stdio）：[{ id, label, command, args, cwd?, env?, enabled }] */
export function getMcpServers() {
  return getSettings().mcpServers;
}

```
再找到 replaceSettings 里：
```js
    s.tokens = n.tokens;
    s.messages = n.messages;
```
在 `s.tokens = n.tokens;` 之后加：
```js
    s.mcpServers = n.mcpServers;
```

- [ ] **E4 — 测试** — 在 `src/store/settings.test.js` 末尾追加：
```js
test('normalizeSettings：mcpServers 缺省为空数组、非数组归空', () => {
  assert.deepEqual(normalizeSettings({}).mcpServers, []);
  assert.deepEqual(normalizeSettings({ mcpServers: 'x' }).mcpServers, []);
  assert.deepEqual(normalizeSettings({ mcpServers: [{ command: 'node' }] }).mcpServers, [{ command: 'node' }]);
});
```

- [ ] **Verify + commit:** `node --test "src/store/settings.test.js"`（原 7 + 新 1 = 8 pass）→ `git add src/store/settings.js src/store/settings.test.js && git commit -m "feat(store): settings 增 mcpServers 读取（getMcpServers + normalize）"`

---

### Task 2: openai-compat capabilities 翻开

- [ ] **E5 — capabilities.** 在 `src/providers/openai-compat.js` 找到：
```js
export const OPENAI_COMPAT_CAPABILITIES = Object.freeze({
  agentic: false, tools: false, fileIO: false, permissions: false,
  stream: true, resume: false, rateLimitAware: false, compaction: false,
});
```
替换为：
```js
export const OPENAI_COMPAT_CAPABILITIES = Object.freeze({
  agentic: true, tools: true, fileIO: true, permissions: true,
  stream: true, resume: false, rateLimitAware: false, compaction: false,
});
```
并把文件头注释第 1-4 行更新为：
```js
/**
 * OpenAI 兼容 provider：流式对话 + 经 MCP 的 agentic 工具（工具定义/执行由 startOpenAiRun 注入）。
 * 无 MCP 配置时 input.tools 为空 → 自然降级为纯对话。凭证/路由见 server.js startOpenAiRun。
 */
```

- [ ] **E6 — 更新 capabilities 测试.** 在 `src/providers/openai-compat.test.js` 找到：
```js
test('capabilities：v1 只声明 stream，其余为 false', () => {
  assert.equal(OPENAI_COMPAT_CAPABILITIES.stream, true);
  for (const k of ['agentic', 'tools', 'fileIO', 'permissions', 'resume', 'rateLimitAware', 'compaction']) {
    assert.equal(OPENAI_COMPAT_CAPABILITIES[k], false, `${k} v1 应为 false`);
  }
});
```
替换为：
```js
test('capabilities：stream + agentic/tools/fileIO/permissions=true；resume/rateLimitAware/compaction=false', () => {
  for (const k of ['stream', 'agentic', 'tools', 'fileIO', 'permissions']) {
    assert.equal(OPENAI_COMPAT_CAPABILITIES[k], true, `${k} 应为 true`);
  }
  for (const k of ['resume', 'rateLimitAware', 'compaction']) {
    assert.equal(OPENAI_COMPAT_CAPABILITIES[k], false, `${k} 应为 false`);
  }
});
```

- [ ] **Verify + commit:** `node --test "src/providers/*.test.js"`（全绿，含更新后的 capabilities 测试）→ `git add src/providers/openai-compat.js src/providers/openai-compat.test.js && git commit -m "feat(providers): openai-compat 翻开 tools/agentic/fileIO/permissions 能力位"`

---

### Task 3: startOpenAiRun 接 MCP + 审批 + close

- [ ] **E7 — import.** 在 `src/entrypoints/web/server.js` 找到：
```js
import { getMessages, appendMessages } from '../../store/conv-messages.js';
```
在其后加：
```js
import { connectMcpServers } from '../../providers/mcp.js';
```
再在 `from '../../store/settings.js'` 的解构导入里加 `getMcpServers,`（放在 `getSettings,` 附近，例如 `getUiPrefs,` 之后）。

- [ ] **E8 — handleRunStart 分支传 cwd.** 找到：
```js
    if (provider === 'openai-compat') {
      sendJson(res, 200, { runId: run.id, model });
      return startOpenAiRun(run, { prompt, model, convId });
    }
```
替换为：
```js
    if (provider === 'openai-compat') {
      sendJson(res, 200, { runId: run.id, model });
      return startOpenAiRun(run, { prompt, model, cwd, convId });
    }
```

- [ ] **E9 — 重写 startOpenAiRun.** 找到整个 `startOpenAiRun` 函数（`function startOpenAiRun(run, { prompt, model, convId }) {` 到其收尾 `}`，即当前 468-501 行），整体替换为：
```js
/** openai-compat run 路径：无 Claude session，历史走 app 自持 conv-messages 重放；
 *  经 MCP 提供 agentic 工具（每次调用过 canUseTool 审批）；hooks 复用 runs.js SSE/停止/流式。
 *  openai resume=false → 不 addActiveRun（不参与跨重启孤儿恢复）。 */
async function startOpenAiRun(run, { prompt, model, cwd, convId }) {
  run.convId = convId || run.convId || null;
  const cred = pickActive(getTokens(), 'openai-compat'); // { id, token=apiKey, baseURL, model, ... } | null
  if (!cred) return failRun(run, '未配置可用的自定义模型凭证——请到设置页添加 OpenAI 兼容凭证（baseURL + apiKey + model）');
  const history = getMessages(convId); // 已有历史（无 convId 则空）
  const userMsg = { role: 'user', content: prompt };
  if (convId) appendMessages(convId, [userMsg]); // 有会话才持久化 user 消息
  const priorMessages = [...history, userMsg]; // 喂模型的消息始终含本轮 prompt（不依赖 convId）

  // 连 MCP 工具（失败隔离；无配置 → 纯对话）
  let mcp = null;
  const mcpConfigs = getMcpServers().filter((s) => s && s.command && s.enabled !== false);
  if (mcpConfigs.length) {
    try {
      mcp = await connectMcpServers(mcpConfigs, { cwd: cwd || undefined, signal: run.abortController.signal });
    } catch (e) {
      logger.warn('web', 'MCP 连接失败，降级为纯对话', { err: e?.message || String(e) });
      mcp = null;
    }
  }
  const hasTools = !!(mcp && Object.keys(mcp.toolDefs).length);

  const hooks = {
    onText: (t) => runText(run, t),
    onActivity: (a) => runActivity(run, summarizeTool(a)),
    onResult: (info) => runResult(run, info),
    onPulse: () => runPulse(run),
  };
  if (hasTools) {
    // 每个工具调用过审批队列（复用 Claude 路径的允许/拒绝卡 + 并发串行化）
    hooks.canUseTool = async (toolName, input) => {
      const choice = await askUser(run, {
        reqId: nextReqId(run),
        kind: 'permission',
        title: `自定义模型请求执行：${toolName}`,
        body: summarizeTool({ name: toolName, input }),
        options: [
          { id: 'allow', label: '允许' },
          { id: 'deny', label: '拒绝' },
        ],
        defaultChoice: 'deny',
      });
      return choice === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: '用户拒绝了该操作' };
    };
  }

  const handle = providers.get('openai-compat').run(
    {
      messages: priorMessages,
      model: model || cred.model,
      apiKey: cred.token,
      baseURL: cred.baseURL,
      abortController: run.abortController,
      ...(hasTools ? { tools: mcp.toolDefs, executeTool: mcp.executeTool } : {}),
    },
    hooks,
  );
  handle.done
    .then((out) => {
      if (convId && out && Array.isArray(out.messages)) {
        appendMessages(convId, out.messages.slice(priorMessages.length));
      }
      finishRun(run);
    })
    .catch((err) => failRun(run, `自定义模型执行失败：${err?.message || String(err)}`))
    .finally(() => {
      if (mcp) mcp.close();
    });
}
```

- [ ] **Verify V1 — 语法:** `node --check src/entrypoints/web/server.js` → 无输出。
- [ ] **Verify V2 — 单测回归:** `node --test "src/providers/*.test.js" "src/store/settings.test.js"` → 全绿（provider 31 + settings 8）。
- [ ] **Verify V3 — MCP 接线冒烟（无需真模型端点）:** 临时数据目录起服务；写一个 `settings.json` 含 `mcpServers:[{command:'node',args:['<repo>/tests/fixtures/echo-mcp-server.mjs']}]` + 一个 openai 凭证（baseURL 指向本地不可达地址如 `http://127.0.0.1:9/v1` 让模型调用快速失败，避免等 api.openai.com 超时）；`POST /api/run/start {provider:'openai-compat',prompt,convId}`；SSE attach。**期望**：run 因模型端点不可达而 failRun（证明走到了 provider.run），且服务端日志无"MCP 连接失败"（证明 echo server 连上了）、无进程泄漏报错（close 生效）。真正"模型调用工具→审批→执行"闭环需真实端点，本步只验 MCP 连接+降级+close 管线；若起服困难退化为 V1+V2 + 人工核对，注明。
- [ ] **Verify V4 — 无 MCP 回归:** 清空 `mcpServers`（或不配）重跑 openai run → 确认无 tools、纯对话路径与片 C 一致。
- [ ] **提交:** `git add src/entrypoints/web/server.js && git commit -m "feat(web): startOpenAiRun 接 MCP 工具 + canUseTool 审批 + close 生命周期"`

---

## 自检
- 无 MCP → `hasTools=false` → 不传 tools/executeTool、不装 canUseTool → 纯对话（片 C 不变）。
- 审批：MCP 工具全过 askUser（安全优先，无 READONLY 白名单）→ pendingQueue 复用。
- 生命周期：`.finally(close)` 覆盖成功/失败/abort。
- capabilities 静态 true = "provider 支持工具"；实际有无取决于运行时 MCP 配置。
- Claude 路径零改动。
## 遗留（3d-3 / 后续）：MCP 配置写 API + 前端 tab；按工具名自动放行白名单；真实端点 e2e（模型真调用工具）；toolCallId 用合成值（可追溯性，后续可透传真实 id）。
## 提交纪律：每 Task 只 add 列出文件，不用 `git add -A`；分支 `feat/config-import-export`。

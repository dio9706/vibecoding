# Provider 抽象 · Phase 3b-2 片 B（OpenAI 凭证 CRUD API）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/api/credentials` 端点，让 openai-compat 凭证（label/apiKey/baseURL/model）能增删改查——复用 store 层已就绪的 `addToken(...,{baseURL,model})`/`updateTokenMeta`/`removeToken`/`getTokens`，只在 web 入口加 HTTP 处理器 + 路由。

**Architecture:** 专用 `/api/credentials` 端点（不动现有 Claude token 流），4 个处理器镜像现有 `handleTokens*` 的 `req.on('data'/'end')+sendJson` 模式；掩码用 `token-rotation.maskToken`。凭证按 `providerId==='openai-compat'` 过滤。server.js handler 无单测惯例 → 验证走 `node --check` + 脚本冒烟（临时 APP_DATA_DIR，起服务→增/查/改/删→杀）。

**Tech Stack:** Node.js ESM；http。

## 本期范围（对照 3b spec 模块 1）
openai 凭证 CRUD API。**不含** startOpenAiRun/路由（片 C）、前端（3c）。

## 文件结构
- Modify `src/entrypoints/web/server.js` — 导入加 `maskToken`；加 4 个 `handleCredentials*` + `cleanCredentialPatch`；路由表加 4 行。

---

### Task 1: 凭证 CRUD 处理器 + 路由

**Files:**
- Modify: `src/entrypoints/web/server.js`

- [ ] **Step 1: 导入 maskToken** — 在 `from '../../features/token-rotation.js'` 的解构导入里，`getTokenById,` 之后加一行 `maskToken,`：

找到：
```js
  getActiveTokenId,
  getTokenById,
} from '../../features/token-rotation.js';
```
改为：
```js
  getActiveTokenId,
  getTokenById,
  maskToken,
} from '../../features/token-rotation.js';
```

- [ ] **Step 2: 加路由** — 在 `if (url.pathname === '/api/tokens/dismiss') return handleTokensDismiss(req, res);` 之后加 4 行：

```js
  if (url.pathname === '/api/credentials' && req.method === 'GET') return handleCredentialsList(res);
  if (url.pathname === '/api/credentials' && req.method === 'POST') return handleCredentialsAdd(req, res);
  if (url.pathname.startsWith('/api/credentials/') && req.method === 'PUT') return handleCredentialsUpdate(req, res, url);
  if (url.pathname.startsWith('/api/credentials/') && req.method === 'DELETE') return handleCredentialsDelete(req, res, url);
```

- [ ] **Step 3: 加处理器** — 在 `handleTokensSwitch` 函数结束（约第 801 行 `}` ）之后插入：

```js
/** 仅取凭证 update 允许字段，防前端塞入 status 等 */
function cleanCredentialPatch(data) {
  const patch = {};
  if (typeof data.label === 'string') patch.label = data.label.trim();
  if (typeof data.apiKey === 'string' && data.apiKey.trim()) patch.token = data.apiKey.trim();
  if (typeof data.baseURL === 'string') patch.baseURL = data.baseURL.trim();
  if (typeof data.model === 'string') patch.model = data.model.trim();
  return patch;
}

/** GET /api/credentials —— 列出 openai-compat 凭证（apiKey 掩码） */
function handleCredentialsList(res) {
  const creds = getTokens()
    .filter((t) => (t.providerId || 'claude-agent') === 'openai-compat')
    .map((t) => ({
      id: t.id,
      label: t.label,
      baseURL: t.baseURL || '',
      model: t.model || '',
      masked: maskToken(t.token),
      status: t.status,
    }));
  sendJson(res, 200, { credentials: creds });
}

/** POST /api/credentials —— 新增 openai-compat 凭证 { label, apiKey, baseURL, model } */
function handleCredentialsAdd(req, res) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let data;
    try {
      data = JSON.parse(body || '{}');
    } catch {
      return sendJson(res, 400, { error: 'invalid json' });
    }
    const apiKey = (data.apiKey || '').trim();
    const baseURL = (data.baseURL || '').trim();
    const model = (data.model || '').trim();
    if (!apiKey || !baseURL || !model) return sendJson(res, 400, { error: 'apiKey / baseURL / model 均必填' });
    const label = (data.label || '').trim();
    addToken(label, apiKey, 'openai-compat', { baseURL, model });
    logger.info('web', '[POST /api/credentials] 新增自定义模型凭证', { label: label || '(默认)', baseURL, model });
    sendJson(res, 200, { ok: true });
  });
}

/** PUT /api/credentials/:id —— 局部更新 */
function handleCredentialsUpdate(req, res, url) {
  const id = decodeURIComponent(url.pathname.slice('/api/credentials/'.length));
  if (!id || !getTokenById(id)) return sendJson(res, 404, { error: 'credential not found' });
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let data;
    try {
      data = JSON.parse(body || '{}');
    } catch {
      return sendJson(res, 400, { error: 'invalid json' });
    }
    updateTokenMeta(id, cleanCredentialPatch(data));
    sendJson(res, 200, { ok: true });
  });
}

/** DELETE /api/credentials/:id */
function handleCredentialsDelete(req, res, url) {
  const id = decodeURIComponent(url.pathname.slice('/api/credentials/'.length));
  if (!id || !getTokenById(id)) return sendJson(res, 404, { error: 'credential not found' });
  removeToken(id);
  logger.info('web', '[DELETE /api/credentials] 删除凭证', { id });
  sendJson(res, 200, { ok: true });
}
```

- [ ] **Step 4: 语法检查** — Run: `node --check src/entrypoints/web/server.js` — Expected: 无输出（成功）。

- [ ] **Step 5: 脚本冒烟（临时数据目录，不污染真实 settings.json）** — 在临时目录起服务跑一次增→查→改→删，确认端点闭环。用一次性 shell（Git Bash）：

```bash
cd "C:/Users/DELL/Desktop/claude-p-web-demo"
export APP_DATA_DIR="$(mktemp -d)"
export PORT=3999
node server.js &  SRV=$!
sleep 2
echo "--- add ---"; curl -s -X POST localhost:3999/api/credentials -H 'Content-Type: application/json' -d '{"label":"DeepSeek","apiKey":"sk-test-123","baseURL":"https://api.deepseek.com","model":"deepseek-chat"}'
echo; echo "--- list ---"; curl -s localhost:3999/api/credentials
echo; echo "--- delete (取上一步 list 里的 id 手动填) ---"
kill $SRV 2>/dev/null; rm -rf "$APP_DATA_DIR"
```
Expected: add 返回 `{"ok":true}`；list 返回含一条 `{label:"DeepSeek", baseURL:"https://api.deepseek.com", model:"deepseek-chat", masked:"sk-test…-123"（掩码）, status:"healthy"}` 的 `credentials` 数组（apiKey 不明文回显）。若 `server.js` 因缺 `.env`/其他原因起不来，退化为仅 `node --check` 通过 + 人工核对处理器逻辑，并在报告注明。

- [ ] **Step 6: 提交**
```bash
git add src/entrypoints/web/server.js
git commit -m "feat(web): /api/credentials CRUD（openai 兼容凭证增删改查）"
```

## 自检
- CRUD 齐全（GET/POST/PUT/DELETE）；apiKey 掩码不明文回显；providerId 过滤只列 openai-compat；复用 store 层函数不动 Claude token 流。
- 校验：add 强制 apiKey/baseURL/model；PUT/DELETE 校验 id 存在。
- 命名一致：`handleCredentialsList/Add/Update/Delete`、`cleanCredentialPatch`。
## 提交纪律：只 add `server.js`，不用 `git add -A`；分支 `feat/config-import-export`。

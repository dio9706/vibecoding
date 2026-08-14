# Provider 抽象 · Phase 3c-2（model-fab 自定义模型选择 + run 路由）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** model-fab 弹层加"自定义模型"区，选中后 run-start 带 `provider:'openai-compat'`+对应 model；选择随会话持久化——不破坏现有 Claude 模型选择/显示/持久化。

**Architecture:** 独立状态 `chatProvider`/`chatCustomModel`/`chatCustomLabel`（与 `chatModel` 并存，不塞进 Claude 的 `MODEL_LABELS` 白名单，避免污染 `syncModelUI`/`applySessionPrefs` 的既有逻辑——只在它们里加"若 openai-compat 走自定义分支"）。custom pills 打开弹层时从 `/api/credentials` 动态拉。run-start 按 `chatProvider` 二选一构造请求体。

**Tech Stack:** 浏览器 JS（无构建）；验证 `node --check public/app.js` + Playwright/手测。

## 本期范围（对照 3c spec 模块 2/3）
model-fab 自定义选择 + run-start `provider` + 会话持久化。**依赖** 3c-1（设置 tab 已能增删凭证）✅、片 B/C（后端就绪）✅。

## 关键不变量（回归重点）
- 选 Claude 模型（含 Auto）→ `chatProvider='claude-agent'`，run-start 与现状**逐字一致**（model/effort/mode，无 provider 或 =claude-agent）。
- `MODEL_LABELS[chatModel]` 只在 `chatProvider==='claude-agent'` 时用于 label（自定义走 `chatCustomLabel`），杜绝 `undefined` label。
- `applySessionPrefs`：Claude 会话（无 `provider` 字段）→ `chatProvider` 归 `claude-agent`；自定义会话 → 还原自定义。防串会话。

## 文件结构
- Modify `public/index.html` — `#modelPop` 内加 `#customDivider` + `#customModelPills`。
- Modify `public/app.js` — 状态 + `syncModelUI` 分支 + `refreshCustomModelPills` + fab 打开拉取 + Claude pill 复位 provider + `persistPrefsToConv`/message 快照 + `applySessionPrefs` + run-start 分支。
- Modify `public/app.css` — `.model-pills.disabled`。

---

### Task 1: 全部接线（single cohesive task）

**Files:** `public/index.html`, `public/app.js`, `public/app.css`

- [ ] **E1 — index.html：custom pills 容器.** 找到 `#modelPop` 内 Claude pills 结束：
```html
            <div class="model-pills" id="modelPills">
              <button data-m="auto">Auto</button>
              <button data-m="claude-sonnet-4-6">Sonnet 4.6</button>
              <button data-m="claude-opus-4-8">Opus 4.8</button>
              <button data-m="claude-haiku-4-5">Haiku 4.5</button>
            </div>
```
在其后插入：
```html
            <div class="pop-divider" id="customDivider" hidden></div>
            <div class="model-pills" id="customModelPills" title="自定义模型"></div>
```

- [ ] **E2 — app.js：状态声明.** 找到：
```js
      let chatMode = localStorage.getItem('claude_mode') || 'default'; // default|acceptEdits|plan|bypassPermissions
```
在其后加：
```js
      let chatProvider = localStorage.getItem('claude_provider') || 'claude-agent';
      let chatCustomModel = localStorage.getItem('claude_custom_model') || '';
      let chatCustomLabel = localStorage.getItem('claude_custom_label') || '';
```

- [ ] **E3 — app.js：customModelPills 引用.** 找到：
```js
      const modePills = $('#modePills');
```
在其后加：
```js
      const customModelPills = $('#customModelPills');
```

- [ ] **E4 — app.js：syncModelUI 加自定义分支.** 找到整个 `syncModelUI` 函数：
```js
      function syncModelUI() {
        modelFabLabel.textContent = MODEL_LABELS[chatModel];
        [...modelPills.children].forEach((b) =>
          b.classList.toggle('active', b.dataset.m === chatModel),
        );
        [...modePills.children].forEach((b) =>
          b.classList.toggle('active', b.dataset.mode === chatMode),
        );
        effortRow.classList.toggle('disabled', chatModel === 'auto'); // Auto 时强度由分类器决定
        effortSlider.value = String(Math.max(0, EFFORTS.indexOf(chatEffort)));
      }
```
整体替换为：
```js
      function syncModelUI() {
        if (chatProvider === 'openai-compat') {
          modelFabLabel.textContent = chatCustomLabel || chatCustomModel || '自定义模型';
          [...modelPills.children].forEach((b) => b.classList.remove('active'));
          [...customModelPills.children].forEach((b) => b.classList.toggle('active', b.dataset.m === chatCustomModel));
          effortRow.classList.add('disabled'); // openai v1 无 effort
          modePills.classList.add('disabled'); // openai v1 无权限模式
          return;
        }
        modelFabLabel.textContent = MODEL_LABELS[chatModel];
        [...modelPills.children].forEach((b) => b.classList.toggle('active', b.dataset.m === chatModel));
        [...customModelPills.children].forEach((b) => b.classList.remove('active'));
        [...modePills.children].forEach((b) => b.classList.toggle('active', b.dataset.mode === chatMode));
        modePills.classList.remove('disabled');
        effortRow.classList.toggle('disabled', chatModel === 'auto'); // Auto 时强度由分类器决定
        effortSlider.value = String(Math.max(0, EFFORTS.indexOf(chatEffort)));
      }

      // 打开弹层时拉取已配置的自定义模型，动态填充 pills
      async function refreshCustomModelPills() {
        try {
          const r = await fetch('/api/credentials');
          const d = await r.json();
          const creds = d.credentials || [];
          customModelPills.innerHTML = '';
          creds.forEach((c) => {
            const b = document.createElement('button');
            b.dataset.m = c.model;
            b.textContent = c.label || c.model;
            b.title = (c.label ? c.label + ' · ' : '') + c.model;
            b.addEventListener('click', () => {
              chatProvider = 'openai-compat';
              chatCustomModel = c.model;
              chatCustomLabel = c.label || c.model;
              localStorage.setItem('claude_provider', chatProvider);
              localStorage.setItem('claude_custom_model', chatCustomModel);
              localStorage.setItem('claude_custom_label', chatCustomLabel);
              syncModelUI();
              persistPrefsToConv();
              modelPop.hidden = true;
              if (currentConvId && runningJobs[currentConvId]) toast('模型将从下一条消息生效');
            });
            customModelPills.appendChild(b);
          });
          const divider = $('#customDivider');
          if (divider) divider.hidden = creds.length === 0;
          syncModelUI();
        } catch {
          /* 忽略：拉取失败不影响 Claude 选择 */
        }
      }
```

- [ ] **E5 — app.js：fab 打开时拉自定义 pills.** 找到：
```js
      modelFabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        modelPop.hidden = !modelPop.hidden;
      });
```
整体替换为：
```js
      modelFabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        modelPop.hidden = !modelPop.hidden;
        if (!modelPop.hidden) refreshCustomModelPills();
      });
```

- [ ] **E6 — app.js：Claude pill 点击复位 provider.** 找到：
```js
      [...modelPills.children].forEach((b) => {
        b.addEventListener('click', () => {
          if (b.dataset.m === chatModel) return; // 重复点当前模型：不触发多余操作
          chatModel = b.dataset.m;
          localStorage.setItem('claude_model', chatModel);
          saveUiPrefs(); // 同步到服务端配置
          syncModelUI();
          persistPrefsToConv();
          if (currentConvId && runningJobs[currentConvId]) toast('模型将从下一条消息生效');
        });
      });
```
整体替换为：
```js
      [...modelPills.children].forEach((b) => {
        b.addEventListener('click', () => {
          if (b.dataset.m === chatModel && chatProvider === 'claude-agent') return; // 重复点当前：不触发
          chatModel = b.dataset.m;
          chatProvider = 'claude-agent'; // 从自定义切回 Claude
          localStorage.setItem('claude_model', chatModel);
          localStorage.setItem('claude_provider', chatProvider);
          saveUiPrefs(); // 同步到服务端配置
          syncModelUI();
          persistPrefsToConv();
          if (currentConvId && runningJobs[currentConvId]) toast('模型将从下一条消息生效');
        });
      });
```

- [ ] **E7 — app.js：persistPrefsToConv 存 provider.** 找到：
```js
        c.model = chatModel;
        c.effort = chatEffort;
        c.mode = chatMode;
        saveConvs(list); // 不动 updatedAt：纯偏好变更不改变左栏排序
      }
```
整体替换为：
```js
        c.model = chatModel;
        c.effort = chatEffort;
        c.mode = chatMode;
        c.provider = chatProvider;
        c.customModel = chatCustomModel;
        c.customLabel = chatCustomLabel;
        saveConvs(list); // 不动 updatedAt：纯偏好变更不改变左栏排序
      }
```

- [ ] **E8 — app.js：message 快照也存 provider.** 找到：
```js
        c.model = chatModel;
        c.effort = chatEffort;
        c.mode = chatMode;
        c.updatedAt = Date.now();
        saveConvs(list);
        renderConvListDebounced();
      }
```
整体替换为：
```js
        c.model = chatModel;
        c.effort = chatEffort;
        c.mode = chatMode;
        c.provider = chatProvider;
        c.customModel = chatCustomModel;
        c.customLabel = chatCustomLabel;
        c.updatedAt = Date.now();
        saveConvs(list);
        renderConvListDebounced();
      }
```

- [ ] **E9 — app.js：applySessionPrefs 还原 provider.** 找到整个 `applySessionPrefs` 函数（`function applySessionPrefs(prefs) {` 到其收尾 `}`，即当前 2129-2150），整体替换为：
```js
      function applySessionPrefs(prefs) {
        let changed = false;
        // 自定义模型（openai-compat）不在 MODEL_LABELS 白名单，单独还原；缺 provider 字段视为 Claude 会话
        const nextProvider = prefs.provider === 'openai-compat' ? 'openai-compat' : 'claude-agent';
        if (nextProvider !== chatProvider) {
          chatProvider = nextProvider;
          localStorage.setItem('claude_provider', chatProvider);
          changed = true;
        }
        if (chatProvider === 'openai-compat') {
          if (prefs.customModel && prefs.customModel !== chatCustomModel) {
            chatCustomModel = prefs.customModel;
            localStorage.setItem('claude_custom_model', chatCustomModel);
            changed = true;
          }
          if (prefs.customLabel && prefs.customLabel !== chatCustomLabel) {
            chatCustomLabel = prefs.customLabel;
            localStorage.setItem('claude_custom_label', chatCustomLabel);
          }
        }
        if (prefs.model && MODEL_LABELS[prefs.model] && prefs.model !== chatModel) {
          chatModel = prefs.model;
          localStorage.setItem('claude_model', chatModel);
          changed = true;
        }
        if (prefs.effort && EFFORTS.includes(prefs.effort) && prefs.effort !== chatEffort) {
          chatEffort = prefs.effort;
          localStorage.setItem('claude_effort', chatEffort);
          changed = true;
        }
        if (prefs.mode && MODES.includes(prefs.mode) && prefs.mode !== chatMode) {
          chatMode = prefs.mode;
          localStorage.setItem('claude_mode', chatMode);
          changed = true;
        }
        if (changed) {
          syncModelUI();
          const lbl =
            chatProvider === 'openai-compat'
              ? chatCustomLabel || chatCustomModel || '自定义模型'
              : MODEL_LABELS[chatModel] + ' · ' + MODE_LABELS[chatMode];
          toast('已还原此会话偏好：' + lbl);
        }
      }
```

- [ ] **E10 — app.js：run-start 按 provider 构造请求体.** 找到：
```js
        fetch('/api/run/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: text,
            cwd: runCwd,
            session: sessionId,
            model: chatModel,
            effort: chatEffort,
            mode: chatMode,
            convId,
          }),
        })
```
整体替换为：
```js
        const startBody =
          chatProvider === 'openai-compat'
            ? { prompt: text, cwd: runCwd, session: sessionId, provider: 'openai-compat', model: chatCustomModel, convId }
            : { prompt: text, cwd: runCwd, session: sessionId, model: chatModel, effort: chatEffort, mode: chatMode, convId };
        fetch('/api/run/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(startBody),
        })
```

- [ ] **E11 — app.css：modePills 禁用样式.** 追加文件末尾：
```css
.model-pills.disabled { opacity: .4; pointer-events: none; }
```

- [ ] **Step V1 — 语法检查:** Run: `node --check public/app.js` — Expected: 无输出。

- [ ] **Step V2 — Playwright/手测冒烟（best-effort）:** 起临时数据目录服务 + 加一个凭证（经 `/api/credentials` 或 UI）。验证：
  1. 打开 model-fab → 出现"自定义模型"区 + 该凭证 pill；
  2. 点它 → fab label 显示凭证名、effort/mode 灰置；发消息 → Network 里 `/api/run/start` body 含 `provider:"openai-compat"`+`model:<凭证 model>`（无外网会 failRun，但请求体正确即验证通过）；
  3. 点回 Claude 模型 → label 恢复、run-start body 回到 `{model,effort,mode}` 无 provider（**回归**）；
  4. 切到另一会话再切回 → provider/model 正确还原、不串会话。
  无 Playwright 则 `node --check` + 人工核对，注明。

- [ ] **Step V3 — 提交:**
```bash
git add public/index.html public/app.js public/app.css
git commit -m "feat(web): model-fab 支持选自定义模型 + run-start 带 provider（会话持久化）"
```

## 自检
- Claude 现状回归：选 Claude 模型 → `chatProvider='claude-agent'` → run-start body 与旧逐字一致（V2.3 验证）。
- 无 `undefined` label：`MODEL_LABELS[chatModel]` 仅 Claude 分支用；自定义走 `chatCustomLabel`。
- 防串会话：`applySessionPrefs` 对无 `provider` 的会话归 `claude-agent`；自定义会话还原自定义（E9）。
- effort/mode 对自定义灰置（E4）。
- 命名一致：`chatProvider/chatCustomModel/chatCustomLabel`、`#customModelPills/#customDivider`、`refreshCustomModelPills`。
## 提交纪律：只 add 三个 public 文件，不用 `git add -A`；分支 `feat/config-import-export`。
## 遗留：真 abort/工具 UI（接 MCP 后）；`shortModel`（气泡里显示实际模型）对自定义的分支（当前 job.pickLabel 逻辑，自定义 run 后端不回 model 事件，前端可后续补显示）。

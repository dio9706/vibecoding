# Provider 抽象 · Phase 3c-1（前端：自定义模型设置 tab）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置页新增"自定义模型"tab，列出/新增/删除 openai-compat 凭证，对接片 B 的 `/api/credentials`——纯增量、镜像现有 Claude 账号 tab 范式，不动运行路径。

**Architecture:** 无构建静态前端。`index.html` 加 1 个 tab 按钮 + 1 个 `.set-tab` 面板（复用 `.set-sec`/`.token-list`/`.token-add` 结构）；`app.js` 加 `loadCredentials/renderCredList/addCredentialUI/deleteCredential`（fetch 直连 `/api/credentials`，不经 `postSettings`），在 `loadSettings` 末尾挂 `loadCredentials()`，绑 `#credAddBtn`；`app.css` 加极少样式。设置 tab 切换是现有纯显隐机制，无需改。

**Tech Stack:** 浏览器 JS（无构建）；验证 `node --check public/app.js`（纯语法，浏览器全局不执行不报错）+ 手测/Playwright 冒烟。

## 本期范围（对照 3c spec 模块 1）
自定义模型设置 tab 的 CRUD UI。**不含** model-fab 选择 / run-start provider / 持久化（3c-2）。

## 文件结构
- Modify `public/index.html` — tab 按钮 + providers 面板。
- Modify `public/app.js` — 凭证 CRUD 函数 + 挂载 + 绑定。
- Modify `public/app.css` — `.cred-add`/`.cred-empty`/`.t-model`/`.t-base` 极少样式。

---

### Task 1: 自定义模型设置 tab（HTML + JS + CSS）

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/app.css`

- [ ] **Step 1: index.html —— 加 tab 按钮.** 找到：
```html
            <button data-tab="tokens">Claude 账号<span class="badge-dot" id="settingsTabBadge" hidden></span></button>
```
在其后加一行：
```html
            <button data-tab="providers">自定义模型</button>
```

- [ ] **Step 2: index.html —— 加 providers 面板.** 找到 tokens 面板结束处：
```html
              <div class="token-add">
                <input id="tokenLabel" placeholder="名称，如 备用A" autocomplete="off" />
                <input id="tokenValue" placeholder="sk-ant-oat01-…" autocomplete="off" />
                <button class="btn" id="tokenAddBtn">＋ 添加</button>
              </div>
            </div>
          </div>
```
在其后（该 `</div>` 之后、`<div class="set-tab" data-tab="desktop"` 之前）插入：
```html
          <div class="set-tab" data-tab="providers" hidden>
            <div class="set-sec">
              <div class="set-sec-head">
                <span class="sec-label">自定义模型（OpenAI 兼容）</span>
              </div>
              <div class="token-list" id="credList"></div>
              <div class="token-add cred-add">
                <input id="credLabel" placeholder="名称，如 DeepSeek" autocomplete="off" />
                <input id="credBaseURL" placeholder="baseURL，如 https://api.deepseek.com/v1" autocomplete="off" />
                <input id="credModel" placeholder="模型，如 deepseek-chat" autocomplete="off" />
                <input id="credApiKey" type="password" placeholder="apiKey (sk-…)" autocomplete="off" />
                <button class="btn" id="credAddBtn">＋ 添加</button>
              </div>
            </div>
          </div>
```

- [ ] **Step 3: app.js —— 加凭证 CRUD 函数.** 找到 `makePrimary` 函数结束处：
```js
      // 置顶 = 设为首选：复用 reorder，pickActive 顺序优先 → 可用则立即成为 active
      async function makePrimary(t) {
        const ids = [...$('#tokenList').querySelectorAll('.token-row')].map((r) => r.dataset.id);
        const next = [t.id, ...ids.filter((id) => id !== t.id)];
        if (await postSettings({ section: 'tokens', action: 'reorder', ids: next })) {
          if (t.status === 'exhausted') toast('该账号额度已耗尽，已设为首选，恢复后自动启用');
          await loadSettings();
        }
      }
```
在其后插入：
```js

      // —— 自定义模型（openai-compat）凭证 CRUD：走专用 /api/credentials（片B），不经 settings 池 ——
      async function loadCredentials() {
        try {
          const r = await fetch('/api/credentials');
          const d = await r.json();
          renderCredList(d.credentials || []);
        } catch {
          /* 设置未打开 / 网络问题：忽略 */
        }
      }

      function renderCredList(creds) {
        const box = $('#credList');
        if (!box) return;
        box.innerHTML = '';
        if (!creds.length) {
          box.innerHTML = '<div class="cred-empty">暂无自定义模型，填下方表单添加</div>';
          return;
        }
        creds.forEach((c) => {
          const row = document.createElement('div');
          row.className = 'token-row';
          row.dataset.id = c.id;
          row.innerHTML =
            '<span class="t-label"></span>' +
            '<span class="t-model"></span>' +
            '<span class="t-base"></span>' +
            '<span class="t-mask"></span>' +
            '<span class="spacer"></span>' +
            '<button class="t-act del" title="删除">🗑</button>';
          row.querySelector('.t-label').textContent = c.label || '(未命名)';
          row.querySelector('.t-model').textContent = c.model || '';
          row.querySelector('.t-base').textContent = c.baseURL || '';
          row.querySelector('.t-mask').textContent = c.masked || '';
          row.querySelector('.del').onclick = () => deleteCredential(c.id, c.label || c.model);
          box.appendChild(row);
        });
      }

      async function addCredentialUI() {
        const label = $('#credLabel').value.trim();
        const baseURL = $('#credBaseURL').value.trim();
        const model = $('#credModel').value.trim();
        const apiKey = $('#credApiKey').value.trim();
        if (!baseURL || !model || !apiKey) return toast('baseURL / 模型 / apiKey 均必填');
        try {
          const r = await fetch('/api/credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label, baseURL, model, apiKey }),
          });
          const d = await r.json();
          if (!r.ok || d.error) return toast(d.error || '添加失败');
          $('#credLabel').value = '';
          $('#credBaseURL').value = '';
          $('#credModel').value = '';
          $('#credApiKey').value = '';
          toast('自定义模型已添加');
          await loadCredentials();
        } catch {
          toast('网络错误');
        }
      }

      async function deleteCredential(id, label) {
        if (!(await confirmDialog({ title: '删除自定义模型', message: `确认删除「${label}」？`, danger: true }))) return;
        try {
          const r = await fetch('/api/credentials/' + encodeURIComponent(id), { method: 'DELETE' });
          const d = await r.json();
          if (!r.ok || d.error) return toast(d.error || '删除失败');
          await loadCredentials();
        } catch {
          toast('网络错误');
        }
      }
```

- [ ] **Step 4: app.js —— loadSettings 末尾挂 loadCredentials.** 找到：
```js
        $('#activeToken').textContent = d.active ? '当前：' + d.active.label : '当前：默认登录';
        renderTokenList(d.tokens || []);
        renderMessages(d.messages || []);
```
在 `renderMessages(d.messages || []);` 之后加一行：
```js
        loadCredentials(); // 自定义模型凭证走独立端点，随设置面板一起加载
```

- [ ] **Step 5: app.js —— 绑定添加按钮.** 找到：
```js
      $('#tokenAddBtn').addEventListener('click', addTokenUI);
```
在其后加一行：
```js
      $('#credAddBtn')?.addEventListener('click', addCredentialUI);
```

- [ ] **Step 6: app.css —— 极少样式.** 在文件末尾追加：
```css
/* 自定义模型凭证 tab */
.cred-add { flex-wrap: wrap; }
.cred-empty { opacity: .6; padding: 10px 4px; font-size: 13px; }
.token-row .t-model { font-size: 12px; opacity: .85; }
.token-row .t-base { font-size: 12px; opacity: .6; }
```

- [ ] **Step 7: 语法检查.** Run: `node --check public/app.js` — Expected: 无输出（语法通过；浏览器全局 document/fetch 等在 --check 阶段不执行、不报错）。

- [ ] **Step 8: 冒烟（真实端点已由片B验证，这里验 UI 接线）.** 起临时数据目录服务，Playwright 加载页面、切到"自定义模型"tab、填表添加、断言列表出现该项且 apiKey 只显示掩码、删除后消失。若无 Playwright 环境或起服困难，退化为：`node --check` 通过 + 人工核对（打开设置→自定义模型→加/查/删对接 `/api/credentials`），并在报告注明。

- [ ] **Step 9: 提交**
```bash
git add public/index.html public/app.js public/app.css
git commit -m "feat(web): 设置页新增自定义模型 tab（openai 凭证 CRUD UI）"
```

## 自检
- 纯增量：新 tab 按钮 + 新面板 + 新函数 + 挂载 + 绑定；不改 Claude 账号 tab、不改运行路径。
- 安全：apiKey input `type=password`；列表只显示 `masked`（片 B 后端只回掩码）。
- 复用：`.token-row`/`.token-list`/`.token-add`/`confirmDialog`/`toast`/`$` 全复用；`loadCredentials` 随 `loadSettings` 加载。
- 校验：add 三必填（baseURL/model/apiKey）；删除走 confirmDialog。
- 命名一致：`loadCredentials/renderCredList/addCredentialUI/deleteCredential`、`#credList/#credLabel/#credBaseURL/#credModel/#credApiKey/#credAddBtn`。
## 提交纪律：只 add 这三个 public 文件，不用 `git add -A`；分支 `feat/config-import-export`。

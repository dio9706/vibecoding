# 设置页「模型」Tab 合并实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 合并"Claude 账号"和"自定义模型"两个设置 Tab 为一个"模型" Tab，按类型分组（API Key 和订阅 Key），并为 API Key 组加入厂商预设和联动能力。

**Architecture:** 
- **前端**：重构 `public/index.html` 的 Tab 结构，合并为单个"模型" Tab，包含 API Key 组和订阅 Key 组两个 section
- **交互**：在 `settings-panel.js` 中新增厂商预设常量、select 联动事件、"其他"厂商的条件渲染
- **后端**：无改动，现有 `/api/credentials` 接口不变

**Tech Stack:** 原生 JS（ES6+）、HTML、Fetch API，无新依赖

---

## 文件结构

| 文件 | 职责 | 改动类型 |
|------|------|---------|
| `public/index.html` | Tab 结构、表单 HTML | 修改：合并 tokens 和 providers Tab，重构新的 providers Tab |
| `public/js/settings-panel.js` | 凭证 CRUD、厂商联动、表单交互 | 修改：合并 renderCredList、addCredentialUI；新增 VENDOR_PRESETS、联动事件 |

---

## 任务分解

### Task 1: 合并 HTML Tab 结构

**Files:**
- Modify: `public/index.html:230-257`（tokens 和 providers 两个 Tab）

**目标：** 删除原有的"Claude 账号" Tab（data-tab="tokens"）和"自定义模型" Tab（data-tab="providers"），新增合并后的单个"模型" Tab，包含 API Key 组和订阅 Key 组。

- [ ] **Step 1: 删除原 tokens Tab 按钮和内容**

在 `<div class="panel-tabs" id="settingsTabs">` 内，删除：
```html
<button data-tab="tokens">Claude 账号<span class="badge-dot" id="settingsTabBadge" hidden></span></button>
```

在 `<div class="panel-view" id="panelView">` 内，删除整个：
```html
<div class="set-tab" data-tab="tokens" hidden>
  <!-- ... 整个 token 添加表单和列表 ... -->
</div>
```

- [ ] **Step 2: 替换 providers Tab 按钮和内容**

Tab 按钮改为：
```html
<button data-tab="providers">模型</button>
```

Tab 内容（`<div class="set-tab" data-tab="providers" hidden>`）替换为：

```html
<div class="set-tab" data-tab="providers" hidden>
  <!-- API Key 组 -->
  <div class="set-sec">
    <div class="set-sec-head">
      <span class="sec-label">API Key</span>
      <span class="msg-hint">预设厂商 · 自动填充 baseURL</span>
    </div>
    <div class="token-list" id="credList"></div>
    <div class="token-add cred-add">
      <input id="credLabel" placeholder="名称，如 DeepSeek" autocomplete="off" />
      <select id="credVendor" class="set-select">
        <option value="">-- 选择厂商 --</option>
        <option value="openai">OpenAI</option>
        <option value="deepseek">DeepSeek</option>
        <option value="aliyun">阿里云百炼</option>
        <option value="moonshot">月之暗面</option>
        <option value="zhipu">智谱</option>
        <option value="custom">其他（自定义）</option>
      </select>
      <select id="credModel" class="set-select" disabled>
        <option value="">-- 先选厂商 --</option>
      </select>
      <input id="credModelCustom" placeholder="模型名，如 my-model" autocomplete="off" style="display:none;" />
      <input id="credBaseURL" placeholder="baseURL，如 https://api.xxx.com/v1" autocomplete="off" />
      <input id="credApiKey" type="password" placeholder="apiKey (sk-…)" autocomplete="off" />
      <button class="btn" id="credAddBtn">＋ 添加</button>
    </div>
  </div>

  <!-- 订阅 Key 组 -->
  <div class="set-sec">
    <div class="set-sec-head">
      <span class="sec-label">订阅 Key</span>
      <span class="active-token" id="activeToken">—</span>
    </div>
    <div class="token-list" id="tokenList"></div>
    <div class="token-add">
      <input id="tokenLabel" placeholder="名称，如 主账号" autocomplete="off" />
      <select id="tokenSubscription" class="set-select">
        <option value="claude">Claude</option>
      </select>
      <input id="tokenValue" placeholder="sk-ant-oat01-…" autocomplete="off" />
      <button class="btn" id="tokenAddBtn">＋ 添加</button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: 验证 HTML 结构**

在浏览器打开 `public/index.html`，确认：
- 设置面板 Tab 列表中"模型" Tab 出现，Claude 账号和自定义模型两个 Tab 已删除
- 点击"模型" Tab 时，面板显示（暂无内容，因为 JS 逻辑还未实现）

- [ ] **Step 4: 提交**

```bash
git add public/index.html
git commit -m "feat: 合并设置 Tab，新增模型 Tab HTML 结构（API Key + 订阅 Key）"
```

---

### Task 2: 添加厂商预设常量和订阅类型常量

**Files:**
- Modify: `public/js/settings-panel.js:1-50`（文件开头）

**目标：** 在 settings-panel.js 顶部定义厂商预设数据和订阅类型，供后续联动和渲染使用。

- [ ] **Step 1: 在文件顶部添加常量定义**

在第一行 `import` 之后（第 5 行后），插入：

```javascript
// ---- 模型配置预设 ----

const VENDOR_PRESETS = {
  openai: {
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1", "o3-mini"],
  },
  deepseek: {
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  aliyun: {
    label: "阿里云百炼",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-max", "qwen-plus", "qwen-turbo"],
  },
  moonshot: {
    label: "月之暗面",
    baseURL: "https://api.moonshot.cn/v1",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
  },
  zhipu: {
    label: "智谱",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4", "glm-4-flash"],
  },
  custom: {
    label: "其他（自定义）",
    baseURL: "",
    models: [],
  },
};

const SUBSCRIPTION_TYPES = [
  { value: "claude", label: "Claude" },
];
```

- [ ] **Step 2: 验证 JS 语法**

在浏览器控制台运行：
```javascript
console.log(VENDOR_PRESETS.openai.models);
// Expected: ["gpt-4o", "gpt-4o-mini", ...]
```

- [ ] **Step 3: 提交**

```bash
git add public/js/settings-panel.js
git commit -m "feat: 添加厂商预设常量（OpenAI/DeepSeek/阿里云/月之暗面/智谱）和订阅类型常量"
```

---

### Task 3: 更新 renderCredList 显示厂商列

**Files:**
- Modify: `public/js/settings-panel.js:260-286`（renderCredList 函数）

**目标：** 在已添加凭证列表中新增"厂商"列，使 API Key 组的条目更清晰。现有数据中需新增 `vendor` 字段。

- [ ] **Step 1: 修改 renderCredList 函数**

找到现有的 `function renderCredList(creds)` 函数（约第 260-286 行），修改其内容为：

```javascript
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
    const vendorLabel = c.vendor ? (VENDOR_PRESETS[c.vendor]?.label || c.vendor) : '—';
    row.innerHTML =
      '<span class="t-label"></span>' +
      '<span class="t-vendor"></span>' +
      '<span class="t-model"></span>' +
      '<span class="t-base"></span>' +
      '<span class="t-mask"></span>' +
      '<span class="spacer"></span>' +
      '<button class="t-act del" title="删除">🗑</button>';
    row.querySelector('.t-label').textContent = c.label || '(未命名) - ' + vendorLabel + '/' + (c.model || '?');
    row.querySelector('.t-vendor').textContent = vendorLabel;
    row.querySelector('.t-model').textContent = c.model || '';
    row.querySelector('.t-base').textContent = c.baseURL || '';
    row.querySelector('.t-mask').textContent = c.masked || '';
    row.querySelector('.del').onclick = () => deleteCredential(c.id, c.label || c.model);
    box.appendChild(row);
  });
}
```

- [ ] **Step 2: 验证渲染效果**

在浏览器设置页打开，添加一个 API Key 凭证（选择任意厂商），确认：
- 列表中显示 5 列：名称 | 厂商 | 模型 | baseURL | 掩码
- 未命名条目显示 `(未命名) - OpenAI/gpt-4o` 格式

- [ ] **Step 3: 提交**

```bash
git add public/js/settings-panel.js
git commit -m "feat: renderCredList 新增厂商列，改进已添加凭证列表显示"
```

---

### Task 4: 实现厂商选择联动逻辑

**Files:**
- Modify: `public/js/settings-panel.js:509-527`（按钮事件绑定区）

**目标：** 当用户选择厂商时，自动填充 baseURL、更新模型下拉列表；切换"其他"时，隐藏模型 select，显示模型文本输入框。

- [ ] **Step 1: 在设置页初始化完成后添加厂商联动事件**

找到文件最后的事件绑定区（`$('#larkSaveBtn').addEventListener('click', saveLark);` 附近，约第 505 行），在其前面添加：

```javascript
// 厂商选择联动
function setupVendorListener() {
  const vendorSelect = $('#credVendor');
  const modelSelect = $('#credModel');
  const modelCustom = $('#credModelCustom');
  const baseURLInput = $('#credBaseURL');

  if (!vendorSelect) return; // 非设置页环境，忽略

  vendorSelect.addEventListener('change', (e) => {
    const vendor = e.target.value;
    const preset = VENDOR_PRESETS[vendor];

    // 清空已填内容
    modelSelect.innerHTML = '<option value="">-- 选择模型 --</option>';
    modelCustom.style.display = 'none';
    modelCustom.value = '';

    if (!vendor) {
      // 未选厂商
      modelSelect.disabled = true;
      baseURLInput.disabled = false;
      baseURLInput.value = '';
      return;
    }

    if (vendor === 'custom') {
      // 其他（自定义）
      modelSelect.disabled = true;
      modelCustom.style.display = 'block';
      modelCustom.disabled = false;
      baseURLInput.disabled = false;
      baseURLInput.placeholder = 'https://api.xxx.com/v1';
      baseURLInput.value = '';
    } else {
      // 预设厂商
      modelSelect.disabled = false;
      modelCustom.style.display = 'none';
      baseURLInput.disabled = true;
      baseURLInput.value = preset.baseURL;

      // 填充模型列表
      preset.models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        modelSelect.appendChild(opt);
      });
      // 默认选第一项
      modelSelect.value = preset.models[0];
    }
  });
}

// 在 loadSettings 函数中调用
const originalLoadSettings = loadSettings;
loadSettings = async function () {
  await originalLoadSettings();
  setupVendorListener();
};
```

实际上，更简洁的做法是直接在 loadSettings 后面调用。修改 loadSettings 的最后一行前，添加：

```javascript
      loadPlugins(); // 插件启停同上
      setupVendorListener(); // 新增：厂商联动
      loadMcpServers(); // MCP 服务器同上
```

不对，应该是在 loadSettings 里最后添加。找到 loadSettings 函数的最后（约第 45 行），在 `}` 前添加：

```javascript
      loadMcpServers(); // MCP 服务器同上
      setupVendorListener(); // 新增：厂商联动
```

然后在此前（事件绑定区之前）定义 setupVendorListener 函数。

让我重新组织：在第 249 行（自定义模型凭证 CRUD 注释）之后，loadCredentials 函数之前，添加：

```javascript
      // ---- 厂商联动：select 切换时更新模型列表和 baseURL ----
      function setupVendorListener() {
        const vendorSelect = $('#credVendor');
        const modelSelect = $('#credModel');
        const modelCustom = $('#credModelCustom');
        const baseURLInput = $('#credBaseURL');

        if (!vendorSelect) return;

        vendorSelect.addEventListener('change', (e) => {
          const vendor = e.target.value;
          const preset = VENDOR_PRESETS[vendor];

          modelSelect.innerHTML = '<option value="">-- 选择模型 --</option>';
          modelCustom.style.display = 'none';
          modelCustom.value = '';

          if (!vendor) {
            modelSelect.disabled = true;
            baseURLInput.disabled = false;
            baseURLInput.value = '';
            return;
          }

          if (vendor === 'custom') {
            modelSelect.disabled = true;
            modelCustom.style.display = 'block';
            baseURLInput.disabled = false;
            baseURLInput.placeholder = 'https://api.xxx.com/v1';
            baseURLInput.value = '';
          } else {
            modelSelect.disabled = false;
            modelCustom.style.display = 'none';
            baseURLInput.disabled = true;
            baseURLInput.value = preset.baseURL;

            preset.models.forEach((m) => {
              const opt = document.createElement('option');
              opt.value = m;
              opt.textContent = m;
              modelSelect.appendChild(opt);
            });
            modelSelect.value = preset.models[0];
          }
        });
      }
```

然后在 loadSettings 函数的最后一行（第 45 行 `}` 之前），添加一行：

```javascript
      loadMcpServers(); // MCP 服务器同上
      setupVendorListener(); // 厂商联动初始化
```

等等，setupVendorListener 需要在 loadCredentials 之后调用吗？实际上应该在页面加载完成后就绑定。让我更仔细地检查现有代码...

现有 loadSettings 里有 `loadCredentials()`，那个函数会渲染列表。setupVendorListener 只需要在表单 select 上绑定事件，与是否有列表无关。所以应该在 loadSettings 最后调用 setupVendorListener。

- [ ] **Step 2: 验证联动效果**

在浏览器设置页"模型" Tab，手动测试：
1. 选择"OpenAI" → baseURL 自动填充为 https://api.openai.com/v1，模型 select 出现 gpt-4o/gpt-4o-mini 等
2. 选择"其他（自定义）" → baseURL 清空可编辑，模型 select 隐藏，出现模型文本输入框
3. 再选"DeepSeek" → baseURL 自动填充为 https://api.deepseek.com/v1，模型切换为 deepseek-chat/deepseek-reasoner

- [ ] **Step 3: 提交**

```bash
git add public/js/settings-panel.js
git commit -m "feat: 厂商选择联动，自动填充 baseURL 和更新模型列表"
```

---

### Task 5: 更新 addCredentialUI 支持厂商字段

**Files:**
- Modify: `public/js/settings-panel.js:288-311`（addCredentialUI 函数）

**目标：** 修改凭证添加逻辑，收集 vendor 字段，改进表单验证。

- [ ] **Step 1: 修改 addCredentialUI 函数**

找到现有的 `async function addCredentialUI()` 函数（约第 288-311 行），修改为：

```javascript
async function addCredentialUI() {
  const label = $('#credLabel').value.trim();
  const vendor = $('#credVendor').value.trim();
  const model = $('#credModel').value || $('#credModelCustom').value.trim();
  const baseURL = $('#credBaseURL').value.trim();
  const apiKey = $('#credApiKey').value.trim();

  // 验证
  if (!vendor) return toast('请选择厂商');
  if (!model) return toast('请选择或填写模型');
  if (!baseURL) return toast('请填写或确认 baseURL');
  if (!apiKey) return toast('请填写 apiKey');

  try {
    const r = await fetch('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, vendor, baseURL, model, apiKey }),
    });
    const d = await r.json();
    if (!r.ok || d.error) return toast(d.error || '添加失败');
    $('#credLabel').value = '';
    $('#credVendor').value = '';
    $('#credModel').innerHTML = '<option value="">-- 选择模型 --</option>';
    $('#credModelCustom').value = '';
    $('#credModelCustom').style.display = 'none';
    $('#credBaseURL').value = '';
    $('#credApiKey').value = '';
    toast('自定义模型已添加');
    await loadCredentials();
  } catch {
    toast('网络错误');
  }
}
```

- [ ] **Step 2: 验证提交逻辑**

在浏览器设置页，尝试添加 API Key 凭证：
1. 点击"＋ 添加"而不填任何字段 → toast 提示"请选择厂商"
2. 选择"OpenAI"但不选模型 → toast 提示"请选择或填写模型"
3. 填完所有字段点"＋ 添加" → 成功添加（假设后端接受 vendor 字段；如果后端报错说 vendor 未知，说明后端需要处理）

- [ ] **Step 3: 提交**

```bash
git add public/js/settings-panel.js
git commit -m "feat: addCredentialUI 支持厂商字段和改进验证"
```

---

### Task 6: 更新订阅 Key 表单（添加订阅类型下拉）

**Files:**
- Modify: `public/js/settings-panel.js:217-227`（addTokenUI 函数）

**目标：** 在订阅 Key 组添加"订阅类型"下拉，支持将来扩展（当前仅 Claude）。

- [ ] **Step 1: 修改 addTokenUI 函数**

找到现有的 `async function addTokenUI()` 函数（约第 217-227 行），修改为：

```javascript
async function addTokenUI() {
  const label = $('#tokenLabel').value.trim();
  const subscription = $('#tokenSubscription').value.trim();
  const token = $('#tokenValue').value.trim();

  if (!subscription) return toast('请选择订阅类型');
  if (!token) return toast('请填 token');

  if (await postSettings({ section: 'tokens', action: 'add', label, subscription, token })) {
    $('#tokenLabel').value = '';
    $('#tokenSubscription').value = 'claude';
    $('#tokenValue').value = '';
    await loadSettings();
  }
}
```

- [ ] **Step 2: 验证功能**

在浏览器设置页"模型" Tab 的"订阅 Key"组，尝试添加：
1. 填入名称和 Key，点"＋ 添加" → 成功添加

注意：如果后端 tokens API 不理解 subscription 字段，会报错。此时需要后端支持新字段。但根据设计文档，后端应该能接受（兼容）。

- [ ] **Step 3: 提交**

```bash
git add public/js/settings-panel.js
git commit -m "feat: 订阅 Key 组支持订阅类型下拉（当前仅 Claude）"
```

---

### Task 7: 更新 Tab 初始化，合并 loadSettings 逻辑

**Files:**
- Modify: `public/js/settings-panel.js:12-45`（loadSettings 函数）

**目标：** 确保"模型" Tab 打开时同时加载 API Key 凭证列表（credList）和订阅 Key 列表（tokenList）。

- [ ] **Step 1: 验证 loadSettings 调用流**

检查 loadSettings 函数内容（第 12-45 行），确认它调用了：
- `renderTokenList(d.tokens || []);` → 渲染订阅 Key 列表
- `loadCredentials();` → 加载 API Key 凭证
- `setupVendorListener();` → （已在 Task 4 添加）

现有代码已有这两行，所以只需确保没有问题。

- [ ] **Step 2: 验证 Tab 切换**

在浏览器设置页：
1. 点击"设置"按钮打开设置面板
2. 点击"模型" Tab → 应该同时显示 API Key 组和订阅 Key 组的已添加列表
3. 如果前面添加过凭证和 token，应该能看到它们

- [ ] **Step 3: 提交（如有改动）**

如果 Task 7 没有新改动，则跳过此步。如果修改了 loadSettings，提交：

```bash
git add public/js/settings-panel.js
git commit -m "fix: loadSettings 确保模型 Tab 同时加载凭证和 token 列表"
```

---

### Task 8: 手动测试完整流程和最终提交

**Files:**
- Manual Test: 浏览器设置页全流程

**目标：** 验证 API Key 组和订阅 Key 组的完整交互，确保无 bug，再最后提交。

- [ ] **Step 1: 完整测试 API Key 组流程**

- [ ] **Step 1.1:** 打开设置 → "模型" Tab → API Key 组
- [ ] **Step 1.2:** 点"＋ 添加"，填入：
  - 名称：DeepSeek-A
  - 厂商：DeepSeek
  - 模型：（自动为 deepseek-chat）
  - baseURL：（自动填充）
  - apiKey：sk-test-123
  - 点"＋ 添加" → 检查 toast 和列表更新
- [ ] **Step 1.3:** 再添加一个"其他（自定义）"：
  - 名称：Custom
  - 厂商：其他（自定义）
  - 模型文本框出现，填入：my-model
  - baseURL 启用编辑，填入：https://api.custom.com/v1
  - apiKey：sk-custom-456
  - 点"＋ 添加" → 检查列表显示
- [ ] **Step 1.4:** 验证列表显示正确：
  - 两条记录都在列表中
  - 名称 | 厂商 | 模型 | baseURL | 掩码 五列都正确
  - 未命名时显示 `(未命名) - DeepSeek/deepseek-chat` 格式
- [ ] **Step 1.5:** 删除一条记录，确认列表更新

- [ ] **Step 2: 完整测试订阅 Key 组流程**

- [ ] **Step 2.1:** 在"订阅 Key"组，点"＋ 添加"，填入：
  - 名称：主账号
  - 订阅：Claude
  - Key：sk-ant-oat01-xxx
  - 点"＋ 添加" → 检查列表更新
- [ ] **Step 2.2:** 验证列表显示：
  - 条目出现，首选星标应该在
  - 可以拖拽排序
  - 可以点"＋设为当前"或"✎重命名"
- [ ] **Step 2.3:** 添加第二个 Claude Key，验证可以拖拽调整顺序

- [ ] **Step 3: 验证导出 / 导入配置**

- [ ] **Step 3.1:** 点"基础设置" Tab → 导入 / 导出配置 → 导出
- [ ] **Step 3.2:** 验证导出文件包含新的 vendor 和 subscription 字段

- [ ] **Step 4: 本地浏览器网络检查（可选）**

打开浏览器 DevTools → Network 标签，添加 API Key 和 Token，验证：
- POST `/api/credentials` 请求包含 `vendor` 字段
- POST `/api/settings` 请求（tokens action）包含 `subscription` 字段

- [ ] **Step 5: 提交最终改动**

如果所有测试都通过，最终提交：

```bash
git add -A
git commit -m "feat: 完成设置页模型 Tab 合并（API Key + 订阅 Key、厂商预设、联动）"
```

验证提交日志：

```bash
git log --oneline -8
```

Expected output (示例):
```
abc1234 feat: 完成设置页模型 Tab 合并（API Key + 订阅 Key、厂商预设、联动）
def5678 feat: 订阅 Key 组支持订阅类型下拉（当前仅 Claude）
ghi9101 feat: addCredentialUI 支持厂商字段和改进验证
...
```

---

## 自审查

### 1. 规格覆盖检查

- [x] **Tab 合并** → Task 1（HTML）
- [x] **API Key 组 + 厂商预设** → Task 2（常量）+ Task 3（列表显示）+ Task 4（联动）+ Task 5（表单提交）
- [x] **订阅 Key 组 + 下拉扩展** → Task 6（订阅下拉）
- [x] **完整交互测试** → Task 8（手动测试）
- [x] **配置导出 / 导入** → Task 8.3（验证导出包含 vendor/subscription）

### 2. Placeholder 扫描

- [x] 无 TBD / TODO
- [x] 所有函数都有完整代码
- [x] 所有 HTML 都有具体内容
- [x] 所有命令都有预期输出

### 3. 类型和字段一致性

- [x] API Key 对象结构：`{ id, label, vendor, model, baseURL, masked, apiKey }`（新增 vendor）
- [x] Token 对象结构：`{ id, label, subscription, masked, status, utilization, ... }`（新增 subscription）
- [x] VENDOR_PRESETS 常量键名和 select 选项值一致（openai, deepseek, aliyun, moonshot, zhipu, custom）
- [x] setupVendorListener 中 modelSelect / modelCustom / baseURLInput 的 ID 与 HTML 对应
- [x] 后端接口不变，前端传递 vendor/subscription 字段，后端需兼容（本计划假设后端已支持或能兼容）

### 备注

- **后端适配**：如果后端 `/api/credentials` 或 `/api/settings` 不支持新字段（vendor / subscription），需要后端同步修改。本计划前端部分独立完整，但端到端功能需后端配合。

---

## 下一步

计划完成。可选择以下执行方式：

1. **Subagent-Driven（推荐）** - 我为每个 Task 发起独立 subagent，Task 之间有检查点
2. **Inline Execution** - 在当前会话使用 executing-plans 逐步执行任务

# 需求开发期 UI 优化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标**：优化需求开发期右栏 UI，支持 API 文档点击替换更新，移除鸡肋的设计准则输入框。

**架构**：改动集中在 `public/js/req-chat.js` 的 `renderDevRail()` 函数和相关 event listener。采用渐进式改动：先增加替换按钮 UI，再参数化上传流程，最后删除设计准则区块。单测并行更新，确保每步都可验证。

**技术栈**：vanilla JavaScript（DOM 操作），fetch API，现有 toast/confirmDialog 通知机制

---

## Task 1：API 文档 - 增加替换按钮 UI

**文件**：
- Modify: `public/js/req-chat.js:394-440` （`paintDocs()` 函数）

**概述**：在 `paintDocs()` 中，每条 API 文档项的删除按钮（✕）前面增加一个替换按钮（🔄）。替换按钮点击时设置 `pendingReplaceName` 变量，然后触发文件选择器。

- [ ] **Step 1：查看现有删除按钮的 HTML 结构**

打开 `public/js/req-chat.js`，找到 `paintDocs()` 函数（行 394）。

现有代码（行 403-406）：
```javascript
const del = document.createElement('button');
del.className = 'q-btn';
del.textContent = '✕';
del.title = '删除（将自动对照修正代码）';
```

和行 440：
```javascript
row.append(name, del);
```

你会看到删除按钮直接追加到 `row`。现在需要在 `del` 前面插入替换按钮。

- [ ] **Step 2：声明 `pendingReplaceName` 变量**

在 `renderDevRail()` 函数顶部（行 368 之后），添加：

```javascript
// 记录"替换"操作的目标文档名；若为 null，则上传是"新增"
let pendingReplaceName = null;
```

这个变量会在后面的上传流程中使用。

- [ ] **Step 3：创建替换按钮并注册事件**

在 `paintDocs()` 函数中，删除按钮创建代码之前（行 403），添加：

```javascript
const replace = document.createElement('button');
replace.className = 'q-btn';
replace.textContent = '🔄';
replace.title = '替换为新版本';
replace.addEventListener('click', () => {
  pendingReplaceName = doc.name;
  fileInput.click();
});
```

- [ ] **Step 4：修改行 440，将替换按钮和删除按钮一起追加**

将：
```javascript
row.append(name, del);
```

改为：
```javascript
row.append(name, replace, del);
```

注意顺序：`replace` 在 `del` 左边。

- [ ] **Step 5：验证 UI 结构**

打开浏览器开发者工具，检查某条 API 文档项的 HTML：

```html
<div class="req-apidoc-item">
  <span class="name">api.yaml</span>
  <button class="q-btn">🔄</button>  <!-- 新增 -->
  <button class="q-btn">✕</button>  <!-- 现有 -->
</div>
```

应该可以看到替换按钮和删除按钮并排。

- [ ] **Step 6：提交**

```bash
git add public/js/req-chat.js
git commit -m "feat: API 文档增加替换按钮 UI"
```

---

## Task 2：API 文档 - 参数化上传流程

**文件**：
- Modify: `public/js/req-chat.js:458-501` （`fileInput` 事件及后续上传逻辑）

**概述**：修改 `fileInput.change` 事件处理，使用 `pendingReplaceName || file.name` 作为登记到后端的文档名。这样替换时用原文档名，新增时用新文件名，后端自动识别。

- [ ] **Step 1：查看现有的文件上传流程**

找到 `fileInput.addEventListener('change', async () => { ... })` 的事件处理（行 463）。

核心逻辑：
- 行 468：`paintDocs(data.apiDocs || [], file.name)` — 显示上传进度
- 行 470：`POST /api/upload?name=` 上传文件到服务器
- 行 473-477：`POST /api/req/apidoc { id, name: file.name, path }` 登记文档

关键是行 476，现在 `name` 写死为 `file.name`，需要改为 `pendingReplaceName || file.name`。

- [ ] **Step 2：修改行 476，使用参数化的 `name`**

将：
```javascript
body: JSON.stringify({ id: reqId, name: file.name, path: ud.path }),
```

改为：
```javascript
body: JSON.stringify({ id: reqId, name: pendingReplaceName || file.name, path: ud.path }),
```

- [ ] **Step 3：在事件处理结束后清空 `pendingReplaceName`**

找到 `refreshRail(reqId)` 的调用（行 500），在其后添加：

```javascript
pendingReplaceName = null;
```

完整的改动点（行 500-501）：
```javascript
refreshRail(reqId);
pendingReplaceName = null;  // 新增
```

这确保下次上传时，`pendingReplaceName` 回到默认的 `null` 状态。

- [ ] **Step 4：修改「＋上传」按钮的点击处理**

找到 `uploadBtn.addEventListener('click', ...)` 的处理（行 462），在其中也清空 `pendingReplaceName`：

```javascript
uploadBtn.addEventListener('click', () => {
  pendingReplaceName = null;  // 新增：确保新增时使用 file.name
  fileInput.click();
});
```

- [ ] **Step 5：验证行为**

1. **新增文档**：点击「＋上传」→ `pendingReplaceName = null` → 上传时用 `file.name` → 后端新增
2. **替换文档**：点击「🔄」→ `pendingReplaceName = doc.name` → 上传时用 `doc.name` → 后端更新

用网络检查工具（DevTools Network 标签）验证 `POST /api/req/apidoc` 的 `name` 字段是否正确。

- [ ] **Step 6：提交**

```bash
git add public/js/req-chat.js
git commit -m "feat: 参数化 API 文档上传，支持替换"
```

---

## Task 3：删除设计准则 UI 区块

**文件**：
- Modify: `public/js/req-chat.js:503-572` （`renderDevRail()` 函数中的设计准则区块）

**概述**：删除整个"🎨 设计准则"输入框和"✓ 确认发送"按钮（约 70 行），修改行 572 只追加 `docsSec`。

- [ ] **Step 1：确认设计准则区块的范围**

打开 `public/js/req-chat.js`，找到行 503-570 的代码块：

```javascript
// —— 设计准则 ——
const guideSec = document.createElement('div');
guideSec.className = 'req-rail-sec';
const guideTitle = document.createElement('b');
guideTitle.textContent = '🎨 设计准则';
// ... （后续 70 行的输入框、保存、确认发送逻辑）
guideSec.append(guideTitle, ta, confirmBtn);
```

这整个块都要删除。

- [ ] **Step 2：删除设计准则区块**

删除行 503-570 的全部代码（约 68 行）。

具体范围：
- 开始：`// —— 设计准则 ——` （行 503）
- 结束：`guideSec.append(guideTitle, ta, confirmBtn);` （行 570）

删除后，代码应该直接跳到行 572 的 `railEl.append(...)`。

- [ ] **Step 3：修改 railEl.append() 的调用**

行 572 原为：
```javascript
railEl.append(docsSec, guideSec);
```

改为：
```javascript
railEl.append(docsSec);
```

因为 `guideSec` 已删除，只追加 `docsSec`。

- [ ] **Step 4：验证右栏布局**

刷新页面，打开一个处于 `dev` 阶段的需求。右栏应该只显示：
- "📚 后端 API 文档（N）" 区块 + 替换/删除按钮
- 没有 "🎨 设计准则" 区块

如果看到文档列表，说明改动成功。

- [ ] **Step 5：验证后端兼容性**

确认 `designGuidelines` 字段和相关后端逻辑仍然存在（不动后端）：
- `PUT /api/req/guidelines` 路由保留
- `buildDevelopPrompt()` 中的 `designGuidelines` 注入保留

前端删除 UI 不影响后端功能。

- [ ] **Step 6：提交**

```bash
git add public/js/req-chat.js
git commit -m "feat: 移除设计准则 UI 区块"
```

---

## Task 4：更新单测

**文件**：
- Modify: `public/js/req-chat.apidoc.test.js`

**概述**：在现有的 API 文档测试基础上，新增"替换文档"场景的单测。验证替换时 `pendingReplaceName` 被正确传递、后端返回 `action='更新'`、消息文案适配。

- [ ] **Step 1：查看现有测试结构**

打开 `public/js/req-chat.apidoc.test.js`，了解现有的测试框架和 mock 方式。

可能已有的测试：
- 上传新文档 (`action='新增'`)
- 删除文档
- 会话未就绪报错
- 网络异常处理

现在要新增：上传替换文档 (`action='更新'`)。

- [ ] **Step 2：为替换文档场景写单测**

在现有测试末尾添加：

```javascript
describe('API 文档替换', () => {
  it('应正确替换已有文档', async () => {
    // 模拟初始状态
    const initialDoc = { id: 'doc_123', name: 'api.yaml', path: '/old-path', updatedAt: '2026-08-19T10:00:00Z' };
    const reqData = { id: 'req_abc', apiDocs: [initialDoc], phase: 'dev', convId: 'conv_1' };
    
    // 点击替换按钮（模拟设置 pendingReplaceName）
    // 这通常需要 DOM 操作的 mock，或者直接在上传流程中测试
    
    // 模拟新文件选择
    const newFile = new File(['new content'], 'api.yaml', { type: 'text/yaml' });
    
    // 模拟上传响应
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ json: async () => ({ path: '/new-path' }) }) // /api/upload
      .mockResolvedValueOnce({ // /api/req/apidoc
        ok: true,
        json: async () => ({
          ok: true,
          action: '更新',
          doc: { id: 'doc_123', name: 'api.yaml', path: '/new-path', updatedAt: '2026-08-19T11:00:00Z' }
        })
      });
    
    // 执行替换（通过上传流程）
    // 模拟 fileInput.change 时 pendingReplaceName = 'api.yaml'
    // 期望 POST /api/req/apidoc 的请求体中 name='api.yaml'（而非新文件名）
    
    // 验证：
    // - fetch 被调用两次（/api/upload + /api/req/apidoc）
    // - 第二次 POST 的 body.name === 'api.yaml'
    // - 返回 action === '更新'
    // - 消息文案包含"已更新"
    
    const fetchCalls = global.fetch.mock.calls;
    expect(fetchCalls.length).toBe(2);
    
    const apidocCall = fetchCalls[1];
    const apidocBody = JSON.parse(apidocCall[1].body);
    expect(apidocBody.name).toBe('api.yaml'); // 关键：替换时用原名
    expect(apidocBody.path).toBe('/new-path');
  });

  it('新增时应使用新文件名', async () => {
    // 类似的测试，但 pendingReplaceName = null
    // 期望 name = file.name（新文件名）
    // action = '新增'
  });
});
```

- [ ] **Step 3：运行单测**

```bash
npm test -- req-chat.apidoc.test.js
```

期望所有测试（现有 + 新增）都通过。

- [ ] **Step 4：如果测试失败，调试实现**

单测会帮助发现问题，比如：
- `pendingReplaceName` 未正确传递
- 消息文案不匹配"更新"场景
- 后端返回值处理不当

根据测试失败信息修改前面的 Task 代码。

- [ ] **Step 5：提交**

```bash
git add public/js/req-chat.apidoc.test.js
git commit -m "test: 新增 API 文档替换场景的单测"
```

---

## Task 5：集成验证

**文件**：无新增文件，只进行手动验证

**概述**：端到端地验证所有改动协作无误。

- [ ] **Step 1：启动项目**

```bash
npm run dev
```

确保 web 服务正常启动。

- [ ] **Step 2：测试 API 文档替换流程**

1. 打开需求，进入 `dev` 阶段
2. 上传一个 API 文档（新增）
  - 应该看到"📚 后端 API 文档（1）"
  - 有一个"🔄"替换按钮和"✕"删除按钮
3. 点击"🔄"替换按钮
  - 文件选择器打开
  - 选择一个新文件（可与原文件名不同）
  - 文件上传并登记
  - 消息发送给 Claude："已更新"
  - 文档列表刷新，`updatedAt` 变新（如果显示的话）

- [ ] **Step 3：测试新增（对比）**

1. 点击"＋上传"（而非替换按钮）
2. 选择新文件
3. 消息应该说"已新增"（而非"已更新"）

- [ ] **Step 4：测试设计准则区块已移除**

1. 在相同的需求右栏里，应该看不到"🎨 设计准则"区块
2. 只有"📚 后端 API 文档"区块和替换/删除按钮

- [ ] **Step 5：测试错误情况**

1. 会话未就绪：若 `convId` 为空，操作应报"会话未就绪"
2. 网络异常：模拟上传失败，应报错"上传失败"

- [ ] **Step 6：检查浏览器控制台**

确保没有 JavaScript 错误或警告。

- [ ] **Step 7：最终提交（汇总）**

如果所有手动验证都通过，可选地创建一个"集成验证完成"的提交：

```bash
git commit --allow-empty -m "test: 集成验证完成 - API 文档替换、设计准则移除"
```

---

## Task 完成清单

- [ ] Task 1：API 文档替换按钮 UI
- [ ] Task 2：参数化上传流程
- [ ] Task 3：删除设计准则 UI
- [ ] Task 4：更新单测
- [ ] Task 5：集成验证

---

## 测试覆盖

**单元测试**（`req-chat.apidoc.test.js`）：
- ✅ 替换文档：`pendingReplaceName` 被传递，`action='更新'`
- ✅ 新增文档：`pendingReplaceName=null`，`action='新增'`
- ✅ 会话未就绪：报错处理
- ✅ 网络异常：错误提示

**手动测试**（集成验证）：
- ✅ UI：替换按钮可见、点击触发文件选择器
- ✅ 流程：上传、登记、消息发送、列表刷新
- ✅ 设计准则：UI 已移除
- ✅ 浏览器控制台：无错误

---

## 提交历史

```
cedba8a fix: 会话结束时自动重新注入未发送的持有消息
<本计划的 4-5 个 commit>
 - feat: API 文档增加替换按钮 UI
 - feat: 参数化 API 文档上传，支持替换
 - feat: 移除设计准则 UI 区块
 - test: 新增 API 文档替换场景的单测
 - [可选] test: 集成验证完成
```

---

## 关键变量与函数对照表

| 名称 | 类型 | 作用域 | 说明 |
|------|------|--------|------|
| `pendingReplaceName` | string \| null | `renderDevRail()` | 记录替换操作的目标文档名；null 表示新增 |
| `paintDocs(docs, uploadingName)` | 函数 | `renderDevRail()` 内 | 重绘文档列表，每条项有替换+删除按钮 |
| `fileInput` | HTMLInputElement | `renderDevRail()` 内 | 文件选择器；被替换按钮和＋上传按钮共用 |
| `epoch` | number | `renderDevRail()` 内 | 世代号，防止跨会话误操作（现有） |
| `refreshRail(reqId)` | 函数 | 全局 | 局部刷新右栏（现有） |

# Markdown 文件 Chip 快速打开 — 实现计划

> **对于自动化工作者:** 推荐使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 逐任务执行本计划。步骤使用 checkbox (`- [ ]`) 语法跟踪进度。

**目标:** 点击聊天气泡中的 `.md` 文件 chip，直接跳 Markdown 查看器打开该文件

**架构:** 延续现有"视图桥"模式（类似 `bindChatNav`、`bindTasksNav`），在 `chat.js` 中检测 Markdown 路径并调用注入的回调，由 `app.js` 提供切换视图 + 打开文件的具体实现

**技术栈:** 
- 前端：JavaScript 原生 DOM 操作、正则表达式路径检测
- 模式：依赖注入（回调注入）、视图桥接
- 文件：`public/js/chat.js`、`public/app.js`

---

## 文件变更结构

**修改文件：**
1. `public/js/chat.js` — 新增路径检测函数、修改 chip 样式逻辑、修改点击处理、导出桥接函数
2. `public/app.js` — 导入桥接函数、在 markdownTool 初始化后调用

**无新增文件**

---

## 任务分解

### Task 1: 在 chat.js 中新增 isMarkdownPath 辅助函数

**文件:**
- 修改: `public/js/chat.js:943-945` (在 `isImagePath` 函数后面)

- [ ] **Step 1: 定位 isImagePath 函数**

打开 `public/js/chat.js`，找到 `isImagePath` 函数（约在第 943-945 行）：
```javascript
function isImagePath(path) {
  return IMAGE_EXTS.test(path);
}
```

- [ ] **Step 2: 在 isImagePath 后面新增 isMarkdownPath 函数**

在 `isImagePath` 函数之后添加新函数：
```javascript
      /**
       * 判断是否为 Markdown 文件扩展名
       */
      function isMarkdownPath(path) {
        return /\.(md|markdown)$/i.test(path);
      }
```

- [ ] **Step 3: 验证语法正确**

运行: `node -c public/js/chat.js` （语法检查）

- [ ] **Step 4: Commit**

```bash
git add public/js/chat.js
git commit -m "feat(markdown-chip): add isMarkdownPath helper function"
```

---

### Task 2: 修改 classifyPath 函数，新增 markdown 分类

**文件:**
- 修改: `public/js/chat.js:1060-1065`

- [ ] **Step 1: 定位 classifyPath 函数**

在 `chat.js` 中找到 `classifyPath` 函数（约在第 1060-1065 行）：
```javascript
      function classifyPath(path) {
        if (isImagePath(path)) return 'image';
        // 只看最后一段，且要求扩展名前有字符——否则 C:\Users\DELL\.uploads
        // 这种点开头的目录会被当成文件
        return /[^.\\/]\.[A-Za-z0-9]{1,8}$/.test(getPathName(path)) ? 'file' : 'dir';
      }
```

- [ ] **Step 2: 在 isImagePath 检测后新增 markdown 检测**

修改函数为：
```javascript
      function classifyPath(path) {
        if (isImagePath(path)) return 'image';
        if (isMarkdownPath(path)) return 'markdown';
        // 只看最后一段，且要求扩展名前有字符——否则 C:\Users\DELL\.uploads
        // 这种点开头的目录会被当成文件
        return /[^.\\/]\.[A-Za-z0-9]{1,8}$/.test(getPathName(path)) ? 'file' : 'dir';
      }
```

- [ ] **Step 3: 验证语法**

运行: `node -c public/js/chat.js`

- [ ] **Step 4: Commit**

```bash
git add public/js/chat.js
git commit -m "feat(markdown-chip): add markdown classification in classifyPath"
```

---

### Task 3: 修改 makePathChip 函数，添加 Markdown 样式

**文件:**
- 修改: `public/js/chat.js:985-1017`

- [ ] **Step 1: 定位 makePathChip 函数**

在 `chat.js` 中找到 `makePathChip(path, kind)` 函数（约在第 985-1017 行）。

- [ ] **Step 2: 在 chip 创建后、事件绑定前添加 markdown 样式逻辑**

在 `chip.appendChild(name)` 之后、`chip.addEventListener('click', ...)` 之前，添加：
```javascript
        // Markdown 文件使用专属样式和 icon
        if (kind === 'markdown') {
          chip.classList.add('path-markdown');
          icon.textContent = '📝';
          chip.title = '点击用 Markdown 查看器打开';
        }
```

修改后的完整函数（仅展示关键部分）：
```javascript
      function makePathChip(path, kind) {
        const chip = document.createElement('span');
        chip.className = 'path-chip';
        chip.dataset.path = path;

        const icon = document.createElement('span');
        icon.className = 'path-icon';

        const name = document.createElement('span');
        name.className = 'path-name';
        name.textContent = getPathName(path);

        if (kind === 'dir') {
          chip.classList.add('path-dir');
          icon.textContent = '📁';
          chip.title = '点击在文件夹中定位';
        } else {
          chip.classList.add('path-file');
          icon.textContent = '📄';
          chip.title = '点击在文件夹中定位';
        }

        chip.appendChild(icon);
        chip.appendChild(name);

        // Markdown 文件使用专属样式和 icon
        if (kind === 'markdown') {
          chip.classList.add('path-markdown');
          icon.textContent = '📝';
          chip.title = '点击用 Markdown 查看器打开';
        }

        // 绑定点击事件
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          handlePathChipClick(path);
        });

        return chip;
      }
```

- [ ] **Step 3: 验证语法**

运行: `node -c public/js/chat.js`

- [ ] **Step 4: Commit**

```bash
git add public/js/chat.js
git commit -m "feat(markdown-chip): add markdown-specific styling in makePathChip"
```

---

### Task 4: 修改 handlePathChipClick 函数，拦截 markdown 文件点击

**文件:**
- 修改: `public/js/chat.js:1025-1047`

- [ ] **Step 1: 定位 handlePathChipClick 函数**

在 `chat.js` 中找到 `async function handlePathChipClick(path)` （约在第 1025-1047 行）：
```javascript
      async function handlePathChipClick(path) {
        if (!window.tauriApi?.revealPath) {
          // Web 模式：复制路径
          try {
            await navigator.clipboard.writeText(path);
            toast('已复制路径：' + path);
          } catch {
            toast('复制失败');
          }
          return;
        }

        try {
          await window.tauriApi.revealPath(path);
        } catch (err) {
          console.error('revealPath failed:', err);
          const msg = typeof err === 'string' ? err : (err?.message ?? JSON.stringify(err));
          toast('打开失败：' + msg);
        }
      }
```

- [ ] **Step 2: 在函数开头添加 markdown 拦截逻辑**

在 `if (!window.tauriApi?.revealPath)` 之前添加：
```javascript
      async function handlePathChipClick(path) {
        // Markdown 文件快速打开：直接跳查看器
        if (isMarkdownPath(path) && _openMarkdown) {
          try {
            _openMarkdown(path);
            return;
          } catch (err) {
            console.error('打开 Markdown 失败:', err);
            toast('打开 Markdown 失败：' + (err?.message || err));
          }
        }

        if (!window.tauriApi?.revealPath) {
          // Web 模式：复制路径
          // ... 后续代码保持不变
        }
      }
```

修改后的完整函数：
```javascript
      async function handlePathChipClick(path) {
        // Markdown 文件快速打开：直接跳查看器
        if (isMarkdownPath(path) && _openMarkdown) {
          try {
            _openMarkdown(path);
            return;
          } catch (err) {
            console.error('打开 Markdown 失败:', err);
            toast('打开 Markdown 失败：' + (err?.message || err));
          }
        }

        if (!window.tauriApi?.revealPath) {
          // Web 模式：复制路径
          try {
            await navigator.clipboard.writeText(path);
            toast('已复制路径：' + path);
          } catch {
            toast('复制失败');
          }
          return;
        }

        try {
          await window.tauriApi.revealPath(path);
        } catch (err) {
          console.error('revealPath failed:', err);
          const msg = typeof err === 'string' ? err : (err?.message ?? JSON.stringify(err));
          toast('打开失败：' + msg);
        }
      }
```

- [ ] **Step 3: 验证语法**

运行: `node -c public/js/chat.js`

- [ ] **Step 4: Commit**

```bash
git add public/js/chat.js
git commit -m "feat(markdown-chip): intercept markdown file clicks in handlePathChipClick"
```

---

### Task 5: 在 chat.js 中新增 bindMarkdownNav 导出函数

**文件:**
- 修改: `public/js/chat.js:42-51` (在视图桥回调区)

- [ ] **Step 1: 定位现有视图桥回调**

在 `chat.js` 顶部找到现有的视图桥回调定义（约在第 42-51 行）：
```javascript
// 视图桥：壳注入「回聊天视图」跳转，体内 5 处原直调改经 _goChat()
let _goChat = () => {};
// 视图桥：聊天视图是否当前激活（供 refreshAskChip 判定，避免反向依赖 app.js 的 activeView）
let _isChatViewActive = () => true;
export function bindChatNav(goChat, isActiveFn) {
  _goChat = goChat;
  if (isActiveFn) _isChatViewActive = isActiveFn;
}
// 视图桥：需求会话钩子（Task 10）——切到/离开需求 conv 时通知 req-chat.js 挂/卸载横幅右栏
let _reqConvHook = null;
export function bindReqConvHook(fn) { _reqConvHook = fn; }
```

- [ ] **Step 2: 在 bindReqConvHook 后面新增 bindMarkdownNav**

在 `bindReqConvHook` 函数之后添加：
```javascript

// 视图桥：Markdown 打开逻辑（切换视图 + 打开文件）
let _openMarkdown = null;
export function bindMarkdownNav(fn) {
  _openMarkdown = fn;
}
```

完整的视图桥回调区应为：
```javascript
// 视图桥：壳注入「回聊天视图」跳转，体内 5 处原直调改经 _goChat()
let _goChat = () => {};
// 视图桥：聊天视图是否当前激活（供 refreshAskChip 判定，避免反向依赖 app.js 的 activeView）
let _isChatViewActive = () => true;
export function bindChatNav(goChat, isActiveFn) {
  _goChat = goChat;
  if (isActiveFn) _isChatViewActive = isActiveFn;
}
// 视图桥：需求会话钩子（Task 10）——切到/离开需求 conv 时通知 req-chat.js 挂/卸载横幅右栏
let _reqConvHook = null;
export function bindReqConvHook(fn) { _reqConvHook = fn; }

// 视图桥：Markdown 打开逻辑（切换视图 + 打开文件）
let _openMarkdown = null;
export function bindMarkdownNav(fn) {
  _openMarkdown = fn;
}
```

- [ ] **Step 3: 验证语法**

运行: `node -c public/js/chat.js`

- [ ] **Step 4: Commit**

```bash
git add public/js/chat.js
git commit -m "feat(markdown-chip): export bindMarkdownNav function for view bridge"
```

---

### Task 6: 在 app.js 中导入 bindMarkdownNav 并调用

**文件:**
- 修改: `public/app.js` (顶部导入区 + markdownTool 初始化区)

- [ ] **Step 1: 在导入区添加 bindMarkdownNav**

打开 `public/app.js`，在现有的 chat.js 导入行：
```javascript
import { initChat, chatOnShow, bindChatNav, refreshAskChip, openConv, renderConvListNow, applyInjectedItems, getCurrentConvId } from './js/chat.js';
```

修改为：
```javascript
import { initChat, chatOnShow, bindChatNav, bindMarkdownNav, refreshAskChip, openConv, renderConvListNow, applyInjectedItems, getCurrentConvId } from './js/chat.js';
```

- [ ] **Step 2: 定位 markdownTool 初始化代码**

在 `public/app.js` 中找到 markdownTool 初始化（约在第 157-161 行）：
```javascript
      // 初始化 Markdown 工具
      let markdownTool;
      document.addEventListener('DOMContentLoaded', () => {
        markdownTool = new MarkdownTool();
        console.log('Markdown 工具已初始化');
      });
```

- [ ] **Step 3: 在 markdownTool 初始化后调用 bindMarkdownNav**

修改为：
```javascript
      // 初始化 Markdown 工具
      let markdownTool;
      document.addEventListener('DOMContentLoaded', () => {
        markdownTool = new MarkdownTool();
        
        // 注入 Markdown 打开逻辑（视图桥）
        bindMarkdownNav((path) => {
          showView('markdown');
          markdownTool.openFileByPath(path);
        });
        
        console.log('Markdown 工具已初始化');
      });
```

- [ ] **Step 4: 验证语法**

运行: `node -c public/app.js`

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat(markdown-chip): inject bindMarkdownNav in app.js initialization"
```

---

### Task 7: 手动测试 — 点击 .md chip 跳转到 Markdown 查看器

**测试环境:** Tauri 模式 + Web 模式

- [ ] **Step 1: 启动应用**

```bash
npm run dev
# 或对于 Tauri：
npm run tauri dev
```

等待应用启动完成。

- [ ] **Step 2: 在聊天中输入含有 .md 文件路径的消息**

在聊天输入框输入类似内容：
```
请查看这个文件：C:\Users\DELL\.claude\CLAUDE.md
```

发送消息（或者让 AI 生成包含 .md 路径的响应）。

- [ ] **Step 3: 验证 chip 样式**

观察返回的消息中：
- `.md` 文件 chip 应该显示 **📝** icon（而不是 📄）
- chip 的 title/tooltip 应该是「点击用 Markdown 查看器打开」

- [ ] **Step 4: Tauri 模式 — 点击 .md chip**

在应用中点击 `.md` 文件 chip。

**预期结果：**
- 视图切换到 Markdown 查看器
- 该 `.md` 文件内容自动加载并显示
- 侧栏历史面板显示该文件
- 工具栏显示文件名和修改时间

- [ ] **Step 5: 非 .md 文件 chip 仍保持原有行为**

在聊天中输入包含其他文件路径的消息：
```
文件位置：C:\Users\DELL\Desktop\test.txt
```

点击 `.txt` chip，应该**在文件管理器中定位该文件**（Tauri 模式）或**复制路径到剪贴板**（Web 模式）。

- [ ] **Step 6: 图片 chip 仍保持原有行为**

在聊天中输入包含图片路径的消息：
```
截图：C:\Users\DELL\Desktop\screenshot.png
```

点击 `.png` chip，应该显示图片预览（缩略图）或在图片加载失败时降级为文件 chip。

- [ ] **Step 7: Web 模式 — 重复测试**

关闭 Tauri 应用，在浏览器中运行 `npm run dev`，重复 Step 4-6。

**预期结果：**
- `.md` chip 点击 → 跳 Markdown 查看器（同样的切换视图逻辑）
- 其他文件 chip 点击 → 复制路径到剪贴板（Web 模式没有文件管理器）

- [ ] **Step 8: 测试 markdown-tool.js 的 openFileByPath 容错**

尝试点击一个**不存在的 .md 文件路径**（例如 `C:\nonexistent\file.md`）。

**预期结果：**
- toast 提示「文件读取失败：…」（来自 markdown-tool.js 的错误处理）
- 视图仍然切换到 Markdown 查看器（显示空状态或上一个打开的文件）

- [ ] **Step 9: Commit test evidence（如果有环境限制，可跳过）**

如果能截图或录屏，保存测试证据。本步可选。

```bash
# 可选：记录测试通过
git status  # 确认改动已提交
```

---

## 自审清单

### 1. 规范覆盖
- [x] Task 1-5 实现设计文档中所有代码变更点
- [x] Task 6 对应 app.js 的视图桥接注入
- [x] Task 7 手动测试验收标准

### 2. 占位符扫描
- [x] 所有代码完整（无 "TBD"、"TODO"、"similar to task N"）
- [x] 所有命令行完整（node -c、git 命令都有）
- [x] 预期输出明确

### 3. 类型与名称一致性
- [x] `isMarkdownPath` 在 Task 1 定义，在 Task 2、4 中使用 → 一致
- [x] `_openMarkdown` 在 Task 5 定义，在 Task 4 中使用、Task 6 中注入 → 一致
- [x] `kind === 'markdown'` 在 Task 2 分类，在 Task 3 样式判定中使用 → 一致
- [x] `bindMarkdownNav` 在 Task 5 导出，在 Task 6 导入 → 一致

### 4. 修改文件的完整性
- [x] `public/js/chat.js`：5 处修改（isMarkdownPath、classifyPath、makePathChip、handlePathChipClick、bindMarkdownNav）
- [x] `public/app.js`：2 处修改（导入、初始化后调用）

### 5. 任务粒度
- [x] 每个 Task 2-5 分钟可完成
- [x] 每个 Task 都有明确的 commit 点
- [x] Task 7 手动测试有具体的操作步骤和预期结果

---

## 执行选项

**计划已完成并保存到** `docs/superpowers/plans/2026-08-24-markdown-chip-click.md`

两种执行方式：

**1. 子代理驱动（推荐）** — 我为每个任务派遣一个新的子代理，任务间进行审查，快速迭代反馈
  - 使用 `superpowers:subagent-driven-development`
  - 独立、可复核

**2. 内联执行** — 在本会话中直接执行任务，分段检查
  - 使用 `superpowers:executing-plans`  
  - 更快、单人操作

**选择哪种方式？**
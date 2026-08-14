# 对话气泡中的路径检测与渲染 实现计划

> **对于代理执行者：** 建议使用 superpowers:subagent-driven-development 逐任务分派执行。每步使用 checkbox (`- [ ]`) 语法追踪进度。

**目标：** 在用户消息气泡中自动识别文件路径，为图片提供预览，为文件和目录提供可点击打开功能。

**架构：** 在 `addMessage()` 用户分支中调用新函数 `renderPathsInText(text, container)`，该函数扫描路径正则、异步验证存在性（Tauri 模式）、生成 DOM 节点（文本 + 图片缩略图 + 可点击 chip）并绑定事件处理器。灯箱全屏预览图片，openPath 打开文件夹或目录。

**技术栈：** Tauri invoke API（path_exists、path_kind）、Web API（fetch、Blob URL、Range/Selection）、原生 DOM、CSS flexbox

---

## 文件结构

| 文件 | 职责 | 改动类型 |
|------|------|--------|
| `public/index.html` | 灯箱 DOM 骨架 | 新增行 |
| `public/app.css` | 路径 chip、图片、灯箱样式 | 新增规则 |
| `public/js/chat.js` | `renderPathsInText()` 实现、`addMessage()` 调用 | 新增函数 + 改动 ~875 行 |

---

## Task 1: 灯箱 HTML 骨架

**Files:**
- Modify: `public/index.html` (在 `</section>` 后面)

- [ ] **Step 1: 定位插入位置**

打开 `public/index.html`，找到第 455 行左右的 `</section>` 标签（在 `fabRow` 之前）。

- [ ] **Step 2: 插入灯箱骨架**

在 `</section>` 之后、`<div class="fab-row" id="fabRow">` 之前插入：

```html
      <!-- 图片预览灯箱 -->
      <div id="imgLightbox" class="lightbox" hidden>
        <div class="lightbox-overlay">
          <img class="lightbox-img" src="" alt="preview" />
          <button class="lightbox-close" title="关闭（Esc）">×</button>
        </div>
      </div>
```

完整上下文应如下：

```html
        </div>
      </section>

      <!-- 图片预览灯箱 -->
      <div id="imgLightbox" class="lightbox" hidden>
        <div class="lightbox-overlay">
          <img class="lightbox-img" src="" alt="preview" />
          <button class="lightbox-close" title="关闭（Esc）">×</button>
        </div>
      </div>

      <div class="fab-row" id="fabRow">
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: add image lightbox HTML skeleton"
```

---

## Task 2: 路径相关样式（CSS）

**Files:**
- Modify: `public/app.css` (在 `.copy-btn.copied` 之后追加)

- [ ] **Step 1: 在 CSS 中定位插入点**

打开 `public/app.css`，找到 `.copy-btn.copied` 规则（约 675 行），在其之后插入新样式。

- [ ] **Step 2: 添加路径 chip 样式**

在 `.copy-btn.copied { color: var(--green); }` 之后插入：

```css
      /* ---- 路径 chip（文件/目录） ---- */
      .path-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        border-radius: 6px;
        background: var(--panel);
        border: 1px solid var(--border-soft);
        cursor: pointer;
        white-space: nowrap;
        user-select: none;
        transition: background 0.15s, border-color 0.15s;
        margin: 2px 0;
      }
      .path-chip:hover {
        background: var(--accent-soft);
        border-color: rgba(217, 119, 87, 0.55);
      }
      .path-chip.path-file {
        /* 普通文件 chip */
      }
      .path-chip.path-dir {
        /* 目录 chip */
      }
      .path-icon {
        font-size: 14px;
        display: inline-block;
        flex-shrink: 0;
      }
      .path-name {
        font-size: 12px;
        color: var(--text);
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .path-notfound {
        color: var(--muted);
        opacity: 0.6;
        cursor: text;
        user-select: text;
      }
```

- [ ] **Step 3: 添加路径图片样式**

紧接上面，添加：

```css
      /* ---- 路径图片缩略图 ---- */
      .path-img {
        max-width: 200px;
        max-height: 150px;
        border-radius: 8px;
        cursor: pointer;
        border: 1px solid var(--border-soft);
        transition: opacity 0.15s;
        display: block;
        margin: 4px 0;
      }
      .path-img:hover {
        opacity: 0.8;
      }
      .path-img.loading {
        opacity: 0.5;
      }
      .path-img.error {
        display: none;
      }
```

- [ ] **Step 4: 添加灯箱样式**

紧接上面，添加：

```css
      /* ---- 图片灯箱 ---- */
      #imgLightbox {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.9);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 99999;
      }
      #imgLightbox[hidden] {
        display: none;
      }
      .lightbox-overlay {
        position: relative;
        max-width: 90vw;
        max-height: 90vh;
        cursor: pointer;
      }
      .lightbox-img {
        max-width: 100%;
        max-height: 100%;
        user-select: none;
        pointer-events: none;
        display: block;
      }
      .lightbox-close {
        position: absolute;
        top: -40px;
        right: 0;
        width: 32px;
        height: 32px;
        background: transparent;
        border: none;
        color: #fff;
        font-size: 24px;
        cursor: pointer;
        line-height: 1;
        padding: 0;
      }
      .lightbox-close:hover {
        opacity: 0.8;
      }
```

- [ ] **Step 5: Commit**

```bash
git add public/app.css
git commit -m "feat: add path chip and lightbox styles"
```

---

## Task 3: 核心函数 renderPathsInText()

**Files:**
- Modify: `public/js/chat.js` (在 `addMessage()` 函数之前新增)

- [ ] **Step 1: 在 chat.js 中定位函数位置**

打开 `public/js/chat.js`，找到 `addMessage()` 函数定义（约 852 行）。在其之前（约 850 行）插入新函数。

- [ ] **Step 2: 编写路径识别正则和工具函数**

在 `addMessage()` 之前插入：

```javascript
      // ---- 路径检测与渲染 ----
      const PATH_PATTERNS = [
        /[A-Za-z]:[\\\/][^\n]*/g,           // Windows 绝对
        /\/[^\s\n]{2,}/g,                   // Unix/Mac 绝对
      ];
      const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i;

      /**
       * 提取路径最后一段作为显示名
       */
      function getPathName(path) {
        const lastSeg = path.split(/[/\\]/).filter(Boolean).pop() || path;
        return lastSeg;
      }

      /**
       * 判断是否为图片扩展名
       */
      function isImagePath(path) {
        return IMAGE_EXTS.test(path);
      }

      /**
       * 创建图片缩略图 DOM
       */
      function makeImageElement(path) {
        const img = document.createElement('img');
        img.className = 'path-img';
        img.alt = 'image preview';
        img.dataset.path = path;
        img.title = '点击查看完整图片';
        
        // Tauri 环境下用 convertFileSrc，否则尝试 file:// URL
        if (window.tauriApi && window.__TAURI__?.path?.convertFileSrc) {
          img.src = window.__TAURI__.path.convertFileSrc(path);
        } else {
          img.src = 'file:///' + path.replace(/\\/g, '/');
        }
        
        img.onerror = () => {
          img.classList.add('error');
        };
        
        return img;
      }

      /**
       * 创建路径 chip（文件或目录）
       */
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
          chip.title = '点击打开目录';
        } else {
          chip.classList.add('path-file');
          icon.textContent = '📄';
          chip.title = '点击打开所在文件夹';
        }
        
        chip.appendChild(icon);
        chip.appendChild(name);
        
        // 绑定点击事件
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          handlePathChipClick(path, kind);
        });
        
        return chip;
      }

      /**
       * 处理路径 chip 点击：Tauri 打开文件夹，Web 复制路径
       */
      async function handlePathChipClick(path, kind) {
        if (!window.tauriApi?.openPath) {
          // Web 模式：复制路径
          try {
            await navigator.clipboard.writeText(path);
            toast('已复制路径：' + path);
          } catch {
            toast('复制失败');
          }
          return;
        }
        
        // Tauri 模式
        let target = path;
        if (kind === 'file') {
          // 文件：打开所在目录
          target = path.split(/[\\\/]/).slice(0, -1).join('/');
        }
        
        try {
          await window.tauriApi.openPath(target);
        } catch (err) {
          console.error('openPath failed:', err);
          toast('打开失败：' + (err?.message || '未知错误'));
        }
      }

      /**
       * 验证路径存在性并获取类型（仅 Tauri）
       */
      async function checkPathKind(path) {
        if (!window.tauriApi?.invoke) {
          return null; // Web 模式无法验证
        }
        
        try {
          // 先检查存在性
          const exists = await window.tauriApi.invoke('plugin:shell|path_exists', { path });
          if (!exists) {
            return 'notfound';
          }
          
          // 再获取类型
          const result = await window.tauriApi.invoke('plugin:shell|path_kind', { path });
          // 返回值可能是 {kind: 'isFile'|'isDir'|'isImage'} 或类似格式
          if (result?.kind) {
            if (result.kind === 'isImage') return 'image';
            if (result.kind === 'isDir') return 'dir';
            if (result.kind === 'isFile') return 'file';
          }
          
          // 如果 invoke 失败，用启发式方法判断
          return path.includes('.') ? 'file' : 'dir';
        } catch (err) {
          console.warn('checkPathKind failed:', err);
          // 网络异常时降级：有扩展名视为文件，无则视为目录
          return path.includes('.') ? 'file' : 'dir';
        }
      }

      /**
       * 主函数：扫描文本中的路径，转换为 DOM 节点混合内容
       */
      async function renderPathsInText(text, container) {
        if (!text || !container) return;
        
        // 收集所有路径及其位置
        const matches = [];
        for (const pattern of PATH_PATTERNS) {
          let m;
          while ((m = pattern.exec(text)) !== null) {
            let path = m[0];
            
            // 清理尾部可能的标点符号（括号、句号）
            if (path.endsWith('.') || path.endsWith('。')) {
              path = path.slice(0, -1);
            }
            if (path.endsWith(')')) {
              path = path.slice(0, -1);
            }
            
            matches.push({
              path,
              start: m.index,
              end: m.index + path.length,
            });
          }
          // 重置正则的 lastIndex
          pattern.lastIndex = 0;
        }
        
        // 去重并排序
        const uniqueMatches = [];
        const seen = new Set();
        for (const m of matches.sort((a, b) => a.start - b.start)) {
          if (!seen.has(m.path)) {
            seen.add(m.path);
            uniqueMatches.push(m);
          }
        }
        
        // 如果没找到路径，直接返回文本
        if (!uniqueMatches.length) {
          container.textContent = text;
          return;
        }
        
        // 构建 DOM：交替组合文本和路径节点
        const fragment = document.createDocumentFragment();
        let lastEnd = 0;
        
        for (const match of uniqueMatches) {
          // 添加路径前的文本
          if (match.start > lastEnd) {
            fragment.appendChild(
              document.createTextNode(text.slice(lastEnd, match.start))
            );
          }
          
          // 获取路径类型
          const kind = await checkPathKind(match.path);
          
          // 根据类型添加 DOM 节点
          if (kind === 'notfound') {
            // 不存在的路径：降级为灰文本
            const span = document.createElement('span');
            span.className = 'path-notfound';
            span.textContent = match.path;
            fragment.appendChild(span);
          } else if (kind === 'image') {
            // 图片：缩略图 + 灯箱
            const img = makeImageElement(match.path);
            img.addEventListener('click', (e) => {
              e.stopPropagation();
              showLightbox(match.path);
            });
            fragment.appendChild(img);
          } else if (kind === 'dir') {
            // 目录
            fragment.appendChild(makePathChip(match.path, 'dir'));
          } else {
            // 文件（默认）
            fragment.appendChild(makePathChip(match.path, 'file'));
          }
          
          lastEnd = match.end;
        }
        
        // 添加剩余文本
        if (lastEnd < text.length) {
          fragment.appendChild(document.createTextNode(text.slice(lastEnd)));
        }
        
        container.innerHTML = '';
        container.appendChild(fragment);
      }

      /**
       * 显示图片灯箱
       */
      function showLightbox(imagePath) {
        const lightbox = document.getElementById('imgLightbox');
        const img = lightbox?.querySelector('.lightbox-img');
        if (!img) return;
        
        // 设置图片源
        if (window.tauriApi && window.__TAURI__?.path?.convertFileSrc) {
          img.src = window.__TAURI__.path.convertFileSrc(imagePath);
        } else {
          img.src = 'file:///' + imagePath.replace(/\\/g, '/');
        }
        
        lightbox.hidden = false;
      }

      /**
       * 关闭灯箱
       */
      function closeLightbox() {
        const lightbox = document.getElementById('imgLightbox');
        if (lightbox) lightbox.hidden = true;
      }

      // 灯箱事件：点击背景关闭、Esc 关闭、关闭按钮
      document.addEventListener('DOMContentLoaded', () => {
        const lightbox = document.getElementById('imgLightbox');
        const overlay = lightbox?.querySelector('.lightbox-overlay');
        const closeBtn = lightbox?.querySelector('.lightbox-close');
        
        if (lightbox) {
          // 点击背景（lightbox 本身）关闭
          lightbox.addEventListener('click', (e) => {
            if (e.target === lightbox) closeLightbox();
          });
          
          // 阻止点击图片容器冒泡（不关闭）
          overlay?.addEventListener('click', (e) => e.stopPropagation());
          
          // 关闭按钮
          closeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            closeLightbox();
          });
        }
        
        // Esc 关闭
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') closeLightbox();
        });
      });
```

- [ ] **Step 3: Commit**

```bash
git add public/js/chat.js
git commit -m "feat: add renderPathsInText() and helper functions"
```

---

## Task 4: 修改 addMessage() 调用新函数

**Files:**
- Modify: `public/js/chat.js` (约 852-876 行的 addMessage 函数)

- [ ] **Step 1: 定位用户消息分支**

打开 `public/js/chat.js`，找到 `addMessage()` 函数，定位到约 875 行的这段代码：

```javascript
        if (role === 'assistant') renderMarkdown(bubble, text);
        else bubble.textContent = text;
```

- [ ] **Step 2: 改为调用 renderPathsInText**

替换 `else bubble.textContent = text;` 为：

```javascript
        else {
          // 用户消息：扫描路径并转为可交互样式
          await renderPathsInText(text, bubble);
        }
```

完整上下文应如下：

```javascript
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        if (role === 'assistant') renderMarkdown(bubble, text);
        else {
          // 用户消息：扫描路径并转为可交互样式
          await renderPathsInText(text, bubble);
        }
```

- [ ] **Step 3: 验证函数是否为异步**

确保 `addMessage()` 定义行是 `async function addMessage(role, text, meta) {` (约第 852 行)。如果不是 async，改为 async。

目前的行是：
```javascript
      function addMessage(role, text, meta) {
```

改为：
```javascript
      async function addMessage(role, text, meta) {
```

- [ ] **Step 4: Commit**

```bash
git add public/js/chat.js
git commit -m "feat: integrate renderPathsInText into addMessage for user messages"
```

---

## Task 5: 集成测试与验证

**Files:**
- 测试环境：本地 Tauri 桌面应用 + Web 浏览器模式

- [ ] **Step 1: 启动应用并进入聊天**

```bash
# 进入项目目录
cd C:/Users/DELL/Desktop/claude-p-web-demo

# 启动 Tauri 桌面版（如果已装）
npm run tauri:dev

# 或启动 Web 模式
npm run dev
# 访问 http://localhost:3000
```

- [ ] **Step 2: 测试 Windows 路径识别**

在聊天框输入：

```
请看这个文件：C:\Users\DELL\Desktop\test.txt
还有图片：C:\Users\DELL\Desktop\photo.png
和目录：C:\Users\DELL\Desktop
```

期望结果：
- `test.txt` 显示为 📄 file chip，可点击打开 `C:\Users\DELL\Desktop`
- `photo.png` 显示为缩略图，点击弹灯箱
- `Desktop` 显示为 📁 dir chip，点击打开目录

- [ ] **Step 3: 测试路径不存在的情况**

在聊天框输入：

```
这个路径不存在：C:\NonExistent\Path\file.txt
```

期望结果：
- 路径显示为灰色文本，不生成 chip

- [ ] **Step 4: 测试灯箱交互**

点击图片缩略图：
- 灯箱弹出，图片居中显示
- 点击背景：灯箱关闭
- 点击 ×：灯箱关闭
- 按 Esc：灯箱关闭

- [ ] **Step 5: 测试文件打开（Tauri 模式）**

点击文件 chip：
- 文件管理器打开，显示该文件所在目录

点击目录 chip：
- 文件管理器打开，显示该目录

- [ ] **Step 6: 测试 Web 模式降级**

在浏览器 http://localhost:3000 中：
- 输入路径消息
- 点击 chip：应复制路径到剪贴板，并 toast 提示
- 图片缩略图：尝试显示但失败时隐藏

- [ ] **Step 7: 检查浏览器控制台**

打开浏览器开发者工具，检查：
- 无红色 JavaScript 错误
- 网络请求正常（Tauri invoke 调用）
- CSS 样式应用正确（chip 颜色、灯箱 z-index）

- [ ] **Step 8: Commit（测试通过）**

```bash
git add .
git commit -m "test: verify path detection and rendering in user messages"
```

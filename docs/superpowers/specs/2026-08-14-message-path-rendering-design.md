# 对话气泡中的路径检测与渲染设计

**日期**：2026-08-14  
**分类**：用户消息气泡、Tauri 交互  
**概述**：自动检测对话消息中的文件路径，为图片提供预览，为文件和目录提供可点击的系统打开功能。

---

## 1. 目标与范围

### 1.1 核心目标

- 用户发送消息后，若消息中包含文件路径，自动转换为可交互的样式
- 图片路径显示缩略图，点击弹全屏灯箱预览
- 普通文件显示文件图标 chip，点击打开所在目录（文件夹）
- 目录路径显示文件夹图标 chip，点击直接打开目录

### 1.2 检测范围

**仅处理用户发送的消息气泡**（`addMessage(role='user')`）。

- Claude 回复消息暂不处理（Markdown 已渲染，markdown 内链接与路径混淆度高）
- 输入框 chip 已有 `insertPathChip()`，本次不改动
- Web 模式（非 Tauri）仅做样式渲染，点击 fallback 到复制路径

### 1.3 范围外

- 网络 URL（http/https）
- 相对路径
- Windows UNC 路径在本版本作为可选延伸，优先支持绝对路径

---

## 2. 路径识别规则

### 2.1 匹配的路径格式

**总原则：只认绝对路径，宁可漏认不可错认。** 普通文本被误改造成 chip 的代价，
远高于少渲染一个路径（2026-08-14 修订，见 2.1.1）。

三条规则共享同一个前置边界 `(^|[\s"'(\[{（【])`，即路径必须从行首或空白/引号/括号后开始。

| 格式 | 路径体 | 示例 |
|------|--------|------|
| Windows 绝对（盘符） | `[A-Za-z]:[\\/]` + 非空白非中文标点 | `C:\Users\user\file.txt` |
| Windows UNC | `\\\\` + 非空白非中文标点 | `\\server\share\file` |
| Unix/Mac 绝对 | `(?:\/[A-Za-z0-9._+@~%-]+){2,}\/?` | `/home/user/file.txt` |

### 2.1.1 为什么这么严（修订记录）

初版用 `\/[^\s\n]{2,}` 匹配 Unix 路径，导致中文聊天内容被大面积误判：
「是否有宠物**/宝宝是2个不同的判断，**」整段被吞成路径，又因不含 `.` 被判成目录，
气泡里凭空长出 📁 chip。收紧要点：

1. **前置边界**——挡掉句子中间的斜杠。中文里 `/` 几乎都是「或」的意思（宠物/宝宝、and/or、3/7）
2. **Unix 路径限定纯 ASCII 且至少两级**——它没有 `C:\` 那样的强锚点，只能靠字符集自保；
   代价是 `/tmp` 这类单级路径不再识别
3. **中文标点不算路径字符**——中文里逗号后不跟空格，否则「C:\a.txt，然后」会整句被吞
4. **遇空白即截断**——`C:\Program Files\app.exe` 只识别到 `C:\Program`，属刻意取舍
5. **相对路径一律不认**（`src/main.js`、`./build.sh`）——无锚点，与正常文本无法区分

回归测试见 `public/js/chat.path.test.js`。

### 2.2 路径验证

> **2026-08-14 修订**：原设计写的 `invoke('plugin:shell|path_exists')` 是个不存在的命令
> ——shell 插件没有它，`src-tauri` 里也没实现，每次调用必然抛错走 catch。
> 也就是说「不存在就降级为灰文本」这条从来没生效过，`.path-notfound` 样式是死代码。
> 现改为**不做前置存在性校验**：

- **图片**：直接渲染 `<img>`，加载失败时 `onerror` 原地替换成文件 chip。
  能不能读到文件，浏览器比任何预检都清楚，这才是真信号
- **文件/目录**：不校验，直接渲染 chip；点击时若 `openPath` 失败，toast 报错

### 2.3 类型判断

> **2026-08-14 修订**：原设计依赖 `invoke('plugin:shell|path_kind')`，同样不存在，
> 所以 `isImage` 分支永远走不到——缩略图和灯箱从上线起就没生效过。改为纯扩展名判断。

```
末段扩展名 ∈ [png,jpg,jpeg,gif,webp,bmp,svg]  → 图片
末段有扩展名（且扩展名前有字符）              → 📄 文件 chip
其余                                          → 📁 目录 chip
```

「扩展名前必须有字符」是为了让 `C:\Users\DELL\.uploads`、`~/.config` 这类
点开头的隐藏目录不被误判成文件。

图片还有一道额外闸门：拿不到 `convertFileSrc`（纯浏览器环境）时不渲染 `<img>`，
直接退回 chip——本地图片在浏览器里注定加载不出来，挂个破图不如不挂。

---

## 3. 渲染策略

### 3.1 图片路径（isImage）

**气泡内嵌缩略图**：

```html
<img class="path-img" 
     src="convertFileSrc(path)"  <!-- Tauri 的 asset 转换 -->
     alt="缩略图" 
     data-path="绝对路径"
     title="点击查看完整图片" />
```

- 尺寸：最大 200×150px（内联）
- 点击事件：弹全屏灯箱（见 3.4）
- Web 模式：src 尝试 `file://` URL，失败时隐藏

### 3.2 文件路径（isFile）

**可点击 chip**：

```html
<span class="path-chip path-file" data-path="绝对路径" title="点击打开所在文件夹">
  <span class="path-icon">📄</span>
  <span class="path-name">filename.ext</span>
</span>
```

- 点击调 `tauriApi.openPath(dirPath)` 打开所在文件夹
- Web 模式：点击复制路径 → toast "已复制"

### 3.3 目录路径（isDir）

**可点击 chip**：

```html
<span class="path-chip path-dir" data-path="绝对路径" title="点击打开目录">
  <span class="path-icon">📁</span>
  <span class="path-name">dirname</span>
</span>
```

- 点击调 `tauriApi.openPath(dirPath)` 直接打开
- Web 模式：同上，复制路径

### 3.4 图片灯箱（Lightbox）

**全屏叠加层**（复用 `.phone-overlay` 的 z-index 模式）：

```html
<div id="imgLightbox" class="lightbox" hidden>
  <div class="lightbox-overlay" @click="close()">
    <img class="lightbox-img" src="..." alt="..." />
    <button class="lightbox-close" title="关闭（Esc）">×</button>
  </div>
</div>
```

- 背景半透明黑（rgba(0,0,0,0.9)）
- 图片居中、max-width/height 90vw/90vh
- 支持键盘 Esc 关闭
- 点击背景关闭

---

## 4. 实现细节

### 4.1 核心函数签名

**新增 `renderPathsInText(text, container)`**（`chat.js` 内）

```javascript
/**
 * 扫描 text 中的文件路径，替换为可交互的 DOM 节点。
 * 
 * @param {string} text - 原始消息文本
 * @param {HTMLElement} container - 气泡容器（将被填充 inline 混合内容）
 * @returns {Promise<void>}
 * 
 * 流程：
 * 1. 正则扫描绝对路径，丢弃重叠区间
 * 2. 按扩展名分类（classifyPath）：image / file / dir
 * 3. 生成 DOM：text fragment + img/chip 混合插入 container
 * 4. 绑定点击事件（打开文件夹、弹灯箱）
 * 5. Web 模式：图片也退回 chip，点击复制路径
 */
```

### 4.2 修改 `addMessage()` 的用户分支

**当前代码**（chat.js ~875）：

```javascript
if (role === 'user') {
  bubble.textContent = text;  // ← 这行改掉
}
```

**改为**：

```javascript
if (role === 'user') {
  bubble.innerHTML = '';  // 清空准备填充
  await renderPathsInText(text, bubble);
}
```

### 4.3 路径识别的正则集

```javascript
// 需要按顺序尝试（优先级：Windows > UNC > Unix），避免重复匹配
const patterns = [
  /[A-Za-z]:[\\\/][^\n]*/g,           // Windows 绝对
  /\\\\[^\s\n]+/g,                    // UNC（可选 v1 延伸）
  /\/[^\s\n]{2,}/g,                   // Unix/Mac
];
```

**匹配的边界处理**：

- 路径后跟 \n / 空格 / 标点（.,;!?） → 含进路径
- 路径后跟 `)` `)。` → 可能是语境标点，**剔除**
- 同一行多个路径 → 全部检测、全部渲染

### 4.4 类型判断（已废弃 Tauri 调用，见 2.2 / 2.3 修订）

```javascript
function classifyPath(path) {
  if (isImagePath(path)) return 'image';
  // 只看末段，且扩展名前要有字符，否则 .uploads 这种隐藏目录会被当成文件
  return /[^.\\/]\.[A-Za-z0-9]{1,8}$/.test(getPathName(path)) ? 'file' : 'dir';
}
```

### 4.5 图片 URL 转换（Tauri）

> **2026-08-14 修订**：`convertFileSrc` 在 Tauri v2 里属于 **core** 模块。
> 原代码写的 `window.__TAURI__.path.convertFileSrc` 取值恒为 `undefined`，
> 于是一路退到 `file:///`，而 WebView 出于安全会拒载 `file://`——必然是破图。

```javascript
function toWebviewUrl(path) {
  const convert = window.__TAURI__?.core?.convertFileSrc
    || window.__TAURI__?.tauri?.convertFileSrc;  // v1 兼容
  return convert ? convert(path) : null;         // null → 调用方退回 chip
}
```

### 4.6 asset 协议配置（前置条件）

`convertFileSrc` 生成的 URL 要能加载，**必须**在 `src-tauri/tauri.conf.json` 里开启
asset 协议并授权目录范围——`enable` 默认为 `false`，不配等于白做：

```json
"assetProtocol": {
  "enable": true,
  "scope": {
    "allow": ["$HOME/**"],
    "deny": ["$HOME/.ssh/**", "$HOME/.aws/**", "$HOME/.gnupg/**"]
  }
}
```

- `allow` 取 `$HOME/**`：桌面/下载/文档/AppData（上传目录在此）都覆盖到，
  又不至于把整盘读权限交给 WebView
- `deny` 优先于 `allow`，挡掉几个凭证目录
- CSP 的 `img-src` 早已放行 `asset:` 与 `http://asset.localhost`，无需再改
- **改动此配置需重新构建 Tauri 应用，刷新页面无效**

---

## 5. 样式定义（app.css）

### 5.1 路径 chip（文件/目录）

```css
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
}

.path-chip:hover {
  background: var(--accent-soft);
  border-color: rgba(217, 119, 87, 0.55);
}

.path-icon {
  font-size: 14px;
  display: inline-block;
}

.path-name {
  font-size: 12px;
  color: var(--text);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 路径不存在时的文本表现 */
.path-notfound {
  color: var(--muted);
  opacity: 0.6;
  cursor: text;
  user-select: text;
}
```

### 5.2 图片缩略图

```css
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
```

### 5.3 灯箱

```css
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
}

.lightbox-close:hover {
  opacity: 0.8;
}
```

---

## 6. 错误处理与降级

### 6.1 Tauri 模式

| 情景 | 行为 |
|------|------|
| 图片不存在／超出 asset scope／格式不支持 | `img.onerror` 原地替换成 📄 chip |
| 末段无扩展名 | 按目录渲染（📁），点击直接打开 |
| 打开文件夹失败 | toast 提示错误，不重试 |

### 6.2 Web 模式（浏览器）

| 情景 | 行为 |
|------|------|
| 所有路径 | 渲染 chip（含图片——拿不到 `convertFileSrc` 就不渲染 `<img>`） |
| 点击文件/目录 | 复制路径到剪贴板 → toast "已复制" |
| 灯箱 | 不会触发（没有缩略图可点） |

---

## 7. 交互流程

### 7.1 时序图

```
用户发送消息（含路径）
    ↓
chat.js: addMessage(role='user', text)
    ↓
await renderPathsInText(text, bubble)
    ├─ 正则扫描路径（只认绝对路径）
    ├─ 按扩展名分类：image / file / dir
    ├─ 生成 DOM (text + img + chips)
    ├─ 绑定点击监听
    └─ 返回
    ↓
气泡插入 DOM，用户可见
    ↓
用户点击图片 → lightbox 弹出
用户点击文件 chip → openPath(dirPath)
用户点击目录 chip → openPath(dirPath)
```

---

## 8. 测试场景

### 8.1 路径识别

- [x] Windows 路径：`C:\Users\xxx\file.txt`
- [x] Windows UNC（可选）：`\\server\share\file`
- [x] Mac/Linux：`/home/user/file.txt`
- [x] 同行多路径：`C:\a\b.txt and D:\c\d.png`
- [x] 路径+标点：`See C:\file.txt.` 和 `Check (C:\file.txt)`

### 8.2 类型检测（Tauri）

- [x] 图片存在：显示缩略图 + 灯箱可用
- [x] 文件存在：显示 📄 chip + 点击打开目录
- [x] 目录存在：显示 📁 chip + 点击打开目录
- [x] 不存在路径：灰文本降级，无 chip

### 8.3 交互

- [x] 灯箱：点击背景/Esc 关闭
- [x] 文件 chip：点击打开所在目录
- [x] 目录 chip：点击打开目录
- [x] Web 模式：点击复制路径、toast 提示

### 8.4 边界

- [x] 空路径或纯符号
- [x] 超长路径显示（ellipsis）
- [x] 网络异常（Tauri 验证失败）

---

## 9. 不在本版本范围

1. **Claude 回复中的路径** —— 复杂度高（markdown link vs 路径混淆），独立 spec
2. **输入框路径 chip** —— 已有 `insertPathChip()`，不改动
3. **相对路径** —— 暂无上下文，延后
4. **URL 识别** —— 网络路径与本地路径职责分离
5. **文件预览**（非图片） —— 超范围，v2 考虑

---

## 10. 关键依赖

- **Tauri API**：`openPath()`（shell 插件）、`core.convertFileSrc`
  - ~~`plugin:shell|path_exists` / `path_kind`~~：**这两个命令不存在**，已于 2026-08-14 移除调用
  - 回退：若 tauriApi 未初始化，直接 Web 模式行为
- **tauri.conf.json**：`app.security.assetProtocol.enable` 必须为 true（见 4.6）
- **convertFileSrc**（可选）：Tauri 提供，asset 路径转换
- **window.getSelection / Range API**：路径识别与 DOM 插入

---

## 11. 提交策略

1. **修改文件**：
   - `public/js/chat.js`：`addMessage()` 改动 + 新增 `renderPathsInText()`
   - `public/app.css`：新增 `.path-chip`、`.path-img`、`.lightbox-*` 样式
   - `public/index.html`：新增 `<div id="imgLightbox">` 骨架

2. **测试**：
   - 在聊天框发送包含路径的消息，验证识别与样式
   - Tauri 模式验证文件夹打开
   - 灯箱弹出与关闭

3. **Commit 信息**：`feat: 对话气泡路径检测与渲染 - 支持文件预览和系统打开`

# Markdown 文件 Chip 快速打开 — 设计文档

**日期**：2026-08-24  
**标题**：点击聊天气泡中的 `.md` 文件 chip，直接跳 Markdown 查看器打开

---

## 1. 背景与需求

### 当前状态
- Claude 等 AI 模型在聊天中返回文件路径，前端自动解析成 chip（文件 / 目录图标）
- 点击任意文件 chip 的行为：
  - **Tauri 模式**：在文件管理器中定位该文件
  - **Web 模式**：复制路径到剪贴板
- `.md` 文件在应用中有专有的"Markdown 查看器"工具，支持目录导航、搜索、导出等

### 用户痛点
- 用户在聊天中看到 `.md` 文件路径，想快速预览其内容
- 目前需要手动打开文件管理器或复制路径再选择文件，体验脱节

### 设计目标
**一步打开**：点击 `.md` chip → 自动切换到 Markdown 查看器 & 打开文件，与图片点击预览逻辑一致

---

## 2. 实现方案（方案 A - 视图桥接）

### 2.1 架构原则
延续现有"视图桥"模式：
- `chat.js` 导出一个 `bindMarkdownNav(callback)` 函数供 `app.js` 注入
- 与现有的 `bindChatNav`、`bindTasksNav` 保持架构一致
- 依赖注入 → 模块间解耦

### 2.2 文件变更清单

#### `public/js/chat.js`

**新增辅助函数** —— 检测路径是否为 Markdown 文件：
```javascript
function isMarkdownPath(path) {
  return /\.(md|markdown)$/i.test(path);
}
```
放在 `isImagePath` 函数下方。

---

**修改 `makePathChip(path, kind)` 函数** —— 区分 Markdown 文件的样式：

在 chip 节点创建后、绑定事件前，添加：
```javascript
// 如果是 Markdown 文件，使用专属样式
if (kind === 'file' && isMarkdownPath(path)) {
  chip.classList.add('path-markdown');
  icon.textContent = '📝';
  chip.title = '点击用 Markdown 查看器打开';
}
```

---

**修改 `classifyPath(path)` 函数** —— 细粒度分类：

在函数内添加 Markdown 检测（在 `isImagePath` 检测后面）：
```javascript
function classifyPath(path) {
  if (isImagePath(path)) return 'image';
  if (isMarkdownPath(path)) return 'markdown';  // 新增
  return /[^.\\/]\.[A-Za-z0-9]{1,8}$/.test(getPathName(path)) ? 'file' : 'dir';
}
```

---

**修改 `handlePathChipClick(path)` 函数** —— 拦截 Markdown 文件点击：

在函数开头添加（在 Tauri 模式检测前）：
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

  // 后续是原有逻辑：Tauri 定位 / Web 复制...
  if (!window.tauriApi?.revealPath) {
    // Web 模式...
  } else {
    // Tauri 模式...
  }
}
```

---

**新增视图桥回调** —— 供 `app.js` 注入：

在文件顶部、与其他视图桥（`_goChat`、`_isChatViewActive`）并列定义：
```javascript
let _openMarkdown = null;
export function bindMarkdownNav(fn) {
  _openMarkdown = fn;
}
```

---

#### `public/app.js`

**在导入区添加** —— 导入 `bindMarkdownNav`：
```javascript
import { bindMarkdownNav } from './js/chat.js';
```

---

**修改 `markdownTool` 初始化逻辑** —— 初始化后立即注入回调：

```javascript
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

---

### 2.3 流程图

```
聊天气泡中的 .md 文件路径
        ↓
   解析为 chip
        ↓
   [用户点击] → isMarkdownPath() 判定?
        ↓                      ↓
      是（.md）              否（其他文件）
        ↓                      ↓
   _openMarkdown()        原有行为
        ↓              （Tauri 定位/Web 复制）
   showView('markdown')
        ↓
   markdownTool.openFileByPath(path)
        ↓
   切换视图 + 打开文件
```

---

## 3. 影响范围

### 变更范围（最小化）
- **修改文件**：2 个（`chat.js` + `app.js`）
- **新增代码**：~30 行
- **删除代码**：0 行
- **breaking changes**：无

### 向后兼容性
- 非 `.md` 文件 chip 点击行为完全不变
- 已有的 `.md` 文件路径 chip 只是换了样式（📝 代替 📄）和点击目标
- 如果未来想添加"右键菜单"选项（保留原行为的快捷方式），可以无缝扩展

---

## 4. 验收要点

- [ ] 点击 `.md` / `.markdown` 文件 chip 直接跳 Markdown 查看器打开
- [ ] chip 样式区分（📝 vs 📄）
- [ ] 非 Markdown 文件 chip 点击行为不变
- [ ] 架构与现有 `bindChatNav`、`bindTasksNav` 一致
- [ ] 没有全局变量污染，严格依赖注入
- [ ] 集成测试：Tauri 模式、Web 模式都验证一遍

---

## 5. 性能与安全

### 性能
- 路径检测使用简单正则 → O(1) 开销
- 无新的网络请求或 DOM 操作
- 回调注入不影响其他流程

### 安全
- `openFileByPath` 已在 `markdown-tool.js` 中实现，接收的 `path` 经过验证
- 点击事件完全在前端处理，无额外后端调用
- 不涉及新的文件读写权限

---

## 6. 未来扩展点

1. **右键菜单**：在文件 chip 上加右键菜单，提供"在文件管理器中定位"选项
2. **拖拽打开**：支持从 Markdown 查看器拖拽打开本地 `.md` 文件（目前已支持）
3. **快捷键**：Ctrl/Cmd + 点击 = 在文件管理器中定位（保留旧行为）


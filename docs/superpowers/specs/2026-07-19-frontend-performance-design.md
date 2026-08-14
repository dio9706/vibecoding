# 前端性能优化设计

**日期**：2026-07-19  
**范围**：`public/app.js` + `public/app.css`  
**目标**：预防性优化，减少内存占用，提升流式输出期间的 CPU/DOM 效率  

---

## 背景

当前前端为纯原生 JS + CSS 单页应用，无构建步骤、无框架。随着使用量增长，以下热路径会逐步成为性能瓶颈：

1. 流式输出期间，每条 token 触发一次 `renderConvList()`（完整 DOM 重建）
2. 每条消息写入都触发一次 `JSON.parse + JSON.stringify` 全量 localStorage 操作
3. `bubbleAt(index)` 每次调用都线性扫描 `.msg` 节点
4. 日志面板一次性将 1000 条记录全部写入 DOM
5. 侧栏搜索 keyup 直接触发完整列表重建

---

## 方案 A（已选）：精准热路径修复 + 轻量列表优化

### 改动 1：renderConvList 防抖

- **当前行为**：`recordMessage → saveConvs → renderConvList`，每 token 执行一次
- **改为**：写脏标志 `_convListDirty = true`，200ms 防抖计时器合批渲染
- **flush 时机**：切换会话、新建对话、删除对话时立即 flush
- **收益**：200 个 token → 从 200 次重建降为 1 次

### 改动 2：loadConvs 读缓存

- **当前行为**：每次调用都 `JSON.parse(localStorage.getItem(...))`
- **改为**：内存变量 `_convsCache`，saveConvs 时同步更新，loadConvs 直接返回缓存
- **收益**：高频路径 JSON.parse 消除

### 改动 3：saveConvs 写防抖

- **当前行为**：每条消息直接序列化并写 localStorage
- **改为**：直接修改 `_convsCache`（快），500ms 防抖攒批写入 localStorage
- **flush 时机**：`beforeunload` 事件强制 flush，防止页面关闭丢数据
- **收益**：流式期间序列化频率降 ~95%

### 改动 4：bubbleAt 改 Map 缓存

- **当前行为**：`querySelectorAll('.msg')[index]` 每次线性扫描
- **改为**：维护 `_bubbleMap: Map<convId, Element[]>`，addMessage 时更新，endJob/newConversation 时清空
- **收益**：paintJob 每帧 O(n) → O(1)

### 改动 5：DocumentFragment 批量插入

- **改动点**：`renderConvList`、`loadLogs` 等列表渲染循环
- **改为**：先在 DocumentFragment 内批量 createElement，最后一次 appendChild
- **收益**：减少 reflow 次数

### 改动 6：日志列表虚拟滚动

- **当前行为**：1000 行全部 createElement 插入 DOM
- **改为**：
  - 外层容器固定高度，overflow-y: auto
  - 内层 spacer 撑满真实高度（rowCount × ROW_HEIGHT）
  - 只渲染可见区 ±5 行 buffer（约 40 行）
  - scroll 事件节流（16ms）动态置换内容
  - 行高固定 32px（日志行为单行文本，高度可预测）
- **搜索降级**：日志面板顶部提供搜索输入框（客户端过滤），替代浏览器 Ctrl+F
- **收益**：1000 行 DOM → 40 行，内存减少 ~96%，首次打开延迟大幅降低

### 改动 7：convSearch 输入防抖

- **当前行为**：keyup 直接调 renderConvList
- **改为**：300ms 防抖
- **收益**：快速输入时不频繁重排

---

## 影响范围

| 文件 | 新增/修改行数 |
|------|-------------|
| `public/app.js` | ~+120 行（含防抖工具函数、虚拟滚动逻辑） |
| `public/app.css` | ~+15 行（日志虚拟滚动容器样式） |

---

## 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| saveConvs 防抖可能在极端情况下丢最后 500ms 数据 | beforeunload flush；内存缓存始终最新 |
| 日志虚拟滚动边界情况（resize、快速滚动）可能有闪烁 | scroll 节流 + 渲染前 requestAnimationFrame |
| bubbleAt Map 缓存若未及时清理会有悬空引用 | endJob/openConv/newConversation 统一清理入口 |

---

## 不在本次范围内

- 消息区虚拟滚动（消息数量当前规模可接受）
- localStorage 消息条数上限（方案 C 内容）
- Service Worker / 缓存策略

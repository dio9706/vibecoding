---
title: 会话清理功能设计文档
date: 2026-09-04
status: approved
---

# 会话清理功能设计

## 概述

在设置页增加一个独立 tab「会话清理」，支持按时间范围（快捷预设 + 自定义日期）筛选并物理删除历史会话文件。

**需求背景：** 用户积累的会话文件可能很多，需要定期清理以节省磁盘空间。

**清理范围：** 仅清理当前选中工作目录对应的会话（对应 `~/.claude/projects/<projectId>/` 下的 `.jsonl` 文件）。

---

## 功能设计

### 1. 用户界面

#### 1.1 新增 Tab
在设置页 `panel-tabs` 中新增「会话清理」tab，排序如下：
```
[基础设置] [模型] [MCP服务器] [托管配置] [会话清理] [桌面]
```

#### 1.2 清理 Tab 内容
**顶部统计信息：**
- 当前目录路径显示：`当前目录: /path/to/project`
- 总会话数：`总会话数: 42`
- 将删除数：`将删除: 8 个`（动态更新，粗体红色强调）

**时间范围选择：**

**快捷选项（单选按钮组）：**
- ◉ 一周前（7 天前）
- ◯ 两周前（14 天前）
- ◯ 一月前（30 天前）
- ◯ 三月前（90 天前）

**自定义日期范围（可折叠）：**
- 默认隐藏，点「⌄ 自定义日期范围」展开
- 两个 date input：`从 [YYYY-MM-DD]` 和 `至 [YYYY-MM-DD]`
- 用户输入后实时预计算待删除数

**操作按钮：**
- `[⌄ 自定义日期范围]`（折叠/展开切换按钮）
- `[清理会话]`（主操作按钮，红色标记危险操作，默认 disabled，选定范围后启用）

---

### 2. 交互流程

#### 2.1 初始加载
1. 用户打开设置页 → 点击「会话清理」tab
2. 前端调 `GET /api/cleanup/stats` 获取当前目录的总会话数
3. 显示统计信息，快捷选项默认不选中

#### 2.2 选择范围
1. 用户点击某个快捷选项 → 或填写自定义日期
2. 前端实时调 `GET /api/cleanup/preview?range=7` 或 `?fromDate=...&toDate=...`
3. 服务端返回 `{ willDeleteCount: 8 }`，前端更新「将删除」的数字
4. 「清理会话」按钮从 disabled 变为 enabled

#### 2.3 执行清理
1. 用户点「清理会话」按钮
2. 弹出 `confirmDialog`：
   ```
   ⚠️ 危险操作
   确定删除 8 个会话？此操作不可恢复。
   [取消] [确认删除]（红色）
   ```
3. 用户确认后 → 调 `POST /api/cleanup/execute` → `{ range: 7 }` 或 `{ fromDate, toDate }`
4. 服务端执行删除，返回 `{ deletedCount: 8, error?: "..." }`
5. 前端显示 toast：`✓ 已删除 8 个会话`，同时重新加载统计（显示新的总数）

#### 2.4 错误处理
- **无会话匹配条件** → toast：`无符合条件的会话`
- **权限不足** → toast：`权限不足，无法删除文件`
- **目录不存在** → toast：`当前目录不可用`
- **网络错误** → toast：`网络错误，请重试`

---

### 3. 数据流与后端 API

#### 3.1 新增 HTTP 端点

**GET /api/cleanup/stats**
- **请求：** 无参数
- **响应：**
  ```json
  {
    "cwd": "/path/to/project",
    "totalCount": 42,
    "historyDir": "~/.claude/projects/C--Users-DELL-Desktop-claude-p-web-demo"
  }
  ```
- **错误：** `{ error: "目录不存在" }` (200)

**GET /api/cleanup/preview**
- **请求参数：**
  - `range`: 7|14|30|90（预设天数）
  - 或 `fromDate` + `toDate`（ISO 8601 格式）
- **响应：**
  ```json
  {
    "willDeleteCount": 8,
    "oldestSession": "2026-08-28T10:30:00Z",
    "newestSession": "2026-09-04T09:00:00Z"
  }
  ```

**POST /api/cleanup/execute**
- **请求体：**
  ```json
  {
    "range": 7,
    "confirmed": true
  }
  ```
  或
  ```json
  {
    "fromDate": "2026-08-28",
    "toDate": "2026-09-04",
    "confirmed": true
  }
  ```
- **响应：**
  ```json
  {
    "deletedCount": 8,
    "remainingCount": 34,
    "freedBytes": 1048576
  }
  ```
- **错误：** `{ error: "..." }` (400/500)

#### 3.2 后端实现清单

**文件位置：**
- `src/entrypoints/web/routes-cleanup.js` — 三个 handler
- `src/store/history.js` — 新增删除函数 `deleteHistorySessions(range, fromDate?, toDate?)`

**routes-cleanup.js 关键函数：**
```javascript
export function handleCleanupStats(res) {
  // 读取历史目录、统计会话数
  // 返回 { cwd, totalCount, historyDir }
}

export function handleCleanupPreview(req, res, url) {
  // 解析 range / fromDate / toDate
  // 调 history.js 的 previewCleanup() 计算待删数
  // 返回 { willDeleteCount, oldestSession, newestSession }
}

export function handleCleanupExecute(req, res) {
  // 校验 confirmed=true
  // 调 history.js 的 deleteHistorySessions()
  // 返回 { deletedCount, remainingCount, freedBytes }
}
```

**history.js 新增函数：**
```javascript
/**
 * 预计算待删会话数（无副作用）
 * @param {number} [range] - 天数（7/14/30/90）
 * @param {string} [fromDate] - ISO 8601
 * @param {string} [toDate] - ISO 8601
 * @returns {Promise<{ count, oldest, newest }>}
 */
export async function previewCleanup(range, fromDate, toDate) { }

/**
 * 物理删除会话文件
 * @param {number} [range]
 * @param {string} [fromDate]
 * @param {string} [toDate]
 * @returns {Promise<{ deletedCount, freedBytes }>}
 */
export async function deleteHistorySessions(range, fromDate, toDate) { }
```

---

### 4. 前端实现清单

**文件位置：**
- `public/js/settings-panel.js` — 新增清理 UI 初始化和事件绑定
- `public/app.css` — 清理 tab 的样式

**public/js/settings-panel.js 新增函数：**
```javascript
// 加载清理页面统计
async function loadCleanupStats() { }

// 预计算待删数（用户选择时触发）
async function previewCleanup(range, fromDate, toDate) { }

// 执行清理
async function executeCleanup(range, fromDate, toDate) { }

// 绑定快捷选项和自定义日期的事件
function bindCleanupEvents() { }
```

**HTML 骨架已在前述 UI 部分定义。**

---

### 5. 核心约定与限制

**①  幂等性：** 清理操作是幂等的，同一批次重复执行不会出现"文件已删除"错误（先检查存在再删）。

**② 并发安全：** 后端清理时使用文件锁（如已有 `lock.js`）防止 web / feishu 两进程同时删除同一会话。

**③ 时间基准：** 筛选时用会话文件的 `mtimeMs`（修改时间）而非创建时间，更符合「最近未使用」的直觉。

**④ 软删除 vs 硬删除：** 本需求明确为「物理删除」（直接 `fs.unlink`），无回收站或备份机制。用户操作前必须确认。

**⑤ 日志记录：** 清理操作记入 `event-log.json`（格式参照 `src/store/event-log.js`），便于审计。

---

### 6. 测试策略

**单元测试（对应 `*.test.js`）：**
- `src/store/history.test.js` 新增：
  - `deleteHistorySessions()` 正常删除
  - `previewCleanup()` 日期筛选正确性
  - 边界：空目录、超大文件数、时间边界
  
- `src/entrypoints/web/routes-cleanup.test.js` 新增：
  - 三个 handler 的输入校验
  - 权限错误、目录不存在的错误路径
  - 响应格式一致性

**集成测试（E2E）：**
- 在测试项目目录生成若干假会话文件（不同时间戳）
- 调清理 API → 验证文件确实被删除
- 验证日志记录

**前端测试：**
- UI 显示、按钮启用/禁用逻辑
- 快捷选项切换时数字正确更新
- 自定义日期展开/收起的状态切换

---

### 7. 部署与回滚

**无数据库迁移需求** — 仅文件系统操作，无 schema 变更。

**向后兼容** — 新 tab 对现有功能无影响；旧版本设置文件在新版本也能正常工作。

**回滚方案** — 若需回滚，删除 routes-cleanup.js、history.js 的新函数、UI 代码，设置页自动隐藏清理 tab。

---

## 验收标准

- [ ] UI 完整呈现：统计、快捷选项、自定义日期、按钮状态
- [ ] 快捷选项和自定义日期切换时，「将删除」数字实时更新
- [ ] 点清理后出现确认对话框，文案清晰、标记为危险操作
- [ ] 删除完成后 toast 显示摘要，统计数字更新
- [ ] 错误场景处理完善（权限、目录不存在等）
- [ ] 后端日志记录清理操作
- [ ] 单测覆盖核心逻辑（日期筛选、文件删除）


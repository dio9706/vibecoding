# 需求开发期 UI 优化设计

**日期**：2026-08-19  
**作者**：Claude Design  
**状态**：设计阶段

---

## 概述

优化需求开发期（`phase === 'dev'`）的右栏 UI，移除鸡肋功能，增强核心功能的易用性：

1. **API 文档管理**：从"仅能新增（删除再上传）"优化为"点击替换更新"，用户体验更流畅
2. **设计准则**：删除输入框和确认发送按钮，界面更聚焦；用户若需指导 Claude 直接在会话中告诉它

---

## 需求

### 功能 1：API 文档支持点击替换更新

**现状**：
- 用户上传 API 文档列表，每条仅有"✕"删除按钮
- 若要更新文档内容，必须手动：删除旧版本 → 再次点击＋上传 → 选择新文件
- 操作链条长，容易出错，且中间产生"消息已删除"的通知

**改动**：
- 每条文档增加"🔄"替换按钮
- 点击替换 → 选择新文件 → 后端自动识别为"更新"（保留原文档 ID，仅更新 `path` 和 `updatedAt`）
- 后端返回 `action === '更新'`，前端自动发送 api-fix 消息告诉 Claude 对照修正

**API 合约**（无改动，后端已支持）：
- 新增：`POST /api/req/apidoc { id, name: file.name, path }`
- 替换：`POST /api/req/apidoc { id, name: doc.name, path }` ← **name 为原文档名**
- 后端按 `name` 主键：存在即更新，不存在即新增，返回 `{ ok, action, doc }`

**用户体验**：
- 替换操作"一键"完成（vs 删除+新增两步）
- 不产生"已删除"的冗余通知
- 文档版本链条清晰（原 ID 不变，`updatedAt` 更新）

---

### 功能 2：移除设计准则输入框和确认发送按钮

**现状**：
- 开发期右栏有"🎨 设计准则"输入框 + "✓ 确认发送"按钮
- 用户可编辑设计准则（主色、圆角、间距等），点击确认发送给 Claude
- 实际使用中此功能鸡肋：很少有用户主动填写，也很少产生实际效果

**改动**：
- 删除"🎨 设计准则"输入框和"✓ 确认发送"按钮（约 70 行 UI 代码）
- 后端字段和路由保留（零风险，历史数据兼容）
- 若用户需要设计准则指导，直接在会话中告诉 Claude（更自然、更灵活）

**数据兼容性**：
- `designGuidelines` 字段保留，仍被注入到开发提示词
- 已保存的值不丢失，后续若需恢复 UI 可无缝接上
- `PUT /api/req/guidelines` 路由保留

**用户体验**：
- 界面更简洁，仅保留有高频使用价值的功能（API 文档）
- 准则指导通过会话更自然："请遵循这些设计准则：主色#007bff、圆角4px..."

---

## 架构与数据流

### API 文档替换流程

```
用户界面
  ↓
点击 🔄 替换按钮（某条文档）
  ↓
设置 pendingReplaceName = doc.name
  ↓
触发文件选择器 fileInput.click()
  ↓
用户选择新文件
  ↓
fileInput.change 事件
  ↓
1. POST /api/upload?name=file.name → { path, name }
2. POST /api/req/apidoc { id, name: pendingReplaceName, path }
  ↓
后端判断：
  - 若 name 存在 → action='更新'，更新 path + updatedAt
  - 若 name 不存在 → action='新增'，生成新 id
  ↓
返回 { ok, action, doc }
  ↓
前端发送 api-fix 消息给 Claude（文案自动适配"已更新"）
  ↓
refreshRail(reqId) 局部刷新右栏
```

### 新增流程（对比）

```
用户界面
  ↓
点击 ＋上传 按钮
  ↓
清空 pendingReplaceName
  ↓
触发文件选择器
  ↓
... （上传逻辑同上，pendingReplaceName 为 undefined）
  ↓
POST /api/req/apidoc { id, name: file.name, path }
  ↓
后端返回 action='新增'
```

---

## 技术改动清单

### 文件 1：`public/js/req-chat.js`

#### 改动 A：API 文档替换按钮（`paintDocs()` 函数）
- 在每条 `.req-apidoc-item`（行 396-440）的 `<button class="delete-btn">✕</button>` 前追加
- 新增"🔄"替换按钮，点击时设置 `pendingReplaceName = doc.name` 后触发 `fileInput.click()`
- **代码位置**：行 407-440（删除按钮 handler 之前）
- **改动行数**：~15 行

#### 改动 B：参数化上传流程（`fileInput.addEventListener('change', ...)` 事件）
- 将行 476 的 `name: file.name` 改为 `name: pendingReplaceName || file.name`
- 在 `fileInput.change` 事件开始前声明 `let pendingReplaceName = null`（行 463 附近）
- 在 `refreshRail(reqId)` 后清空：`pendingReplaceName = null`
- **代码位置**：行 463-501
- **改动行数**：~15 行

#### 改动 C：删除设计准则（`renderDevRail()` 函数）
- 删除整个"🎨 设计准则"区块（行 503-570）
- 修改行 572：`railEl.append(docsSec, guideSec)` → `railEl.append(docsSec)`
- **代码位置**：行 503-572
- **改动行数**：删除 ~68 行，修改 1 行

### 文件 2：`public/js/req-chat.apidoc.test.js`

#### 改动 D：单测更新
- 新增"替换文档"场景的单测
- 验证：替换时 `pendingReplaceName` 被传递、后端返回 `action='更新'`、消息文案正确
- **改动行数**：~15 行

---

## 边界守卫与错误处理

**沿用既有机制**（无改动）：

1. **世代号守卫**（`epoch`）
   - 上传/替换/删除 handler 都检查 `epoch !== chromeEpoch || currentReqId !== data.id`
   - 防止用户切换需求后消息发到错误会话

2. **会话状态检查**
   - 若 `data.convId` 为空，报错"会话未就绪"
   - 确保 api-fix 消息不会静默消失

3. **局部刷新**
   - 操作完成后调 `refreshRail(reqId)`，重拉最新数据并重绘右栏
   - 防止界面过期或不一致

---

## 测试清单

- [ ] API 文档新增：上传新文件 → 消息"已新增" → 列表刷新
- [ ] API 文档替换：点击🔄 → 选新文件 → 消息"已更新" → 列表刷新（文档 ID 不变，updatedAt 更新）
- [ ] API 文档替换（不同文件名）：替换时选择与原名不同的新文件 → 仍按原名登记 → 触发"更新"分支
- [ ] API 文档删除：删除后消息"已删除" → 列表刷新
- [ ] 会话未就绪：操作时 convId 为空 → 报错"会话未就绪" → 消息不发出
- [ ] 用户切换需求：操作途中切换 → 检查 epoch → 操作完成但不发消息（防错发）
- [ ] UI 视觉：设计准则区块已移除，仅显示 API 文档区块

---

## 后端影响

**零改动**：
- `designGuidelines` 字段保留，`PUT /api/req/guidelines` 路由保留
- `POST /api/req/apidoc` 的替换逻辑已在 routes-requirements.js 行 267-279 实现
- 测试 routes-requirements.test.js:262-265 已验证同名替换行为

**兼容性**：
- 现有会话历史不受影响
- 若需恢复设计准则 UI，仅需前端改动

---

## 工作量估计

| 任务 | 文件 | 行数 | 时间 |
|------|------|------|------|
| 替换按钮 UI | `req-chat.js` | ~15 | 10 min |
| 参数化上传 | `req-chat.js` | ~15 | 10 min |
| 删除设计准则 | `req-chat.js` | ~70 删除 + 1 修改 | 2 min |
| 单测更新 | `req-chat.apidoc.test.js` | ~15 | 5 min |
| **合计** | | ~116 | **27 min** |

---

## 风险评估

| 风险 | 可能性 | 影响 | 缓解 |
|------|--------|------|------|
| 替换时误解为新增 | 低 | 文档重复 | 后端按 `name` 主键，不可能新增重名文件 |
| 用户找不到替换按钮 | 中 | 操作困惑 | 按钮紧挨删除按钮，tooltip 提示"更新文档" |
| 设计准则被删除后用户反馈 | 低 | 功能诉求 | 后端字段完整保留，恢复 UI 成本低 |
| 替换途中网络中断 | 低 | 操作失败 | 现有机制已处理，错误提示"上传失败" |

---

## 后续扩展

- 支持批量替换多个文档
- 文档版本历史记录（保留所有历史上传的 path）
- 文档预览（Read API 文档内容）

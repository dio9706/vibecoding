# 需求文档生成增强设计

**日期：** 2026-08-05  
**作者：** Claude Code  
**状态：** 待审核

## 概述

当前需求系统的开发文档生成（docgen）功能需要三项增强：
1. **摘要 Markdown 渲染**：目前「说人话总结」文案显示为纯文本，应 Markdown 渲染
2. **生成完成后展示统计信息**：显示耗时和 token 消耗量
3. **机器人通知集成**：完成后通过配置的飞书机器人自动通知用户

## 目标

提升用户体验，在文档生成完成时以结构化、清晰的方式呈现结果和消耗信息，支持跨平台通知。

## 需求细节

### 需求 1：摘要 Markdown 渲染

**当前行为：**
- 版本条目中的 `summary` 字段存储 Markdown 格式文本
- 页面显示时文案标签为「🗣 说人话总结」
- 内容使用 `textContent = activeEntry.summary`，以纯文本呈现

**目标行为：**
- 文案标签改为「📝 摘要」
- 使用 `renderMarkdown(container, summary)` 渲染，支持加粗、标题、列表等 Markdown 格式

**影响范围：** 前端仅（public/js/req-view.js）

---

### 需求 2：耗时与 Token 消耗展示

**当前行为：**
- `runDocgen` 捕获耗时（`Date.now() - t0`）但仅输出到日志
- 版本记录 `{ v, path, summary, at }` 不包含耗时或 token 数
- 用户无法看到资源消耗情况

**目标行为：**
- 版本条目扩展字段：`ms`（耗时毫秒）、`inputTokens`、`outputTokens`
- 前端在最新版本的 Markdown 内容下方显示：
  ```
  耗时 2m 35s · 输入 12.3k tokens · 输出 4.1k tokens
  ```
- 仅最新版本显示（历史版本若无该字段则静默不显示）

**数据流：**
1. `claude.js` 的 `onResult` 回调提取 `message.usage.input_tokens` 和 `message.usage.output_tokens`
2. `requirement-ops.js` 的 `runDocgen` 在成功时将 token 数和耗时写入版本条目
3. `req-view.js` 渲染时检查 `activeEntry.ms` 存在则展示统计行

**影响范围：** 前端 + 后端

---

### 需求 3：机器人通知集成

**当前行为：**
- 需求可配置关联机器人（bots-panel.js）
- 没有「生成完成通知」的概念

**目标行为：**

#### 前端（public/js/req-view.js）
- 在文档区（无文档空态 + 有文档 tabs 下方）新增一行交互：
  ```
  ☐ 完成后通过机器人通知我  [机器人下拉▼]
  ```
- 勾选后展示机器人下拉列表，拉取 `/api/bots`，默认选中第一个 `enabled` 的机器人
- 状态存需求对象的 `notifyBotId` 字段（使用现有 `/api/req/config PUT` 扩展）
- 仅在评审期（phase='review'）显示此交互

#### 后端（requirement-ops.js）
- docgen 成功、写完版本后，检查 `req.notifyBotId` 是否非空
- 若非空且 `getMyFeishuOpenId()` 也非空，触发异步通知（fire-and-forget，不阻塞）
- 通知内容（飞书文本消息）：
  ```
  需求「{需求标题}」，开发文档已生成
  耗时：{时间，如 2m 35s}
  Token 消耗：输入 12.3k · 输出 4.1k
  ```

#### 飞书集成（integrations/lark.js）
- 新增函数 `sendTextToUser(botCreds, openId, text)`
  - 参数：bot 凭证（appId + secret）、用户 open_id、消息文本
  - 使用该凭证创建临时 Lark API client，调 `message.create` 发送到 `open_id`
  - 不影响全局 singleton client（后续消息仍用原 client）
  - 失败静默（logger.warn），不影响 docgen 主流程

---

## 架构与数据流

### 三层协调

```
runDocgen (requirement-ops.js)
  ├─ onResult 回调：捕获 inputTokens/outputTokens（来自 claude.js）
  ├─ 版本记录写入：{ v, path, summary, at, ms, inputTokens, outputTokens }
  └─ docgen 成功
      ├─ renderDocArea (req-view.js)：展示统计信息
      └─ 检查 req.notifyBotId → sendDocgenNotify (lark.js)
```

### 存储结构

**需求对象扩展字段：**
```javascript
{
  id: '...',
  title: '...',
  phase: 'review',
  devDoc: {
    versions: [
      {
        v: 1,
        path: '...',
        summary: '...（Markdown）',
        at: '2026-08-05T10:00:00Z',
        ms: 155000,           // ← 新增：耗时毫秒
        inputTokens: 12300,   // ← 新增：输入 token 数
        outputTokens: 4100    // ← 新增：输出 token 数
      }
    ]
  },
  notifyBotId: 'bot-id-123'  // ← 新增：完成后通知的机器人 ID（null 表示不通知）
}
```

---

## 实现考虑

### 兼容性
- 版本记录新增字段是可选的（历史版本不一定有 `ms`/`inputTokens`/`outputTokens`）
- 前端渲染时需要检查字段存在再显示，无字段则不显示统计行
- `notifyBotId` 设置也完全可选，不设则不通知

### 前置条件
- 飞书通知仅在用户配置了「我的飞书 open_id」（设置 → 基础设置）时触发
- 机器人需具有发送私聊消息的权限（通常默认有）
- 如果通知失败（网络 / 凭证过期等），仅 logger.warn，不影响 docgen 主流程

### 性能与故障处理
- 通知是异步 fire-and-forget，不阻塞 docgen 结束路径
- Token 数提取在 `onResult` 回调中同步完成，无额外开销
- 摘要渲染使用现有 `renderMarkdown` 工具，无新依赖

---

## 测试清单

- [ ] 摘要内容使用 Markdown 格式时正确渲染（加粗、标题等）
- [ ] 版本条目包含 `ms` / `inputTokens` / `outputTokens` 字段
- [ ] 前端显示统计信息：耗时 + token 消耗（格式化为 k 单位）
- [ ] 评审期显示「完成后通过机器人通知我」选项
- [ ] 勾选后下拉展示机器人列表，默认第一个
- [ ] 保存配置后，刷新页面保持选中状态
- [ ] docgen 完成后，未设置 `notifyBotId` 时不发通知
- [ ] docgen 完成后，已设置 `notifyBotId` + `myFeishuOpenId` 时通过飞书发通知
- [ ] 通知消息包含正确的需求标题、耗时、token 数
- [ ] 用户未配置 `myFeishuOpenId` 时，静默不发通知（logger.warn）
- [ ] 通知发送失败时，仅日志记录，不影响 docgen 状态

---

## 影响范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `public/js/req-view.js` | 修改 | renderDocArea 渲染摘要 + 统计信息；新增通知选项 UI |
| `src/integrations/claude.js` | 修改 | onResult 回调提取并传递 inputTokens / outputTokens |
| `src/entrypoints/web/requirement-ops.js` | 修改 | runDocgen 捕获 token 数；成功时写版本并触发通知 |
| `src/integrations/lark.js` | 新增 | sendTextToUser 函数（指定凭证发送给 open_id） |
| `public/app.css` | 修改 | 可选：统计信息文案样式（如 color: var(--text-muted)） |

---

## 版本与兼容

- **首次实施版本：** v2.1.0（之后所有生成的版本均包含新字段）
- **历史版本处理：** 无字段则静默不显示统计（无迁移需求）
- **配置迁移：** `notifyBotId` 从 null 开始，用户手动选择机器人时才填充

---

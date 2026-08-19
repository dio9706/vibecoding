# 飞书会话回控功能设计

**日期**：2026-08-19  
**作者**：Claude Design  
**状态**：设计阶段

---

## 概述

优化飞书通知功能，移除鸡肋的「补充内容」和「结束会话」按钮，改为在卡片底部显示会话 ID 和使用说明。新增两个功能：

1. **会话 ID 提示**：在通知卡片末尾显示会话前 8 位 ID，用户可通过 `会话 xxxx 内容` 格式继续对话
2. **新建会话指令**（`\10003 新建会话`）：允许用户在飞书侧创建新会话，后端生成真实会话条目并同步到网页端
3. **摘要优化**：将通知卡片内容摘要从头部截断改为末尾向前截断，字数上限从 300 增至 500

---

## 需求

### 功能 1：移除卡片按钮，增加会话 ID 提示行

**现状**：会话结束后推送卡片给用户，卡片底部有两个按钮：
- 📝 补充内容（实际使用率极低）
- 🛑 结束会话（本质无用——用户关闭通知就行）

**改动**：
- 删除 `action` 标签（两个按钮）
- 在文本末尾追加一行：
  ```
  ---
  会话ID：a1b2c3d4
  如需继续对话，向我发送：会话 a1b2c3d4 你的内容
  ```
  其中 `a1b2c3d4` = `convId.slice(0, 8)`

**影响范围**：`buildConvSettledCard()` 卡片构造函数

---

### 功能 2：`会话 xxxx 内容` 精确路由

**用户行为**：在飞书发送 `会话 a1b2c3d4 我要补充一些东西`

**系统行为**：
1. 识别格式 `会话 <8位ID> <正文>`
2. 在 `conv-notify.json` 中精确查找 `convId` 以该 ID 开头的会话
3. 若找到，调用既有的 `postInject` 机制将内容注入到目标会话
4. 若未找到，回复用户「未找到该会话，请检查会话 ID」

**触发优先级**：order=16（在 claude-exec 之前），防止被误当成普通对话吃掉

**实现文件**：
- `src/plugins/feishu-relay/logic.js`：新增 `matchSessionText()` 解析函数
- `src/store/conv-notify.js`：新增 `findEntryByShortId()` 查询函数  
- `src/plugins/feishu-relay/index.js`：扩展 `match` 和 `handle` 逻辑分支

---

### 功能 3：`\10003 新建会话` 指令

**用户行为**：在飞书发送 `\10003 新建会话`（精确文案匹配）

**权限**：owner 或 trusted 用户（复用既有权限体系）

**系统行为**：
1. 生成 UUID 作为 `convId`
2. 在 `conv-notify.json` 中调用 `enableConv()` 注册该会话（标题："飞书新建会话"）
3. 在 web 侧创建真实会话条目（前端可在侧边栏看到）
4. 回复用户：
   ```
   ✅ 已新建会话
   会话ID：a1b2c3d4
   向我发送「会话 a1b2c3d4 你的内容」即可开始对话
   ```

**跨进程流程**：
```
飞书进程：识别 \10003 → 权限校验 → POST /api/conv-notify/new
web 进程：收请求 → 生成 convId → enableConv() → 创建会话 → 返回 convId
飞书进程：收到 convId 前 8 位 → 回复用户
```

**实现文件**：
- `src/plugins/trusted-commands/index.js`：新增 `\10003` 处理器
- `src/entrypoints/web/routes-conv-notify.js`：新增 `POST /api/conv-notify/new` 路由
- Web 侧需要调用会话创建逻辑（使用既有的创建会话 API）

---

### 功能 4：摘要优化（末尾截断，字数 500）

**现状**：通知卡片内容摘要使用 `s.slice(0, 300)` 从头截断，容易丢失关键信息

**改动**：
- 改为 `'…' + s.slice(-500)` 从末尾向前保留
- 字数上限从 300 → **500**

**好处**：
- 用户看到的是最新产出的结果（对话末尾）
- 开头的上下文铺垫被省略，信息密度更高

**实现文件**：`src/entrypoints/web/conv-notify.logic.js` 中 `summarize()` 函数

---

## 数据模型

### Conv Entry 扩展（已有，无改动）

`conv-notify.json` 中每个会话条目：
```json
{
  "convId": "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "title": "飞书新建会话",
  "session": "...",
  "cwd": "...",
  "model": "auto",
  "effort": "medium",
  "mode": "default",
  "enabledAt": "2026-08-19T10:00:00.000Z",
  "lastNotifiedAt": null,
  "inbox": []
}
```

### Web 新增路由

**POST /api/conv-notify/new**
- 请求体：`{}` （无参数）
- 响应：`{ ok: true, convId: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d" }`
- 副作用：在 `conv-notify.json` 中新增一条、在 web 侧创建真实会话

---

## 交互流程

### 流程 1：会话结束 → 飞书推卡片

```
Claude 任务完成
  ↓
web 侧调 sendCard → 飞书
  ↓
卡片显示（带会话 ID 和使用说明，无按钮）
  ↓
用户在飞书（选项 A）：点按钮等待补充 / 点结束会话
用户在飞书（选项 B）：直接发「会话 a1b2c3d4 补充」
  ↓
飞书进程识别格式 → 查表找会话 → postInject 到 web 台 → 后续任务继续
```

### 流程 2：用户主动新建会话

```
用户在飞书发「\10003 新建会话」
  ↓
飞书进程权限校验（owner/trusted）
  ↓
POST /api/conv-notify/new → web 进程
  ↓
Web 生成 convId、enableConv()、创建会话
  ↓
返回 convId → 飞书进程
  ↓
回复用户会话 ID 和使用说明
  ↓
用户发「会话 a1b2c3d4 内容」→ 执行任务（同流程 1）
```

---

## 文件改动清单

| 文件 | 改动 | 优先级 |
|------|------|--------|
| `src/entrypoints/web/conv-notify.logic.js` | 1. `buildConvSettledCard()` 删除按钮、加 ID 提示行；2. `summarize()` 改末尾截断、字数改 500 | P0 |
| `src/plugins/feishu-relay/logic.js` | 新增 `matchSessionText(text)` 函数，识别 `会话 xxxx 内容` 格式 | P0 |
| `src/store/conv-notify.js` | 新增 `findEntryByShortId(shortId)` 函数，按前 8 位查表 | P0 |
| `src/plugins/feishu-relay/index.js` | 扩展 `match` 和 `handle`，处理 `会话 xxxx` 路由 | P0 |
| `src/plugins/trusted-commands/index.js` | 新增 `\10003 新建会话` 处理器 | P1 |
| `src/entrypoints/web/routes-conv-notify.js` | 新增 `POST /api/conv-notify/new` 路由 | P1 |
| Web 前端 | （需调查）创建会话的既有 API / 流程 | P1 |

---

## 边界情况 & 风险

### 前 8 位 ID 冲突

**风险**：理论上两个 UUID 前 8 位相同（概率 1/16^8 ≈ 1 亿分之一）

**处理**：
- 若冲突，`findEntryByShortId()` 返回最近创建的那个（按 `enabledAt` 倒序）
- 用户可补全更多位数重试（格式仍为 `会话 xxxxx 内容`，只要前缀唯一即可）

### 跨进程超时

**风险**：`POST /api/conv-notify/new` 超时（web 进程未运行或卡住）

**处理**（参考 `postInject` 模式）：
- 设置 3 秒超时
- 超时或异常回复用户「执行台无响应，请稍后再试」

### 会话注册后用户未在网页激活

**风险**：飞书侧创建的会话在 `conv-notify.json` 中，但 web 端未创建真实会话

**处理**：
- `\10003` 的响应中必须同时创建 web 侧会话（不能只写 JSON）
- 前端通过既有的 inbox 轮询机制看到这个新会话

### 权限校验缺失

**风险**：任何人都能在飞书创建会话

**处理**：
- `\10003` 处理器复用既有的 trusted-commands 权限体系
- 仅 owner 和 trusted 用户允许（同 `\10001`、`\10002`）

---

## 测试清单

- [ ] 卡片显示：无按钮，有会话 ID 和使用说明
- [ ] 摘要截断：500 字，末尾保留关键信息
- [ ] `会话 xxxx 内容` 精确路由：找到会话→成功注入 / 未找到→提示用户
- [ ] `\10003 新建会话`：权限校验通过→创建成功 / 权限不足→静默忽略
- [ ] 跨进程：web 进程未运行→超时降级 / 正常运行→返回 convId
- [ ] 网页端：新建的会话在侧边栏可见

---

## 后续扩展

- 飞书侧会话列表查询（用户发 `\10004 列表所有会话`）
- 会话绑定标签/分类
- 会话搜索（`会话 keyword`）

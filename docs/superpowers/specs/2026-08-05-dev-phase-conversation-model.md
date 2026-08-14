# 开发期交互模型改造 — 设计文档

**日期**：2026-08-05  
**状态**：待实现  
**关联**：requirement-workflow-design.md

---

## 一、背景与目标

### 现状问题

当前开发期的工作机制是**服务端系统任务模型**：
- 进入开发期后服务端自动 `enqueueSystemTask('develop')`，即使不开浏览器也在后台运行。
- 过程对用户不可见（只有顶部一颗 busy 芯片在转）。
- 提示词不可见。
- 上传 API 文档/设计准则修改只更新记录，无法与正在进行的 Claude 会话实时交互。
- 右侧准则文本框失焦即保存，没有「确认发送」步骤。

### 目标

让开发期**与普通会话完全一致的交互体验**，差异仅在于：
1. 打开会话时自动发送 develop 提示词（无需手动输入）。
2. 右侧 API 文档操作后自动发送对应提示词。
3. 设计准则有确认按钮，点击后才主动发送。

---

## 二、核心架构决策

### 客户端驱动，放弃后台自跑

| 方面 | 现有（服务端系统任务） | 改造后（普通会话） |
|------|--------------------|--------------------|
| 触发时机 | 定稿后立即后台自跑 | 用户打开会话时前端自动发送 |
| 过程可见 | 不可见 | 逐字流式，完全可见 |
| 提示词可见 | 不可见 | 显示为用户气泡 |
| 插话/追问 | 通过 busy 串行闸排队 | 正常会话插话（排队注入或新轮发送） |
| 权限审批 | bypassPermissions | bypassPermissions（不变） |
| 不开浏览器 | 后台自跑 | **不跑**（接受此权衡） |
| 额度用尽续跑 | busy + pending-resume 机制 | 正常会话 pending-resume 机制（天然复用） |

**接受"不开浏览器就不跑"的理由**：开发期是需要实时交互/插话的场景，用户本就需要在场。

### 移除的服务端系统任务

| 任务 | 现状 | 改造后 |
|------|------|--------|
| `develop` | 服务端 enqueueSystemTask | 前端自动发消息，完全走正常会话路径 |
| `api-fix` | 服务端 enqueueSystemTask | 前端上传/删除完成后自动发消息 |
| 设计准则 | 失焦存库，注入 develop 提示词 | 点确认才发消息（同时存库） |
| `bug-fix` | 测试期服务端系统任务 | **本次不动**（超出范围） |
| `docgen` | 评审期服务端系统任务 | **本次不动**（仍在后台评审期跑） |

---

## 三、用户交互流程

### 3.1 进入开发期

```
用户定稿需求
    → 服务端: phase = 'dev'，新建 convId，入库
    → 前端 openRequirementChat: openConv(convId)
    → mountReqChrome 拉取需求数据
    → 检测条件:
        - phase === 'dev'
        - conv.messages 全为空（没有内容）
        - busy === null（没有正在跑的任务）
    → 前端自动发送 develop 提示词（作为普通用户消息）
    → Claude 收到并开始开发（bypassPermissions）
```

**提示词来源**：调用客户端侧的 `buildDevelopPrompt`（从 `/api/req/get` 拿数据）。  
**触发时机**：每次打开会话时检测，若条件全满足则自动发。条件任一不满足则跳过（已有历史/正在跑/已完成不再触发）。

### 3.2 上传 / 删除 API 文档

```
用户上传 API 文档（或删除）
    → 前端 POST /api/req/apidoc（或 DELETE）
    → 服务端更新 apiDocs 记录（仅更新记录，不再 enqueueSystemTask）
    → 前端收到 202 → 自动发消息: buildApiFixPrompt 的内容
        "后端 API 文档「xxx」已新增（路径 yyy，请先 Read）
         请对照该 API 文档变更，检查并修正本需求已实现代码中所有相关调用。"
    → Claude 通过正常插话/新轮接收并处理
```

### 3.3 设计准则确认发送

```
用户在右栏编辑设计准则文本框
    → 失焦时：仅存库（PUT /api/req/guidelines），不发消息（与现有逻辑相同）
    → 点击「✓ 确认发送」按钮:
        1. 存库（如尚未保存则先保存）
        2. 发送消息: "设计准则已更新，请在后续开发中遵循：\n{准则内容}"
        3. 按钮短暂变为「已发送 ✓」然后恢复
```

---

## 四、前端实现要点

### 4.1 req-chat.js — 自动发送 develop 提示词

**位置**：`mountReqChrome` 完成数据加载后。

**条件判断**（三个条件同时满足）：
```
data.phase === 'dev'
AND conv.messages.every(m => !m.text?.trim())   // 会话无实质内容
AND !data.busy                                   // 无正在跑的任务
AND !hasQueuedItem(convId)                       // 无排队消息（防抖动双触发）
```

**发送方式**：调用 `chat.js` 导出的 `sendMessageProgrammatically(text, { mode: 'bypassPermissions' })`（新建此接口），内部走正常 `/api/run/start` 路径，区别仅在于不经过 `<textarea>` 输入框（避免覆盖用户正在输入的内容）。

**提示词构建**：前端侧重建 `buildDevelopPrompt`（从 `data` 字段取 projects/designGuidelines/apiDocs/devDoc），不依赖服务端逻辑（保持前后端同步，两侧都有此函数）。

### 4.2 req-chat.js — API 文档自动发送

上传/删除 API 文档成功（服务端 202）后，前端构建并发送：
```js
const text = action === '删除'
  ? `后端 API 文档「${doc.name}」已删除\n\n请对照该 API 文档变更，检查并修正本需求已实现代码中所有相关调用。`
  : `后端 API 文档「${doc.name}」已${action}（路径 ${doc.path}，请先 Read）\n\n请对照该 API 文档变更，检查并修正本需求已实现代码中所有相关调用。`;
sendMessageProgrammatically(text);
```

### 4.3 req-chat.js — 设计准则确认按钮

- `textarea.blur` → 仅调 `PUT /api/req/guidelines`（存库），同现有逻辑。
- 新增 `<button class="q-btn q-btn-text">✓ 确认发送</button>`，只在开发期渲染。
- 点击按钮：
  1. 若文本有未保存变更，先 PUT 存库。
  2. 调 `sendMessageProgrammatically("设计准则已更新，请在后续开发中遵循：\n" + text)`。
  3. 按钮文案切换为「已发送 ✓」2 秒后恢复；同时更新 `ta.dataset.saved = text`（防止重复发送）。

### 4.4 chat.js — sendMessageProgrammatically

新增导出函数，绕过 `<textarea>` 直接触发发送流程：

```js
export function sendMessageProgrammatically(text, opts = {}) {
  // opts.mode: 权限模式，默认取当前 chatMode，自动开发传 'bypassPermissions'
  // 内部复用现有 sendMessage 核心逻辑（POST /api/run/start）
  // 区别：文本直接传入，不从 textarea 读取
}
```

**与现有发送路径的关系**：复用同一套 POST `/api/run/start` → `attachStream` → `runningJobs` 机制，不新增服务端接口。

### 4.5 req-view.js — 去除 develop busy 依赖

`openRequirementChat` 完成后，不再有 busy 态需要等待。开发期打开后即进入正常会话视图。

---

## 五、服务端改动

### 5.1 routes-requirements.js

| 接口 | 现有行为 | 改后行为 |
|------|---------|---------|
| `POST /api/req/apidoc` | 更新记录 + `enqueueSystemTask('api-fix', ...)` | **仅更新记录**（移除 enqueue 调用） |
| `DELETE /api/req/apidoc` | 更新记录 + `enqueueSystemTask('api-fix', ...)` | **仅更新记录** |
| `PUT /api/req/guidelines` | 存库 | 不变（只存库，不触发任何任务） |

### 5.2 requirement-ops.js

- 移除 `dispatch` 中的 `develop` 分支（`dispatchSystemTask` 对 develop 的处理）。
- `enqueueSystemTask` 不再接受 `'develop'` 和 `'api-fix'` 类型（或保留但永不入队）。
- `api-fix` 和 `develop` 的 busy 串行闸逻辑随之清理。
- `buildDevelopPrompt` 和 `buildApiFixPrompt` 保留（后端测试、前端也可直接引用等值逻辑）。
- **保留**：`bug-fix`（测试期）、`docgen`（评审期）、对应串行闸逻辑不动。

### 5.3 canDispatch / 串行闸

`canDispatch` 的 `hasActiveRunForConv` 检查仍然有效（`bug-fix` 仍需等用户会话空闲），只是 `develop`/`api-fix` 不再入队，实际影响面缩小。

---

## 六、兼容性与边界

| 场景 | 处理方式 |
|------|---------|
| 已有历史（之前跑过）再打开 | `conv.messages` 非空 → 不触发自动发送 |
| Claude 正在开发中时上传文档 | 消息通过正常插话路径排队注入当前运行 |
| Claude 正在开发中时确认准则 | 同上，插话排队 |
| 刷新页面 | `openConv` 恢复历史 + `attachStream` 重连正在跑的 run → 不重复自动发送（conv 非空） |
| 定稿后不打开浏览器 | 不自动开发（已接受此权衡） |
| 已完成的需求再打开 | conv 非空（有历史）→ 不触发自动发送，正常查看历史 |
| 旧版 develop busy 残留 | `recoverBusyOnBoot` 现有逻辑：重启清残留 busy → 前端打开时 busy=null，条件满足则重新发 develop |

---

## 七、测试要点

1. **自动发 develop**：进入开发期、打开会话 → develop 提示词作为用户气泡出现、Claude 开始开发。
2. **不重复触发**：关闭再打开 → 已有历史，不重发。
3. **API 文档上传**：上传后前端自动发 api-fix 消息，Claude 收到并处理。
4. **API 文档删除**：同上，消息内容为"已删除"。
5. **设计准则确认**：编辑准则 → 失焦存库（不发消息）→ 点确认 → 消息发出 → 再点确认（内容同上次）→ 幂等（不重发）。
6. **并发**：Claude 开发中上传文档 → 消息排队插话，Claude 收到后处理。
7. **bug-fix / docgen 不受影响**：测试期 bug-fix、评审期 docgen 仍正常工作。
8. **权限模式**：自动发的 develop 消息以 bypassPermissions 运行。

---

## 八、不在本次范围

- 测试期 bug-fix 改为会话模型（保留系统任务）。
- 评审期 docgen 改为会话模型（保留系统任务）。
- 后台自跑（不开浏览器也能开发）。
- 会话消息服务端持久化。

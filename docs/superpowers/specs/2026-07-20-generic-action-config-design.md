# 通用动作配置系统 — 设计规范

**日期**：2026-07-20  
**状态**：草稿，待用户确认  
**替代**：`src/features/data-cleanup`（硬编码清理功能 → 由本系统的一条配置覆盖）

---

## 1. 背景与目标

现有 `data-cleanup` 功能硬编码了"清理账号数据"这一个用例（固定脚本路径、固定变量手机号/环境）。  
目标是把它抽象成**配置驱动**：管理员在 Web 设置页注册「动作配置」，包含意图关键词、脚本路径、所需变量；用户用自然语言触发后，系统自动填槽、缺变量就追问，最终以 `--param value` 调用脚本。

**不变的部分**：现有的 dispatch → classify → feature 路由框架、`shell.js` 执行层、`store/index.js` 持久化基座、权限模型。

---

## 2. 核心实体

### 2.1 ActionConfig（动作配置）

存储于 `action-configs.json`（项目根，gitignore 中加入或按需保留）。

```json
{
  "id": "uuid-v4",
  "name": "清理账号数据",
  "description": "清理某账号在 dev/test 环境的账号数据",
  "keywords": ["清理", "清空", "重置", "清除", "初始化"],
  "scriptType": "python",
  "scriptName": "reset_onboarding.py",
  "permission": "guest",
  "enabled": true,
  "variables": [
    {
      "name": "env",
      "label": "环境",
      "prompt": "要清理哪个环境？请回复 dev 或 test",
      "required": true,
      "persistent": false
    },
    {
      "name": "phone",
      "label": "手机号",
      "prompt": "请提供您的手机号（11 位）",
      "required": true,
      "persistent": true
    }
  ],
  "createdAt": "2026-07-20T00:00:00Z",
  "updatedAt": "2026-07-20T00:00:00Z"
}
```

字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | UUID，系统生成 |
| `name` | string | 人类可读名称（Web UI 展示） |
| `description` | string | 给 Claude 消歧用的一句话描述（精确、包含核心词） |
| `keywords` | string[] | 关键词快路匹配，任意一个命中则记为候选 |
| `scriptType` | `"python"` \| `"node"` | 决定用 `python` 还是 `node` 启动 |
| `scriptName` | string | 脚本文件名，必须位于 `scripts/` 目录下（不含路径） |
| `permission` | `"guest"` \| `"owner"` | 沿用现有权限模型 |
| `enabled` | boolean | 禁用后不参与意图匹配，不触发执行 |
| `variables` | Variable[] | 见下表，内联定义 |

Variable 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 脚本参数名，对应 `--{name} value` |
| `label` | string | 中文标签，仅 Web UI 展示 |
| `prompt` | string | 缺失时向用户发送的追问文案 |
| `required` | boolean | true = 必须在调用脚本前收集到 |
| `persistent` | boolean | true = 收集后绑定 userId，下次跳过追问 |

### 2.2 UserVars（用户变量存储）

存储于 `user-vars.json`，**替代现有** `bindings.json`（迁移见第 7 节）。

```json
{
  "ou_xxxx": {
    "phone": "13800138000"
  }
}
```

一个 userId（open_id）对应一个 KV 对象，key 为 variable.name，value 为字符串值。

---

## 3. 意图识别架构（两级：关键词召回 → Claude 消歧）

> 目标：配置 N 条动作，平均耗时不随 N 线性增长；大多数请求走关键词快路，不调 Claude。

### 3.1 第一级：关键词召回

遍历全部 `enabled: true` 的 ActionConfig，用用户消息文本匹配每条的 `keywords`：

- **0 条命中** → 进入 Claude 消歧，传入**所有 enabled 配置**（最多 20 条，超过截断并记 warn）
- **1 条命中** → 直接命中，跳过 Claude，进入槽位填充
- **2+ 条命中** → 进入 Claude 消歧，只传入命中的候选子集

### 3.2 第二级：Claude 消歧（仅 0 或 2+ 候选时）

与现有 `claudeClassify` 同款调用：`maxTurns:1`、禁全部工具、30s 超时 + race 兜底。  
使用 Haiku（轻模型），Prompt 示例：

```
你是意图分类器，仅输出一行 JSON，不要任何解释。
用户说：「帮我重置一下 13800138000」

可选动作：
1. id=abc123  清理账号数据 — 清理某账号在 dev/test 环境的账号数据
2. id=def456  发送验证码 — 向指定手机号发送短信验证码

若用户意图与某动作匹配，输出 {"action_id":"abc123"}；
若均不匹配，输出 {"action_id":null}。
```

消歧结果 `action_id: null` → 降级到 `other` 意图走帮助兜底。  
消歧成功 → 同样进入槽位填充。

### 3.3 与现有 intent.js 的关系

**`classifyAction(text)` 返回值**（新增函数）：
```js
// 命中某条 ActionConfig
{ intent: 'action', actionId: 'uuid', actionName: '清理账号数据' }
// 无匹配
{ intent: 'other' }
```

**`classify(text)` 统一入口改为**（调用顺序）：
```
1. feedbackKeyword 快路（bug/feature 关键词）→ 命中直接返回 { intent: 'bug'|'feature' }
2. classifyAction(text)                       → 命中返回 { intent: 'action', actionId, actionName }
3. fallback                                   → 返回 { intent: 'other' }
```

**dispatch.js 无需改动**：`action-runner` feature 注册时声明 `intents: ['action']`，dispatch 收到 `intent.intent === 'action'` 时自动路由并把 `intent.actionId` 透传给 `handle(ctx, intent)`。

**移除**：`hasCleanupIntent` 函数（cleanup 意图已由 ActionConfig 的 keywords 覆盖）；`addLearnedVerb` 路径（新系统关键词在配置里管理，不依赖自学习）。  
`learned-keywords.js` / `store` 中对应代码在本次一并清理。

---

## 4. 槽位填充（Slot Filling）

ActionConfig 命中后，进入 `action-runner` feature 的 handle 逻辑：

```
用户消息 ──→ [从消息文本提取变量值] ──→ [合并持久化变量] ──→ [检查缺失必填]
                                                                    ↓
                                                        缺失 → 追问用户（存 pendingState）
                                                        齐全 → 执行脚本
```

### 4.1 变量提取（从消息文本）

使用轻量 Claude 调用（Haiku, maxTurns:1），prompt 动态构建：
```
从以下用户消息中提取变量，仅输出一行 JSON。
变量定义：phone=手机号(11位数字), env=环境(dev|test)
用户消息：「帮我清一下 test 的 13800138000」
输出：{"phone":"13800138000","env":"test"}，找不到的字段省略。
```

提取结果与持久化缓存合并：`{ ...persistentVars[userId], ...extractedVars }`

> **回退策略**：Claude 提取失败（超时/解析失败）→ 走正则兜底（手机号 `/1[3-9]\d{9}/`，env `/\b(dev|test)\b/`），与现有 data-cleanup 行为一致。

### 4.2 持久化变量复用

`persistent: true` 的变量：
1. 执行前先查 `user-vars.json[userId][varName]`，有值则跳过追问
2. 用户提供后（无论首次还是追问），立即写入 `user-vars.json`

### 4.3 追问状态机

与现有 `data-cleanup` 的 state Map 同款：

```
// pendingState: userId → { actionId, collected: {}, waitingFor: variableName }
const pendingState = new Map()
```

每次 handle：
1. 有 pendingState → 追问当前 waitingFor 变量
2. 收到用户回复 → 提取/存储 → 检查下一个缺失必填 → 继续追问或执行
3. 用户发「取消」→ 清 state
4. run 终结时（finish/fail）→ 通过 `drainState` 清理（参考现有 drainAsks 设计）

---

## 5. 脚本执行层

### 5.1 安全约束

- `scripts/` 目录（项目根，`SCRIPTS_DIR` env 可覆盖）作为**白名单沙箱**
- Web UI 配置时 `scriptName` 仅允许文件名（不含路径分隔符 `/` `\` `..`），后端校验
- 参数传递全走数组 `['--varName', 'value']`，永不拼字符串，无 shell 注入风险（现有 `shell.js` 已是此模式）

### 5.2 调用方式

```js
// python: python scripts/reset_onboarding.py --env test --phone 13800138000
// node:   node scripts/send_sms.js --phone 13800138000
const bin = scriptType === 'node' ? 'node' : config.scripts.pythonBin
const scriptPath = path.join(config.scripts.dir, scriptName)
const args = [scriptPath, ...buildArgs(collectedVars)]
// buildArgs: [{name:'env',value:'test'},{name:'phone',value:'...'}] → ['--env','test','--phone','...']
```

复用现有 `runScript(bin, args, { cwd, env })` 封装，零改动。

### 5.3 执行日志

新建 `src/store/action-log.js`，替代 `cleanup-log.js`，记录：
```json
{
  "time": "ISO8601",
  "userId": "ou_xxxx",
  "actionId": "uuid",
  "actionName": "清理账号数据",
  "vars": { "env": "test", "phone": "159****9503" },
  "ok": true,
  "code": 0
}
```
`phone` 等敏感变量自动脱敏（`maskValue`：中间 4 位打 *）。

---

## 6. Web 设置页 UI（"动作配置" Tab）

### 6.1 布局

在现有设置弹层（`#settingsPanel`）的下划线 tab 列表中增加第四个 tab：**动作配置**。

Tab 内部两区：
- **左：动作列表**（简洁 table：名称 / 关键词预览 / 脚本 / 权限 / 启用开关 / 编辑·删除按钮）
- **右（或下方弹层）：编辑表单**（新建/编辑复用同一表单）

### 6.2 编辑表单字段

```
动作名称     [________________]
意图描述     [________________]  (给 Claude 消歧用)
关键词       [清理, 清空, 重置]  (tag 输入，回车添加)
脚本类型     [Python ▼]
脚本文件名   [________________]  (下拉选 scripts/ 目录现有文件)
权限         [guest ▼]
是否启用     [✓]

── 变量 ────────────────────────────────
[+ 添加变量]
┌─────┬──────┬──────────────────┬──────┬────────┐
│ 名称│ 标签 │ 追问文案         │ 必填 │ 永久存储│
├─────┼──────┼──────────────────┼──────┼────────┤
│phone│手机号│请提供您的手机号  │  ✓  │   ✓    │
│env  │环境  │请回复 dev 或 test│  ✓  │        │
└─────┴──────┴──────────────────┴──────┴────────┘
```

### 6.3 API 端点（新增）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/actions` | 列出全部动作配置 |
| `POST` | `/api/actions` | 新建（server 生成 id + createdAt） |
| `PUT` | `/api/actions/:id` | 更新（server 更新 updatedAt） |
| `DELETE` | `/api/actions/:id` | 删除 |
| `GET` | `/api/scripts` | 列出 `scripts/` 目录下的文件名（供编辑表单选择） |

---

## 7. 迁移计划（data-cleanup → 配置条目）

### 7.1 删除的文件
- `src/features/data-cleanup/index.js`
- `src/store/cleanup-log.js`

### 7.2 修改的文件

| 文件 | 改动 |
|---|---|
| `src/features/index.js` | 移除 dataCleanup import，注册 actionRunner |
| `src/app/intent.js` | 保留 feedback 快路；新增 `classifyAction()`；`classify()` 改调新函数 |
| `src/app/dispatch.js` | 无需改动（通过 feature 注册表自动路由） |
| `src/shared/config.js` | 移除 `config.cleanup`；新增 `config.scripts.dir` / `pythonBin` |
| `src/shared/messages.js` | 移除 `cleanupAskPhone` / `cleanupAskEnv`（追问文案改为配置内联） |

### 7.3 数据迁移

启动时（`server.js` 启动钩子）自动执行一次性迁移：
1. 若 `action-configs.json` 不存在 → 写入默认配置条目（内容见第 2.1 节示例），脚本文件名 `reset_onboarding.py`（需手动放到 `scripts/`）
2. 若 `bindings.json` 存在且 `user-vars.json` 不存在 → 将 `{ userId: phone }` 转为 `{ userId: { phone } }` 写入 `user-vars.json`

---

## 8. 新增的文件结构

```
src/
  features/
    action-runner/
      index.js          # feature handler（handle / hasPending / intents）
      slot-filler.js    # 变量提取 + 追问状态机
      script-runner.js  # 组装参数 + 调用 shell.js + 脱敏日志
  store/
    action-configs.js   # CRUD for action-configs.json
    user-vars.js        # CRUD for user-vars.json（替代 bindings.js）
    action-log.js       # append-only 执行日志（替代 cleanup-log.js）
scripts/
  reset_onboarding.py   # 从原位置移动（或 symlink）过来
```

---

## 9. 边界与约束

- **脚本白名单**：`scriptName` 后端校验仅允许 `[a-zA-Z0-9_\-\.]+`，不允许 `/` `\` `..`
- **并发追问**：每个 userId 同一时刻只有一个 pendingState（串行，与现有 data-cleanup 一致）
- **超时**：脚本执行无超时（与现有 runScript 一致；长脚本由调用方自行控制）
- **配置上限**：建议 ≤ 20 条 enabled 配置（超过后 Claude 消歧 prompt 变长，记录 warn 日志）
- **变量数上限**：每条配置建议 ≤ 8 个变量（追问交互成本随变量数线性增长）
- **权限**：动作配置 CRUD API 仅 Web UI 访问（无独立鉴权，沿用现有 web server 设计）

---

## 10. 不在本次范围内

- 脚本执行结果的 Web UI 可视化（仅现有飞书 reply 回传）
- 微信/QQ 适配（预留 `ctx.source` 已有，但本次不测试）
- 变量值校验规则（如"手机号必须 11 位"目前靠 Claude 提取兜底）
- 脚本上传（scripts/ 目录仍需手动维护）
- 执行历史 Web 查看页（执行日志仍以 JSONL 文件落盘，不做 UI）

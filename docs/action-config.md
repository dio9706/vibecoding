# 动作配置系统 使用指南

> **更新日期**：2026-07-20  
> **对应规范**：`docs/superpowers/specs/2026-07-20-generic-action-config-design.md`

本文档说明如何在本项目中使用**通用动作配置系统**，该系统提供了灵活的配置化动作定义、意图识别、变量填槽和脚本执行能力。

---

## 目录

1. [快速开始](#快速开始)
2. [配置动作](#配置动作)
3. [触发动作](#触发动作)
4. [脚本规范](#脚本规范)
5. [日志与审计](#日志与审计)
6. [手动测试清单](#手动测试清单)
7. [常见问题](#常见问题)

---

## 快速开始

### 启动服务

在项目根目录执行：

```bash
npm start
```

或使用 PM2 重启：

```bash
pm2 restart principal-web
```

首次启动时，系统自动在项目根目录创建以下文件：

- **`action-configs.json`** — 动作配置存储（JSON 数组）
- **`user-vars.json`** — 用户变量持久化（键值对象）
- **`action-log.jsonl`** — 执行日志（JSON Lines 格式，一行一条）

### 验证启动

访问 http://localhost:3000，打开 Web 设置页（左侧菜单"设置"或齿轮图标），应看到新 Tab：**"动作配置"**。

---

## 配置动作

### 在 Web UI 中新建或编辑动作

#### 步骤

1. **打开设置页**  
   访问 http://localhost:3000，点击左侧菜单的"设置"或齿轮图标，进入 Web 设置页

2. **切换到「动作配置」Tab**  
   在顶部 Tab 栏找到「动作配置」，点击切换

3. **查看现有配置**  
   左侧列表展示所有已注册的动作配置，包括：
   - 动作名称
   - 关键词预览
   - 脚本文件名
   - 编辑/删除按钮

4. **添加新动作**  
   点击「+ 添加动作」按钮，右侧弹出编辑表单

5. **填写基本信息**

   | 字段 | 说明 | 示例 |
   |------|------|------|
   | **动作名称** | 人类可读的名称，显示在 Web UI 和日志中 | 清理账号数据 |
   | **意图描述** | 给 Claude 消歧用的一句话描述，需精确包含核心词 | 清理某账号在 dev/test 环境的账号数据 |
   | **关键词** | 触发关键词列表（逗号或标签分隔），命中任意一个则候选 | 清理, 清空, 重置, 清除, 初始化 |
   | **脚本类型** | Python 或 Node.js | Python |
   | **脚本文件名** | 不含路径的文件名，必须在 `scripts/` 目录中存在 | reset_onboarding.py |
   | **权限** | 执行权限级别（guest / owner） | guest |
   | **启用此动作** | 复选框，取消则不参与意图匹配 | ✓ |

6. **定义变量**

   点击「+ 添加变量」为此动作添加所需的参数。每个变量由以下属性组成：

   | 字段 | 说明 | 示例 |
   |------|------|------|
   | **名称** | 变量名，对应脚本的 `--{name}` 参数 | phone |
   | **标签** | 中文显示名（仅 Web UI） | 手机号 |
   | **追问文案** | 缺失时向用户发送的追问文案 | 请提供您的手机号（11 位） |
   | **必填** | 是否必须提供（复选框） | ✓ |
   | **永久存储** | 是否记住用户提供的值以便下次跳过追问（复选框） | ✓ |

   **变量示例**：

   ```
   ┌──────┬────────┬──────────────────────────┬────────┬────────┐
   │ 名称 │ 标签   │ 追问文案                 │ 必填   │ 永久存储│
   ├──────┼────────┼──────────────────────────┼────────┼────────┤
   │ phone│ 手机号 │ 请提供您的手机号（11位） │   ✓    │   ✓    │
   │ env  │ 环境   │ 请回复 dev 或 test      │   ✓    │        │
   └──────┴────────┴──────────────────────────┴────────┴────────┘
   ```

7. **保存配置**  
   点击「保存」按钮，配置立即写入 `action-configs.json` 并生效

8. **编辑或删除**  
   - **编辑**：在列表中点击「编辑」按钮，修改后保存
   - **删除**：点击「删除」按钮，确认后删除配置

### 配置文件结构

配置完成后，`action-configs.json` 的结构如下：

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
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
    "createdAt": "2026-07-20T10:00:00Z",
    "updatedAt": "2026-07-20T10:00:00Z"
  }
]
```

---

## 触发动作

### 在飞书中触发

#### 流程概览

用户在飞书与机器人对话时，可以通过自然语言触发已配置的动作。系统会自动：

1. **识别意图** — 匹配关键词或 Claude 消歧
2. **提取变量** — 从消息文本中提取变量值
3. **填槽追问** — 若缺少必填变量，向用户追问
4. **执行脚本** — 所有必填变量齐全后，执行脚本
5. **记录日志** — 执行结果写入 `action-log.jsonl`

#### 示例对话

**用户**：  
> 帮我清一下 test 的 13800138000

**机器人**（后台处理）：
1. 关键词匹配「清」→ 命中「清理账号数据」动作
2. 文本提取 → `{ env: 'test', phone: '13800138000' }`
3. 检查必填：`env` ✓、`phone` ✓ → 全部齐全
4. 检查持久化：`phone` 已标记为 `persistent: true`
   - 查询 `user-vars.json[userId]['phone']`
   - 若之前提供过，跳过追问；否则记录新值
5. 执行脚本：  
   ```bash
   python scripts/reset_onboarding.py --env test --phone 13800138000
   ```
6. 回复用户：  
   > ✅ 清理账号数据完成  
   > (脚本输出内容，最后 800 字符)

#### 带追问的对话示例

**情况 1**：首次使用，用户提供了 `env` 但未提供 `phone`

**用户**：  
> 帮我清一下 test

**机器人**：
1. 文本提取 → `{ env: 'test' }`（phone 缺失）
2. 发送追问：
   > 请提供您的手机号（11 位）

**用户**：  
> 13800138000

**机器人**：
3. 收集新值 → `{ env: 'test', phone: '13800138000' }`
4. 所有必填齐全 → 执行脚本 → 回复结果

**情况 2**：用户已缓存 `phone`，再次使用时省略追问

**用户**（第二次）：  
> 清一下 dev 的账号

**机器人**：
1. 文本提取 → `{ env: 'dev' }`
2. 从 `user-vars.json[userId]['phone']` 查到缓存值 `13800138000`
3. 合并 → `{ env: 'dev', phone: '13800138000' }`
4. 所有必填齐全 → **直接执行脚本**（跳过追问）
5. 回复结果

### 意图识别的工作原理（两级）

#### 第一级：关键词快路

系统遍历所有 `enabled: true` 的动作配置，检查用户消息是否包含任意关键词：

```
用户消息 "清一下 test 的 13800138000"
         ↓
检查关键词 ['清理', '清空', '重置', ...] 中是否有匹配
         ↓
「清」命中 → 1 条候选 → 直接确定意图（跳过 Claude）
```

**结果**：
- **0 条命中** → 进入第二级（Claude 消歧）
- **1 条命中** → 直接命中，无需 Claude
- **2+ 条命中** → 进入第二级（Claude 在候选间消歧）

#### 第二级：Claude 消歧（仅在需要时调用）

当关键词快路无法确定唯一意图时，使用轻量 Claude 模型消歧：

```
用户：「帮我发通知」
         ↓
关键词快路：无匹配 → 0 条候选 → 进入 Claude 消歧
         ↓
传入所有可用配置（如：「发送验证码」、「发送通知」）
         ↓
Claude 分析并返回最匹配的 actionId
         ↓
确定意图 → 进入槽位填充
```

**优化特点**：
- 大多数请求走关键词快路，耗时短、成本低
- 仅在必要时调用 Claude，减少 API 费用
- 配置关键词时应选择有区别的词汇，避免多个动作命中

---

## 脚本规范

### 脚本位置

所有脚本必须放在项目根目录的 **`scripts/`** 文件夹中。

```
project-root/
├── scripts/
│   ├── reset_onboarding.py     ← Python 脚本
│   ├── send_sms.js              ← Node.js 脚本
│   └── notify_user.py
├── action-configs.json
├── user-vars.json
└── ...
```

### 支持的语言

- **Python** — 脚本类型 `python`，扩展名 `.py`
- **Node.js** — 脚本类型 `node`，扩展名 `.js`

### 参数传递方式

参数通过 **命令行参数** 传递，格式为 `--{name} {value}`：

```bash
# 示例
python scripts/reset_onboarding.py --env test --phone 13800138000
node scripts/send_sms.js --phone 13800138000 --code 123456
```

脚本需自行解析 `process.argv`（Node.js）或 `sys.argv`（Python）。

### Python 脚本示例

```python
import sys
import argparse

# 方案 1：使用 argparse（推荐）
parser = argparse.ArgumentParser()
parser.add_argument('--env', required=True, help='环境')
parser.add_argument('--phone', required=True, help='手机号')
args = parser.parse_args()

print(f"清理 {args.phone} 在 {args.env} 环境的数据...")

# 执行清理逻辑
try:
    # 调用 API 或执行本地操作
    result = cleanup_account(args.phone, args.env)
    print(f"✓ 清理成功：{result}")
    sys.exit(0)  # 成功
except Exception as e:
    print(f"✗ 清理失败：{str(e)}")
    sys.exit(1)  # 失败

def cleanup_account(phone, env):
    # 实现清理逻辑
    return f"account {phone} cleared in {env}"
```

```python
# 方案 2：手动解析 sys.argv
import sys

env = None
phone = None

i = 1
while i < len(sys.argv):
    if sys.argv[i] == '--env':
        env = sys.argv[i + 1]
        i += 2
    elif sys.argv[i] == '--phone':
        phone = sys.argv[i + 1]
        i += 2
    else:
        i += 1

if not env or not phone:
    print("错误：缺少必要参数 --env 或 --phone")
    sys.exit(1)

print(f"清理 {phone} 在 {env} 环境的数据...")
# ... 执行逻辑
```

### Node.js 脚本示例

```javascript
#!/usr/bin/env node

// 方案 1：使用 yargs（需要 npm install yargs）
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
  .option('env', {
    describe: '环境',
    type: 'string',
    demandOption: true,
  })
  .option('phone', {
    describe: '手机号',
    type: 'string',
    demandOption: true,
  })
  .argv;

console.log(`清理 ${argv.phone} 在 ${argv.env} 环境的数据...`);

cleanupAccount(argv.phone, argv.env)
  .then(() => {
    console.log('✓ 清理成功');
    process.exit(0);
  })
  .catch((err) => {
    console.error(`✗ 清理失败：${err.message}`);
    process.exit(1);
  });

async function cleanupAccount(phone, env) {
  // 实现清理逻辑
  return `account ${phone} cleared in ${env}`;
}
```

```javascript
// 方案 2：手动解析 process.argv
const env = process.argv.includes('--env')
  ? process.argv[process.argv.indexOf('--env') + 1]
  : null;

const phone = process.argv.includes('--phone')
  ? process.argv[process.argv.indexOf('--phone') + 1]
  : null;

if (!env || !phone) {
  console.error('错误：缺少必要参数 --env 或 --phone');
  process.exit(1);
}

console.log(`清理 ${phone} 在 ${env} 环境的数据...`);
// ... 执行逻辑
process.exit(0);
```

### 脚本的标准输出和退出码

系统会捕获脚本的标准输出（stdout）和标准错误（stderr），并根据退出码判断执行结果：

| 退出码 | 含义 | 飞书回复 |
|--------|------|---------|
| `0` | 成功 | ✅ {actionName}完成\n{output} |
| 非 0 | 失败 | ❌ 执行失败\n{output} |

**输出示例**：

```bash
$ python scripts/reset_onboarding.py --env test --phone 13800138000
清理 13800138000 在 test 环境的数据...
✓ 清理成功：account deleted
(脚本退出码：0)
```

飞书消息：
> ✅ 清理账号数据完成  
> ✓ 清理成功：account deleted

---

## 日志与审计

### 执行日志文件

脚本每次执行后，系统自动向 `action-log.jsonl` 追加一条日志。文件位于项目根目录，格式为 **JSON Lines**（每行一条 JSON 记录）。

### 日志格式

```json
{
  "time": "2026-07-20T10:00:00Z",
  "userId": "ou_xxxxxxxxxx",
  "actionId": "550e8400-e29b-41d4-a716-446655440000",
  "actionName": "清理账号数据",
  "vars": {
    "env": "test",
    "phone": "159****9503"
  },
  "ok": true,
  "code": 0
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `time` | ISO8601 | 执行时间（UTC） |
| `userId` | string | 飞书用户 open_id |
| `actionId` | string | 动作配置 UUID |
| `actionName` | string | 动作人类可读名称 |
| `vars` | object | 执行时使用的变量值（敏感字段脱敏） |
| `ok` | boolean | 执行成功/失败 |
| `code` | number | 脚本退出码 |

### 敏感字段脱敏

系统会自动对日志中的敏感字段进行脱敏，避免 PII 泄露：

**脱敏规则**：
- 字段名为 `phone` 的值 → 保留前 3 位和后 4 位，中间用 `****` 替换
- 示例：`13800138000` → `159****9503`

脱敏后的日志示例：

```json
{"time":"2026-07-20T10:00:00Z","userId":"ou_xxxx","actionId":"abc123","actionName":"清理账号数据","vars":{"env":"test","phone":"159****9503"},"ok":true,"code":0}
```

### 查看日志

```bash
# 查看最近 10 条日志
tail -10 action-log.jsonl

# 查看特定用户的日志
grep '"userId":"ou_xxxx"' action-log.jsonl

# 查看失败的日志
grep '"ok":false' action-log.jsonl

# 用 jq 格式化查看
cat action-log.jsonl | jq .
```

---

## 手动测试清单

本章提供完整的手动测试步骤，覆盖启动、Web UI、API、飞书 E2E、多客户端等场景。

### 前置条件

- Node.js 版本符合项目要求
- 飞书机器人已配置并运行
- `scripts/reset_onboarding.py` 存在于 `scripts/` 目录（或配置指向的脚本文件）

### 测试清单

#### 1. 启动测试

- [ ] **启动服务**  
  ```bash
  npm start
  ```
  检查后台日志，确认无 import 错误

- [ ] **验证默认配置创建**  
  启动后，检查项目根目录是否存在 `action-configs.json` 文件  
  ```bash
  ls -la action-configs.json
  ```

- [ ] **Web 服务正常运行**  
  访问 http://localhost:3000，页面正常加载

#### 2. Web UI 功能测试

**导航与可见性**

- [ ] **进入设置页**  
  点击 Web 界面左侧菜单的"设置"或齿轮图标，进入设置弹层

- [ ] **确认新 Tab 可见**  
  在设置弹层的 Tab 栏中，找到并确认「动作配置」Tab 存在

- [ ] **切换到动作配置 Tab**  
  点击「动作配置」Tab，左侧应显示已有的动作列表

**动作列表展示**

- [ ] **列表显示正确**  
  确认列表中显示：
  - 默认配置「清理账号数据」存在
  - 配置名称、关键词、脚本文件名、权限等字段可见
  - 每行都有「编辑」和「删除」按钮

**创建新动作**

- [ ] **点击「+ 添加动作」**  
  按钮位于列表上方，点击后右侧应弹出编辑表单

- [ ] **表单显示完整**  
  编辑表单包含以下字段：
  - 动作名称
  - 意图描述
  - 关键词（tag 或逗号分隔输入）
  - 脚本类型（下拉选：Python / Node.js）
  - 脚本文件名（下拉选或文本输入）
  - 权限（下拉选：guest / owner）
  - 启用此动作（复选框）
  - 变量表（有「+ 添加变量」按钮）

- [ ] **填写测试动作**  
  在表单中填入以下信息（作为测试动作）：
  ```
  动作名称：测试脚本执行
  意图描述：用来测试脚本执行流程
  关键词：test, 测试
  脚本类型：Python
  脚本文件名：reset_onboarding.py
  权限：guest
  启用此动作：✓
  ```

- [ ] **添加变量**  
  点击「+ 添加变量」，添加两个变量：
  ```
  变量 1：
    名称：test_param
    标签：测试参数
    追问文案：请输入测试参数值
    必填：✓
    永久存储：✗

  变量 2（可选）：
    名称：phone
    标签：手机号
    追问文案：请提供手机号
    必填：✓
    永久存储：✓
  ```

- [ ] **保存新动作**  
  点击「保存」按钮，应看到确认提示（如 alert 或 toast）

- [ ] **列表更新**  
  新配置应立即出现在左侧列表中

**编辑动作**

- [ ] **点击「编辑」**  
  在列表中选择一条配置（如刚添加的测试动作），点击其「编辑」按钮

- [ ] **表单加载现有值**  
  编辑表单应显示该配置的所有已保存字段值

- [ ] **修改字段**  
  修改其中一个字段（如关键词），点击「保存」

- [ ] **验证更新**  
  列表应立即反映修改，日志中应记录新的 `updatedAt`

**删除动作**

- [ ] **点击「删除」**  
  选择列表中的任意配置（建议选择测试动作），点击其「删除」按钮

- [ ] **确认对话**  
  应弹出确认对话（如 confirm()），确认"确实要删除"

- [ ] **删除成功**  
  配置从列表消失，文件系统中 `action-configs.json` 已更新

#### 3. API 端点测试

**获取配置列表**

- [ ] **GET /api/actions**  
  ```bash
  curl http://localhost:3000/api/actions
  ```
  返回 JSON 数组，包含所有已配置的动作

- [ ] **返回格式正确**  
  返回值应是数组，每项包含 `id`, `name`, `keywords`, `variables` 等字段

**创建配置**

- [ ] **POST /api/actions**  
  ```bash
  curl -X POST http://localhost:3000/api/actions \
    -H 'Content-Type: application/json' \
    -d '{
      "name": "API 测试动作",
      "description": "通过 API 创建的动作",
      "keywords": ["api"],
      "scriptType": "python",
      "scriptName": "reset_onboarding.py",
      "permission": "guest",
      "enabled": true,
      "variables": []
    }'
  ```
  返回新建的配置，包含系统生成的 `id` 和时间戳

**更新配置**

- [ ] **PUT /api/actions/{id}**  
  获取上一步返回的 id，执行：
  ```bash
  curl -X PUT http://localhost:3000/api/actions/{id} \
    -H 'Content-Type: application/json' \
    -d '{"name": "API 测试动作 - 已更新"}'
  ```
  返回更新后的配置，`updatedAt` 应变化

**获取脚本列表**

- [ ] **GET /api/scripts**  
  ```bash
  curl http://localhost:3000/api/scripts
  ```
  返回 JSON 数组，列出 `scripts/` 目录下所有 `.py` 和 `.js` 文件

- [ ] **返回格式正确**  
  返回值应是字符串数组，如 `["reset_onboarding.py", "other_script.js"]`

**删除配置**

- [ ] **DELETE /api/actions/{id}**  
  选择上一步创建的 id，执行：
  ```bash
  curl -X DELETE http://localhost:3000/api/actions/{id}
  ```
  返回 `{"success":true}` 或类似确认

- [ ] **验证删除**  
  再次 GET /api/actions，被删除的配置不应出现

#### 4. 飞书 E2E 测试（意图识别 + 槽位填充）

**前置**

- 确保机器人已启动并连接到飞书
- 确认项目中已有「清理账号数据」配置（如果被删除，重启服务会自动恢复）

**关键词快路匹配**

- [ ] **发送命中关键词的消息**  
  在飞书与机器人对话，发送：
  ```
  清一下 test 的 13800138000
  ```

- [ ] **机器人识别意图**  
  后台日志应出现类似信息：
  ```
  [intent] 关键词命中：动作「清理账号数据」
  ```

- [ ] **机器人回复**  
  若两个参数都提供了，机器人应：
  1. 若手机号首次提供 → 执行脚本
  2. 若手机号已缓存 → 直接执行（跳过追问）

**缺少必填变量的追问流程**

- [ ] **发送部分信息**  
  在飞书发送（仅提供 env，不提供 phone）：
  ```
  帮我重置一下 test 的账号
  ```

- [ ] **机器人追问**  
  机器人应回复：
  ```
  请提供您的手机号（11 位）
  ```

- [ ] **用户提供变量**  
  用户回复：
  ```
  15801234567
  ```

- [ ] **机器人执行**  
  机器人应收集齐所有必填，然后执行脚本，回复：
  ```
  ✅ 清理账号数据完成
  (脚本输出内容)
  ```

**持久化变量的缓存**

- [ ] **首次提供手机号**  
  用户第一次在对话中提供手机号时，系统记录到 `user-vars.json`：
  ```json
  {
    "ou_xxxxxxxxxx": { "phone": "15801234567" }
  }
  ```

- [ ] **第二次发送时省略手机号**  
  用户再次发送（仅提供 env，省略 phone）：
  ```
  清一下 dev 的账号
  ```

- [ ] **机器人直接执行**  
  机器人应：
  1. 从 `user-vars.json` 查到缓存的 phone
  2. **跳过追问**，直接执行脚本
  3. 回复执行结果

**日志记录与脱敏**

- [ ] **查看执行日志**  
  执行脚本后，检查 `action-log.jsonl`：
  ```bash
  tail -1 action-log.jsonl
  ```

- [ ] **日志包含必要字段**  
  日志应包含：
  - `time`: ISO8601 时间戳
  - `userId`: 飞书用户 open_id
  - `actionId`: 配置 UUID
  - `actionName`: 「清理账号数据」
  - `vars`: 变量值（phone 应脱敏为 `158****4567`）
  - `ok`: true（执行成功）
  - `code`: 0（退出码）

- [ ] **手机号已脱敏**  
  检查日志中 phone 值，应为格式 `1XX****XXXX`（前 3 位 + **** + 后 4 位）

**机器人回复格式**

- [ ] **成功时的回复**  
  应包含：
  - ✅ 符号
  - 动作名称
  - 脚本输出（最后 800 字符）
  
  示例：
  ```
  ✅ 清理账号数据完成
  (脚本输出内容)
  ```

- [ ] **失败时的回复**  
  应包含：
  - ❌ 符号
  - 「执行失败」
  - 脚本错误输出
  
  示例：
  ```
  ❌ 执行失败
  错误：找不到用户 15801234567
  ```

#### 5. 多客户端隔离测试（可选）

**用户变量隔离**

- [ ] **用户 A 缓存变量**  
  飞书中用户 A 执行命令，设置 `phone=15801234567`，系统记录到 `user-vars.json`

- [ ] **用户 B 独立缓存**  
  用户 B（不同 open_id）执行相同命令，设置 `phone=18800000000`

- [ ] **查看文件隔离**  
  检查 `user-vars.json`，应看到：
  ```json
  {
    "ou_userA": { "phone": "15801234567" },
    "ou_userB": { "phone": "18800000000" }
  }
  ```

- [ ] **追问中间态隔离**  
  用户 A 在追问等待中，用户 B 独立发送命令，两者不应互相影响

#### 6. 脚本执行测试

**Python 脚本执行**

- [ ] **脚本存在**  
  确认 `scripts/reset_onboarding.py` 存在于 `scripts/` 目录

- [ ] **脚本参数正确传递**  
  脚本应接收 `--env test --phone 13800138000` 并正确解析

- [ ] **脚本输出捕获**  
  脚本的标准输出应被记录，并显示在飞书回复中

- [ ] **退出码正确**  
  成功执行时，脚本应以退出码 `0` 结束；失败时为非 0 值

**Node.js 脚本执行（如有）**

- [ ] **脚本可执行**  
  若配置中有 `scriptType: "node"` 的脚本，确认存在且可以 `node` 直接执行

- [ ] **参数解析**  
  脚本应能正确解析命令行参数

#### 7. 边界和错误情况

**无匹配意图**

- [ ] **发送无相关关键词**  
  发送完全不相关的消息：
  ```
  今天天气怎么样
  ```
  机器人应回复帮助信息或「无法匹配」

**配置已禁用**

- [ ] **禁用某个配置**  
  在 Web UI 中，编辑配置，取消「启用此动作」复选框，保存

- [ ] **无法触发**  
  尝试触发该动作的关键词，机器人应不识别

**脚本不存在**

- [ ] **指定不存在的脚本**  
  在 Web UI 中创建配置，指定 `scriptName` 为不存在的文件（如 `fake_script.py`）

- [ ] **执行时失败**  
  触发该动作，机器人应回复：
  ```
  ❌ 执行失败
  (文件不存在或权限错误)
  ```

**无必填变量时直接执行**

- [ ] **创建零必填变量的动作**  
  新建动作，不添加任何变量或所有变量都取消「必填」

- [ ] **发送触发消息**  
  无需追问，直接执行脚本

---

## 常见问题

### Q1: 如何修改默认的「清理账号数据」配置？

**A**: 在 Web 设置页的「动作配置」Tab 中点击「编辑」按钮，修改任意字段（如关键词、脚本路径等），点「保存」即可。修改不需要重启服务。

### Q2: 手机号在日志中是如何脱敏的？

**A**: 系统自动识别字段名为 `phone` 的值，将其脱敏为 `前3位****后4位` 的格式。例如 `13800138000` 脱敏为 `159****9503`。其他字段不脱敏。

### Q3: 如何让某个变量只对特定用户有效（不跨用户共享）？

**A**: 在配置中，将该变量的 `persistent: true`。这样每个用户会有独立的缓存。系统通过 `open_id` 隔离用户数据。

### Q4: 脚本执行超时了怎么办？

**A**: 系统本身不设置脚本超时限制。若脚本执行过久，可以：
1. 优化脚本逻辑，加快执行
2. 在脚本内部设置超时（如调用外部 API 时加超时参数）
3. 使用后台任务队列（超出本系统范围）

### Q5: 如何添加新脚本？

**A**: 
1. 在 `scripts/` 目录下编写脚本文件（`.py` 或 `.js`）
2. 脚本需要能解析 `--{paramName} value` 格式的命令行参数
3. 在 Web UI 创建新动作配置，指定脚本文件名
4. 保存后立即生效

### Q6: 变量能否自动验证（如手机号必须 11 位）？

**A**: 当前系统不支持自动验证。建议：
1. 在脚本中验证参数有效性，无效时以非 0 退出码退出
2. 在追问文案中说明格式要求（如「请输入 11 位手机号」）
3. 后续版本可考虑在配置中添加正则校验规则

### Q7: 如何在多个环境（开发/测试/生产）中使用？

**A**: 
1. 每个环境独立运行本服务，各有独立的 `action-configs.json` 和 `user-vars.json`
2. 配置可通过 Web UI 在各环境中分别设置，或使用配置管理工具同步
3. 环境变量 `SCRIPTS_DIR` 可指向不同目录（环境特定的脚本）

### Q8: 日志能否定期清理或按大小轮转？

**A**: `action-log.jsonl` 是追加文件，建议：
1. 定期手动备份并清空（实际应用中）
2. 使用日志轮转工具（如 logrotate）管理文件大小
3. 后续版本可考虑集成日志轮转或数据库存储

### Q9: 如何禁用某个动作但不删除配置？

**A**: 在 Web UI 编辑该配置，取消「启用此动作」复选框，保存。被禁用的配置不会参与意图匹配。

### Q10: 关键词如何避免歧义（多个动作命中）？

**A**:
1. 为每个动作选择有区别的关键词
2. 若避免不了重复，系统会自动进入 Claude 消歧，但会增加延迟和成本
3. 建议在配置时仔细选择关键词，避免通用词如「取消」「执行」

---

## 相关文档

- **设计规范** — `docs/superpowers/specs/2026-07-20-generic-action-config-design.md`
- **实现计划** — `docs/superpowers/plans/2026-07-20-generic-action-config.md`
- **项目架构** — `docs/ARCHITECTURE.md`

---

**文档版本**: 1.0  
**最后更新**: 2026-07-20  
**维护者**: 开发团队

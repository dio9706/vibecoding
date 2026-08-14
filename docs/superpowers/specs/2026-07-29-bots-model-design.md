# 托管配置改造：机器人实体模型 设计

## 一、目标

把「单一飞书凭证 + 全局角色描述 + 全局文案 + 全局动作」重构为**机器人实体列表**：每个机器人携带平台凭证、角色描述、可配文案、专属动作。托管配置 tab 改为机器人管理界面。

本期边界（已与用户确认）：
- **单机器人生效**：可配置多个机器人，同时只有一个 enabled（互斥），仅它建立连接、其配置生效；多 WS 并发下期做。
- **无人值守不动**：仍留在需求/故障面板，后续用户统一调整为 per-bot。
- **动作 per-bot 独享**：动作加 `botId`；存量动作迁移归第一个机器人。
- 平台枚举仅 `feishu`。

## 二、数据模型

### settings.json 新增 `bots`（顶层 lark/persona/messages 迁移后清空）

```json
bots: [{
  "id": "bot_xxx",
  "name": "机器人 1",
  "platform": "feishu",
  "appId": "cli_...",
  "appSecret": "...",
  "persona": "",
  "messages": { "feedbackAck": "", "execProcessing": "" },
  "projectDir": "",
  "projectNotes": "",
  "enabled": true,
  "updatedAt": "..."
}]
```

- `projectDir`（项目文件夹）：机器人处理的事务仅限此工程目录（作为所有飞书侧 Claude 调用的默认 cwd）；本机其他目录只读参考——经 system prompt 软约束声明（`shared/bot-scope.js`），owner 对话中 `cwd:` 前缀可显式覆盖。
- `projectNotes`（工程说明，可空，≤2000 字符）：如"后端工程/前端工程/figma"等参考信息，注入 owner 对话、需求/故障分析与开发（task-ops）的提示词。
- 原「基础设置-需求/故障处理项目」（uiPrefs.taskProjectDir）移除，迁移时随迁为机器人 1 的 projectDir；task-ops 与无人值守的 cwd 改读 `getActiveBot()?.projectDir`（env 默认工程兜底）。

### action-configs.json 每条动作加 `botId`

## 三、迁移（web 启动时执行，幂等）

`migrateToBots()`（src/store/bots-migration.js）：
1. `bots` 为空且旧 settings 配置（lark 凭证 / persona / messages / uiPrefs.taskProjectDir）任一存在 → 生成「机器人 1」（enabled=true），带走凭证、persona、feedbackAck/execProcessing 覆盖值、项目目录；清空旧顶层字段与 taskProjectDir。`welcome`/`execNewChat` 自定义值丢弃（回落默认文案）。
2. 动作收养（每次启动都执行，幂等）：只要存在机器人，`botId` 缺失**或指向不存在机器人**的动作回填为启用机器人 id（同时治愈"导入旧配置后动作 botId 失配"场景）。

调用点：`initializeDefaults()`（routes-ops.js）**先迁移、后建默认动作**；默认清理动作仅在存在启用机器人时创建（挂其 botId），无机器人则跳过。`/api/settings/import` 成功后也调一次（兼容导入旧版配置文件）。

## 四、运行时语义

- `getActiveBot()` = 第一个 `enabled` 的机器人（store/settings.js）。
- `getLarkCredentials()`（shared/config.js）：启用的 feishu 机器人 → 旧 `lark` 字段兜底 → env 兜底。feishu 进程热重载逻辑不变（凭证值变化自动重连）。
- `messages.js`：REGISTRY 保留 4 条默认文案；可配 key 收窄为 `BOT_MESSAGE_KEYS = ['feedbackAck','execProcessing']`，`msg(key)` 覆盖值改读启用机器人的 `messages`；welcome/execNewChat 永远默认文案。
- `claude-exec`：persona 改读 `getActiveBot()?.persona`（原 getPersona/setPersona 移除）。
- `intent.js classifyAction`：只匹配 `botId === activeBot.id` 且 enabled 的动作；无启用机器人 → 不匹配任何动作。

## 五、API

| 路由 | 说明 |
|---|---|
| `GET /api/bots` | 列表（appSecret 掩码）+ `messagesMeta`（两条可配文案的 key/label/defaultText，供表单动态渲染） |
| `POST /api/bots` | 新增：name/platform/appId/appSecret/persona/messages |
| `PUT /api/bots/:id` | 局部更新；appSecret 留空不改；`enabled:true` 时互斥禁用其他机器人 |
| `DELETE /api/bots/:id` | 删除机器人 + **级联删除其全部动作** |
| `GET /api/actions?botId=` | 按机器人过滤（UI 必传） |
| `POST /api/actions` | 必填 botId（校验机器人存在）；PUT 剥离 botId（归属不可改） |
| `GET/POST /api/settings` | 移除 lark/persona/messages 分区与返回（feishu 连接状态、tokens、uiPrefs 保留） |

persona/messages 长度上限 2000 字符（沿用）。

## 六、UI（托管配置 tab）

- **机器人列表**（token-list 风格行）：名称 / 平台 / App ID 掩码 / 启用开关（互斥）/ 编辑 / 删除（confirm 提示级联删动作）；列表头带飞书连接状态灯（`#feishuState` 保留）。
- **编辑表单**（选中机器人后显示）：名称、机器人平台（下拉，仅"飞书"）、App ID、App Secret（password，留空不改）、角色描述（textarea）、两条文案（按 messagesMeta 动态渲染）＋ 保存/取消。
- **动作配置区**：仅编辑已有机器人时显示，复用现有 actions-panel 双栏组件，增加 botId 上下文（列表按 botId 过滤、新建带 botId）。
- 上期的「飞书凭证/角色描述/机器人文案/动作配置」四分区布局整体移除；settings-panel.js 中对应读写代码删除。
- 新增 `public/js/bots-panel.js`（副作用模块，app.js 引入）；actions-panel.js 暴露 botId 上下文入口，删除原 tab 点击自加载绑定。

## 七、测试与验证

- 单测：bots 归一/makeBotEntry/启用互斥/getActiveBot；migrateToBots（迁移、幂等、动作收养、孤儿 botId 治愈）——APP_DATA_DIR 临时目录模式（同 action-configs.test.js）。
- 手动：迁移后托管配置出现「机器人 1」且凭证/人设/文案/动作齐全；启用互斥；删除级联；飞书重连；owner 对话语气生效；导入旧版配置自动升级。

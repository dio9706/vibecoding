# 托管配置（设置页重组 + 角色描述）设计

## 一、目标

把设置页的「动作配置」tab 改名为**「托管配置」**，并把原先独立的「飞书凭证」「机器人文案」两个 tab 收编为其内部分区；新增**「角色描述」**多行文本配置项，用于描述飞书机器人的角色、性格、语气，保存后注入飞书侧 Claude 对话的 system prompt。

改造后 tab 结构：**基础设置 | 模型 | MCP 服务器 | 托管配置 | 桌面(隐藏)**

托管配置 tab 内分区顺序：**飞书凭证 → 角色描述 → 机器人文案 → 动作配置**

## 二、改动清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/store/settings.js` | 改 | DEFAULTS/normalizeSettings/replaceSettings 加 `persona: ''`；新增 `getPersona()`/`setPersona()` |
| `src/store/settings.test.js` | 改 | 补 persona 归一测试（缺省空串 / 非字符串归空 / 透传） |
| `src/entrypoints/web/routes-settings.js` | 改 | GET 返回 `persona`；POST 新增 `section: 'persona'`（trim + 2000 字符上限） |
| `src/features/claude-exec/index.js` | 改 | handle 时读 `getPersona()`，非空则传 `systemPrompt: { type:'preset', preset:'claude_code', append }` |
| `public/index.html` | 改 | 删 lark/messages tab 按钮；actions 按钮改名「托管配置」；分区 HTML 搬入 actions 面板并新增角色描述分区 |
| `public/js/settings-panel.js` | 改 | loadSettings 填充 persona；绑定保存按钮；导入确认文案补「角色描述」 |

## 三、关键决策

1. **`data-tab="actions"` 值不变**，只改按钮文字——`actions-panel.js` 按 `dataset.tab === 'actions'` 绑定 tab 点击加载动作列表，元素 ID（`larkAppId`/`msgList`/`actionsList` 等）全部保留，前端逻辑近零改动（KISS）。
2. **persona 存 settings.json 顶层字段**（与 messages 平级），不塞进 lark（凭证）或 messages（门面文案注册表）——职责分离（SRP）。`normalizeSettings` 白名单透传后，导入导出（`buildExport`/`replaceSettings` 走整份 settings）自动覆盖，无需改 config-transfer。
3. **注入方式用 SDK preset+append**：保留 Claude Code 完整系统提示，仅追加人设，不影响工具调用能力。每次 handle 时读盘（与文案 `msg()` 同理），保存后下一条消息生效，无需重启。
4. **生效范围仅 claude-exec**（飞书 owner 对话）。意图分类、判档等内部一次性调用不注入（角色语气对分类器是噪音）。
5. **上限 2000 字符**，对齐 `shared/messages.js` 的 MAX_LEN。

## 四、UI 细节

- 角色描述分区：`textarea#personaText`（5 行）+ 保存按钮 `#personaSaveBtn`，hint「注入飞书对话 · 保存后下一条消息生效」。
- 动作配置区从 `height:100%` 双栏 flex 改为自适应高度分区（`.set-sec` 包裹 + sec-label「动作配置」），避免挤压上方分区。
- 导出说明与导入 confirm 文案补「角色描述」。

## 五、验证

- `npm test`：settings 归一测试全绿。
- 手动：设置页只剩 4 个可见 tab；托管配置内四分区正常读写；保存角色描述后 settings.json 出现 persona 字段；飞书 owner 发消息，回复语气符合人设；导出 JSON 含 persona，导入后回填。

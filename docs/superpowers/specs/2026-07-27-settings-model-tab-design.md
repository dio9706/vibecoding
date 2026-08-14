# 设置页「模型」Tab 重设计

**日期**：2026-07-27  
**状态**：已批准  

---

## 背景

当前设置页有两个独立 Tab：
- **Claude 账号**（`data-tab="tokens"`）：管理 Claude 订阅 Token 池
- **自定义模型**（`data-tab="providers"`）：管理 OpenAI 兼容接口凭证

两者都是"模型凭证"，放在两个 Tab 割裂了用户认知，合并为单个「模型」Tab 并按类型分组更直觉。

---

## 目标

1. 将"Claude 账号"和"自定义模型"两个 Tab 合并为单个 **「模型」** Tab
2. Tab 内分两组：**API Key 组** 和 **订阅 Key 组**
3. API Key 组支持厂商/模型下拉预设，减少手动输入
4. 订阅 Key 组预留可扩展性（当前仅 Claude）

---

## 界面设计

### Tab 变更

| 现在 | 变更后 |
|------|-------|
| `Claude 账号` | 合并 → **模型** |
| `自定义模型` | 合并 → （同上） |

Tab 顺序：基础设置 → 飞书凭证 → 机器人文案 → **模型** → MCP 服务器 → 动作配置

### 模型 Tab 布局

```
┌──────────────────────────────────────────────┐
│  ── API Key ──────────────────────────────── │
│  已添加列表：名称 | 厂商 | 模型 | baseURL | 掩码 | [删除] │
│                                              │
│  添加表单：                                   │
│  [名称] [厂商▾] [模型▾] [baseURL] [API Key]  │
│  [ ＋ 添加 ]                                 │
│                                              │
│  ── 订阅 Key ─────────────────────────────── │
│  已添加列表：名称 | 订阅 | 掩码 | 健康状态 | 拖拽排序 | [重命名][删除] │
│                                              │
│  添加表单：                                   │
│  [名称] [订阅▾ Claude] [Key]                 │
│  [ ＋ 添加 ]                                 │
└──────────────────────────────────────────────┘
```

---

## API Key 组

### 表单字段

| 字段 | 类型 | 说明 |
|------|------|------|
| 名称 | text input | 可选；placeholder "如 DeepSeek" |
| 厂商 | select | 必填；选中后联动填充模型列表和 baseURL |
| 模型 | select/text | 厂商未选时禁用；"其他"时改为文本输入框 |
| baseURL | text input | 厂商非"其他"时自动填充且禁用；"其他"时启用编辑 |
| API Key | password | 必填；placeholder "sk-…" |

### 厂商预设数据

```javascript
const VENDOR_PRESETS = {
  openai:   { label: "OpenAI",      baseURL: "https://api.openai.com/v1",                         models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1", "o3-mini"] },
  deepseek: { label: "DeepSeek",    baseURL: "https://api.deepseek.com/v1",                        models: ["deepseek-chat", "deepseek-reasoner"] },
  aliyun:   { label: "阿里云百炼",  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen-max", "qwen-plus", "qwen-turbo"] },
  moonshot: { label: "月之暗面",    baseURL: "https://api.moonshot.cn/v1",                         models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"] },
  zhipu:    { label: "智谱",        baseURL: "https://open.bigmodel.cn/api/paas/v4",               models: ["glm-4", "glm-4-flash"] },
  custom:   { label: "其他（自定义）", baseURL: "",                                                  models: [] },
};
```

### 列表展示

每条记录显示：**名称** | **厂商** | **模型** | **baseURL** | **掩码 key** | [删除]

名称为空时显示 `(未命名) - 厂商/模型`（如 `(未命名) - DeepSeek/deepseek-chat`）

### 数据接口

- `GET /api/credentials` — 获取列表（现有接口不变）
- `POST /api/credentials` — 新增（payload 新增 `vendor` 字段，其余不变）
- `DELETE /api/credentials/:id` — 删除（不变）

---

## 订阅 Key 组

### 表单字段

| 字段 | 类型 | 说明 |
|------|------|------|
| 名称 | text input | 可选；placeholder "如 主账号" |
| 订阅 | select | 必填；当前仅 Claude；预留扩展 |
| Key | password | 必填；placeholder "sk-ant-oat01-…" |

### 订阅下拉选项

```javascript
const SUBSCRIPTION_TYPES = [
  { value: "claude", label: "Claude" },
  // 未来在此扩展其他订阅服务
];
```

### 列表展示

保留现有 token-row 展示逻辑（健康状态、使用率、重置时间、首选星标、拖拽排序），新增 **订阅类型** 列，其他显示方式不变。

### 数据接口

复用现有 token 接口（`/api/settings` section: `tokens`），不变。

---

## 交互细节

### 厂商联动逻辑

1. 用户选择厂商 → 模型下拉刷新为该厂商 models 列表（默认选第一项）
2. baseURL 自动填充 preset.baseURL 并 `disabled`
3. 选"其他（自定义）"时：
   - 模型 select 换成 text input（`credModelCustom`），placeholder "如 my-model"
   - baseURL 改为 enabled，placeholder "https://api.xxx.com/v1"

### 校验规则

- API Key 组：baseURL + 模型 + apiKey 均必填
- 订阅 Key 组：key 必填

### 布局调整

- 名称列和模型列宽度稍窄（`min-width: 80px`），为 5 列提供足够空间
- token-row 的水平滚动在超窄屏时触发（不影响正常宽度）

---

## 受影响文件

| 文件 | 变更类型 |
|------|---------|
| `public/index.html` | 合并两个 Tab 为一个，重写「模型」Tab HTML |
| `public/js/settings-panel.js` | 合并 `loadCredentials`/`renderCredList`/`addCredentialUI` 逻辑，更新 Tab 初始化，新增厂商联动 |

---

## 不变范围

- 后端接口：`/api/credentials`、`/api/settings` (tokens) 均不变
- 其他 Tab 不受影响
- model-fab 浮动按钮的自定义模型列表不受影响

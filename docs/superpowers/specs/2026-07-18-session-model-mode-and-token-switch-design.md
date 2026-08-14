# 设计：会话级模型/模式还原 + 设置页账号切换

日期：2026-07-18
状态：已获用户批准

## 背景

- 右下角悬浮控件（`modelFab`）的模型选择（`chatModel`）、强度（`chatEffort`）、询问模式（`chatMode`）目前存在全局 localStorage 键（`claude_model` / `claude_effort` / `claude_mode`），切换会话时不跟随变化。
- 本地会话条目（localStorage `claude_convs`）已有 `cwd` 随会话保存与恢复的先例（`openConv()` 中还原工作目录）。
- 设置页已有 token 列表 + 拖拽排序（`reorder` API）；当前账号 = `pickActive()`（列表顺序中第一个可用），不支持手动指定。

## 功能 A：模型选择和询问模式随历史会话还原

### 本地会话（web）

1. `claude_convs` 条目新增字段 `model`、`effort`、`mode`。
2. `recordMessage()` 每次落库时快照当前 `chatModel` / `chatEffort` / `chatMode`（照 `cwd` 的现有写法）。
3. `openConv()` 还原：字段存在且合法（在 `MODEL_LABELS` / `EFFORTS` / `MODES` 白名单内）才赋值，
   同步 localStorage 并调 `syncModelUI()`；缺失或不认识的值保持现状不动（老会话无此字段，天然兼容）。

### 磁盘历史（CLI 会话）

1. 后端 `getHistorySession()`（`src/store/history.js`）在现有逐行遍历中顺带提取，零额外 IO：
   - `permissionMode`：最后一条 `type === 'permission-mode'` 行的 `permissionMode` 值；
   - `model`：最后一条 `type === 'assistant'` 行的 `message.model`。
   返回体新增这两个字段（提取不到则为空）。
2. 前端 `resumeHistorySession()` 拿到后同样过白名单再还原：
   - CLI 模型 ID 可能不在 web 列表里（如 `claude-fable-5`），此时忽略；
   - 磁盘历史没有 effort 概念，不还原 effort。
3. 还原发生在 `recordMessage` 落库之前，续接出的新本地条目自动带上这些值，后续走本地路径。

### 边界

- `auto` 模式下本地保存的是 `'auto'` 本身（保留用户意图），实际分类结果不覆盖它。
- 磁盘历史解析失败 → 字段缺省，前端不还原，行为同现状。

## 功能 B：设置页「设为当前」账号

采用置顶（设为首选）语义，零后端改动：

1. 每个 token 行加「设为当前」按钮；首位那行不显示按钮，改显示「当前首选」标记。
2. 点击 → 复用现有 `postSettings({section:'tokens', action:'reorder', ids})` 把该 id 移到首位
   （其余相对顺序不变）→ `loadSettings()` 刷新。`pickActive` 顺序优先的语义使它立即成为 active。
3. 若点的是 exhausted 账号：照常置顶，toast 提示「该账号额度已耗尽，恢复后将自动启用」
   （`pickActive` 会先跳过它，现有保护不破坏）。
4. 正在运行中的任务不受影响（token 在启动时注入 env），下一次运行生效。

## 不做的事（YAGNI）

- 历史列表不加模型/模式徽标（用户已确认不需要）。
- 不引入「强制指定账号」的新状态机。
- `listHistorySessions`（列表接口）不动，只改详情接口。

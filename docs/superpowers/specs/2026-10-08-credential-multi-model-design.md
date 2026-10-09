# 凭证多模型发现与选择（OpenCode 式）· 设计

- 日期：2026-10-08
- 状态：已拍板（2026-10-08，两处决策经确认）；实现中，进度见 §8
- 关联：`store/settings.js`（凭证条目）、`entrypoints/web/routes-settings.js`（凭证端点）、`entrypoints/web/provider-models{,.logic}.js`（拉取层，本次随附落地）、`public/js/{settings-panel,onboarding,chat}.js`、`public/js/vendor-presets.js`
- 背景（方向变更）：原设计是「添加表单里加一键拉取按钮，仍要选一个模型」。用户改为对齐 OpenCode 的两层模型：**凭证 = 接入（key/baseURL），添加后自动发现该服务商全部可用模型；模型选择里按凭证分组展示全部模型**。原「添加时选模型」的链路（表单必填 model、凭证行一凭证一模型、弹层一凭证一 pill、`resolveCredential` 按 `model` 匹配）整体需要拆开。

## 1. 拍板记录（2026-10-08 已确认）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 发现时机 | **添加时自动拉取 + 设置页凭证行「刷新模型」手动刷新**；旧凭证不自动网络迁移（点刷新升级）；聊天弹层里对「未获取模型」的凭证给一条「刷新模型」入口（Q2 附带，不自动懒加载） |
| 2 | 弹层呈现 | **按凭证分组**：凭证名做组标题，其下每个模型一颗 pill；无模型的凭证显示刷新入口 |

## 2. 目标与非目标

**目标**

1. 凭证不再要求选择具体模型：添加表单（设置页 + 引导向导）只收 厂商 / baseURL / API Key；
2. 添加成功后自动拉取 `GET {base}/models`，结果存进凭证（`models`），设置页可随时「刷新模型」；
3. 聊天模型弹层自定义区按凭证分组，展示该凭证全部模型（显示名优先 `name`，如 DeepSeek V4.1 Flash）；
4. 后端解析（`resolveCredential`）与旧数据（仅 `model` 字段）全链兼容。

**非目标（本期不做）**

- 模型能力元数据（context_window / effort 等）落库与展示（只存 `{id, name}`）；
- 弹层模型搜索/过滤、定时自动刷新；
- Claude 路径与 `uiPrefs.defaultModel` 变更；
- 凭证编辑 UI（换 key 仍走删了重加；PUT 接口原样保留）。

## 3. 数据模型

Token 条目（openai-compat）：

```jsonc
{
  "id": "tk_x", "providerId": "openai-compat", "label": "DeepSeek", "token": "sk-…",
  "baseURL": "https://api.deepseek.com/v1", "vendor": "deepseek",
  "models": [{ "id": "deepseek-flash", "name": "DeepSeek V4.1 Flash" }], // 发现结果（添加/刷新时覆盖）
  "modelsUpdatedAt": "2026-10-08T…",
  "model": "deepseek-chat" // legacy：老凭证/curl 手传仍在；新链路不再写入
}
```

- 纯函数 `credentialModels(t)`（`store/settings.js`）：`models` 非空优先（归一 id/name、去重）；否则回落 legacy `model` → `[{id}]`；否则 `[]`。**读侧单一事实源**——`GET /api/credentials`、`resolveCredential` 都走它，前端无需兼容逻辑。
- `makeTokenEntry` 增可选 `models`/`modelsUpdatedAt`（条件展开，保持条目形状干净）；新增 `addTokenEntry` 返回**新建条目**（用于 add 响应带 id）；`addToken` 行为不变。

## 4. 后端

| 端点 | 变化 |
|---|---|
| `POST /api/credentials` | `model` 不再必填（仍接受以兼容 curl）；校验 = apiKey + baseURL；响应加 `{ credential: { id } }` 供前端接着调刷新 |
| `POST /api/credentials/:id/refresh-models`（新） | 调 `fetchProviderModels({baseURL, apiKey: 存储的 token})` → 成功 `updateTokenMeta(id, {models, modelsUpdatedAt})` 并返回 `{ok, models}`；失败 502 人话错误；未知 id / 非 openai-compat 404；key 不回显不进日志 |
| `GET /api/credentials` | 加 `models`（经 `credentialModels` 归一）+ `modelsUpdatedAt`；保留 `model` 字段 |
| `run-openai.js#resolveCredential` | by-model 改为在 `credentialModels(t)` 里找；多条同模型仍不赌（唯一命中才认，否则 pickActive）；`summarizeSpan` 的兜底模型同步改为 `credentialModels(cred)[0]?.id` |

## 5. 前端

**设置页（`index.html` + `settings-panel.js`）**

- 添加表单删除模型输入/datalist；选厂商只联动 baseURL；提交后：`POST /api/credentials` → 立即 `POST …/refresh-models`（失败不阻塞，toast 提示「可稍后在列表点刷新」）→ 重载列表；
- 凭证行：模型列显示 `N 个模型`（title = 完整模型名列表；未获取时显示「未获取模型」）+ 「刷新模型」按钮（`REFRESH_ICON_SVG`，点击 POST 刷新 → toast → 重载）。

**引导向导（`index.html` + `onboarding.js` + `onboarding.logic.js`）**

- 自定义 pane 同步删除模型字段；校验 = apiKey + baseURL；保存后软性尝试一次刷新（失败忽略，进应用后可在设置/弹层刷新）。

**聊天弹层（`chat.js` + `app.css`）**

- 自定义区按凭证渲染 `{组头: 凭证名, 组体: 该凭证全部模型 pill}`；pill 文案 = `name || id`，点击仍持久化 `customModel / customLabel / customCredId`；
- 无模型的凭证：组头 + 「刷新模型」pill（点击 POST 刷新，成功后重渲染）；
- 选中态高亮 = `cid + model` 双匹配（同凭证换模型、多凭证同模型都能区分）；
- 有效性检查：所选凭证被删 → 回退 Claude（现状）；老数据无 credId → 在「模型 ∈ 凭证 models」里唯一认领一次。

**vendor-presets（`vendor-presets.js`）**

- 删除 `models` 数组（唯一消费方是已删除的 datalist 建议）；`label/baseURL` 保留，反查表不变。

## 6. 兼容与边界

| 场景 | 行为 |
|---|---|
| 老凭证（仅 `model`） | 列表/弹层/解析经 `credentialModels` 回落为单模型，行为同旧；点「刷新模型」升级为完整列表 |
| 同模型多凭证 | by-model 不唯一 → pickActive（维持「不赌」口径）；弹层按凭证分组天然区分 |
| 拉取失败（网络/401/无 /models 端点） | 凭证照存；设置页/弹层均可重试；错误给可读原因（复用 provider-models 的错误映射） |
| 模型列表很大（openrouter 等） | 拉取层上限 300 条、10s 超时、1MB 响应上限；弹层容器可滚动 |
| 会话偏好字段 | `customModel / customLabel / customCredId` 语义不变（model 现在取自凭证的模型列表） |

## 7. 测试策略

- `store/settings.test.js`：`makeTokenEntry` 的 models 条件展开；`credentialModels`（models 优先 / legacy model 回落 / 去重归一 / 空）；
- `run-openai.cred.test.js`：models 列表匹配（by-model）、同模型多条 fallback、legacy model 兼容、credId 优先级不变；
- `routes-credentials.test.js`（新，假 req/res + fetch 桩）：add 无 model 200；add 带 legacy model 兼容；list 归一（含 legacy 回落）；refresh 成功落盘/上游失败 502/未知 id 404；
- `provider-models{,.logic}.test.js`：沿用（拉取层单测已在）；
- `onboarding.logic.test.js`：custom 校验去掉 model、改验 baseURL；
- 全量 `npm test` + `npm run test:e2e`。

## 8. 实施状态

- [x] spec 拍板（2026-10-08，两处决策见 §1）
- [x] 拉取层 `provider-models{,.logic}.js` + 单测（随附落地）
- [x] 存储（models 字段 + credentialModels + addTokenEntry）
- [x] 后端端点（add/list/refresh + resolveCredential）
- [x] 前端（设置页 / 引导 / 弹层 / presets）
- [x] 测试与文档（全量 `npm test` 3724 全绿；e2e 与「输入区工具栏」特性一同回归）

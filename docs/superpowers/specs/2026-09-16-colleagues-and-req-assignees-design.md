# 同事名册 + 需求开发人员指派 · 设计

- 日期：2026-09-16
- 状态：已拍板，待实现
- 涉及分层：`store` / `entrypoints/web` / `public`

## 一、背景与目标

当前系统里没有「人」这个概念——所有协作对象只有机器人（`bots`）和一个全局的「我的飞书 open_id」。
后续要做的「智能体主动询问同事」缺一份可寻址的人员名册：知道谁是前端、谁是运营、他的飞书 open_id 是多少。

本期交付两件事：

1. **同事名册**：设置页新增「同事设置」tab，按 5 个固定职位分组维护人员（姓名 / 备注 / 飞书 open_id），并在 store 层导出读取接口。
2. **需求开发人员指派**：名册的第一个消费方——需求工作流的评审期可指派开发人员，开发期可修改。

**本期不做**「主动询问」动作本身，只铺数据与读取接口。

## 二、已拍板的四项取舍

| 决策点 | 结论 | 理由 |
|---|---|---|
| 数据落点 | 独立 `colleagues.json`，新建 `src/store/colleagues.js` | `settings.json` 含明文密钥且已 gitignore，同事名册是可分享的组织数据，混进去会被配置导入导出一起带走密钥；且 `normalizeSettings` 已有 10 个顶层字段，不再膨胀 |
| 职位分类 | 固定 5 类，代码内枚举 | YAGNI。固定枚举让后续智能体按职位路由（「问前端」）有稳定契约，新增职位只需加一行常量 |
| 飞书 ID 录入 | 手填 open_id，只校验 `ou_` 前缀 | 与现有「我的飞书 open_id」一致，零外部依赖。通讯录搜索需额外 API 权限且 `lark.js` 当前无搜索封装 |
| 指派范围 | 多人多选，不限职位 | 一个需求挂前端+后端+UI 是常态；运营/产品也可能是需求负责人。单人是多人的子集 |

## 三、Part 1 · 同事名册

### 3.1 数据层 —— `src/store/colleagues.js` → `colleagues.json`

**数据形状（扁平数组）**：

```js
[
  { id: 'cl_a1b2', role: 'frontend', name: '张三', note: '负责活动页', feishuOpenId: 'ou_xxx', updatedAt: '2026-09-16T…' }
]
```

**为什么是扁平数组 + `role` 字段，而不是按职位嵌套的 map**：

- 增删改一个人 = 一次 `map`/`filter`，不必先定位分组再操作分组内数组；
- 职位 label 改名（如「UI设计」→「设计」）不触发任何数据迁移；
- 分组只是渲染形态，属于展示层职责（SRP）——store 不该固化 UI 的组织方式。

**职位常量**（英文 id 稳定、中文 label 可改）：

```js
export const ROLES = [
  { id: 'ops',      label: '运营'   },
  { id: 'frontend', label: '前端'   },
  { id: 'backend',  label: '后端'   },
  { id: 'design',   label: 'UI设计' },
  { id: 'product',  label: '产品'   },
];
```

**导出接口**：

| 函数 | 说明 |
|---|---|
| `ROLES` | 职位枚举常量 |
| `normalizeColleagues(raw)` | 纯函数，形状归一（非数组→`[]`；缺字段补空串；**无 `id` 的条目补发 id 而非丢弃**） |
| `getColleagues()` | 全部同事 |
| `getColleague(id)` | 按 id 取单个，无则 `null`（路由侧校验 assignee 存在性用） |
| `getColleaguesByRole(roleId)` | 按职位筛（严格匹配，非法 roleId 返回 `[]`） |
| `addColleague({ role, name, note, feishuOpenId })` | 新增，返回新条目 |
| `updateColleague(id, patch)` | 局部更新；未知 id 不写盘、返回 `null` |
| `removeColleague(id)` | 删除，返回剩余列表 |

**写入与读取的校验不对称（刻意）**：

- 写入侧（`addColleague`/`updateColleague`）强校验 `role ∈ ROLES`，非法直接拒绝；
- 读取侧 `normalizeColleagues` **只归一形状、不改 `role` 值**。

理由：把非法 role 归一到第一个合法值是静默改数据，丢弃条目是静默丢数据，两者都会让用户以为「我填的人没了」。保留原值，由 UI 在末尾渲染一个「未知职位」兜底分组显示这些条目——用户看得见就能自己修。该兜底分组仅在确有此类数据时出现。

同理，手改 json 塞进的**无 `id` 条目由 normalize 补发 id**（照搬 `settings.js:ensureMcpServerIds` 的既有做法），而不是丢弃：没有 id 的条目在 UI 上既编辑不了也删不掉，丢弃则用户连「它曾经存在」都看不见。补 id 后它就是一条正常可维护的记录。

所有写操作经 `store/index.js` 的 `updateJson`（跨进程文件锁 + tmp+rename 原子写），不得裸 `readJson`→`writeJson`。

### 3.2 HTTP 层 —— `src/entrypoints/web/routes-colleagues.js`

单入口 `handleColleagueRoutes(req, res, url)`，按 pathname + method 内部分发（对齐 `routes-memory.js` 范式）。
`server.js` 的 ROUTES 表登记一行：`{ prefix: '/api/colleagues', h: (req, res, url) => handleColleagueRoutes(req, res, url) }`。
单条 prefix 同时覆盖 `/api/colleagues` 与 `/api/colleagues/:id`，无需两行、也就不存在遮蔽问题。

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/api/colleagues` | — | `{ roles, colleagues }` |
| POST | `/api/colleagues` | `{ role, name, note, feishuOpenId }` | `{ colleague }` |
| PUT | `/api/colleagues/:id` | 同上（局部） | `{ colleague }` |
| DELETE | `/api/colleagues/:id` | — | `{ ok: true }` |

**校验规则（HTTP 边界）**：

- `name`：必填，`trim` 后非空，超 40 字截断；
- `role`：必须 ∈ `ROLES`，否则 400；
- `note`：可空，超 100 字截断；
- `feishuOpenId`：**允许留空**（先记人、后补 id 是常见节奏）；非空时必须以 `ou_` 开头，否则 400。

请求体读取走 `body.js` 的 `withJsonBody`，id 解码走 `input.js` 的 `safeDecodeId`。

### 3.3 前端 —— `public/js/colleagues-panel.js`

**`index.html` 改动**：

- `#settingsTabs` 内新增 `<button data-tab="colleagues">同事设置</button>`，插在「MCP 服务器」之后；
- 新增 `<div class="set-tab" data-tab="colleagues" hidden>`，内含：
  - `#colleagueGroups`（分组容器，由 JS 渲染）
  - `#colleagueFormSec`（内联编辑表单，默认 hidden）：姓名 / 职位下拉 / 备注 / 飞书 open_id + 保存/取消

`settings-panel.js` 的 tab 显隐是通用循环（遍历 `.set-tab` 比对 `data-tab`），**无需改动**。

**渲染形态**：每个职位一个 `set-sec`，组头 = 职位名 + 人数 + 「＋」按钮（点击后表单预选该职位，少一次选择）；组内 `token-list` 列出成员，每行复用 `token-row`：

```
[姓名]  [备注]  [ou_xxx…]              [编辑] [删除]
```

空组显示 `cred-empty` 占位文案。

**模块范式**：副作用模块，自绑「同事设置」tab 点击 → `renderColleagues()`（照搬 `bots-panel.js:195` 的显式取元素写法，不依赖 id 隐式全局）。`app.js` 加一行 `import './js/colleagues-panel.js'`。

**CSS**：零新增。`set-sec` / `set-sec-head` / `sec-label` / `set-field` / `token-list` / `token-row` / `t-label` / `t-base` / `cred-empty` / `t-act` 均已存在于 `public/app.css`。

**安全渲染**：同事姓名/备注是用户输入，一律用 `textContent` 赋值，不拼 `innerHTML`（与 `bots-panel.js` 现有做法一致）。

## 四、Part 2 · 需求开发人员指派

### 4.1 数据 —— `requirements.json` 记录新增 `assignees`

```js
assignees: [], // 同事 id 数组，如 ['cl_a1b2', 'cl_c3d4']
```

在 `createRequirement` 的初始对象中声明。老需求读侧缺此字段时降级为 `[]`（与 `changes`/`bugs` 等 v2 字段的处理一致）。

**存 id 不存姓名快照**：同事改名、换 open_id 后需求侧自动同步（DRY）。代价是同事被删后出现悬空引用——渲染时 id 查不到就显示「已移除的同事」，**不主动清理历史需求**：这是「当前负责人」语义而非审计快照，静默改动历史需求记录比显示一个可见的失效标记更糟。

### 4.2 HTTP —— 新开 `PUT /api/req/assignees`

**不塞进 `handleConfig`**。`routes-requirements.js:164` 有路由级守卫：

```js
if (r.phase !== 'review') return sendJson(res, 409, { error: '仅评审设计期可修改配置' });
```

开发期也要能改开发人员，往 `handleConfig` 里加字段级豁免会让这句守卫文案变成谎言——下一个人读这个 handler 必然误判「这里所有字段都只能评审期改」。新路由语义干净、守卫独立。

| 项 | 内容 |
|---|---|
| 路径 | `PUT /api/req/assignees` |
| 请求体 | `{ id, assignees: ['cl_xxx', …] }` |
| 阶段守卫 | `review` / `dev` 放行；其余 409「仅评审期与开发期可修改开发人员」 |
| 校验 | 必须是数组；元素去重；每个 id 必须存在于名册，否则 400（防写入悬空引用） |
| 落库 | `updateRequirement(id, { assignees }, '更新开发人员')` |

在 `routes-requirements.js` 的 pathname 分发处登记（与 `/api/req/config` 同层）。

### 4.3 UI —— 两处入口，共用一个选人弹窗

| 阶段 | 落点 | 形态 |
|---|---|---|
| 评审 | `req-view.js:1138` `renderConfigCard` 的 `rqw-slots` | 新增 `makeAssigneeSlot(req)`，与前端工程 / 后端工程 / 需求文档并列。展示已选人 chip（姓名·职位），按钮「选择开发人员」开弹窗 |
| 开发 | `req-chat.js:604` `renderReqMgmtSection` | 新增一个 `rq-railbtn`：标题「开发人员」，副标题 = 当前指派人姓名列表（空则「未指派」），点击开同一弹窗 |

**开发期为什么用弹窗而非常驻多选控件**：`renderRail` 每 3s 轮询时整栏 `innerHTML = ''` 重画。常驻编辑控件的选中态会被反复冲掉——该文件已为测试期 bitable 输入框写过一处 `urlDraft` 草稿保护（`req-chat.js:417` 注释），不该再添同类特例。弹窗挂在 `railEl` 之外，天然免疫重画。

**选人弹窗 —— 新建 `public/js/req-assignee-dialog.js`**：

- 导出 `openAssigneeDialog({ reqId, current, onDone })`，评审页与开发页共用（DRY）；
- 打开时拉 `GET /api/colleagues`，按职位分组列出复选框，预勾 `current`；
- 确定 → `PUT /api/req/assignees` → 成功后调 `onDone`（评审页走 `loadAndRenderReq`，开发页走 `refreshRail`）；
- 名册为空时显示指路文案「还没有同事，请先到 设置 → 同事设置 添加」。

## 五、测试

| 文件 | 覆盖 |
|---|---|
| `src/store/colleagues.test.js` | `normalizeColleagues` 形状归一（非数组 / 缺字段 / 无 id 条目）；CRUD 增改删；未知 id 更新/删除无变化；`addColleague` 非法 role 被拒；`getColleaguesByRole` 严格匹配 |
| `src/entrypoints/web/routes-colleagues.test.js` | 四条拒绝分支：空 name、非法 role、`feishuOpenId` 前缀不合法、未知 id 的 PUT/DELETE |
| `src/entrypoints/web/routes-requirements.test.js`（追加） | `PUT /api/req/assignees`：悬空 id 被拒（400）、`test` 阶段被拒（409）、`review`/`dev` 阶段写入成功、重复 id 去重 |

跑 `npm test`（`node --test`）。

## 六、分层合规自检

- 依赖方向：`public` → `entrypoints/web` → `store`，无反向 import；
- 持久化：全部经 `store/index.js` 的 `updateJson`，无裸读写；
- 新 store 需在 `docs/ARCHITECTURE.md` 与 `src/store/CLAUDE.md` 的清单里登记；
- 新路由需在 `src/entrypoints/CLAUDE.md` 的文件清单里登记；
- 前端不引入新 CSS，不使用裸 `innerHTML` 渲染用户输入。

## 七、明确不做（YAGNI）

- 职位自定义（增删改职位本身）
- 同事「启用/停用」开关
- 名册拖拽排序
- 接入配置导入导出（`config-transfer.js` 不动）
- 飞书通讯录搜索自动填 open_id
- 「智能体主动询问同事」动作本身

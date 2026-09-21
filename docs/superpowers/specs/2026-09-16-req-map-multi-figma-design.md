# 需求地图「UI 设计稿挂多张」设计

**日期:** 2026-09-16
**作者:** AI + User
**版本:** 1.0

---

## 需求概述

**痛点：** 需求地图的页面节点只能挂**一条** Figma 链接（`page.figma = { url, node } | null`）。但一个页面通常有多个视觉状态——默认态、空态、加载中、错误态、弹窗展开态——设计师会给出多张稿。当前结构下用户只能挂一张，其余状态要么丢失、要么被迫拆成假页面节点污染地图。

**目标：** 页面节点支持挂**任意多条** Figma 链接，每条带一个状态名，每条可独立触发 UI 还原。

**范围：** 只动「需求地图 → 页面抽屉 → UI 设计稿」这一块。不动地图生成/修订链路、不动 UI 规范本身、不动画布渲染。

---

## 关键决策（已拍板）

### 决策 1：每条稿带 `label`（状态名），不是裸链接数组

还原 prompt 会逐条带上状态名。不带的话，模型拿到多条链接只能自己猜每张对应什么状态，多状态还原的质量不可控。`label` 允许为空（只有一张稿时用户懒得填是常态）。

### 决策 2：每条稿**单独还原**，不做页面级一次全带

用户拍板。每条稿各有一个「还原」按钮，各自触发一轮。

**连带后果：`restoredAt` 必须从页面级下沉到条目级。** 页面级一个时间戳无法表达「稿1 已还原、稿2 还没」——而这正是单独还原要展示的核心状态。因此 `page.restoredAt` 字段退场，改为 `page.figmas[i].restoredAt`。

### 决策 3：单条还原的 prompt 必须带「其他状态名」护栏

单独还原的固有风险是**后一轮覆盖前一轮**：模型看到只有一张空态稿，很可能把组件直接写死成空态。因此 prompt 里列出同页其他稿的**状态名**，并明写「这些状态共用同一个组件，不要把组件写死成单状态，也不要改动其他状态已有的实现」。

**只列状态名，不列其他稿的链接**——列了链接模型会一次把所有状态都做掉，等于退化回页面级还原，用户的选择就失效了。

### 决策 4：`figmas` 全量覆盖，不做 add/remove 两个动作端点

`PUT /api/req/map/figma` 的 body 从 `{url, node}` 改为 `{figmas: [...]}`，语义是幂等全量覆盖。前端本来就持有完整列表，增 / 删 / 改 label 都是一次覆盖。本机单用户无并发，一个幂等端点比两个动作端点少一半代码和测试。

### 决策 5：去掉 `node` 字段（随手清理，未单独拍板）

现结构里的 `figma.node`（Figma 节点 id）只有 `buildRestorePrompt` 读，而前端从挂载入口起就恒传 `node: ''`（`req-map.js:500`）——是个从未被写入过的死字段。用户从 Figma 复制的链接本身已含 `?node-id=`，模型直接能用。新结构不保留 `node`。

若要保留，只需在 `figmas` 条目上加回 `node` 字段并在添加行多一个输入框，改动量很小。

### 否决的替代方案

| 方案 | 否决理由 |
|---|---|
| 保留 `page.figma` 当「主稿」+ 新增 `page.figmaExtras[]` | 两套字段割裂，每处读取都要先合并，回迁 / 旗标 / prompt 三处各写一遍合并逻辑 |
| `figmas` 数组不给 `id`，用下标定位 | 删中间条目后下标错位，`restoredAt` 会挂到错误的稿上；前端逐条渲染也缺稳定 key |

---

## 数据结构

```js
// page 节点（req-map.logic.js normalizeMap 产出）
{
  id, name, file, state, points,
  figmas: [
    { id: 'fg-a1b2c3d4', url: 'https://figma.com/...', label: '默认态', restoredAt: '2026-09-16T06:30:00.000Z' },
    { id: 'fg-e5f6a7b8', url: 'https://figma.com/...', label: '空态',   restoredAt: null },
  ],
}
```

- `figmas` 恒为数组（无稿时空数组，不是 `null`）——省掉所有读取点的空值分支。
- `id`：服务端生成，`'fg-' + randomUUID().slice(0, 8)`（`randomUUID` 在 `routes-conv-notify.js:12` 已有先例）。
- `label`：可空字符串。
- `restoredAt`：ISO 串或 `null`。

### 旧数据升级（`normalizeMap`）

地图版本是落盘历史数据，旧版本仍会被打开，必须无感兼容。归一时一次性升级：

```
{ figma: { url, node }, restoredAt } → { figmas: [{ id, url, label: '', restoredAt }] }
{ figma: null,          restoredAt } → { figmas: [] }
```

`page.figma` / `page.restoredAt` 归一后不再产出。升级收口在 `req-map.logic.js` 导出的 `upgradeFigmas()` 一个函数里，是**唯一**一处认识旧结构的代码；挂载点是地图的唯一读出口 `readMapVersion()`（`requirement-ops.js:879`）——路由层和前端读到的都是落盘原文、不经 `normalizeMap`，挂在读出口才能一次覆盖「GET 给前端 / 路由就地改 / 重生成取 prev」三条路径。

**升级必须确定性且幂等**：它不回写落盘，用户不动手时盘上一直是旧结构，每次读地图都会再跑一遍。id 若随机生成，前端拿到的 id 与下次 restore 时重新升级出的 id 会对不上，还原直接报「设计稿不存在」。旧结构必然只有一条稿，故其 id 固定为 `'fg-legacy'`。

### 重生成回迁（`normalizeMap` 的 `prev` 分支）

现有逻辑按**页面名**从上一版回迁 `figma` / `restoredAt`（`req-map.logic.js:147-148`），改为回迁 `figmas` 整个数组（含各条的 `restoredAt`）。回迁前同样过一遍升级函数——上一版可能还是旧结构。

---

## API 契约（`routes-req-v2.js`）

### `PUT /api/req/map/figma` — 全量覆盖

```jsonc
// 请求
{ "id": "<reqId>", "pageId": "<pageId>", "figmas": [
  { "id": "fg-a1b2c3d4", "url": "https://...", "label": "默认态" },  // 已有条目：带 id
  { "url": "https://...", "label": "空态" }                          // 新增条目：无 id
]}
// 响应
{ "ok": true, "page": { /* 含服务端补全 id / restoredAt 后的 figmas */ } }
```

服务端合并规则由 `req-map.logic.js` 新增纯函数 `mergeFigmas(prevList, incoming)` 承担（路由层只做取值 / 落盘 / 审计）——项目约定：编排层不可直测，判定一律下沉 `.logic.js`。

| 入参情形 | `id` | `restoredAt` |
|---|---|---|
| 带 `id` 且在旧列表中、`url` 未变 | 沿用 | **沿用旧值** |
| 带 `id` 且在旧列表中、`url` 变了 | 沿用 | **清空**（换了稿，「已还原」不再成立——与旧版解绑清 `restoredAt` 同一条理由） |
| 无 `id` 或 `id` 不认识 | 新生成 | `null` |

`url` 为空的条目直接丢弃（等于删除）。审计文案按条目数变化给出「设计稿更新：<页面名>（3 张）」。

### `POST /api/req/map/restore` — 增 `figmaId`

```jsonc
{ "id": "<reqId>", "pageId": "<pageId>", "figmaId": "fg-a1b2c3d4" }
```

`figmaId` 找不到 → 404「该设计稿不存在」（与同一函数上方「页面不存在」的 404 保持一致）。成功后只更新该条目的 `restoredAt`。响应结构不变（`{ ok, prompt, hasSpec }`）。

---

## 还原 prompt（`req-uispec.logic.js`）

`buildRestorePrompt({ page, figma, specText })` — 签名增 `figma`（指明还原哪一条）。`figma` 缺失或无 `url` 时抛错（沿用现有「尚未挂载设计稿，无法还原」语义）。

变化的只有开头三行 + 一段护栏，规范全文与四条还原要求原样保留：

```
请按设计稿还原页面「导出确认弹窗」的【空态】视觉实现。

设计稿：https://figma.com/...
目标文件：src/pages/order/ExportConfirmModal.vue

⚠ 本页还有其他状态的设计稿：默认态、导出中。这些状态共用同一个组件实现，
  因此：不要把组件写死成只有当前这一个状态；不要改动其他状态已有的实现。

<规范全文 / 未配置规范说明>

还原要求：
1~4（原样）
```

- `label` 为空时省略 `的【…】`，退化为原文案。
- 同页无其他稿时，整段护栏不出现。

---

## 前端（`public/js/req-map.js` + `public/css/req-v2.css`）

### 抽屉内「UI 设计稿」区块

```
UI 设计稿
┌──────────────────────────────────────────┐
│ ✓ 默认态   https://figma.com/...         │
│   已还原 09-16 14:30    [再还原] [删除]  │
├──────────────────────────────────────────┤
│ ○ 空态     https://figma.com/...         │
│   未还原                [还原 →] [删除]  │
└──────────────────────────────────────────┘
[状态名(可空)] [粘贴 Figma 链接]      [添加]
```

- 列表为空时只出添加行 + 原有那句提示（「没有设计稿时先按需求地图搭骨架…」）。
- 「添加」：链接为空则不提交；提交后清空两个输入框，可连续录入。
- 「删除」：从本地列表剔除后整表覆盖提交（无二次确认——误删重粘链接即可，代价极低）。
- 每条的「还原」按钮走 `doRestore(page, figma, btn)`，只禁用当前这一条的按钮。
- 复用现有 class（`.rq-figcard` / `.rq-fh` / `.rq-fb` / `.rq-facts` / `.rq-restored` / `.rq-furl`），新增条目分隔与状态名徽标的少量样式。

### 画布节点旗标（`req-map.js:174`）

`🎨 已挂稿` / `🎨 已还原` 改为按条目数聚合：

- 无稿：不出旗标（同现状）
- 有稿：`🎨 3 张稿 · 2 已还原`；一张都没还原时 `🎨 3 张稿`
- 保留 `.rq-nflag.rq-figma` 配色不变

---

## 测试

| 文件 | 用例 |
|---|---|
| `req-map.logic.test.js` | 旧 `figma` 单对象归一为单元素 `figmas`，`restoredAt` 随之下沉；旧 `figma: null` 归一为空数组；回迁保留整个 `figmas`（含各条 `restoredAt`）；改名的页面不误挂设计稿（现有用例，改数组语义） |
| `req-map.logic.test.js`（`mergeFigmas`） | `url` 未变保 `restoredAt` / `url` 变了清 `restoredAt` / 新增条目生成 id 且 `restoredAt` 为 `null` / 空 `url` 条目被丢弃 / 未知 `id` 当新增处理 |
| `req-uispec.logic.test.js` | prompt 带状态名与链接；同页其他稿**只出状态名不出链接**；`label` 为空时不出 `【】`；同页仅一张稿时无护栏段；`figma` 缺失抛错 |

验证命令：`npm test`

---

## 非目标（YAGNI）

- **不做**「一键还原全部状态」按钮——用户已明确选择逐条还原。
- **不做** 设计稿排序 / 拖拽——按录入顺序即可。
- **不做** Figma 缩略图预览——需要 Figma API token，超出本次范围。
- **不做** 旧 `page.figma` 字段的双写兼容——归一收口一处，没有第二个消费者。

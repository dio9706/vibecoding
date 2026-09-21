# 需求地图「UI 设计稿挂多张」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目不自动 git 提交**（见 `CLAUDE.md`「协作约定」）。每个 Task 末尾的「收尾」步骤只跑测试，**不要执行 `git commit`**，改动一律留工作区由维护者决定提交时机。

**Goal:** 需求地图的页面节点支持挂任意多条 Figma 设计稿，每条带状态名（如「空态」「加载中」），每条可独立触发 UI 还原。

**Architecture:** 数据结构从 `page.figma = {url,node}|null` 改为 `page.figmas = [{id,url,label,restoredAt}]`，`restoredAt` 随之从页面级下沉到条目级。旧结构的升级收口在 `req-map.logic.js` 的 `upgradeFigmas()` 一个纯函数里，由地图的唯一读出口 `readMapVersion()` 和 `normalizeMap()` 共同调用——下游（前端 / 路由 / 重生成回迁）一律只认新结构。列表写入走一个幂等的全量覆盖端点，合并规则由纯函数 `mergeFigmas()` 承担。

**Tech Stack:** Node LTS ESM、`node --test`（零框架，`node:assert/strict`）、原生 DOM（前端无框架）。

**Spec:** `docs/superpowers/specs/2026-09-16-req-map-multi-figma-design.md`

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/entrypoints/web/req-map.logic.js` | 修改 | 新增 `upgradeFigmas()`（旧结构升级，确定性幂等）、`mergeFigmas()`（全量覆盖合并规则）；`normalizeMap()` 产出 `figmas` 取代 `figma`/`restoredAt` |
| `src/entrypoints/web/req-map.logic.test.js` | 修改 | 两条现有 figma 回迁用例改数组语义；新增升级 / 合并规则用例 |
| `src/entrypoints/web/requirement-ops.js` | 修改 | `readMapVersion()` 在读出口统一升级旧结构 |
| `src/entrypoints/web/req-uispec.logic.js` | 修改 | `buildRestorePrompt` 签名增 `figma`，prompt 带状态名 + 「其他状态」护栏 |
| `src/entrypoints/web/req-uispec.logic.test.js` | 修改 | 用例改新签名；新增护栏相关用例 |
| `src/entrypoints/web/routes-req-v2.js` | 修改 | `handleMapFigma` 改全量覆盖；`handleMapRestore` 增 `figmaId` |
| `public/js/req-map.js` | 修改 | 抽屉「UI 设计稿」区块改多条列表；画布节点旗标改聚合文案 |
| `public/css/req-v2.css` | 修改 | 多条目分隔线、状态名徽标、未还原态、添加行状态名输入框宽度 |

**对 spec 的两处修正（实现时按本计划为准）：**

1. spec 说升级「收口在 `normalizeMap` 内一个私有函数」——实际必须 **export**，因为路由层读的是落盘原文（未经 `normalizeMap`）。收口点改为 `readMapVersion()`（地图唯一读出口）。
2. spec 说 `figmaId` 找不到回 400——改为 **404**，与同一函数上方「页面不存在」回 404 保持一致。

---

### Task 1: `upgradeFigmas` —— 旧结构升级（确定性幂等）

**为什么必须确定性：** 升级**不落盘**（用户不操作时盘上仍是旧结构），所以每次读地图都会升级一次。若 id 随机生成，前端拿到的 id 与下次 restore 时服务端重新升级出的 id 对不上，还原按钮必然报「该设计稿不存在」。因此旧结构升级出的条目 id 恒为 `'fg-legacy'`（旧结构必然只有一条稿，不存在碰撞）。

**Files:**
- Modify: `src/entrypoints/web/req-map.logic.js`（在 `normalizeMap` 上方，`toStrList` 之后）
- Test: `src/entrypoints/web/req-map.logic.test.js`

- [ ] **Step 1: 写失败的测试**

追加到 `src/entrypoints/web/req-map.logic.test.js` 顶部 import 之后（`upgradeFigmas` 加进现有 import 列表）：

```js
// ---- upgradeFigmas ----

test('upgradeFigmas 把旧版单条 figma + 页面级 restoredAt 升级为 figmas 数组', () => {
  const page = { figma: { url: 'https://figma.com/x', node: '12:3' }, restoredAt: '2026-08-25T00:00:00.000Z' };
  assert.deepEqual(upgradeFigmas(page), [
    { id: 'fg-legacy', url: 'https://figma.com/x', label: '', restoredAt: '2026-08-25T00:00:00.000Z' },
  ]);
});

test('upgradeFigmas 是幂等的 —— 升级不落盘，每次读地图都会再跑一遍，id 必须稳定', () => {
  const page = { figma: { url: 'https://figma.com/x' }, restoredAt: null };
  const once = upgradeFigmas(page);
  assert.deepEqual(upgradeFigmas({ figmas: once }), once);
});

test('upgradeFigmas 无稿页面给出空数组而非 null', () => {
  assert.deepEqual(upgradeFigmas({ figma: null, restoredAt: null }), []);
  assert.deepEqual(upgradeFigmas({}), []);
  assert.deepEqual(upgradeFigmas(null), []);
});

test('upgradeFigmas 对新结构补齐缺失字段并丢弃空 url 条目', () => {
  const out = upgradeFigmas({ figmas: [{ url: 'u1' }, { url: '' }, { id: 'fg-x', url: 'u2', label: '空态' }] });
  assert.deepEqual(out, [
    { id: 'fg-1', url: 'u1', label: '', restoredAt: null },
    { id: 'fg-x', url: 'u2', label: '空态', restoredAt: null },
  ]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --test-name-pattern="upgradeFigmas" src/entrypoints/web/req-map.logic.test.js`
Expected: FAIL，`SyntaxError` 或 `upgradeFigmas is not a function`（尚未导出）

- [ ] **Step 3: 实现**

在 `src/entrypoints/web/req-map.logic.js` 的 `toStrList` 函数之后插入：

```js
/**
 * 旧结构升级：页面级 `figma` 单对象 + `restoredAt` → 条目级 `figmas` 数组。
 *
 * **必须确定性且幂等**：升级不落盘（用户不动手时盘上一直是旧结构），每次读地图都会再跑一遍。
 * id 若随机生成，前端拿到的 id 与下次 restore 时重新升级出的 id 会对不上，还原直接报「设计稿不存在」。
 * 旧结构必然只有一条稿，故固定 `fg-legacy`；新结构缺 id 的（理论上不会有）按下标兜底。
 */
export function upgradeFigmas(page) {
  if (Array.isArray(page?.figmas)) {
    return page.figmas
      .map((f, i) => ({
        id: String(f?.id ?? '').trim() || `fg-${i + 1}`,
        url: String(f?.url ?? '').trim(),
        label: String(f?.label ?? '').trim(),
        restoredAt: f?.restoredAt ?? null,
      }))
      .filter((f) => f.url);
  }
  const url = String(page?.figma?.url ?? '').trim();
  if (!url) return [];
  return [{ id: 'fg-legacy', url, label: '', restoredAt: page?.restoredAt ?? null }];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --test-name-pattern="upgradeFigmas" src/entrypoints/web/req-map.logic.test.js`
Expected: PASS，4 条用例全绿

- [ ] **Step 5: 收尾**

Run: `npm test`
Expected: `req-map.logic.test.js` 里两条 figma 回迁用例**仍是绿的**（本步没动 `normalizeMap`）。改动留工作区，不提交。

---

### Task 2: `mergeFigmas` —— 全量覆盖的合并规则

**Files:**
- Modify: `src/entrypoints/web/req-map.logic.js`（紧跟 `upgradeFigmas` 之后）
- Test: `src/entrypoints/web/req-map.logic.test.js`

- [ ] **Step 1: 写失败的测试**

追加到 `req-map.logic.test.js`（`mergeFigmas` 加进 import 列表）。新增条目的 id 是随机的，所以只断言 `fg-` 前缀，不断言具体值：

```js
// ---- mergeFigmas ----

const PREV = [
  { id: 'fg-a', url: 'https://figma.com/a', label: '默认态', restoredAt: '2026-09-01T00:00:00.000Z' },
  { id: 'fg-b', url: 'https://figma.com/b', label: '空态', restoredAt: null },
];

test('mergeFigmas 只改 label 时保留 restoredAt', () => {
  const out = mergeFigmas(PREV, [{ id: 'fg-a', url: 'https://figma.com/a', label: '默认' }]);
  assert.deepEqual(out, [
    { id: 'fg-a', url: 'https://figma.com/a', label: '默认', restoredAt: '2026-09-01T00:00:00.000Z' },
  ]);
});

test('mergeFigmas 换了 url 就清掉 restoredAt —— 换了稿，「已按这张稿还原过」不再成立', () => {
  const out = mergeFigmas(PREV, [{ id: 'fg-a', url: 'https://figma.com/NEW', label: '默认态' }]);
  assert.equal(out[0].id, 'fg-a');
  assert.equal(out[0].restoredAt, null);
});

test('mergeFigmas 新增条目生成 fg- 前缀 id，restoredAt 为 null', () => {
  const out = mergeFigmas(PREV, [...PREV, { url: 'https://figma.com/c', label: '导出中' }]);
  assert.equal(out.length, 3);
  assert.match(out[2].id, /^fg-/);
  assert.equal(out[2].restoredAt, null);
  assert.equal(out[2].label, '导出中');
});

test('mergeFigmas 丢弃空 url 条目（前端删除就是把该条从列表里剔掉后整表覆盖）', () => {
  const out = mergeFigmas(PREV, [PREV[0], { id: 'fg-b', url: '  ', label: '空态' }]);
  assert.deepEqual(out.map((f) => f.id), ['fg-a']);
});

test('mergeFigmas 不认识的 id 当新增处理，不会把别人的 restoredAt 带过来', () => {
  const out = mergeFigmas(PREV, [{ id: 'fg-ghost', url: 'https://figma.com/z' }]);
  assert.notEqual(out[0].id, 'fg-ghost');
  assert.equal(out[0].restoredAt, null);
});

test('mergeFigmas 非法入参退化为空数组，不抛错', () => {
  assert.deepEqual(mergeFigmas(null, null), []);
  assert.deepEqual(mergeFigmas(undefined, 'nope'), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --test-name-pattern="mergeFigmas" src/entrypoints/web/req-map.logic.test.js`
Expected: FAIL，`mergeFigmas is not a function`

- [ ] **Step 3: 实现**

`src/entrypoints/web/req-map.logic.js` 文件顶部加 import：

```js
import { randomUUID } from 'node:crypto';
```

在 `upgradeFigmas` 之后插入：

```js
/**
 * 设计稿列表全量覆盖：以入参为准，按 id 把已有条目的 `restoredAt` 带过来。
 *
 * url 变了必须清掉 `restoredAt` —— 换了一张稿，「已按这张稿还原过」就不再成立
 *（与旧版「解绑连带清 restoredAt」同一条理由）。只改 label 不算换稿。
 * 空 url 条目直接丢弃：前端的「删除」就是把该条从列表里剔掉后整表提交。
 */
export function mergeFigmas(prevList, incoming) {
  const prevById = new Map((Array.isArray(prevList) ? prevList : []).map((f) => [String(f?.id ?? ''), f]));
  const out = [];
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const url = String(raw?.url ?? '').trim();
    if (!url) continue;
    const old = prevById.get(String(raw?.id ?? ''));
    out.push({
      id: old ? old.id : 'fg-' + randomUUID().slice(0, 8),
      url,
      label: String(raw?.label ?? '').trim(),
      restoredAt: old && old.url === url ? (old.restoredAt ?? null) : null,
    });
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --test-name-pattern="mergeFigmas" src/entrypoints/web/req-map.logic.test.js`
Expected: PASS，6 条用例全绿

- [ ] **Step 5: 收尾**

Run: `npm test`
Expected: 全绿。改动留工作区，不提交。

---

### Task 3: `normalizeMap` 改产 `figmas`

**Files:**
- Modify: `src/entrypoints/web/req-map.logic.js:119-151`（`normalizeMap` 的 JSDoc 与页面组装）
- Test: `src/entrypoints/web/req-map.logic.test.js:161-176`（两条现有用例改数组语义）

- [ ] **Step 1: 改测试到新语义（此时应失败）**

把 `req-map.logic.test.js` 里现有的两条用例整体替换为：

```js
test('normalizeMap 保留旧版的 figmas，不被重生成抹掉', () => {
  // 地图修订会全量重出 pages，用户挂的设计稿必须按页面名回迁，否则每修订一次就丢一次
  const prev = normalizeMap({ pages: [{ name: 'A', file: 'a.vue' }] });
  prev.pages[0].figmas = [
    { id: 'fg-a', url: 'u1', label: '默认态', restoredAt: '2026-08-25T00:00:00.000Z' },
    { id: 'fg-b', url: 'u2', label: '空态', restoredAt: null },
  ];
  const next = normalizeMap({ pages: [{ name: 'A', file: 'a.vue' }] }, { prev });
  assert.deepEqual(next.pages[0].figmas, prev.pages[0].figmas);
  assert.equal(next.pages[0].figma, undefined); // 旧字段不再产出
  assert.equal(next.pages[0].restoredAt, undefined); // restoredAt 已下沉到条目
});

test('normalizeMap 回迁旧结构的上一版地图时顺带升级为 figmas', () => {
  // prev 可能来自历史落盘数据，仍是 { figma, restoredAt } 单对象结构
  const prev = { pages: [{ name: 'A', figma: { url: 'u' }, restoredAt: '2026-08-25T00:00:00.000Z' }] };
  const next = normalizeMap({ pages: [{ name: 'A' }] }, { prev });
  assert.deepEqual(next.pages[0].figmas, [
    { id: 'fg-legacy', url: 'u', label: '', restoredAt: '2026-08-25T00:00:00.000Z' },
  ]);
});

test('normalizeMap 回迁只认同名页面，改名的页面不误挂设计稿', () => {
  const prev = normalizeMap({ pages: [{ name: 'A' }] });
  prev.pages[0].figmas = [{ id: 'fg-a', url: 'u', label: '', restoredAt: null }];
  const next = normalizeMap({ pages: [{ name: 'B' }] }, { prev });
  assert.deepEqual(next.pages[0].figmas, []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --test-name-pattern="normalizeMap" src/entrypoints/web/req-map.logic.test.js`
Expected: FAIL，`next.pages[0].figmas` 为 `undefined`

- [ ] **Step 3: 实现**

改 `req-map.logic.js` 的 JSDoc（`@param opts.prev` 那一行）：

```js
 * @param {object|null} [opts.prev] - 上一版地图。修订会全量重出 pages，用户挂过的设计稿
 *   （`figmas`，含各条的 `restoredAt`）必须**按页面名**回迁，否则每修订一次就把设计稿丢一次。
 *   prev 可能仍是旧的 `{ figma, restoredAt }` 结构，交给 upgradeFigmas 顺带升级。
```

把页面组装里的两行：

```js
      figma: old?.figma ?? null,
      restoredAt: old?.restoredAt ?? null,
```

替换为一行：

```js
      figmas: upgradeFigmas(old),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --test-name-pattern="normalizeMap" src/entrypoints/web/req-map.logic.test.js`
Expected: PASS

- [ ] **Step 5: 收尾**

Run: `npm test`
Expected: 全绿。`req-uispec.logic.test.js` 此时**仍应通过**（那边用的是自己构造的 `page` 字面量，尚未改签名）。改动留工作区，不提交。

---

### Task 4: `readMapVersion` 在唯一读出口统一升级

路由层与前端读到的都是落盘原文（**未经** `normalizeMap`），所以升级必须挂在地图的唯一读出口上。挂在这里一处，三条路径（GET 给前端 / 路由就地改 / 重生成取 prev）全部覆盖。

**Files:**
- Modify: `src/entrypoints/web/requirement-ops.js:879-890`

- [ ] **Step 1: 确认当前形态**

Run: `npm test`（基线全绿）。`readMapVersion` 每次都是 `JSON.parse(fs.readFileSync(...))` 出来的全新对象、无缓存，因此可以放心就地改写和 `delete`。

- [ ] **Step 2: 实现**

`requirement-ops.js` 顶部的 `req-map.logic.js` import 列表里加入 `upgradeFigmas`（该文件已 import `normalizeMap` / `markFreshPoints` 等，追加即可）。

把 `readMapVersion` 的 try 块：

```js
  try {
    return JSON.parse(fs.readFileSync(target.path, 'utf8'));
  } catch (e) {
```

替换为：

```js
  try {
    const map = JSON.parse(fs.readFileSync(target.path, 'utf8'));
    // 旧版地图（page.figma 单对象 + 页面级 restoredAt）在唯一的读出口统一升级为 figmas 数组，
    // 下游（前端 / 路由就地改 / 重生成取 prev）一律只认新结构。
    // 不回写落盘：upgradeFigmas 是确定性的，每次读都升级出同一份 id，没有回写的必要。
    for (const p of map?.pages || []) {
      p.figmas = upgradeFigmas(p);
      delete p.figma;
      delete p.restoredAt;
    }
    return map;
  } catch (e) {
```

- [ ] **Step 3: 跑测试确认无回归**

Run: `npm test`
Expected: 全绿（该函数无直测，靠 Task 1 的 `upgradeFigmas` 纯函数用例背书）

- [ ] **Step 4: 收尾**

改动留工作区，不提交。

---

### Task 5: `buildRestorePrompt` 带状态名与「其他状态」护栏

**Files:**
- Modify: `src/entrypoints/web/req-uispec.logic.js:11-37`
- Test: `src/entrypoints/web/req-uispec.logic.test.js:7-32`

- [ ] **Step 1: 改测试到新签名并加护栏用例（此时应失败）**

把 `req-uispec.logic.test.js` 的 `// ---- buildRestorePrompt ----` 到 `buildSpecDraftPrompt` 之前的整段替换为：

```js
// ---- buildRestorePrompt ----

const FG_DEFAULT = { id: 'fg-a', url: 'https://figma.com/x', label: '默认态', restoredAt: null };
const FG_EMPTY = { id: 'fg-b', url: 'https://figma.com/y', label: '空态', restoredAt: null };
const page = {
  name: '导出确认弹窗',
  file: 'src/pages/order/ExportConfirmModal.vue',
  figmas: [FG_DEFAULT, FG_EMPTY],
};

test('buildRestorePrompt 带上设计稿链接、目标文件与规范全文', () => {
  const p = buildRestorePrompt({ page, figma: FG_DEFAULT, specText: '弹框统一用 OpModal，圆角 12px' });
  assert.match(p, /figma\.com\/x/);
  assert.match(p, /ExportConfirmModal\.vue/);
  assert.match(p, /OpModal/);
});

test('buildRestorePrompt 在标题里点明这一轮还原的是哪个状态', () => {
  const p = buildRestorePrompt({ page, figma: FG_EMPTY, specText: 'x' });
  assert.match(p, /【空态】/);
});

test('buildRestorePrompt 列出同页其他状态名，但不给它们的链接', () => {
  // 逐条还原的固有风险是后一轮把前一轮覆盖掉，所以要告诉模型这页还有别的状态；
  // 但给了链接模型会一次全做完，就退化成页面级还原了
  const p = buildRestorePrompt({ page, figma: FG_EMPTY, specText: 'x' });
  assert.match(p, /默认态/);
  assert.ok(!p.includes('figma.com/x'), '不应出现其他稿的链接');
  assert.match(p, /不要把组件写死/);
});

test('buildRestorePrompt 同页只有一张稿时不出护栏段', () => {
  const solo = { name: 'A', file: 'a.vue', figmas: [FG_DEFAULT] };
  const p = buildRestorePrompt({ page: solo, figma: FG_DEFAULT, specText: 'x' });
  assert.ok(!p.includes('其他状态'), '单张稿不该提其他状态');
});

test('buildRestorePrompt label 为空时不出空的【】', () => {
  const fg = { id: 'fg-a', url: 'https://figma.com/x', label: '', restoredAt: null };
  const p = buildRestorePrompt({ page: { name: 'A', file: 'a.vue', figmas: [fg] }, figma: fg, specText: 'x' });
  assert.ok(!p.includes('【】'));
  assert.match(p, /还原页面「A」的视觉实现/);
});

test('buildRestorePrompt 其他稿没填状态名时以「未命名状态」占位', () => {
  const anon = { id: 'fg-c', url: 'https://figma.com/z', label: '', restoredAt: null };
  const p = buildRestorePrompt({ page: { name: 'A', figmas: [FG_DEFAULT, anon] }, figma: FG_DEFAULT, specText: 'x' });
  assert.match(p, /未命名状态/);
});

test('buildRestorePrompt 明确规范优先于设计稿，并要求列出冲突', () => {
  // 这是整个还原能力的核心约束：设计稿和规范打架时不能让模型自己拍脑袋
  const p = buildRestorePrompt({ page, figma: FG_DEFAULT, specText: 'x' });
  assert.match(p, /规范/);
  assert.match(p, /冲突/);
});

test('buildRestorePrompt 规范为空时改口径为「按现有代码风格」并说明未配置', () => {
  const p = buildRestorePrompt({ page, figma: FG_DEFAULT, specText: '' });
  assert.match(p, /未配置/);
});

test('buildRestorePrompt 缺设计稿时抛错', () => {
  assert.throws(() => buildRestorePrompt({ page: { name: 'A' }, figma: null, specText: 'x' }), /设计稿/);
  assert.throws(() => buildRestorePrompt({ page, figma: { id: 'fg-x', url: '' }, specText: 'x' }), /设计稿/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --test-name-pattern="buildRestorePrompt" src/entrypoints/web/req-uispec.logic.test.js`
Expected: FAIL —— 「缺设计稿时抛错」以外的用例全挂（旧实现读的是 `page.figma`，新入参给的是 `figma`）

- [ ] **Step 3: 实现**

把 `src/entrypoints/web/req-uispec.logic.js` 的 `buildRestorePrompt` 整体替换为：

```js
/**
 * 按 UI 规范还原某个页面**某一张设计稿**的 prompt。规范为空时不能假装有规范——
 * 改口径为「对齐现有代码风格」并显式说明未配置，否则模型会凭空编一套 token 出来。
 *
 * 同页多张稿是逐条还原的，固有风险是后一轮把前一轮覆盖掉，所以要把同页其他状态名带进来做护栏。
 * **只给名字不给链接**：给了链接模型会一次把所有状态都做掉，逐条还原就失去意义了。
 *
 * @param {object} opts.page - 页面节点（用 name / file / figmas）
 * @param {object} opts.figma - 本轮要还原的那一条 `{ id, url, label }`
 * @param {string} opts.specText - 项目 UI 规范全文，可空
 */
export function buildRestorePrompt({ page, figma, specText }) {
  const url = String(figma?.url ?? '').trim();
  if (!url) throw new Error('该页面尚未挂载设计稿，无法还原');
  const label = String(figma?.label ?? '').trim();
  const scope = label ? `的【${label}】` : '的';
  const spec = String(specText ?? '').trim();

  const others = (page?.figmas || [])
    .filter((f) => f && f.id !== figma?.id)
    .map((f) => String(f?.label ?? '').trim() || '未命名状态');
  const guard = others.length
    ? `⚠ 本页还有其他状态的设计稿：${others.join('、')}。这些状态共用同一个组件实现，因此：\n` +
      `  不要把组件写死成只有当前这一个状态；不要改动其他状态已有的实现。\n\n`
    : '';

  const specPart = spec
    ? `本项目 UI 规范全文（**优先级高于设计稿**，下称「规范」）：\n---\n${spec}\n---\n`
    : `本项目**尚未配置 UI 规范**。请对齐工程内现有同类组件的写法，不要自创一套样式体系。\n`;

  return (
    `请按设计稿还原页面「${page.name}」${scope}视觉实现。\n\n` +
    `设计稿：${url}\n` +
    `目标文件：${page.file || '（按页面名在工程内定位）'}\n\n` +
    guard +
    specPart +
    `\n还原要求：\n` +
    `1. 组件一律用规范指定的那个，不要自己写裸标签或自造弹框。\n` +
    `2. 圆角、间距、字号、颜色一律回落到规范的档位，不要从设计稿里量像素直接抄。\n` +
    `3. 只改视觉，**不要动已经实现的业务逻辑**。\n` +
    `4. 设计稿与规范**冲突**时按规范落地，并在回复末尾用「⚠ 冲突」列出每一处：\n` +
    `   设计稿是什么、规范是什么、你按哪个落的。这些要由人来裁决，不要自行决定后就不提。`
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --test-name-pattern="buildRestorePrompt" src/entrypoints/web/req-uispec.logic.test.js`
Expected: PASS，9 条用例全绿

- [ ] **Step 5: 收尾**

Run: `npm test`
Expected: 全绿。注意此刻路由层**还在按旧签名调用** `buildRestorePrompt`（少传 `figma`），运行时还原功能是坏的——Task 6 会修好，中途不要去起服务验证。改动留工作区，不提交。

---

### Task 6: 路由层 —— 全量覆盖 + 按 `figmaId` 还原

**Files:**
- Modify: `src/entrypoints/web/routes-req-v2.js:21`（import）、`:144-165`（`handleMapFigma`）、`:167-191`（`handleMapRestore`）

- [ ] **Step 1: 改 import**

第 21 行：

```js
import { collectAnnotLines } from './req-map.logic.js';
```

改为：

```js
import { collectAnnotLines, mergeFigmas } from './req-map.logic.js';
```

- [ ] **Step 2: 改 `handleMapFigma` 为全量覆盖**

把 `:144-165` 整段替换为：

```js
// ==== PUT /api/req/map/figma {id, pageId, figmas:[{id?,url,label}]} ====
// 全量覆盖（增 / 删 / 改 label 都走这一个幂等端点）。就地改当前版，不升版本。
// restoredAt 的存废规则在 mergeFigmas 里，路由层只管取值、落盘、记审计。
function handleMapFigma(req, res) {
  return withJsonBody(req, res, (data) => {
    const got = mustGetMap(res, str(data.id));
    if (!got) return;
    const { r, map } = got;
    const page = map.pages.find((p) => p.id === str(data.pageId));
    if (!page) return sendJson(res, 404, { error: '页面不存在' });

    page.figmas = mergeFigmas(page.figmas, data.figmas);
    writeMapVersion(r, map);
    updateRequirement(r.id, {}, `更新设计稿：${page.name}（${page.figmas.length} 张）`);
    sendJson(res, 200, { ok: true, page });
  });
}
```

- [ ] **Step 3: 改 `handleMapRestore` 按 `figmaId` 定位**

把 `:167-191` 整段替换为：

```js
// ==== POST /api/req/map/restore {id, pageId, figmaId} —— 按 UI 规范还原某一张稿 ====
// 服务端只负责「记状态 + 拼 prompt」，真正的发送由前端 sendMessageProgrammatically 完成
//（与 API 文档上传后自动发对照修正消息同款范式，见 req-chat.js）。
function handleMapRestore(req, res) {
  return withJsonBody(req, res, (data) => {
    const got = mustGetMap(res, str(data.id));
    if (!got) return;
    const { r, map } = got;
    const page = map.pages.find((p) => p.id === str(data.pageId));
    if (!page) return sendJson(res, 404, { error: '页面不存在' });
    const figma = (page.figmas || []).find((f) => f.id === str(data.figmaId));
    if (!figma) return sendJson(res, 404, { error: '该设计稿不存在' });

    // UI 规范按「第一个工程」归属，与 docgen/开发任务的 cwd 同源
    const { cwd } = pickCwdAndDirs(r.projects);
    let prompt;
    try {
      prompt = buildRestorePrompt({ page, figma, specText: readUiSpec(cwd) });
    } catch (e) {
      return sendJson(res, 400, { error: e?.message || '无法生成还原任务' });
    }
    figma.restoredAt = new Date().toISOString();
    writeMapVersion(r, map);
    updateRequirement(r.id, {}, '触发 UI 还原：' + page.name + (figma.label ? ' · ' + figma.label : ''));
    sendJson(res, 200, { ok: true, prompt, hasSpec: !!readUiSpec(cwd).trim() });
  });
}
```

- [ ] **Step 4: 语法自检 + 全量测试**

Run: `node --check src/entrypoints/web/routes-req-v2.js && npm test`
Expected: 无输出（语法 OK）+ 测试全绿

- [ ] **Step 5: 收尾**

改动留工作区，不提交。

---

### Task 7: 前端 —— 多条设计稿列表与聚合旗标

**Files:**
- Modify: `public/js/req-map.js:174`（节点旗标）、`:463-532`（`buildFigmaSection` / `saveFigma` / `doRestore`）
- Modify: `public/css/req-v2.css:242-257`（设计稿区块样式）

- [ ] **Step 1: 改画布节点旗标**

`public/js/req-map.js:174` 这一行：

```js
    if (page.figma) top.appendChild(el('span', 'rq-nflag rq-figma', page.restoredAt ? '🎨 已还原' : '🎨 已挂稿'));
```

替换为：

```js
    // 多张稿时一眼看出「挂了几张、还原了几张」，比单个「已挂稿/已还原」信息量大
    const figmas = page.figmas || [];
    if (figmas.length) {
      const done = figmas.filter((f) => f.restoredAt).length;
      const txt = '🎨 ' + figmas.length + ' 张稿' + (done ? ' · ' + done + ' 已还原' : '');
      top.appendChild(el('span', 'rq-nflag rq-figma', txt));
    }
```

- [ ] **Step 2: 重写设计稿区块**

把 `public/js/req-map.js` 的 `buildFigmaSection`（`:463-493`）、`saveFigma`（`:495-511`）、`doRestore`（`:513-532`）三个函数整体替换为：

```js
  /**
   * UI 设计稿区块：一页可以挂多张稿（同一页面的不同状态：默认态 / 空态 / 加载中…），
   * 每张各自还原一次——多状态共用一个组件，逐条还原时靠 prompt 里的护栏防止后一轮覆盖前一轮。
   */
  function buildFigmaSection(page) {
    const s = section('UI 设计稿');
    const list = page.figmas || [];
    if (list.length) {
      const card = el('div', 'rq-figcard');
      for (const fg of list) card.appendChild(buildFigmaItem(page, fg));
      s.appendChild(card);
    }
    s.appendChild(buildFigmaAddRow(page));
    if (!list.length) {
      s.appendChild(el('div', 'rq-tip', '没有设计稿时先按需求地图搭骨架；设计稿到位后回这里挂载，再触发一次 UI 还原。'));
    }
    return s;
  }

  /** 单条稿：状态名徽标 + 链接 + 还原/删除。条目间的分隔线交给 CSS 相邻选择器。 */
  function buildFigmaItem(page, fg) {
    const box = el('div', 'rq-figitem');
    const head = el('div', 'rq-fh');
    head.appendChild(el('span', 'rq-ok', fg.restoredAt ? '✓' : '○'));
    if (fg.label) head.appendChild(el('span', 'rq-flabel', fg.label));
    head.appendChild(el('span', 'rq-furl', fg.url));
    box.appendChild(head);

    const body = el('div', 'rq-fb');
    body.appendChild(
      fg.restoredAt
        ? el('div', 'rq-restored', '已还原 · ' + fg.restoredAt.slice(0, 16).replace('T', ' '))
        : el('div', 'rq-unrestored', '未还原'),
    );
    const acts = el('div', 'rq-facts');
    const go = el('button', 'btn primary', fg.restoredAt ? '再还原一次' : '按 UI 规范还原 →');
    go.addEventListener('click', () => doRestore(page, fg, go));
    const del = el('button', 'btn', '删除');
    // 不做二次确认：误删把链接重新粘一遍即可，代价远低于每次都弹框
    del.addEventListener('click', () => saveFigmas(page, (page.figmas || []).filter((x) => x.id !== fg.id)));
    acts.append(go, del);
    body.appendChild(acts);
    box.appendChild(body);
    return box;
  }

  /** 添加行：状态名可空，链接为空不提交；提交后清空两个框，方便连续录入多张。 */
  function buildFigmaAddRow(page) {
    const row = el('div', 'rq-figrow');
    const label = el('input');
    label.className = 'rq-figlabel';
    label.placeholder = '状态名（可空）';
    const url = el('input');
    url.placeholder = '粘贴 Figma 链接';
    const add = el('button', 'btn primary', '添加');
    const submit = () => {
      const u = url.value.trim();
      if (!u) return;
      saveFigmas(page, [...(page.figmas || []), { url: u, label: label.value.trim() }]);
    };
    add.addEventListener('click', submit);
    url.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    row.append(label, url, add);
    return row;
  }

  /** 全量覆盖提交（增 / 删都走这一个端点）。服务端补 id 与 restoredAt 存废，回填后重绘。 */
  async function saveFigmas(page, figmas) {
    try {
      const r = await fetch('/api/req/map/figma', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reqId, pageId: page.id, figmas }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '保存失败');
      page.figmas = d.page.figmas;
      openPage(page.id); // 内含 renderNodes()，画布旗标同步刷新
      window.toast.success('已保存设计稿');
    } catch (e) {
      window.toast.error('设计稿保存失败：' + (e?.message || e));
    }
  }

  async function doRestore(page, fg, btn) {
    btn.disabled = true;
    try {
      const r = await fetch('/api/req/map/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reqId, pageId: page.id, figmaId: fg.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '触发失败');
      fg.restoredAt = new Date().toISOString();
      openPage(page.id);
      if (!d.hasSpec) window.toast.error('本项目还没配 UI 规范，已按现有代码风格还原');
      onRestore?.(d.prompt);
    } catch (e) {
      window.toast.error('触发还原失败：' + (e?.message || e));
    } finally {
      btn.disabled = false;
    }
  }
```

- [ ] **Step 3: 补样式**

把 `public/css/req-v2.css:242-257` 的「设计稿挂载 / 还原」整段替换为：

```css
/* ── 设计稿挂载 / 还原（一页可挂多张，对应页面的不同状态）─────────────── */
.rq-figrow { display: flex; gap: 8px; margin-top: 10px; }
.rq-figrow input {
  flex: 1; min-width: 0; padding: 8px 11px; border-radius: 8px;
  background: var(--panel-2, #1b1c26); border: 1px solid var(--border-soft);
  color: var(--text); font-family: var(--mono, monospace); font-size: 12px; outline: none;
}
.rq-figrow input.rq-figlabel { flex: 0 0 92px; font-family: inherit; }
.rq-figrow input:focus { border-color: var(--accent); }
.rq-tip { font-size: 12px; color: var(--faint); margin-top: 8px; line-height: 1.6; }
.rq-figcard { border: 1px solid var(--border-soft); border-radius: 10px; overflow: hidden; }
.rq-figitem + .rq-figitem { border-top: 1px solid var(--border-soft); }
.rq-fh { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: var(--panel-2, #1b1c26); font-size: 12.5px; }
.rq-fh .rq-ok { color: var(--green); }
.rq-flabel {
  flex: 0 0 auto; font-size: 11px; padding: 1px 7px; border-radius: 4px;
  background: rgba(91, 141, 239, 0.16); color: var(--blue); white-space: nowrap;
}
.rq-furl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.rq-fb { padding: 11px 12px; font-size: 12px; color: var(--muted); }
.rq-restored { color: var(--green); margin-bottom: 9px; }
.rq-unrestored { color: var(--faint); margin-bottom: 9px; }
.rq-facts { display: flex; gap: 8px; }
```

- [ ] **Step 4: 前端语法自检**

Run: `node --check public/js/req-map.js`
Expected: 无输出

> 前端 import 图有语法错误时的症状是「卡启动页 + 窗口按钮消失」，`node --check` 是最快的定位手段——别跳过这步。

- [ ] **Step 5: 收尾**

Run: `npm test`
Expected: 全绿。改动留工作区，不提交。

---

### Task 8: 人工验收

**Files:** 无改动，纯验证。

- [ ] **Step 1: 起服务**

Run: `npm start`
Expected: 监听 `127.0.0.1:3000`，无启动报错

- [ ] **Step 2: 挂多张稿**

浏览器打开 `http://127.0.0.1:3000`，进一个已有需求地图的需求 → 点任一页面节点开抽屉 → 「UI 设计稿」区：

1. 状态名填「默认态」、链接粘一个 figma URL → 点「添加」→ 出现第一条，toast「已保存设计稿」
2. 再加「空态」「导出中」两条 → 列表三条，条目间有分隔线
3. 画布上该节点旗标显示 `🎨 3 张稿`

- [ ] **Step 3: 逐条还原**

点「空态」那条的「按 UI 规范还原 →」：

1. 该条变为「已还原 · MM-DD HH:mm」，按钮变「再还原一次」
2. 其余两条仍是「未还原」
3. 画布旗标变 `🎨 3 张稿 · 1 已还原`
4. 聊天区收到的 prompt 里：标题含 `【空态】`、只出现空态那条链接、含「本页还有其他状态的设计稿：默认态、导出中」

- [ ] **Step 4: 验 `restoredAt` 存废规则**

1. 把「空态」那条删掉再重新添加同一链接 → 应为「未还原」（新条目，新 id）
2. 手工验证「只改 label 保状态」需要改 url 的入口，当前 UI 未提供编辑——**这是已知的 UI 缺口**，规则本身已由 `mergeFigmas` 单测覆盖，不阻塞验收

- [ ] **Step 5: 验旧数据兼容**

找一个**改造前**就挂过设计稿的旧需求（或手工把某个 `map-v*.json` 的某页改回 `"figma": {"url":"..."}` + `"restoredAt": "..."` 结构），打开其地图：

1. 该页显示一条稿，状态名为空，还原时间保留
2. 点「再还原一次」能正常触发（证明 `fg-legacy` 这个确定性 id 在两次读盘之间稳定）

- [ ] **Step 6: 收尾**

改动留工作区，不提交。向维护者汇报验收结果。

---

## 已知缺口（本次不做）

- **无法编辑已有条目的 url / label** —— 只能删了重加。`mergeFigmas` 已支持「带 id 改 url/label」，补 UI 即可，留待需要时再加。
- 设计稿排序 / 拖拽、Figma 缩略图预览 —— 见 spec 的「非目标」。

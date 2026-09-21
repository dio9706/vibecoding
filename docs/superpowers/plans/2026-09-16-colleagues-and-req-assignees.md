# 同事名册 + 需求开发人员指派 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> ⚠️ **本项目禁止自动 git 提交**（见根 `CLAUDE.md`「协作约定」）。本计划刻意**不含任何 `git commit` 步骤**，每个 Task 以「跑测试 / 人工验收」收口，改动一律留在工作区，提交时机由维护者掌控。

**Goal:** 设置页新增「同事设置」tab 维护按职位分组的人员名册（姓名 / 备注 / 飞书 open_id），并让需求工作流在评审期与开发期都能指派开发人员。

**Architecture:** 名册落独立 `colleagues.json`（不混进含密钥的 `settings.json`），store 层用扁平数组 + `role` 字段，分组只在渲染时做。HTTP 走单入口子路由范式。需求侧只存同事 id 数组，姓名由 `/api/req/get` 服务端 join 回填，避免前端二次请求。开发期的编辑入口用弹窗而非常驻控件，绕开右栏 3s 轮询整栏重画。

**Tech Stack:** Node ≥20 原生（`node:http` / `node --test`）、原生 ESM、无框架前端（原生 DOM）、`src/store/index.js` 的文件锁 + 原子写。

**Spec:** `docs/superpowers/specs/2026-09-16-colleagues-and-req-assignees-design.md`

---

## 文件结构

### 新建

| 文件 | 职责 |
|---|---|
| `src/store/colleagues.js` | 名册持久化唯一入口 + 职位枚举 + 输入校验纯函数 |
| `src/store/colleagues.test.js` | store 层单测 |
| `src/entrypoints/web/routes-colleagues.js` | 名册 HTTP 单入口 |
| `src/entrypoints/web/routes-colleagues.test.js` | 路由层单测（真起 http server） |
| `public/js/colleagues-panel.js` | 设置页「同事设置」面板（副作用模块） |
| `public/js/req-assignee-dialog.js` | 选人弹窗，评审期与开发期共用 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/store/requirements.js` | `createRequirement` 初始对象加 `assignees: []` |
| `src/entrypoints/web/server.js` | import + ROUTES 表加一行 |
| `src/entrypoints/web/routes-requirements.js` | `handleGet` 回填 `assigneeList`；新增 `handleAssignees` + 分发一行 |
| `src/entrypoints/web/routes-requirements.test.js` | 追加 assignees 用例 |
| `public/index.html` | tab 按钮 + `.set-tab` 骨架 |
| `public/app.js` | import 新面板模块 |
| `public/app.css` | 弹窗与名册行的少量样式 |
| `public/js/icons.js` | 新增 `TEAM_ICON_SVG` |
| `public/js/req-view.js` | `makeAssigneeSlot` + 挂进 `renderConfigCard` |
| `public/js/req-chat.js` | `renderReqMgmtSection` 加一个 `rq-railbtn` |
| `docs/ARCHITECTURE.md` / `src/store/CLAUDE.md` / `src/entrypoints/CLAUDE.md` | 清单登记 |

---

## Task 1：store 层 —— 同事名册

**Files:**
- Create: `src/store/colleagues.js`
- Test: `src/store/colleagues.test.js`

- [ ] **Step 1: 先写失败的测试**

创建 `src/store/colleagues.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录：store/index.js 按 APP_DATA_DIR 定位，须在 import store 之前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'colleagues-store-'));
const {
  ROLES,
  normalizeColleagues,
  validateColleagueInput,
  getColleagues,
  getColleague,
  getColleaguesByRole,
  addColleague,
  updateColleague,
  removeColleague,
} = await import('./colleagues.js');

test('ROLES：5 个固定职位，id 唯一', () => {
  assert.equal(ROLES.length, 5);
  assert.deepEqual(
    ROLES.map((r) => r.id),
    ['ops', 'frontend', 'backend', 'design', 'product'],
  );
  assert.equal(new Set(ROLES.map((r) => r.id)).size, 5);
});

test('normalizeColleagues：非数组归空；缺字段补空串', () => {
  assert.deepEqual(normalizeColleagues(null), []);
  assert.deepEqual(normalizeColleagues({}), []);
  const out = normalizeColleagues([{ id: 'cl_x' }]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { id: 'cl_x', role: '', name: '', note: '', feishuOpenId: '', updatedAt: '' });
});

test('normalizeColleagues：无 id 的条目补发 id，而不是丢弃', () => {
  const out = normalizeColleagues([{ name: '手改进来的' }]);
  assert.equal(out.length, 1, '不该丢弃：丢了用户连它曾经存在都看不见');
  assert.match(out[0].id, /^cl_/);
  assert.equal(out[0].name, '手改进来的');
});

test('normalizeColleagues：非法 role 原样保留，不静默改写', () => {
  const out = normalizeColleagues([{ id: 'cl_y', role: 'qa', name: '张三' }]);
  assert.equal(out[0].role, 'qa', '归一到合法值 = 静默改数据，UI 靠「未知职位」兜底分组显示');
});

test('validateColleagueInput：姓名必填', () => {
  assert.match(validateColleagueInput({ role: 'frontend', name: '   ' }).error, /姓名/);
  assert.match(validateColleagueInput({ role: 'frontend' }).error, /姓名/);
});

test('validateColleagueInput：role 必须在枚举内', () => {
  assert.match(validateColleagueInput({ role: 'qa', name: '张三' }).error, /未知职位/);
  assert.match(validateColleagueInput({ name: '张三' }).error, /未知职位/);
  assert.equal(validateColleagueInput({ role: 'frontend', name: '张三' }).error, undefined);
});

test('validateColleagueInput：open_id 可空；非空必须 ou_ 前缀', () => {
  assert.equal(validateColleagueInput({ role: 'ops', name: '李四' }).value.feishuOpenId, '');
  assert.match(validateColleagueInput({ role: 'ops', name: '李四', feishuOpenId: 'abc' }).error, /ou_/);
  assert.equal(
    validateColleagueInput({ role: 'ops', name: '李四', feishuOpenId: 'ou_123' }).value.feishuOpenId,
    'ou_123',
  );
});

test('validateColleagueInput：姓名 40 字 / 备注 100 字截断', () => {
  const v = validateColleagueInput({ role: 'ops', name: 'a'.repeat(60), note: 'b'.repeat(200) });
  assert.equal(v.value.name.length, 40);
  assert.equal(v.value.note.length, 100);
});

test('addColleague → getColleague / getColleaguesByRole 回读', () => {
  const c = addColleague({ role: 'frontend', name: '王五', note: '活动页', feishuOpenId: 'ou_w5' });
  assert.match(c.id, /^cl_/);
  assert.equal(c.role, 'frontend');
  assert.ok(c.updatedAt);
  assert.equal(getColleague(c.id).name, '王五');
  assert.ok(getColleaguesByRole('frontend').some((x) => x.id === c.id));
  assert.deepEqual(getColleaguesByRole('qa'), [], '非法 roleId 返回空数组而非抛错');
  assert.ok(getColleagues().some((x) => x.id === c.id));
});

test('addColleague：非法 role 抛错（挡住非 HTTP 调用方写脏数据）', () => {
  assert.throws(() => addColleague({ role: 'qa', name: '赵六' }), /未知职位/);
});

test('updateColleague：局部更新；未知 id 返回 null', () => {
  const c = addColleague({ role: 'backend', name: '钱七' });
  const u = updateColleague(c.id, { role: 'backend', name: '钱七七', note: '改了备注' });
  assert.equal(u.name, '钱七七');
  assert.equal(u.note, '改了备注');
  assert.equal(u.id, c.id, 'id 不可被 patch 覆盖');
  assert.equal(updateColleague('cl_none', { role: 'ops', name: 'X' }), null);
});

test('removeColleague：删除返回 true；未知 id 返回 false', () => {
  const c = addColleague({ role: 'design', name: '孙八' });
  assert.equal(removeColleague(c.id), true);
  assert.equal(getColleague(c.id), null);
  assert.equal(removeColleague('cl_none'), false);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test src/store/colleagues.test.js
```

预期：`Cannot find module './colleagues.js'`。

- [ ] **Step 3: 实现 `src/store/colleagues.js`**

```js
/**
 * 同事名册持久化（colleagues.json）—— 按职位维护人员：姓名 / 备注 / 飞书 open_id。
 *
 * 为什么独立于 settings.json：后者含明文密钥、已 gitignore，且整份参与配置导入导出；
 * 名册是可分享的组织数据，混进去等于让「导出一份同事清单」顺手带走密钥。
 *
 * 为什么是扁平数组 + role 字段而不是按职位嵌套的 map：增删改一个人就是一次 map/filter，
 * 不必先定位分组；职位 label 改名不触发数据迁移；分组只是渲染形态，不该被 store 固化。
 *
 * 消费方：设置页「同事设置」tab、需求工作流的开发人员指派，以及后续「智能体主动询问同事」。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'colleagues.json';

/** 职位枚举：id 稳定（落盘值 + 后续按职位路由的契约），label 可随时改而不动数据 */
export const ROLES = [
  { id: 'ops', label: '运营' },
  { id: 'frontend', label: '前端' },
  { id: 'backend', label: '后端' },
  { id: 'design', label: 'UI设计' },
  { id: 'product', label: '产品' },
];

const ROLE_IDS = new Set(ROLES.map((r) => r.id));

function genId() {
  return 'cl_' + Math.random().toString(36).slice(2, 8);
}

/**
 * 形状归一（纯函数）。两条刻意的「不」：
 *
 * 1. **不改非法 role**：归一到第一个合法值是静默改数据，丢弃条目是静默丢数据，
 *    两者都会让用户以为「我填的人没了」。保留原值，由 UI 的「未知职位」兜底分组
 *    显示出来——用户看得见才能自己修。
 * 2. **无 id 的条目补发 id 而非丢弃**（同 settings.js:ensureMcpServerIds）：没有 id
 *    的条目在 UI 上既编辑不了也删不掉，丢弃则用户连它曾经存在都看不见。
 */
export function normalizeColleagues(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
    .map((c) => ({
      id: typeof c.id === 'string' && c.id ? c.id : genId(),
      role: typeof c.role === 'string' ? c.role : '',
      name: typeof c.name === 'string' ? c.name : '',
      note: typeof c.note === 'string' ? c.note : '',
      feishuOpenId: typeof c.feishuOpenId === 'string' ? c.feishuOpenId : '',
      updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : '',
    }));
}

/**
 * 输入校验（纯函数）—— 名册数据不变式的**唯一实现**。
 * HTTP 层调它拿 400 文案；add/update 也调它并抛错，挡住非 HTTP 调用方（插件 / 脚本）写脏数据。
 * 两处共用同一实现，规则不会各写一份然后跑偏。
 */
export function validateColleagueInput(input) {
  const o = input && typeof input === 'object' ? input : {};
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) return { error: '姓名不能为空' };
  const role = typeof o.role === 'string' ? o.role.trim() : '';
  if (!ROLE_IDS.has(role)) return { error: `未知职位：${role || '(空)'}` };
  const note = typeof o.note === 'string' ? o.note.trim() : '';
  const feishuOpenId = typeof o.feishuOpenId === 'string' ? o.feishuOpenId.trim() : '';
  // 允许留空：先把人记下、之后再补 id 是常见节奏。非空则必须是 open_id——
  // 填成 user_id 的话后续发消息只会静默失败，用户根本不知道是这里填错了。
  if (feishuOpenId && !feishuOpenId.startsWith('ou_')) {
    return { error: '飞书 open_id 必须以 ou_ 开头' };
  }
  return { value: { role, name: name.slice(0, 40), note: note.slice(0, 100), feishuOpenId } };
}

export function getColleagues() {
  return normalizeColleagues(readJson(FILE, []));
}

export function getColleague(id) {
  return getColleagues().find((c) => c.id === id) || null;
}

/** 按职位筛；严格匹配，非法 roleId 返回空数组 */
export function getColleaguesByRole(role) {
  return getColleagues().filter((c) => c.role === role);
}

/** 锁内读-改-写整份名册：fn(list) 就地修改；fn 显式返回 false 则放弃写盘 */
function updateColleagues(fn) {
  return updateJson(FILE, [], (raw) => {
    const list = normalizeColleagues(raw);
    if (fn(list) === false) return undefined;
    return list;
  });
}

export function addColleague(input) {
  const v = validateColleagueInput(input);
  if (v.error) throw new Error(v.error);
  let created = null;
  updateColleagues((list) => {
    created = { id: genId(), ...v.value, updatedAt: new Date().toISOString() };
    list.push(created);
  });
  return created;
}

/** 局部更新；未知 id 不写盘并返回 null */
export function updateColleague(id, input) {
  const v = validateColleagueInput(input);
  if (v.error) throw new Error(v.error);
  let updated = null;
  updateColleagues((list) => {
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) return false;
    list[i] = { ...list[i], ...v.value, id, updatedAt: new Date().toISOString() };
    updated = list[i];
  });
  return updated;
}

/** @returns {boolean} 是否真的删掉了（供路由区分 200 / 404） */
export function removeColleague(id) {
  let removed = false;
  updateColleagues((list) => {
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    removed = true;
  });
  return removed;
}
```

- [ ] **Step 4: 跑测试，确认全绿**

```bash
node --test src/store/colleagues.test.js
```

预期：`pass 12` / `fail 0`。

---

## Task 2：HTTP 层 —— 名册路由

**Files:**
- Create: `src/entrypoints/web/routes-colleagues.js`
- Test: `src/entrypoints/web/routes-colleagues.test.js`
- Modify: `src/entrypoints/web/server.js`

- [ ] **Step 1: 先写失败的测试**

创建 `src/entrypoints/web/routes-colleagues.test.js`：

```js
/**
 * routes-colleagues 单测 —— 真实 HTTP server + fetch 联调，验证状态码与校验分支。
 * 只挂 handleColleagueRoutes（不经完整 server.js），避免拉起飞书/token 等无关依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';

// 隔离数据目录：本模块间接 import store/colleagues.js（读盘），须在 import 前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'colleagues-routes-'));

const { handleColleagueRoutes } = await import('./routes-colleagues.js');

function startServer() {
  const server = createServer((req, res) => {
    handleColleagueRoutes(req, res, new URL(req.url, 'http://x'));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let server;
let base;
test.before(async () => {
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(pathname, method, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(base + pathname, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test('GET /api/colleagues：回 roles + colleagues', async () => {
  const r = await call('/api/colleagues', 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.json.roles.length, 5);
  assert.ok(Array.isArray(r.json.colleagues));
});

test('POST → PUT → DELETE 全链路', async () => {
  const c = await call('/api/colleagues', 'POST', {
    role: 'frontend', name: '张三', note: '活动页', feishuOpenId: 'ou_zs',
  });
  assert.equal(c.status, 201);
  const id = c.json.colleague.id;

  const u = await call('/api/colleagues/' + id, 'PUT', { role: 'backend', name: '张三丰' });
  assert.equal(u.status, 200);
  assert.equal(u.json.colleague.name, '张三丰');
  assert.equal(u.json.colleague.role, 'backend');

  const list = await call('/api/colleagues', 'GET');
  assert.ok(list.json.colleagues.some((x) => x.id === id && x.name === '张三丰'));

  const d = await call('/api/colleagues/' + id, 'DELETE');
  assert.equal(d.status, 200);
  const after = await call('/api/colleagues', 'GET');
  assert.ok(!after.json.colleagues.some((x) => x.id === id));
});

test('POST 拒绝：空姓名 400', async () => {
  const r = await call('/api/colleagues', 'POST', { role: 'ops', name: '  ' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /姓名/);
});

test('POST 拒绝：非法 role 400', async () => {
  const r = await call('/api/colleagues', 'POST', { role: 'qa', name: '张三' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /未知职位/);
});

test('POST 拒绝：open_id 前缀不合法 400', async () => {
  const r = await call('/api/colleagues', 'POST', { role: 'ops', name: '张三', feishuOpenId: 'u_123' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /ou_/);
});

test('未知 id 的 PUT / DELETE 回 404', async () => {
  const u = await call('/api/colleagues/cl_none', 'PUT', { role: 'ops', name: 'X' });
  assert.equal(u.status, 404);
  const d = await call('/api/colleagues/cl_none', 'DELETE');
  assert.equal(d.status, 404);
});

test('畸形 id（%）回 400 而不是让进程崩', async () => {
  const r = await call('/api/colleagues/%', 'DELETE');
  assert.equal(r.status, 400);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test src/entrypoints/web/routes-colleagues.test.js
```

预期：`Cannot find module './routes-colleagues.js'`。

- [ ] **Step 3: 实现 `src/entrypoints/web/routes-colleagues.js`**

```js
/**
 * 同事名册 HTTP 接口。沿用本项目单入口子路由范式（对齐 routes-memory.js）。
 * 单条 prefix 同时覆盖 /api/colleagues 与 /api/colleagues/:id，不必在 ROUTES 表登记两行，
 * 也就不存在前缀遮蔽精确路由的问题。
 */
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { safeDecodeId } from './input.js';
import { logger } from '../../shared/logger.js';
import {
  ROLES,
  getColleagues,
  addColleague,
  updateColleague,
  removeColleague,
  validateColleagueInput,
} from '../../store/colleagues.js';

// ==== GET /api/colleagues ====
function handleList(res) {
  sendJson(res, 200, { roles: ROLES, colleagues: getColleagues() });
}

// ==== POST /api/colleagues {role,name,note,feishuOpenId} ====
function handleCreate(req, res) {
  return withJsonBody(req, res, (data) => {
    const v = validateColleagueInput(data);
    if (v.error) return sendJson(res, 400, { error: v.error });
    const colleague = addColleague(v.value);
    logger.info('web', '[POST /api/colleagues] 新增同事', { id: colleague.id, role: colleague.role });
    sendJson(res, 201, { colleague });
  });
}

// ==== PUT /api/colleagues/:id ====
function handleUpdate(req, res, id) {
  return withJsonBody(req, res, (data) => {
    const v = validateColleagueInput(data);
    if (v.error) return sendJson(res, 400, { error: v.error });
    const colleague = updateColleague(id, v.value);
    if (!colleague) return sendJson(res, 404, { error: '同事不存在' });
    sendJson(res, 200, { colleague });
  });
}

// ==== DELETE /api/colleagues/:id ====
function handleDelete(res, id) {
  if (!removeColleague(id)) return sendJson(res, 404, { error: '同事不存在' });
  logger.info('web', '[DELETE /api/colleagues] 删除同事', { id });
  sendJson(res, 200, { ok: true });
}

/** 同事名册路由单入口：按 pathname + method 分发 */
export function handleColleagueRoutes(req, res, url) {
  const { pathname } = url;
  const { method } = req;
  if (pathname === '/api/colleagues' && method === 'GET') return handleList(res);
  if (pathname === '/api/colleagues' && method === 'POST') return handleCreate(req, res);
  if (pathname.startsWith('/api/colleagues/')) {
    // safeDecodeId 而非裸 decodeURIComponent：`DELETE /api/colleagues/%` 会抛 URIError，
    // 抛在 request 监听器主体里 → uncaughtException → 进程退出（见 input.js 注释）
    const id = safeDecodeId(pathname.slice('/api/colleagues/'.length));
    if (!id) return sendJson(res, 400, { error: '无效的 id' });
    if (method === 'PUT') return handleUpdate(req, res, id);
    if (method === 'DELETE') return handleDelete(res, id);
  }
  return sendJson(res, 404, { error: 'not found' });
}
```

- [ ] **Step 4: 跑测试，确认全绿**

```bash
node --test src/entrypoints/web/routes-colleagues.test.js
```

预期：`pass 7` / `fail 0`。

- [ ] **Step 5: 接进 `server.js`**

在 import 区（紧挨 `import { handleMemoryRoutes } from './routes-memory.js';` 之后）加：

```js
import { handleColleagueRoutes } from './routes-colleagues.js';
```

在 ROUTES 表里，`{ prefix: '/api/memory/', ... }` 这一行之后加：

```js
  { prefix: '/api/colleagues', h: (req, res, url) => handleColleagueRoutes(req, res, url) },
```

- [ ] **Step 6: 起服务人工验收**

```bash
npm start
```

另开一个终端：

```bash
curl -s http://127.0.0.1:3000/api/colleagues
```

预期：`{"roles":[{"id":"ops","label":"运营"},...],"colleagues":[]}`。验完 `Ctrl+C` 停服务。

---

## Task 3：设置页骨架 —— tab 按钮 + 面板容器

**Files:**
- Modify: `public/index.html:326-333`（tab 按钮组）、`public/index.html:504` 之后（面板）

- [ ] **Step 1: 加 tab 按钮**

在 `#settingsTabs` 内，`<button data-tab="mcp">MCP 服务器</button>` 这一行**之后**插入：

```html
            <button data-tab="colleagues">同事设置</button>
```

- [ ] **Step 2: 加面板骨架**

在 `<div class="set-tab" data-tab="desktop" hidden></div>` 这一行**之前**插入：

```html
          <div class="set-tab" data-tab="colleagues" hidden>
            <div class="set-sec">
              <div class="set-sec-head">
                <span class="sec-label">同事</span>
                <span class="msg-hint">按职位维护成员，填了飞书 open_id 才能被智能体主动询问</span>
              </div>
            </div>
            <div id="colleagueGroups"></div>
            <!-- 编辑表单：新增与编辑共用，默认收起 -->
            <div class="set-sec" id="colleagueFormSec" hidden>
              <div class="set-sec-head">
                <span class="sec-label" id="colleagueFormTitle">新增同事</span>
              </div>
              <label class="set-field">姓名
                <input id="colleagueName" placeholder="如 张三" autocomplete="off" />
              </label>
              <label class="set-field">职位
                <select id="colleagueRole" class="set-select"></select>
              </label>
              <label class="set-field">备注
                <input id="colleagueNote" placeholder="如 负责活动页" autocomplete="off" />
              </label>
              <label class="set-field">飞书 open_id
                <input id="colleagueOpenId" placeholder="ou_xxxxxxxx（可留空，之后再补）" autocomplete="off" />
              </label>
              <div class="set-actions" style="justify-content:flex-start;">
                <button class="btn primary" id="colleagueSaveBtn">保存</button>
                <button class="btn" id="colleagueCancelBtn">取消</button>
              </div>
            </div>
          </div>
```

- [ ] **Step 3: 校验 HTML 未破坏结构**

```bash
node -e "const s=require('fs').readFileSync('public/index.html','utf8');const o=(s.match(/<div/g)||[]).length,c=(s.match(/<\/div>/g)||[]).length;console.log('div open',o,'close',c);if(o!==c)process.exit(1)"
```

预期：两个数字相等，退出码 0。

---

## Task 4：设置页面板逻辑

**Files:**
- Create: `public/js/colleagues-panel.js`
- Modify: `public/app.js:12` 附近

- [ ] **Step 1: 实现 `public/js/colleagues-panel.js`**

```js
/** 同事名册面板：按职位分组列出成员 / 新增 / 编辑 / 删除。
 *  副作用模块：自绑「同事设置」tab 与表单按钮的入口绑定（范式对齐 bots-panel.js）。 */
import { $ } from './util.js';
import { toast, confirmDialog } from './ui.js';
import { iconHtml, DELETE_ICON_SVG, EDIT_ICON_SVG } from './icons.js';
import { getJson, postJson, putJson, delJson } from './api.js';

let editingId = null; // 非空 = 编辑既有同事
let roles = []; // [{id,label}]，由 GET /api/colleagues 返回

async function loadColleagues() {
  try {
    const { data } = await getJson('/api/colleagues');
    roles = data?.roles || [];
    return data?.colleagues || [];
  } catch {
    toast('网络错误，无法加载同事名册');
    return [];
  }
}

/** 按职位分组。名册里出现的未知职位归到末尾「未知职位」组——
 *  静默隐藏会让用户以为数据丢了，显示出来他才能自己改。 */
function groupByRole(colleagues) {
  const known = new Set(roles.map((r) => r.id));
  const groups = roles.map((r) => ({ id: r.id, label: r.label, items: colleagues.filter((c) => c.role === r.id) }));
  const unknown = colleagues.filter((c) => !known.has(c.role));
  if (unknown.length) groups.push({ id: '', label: '未知职位', items: unknown });
  return groups;
}

export async function renderColleagues() {
  const colleagues = await loadColleagues();
  const box = $('#colleagueGroups');
  box.innerHTML = '';
  for (const g of groupByRole(colleagues)) {
    const sec = document.createElement('div');
    sec.className = 'set-sec';

    const head = document.createElement('div');
    head.className = 'set-sec-head';
    const label = document.createElement('span');
    label.className = 'sec-label';
    label.textContent = `${g.label}（${g.items.length}）`;
    head.appendChild(label);
    // 未知职位组不给「＋」：新增必须落到合法职位上
    if (g.id) {
      const add = document.createElement('button');
      add.className = 'btn';
      add.textContent = '＋ 新增';
      add.addEventListener('click', () => openForm(null, g.id));
      head.appendChild(add);
    }
    sec.appendChild(head);

    const list = document.createElement('div');
    list.className = 'token-list';
    if (!g.items.length) {
      const empty = document.createElement('div');
      empty.className = 'cred-empty';
      empty.textContent = '暂无成员';
      list.appendChild(empty);
    }
    for (const c of g.items) {
      list.appendChild(makeRow(c));
    }
    sec.appendChild(list);
    box.appendChild(sec);
  }
}

function makeRow(c) {
  const row = document.createElement('div');
  row.className = 'token-row';
  row.dataset.id = c.id;
  row.innerHTML =
    '<span class="t-label"></span>' +
    '<span class="t-vendor"></span>' +
    '<span class="t-base"></span>' +
    '<span class="spacer"></span>' +
    '<button class="t-act edit" title="编辑">' + iconHtml(EDIT_ICON_SVG) + '</button>' +
    '<button class="t-act del" title="删除">' + iconHtml(DELETE_ICON_SVG) + '</button>';
  // 姓名/备注是用户输入，一律 textContent 赋值，不拼进上面的 innerHTML
  row.querySelector('.t-label').textContent = c.name || '(未命名)';
  row.querySelector('.t-vendor').textContent = c.note || '';
  const idCell = row.querySelector('.t-base');
  idCell.textContent = c.feishuOpenId || '(未填飞书 ID)';
  idCell.title = c.feishuOpenId || '未填飞书 open_id，智能体无法主动询问该同事';
  row.querySelector('.edit').onclick = () => openForm(c, c.role);
  row.querySelector('.del').onclick = () => removeColleague(c);
  return row;
}

function openForm(colleague, roleId) {
  editingId = colleague ? colleague.id : null;
  $('#colleagueFormSec').hidden = false;
  $('#colleagueFormTitle').textContent = colleague ? `编辑「${colleague.name || '(未命名)'}」` : '新增同事';

  const sel = $('#colleagueRole');
  sel.innerHTML = '';
  for (const r of roles) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.label;
    sel.appendChild(opt);
  }
  sel.value = roleId || roles[0]?.id || '';

  $('#colleagueName').value = colleague?.name || '';
  $('#colleagueNote').value = colleague?.note || '';
  $('#colleagueOpenId').value = colleague?.feishuOpenId || '';
  $('#colleagueName').focus();
}

function closeForm() {
  editingId = null;
  $('#colleagueFormSec').hidden = true;
}

async function saveColleague() {
  const payload = {
    name: $('#colleagueName').value.trim(),
    role: $('#colleagueRole').value,
    note: $('#colleagueNote').value.trim(),
    feishuOpenId: $('#colleagueOpenId').value.trim(),
  };
  try {
    const url = editingId ? '/api/colleagues/' + encodeURIComponent(editingId) : '/api/colleagues';
    const { ok, data } = editingId ? await putJson(url, payload) : await postJson(url, payload);
    if (!ok) return toast(data?.error || '保存失败');
    toast('已保存');
    closeForm();
    await renderColleagues();
  } catch {
    toast('网络错误');
  }
}

async function removeColleague(c) {
  const ok = await confirmDialog({
    title: '删除同事',
    message: `确认删除「${c.name || '(未命名)'}」？已指派给他的需求会显示为「已移除的同事」。`,
    danger: true,
  });
  if (!ok) return;
  try {
    const { ok: httpOk, data } = await delJson('/api/colleagues/' + encodeURIComponent(c.id));
    if (!httpOk) return toast(data?.error || '删除失败');
    if (editingId === c.id) closeForm();
    toast('已删除');
    await renderColleagues();
  } catch {
    toast('网络错误');
  }
}

$('#colleagueSaveBtn')?.addEventListener('click', saveColleague);
$('#colleagueCancelBtn')?.addEventListener('click', closeForm);

// 同事设置 tab 点击时加载名册（显式取元素，避免 id 隐式全局）
const colleagueTabBtn = [...$('#settingsTabs').querySelectorAll('button')].find((b) => b.dataset.tab === 'colleagues');
if (colleagueTabBtn) colleagueTabBtn.addEventListener('click', () => renderColleagues());
```

- [ ] **Step 2: 在 `public/app.js` 注册**

在 `import './js/bots-panel.js'; // 副作用：机器人面板自绑定（托管配置 tab）` 这一行**之后**加：

```js
import './js/colleagues-panel.js'; // 副作用：同事名册面板自绑定（同事设置 tab）
```

- [ ] **Step 3: 语法自检（前端模块没有单测，靠 node --check 挡语法错）**

```bash
node --check public/js/colleagues-panel.js && node --check public/app.js && echo OK
```

预期：输出 `OK`。

> 为什么这步不能省：本项目有过「前端 import 图里一个语法错 → 卡在启动页、窗口按钮全消失」的事故，`node --check` 是最快的定位手段。

- [ ] **Step 4: 人工验收**

```bash
npm start
```

浏览器开 `http://127.0.0.1:3000` → 设置 → 同事设置。逐项确认：

1. 看到 5 个职位分组，每组显示「（0）」和「＋ 新增」；
2. 在「前端」组点「＋ 新增」→ 职位下拉已预选「前端」；
3. 填姓名「张三」、open_id 填 `abc` → 保存 → toast 报「飞书 open_id 必须以 ou_ 开头」；
4. 改成 `ou_test` → 保存 → 「前端（1）」出现一行「张三」；
5. 编辑改名 → 列表跟着变；删除 → 弹确认框 → 确认后行消失。

---

## Task 5：需求侧 —— `assignees` 字段与 `PUT /api/req/assignees`

**Files:**
- Modify: `src/store/requirements.js:32` 附近
- Modify: `src/entrypoints/web/routes-requirements.js`
- Test: `src/entrypoints/web/routes-requirements.test.js`（追加）

- [ ] **Step 1: 先写失败的测试**

在 `src/entrypoints/web/routes-requirements.test.js` **文件末尾**追加：

```js
// ==== 开发人员指派 ====

const { addColleague } = await import('../../store/colleagues.js');

test('PUT /api/req/assignees：review 期写入成功并回读；重复 id 去重', async () => {
  const c1 = addColleague({ role: 'frontend', name: '张三', feishuOpenId: 'ou_zs' });
  const c2 = addColleague({ role: 'backend', name: '李四' });
  const r = await createReq('指派测试A');

  const put1 = await put('/api/req/assignees', { id: r.id, assignees: [c1.id, c2.id, c1.id] });
  assert.equal(put1.status, 200);
  assert.deepEqual(put1.json.assignees, [c1.id, c2.id], '重复 id 必须去重');

  const got = await get('/api/req/get?id=' + r.id);
  assert.deepEqual(got.json.assignees, [c1.id, c2.id]);
});

test('GET /api/req/get：assigneeList 服务端 join 姓名/职位，缺失的标 missing', async () => {
  const c = addColleague({ role: 'design', name: '王五' });
  const r = await createReq('指派测试B');
  await put('/api/req/assignees', { id: r.id, assignees: [c.id] });
  updateRequirement(r.id, { assignees: [c.id, 'cl_gone'] }); // 绕过路由，模拟同事被删后的悬空引用

  const got = await get('/api/req/get?id=' + r.id);
  assert.equal(got.json.assigneeList.length, 2);
  assert.deepEqual(got.json.assigneeList[0], {
    id: c.id, name: '王五', role: 'design', roleLabel: 'UI设计', feishuOpenId: '', missing: false,
  });
  assert.equal(got.json.assigneeList[1].missing, true);
  assert.equal(got.json.assigneeList[1].name, '已移除的同事');
});

test('PUT /api/req/assignees：悬空 id 被拒 400', async () => {
  const r = await createReq('指派测试C');
  const res = await put('/api/req/assignees', { id: r.id, assignees: ['cl_nope'] });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /同事不存在/);
});

test('PUT /api/req/assignees：非数组 400；未知需求 404', async () => {
  const r = await createReq('指派测试D');
  assert.equal((await put('/api/req/assignees', { id: r.id, assignees: 'x' })).status, 400);
  assert.equal((await put('/api/req/assignees', { id: 'r_none', assignees: [] })).status, 404);
});

test('PUT /api/req/assignees：dev 期放行、test 期 409', async () => {
  const c = addColleague({ role: 'ops', name: '赵六' });
  const r = await createReq('指派测试E');

  updateRequirement(r.id, { phase: 'dev' });
  assert.equal((await put('/api/req/assignees', { id: r.id, assignees: [c.id] })).status, 200);

  updateRequirement(r.id, { phase: 'test' });
  const res = await put('/api/req/assignees', { id: r.id, assignees: [] });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /评审期与开发期/);
});

test('createRequirement：assignees 初始为空数组', async () => {
  const r = await createReq('指派测试F');
  assert.deepEqual(getRequirement(r.id).assignees, []);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test src/entrypoints/web/routes-requirements.test.js
```

预期：新增的 6 条全部 fail（`assignees` 路由 404、`assigneeList` undefined）。

- [ ] **Step 3: `src/store/requirements.js` 加字段**

在 `createRequirement` 的初始对象里，`projects: { frontend: null, backend: null },` 这一行**之后**插入：

```js
    assignees: [], // 开发人员：同事 id 数组（src/store/colleagues.js）。存 id 不存姓名快照，
    // 改名/换 open_id 自动同步；同事被删产生的悬空 id 由读侧标 missing，不回头清理历史需求
```

- [ ] **Step 4: `routes-requirements.js` 加 import**

在现有 store import 区加：

```js
import { ROLES, getColleague } from '../../store/colleagues.js';
```

- [ ] **Step 5: `handleGet` 回填 `assigneeList`**

在 `handleGet` 里，`const featureSnapshot = ...` 之后、`sendJson(...)` 之前插入：

```js
  // 开发人员 join：名册在另一个文件，前端两处（评审卡 / 开发右栏）都要显示姓名。
  // 在这里 join 一次，省掉前端「拿到需求再拉一次名册」的第二跳——
  // 开发期右栏每 3s 轮询一次本接口，多一跳就是多一倍请求（同 mapLatest 的理由）。
  const assigneeList = (r.assignees || []).map((cid) => {
    const c = getColleague(cid);
    if (!c) return { id: cid, name: '已移除的同事', role: '', roleLabel: '', feishuOpenId: '', missing: true };
    return {
      id: c.id,
      name: c.name,
      role: c.role,
      roleLabel: ROLES.find((x) => x.id === c.role)?.label || '',
      feishuOpenId: c.feishuOpenId,
      missing: false,
    };
  });
```

并在 `sendJson(res, 200, { ...r, devDocLatest,` 的对象里加一项：

```js
    assigneeList,
```

- [ ] **Step 6: 新增 `handleAssignees`**

在 `handleConfig` 函数**之后**插入：

```js
/**
 * PUT /api/req/assignees {id, assignees:[colleagueId]} —— 指派 / 修改开发人员。
 *
 * 刻意**不**并入 handleConfig：那条路由有「仅评审设计期可修改配置」的整体守卫，
 * 而开发人员在开发期也要能改。往 handleConfig 里加字段级豁免，会让那句守卫文案变成谎言——
 * 下一个读 handleConfig 的人必然误判「这里所有字段都只能评审期改」。
 */
function handleAssignees(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (r.phase !== 'review' && r.phase !== 'dev') {
      return sendJson(res, 409, { error: '仅评审期与开发期可修改开发人员' });
    }
    if (!Array.isArray(data.assignees)) return sendJson(res, 400, { error: 'assignees 必须是数组' });
    const ids = [...new Set(data.assignees.filter((x) => typeof x === 'string' && x))];
    // 存在性校验：允许写入悬空 id 等于让「已移除的同事」凭空长出来，
    // 而这里的悬空只该由「先指派、后删同事」产生
    for (const cid of ids) {
      if (!getColleague(cid)) return sendJson(res, 400, { error: `同事不存在：${cid}` });
    }
    const updated = updateRequirement(id, { assignees: ids }, '更新开发人员');
    sendJson(res, 200, { assignees: updated.assignees });
  });
}
```

- [ ] **Step 7: 登记分发**

在 `handleRequirementRoutes` 里，`if (pathname === '/api/req/config' && method === 'PUT') return handleConfig(req, res);` **之后**加：

```js
  if (pathname === '/api/req/assignees' && method === 'PUT') return handleAssignees(req, res);
```

- [ ] **Step 8: 跑测试，确认全绿**

```bash
node --test src/entrypoints/web/routes-requirements.test.js src/store/requirements.test.js
```

预期：`fail 0`，新增 6 条全 pass。

---

## Task 6：选人弹窗 + 图标 + 样式

**Files:**
- Modify: `public/js/icons.js`（末尾）
- Create: `public/js/req-assignee-dialog.js`
- Modify: `public/app.css`（末尾）

- [ ] **Step 1: `public/js/icons.js` 新增图标**

在最后一个 `export const *_ICON_SVG` 定义之后加：

```js
/** 团队 / 同事（双人）。用于需求的开发人员槽位与右栏入口。 */
export const TEAM_ICON_SVG =
  '<svg viewBox="0 0 1024 1024" width="1em" height="1em" fill="currentColor" aria-hidden="true">' +
  '<path d="M384 512a176 176 0 1 0 0-352 176 176 0 0 0 0 352zm0 64C233 576 64 651 64 800v64a32 32 0 0 0 32 32h576a32 32 0 0 0 32-32v-64c0-149-169-224-320-224z"/>' +
  '<path d="M736 288a144 144 0 1 1 0 288 144 144 0 0 1 0-288zm0 352c124 0 224 62 224 176v48a32 32 0 0 1-32 32H752v-96c0-66-29-122-76-160h60z"/>' +
  '</svg>';
```

- [ ] **Step 2: 实现 `public/js/req-assignee-dialog.js`**

```js
/**
 * 开发人员选人弹窗 —— 评审期「工程配置」卡与开发期右栏共用同一份实现。
 *
 * 为什么是弹窗而不是常驻多选控件：开发期右栏（req-chat.js renderRail）每 3s 轮询时
 * 整栏 innerHTML='' 重画，常驻控件的勾选态会被反复冲掉。该文件已经为测试期 bitable
 * 输入框写过一处草稿保护，不该再添同类特例——弹窗挂在 body 上，天然免疫重画。
 *
 * 依赖方向：req-assignee-dialog → api.js；不反向依赖 req-view / req-chat，由后者调用。
 */
import { getJson, putJson } from './api.js';

/**
 * @param {object} opts
 * @param {string} opts.reqId
 * @param {string[]} [opts.current] - 当前已指派的同事 id
 * @param {Function} [opts.onDone] - 保存成功后的回调（刷新页面 / 右栏）
 */
export async function openAssigneeDialog({ reqId, current = [], onDone }) {
  let roles = [];
  let colleagues = [];
  try {
    const { data } = await getJson('/api/colleagues');
    roles = data?.roles || [];
    colleagues = data?.colleagues || [];
  } catch {
    return window.toast.error('网络错误，无法加载同事名册');
  }

  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML =
    '<div class="modal rq-assignee-modal">' +
    '<div class="head"><h3>选择开发人员</h3></div>' +
    '<div class="body"><div class="rq-assignee-groups"></div></div>' +
    '<div class="confirm-foot">' +
    '<button class="btn cancel">取消</button>' +
    '<button class="btn primary ok">保存</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(mask);

  const groupsBox = mask.querySelector('.rq-assignee-groups');
  const picked = new Set(current);

  if (!colleagues.length) {
    const tip = document.createElement('div');
    tip.className = 'rq-assignee-empty';
    tip.textContent = '还没有同事，请先到 设置 → 同事设置 添加。';
    groupsBox.appendChild(tip);
  }

  // 按职位分组；名册里的未知职位归到末尾，不静默隐藏（与设置页同一处置）
  const known = new Set(roles.map((r) => r.id));
  const groups = roles.map((r) => ({ label: r.label, items: colleagues.filter((c) => c.role === r.id) }));
  const unknown = colleagues.filter((c) => !known.has(c.role));
  if (unknown.length) groups.push({ label: '未知职位', items: unknown });

  for (const g of groups) {
    if (!g.items.length) continue;
    const sec = document.createElement('div');
    sec.className = 'rq-assignee-group';
    const h = document.createElement('b');
    h.textContent = g.label;
    sec.appendChild(h);
    for (const c of g.items) {
      const row = document.createElement('label');
      row.className = 'rq-assignee-row';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'pretty-check';
      chk.checked = picked.has(c.id);
      chk.addEventListener('change', () => (chk.checked ? picked.add(c.id) : picked.delete(c.id)));
      const name = document.createElement('span');
      name.className = 'nm';
      name.textContent = c.name || '(未命名)';
      const note = document.createElement('span');
      note.className = 'nt';
      // 没填 open_id 的人指派了也收不到智能体提问，这里先标出来，别等到发消息时静默失败
      note.textContent = c.feishuOpenId ? c.note || '' : '未填飞书 ID';
      row.append(chk, name, note);
      sec.appendChild(row);
    }
    groupsBox.appendChild(sec);
  }

  const close = () => mask.remove();
  mask.querySelector('.cancel').addEventListener('click', close);
  mask.addEventListener('click', (ev) => {
    if (ev.target === mask) close();
  });

  const okBtn = mask.querySelector('.ok');
  okBtn.addEventListener('click', async () => {
    okBtn.disabled = true;
    try {
      const { ok, data } = await putJson('/api/req/assignees', { id: reqId, assignees: [...picked] });
      if (!ok) {
        okBtn.disabled = false;
        return window.toast.error(data?.error || '保存失败');
      }
      close();
      onDone?.();
    } catch {
      okBtn.disabled = false;
      window.toast.error('网络错误');
    }
  });
}
```

- [ ] **Step 3: `public/app.css` 末尾加样式**

```css
/* 开发人员选人弹窗（req-assignee-dialog.js） */
.rq-assignee-modal .body { max-height: 52vh; overflow-y: auto; }
.rq-assignee-group { margin-bottom: 12px; }
.rq-assignee-group > b { display: block; font-size: 12px; color: var(--faint); margin-bottom: 4px; }
.rq-assignee-row { display: flex; align-items: center; gap: 8px; padding: 5px 2px; cursor: pointer; }
.rq-assignee-row .nm { font-size: 13px; color: var(--text); }
.rq-assignee-row .nt { font-size: 11px; color: var(--faint); }
.rq-assignee-empty { opacity: .6; padding: 12px 4px; font-size: 13px; }
/* 开发人员槽位里的姓名 chip（req-view.js makeAssigneeSlot） */
.rqw-assignees { display: flex; flex-wrap: wrap; gap: 5px; }
.rqw-assignees .chip { font-size: 11px; padding: 1px 7px; border-radius: 10px; background: var(--chip-bg, rgba(127,127,127,.14)); }
.rqw-assignees .chip.missing { opacity: .55; text-decoration: line-through; }
```

- [ ] **Step 4: 语法自检**

```bash
node --check public/js/req-assignee-dialog.js && node --check public/js/icons.js && echo OK
```

预期：输出 `OK`。

---

## Task 7：评审期入口 —— 工程配置卡里的开发人员槽位

**Files:**
- Modify: `public/js/req-view.js`（import 区、`renderConfigCard`、`makeTagSlot` 之前）

- [ ] **Step 1: 补 import**

在 `req-view.js` 的 icons import 里加入 `TEAM_ICON_SVG`，并新增一行：

```js
import { openAssigneeDialog } from './req-assignee-dialog.js';
```

- [ ] **Step 2: 挂进 `renderConfigCard`**

在 `renderConfigCard` 里，`slots.appendChild(makeDocSlot(req));` 这一行**之后**加：

```js
  slots.appendChild(makeAssigneeSlot(req));
```

同时把该函数里的计数行改为把开发人员算进去 —— 找到：

```js
  hd.appendChild(e('span', 'cnt', `${dirs + (req.reqDoc ? 1 : 0)} / 3 已配置`));
```

替换为：

```js
  const configured = dirs + (req.reqDoc ? 1 : 0) + ((req.assignees || []).length ? 1 : 0);
  hd.appendChild(e('span', 'cnt', `${configured} / 4 已配置`));
```

- [ ] **Step 3: 新增 `makeAssigneeSlot`**

在 `function makeTagSlot(req) {` **之前**插入：

```js
/** 开发人员槽位：展示已指派的人，点击开选人弹窗。与工程 / 文档槽并列。 */
function makeAssigneeSlot(req) {
  const list = req.assigneeList || [];
  const slot = e('div', 'rqw-slot' + (list.length ? '' : ' blank'));

  const top = e('div', 'rqw-slot-top');
  top.appendChild(iconEl(TEAM_ICON_SVG, 'rqw-slot-ic'));
  top.appendChild(e('span', 'rqw-slot-k', '开发人员'));
  // 可留空是刻意的：还没定人就不该拿一个红叉挡住生成开发文档
  if (!list.length) top.appendChild(e('span', 'rqw-slot-opt', '可留空'));
  top.appendChild(e('span', 'gap'));
  slot.appendChild(top);

  const row = e('div', 'rqw-slot-row');
  if (list.length) {
    const chips = e('div', 'rqw-assignees');
    for (const a of list) {
      const chip = e('span', 'chip' + (a.missing ? ' missing' : ''), a.roleLabel ? `${a.name}·${a.roleLabel}` : a.name);
      if (a.missing) chip.title = '该同事已从名册中移除，点「修改」可重新指派';
      else if (!a.feishuOpenId) chip.title = '未填飞书 open_id，智能体无法主动询问他';
      chips.appendChild(chip);
    }
    row.appendChild(chips);
  }
  const btn = e('button', 'rqw-btn sm', list.length ? '修改' : '选择开发人员');
  btn.type = 'button';
  btn.onclick = () =>
    openAssigneeDialog({
      reqId: req.id,
      current: (req.assignees || []).slice(),
      onDone: () => loadAndRenderReq(req.id),
    });
  row.appendChild(btn);
  slot.appendChild(row);

  const ft = e('div', 'rqw-slot-ft');
  ft.appendChild(e('span', null, '指派后可由智能体主动向他们提问；开发期仍可修改'));
  slot.appendChild(ft);
  return slot;
}
```

- [ ] **Step 4: 语法自检**

```bash
node --check public/js/req-view.js && echo OK
```

预期：输出 `OK`。

- [ ] **Step 5: 人工验收**

```bash
npm start
```

浏览器 → 需求 → 新建一个需求（评审期）。确认：

1. 「工程配置」卡里出现第 4 个槽位「开发人员」，标「可留空」，计数显示 `x / 4 已配置`；
2. 点「选择开发人员」→ 弹窗按职位分组列出 Task 4 里加的同事；
3. 勾 2 人 → 保存 → 槽位出现 2 个 chip（`张三·前端`），按钮变「修改」；
4. 到 设置 → 同事设置 删掉其中 1 人 → 回需求页刷新 → 该 chip 变灰带删除线、文案「已移除的同事」。

---

## Task 8：开发期入口 —— 右栏「需求管理」区按钮

**Files:**
- Modify: `public/js/req-chat.js`（import 区、`renderReqMgmtSection`）

- [ ] **Step 1: 补 import**

在 `req-chat.js` 的 icons import 里加入 `TEAM_ICON_SVG`，并新增一行：

```js
import { openAssigneeDialog } from './req-assignee-dialog.js';
```

- [ ] **Step 2: 在 `renderReqMgmtSection` 加按钮**

在该函数里，`mk(CHANGE_ICON_SVG, '需求变动', ...)` 这一段**之后**插入：

```js
  // 开发人员：副标题直接显示当前指派人，不点开也能一眼看到这需求归谁
  const assignees = data.assigneeList || [];
  const assigneeSub = assignees.length
    ? assignees.map((a) => (a.roleLabel ? `${a.name}·${a.roleLabel}` : a.name)).join('、')
    : '未指派，点击选择';
  mk(TEAM_ICON_SVG, '开发人员', assigneeSub, () =>
    openAssigneeDialog({
      reqId: data.id,
      current: (data.assignees || []).slice(),
      onDone: () => refreshRail(data.id),
    }),
  );
```

- [ ] **Step 3: 语法自检**

```bash
node --check public/js/req-chat.js && echo OK
```

预期：输出 `OK`。

- [ ] **Step 4: 人工验收**

```bash
npm start
```

浏览器 → 打开一个处于**开发期**的需求（若没有，可在评审期完成配置后点「完成评审/定稿」推进，或直接改 `requirements.json` 里该条的 `phase` 为 `dev` 后刷新）。确认：

1. 右栏「需求管理」区第二个按钮是「开发人员」，副标题显示当前指派人（未指派时显示「未指派，点击选择」）；
2. 点开弹窗改选 → 保存 → 副标题立刻更新；
3. **停在该页静置 10 秒以上**（右栏轮询至少重画 3 次），副标题保持正确、不闪回旧值 —— 这一条是本 Task 的关键回归点。

---

## Task 9：文档登记与全量回归

**Files:**
- Modify: `src/store/CLAUDE.md`、`src/entrypoints/CLAUDE.md`、`docs/ARCHITECTURE.md`

- [ ] **Step 1: `src/store/CLAUDE.md` 登记**

在「### 业务领域 store」清单里加一行：

```markdown
- `colleagues.js` — 同事名册（`colleagues.json`）：按职位（`ROLES` 5 类枚举）维护人员的姓名 / 备注 / 飞书 open_id。独立于 `settings.json` 的理由见文件头注释（后者含明文密钥且参与配置导入导出）。校验规则收在 `validateColleagueInput` 一处，HTTP 层与 store 写入口共用。
```

在「## 常见改动入口」加一行：

```markdown
- **要改同事名册的职位枚举 / 校验规则** → `colleagues.js`（`ROLES` + `validateColleagueInput`）；注意非法 role 与无 id 条目在 `normalizeColleagues` 里是**保留并补齐**而非丢弃，改这条前先读该函数注释。
```

- [ ] **Step 2: `src/entrypoints/CLAUDE.md` 登记**

在「### web 入口：其它路由 handler」清单里加一行：

```markdown
- `web/routes-colleagues.js` — 同事名册 CRUD（单入口范式）。单条 prefix 覆盖 `/api/colleagues` 与 `/api/colleagues/:id`。
```

在「## 三、常见改动入口」加一行：

```markdown
- 要**改同事名册 HTTP 接口**就改 `web/routes-colleagues.js`；要改需求的开发人员指派就改 `web/routes-requirements.js` 的 `handleAssignees`（刻意独立于 `handleConfig`，理由见其注释）。
```

- [ ] **Step 3: `docs/ARCHITECTURE.md` 的 store 清单登记**

找到该文件里列 `src/store/` 各文件的表格/清单，加入 `colleagues.js` 一行，描述同 Step 1。

- [ ] **Step 4: 全量单测**

```bash
npm test
```

预期：全绿，`fail 0`。若有失败，**先看是不是本次改动引入的**——`handleGet` 响应多了一个 `assigneeList` 字段，任何断言「响应字段全集」的既有用例都会红，需要同步更新那条断言（而不是把 `assigneeList` 拿掉）。

- [ ] **Step 5: 前端全模块语法自检**

```bash
for f in public/app.js public/js/*.js; do node --check "$f" || echo "FAIL $f"; done; echo done
```

预期：只输出 `done`，无 `FAIL` 行。

- [ ] **Step 6: 端到端冒烟**

```bash
npm run test:e2e
```

预期：通过。若 e2e 里有需求相关的响应断言因 `assigneeList` 失败，同 Step 4 处置。

---

## 自检对照（计划 ↔ spec）

| spec 章节 | 落点 |
|---|---|
| 3.1 数据层（`ROLES` / 7 个导出 / 归一策略） | Task 1 |
| 3.2 HTTP 层（4 个端点 / 校验 / server 接线） | Task 2 |
| 3.3 前端（tab / 分组渲染 / 表单 / 零新增 CSS） | Task 3、Task 4 |
| 4.1 `assignees` 字段与悬空引用处置 | Task 5 Step 3、Step 5 |
| 4.2 `PUT /api/req/assignees` 与独立守卫 | Task 5 Step 6、Step 7 |
| 4.3 评审期槽位 | Task 7 |
| 4.3 开发期右栏按钮 + 轮询重画取舍 | Task 8（Step 4 第 3 条是该取舍的回归点） |
| 4.3 共用选人弹窗 | Task 6 |
| 五、测试 | Task 1 Step 1、Task 2 Step 1、Task 5 Step 1、Task 9 Step 4 |
| 六、分层合规自检 | Task 9 Step 1~3 |

**与 spec 的一处偏离**：spec 写 `removeColleague(id)` 返回剩余列表，本计划改为返回 `boolean`。原因是路由要靠它区分 200 / 404，返回列表还得再查一次。spec 对应行应同步更新。

Part 2 的 `assigneeList` 服务端 join 是 spec 未写明、实现时补上的决定：spec 只说「渲染兜底显示已移除」，但没定姓名从哪来。放服务端 join 的理由写在 Task 5 Step 5 的代码注释里（开发期右栏 3s 轮询，前端二次请求等于翻倍）。

# 机器人端日志面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **本项目规则：不自动 git 提交。** 每个 Task 末尾是「验收」步骤而非 commit，改动一律留工作区，提交时机由用户掌控。

**Goal:** 把「访问日志」面板从 web 控制台的 HTTP 访问记录，改为机器人端业务日志（动作执行 + 飞书对话），形如「机器人 1 为 申孟涛 执行了「获取小程序二维码」· 成功」。

**Architecture:** 新增独立落点 `bot-log.jsonl`（不复用 event-log，因其 MAX=1000 会被每请求一条的 access 洪流冲掉）。分三层：`store/jsonl.js` 提供共享的 JSONL 读取/压缩；`store/bot-log.js` 纯存储；`shared/bot-activity.js` 负责组装（查机器人名、解析用户姓名）。两处埋点调组装层，前端换数据源 + 重写文案。

**Tech Stack:** Node.js ESM、`node --test`、原生 http、无框架前端 ES module。飞书 contact API 走 `@larksuiteoapi/node-sdk` 的 generic request。

**Spec:** `docs/superpowers/specs/2026-08-26-bot-log-panel-design.md`

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/store/jsonl.js` | 创建 | JSONL 共享底座：`readJsonl` / `compactJsonl` / `withinRetention` |
| `src/store/jsonl.test.js` | 创建 | 上述三者的单测 |
| `src/store/event-log.js` | 修改 | 收敛到 `jsonl.js`（行为不变） |
| `src/store/action-log.js` | 修改 | 收敛到 `jsonl.js`（行为不变） |
| `src/store/action-log.test.js` | 创建 | 补读写往返测试（抽取安全网） |
| `src/store/bot-log.js` | 创建 | 机器人日志纯存储：`appendBotLog` / `getBotLogs` / `clearBotLogs` |
| `src/store/bot-log.test.js` | 创建 | 存储层单测 |
| `src/integrations/lark.js` | 修改 | 新增 `getUserName(id)`，缓存 + 负缓存 |
| `src/integrations/lark.username.test.js` | 创建 | FakeClient mock 单测 |
| `src/shared/bot-activity.js` | 创建 | 组装层：查 botName、解析 userName、截断 detail |
| `src/plugins/action-runner/feature/script-runner.js` | 修改 | 埋点 1：动作执行 |
| `src/entrypoints/feishu/index.js` | 修改 | 埋点 2：飞书对话 |
| `src/entrypoints/web/routes-ops.js` | 修改 | `handleBotLogs` / `handleBotLogsClear` |
| `src/entrypoints/web/server.js` | 修改 | 路由注册 + `ACCESS_LOG_SKIP` |
| `public/js/logs-panel.logic.js` | 创建 | 纯函数文案层（项目 `.logic.js` 约定，便于 node 测试） |
| `public/js/logs-panel.logic.test.js` | 创建 | 文案纯函数单测 |
| `public/js/logs-panel.js` | 修改 | 换数据源 + 用文案层，删死代码 |

**为何 `formatBotLogEntry` 单独放 `.logic.js`：** `logs-panel.js` 顶层 import 了 `./ui.js` 并操作 DOM，node 测试里 import 会炸。项目已有此约定（`optimize-fix.logic.js`、`req-map-layout.logic.js` 等 12 个 `.logic.js` + 配套 `.test.js`）。

---

## Task 1: 抽出 `src/store/jsonl.js`

`event-log.js` 与 `action-log.js` 各有一份逐字重复的 `readJsonl()` + `compact()`。先建共享底座并测通，再让两个 store 收敛。

**Files:**
- Create: `src/store/jsonl.js`
- Test: `src/store/jsonl.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/store/jsonl.test.js`。

> **测试环境的硬约束（已实测）：** `store/index.js` 的 `DATA_DIR` 是模块级常量，且它被
> `jsonl.js` 以无查询串的 `'./index.js'` 引入 → **全进程只实例化一次**。用 `?case=` 打散被测
> 模块换不掉它。实测：设 `APP_DATA_DIR=A` 后写一条、改成 `B` 再用新实例写一条，**两条都落在 A**，
> B 目录根本未被创建。
> 因此：**整个测试文件共享一个数据目录**，`APP_DATA_DIR` 必须在任何 store 模块被引入**之前**
> 同步设置（故被测模块用 `await import()` 而非顶部静态 import），各用例靠**不同文件名**互相隔离。

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// 必须先设 env，再 import 被测模块（见上方硬约束说明）
const TMP = path.join(os.tmpdir(), `cad-jsonl-test-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.APP_DATA_DIR = TMP;

const { readJsonl, compactJsonl, withinRetention } = await import('./jsonl.js');

after(() => {
  delete process.env.APP_DATA_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('readJsonl：按文件序返回（旧→新），坏行跳过，缺文件返回空数组', () => {
  assert.deepStrictEqual(readJsonl('missing.jsonl'), [], '文件不存在应返回空数组');

  fs.writeFileSync(
    path.join(TMP, 'read.jsonl'),
    ['{"n":1}', '', '{"n":2', '{"n":3}', '   '].join('\n') + '\n',
  );
  assert.deepStrictEqual(
    readJsonl('read.jsonl').map((e) => e.n),
    [1, 3],
    '空行与半行（进程被杀留下）应跳过，其余保持文件序',
  );
});

test('withinRetention：时间窗含边界，time 缺失/不可解析一律保留', () => {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const iso = (ms) => new Date(ms).toISOString();

  assert.equal(withinRetention({ time: iso(now) }, now, 3 * DAY), true);
  assert.equal(withinRetention({ time: iso(now - 3 * DAY) }, now, 3 * DAY), true, '3 天整边界应保留');
  assert.equal(withinRetention({ time: iso(now - 3 * DAY - 1000) }, now, 3 * DAY), false);
  assert.equal(withinRetention({}, now, 3 * DAY), true, 'time 缺失应保留，避免误删');
  assert.equal(withinRetention({ time: 'not-a-date' }, now, 3 * DAY), true);
});

test('compactJsonl：超限裁尾部保留最新 + 时间窗过滤 + 无变化不写盘', async () => {
  const mod = { readJsonl, compactJsonl };
  const file = path.join(TMP, 'c.jsonl');

  // 1) 仅条数超限
  fs.writeFileSync(file, [1, 2, 3, 4, 5].map((n) => JSON.stringify({ n })).join('\n') + '\n');
  mod.compactJsonl('c.jsonl', { max: 3 });
  assert.deepStrictEqual(
    mod.readJsonl('c.jsonl').map((e) => e.n),
    [3, 4, 5],
    '应保留最新 3 条（尾部）',
  );

  // 2) 无变化不写盘：mtime 不应改变
  const before = fs.statSync(file).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  mod.compactJsonl('c.jsonl', { max: 3 });
  assert.equal(fs.statSync(file).mtimeMs, before, '未超限未过期时不应触碰文件');

  // 3) 时间窗过滤
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ n: 'old', time: new Date(now - 4 * DAY).toISOString() }),
      JSON.stringify({ n: 'new', time: new Date(now).toISOString() }),
    ].join('\n') + '\n',
  );
  mod.compactJsonl('c.jsonl', { max: 100, retainMs: 3 * DAY });
  assert.deepStrictEqual(mod.readJsonl('c.jsonl').map((e) => e.n), ['new']);
});

test('compactJsonl：全部被清空时写出空文件而非留下坏行', () => {
  const file = path.join(TMP, 'e.jsonl');
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ n: 1, time: old }) + '\n');

  compactJsonl('e.jsonl', { max: 10, retainMs: 24 * 60 * 60 * 1000 });
  assert.equal(fs.readFileSync(file, 'utf8'), '', '全过期应得到空文件');
  assert.deepStrictEqual(readJsonl('e.jsonl'), []);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/store/jsonl.test.js`
Expected: FAIL —— `Cannot find module ... jsonl.js`

- [ ] **Step 3: 实现 `src/store/jsonl.js`**

```js
/**
 * JSONL 存储底座 —— event-log / action-log / bot-log 共用。
 *
 * 抽出的动机：三个 store 原本各持一份逐字相同的 readJsonl + compact（含「压缩必须加锁」
 * 那段注释也是复制的）。追加写各自保留（event-log 在每个 HTTP 请求上调用，必须同步；
 * 另两个在 async 上下文，用异步 append），只有读取与压缩是真正重复的部分。
 */
import fs from 'node:fs';
import { dataPath } from './index.js';
import { acquireLock, releaseLock } from './lock.js';

/** 读取全部行（文件序 = 旧→新）。缺文件返回 []；坏行（进程被杀留下的半行）跳过。 */
export function readJsonl(name) {
  let raw = '';
  try {
    raw = fs.readFileSync(dataPath(name), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

/**
 * 是否在保留窗口内。time 缺失/不可解析一律保留 —— 宁可留下无法判定的条目，也不误删。
 * @param {number} retainMs 窗口毫秒数；含边界（相等视为窗口内）
 */
export function withinRetention(entry, now, retainMs) {
  const t = Date.parse(entry && entry.time);
  if (Number.isNaN(t)) return true;
  return now - t <= retainMs;
}

/**
 * 压缩：时间窗过滤（可选）+ 条数封顶，原子 rename 落盘。
 *
 * **必须加锁**：追加写可以无锁（单行 <4KB 近似原子，极端并发丢一行可接受），
 * 但压缩是「读全量 → rename 覆盖」，跨进程并发时会把对方在这个窗口里追加的行整段吞掉
 * （web 与 feishu 是两个进程，都在写日志，窗口并不罕见）。
 * 抢不到锁说明别人正在压缩，直接跳过本次即可。
 */
export function compactJsonl(name, { max, retainMs } = {}) {
  const file = dataPath(name);
  const lock = file + '.lock';
  let token;
  try {
    token = acquireLock(lock, { maxWaitMs: 2000 });
  } catch {
    return;
  }
  try {
    const list = readJsonl(name);
    let keep = retainMs ? list.filter((e) => withinRetention(e, Date.now(), retainMs)) : list;
    if (max && keep.length > max) keep = keep.slice(-max); // 时间为主、条数为安全上限
    if (keep.length === list.length) return; // 无过期、未超限 → 不写盘
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, keep.length ? keep.map((e) => JSON.stringify(e)).join('\n') + '\n' : '');
    fs.renameSync(tmp, file);
  } catch {
    /* 压缩失败不影响主流程，下次再试 */
  } finally {
    releaseLock(lock, token);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/store/jsonl.test.js`
Expected: PASS，4 个 test 全绿

- [ ] **Step 5: 验收**

改动留工作区。确认 `src/store/jsonl.js` 与 `src/store/jsonl.test.js` 已创建，无其他文件被改动。

---

## Task 2: `event-log.js` 收敛到 `jsonl.js`

现有 `event-log.test.js` 是这次抽取是否安全的判据，**必须保持绿**。

**Files:**
- Modify: `src/store/event-log.js`

- [ ] **Step 1: 先跑基线，确认现在是绿的**

Run: `node --test src/store/event-log.test.js`
Expected: PASS（1 个 test）。若此时已红，停下来先查环境，不要继续改。

- [ ] **Step 2: 改写 `src/store/event-log.js`**

用下面内容整体替换（顶部注释保留原有的历史说明，删掉本地 `readJsonl`/`withinRetention`/`compact`）：

```js
/**
 * 通用事件日志（API 访问 / 任务操作 / 错误等），最新在前，最多 1000 条。
 * 追加写 JSONL（每行一条）：旧版「每条事件全读全写 1000 条 JSON」在每个 API 请求上
 * 都是一次全量磁盘往返，且被 git 追踪导致工作区永远脏。
 * 追加单行远小于 4KB 近似原子，无需文件锁（极端并发下日志丢一行可接受）。
 * 旧 event-log.json 只读兼容合并，不再写入。
 *
 * 读取与压缩下沉到 store/jsonl.js（三个 JSONL store 共用），此处只保留本日志特有的
 * 策略：3 天保留窗口、遗留 JSON 合并、1000 条上限。
 */
import fs from 'node:fs';
import { dataPath, readJson } from './index.js';
import { readJsonl, compactJsonl, withinRetention } from './jsonl.js';

const FILE = 'event-log.jsonl';
const LEGACY = 'event-log.json';
const MAX = 1000;
const RETAIN_MS = 3 * 24 * 60 * 60 * 1000; // 访问日志仅保留最近 3 天
// 每多少次 append 触发一次压缩。必须**小于** MAX：此前写死 2000，而 MAX 是 1000，
// 文件因此常态维持在上限的 2~3 倍。取 MAX/2 后峰值约 1.5×MAX，且压缩频率仍然可接受。
const COMPACT_EVERY = Math.floor(MAX / 2);

let _appends = 0;

export function appendEvent(entry) {
  try {
    fs.appendFileSync(
      dataPath(FILE),
      JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n',
    );
  } catch {
    /* 日志写失败不影响主流程 */
  }
  if (++_appends >= COMPACT_EVERY) {
    _appends = 0;
    compact(); // 常驻进程（pm2）防文件无限增长
  }
}

function compact() {
  compactJsonl(FILE, { max: MAX, retainMs: RETAIN_MS });
}

/** 最新在前；合并旧版 event-log.json（只读遗留），封顶 MAX 条 */
export function getEvents() {
  const now = Date.now();
  const cur = readJsonl(FILE).reverse();
  const legacy = readJson(LEGACY, []); // 旧文件本就最新在前
  return [...cur, ...legacy].filter((e) => withinRetention(e, now, RETAIN_MS)).slice(0, MAX);
}

/** 清空全部访问日志：截空 JSONL，并删除只读遗留 event-log.json，保证清空彻底。 */
export function clearEvents() {
  fs.writeFileSync(dataPath(FILE), '');
  try {
    fs.rmSync(dataPath(LEGACY), { force: true });
  } catch {
    /* 遗留文件删除失败可忽略（时间过滤也会滤除其旧条目） */
  }
}
// 模块加载即压缩一次（跨重启兜底）。**必须延后到事件循环空闲**：
// 直接同步调用会在启动关键路径上做一次全量读+写，明显拖慢冷启动
//（桌面版有 40s 健康检查窗口，web 就绪越早越好）。unref 保证它不阻止进程退出。
setTimeout(compact, 3000).unref();
```

- [ ] **Step 3: 跑回归测试**

Run: `node --test src/store/event-log.test.js src/store/jsonl.test.js`
Expected: PASS，5 个 test 全绿。`withinRetention` 参数顺序从 `(e, now)` 变成 `(e, now, retainMs)`，若忘记传第三参会出现「3 天窗口内条目被判过期」的失败。

- [ ] **Step 4: 验收**

改动留工作区。`getEvents` / `appendEvent` / `clearEvents` 三个导出的签名与行为均未变，调用方（`routes-ops.js`、`server.js`、`run-claude.js`）无需改动。

---

## Task 3: `action-log.js` 收敛 + 补测试

该文件此前**没有专门测试**（仅 `mask.test.js` 覆盖脱敏），先补一个读写往返测试作为抽取安全网。

**Files:**
- Modify: `src/store/action-log.js`
- Test: `src/store/action-log.test.js`

- [ ] **Step 1: 写测试（先针对现有实现，此时应直接通过）**

创建 `src/store/action-log.test.js`。同 Task 1：共享单一数据目录，env 先于 import 设置
（`DATA_DIR` 全进程只求值一次，已实测）。两个用例共用 `action-log.jsonl`，靠执行顺序 +
用例内自清理隔离（`node:test` 同文件内默认串行）。

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP = path.join(os.tmpdir(), `cad-actionlog-test-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.APP_DATA_DIR = TMP;

const { appendActionLog } = await import('./action-log.js');
const FILE = path.join(TMP, 'action-log.jsonl');

after(() => {
  delete process.env.APP_DATA_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('appendActionLog 落盘 + vars 脱敏', async () => {
  fs.rmSync(FILE, { recursive: true, force: true });

  await appendActionLog({
    time: new Date().toISOString(),
    userId: 'ou_abc',
    actionId: 'ac_1',
    actionName: '清理账号数据',
    vars: { phone: '15912349503', env: 'dev' },
    ok: true,
    code: 0,
  });

  const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, '应写入一行');
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.actionName, '清理账号数据');
  assert.equal(rec.ok, true);
  assert.equal(rec.vars.env, 'dev');
  assert.notEqual(rec.vars.phone, '15912349503', '手机号必须脱敏后落盘');
  assert.match(rec.vars.phone, /\*/, '脱敏后应含掩码字符');
});

test('写失败不抛（目标文件名被目录占住）', async () => {
  fs.rmSync(FILE, { recursive: true, force: true });
  fs.mkdirSync(FILE); // 目录占住目标文件名 → append 必然 EISDIR
  try {
    await appendActionLog({ userId: 'ou_x', actionName: 'X', ok: true, code: 0 });
    // 不抛即通过：日志写失败绝不能影响主流程
  } finally {
    fs.rmSync(FILE, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认通过（基线）**

Run: `node --test src/store/action-log.test.js`
Expected: PASS，2 个 test。这一步是在**未修改** `action-log.js` 的情况下建立基线。

- [ ] **Step 3: 改写 `src/store/action-log.js` 收敛到 jsonl.js**

删除本地 `readJsonl` 与 `compact`，改为：

```js
/**
 * 执行日志（action-log.jsonl）—— 记录每次用户操作执行结果，支持敏感字段脱敏。
 *
 * 格式：JSONL（每行一条 JSON 记录）。敏感字段脱敏：手机号 → 159****9503。
 * 写失败不影响主流程，仅 logger.warn 记录。
 * 防无限增长：每 250 次 append 压缩一次，保留最新 500 条（读取与压缩见 store/jsonl.js）。
 *
 * 注意：本文件是**审计**用途（结构化 vars + 脱敏）。面板展示用的机器人日志在 store/bot-log.js，
 * 两者并行写入，互不影响。
 */
import { appendFile } from 'node:fs/promises';
import { logger } from '../shared/logger.js';
import { dataPath } from './index.js';
import { maskValue, maskDeep } from './mask.js';
import { compactJsonl } from './jsonl.js';

const FILE = 'action-log.jsonl';
const MAX_ENTRIES = 500;
const COMPACT_EVERY = Math.floor(MAX_ENTRIES / 2);
let _appends = 0;

function compact() {
  compactJsonl(FILE, { max: MAX_ENTRIES });
}

/**
 * 异步追加执行日志到 action-log.jsonl
 * @param {Object} entry - 日志记录，包含 { time, userId, actionId, actionName, vars, ok, code }
 * @returns {Promise<void>}
 */
export async function appendActionLog(entry) {
  try {
    // 脱敏 vars 中的敏感字段
    const maskedEntry = {
      ...entry,
      vars: entry.vars ? maskDeep(entry.vars) : undefined,
    };
    await appendFile(dataPath(FILE), JSON.stringify(maskedEntry) + '\n');
  } catch (err) {
    // 日志写失败仅记录 warn，不抛异常
    logger.warn('action-log', 'Failed to append action log', {
      error: err?.message || String(err),
    });
  }

  // 压缩阈值必须**小于** MAX_ENTRIES，否则文件常态会稳定在上限的 2 倍以上
  // （此前写死 500，恰好等于 MAX_ENTRIES）
  if (++_appends >= COMPACT_EVERY) {
    _appends = 0;
    compact();
  }
}

// 模块加载时压缩一次，跨重启兜底。延后到事件循环空闲执行：
// 同步跑会在启动关键路径上做一次全量读+写，拖慢冷启动。unref 保证不阻止进程退出。
setTimeout(compact, 3000).unref();

export { maskValue }; // 兼容既有引用；实现已迁至 ./mask.js
```

- [ ] **Step 4: 跑全量 store 测试**

Run: `node --test "src/store/*.test.js"`
Expected: PASS。特别确认 `action-log.test.js`、`event-log.test.js`、`jsonl.test.js`、`mask.test.js` 全绿。

- [ ] **Step 5: 验收**

三份重复的 `readJsonl`+`compact` 已收敛为一份。确认 `action-log.js` 中已无 `fs.readFileSync`、`acquireLock` 的直接引用（`import fs from 'node:fs'` 也应随之删除，只留 `appendFile`）。

---

## Task 4: `src/store/bot-log.js` 纯存储层

只管读写，不查机器人名、不解析用户姓名（那是 Task 6 组装层的事）——store 层不依赖 integrations。

**Files:**
- Create: `src/store/bot-log.js`
- Test: `src/store/bot-log.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/store/bot-log.test.js`。同 Task 1/3：共享单一数据目录，env 先于 import 设置。
各用例开头清空 `bot-log.jsonl` 以互相隔离。

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP = path.join(os.tmpdir(), `cad-botlog-test-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.APP_DATA_DIR = TMP;

const { appendBotLog, getBotLogs, clearBotLogs } = await import('./bot-log.js');
const FILE = path.join(TMP, 'bot-log.jsonl');

/** 每个用例前把落点恢复成「文件不存在」的干净状态 */
function reset() {
  fs.rmSync(FILE, { recursive: true, force: true });
}

after(() => {
  delete process.env.APP_DATA_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('文件不存在时 getBotLogs 返回空数组而非抛错', () => {
  reset();
  assert.deepStrictEqual(getBotLogs(), []);
});

test('写入后按最新在前读出，time 自动补齐', async () => {
  reset();

  await appendBotLog({
    botId: 'bot_1', botName: '机器人 1',
    userId: 'ou_abc', userName: '申孟涛',
    kind: 'action', detail: '获取小程序二维码', ok: true, code: 0,
  });
  await appendBotLog({
    botId: 'bot_1', botName: '机器人 1',
    userId: 'ou_abc', userName: '申孟涛',
    kind: 'chat', detail: '帮我看下登录接口报错', ok: true,
  });

  const logs = getBotLogs();
  assert.equal(logs.length, 2);
  assert.equal(logs[0].kind, 'chat', '最新在前');
  assert.equal(logs[1].kind, 'action');
  assert.ok(logs[0].time, 'time 应由 store 自动补齐');
  assert.equal(logs[1].userName, '申孟涛');
});

test('clearBotLogs 清空', async () => {
  reset();
  await appendBotLog({ kind: 'action', detail: 'X', ok: true });
  assert.equal(getBotLogs().length, 1);
  clearBotLogs();
  assert.deepStrictEqual(getBotLogs(), []);
});

test('写失败不抛（目标文件名被目录占住）', async () => {
  reset();
  fs.mkdirSync(FILE); // 目录占位 → append 必然 EISDIR
  try {
    await appendBotLog({ kind: 'action', detail: 'X', ok: true });
    // 不抛即通过
  } finally {
    fs.rmSync(FILE, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/store/bot-log.test.js`
Expected: FAIL —— `Cannot find module ... bot-log.js`

- [ ] **Step 3: 实现 `src/store/bot-log.js`**

```js
/**
 * 机器人端业务日志（bot-log.jsonl）—— 面板「访问日志」展示的数据源。
 *
 * 为什么独立于 event-log：event-log 的 MAX 是 1000，而 server.js 对每个 HTTP 请求都写一条
 * access，前端 5 秒一轮的轮询几十分钟就能把机器人日志全部挤出上限——放同一个环形缓冲
 * 等于自动删除。
 * 为什么独立于 action-log：那份是审计用途（结构化 vars + maskDeep 脱敏），
 * 脱敏逻辑套不到对话自由文本上，两类日志的字段需求会互相拖累。
 *
 * 条目形状：{ time, botId, botName, userId, userName, kind:'action'|'chat', detail, ok, code }
 * botName/userName 是**写入时快照**：机器人改名或飞书权限回收后，历史记录仍显示当时的名字，
 * 这符合审计语义。
 *
 * 本模块只做存储，不查机器人名、不解析用户姓名（见 shared/bot-activity.js），
 * 以免 store 层反向依赖 integrations/settings。
 */
import fs from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { logger } from '../shared/logger.js';
import { dataPath } from './index.js';
import { readJsonl, compactJsonl } from './jsonl.js';

const FILE = 'bot-log.jsonl';
// 业务审计日志且低频（一天几条到几十条）→ 不设时间窗，按时间删只会白丢历史。
// 条数上限只作为文件无限增长的安全阀。
const MAX = 2000;
const COMPACT_EVERY = Math.floor(MAX / 2);

let _appends = 0;

function compact() {
  compactJsonl(FILE, { max: MAX });
}

/** 追加一条机器人日志。写失败只 warn，绝不影响主流程（埋点在用户消息处理路径上）。 */
export async function appendBotLog(entry) {
  try {
    await appendFile(
      dataPath(FILE),
      JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n',
    );
  } catch (err) {
    logger.warn('bot-log', '写入机器人日志失败', { error: err?.message || String(err) });
  }
  if (++_appends >= COMPACT_EVERY) {
    _appends = 0;
    compact();
  }
}

/** 最新在前，封顶 MAX 条 */
export function getBotLogs() {
  return readJsonl(FILE).reverse().slice(0, MAX);
}

/** 清空全部机器人日志 */
export function clearBotLogs() {
  fs.writeFileSync(dataPath(FILE), '');
}

// 模块加载即压缩一次（跨重启兜底），延后到事件循环空闲，unref 不阻止进程退出。
setTimeout(compact, 3000).unref();
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/store/bot-log.test.js`
Expected: PASS，4 个 test 全绿

- [ ] **Step 5: 验收**

改动留工作区。确认 `bot-log.js` 没有 import `settings.js` 或 `integrations/`。

---

## Task 5: `lark.getUserName(id)` —— 飞书姓名解析

**Files:**
- Modify: `src/integrations/lark.js`
- Test: `src/integrations/lark.username.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/integrations/lark.username.test.js`。mock 手法与 `lark.file.test.js` 相同：必须抢在 `lark.js` 被 import **之前**替换 CJS exports 上的 `Client`。

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// —— 依赖注入手法：见 lark.file.test.js 的详细说明 ——
// SDK 是 CJS 包，ESM 侧 `import * as Lark` 只在该模块首次被 ESM 引入时从 exports 快照命名导出。
// 必须在 import lark.js 之前把 Client 换掉，晚一步快照就定型了。
const require = createRequire(import.meta.url);
const larkCjs = require('@larksuiteoapi/node-sdk');

/** 每个用例可改写：request 的返回值（或抛错函数） */
let requestImpl = () => ({ data: { user: { name: '默认名' } } });
/** 记录打到「飞书」的请求，用于断言 URL / user_id_type */
let calls = [];

class FakeClient {
  constructor(cfg) {
    this.cfg = cfg;
  }
  async request(opts) {
    calls.push(opts);
    return requestImpl(opts);
  }
}
larkCjs.Client = FakeClient;

process.env.LARK_APP_ID = process.env.LARK_APP_ID || 'cli_test';
process.env.LARK_APP_SECRET = process.env.LARK_APP_SECRET || 'secret_test';

const lark = await import('./lark.js');

function reset() {
  calls = [];
  lark.resetApiClient({ appId: 'cli_test', appSecret: 'secret_test' }); // 顺带清姓名缓存
}

test('getUserName: ou_ 前缀 → user_id_type=open_id，返回姓名', async () => {
  reset();
  requestImpl = () => ({ data: { user: { name: '申孟涛' } } });

  const name = await lark.getUserName('ou_0af8c9b5');
  assert.equal(name, '申孟涛');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/open-apis\/contact\/v3\/users\/ou_0af8c9b5$/);
  assert.equal(calls[0].params.user_id_type, 'open_id');
});

test('getUserName: 非 ou_ 前缀 → user_id_type=user_id（卡片回调给的是内部 userId）', async () => {
  reset();
  requestImpl = () => ({ data: { user: { name: '李四' } } });

  assert.equal(await lark.getUserName('7f8e9d0c'), '李四');
  assert.equal(calls[0].params.user_id_type, 'user_id');
});

test('getUserName: 正缓存命中，不重复请求', async () => {
  reset();
  requestImpl = () => ({ data: { user: { name: '申孟涛' } } });

  await lark.getUserName('ou_cache');
  await lark.getUserName('ou_cache');
  await lark.getUserName('ou_cache');
  assert.equal(calls.length, 1, '同一 id 只应请求一次');
});

test('getUserName: HTTP 200 但业务 code≠0 → 返回 null 并进负缓存', async () => {
  reset();
  requestImpl = () => ({ code: 99991672, msg: 'no permission' });

  assert.equal(await lark.getUserName('ou_nope'), null, 'code≠0 必须当失败');
  assert.equal(await lark.getUserName('ou_nope'), null);
  assert.equal(calls.length, 1, '负缓存生效：TTL 内不重复请求');
});

test('getUserName: 抛错 → 返回 null，不冒泡', async () => {
  reset();
  requestImpl = () => {
    throw new Error('network down');
  };
  assert.equal(await lark.getUserName('ou_err'), null);
});

test('getUserName: 负缓存按 id 粒度，一个查不到不连带压掉别人', async () => {
  reset();
  requestImpl = (opts) =>
    opts.url.endsWith('ou_bad') ? { code: 1, msg: 'not found' } : { data: { user: { name: '王五' } } };

  assert.equal(await lark.getUserName('ou_bad'), null);
  assert.equal(await lark.getUserName('ou_good'), '王五', '别的 id 必须照常解析');
});

test('getUserName: 空 id 直接返回 null，不发请求', async () => {
  reset();
  assert.equal(await lark.getUserName(''), null);
  assert.equal(await lark.getUserName(null), null);
  assert.equal(calls.length, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/integrations/lark.username.test.js`
Expected: FAIL —— `lark.getUserName is not a function`

- [ ] **Step 3: 在 `src/integrations/lark.js` 中实现**

在 `getBotOpenId()` 函数之后（约 `lark.js:75`，`createWsClient` 之前）插入：

```js
// —— 用户姓名解析（机器人日志展示用）——
/** 姓名正缓存：id → name */
const _userNames = new Map();
/** 失败负缓存：id → 失败时刻。**按 id 粒度**，否则一个查不到的离职用户会连带压掉所有人的解析 */
const _userNameFailedAt = new Map();
/** 负缓存 TTL，与 BOT_OPEN_ID_FAIL_TTL 同值：权限缺失时不必每条消息都打一次 HTTP + 刷一条 warn，
 *  带 TTL 则权限修好后无需重启即可恢复 */
const USER_NAME_FAIL_TTL = 60_000;

/**
 * openId / userId → 姓名。取不到返回 null（调用方降级为显示 id 尾号），**绝不抛错**。
 *
 * user_id_type 必须按前缀动态判定：ctx.user.id 并非恒为 open_id ——
 * card-actions.js 的卡片回调路径是「优先 userId（飞书内部 ID），回退 openId」。
 * 写死 open_id 会让卡片按钮触发的动作日志全部解析失败。
 *
 * 需应用开通 contact:user.base:readonly。未开通时负缓存生效，一分钟最多一次无效请求。
 */
export async function getUserName(id) {
  if (!id) return null;
  const key = String(id);
  const hit = _userNames.get(key);
  if (hit) return hit;
  const failedAt = _userNameFailedAt.get(key);
  if (failedAt && Date.now() - failedAt < USER_NAME_FAIL_TTL) return null;
  try {
    const r = await getClient().request({
      method: 'GET',
      url: `/open-apis/contact/v3/users/${encodeURIComponent(key)}`,
      params: { user_id_type: key.startsWith('ou_') ? 'open_id' : 'user_id' },
    });
    // SDK generic request 不校验业务 code：HTTP 200 + code!=0 也是失败
    if (r?.code) throw new Error(`contact users get 失败: ${r.msg || r.code}`);
    const name = r?.data?.user?.name || r?.user?.name || null;
    if (!name) throw new Error('响应中无 user.name');
    _userNames.set(key, name);
    _userNameFailedAt.delete(key);
    return name;
  } catch (e) {
    _userNameFailedAt.set(key, Date.now());
    logger.warn('lark', '用户姓名解析失败（降级为显示 id 尾号）', {
      id: key,
      err: e?.message || String(e),
    });
    return null;
  }
}
```

- [ ] **Step 4: 在 `resetApiClient` 中清缓存**

`resetApiClient`（`lark.js:37`）函数体末尾，`_botOpenIdFailedAt = 0;` 之后加两行：

```js
  // 换号后 id 归属可能变，姓名缓存必须一起失效
  _userNames.clear();
  _userNameFailedAt.clear();
```

注意：`_userNames` 声明在 `resetApiClient` 之后（`const` 的 TDZ 只影响**执行时**，而 `resetApiClient` 在模块求值完成后才被调用），因此无需移动声明位置。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test src/integrations/lark.username.test.js`
Expected: PASS，7 个 test 全绿

- [ ] **Step 6: 验证 logger 已在作用域内**

Run: `rg -n "^import.*logger" src/integrations/lark.js`
Expected: 有输出（`getUserName` 里用到 `logger.warn`）。若无，从 `../shared/logger.js` 补 import。

- [ ] **Step 7: 验收**

改动留工作区。确认未触碰 `lark.file.test.js`，并跑一次 `node --test "src/integrations/*.test.js"` 确认无回归。

---

## Task 6: `src/shared/bot-activity.js` 组装层

把「查机器人名 + 解析用户姓名 + 截断 detail」收在一处，两个埋点共用（DRY）。

**Files:**
- Create: `src/shared/bot-activity.js`

- [ ] **Step 1: 实现**

```js
/**
 * 机器人日志组装层 —— 埋点唯一入口。
 *
 * 职责：把埋点现场只有的 id（botId/userId）补成可展示的快照（botName/userName），
 * 截断自由文本，然后交给 store/bot-log.js 落盘。
 *
 * 放在 shared 而非 store：解析姓名要调 integrations/lark，查机器人名要读 store/settings，
 * 让 store/bot-log.js 反向依赖这两者会把存储层和业务层绑死。
 */
import { appendBotLog } from '../store/bot-log.js';
import { getBots } from '../store/settings.js';
import { getUserName } from '../integrations/lark.js';
import { logger, preview } from './logger.js';

/** detail 截断长度：面板是固定行高的单行展示，再长也会被 CSS 省略号截掉 */
const DETAIL_MAX = 60;

/** botId → 当前机器人名快照；查不到返回 null（渲染时显示「机器人 —」） */
function botNameOf(botId) {
  if (!botId) return null;
  try {
    return getBots().find((b) => b && b.id === botId)?.name || null;
  } catch {
    return null; // settings 读失败不能拖垮埋点
  }
}

/**
 * 记录一条机器人活动。**永不抛错**——埋点在用户消息处理路径上，日志失败绝不能影响主流程。
 *
 * @param {'action'|'chat'} kind
 * @param {string} botId 机器人 id
 * @param {string} userId openId 或飞书内部 userId
 * @param {string} detail action → 动作名；chat → 用户原话
 * @param {boolean} ok 执行/处理是否成功
 * @param {number} [code] 仅 action 有意义的退出码
 */
export async function recordBotActivity({ kind, botId, userId, detail, ok, code }) {
  try {
    // 姓名解析失败返回 null，不阻断写入（渲染层回退 id 尾号）
    const userName = await getUserName(userId);
    await appendBotLog({
      botId: botId || null,
      botName: botNameOf(botId),
      userId: userId || null,
      userName,
      kind,
      detail: preview(detail, DETAIL_MAX),
      ok: !!ok,
      ...(code == null ? {} : { code }),
    });
  } catch (e) {
    logger.warn('bot-activity', '记录机器人日志失败', { kind, err: e?.message || String(e) });
  }
}
```

- [ ] **Step 2: 验证 `preview` 导出可用**

Run: `rg -n "export function preview" src/shared/logger.js`
Expected: `82:export function preview(text, n = 120) {`

- [ ] **Step 3: 验证模块可加载（无循环依赖）**

Run: `node -e "import('./src/shared/bot-activity.js').then(m=>console.log(Object.keys(m)))"`
Expected: `[ 'recordBotActivity' ]`

- [ ] **Step 4: 验收**

改动留工作区。

---

## Task 7: 埋点 1 —— 动作执行

**Files:**
- Modify: `src/plugins/action-runner/feature/script-runner.js:11`（import）、`:137-153`（埋点）

- [ ] **Step 1: 加 import**

在 `script-runner.js:11` 的 `import { appendActionLog } ...` 之后加：

```js
import { recordBotActivity } from '../../../shared/bot-activity.js';
import { getConfig } from '../../../store/action-configs.js';
```

- [ ] **Step 2: 在既有 appendActionLog 的 try 块之后插入埋点**

`runAction` 中「7. 记录执行日志」那个 try/catch 块**之后**、`return { ok: result.ok, output }` 之前插入：

```js
  // 8. 记录机器人日志（面板展示用；action-log 是审计用途，两者并行不互相替代）
  // botId 由 actionId 反查：动作 per-bot 独享，配置里带 botId
  await recordBotActivity({
    kind: 'action',
    botId: getConfig(actionId)?.botId,
    userId,
    detail: actionName,
    ok: result.ok,
    code: result.code || (result.ok ? 0 : 1),
  });
```

`recordBotActivity` 内部已全包 try/catch 且永不抛错，这里无需再套。

- [ ] **Step 3: 语法检查**

Run: `node --check src/plugins/action-runner/feature/script-runner.js`
Expected: 无输出（通过）

`getConfig(id)` 已确认是 `src/store/action-configs.js:27` 的导出，签名 `getConfig(id)` 返回配置对象或 undefined，故用 `?.botId` 取值。

- [ ] **Step 4: 跑动作相关测试**

Run: `node --test "src/plugins/action-runner/**/*.test.js"`
Expected: PASS。若某测试 mock 了 `script-runner` 的依赖而未预期新 import，按其既有 mock 风格补上。

- [ ] **Step 5: 验收**

改动留工作区。确认 `appendActionLog` 调用**未被删除**（审计日志保留）。

---

## Task 8: 埋点 2 —— 飞书对话

**Files:**
- Modify: `src/entrypoints/feishu/index.js:257`

- [ ] **Step 1: 加 import**

在 `feishu/index.js` 顶部 import 区加：

```js
import { recordBotActivity } from '../../shared/bot-activity.js';
import { getActiveBot } from '../../store/settings.js';
```

若 `getActiveBot` 已被该文件 import，则只加第一行。先查：

Run: `rg -n "getActiveBot" src/entrypoints/feishu/index.js`

- [ ] **Step 2: 接住 dispatchSafely 的返回值并埋点**

把 `feishu/index.js:253-260` 的 try/finally 改为：

```js
  const emojis = config.lark.reactionEmojis;
  const emoji = emojis[Math.floor(Math.random() * emojis.length)];
  const reactionId = await channel.addReaction(m.messageId, emoji);
  let result = { ok: false };
  try {
    // 用 dispatchSafely 而非裸 dispatch：这里没有 catch，而上游 channels/feishu.js 只 logger.error，
    // 且 SDK 早已回 200 ack（飞书不重推）+ seen 已标记（用户重发同一条也不会重跑）。
    // 裸 dispatch 抛错 = 用户看到表情贴上又取下，然后永远没有下文。
    result = await dispatchSafely(ctx);
  } finally {
    if (reactionId) await channel.removeReaction(m.messageId, reactionId);
  }
  // 机器人日志埋点：放在回复已发出、表情已撤之后 —— getUserName 首次调用有网络往返，
  // 不能挡住用户感知到的响应速度。
  await recordBotActivity({
    kind: 'chat',
    botId: getActiveBot()?.id,
    userId: m.userId,
    detail: m.text,
    ok: result.ok,
  });
```

- [ ] **Step 3: 语法检查**

Run: `node --check src/entrypoints/feishu/index.js`
Expected: 无输出（通过）

- [ ] **Step 4: 跑 dispatch 相关测试**

Run: `node --test src/app/dispatch.test.js`
Expected: PASS（该文件测的是 `dispatch.js`，不受入口改动影响；此步是回归确认）

- [ ] **Step 5: 验收**

改动留工作区。确认 `dispatchSafely` 的返回值 `{ ok, notified }` 契约未被改动（见 `src/app/dispatch.js:30-49`）。

---

## Task 9: 后端路由 `/api/bot-logs`

**Files:**
- Modify: `src/entrypoints/web/routes-ops.js:6`（import）、`:23-37`（新增 handler）
- Modify: `src/entrypoints/web/server.js:89-98`（排除集）、`:159-160`（路由注册）

- [ ] **Step 1: 在 `routes-ops.js` 加 import**

第 6 行 `import { getEvents, clearEvents } from '../../store/event-log.js';` 之后加：

```js
import { getBotLogs, clearBotLogs } from '../../store/bot-log.js';
```

- [ ] **Step 2: 在 `handleLogsClear` 之后新增两个 handler**

```js
/** 机器人端业务日志（面板数据源），最新在前 */
export function handleBotLogs(res) {
  sendJson(res, 200, { logs: getBotLogs() });
}

/** 清空全部机器人日志 */
export function handleBotLogsClear(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  try {
    clearBotLogs();
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}
```

`getBotLogs()` 已在 store 内封顶 2000 条，此处不再 slice。

- [ ] **Step 3: 在 `server.js` 注册路由**

`server.js:159-160` 的两行之后加：

```js
  if (url.pathname === '/api/bot-logs') return handleBotLogs(res);
  if (url.pathname === '/api/bot-logs/clear') return handleBotLogsClear(req, res);
```

并在 `server.js` 顶部从 `./routes-ops.js` 的 import 清单里加上 `handleBotLogs,` 和 `handleBotLogsClear,`。

- [ ] **Step 4: 加入访问日志排除集（关键）**

`server.js:90` 的 `ACCESS_LOG_SKIP` 中加两行：

```js
  '/api/bot-logs',
  '/api/bot-logs/clear',
```

**不加会怎样：** 打开面板这个动作本身就往 `event-log.jsonl` 写一条 access。现有 `/api/logs`、`/api/logs/clear` 正是因此被排除的。

- [ ] **Step 5: 起服务验证**

Run: `node server.js`（另开终端）然后 `curl -s http://127.0.0.1:3000/api/bot-logs`
Expected: `{"logs":[]}` 或含已有条目的 JSON。端口 3000 已确认：`config.web.port = Number(process.env.PORT) || 3000`（`src/shared/config.js:32`），且本项目 `.env` 未设 `PORT`。

验证排除集生效：请求几次 `/api/bot-logs` 后 `tail -n 3 event-log.jsonl`，**不应**出现 `"path":"/api/bot-logs"`。

- [ ] **Step 6: 验收**

改动留工作区。确认 `/api/logs` 与 `/api/logs/clear` 两个旧接口**仍然存在**（`event-log` 照旧写盘，仅 UI 不再消费）。

---

## Task 10: 前端文案层（纯函数 + 测试）

**Files:**
- Create: `public/js/logs-panel.logic.js`
- Test: `public/js/logs-panel.logic.test.js`

- [ ] **Step 1: 写失败测试**

创建 `public/js/logs-panel.logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBotLogEntry, botLabel, userLabel } from './logs-panel.logic.js';

test('动作执行：成功文案', () => {
  const r = formatBotLogEntry({
    kind: 'action', botName: '机器人 1', userName: '申孟涛',
    detail: '获取小程序二维码', ok: true, code: 0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, '机器人 1 为 申孟涛 执行了「获取小程序二维码」· 成功');
});

test('动作执行：失败带 code', () => {
  const r = formatBotLogEntry({
    kind: 'action', botName: '机器人 1', userName: '申孟涛',
    detail: '清理账号数据', ok: false, code: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.text, '机器人 1 为 申孟涛 执行了「清理账号数据」· 失败(code 1)');
});

test('动作执行：失败但无 code → 占位符不显示 undefined', () => {
  const r = formatBotLogEntry({ kind: 'action', botName: 'B', userName: 'U', detail: 'X', ok: false });
  assert.equal(r.text, 'B 为 U 执行了「X」· 失败(code -)');
});

test('飞书对话文案（引号内是用户原话，不带成功后缀）', () => {
  const r = formatBotLogEntry({
    kind: 'chat', botName: '机器人 1', userName: '申孟涛',
    detail: '帮我看下登录接口报错', ok: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, '机器人 1 回复了 申孟涛：「帮我看下登录接口报错」');
});

test('飞书对话：处理失败时标记为失败', () => {
  const r = formatBotLogEntry({ kind: 'chat', botName: 'B', userName: 'U', detail: 'X', ok: false });
  assert.equal(r.ok, false);
  assert.equal(r.text, 'B 回复了 U：「X」· 处理失败');
});

test('userName 缺失 → 回退 openId 尾 6 位', () => {
  assert.equal(userLabel({ userId: 'ou_0af8c9b5bfeb7c667c963c3d08a774fd' }), '用户 …a774fd');
  assert.equal(userLabel({ userName: '申孟涛', userId: 'ou_x' }), '申孟涛', '有姓名时优先用姓名');
  assert.equal(userLabel({}), '用户 —', 'userId 也缺失');
});

test('botName 缺失 → 机器人 —', () => {
  assert.equal(botLabel({ botName: '机器人 1' }), '机器人 1');
  assert.equal(botLabel({}), '机器人 —');
});

test('detail 缺失不渲染 undefined', () => {
  const r = formatBotLogEntry({ kind: 'action', botName: 'B', userName: 'U', ok: true });
  assert.equal(r.text, 'B 为 U 执行了「—」· 成功');
});

test('ok 字段缺失时按成功处理（旧条目容错）', () => {
  assert.equal(formatBotLogEntry({ kind: 'action', detail: 'X' }).ok, true);
});

test('未知 kind 按 action 文案兜底，不返回空白行', () => {
  const r = formatBotLogEntry({ kind: 'weird', botName: 'B', userName: 'U', detail: 'X', ok: true });
  assert.equal(r.text, 'B 为 U 执行了「X」· 成功');
});

test('entry 为 null/undefined 不抛错', () => {
  assert.doesNotThrow(() => formatBotLogEntry(null));
  assert.doesNotThrow(() => formatBotLogEntry(undefined));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test public/js/logs-panel.logic.test.js`
Expected: FAIL —— `Cannot find module ... logs-panel.logic.js`

- [ ] **Step 3: 实现 `public/js/logs-panel.logic.js`**

```js
/**
 * 机器人日志的文案渲染（纯函数，无 DOM 依赖 → 可被 node --test 直接 import）。
 * logs-panel.js 顶层 import 了 ui.js 并操作 DOM，测试里 import 会炸，故按项目既有的
 * `.logic.js` 约定把纯逻辑单独放这里。
 */

/** 机器人名；缺失（botId 已被删除或历史条目无此字段）显示占位符 */
export function botLabel(entry) {
  return (entry && entry.botName) || '机器人 —';
}

/**
 * 用户名；解析失败（飞书未开通 contact 权限等）回退 id 尾 6 位。
 * 尾号比整串 openId 短且足以区分不同人，适合固定行高的单行展示。
 */
export function userLabel(entry) {
  const e = entry || {};
  if (e.userName) return e.userName;
  const id = String(e.userId || '');
  return id ? `用户 …${id.slice(-6)}` : '用户 —';
}

/**
 * 一条日志 → { ok, text }。ok 供行首 ✅/❌ 使用。
 * ok 字段缺失按成功处理：旧条目容错，不能让缺字段的记录整行标红。
 */
export function formatBotLogEntry(entry) {
  const e = entry || {};
  const ok = e.ok !== false;
  const bot = botLabel(e);
  const user = userLabel(e);
  const detail = e.detail || '—';

  if (e.kind === 'chat') {
    // 引号内是**用户原话**，不是机器人的回复内容
    return { ok, text: `${bot} 回复了 ${user}：「${detail}」${ok ? '' : ' · 处理失败'}` };
  }
  // 未知 kind 一并走动作文案兜底，避免出现空白行
  const tail = ok ? '成功' : `失败(code ${e.code ?? '-'})`;
  return { ok, text: `${bot} 为 ${user} 执行了「${detail}」· ${tail}` };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test public/js/logs-panel.logic.test.js`
Expected: PASS，11 个 test 全绿

- [ ] **Step 5: 验收**

改动留工作区。

---

## Task 11: 前端面板接线

**Files:**
- Modify: `public/js/logs-panel.js`

- [ ] **Step 1: 替换 import 与删除死代码**

把文件开头（第 1-25 行，从注释到 `formatLogEntry` 结束）替换为：

```js
/** 机器人日志面板：分组渲染 + 搜索过滤 + 虚拟滚动 + 清空。入口 loadLogs 由 showView('logs') 调用。 */
import { $, debounce, fmtTime } from './util.js';
import { confirmDialog } from './ui.js';
import { formatBotLogEntry } from './logs-panel.logic.js';
```

这一步删掉了 `LOG_PATH_LABELS`（8 条路径映射）与 `formatLogEntry`（含 `cleanup` 分支）——
HTTP access 不再展示，它们成为死代码。

- [ ] **Step 2: 换数据源**

`loadLogs` 内：

```js
          const { logs } = await (await fetch('/api/bot-logs')).json();
```

空态文案改为：

```js
        if (!allLogs.length) {
          body.innerHTML = '<div style="color:var(--faint);padding:8px">暂无机器人日志</div>';
          return;
        }
```

- [ ] **Step 3: 换清空接口与确认文案**

```js
          const ok = await confirmDialog({
            title: '清空机器人日志',
            message: '确认清空全部机器人日志？清空后不可恢复。',
            confirmText: '确认清空',
            danger: true,
          });
          if (!ok) return;
          clearBtn.disabled = true;
          try {
            const resp = await fetch('/api/bot-logs/clear', { method: 'POST' });
```

- [ ] **Step 4: 换渲染与过滤中的 format 调用**

`renderVisible()` 内：

```js
            const { ok, text } = formatBotLogEntry(g);
```

搜索过滤内（去掉已不存在的 `g.path` 分支）：

```js
        const filterDebounced = debounce((q) => {
          const kw = q.trim().toLowerCase();
          filteredLogs = kw
            ? allLogs.filter((g) => formatBotLogEntry(g).text.toLowerCase().includes(kw))
            : allLogs;
          scroller.scrollTop = 0;
          renderVisible();
        }, 200);
```

- [ ] **Step 5: 确认 CSS 已满足固定行高前提（无需改动）**

Run: `rg -n "\.log-row \.info" -A 5 public/app.css`
Expected:

```
.log-row .info {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

`ROW_H = 32` 的虚拟滚动依赖单行不折行。上述三条属性**已存在**（`app.css:1405-1410`），
新文案更长也会被省略号截断，行高不变。**本步只做验证，不修改 CSS。**
（设计文档 §4.3 原写「必须加」，实为已具备——已在 spec 中更正。）

- [ ] **Step 6: 确认无残留引用**

Run: `rg -n "LOG_PATH_LABELS|formatLogEntry|/api/logs" public/`
Expected: 无输出。若 `/api/logs` 仍出现在 `public/` 下，说明还有未替换的调用点。

- [ ] **Step 7: 端到端验证**

1. 起服务：`node server.js`
2. 浏览器打开控制台，点「访问日志」按钮 → 应显示「暂无机器人日志」（尚无数据）
3. 手工塞一条测试数据验证渲染：

```bash
node -e "import('./src/store/bot-log.js').then(m=>m.appendBotLog({botId:'bot_nwwiga',botName:'机器人 1',userId:'ou_0af8c9b5bfeb7c667c963c3d08a774fd',userName:'申孟涛',kind:'action',detail:'获取小程序二维码',ok:true,code:0}))"
```

4. 刷新面板 → 应显示 `✅ 2026/8/26 15:32:11  机器人 1 为 申孟涛 执行了「获取小程序二维码」· 成功`
   （时间格式由 `util.js` 的 `fmtTime` 决定：`toLocaleString('zh-CN',{hour12:false})`）
5. 搜索框输入「申孟涛」→ 该行保留；输入「zzz」→ 显示 0 条
6. 点「清空日志」→ 确认 → 回到空态
7. `tail -n 5 event-log.jsonl` → 确认整个过程**没有** `/api/bot-logs` 的 access 条目

- [ ] **Step 8: 跑全量测试**

Run: `npm test`
Expected: 全绿。`npm test` 的 glob 是 `"src/**/*.test.js" "public/**/*.test.js"`，本次新增的
5 个测试文件都在覆盖范围内。

- [ ] **Step 9: 验收**

全部改动留工作区，由用户决定提交时机。向用户报告：改动文件清单、`npm test` 实际输出、以及
飞书 contact 权限是否需要开通（若端到端验证时 `logger.warn` 出现「用户姓名解析失败」，
说明 `contact:user.base:readonly` 未开通，日志会显示 id 尾号——功能不阻断，但需告知用户）。

---

## 完成标准

- [ ] `npm test` 全绿，含新增的 `jsonl` / `bot-log` / `action-log` / `lark.username` / `logs-panel.logic` 五组测试
- [ ] 三份重复的 `readJsonl`+`compact` 收敛为 `store/jsonl.js` 一份
- [ ] 面板展示机器人日志，两类文案（action / chat）均正确
- [ ] `userName` / `botName` / 空数据三级降级均验证过
- [ ] `/api/bot-logs` 在 `ACCESS_LOG_SKIP` 中，打开面板不再自我刷日志
- [ ] `event-log.jsonl` 照旧写盘，`/api/logs` 接口保留
- [ ] `action-log.jsonl` 审计写入保留，未被 bot-log 取代

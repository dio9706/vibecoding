# 埋点统计机器人动作 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让飞书机器人接受 `帮我统计埋点: <自然语言>`，自动理解需求、查生产埋点库、生成 HTML 报告并作为附件发回聊天。

**Architecture:** 新建独立插件 `src/plugins/tracking-stats/`（order 16）。两阶段 Haiku 推理把口语转成结构化 QuerySpec（模型永远碰不到 SQL），纯函数负责召回与硬校验，Python 脚本连生产只读库跑参数化 SQL 并渲染内联 SVG 的 HTML，最后经新增的 `lark.uploadFile/sendFile` 送达。

**Tech Stack:** Node 20 + ESM、`node --test`、`@larksuiteoapi/node-sdk` 1.71.1、Python 3.11 + pymysql、MySQL（生产只读账号）

**Spec:** `docs/superpowers/specs/2026-08-19-tracking-stats-design.md`

---

## ⚠️ 本项目规矩（覆盖 skill 默认行为）

**所有改动留在工作区，不做任何 git 提交。** 提交时机由用户掌控。因此本计划中**没有 commit 步骤** —— 每个任务以「跑测试通过」收尾即可。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/shared/trusted-ids.js` | 可信名单解析 + `isTrustedSubmitter` 上移至此 | 修改 |
| `src/plugins/team-tools/trusted-trigger.js` | 原样再导出 `isTrustedSubmitter`，保持既有调用不变 | 修改 |
| `src/plugins/team-tools/{bug-patrol,status-report,feedback}/index.js` | 修复 `resolveTrustedOpenIds` 误传参 | 修改 |
| `scripts/sync-event-dict.mjs` | 从 compass-agent 解析字典生成快照 | 新建 |
| `data/event-dict.json` | 事件/页面字典快照 | 生成 |
| `src/plugins/tracking-stats/logic.js` | 纯函数：触发解析、召回、区间收敛、QuerySpec 校验、摘要文案 | 新建 |
| `src/plugins/tracking-stats/logic.test.js` | 上述纯函数的单测 | 新建 |
| `src/plugins/tracking-stats/dict.js` | 字典快照加载与缓存 | 新建 |
| `src/plugins/tracking-stats/understand.js` | 阶段 A/B 的 prompt 与 LLM 调用 | 新建 |
| `src/plugins/tracking-stats/index.js` | feature 注册、门禁、编排、回消息 | 新建 |
| `src/plugins/index.js` | 插件清单登记 | 修改 |
| `src/integrations/lark.js` | 新增 `uploadFile` / `sendFile` | 修改 |
| `src/plugins/tracking-stats/tracking_report.py` | 连库、参数化 SQL、渲染 HTML | 新建 |
| `.env.example` | 新增数据库配置项说明 | 修改 |

**为什么 logic.js 单文件而非再拆**：五组纯函数总量约 300 行，同属「把一句话变成一份可执行查询计划」这一个职责，拆开反而要在文件间来回跳。参照 `bug-patrol/logic.js` 的既有粒度。

---

## Task 1: 修复可信名单解析并上移门禁函数

**背景（这是一个真实存在的 bug，不是重构洁癖）**

`src/shared/trusted-ids.js:14` 的签名是 `resolveTrustedOpenIds(myFeishuOpenId)`（单参数、取字符串），但有 4 处调用点仍按旧签名传参：

```js
resolveTrustedOpenIds(getActiveBot(), config.lark.trustedOpenIds)
```

传进去的是 bot **对象**，函数返回 `[botObject]`，随后 `trustedOpenIds.includes(openIdString)` 永远为 `false`。

**实际后果**：`\10001` / `\10002` 的可信名单判定完全失效，只有 `role === 'owner'` 这条分支还活着；`feedback` 的「可信提交人跳过 AI 评审门」也失效。正确用法见 `src/plugins/feishu-relay/index.js:59` 与 `src/entrypoints/web/req-inspect.js:53`：`resolveTrustedOpenIds(getMyFeishuOpenId())`。

新插件要用同一把门禁尺子，不能把这个错误复制一份，所以先修。

同时把 `isTrustedSubmitter` 从 `team-tools/trusted-trigger.js` 上移到 `shared/trusted-ids.js` —— **插件之间禁止互相 import**（`shared/trusted-ids.js:5-8` 已记录此约束：跨插件依赖会让「停用某插件」变成「另一个插件也一起挂掉」）。`tracking-stats` 是独立插件，不能 import `team-tools` 的文件。

**Files:**
- Modify: `src/shared/trusted-ids.js`
- Modify: `src/plugins/team-tools/trusted-trigger.js`
- Modify: `src/plugins/team-tools/bug-patrol/index.js:20,57`
- Modify: `src/plugins/team-tools/status-report/index.js:55`
- Modify: `src/plugins/team-tools/feedback/index.js:135,256`
- Test: `src/shared/trusted-ids.test.js`

- [ ] **Step 1: 写失败测试**

新建 `src/shared/trusted-ids.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTrustedOpenIds, isTrustedSubmitter } from './trusted-ids.js';

test('resolveTrustedOpenIds：单 open_id → 单元素数组；空 → 空数组', () => {
  assert.deepEqual(resolveTrustedOpenIds('ou_abc'), ['ou_abc']);
  assert.deepEqual(resolveTrustedOpenIds(''), []);
  assert.deepEqual(resolveTrustedOpenIds(undefined), []);
});

test('resolveTrustedOpenIds：传对象（旧签名误用）不得产出对象元素', () => {
  // 回归锚点：曾有 4 处调用点传 bot 对象进来，导致 includes(openId) 永远 false，
  // 可信名单门禁静默失效，只剩 role==='owner' 生效。
  const out = resolveTrustedOpenIds({ id: 'bot_x' });
  assert.deepEqual(out, [], '非字符串一律视为未配置');
});

test('isTrustedSubmitter：owner 直通', () => {
  assert.equal(isTrustedSubmitter({ user: { id: 'ou_x', role: 'owner' } }, []), true);
});

test('isTrustedSubmitter：名单命中', () => {
  assert.equal(isTrustedSubmitter({ user: { id: 'ou_a', role: 'guest' } }, ['ou_a']), true);
});

test('isTrustedSubmitter：名单不命中 / 无 id / 名单非数组', () => {
  assert.equal(isTrustedSubmitter({ user: { id: 'ou_b', role: 'guest' } }, ['ou_a']), false);
  assert.equal(isTrustedSubmitter({ user: { role: 'guest' } }, ['ou_a']), false);
  assert.equal(isTrustedSubmitter({ user: { id: 'ou_a', role: 'guest' } }, 'ou_a'), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --test-name-pattern="isTrustedSubmitter"`
Expected: FAIL —— `isTrustedSubmitter` 尚未从 `trusted-ids.js` 导出（`SyntaxError` 或 `undefined is not a function`）

- [ ] **Step 3: 改 `src/shared/trusted-ids.js`**

把 `resolveTrustedOpenIds` 改成只认字符串，并把 `isTrustedSubmitter` 搬进来：

```js
/**
 * 可信提交人名单出口：取基础设置中「我的飞书 open_id」作为唯一可信提交人。
 * 单 open_id → 单元素数组；未填则返回空数组。
 *
 * 只认字符串：历史上本函数签名是 (bot, envList)，改签名后有 4 处调用点没跟着改，
 * 仍传 bot 对象进来 —— 返回 [对象] 让 includes(openIdStr) 永远 false，
 * 可信名单门禁**静默失效**（只剩 role==='owner' 兜着），排查成本极高。
 * 这里显式做类型闸：非字符串一律当未配置，宁可门禁关死也不要看起来在工作却没工作。
 */
export function resolveTrustedOpenIds(myFeishuOpenId) {
  const id = typeof myFeishuOpenId === 'string' ? myFeishuOpenId.trim() : '';
  return id ? [id] : [];
}

/**
 * 是否可信提交人：设置页可信名单命中，或 role=owner（与 feedback 直通判定同口径）。
 * 名单由调用方经 resolveTrustedOpenIds 解析后传入。
 *
 * 放内核（shared/）而不留在 team-tools/trusted-trigger.js：tracking-stats 是独立插件，
 * 而插件之间禁止互相 import（跨插件依赖会让「停用某插件」变成「另一个插件一起挂掉」）。
 * @param {{ user?: { id?: string, role?: string } }} ctx
 * @param {string[]} trustedOpenIds
 */
export function isTrustedSubmitter(ctx, trustedOpenIds) {
  if (ctx?.user?.role === 'owner') return true;
  const id = ctx?.user?.id;
  return !!id && (Array.isArray(trustedOpenIds) ? trustedOpenIds : []).includes(id);
}
```

（文件中原有的 `canOperateRelay` 保持不动。）

- [ ] **Step 4: 改 `src/plugins/team-tools/trusted-trigger.js` 为再导出**

删掉其中的 `isTrustedSubmitter` 函数体，改为：

```js
/**
 * 可信提交人专属指令的共用纯函数 —— bug-patrol / status-report 共用。
 * 设计铁律（用户拍板）：指令只认「指定文案严格匹配」（去首尾空白后全等），
 * 绝不做模糊/前缀/LLM 识别 —— 宁可不触发，也不要把普通消息误认成指令。
 *
 * isTrustedSubmitter 已上移内核 shared/trusted-ids.js（独立插件也要用同一把尺子，
 * 而插件之间禁止互相 import）。此处原样再导出，既有调用点无需改动。
 */
export { isTrustedSubmitter } from '../../shared/trusted-ids.js';

/**
 * 消息是否全等命中触发文案之一（去首尾空白，大小写敏感）。
 * @param {unknown} text
 * @param {string[]} triggers
 */
export function matchesExactTrigger(text, triggers) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return false;
  return (Array.isArray(triggers) ? triggers : []).includes(t);
}
```

- [ ] **Step 5: 修 4 处误传参调用点**

`src/plugins/team-tools/bug-patrol/index.js` —— 第 20 行的 import 改为从 store 取 open_id：

```js
import { getActiveBot, getMyFeishuOpenId } from '../../../store/settings.js';
```

（删除 `import { resolveTrustedOpenIds } from '../feedback/logic.js';`，改从内核导入）

```js
import { resolveTrustedOpenIds } from '../../../shared/trusted-ids.js';
```

第 57 行改为：

```js
function isTrusted(ctx) {
  return isTrustedSubmitter(ctx, resolveTrustedOpenIds(getMyFeishuOpenId()));
}
```

`src/plugins/team-tools/status-report/index.js:55` 同样改为 `resolveTrustedOpenIds(getMyFeishuOpenId())`，并补上 `getMyFeishuOpenId` 的 import。

`src/plugins/team-tools/feedback/index.js:135` 与 `:256` 同样改为 `resolveTrustedOpenIds(getMyFeishuOpenId())`。

> 注意：若 `getActiveBot()` 在这些文件的其它地方仍被使用，保留其 import；只替换 `resolveTrustedOpenIds` 的入参。

- [ ] **Step 6: 运行全量测试**

Run: `npm test`
Expected: PASS，且总数不少于改动前（`trusted-ids.test.js` 新增 5 例）

---

## Task 2: 埋点索引同步脚本（双源合并）

> **本任务在实现期被重写。** 初版只从 `user_path_mapping.py` 取字典，实测发现字典 ≠ 埋点全集：
> 近 30 天生产库有 593 个事件，其中 **331 个（56%）字典里没有中文名**；页面维度更糟 ——
> 字典 key 无前导斜杠、库内有，**直接查 0 命中且不报错**（安静返回空表，报告写「该时段无数据」）。
> 现改为「生产库为准 + 字典作注解」的双源合并，详见 spec §2.2。

**Files:**
- Create: `scripts/sync-event-dict.mjs`
- Generate: `data/event-dict.json`
- Modify: `.gitignore`（`scripts/*` 规则会吞掉新脚本，需加白名单例外）

**产出结构**（数组而非 map —— 条目要带 count/live/named，字符串映射装不下）：

```json
{
  "syncedAt": "...", "sourceCommit": "35022b1f", "liveWindowDays": 90,
  "events": [{ "name": "chat_sse_send", "label": "会话发送", "count": 68210, "live": true, "named": true }],
  "pages":  [{ "path": "/pages/chat/index", "key": "pages/chat/index", "label": "会话页", "count": 52130, "live": true, "named": true }],
  "categories": [{ "prefix": "baby_food", "label": "宝宝辅食", "count": 74 }]
}
```

关键约定：**`pages[].path` 存库内原始值（带前导斜杠），SQL 用它；`key` 是去前导斜杠的归一化形式，仅用于与字典比对。** 搞反了就是 0 命中。

- [ ] **Step 1: 写同步脚本（双源）**

工作区已存在一份**初版可用**的 `scripts/sync-event-dict.mjs`（仅字典单源）。它的字典解析部分已验证正确（677 事件 / 82 页面，含转义双引号处理），**不要重写，在其基础上增量改造**。

改造内容：

**A. 新增：从生产库拉真实清单**

在字典解析之后、构建 snapshot 之前，插入一段库查询。用 `mysql2`（若项目未装则改用 `child_process` 调 Python，见下方备选）：

```js
/**
 * 从生产埋点库拉近 N 天真实出现过的事件与页面。
 *
 * 为什么必须查库：user_path_mapping.py 是人工维护的中文名对照表，维护滞后于代码 ——
 * 实测近 30 天生产库 593 个事件里有 331 个（56%）字典查不到，且全是在跑的核心功能
 * （付费墙、过敏记录、语音）。页面更糟：字典 key 无前导斜杠、库内有，
 * 直接拿字典 key 去 IN 查是 0 命中且不报错，安静返回空表。
 * 所以：全集以库为准，字典只作中文名注解。
 */
const LIVE_WINDOW_DAYS = 90;

async function fetchLiveIndex() {
  const conn = await mysql.createConnection({
    host: process.env.TRACKING_DB_HOST,
    port: Number(process.env.TRACKING_DB_PORT || 3306),
    database: process.env.TRACKING_DB_NAME || 'compass_prod',
    user: process.env.TRACKING_DB_USER,
    password: process.env.TRACKING_DB_PASSWORD,
    connectTimeout: 15000,
  });
  try {
    const sinceMs = Date.now() - LIVE_WINDOW_DAYS * 86400000;
    const [evRows] = await conn.query(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(properties,'$.event_name')) AS name, COUNT(*) AS cnt
         FROM statistics_data
        WHERE time > ? AND is_deleted = 0
          AND JSON_EXTRACT(properties,'$.event_name') IS NOT NULL
        GROUP BY name`,
      [sinceMs],
    );
    const [pgRows] = await conn.query(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(properties,'$."$url_path"')) AS path, COUNT(*) AS cnt
         FROM statistics_data
        WHERE time > ? AND is_deleted = 0 AND event = '$MPViewScreen'
          AND JSON_EXTRACT(properties,'$."$url_path"') IS NOT NULL
        GROUP BY path`,
      [sinceMs],
    );
    return {
      events: new Map(evRows.filter((r) => r.name).map((r) => [r.name, Number(r.cnt)])),
      pages: new Map(pgRows.filter((r) => r.path).map((r) => [r.path, Number(r.cnt)])),
    };
  } finally {
    await conn.end();
  }
}
```

**若 `mysql2` 未安装**：不要为此新增 Node 依赖。改为用 `execFileSync` 调一小段 Python（项目已确认有 `pymysql`），让它把上面两个查询的结果以 JSON 打到 stdout，Node 侧解析。哪种方式都可以，选好后在注释里写明理由。

**B. 新增：路径归一化 + 双源合并**

```js
/** 页面路径归一化：去前导斜杠。字典 key 无斜杠、库内值有，不归一就永远对不上 */
const normPath = (p) => String(p || '').replace(/^\/+/, '');

/**
 * 合并：库为事实（决定全集与频次），字典为注解（决定中文名）。
 * 字典独有的条目保留但 live=false —— 历史事件仍可查，只是召回排序靠后。
 */
function mergeEvents(dictMap, liveMap) {
  const out = [];
  const seen = new Set();
  for (const [name, count] of liveMap) {
    const label = dictMap[name];
    out.push({ name, label: label || name, count, live: true, named: !!label });
    seen.add(name);
  }
  for (const [name, label] of Object.entries(dictMap)) {
    if (seen.has(name)) continue;
    out.push({ name, label, count: 0, live: false, named: true });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function mergePages(dictMap, liveMap) {
  // 字典 key 归一化后建索引，供库内路径反查中文名
  const byKey = new Map(Object.entries(dictMap).map(([k, v]) => [normPath(k), v]));
  const out = [];
  const usedKeys = new Set();
  for (const [path, count] of liveMap) {
    const key = normPath(path);
    const label = byKey.get(key);
    out.push({ path, key, label: label || path, count, live: true, named: !!label });
    usedKeys.add(key);
  }
  for (const [k, label] of byKey) {
    if (usedKeys.has(k)) continue;
    // 字典独有的历史页面：库里没有原始值，path 回退为带斜杠形式（查不到也无妨，live=false）
    out.push({ path: `/${k}`, key: k, label, count: 0, live: false, named: true });
  }
  return out.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}
```

**C. 改造：snapshot 结构与统计输出**

`events` / `pages` 从对象改成上面 merge 函数产出的数组；`categories` 的输入相应改为「从 events 数组重建 name→label 映射」后再聚类（保持既有聚类逻辑不变）。

同步完成后 console 输出要能一眼看出字典维护缺口：

```js
const namedEv = snapshot.events.filter((e) => e.live && e.named).length;
const liveEv = snapshot.events.filter((e) => e.live).length;
console.log(`✅ 埋点索引已生成：${outFile}`);
console.log(`   事件：库内活跃 ${liveEv} 个（其中 ${namedEv} 个有中文名，${liveEv - namedEv} 个缺）+ 历史 ${snapshot.events.length - liveEv} 个`);
console.log(`   页面：库内活跃 ${snapshot.pages.filter((p) => p.live).length} 个 + 历史 ${snapshot.pages.filter((p) => !p.live).length} 个`);
console.log(`   来源 commit：${sourceCommit} · 窗口 ${LIVE_WINDOW_DAYS} 天`);
```

- [ ] **Step 2: 运行同步并核对**

```
node scripts/sync-event-dict.mjs "C:/Users/DELL/Desktop/compass-agent"
```
（需先在环境中提供 `TRACKING_DB_HOST` / `TRACKING_DB_USER` / `TRACKING_DB_PASSWORD`；值见 `.env`，若 `.env` 尚无这几项，参考 compass-agent 的 `scripts/user_path_analyzer.py:31-37`）

Expected（基于 2026-08-19 实测，允许小幅浮动）：
- 事件：库内活跃约 **600 个**（近 90 天窗口应 ≥ 近 30 天的 593），其中约 **44%** 有中文名
- 页面：库内活跃约 **82 个**
- 若「有中文名」的比例接近 100%，说明归一化或合并写反了，**必须查清**

- [ ] **Step 3: 验证致命项 —— 页面路径可用**

```
node -e "const d=require('./data/event-dict.json');const p=d.pages.find(x=>x.live);console.log(JSON.stringify(p));console.log('path 带前导斜杠:', p.path.startsWith('/'), '| key 不带:', !p.key.startsWith('/'))"
```
Expected: `path 带前导斜杠: true | key 不带: true`

**这是本任务最关键的验收点。** `path` 是 SQL 要用的值，必须与库内原始格式完全一致；搞反就是 0 命中且不报错。

- [ ] **Step 4: 验证字典缺名事件确实被收进来了**

```
node -e "const d=require('./data/event-dict.json');const e=d.events.find(x=>x.name==='baby_food_paywall_pay_success');console.log(e?JSON.stringify(e):'❌ 缺失')"
```
Expected: 打印出该条目，`named: false`、`count > 0`、`live: true`

这个事件在字典里没有，但生产库里正在跑 —— 它能被收进来，才证明双源合并真的生效了。

- [ ] **Step 5: 修 .gitignore**

`.gitignore:45` 的 `scripts/*` 会把新脚本一起忽略掉（该规则下方已有一组 `!scripts/build-win.sh` 之类的白名单例外，注释说明是防止 `reset_onboarding.py` 那类含账密的脚本入库）。同步脚本不含凭证（走环境变量），追加白名单例外：

```
!scripts/sync-event-dict.mjs
```

`data/` **不加忽略**（保持入库）。理由：选快照方案的初衷就是「不依赖两个仓库在同一台机器上」，快照不入库的话这个依赖只是从运行时挪到部署时，方案价值被抵消。

---

## Task 3: logic.js —— 触发前缀解析

**Files:**
- Create: `src/plugins/tracking-stats/logic.js`
- Create: `src/plugins/tracking-stats/logic.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/plugins/tracking-stats/logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRACKING_PREFIX, parseTrackingCommand } from './logic.js';

test('TRACKING_PREFIX 回归锚点', () => {
  assert.equal(TRACKING_PREFIX, '帮我统计埋点');
});

test('parseTrackingCommand：中英文冒号与无冒号都认', () => {
  assert.deepEqual(parseTrackingCommand('帮我统计埋点: 最近7天分享功能'), { hit: true, body: '最近7天分享功能' });
  assert.deepEqual(parseTrackingCommand('帮我统计埋点：最近7天分享功能'), { hit: true, body: '最近7天分享功能' });
  assert.deepEqual(parseTrackingCommand('帮我统计埋点 最近7天分享功能'), { hit: true, body: '最近7天分享功能' });
});

test('parseTrackingCommand：正文可以是任意自然语言（含"埋点"二字也不受影响）', () => {
  const r = parseTrackingCommand('帮我统计埋点: 帮我拿最近一个月的宝宝辅食页面的埋点');
  assert.deepEqual(r, { hit: true, body: '帮我拿最近一个月的宝宝辅食页面的埋点' });
});

test('parseTrackingCommand：只发前缀 → 命中但正文为空（调用方据此追问）', () => {
  assert.deepEqual(parseTrackingCommand('帮我统计埋点'), { hit: true, body: '' });
  assert.deepEqual(parseTrackingCommand('帮我统计埋点：  '), { hit: true, body: '' });
});

test('parseTrackingCommand：前缀不在开头一律不命中', () => {
  // 回归锚点：沿用 intent-keywords 的铁律 —— 历史事故是整篇文档贴进来被全文命中而误判
  assert.deepEqual(parseTrackingCommand('这个需求要帮我统计埋点: 分享'), { hit: false, body: '' });
  assert.deepEqual(parseTrackingCommand('文档里写了帮我统计埋点这几个字'), { hit: false, body: '' });
});

test('parseTrackingCommand：允许行首空白，但不允许其它前置文字', () => {
  assert.deepEqual(parseTrackingCommand('  帮我统计埋点: 分享'), { hit: true, body: '分享' });
});

test('parseTrackingCommand：非字符串与空串安全返回', () => {
  assert.deepEqual(parseTrackingCommand(null), { hit: false, body: '' });
  assert.deepEqual(parseTrackingCommand(''), { hit: false, body: '' });
  assert.deepEqual(parseTrackingCommand(123), { hit: false, body: '' });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/plugins/tracking-stats/logic.test.js`
Expected: FAIL —— `Cannot find module './logic.js'`

- [ ] **Step 3: 写实现**

创建 `src/plugins/tracking-stats/logic.js`（本任务只写这一段，后续任务往同一文件追加）：

```js
/**
 * 埋点统计的纯函数集合 —— 触发解析、召回、区间收敛、QuerySpec 校验、摘要文案。
 * 全部无副作用、无 IO，便于单测覆盖到每条分支。
 */

/** 触发前缀（回归锚点：改动此值等于改变用户契约，必须同步改文档与提示语） */
export const TRACKING_PREFIX = '帮我统计埋点';

/**
 * 前缀必须在**消息开头**。
 * 沿用 src/app/intent-keywords.js 的铁律：只匹配开头 ——
 * 历史事故是整篇接口文档被贴进来，全文命中关键词而误判意图。
 * 分隔符（冒号/空白）可有可无，正文不做任何限制。
 */
const CMD_RE = new RegExp(`^\\s*${TRACKING_PREFIX}\\s*[:：]?\\s*([\\s\\S]*)$`);

/**
 * 解析触发指令。
 * @param {unknown} text
 * @returns {{ hit: boolean, body: string }} hit=命中前缀；body=正文（只发前缀时为空串，调用方据此追问）
 */
export function parseTrackingCommand(text) {
  const t = typeof text === 'string' ? text : '';
  if (!t.trim()) return { hit: false, body: '' };
  const m = CMD_RE.exec(t);
  if (!m) return { hit: false, body: '' };
  return { hit: true, body: (m[1] || '').trim() };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/plugins/tracking-stats/logic.test.js`
Expected: PASS，8 例全绿

---

## Task 4: logic.js —— 索引召回（含频次权重）

> **本任务在实现期随 Task 2 一并调整**：索引结构从 `Record<name,label>` 改为带 `count`/`live` 的数组，
> 召回排序因此从「纯字面匹配强度」升级为「字面强度 + 真实频次」。

**Files:**
- Modify: `src/plugins/tracking-stats/logic.js`（追加）
- Modify: `src/plugins/tracking-stats/logic.test.js`（追加）

- [ ] **Step 1: 写失败测试**

在 `logic.test.js` 的 import 中追加 `indexDict, recallCandidates`，并在文件末尾追加：

```js
const RAW_DICT = {
  events: [
    { name: 'dish_share_wechat', label: '分享到微信', count: 5000, live: true, named: true },
    { name: 'dish_share_save_photo', label: '保存分享图片', count: 300, live: true, named: true },
    { name: 'dish_share_page_load', label: '分享页加载', count: 20, live: true, named: true },
    { name: 'dish_share_legacy', label: '旧版分享', count: 0, live: false, named: true },
    { name: 'chat_sse_send', label: '会话发送', count: 68210, live: true, named: true },
    { name: 'baby_food_paywall_pay_success', label: 'baby_food_paywall_pay_success', count: 1820, live: true, named: false },
    { name: 'order_confirm_click_submit', label: '确认订单提交', count: 900, live: true, named: true },
  ],
  pages: [
    { path: '/pages-agent/baby-food/index', key: 'pages-agent/baby-food/index', label: '宝宝辅食首页', count: 4000, live: true, named: true },
    { path: '/pages/chat/index', key: 'pages/chat/index', label: '会话页', count: 52130, live: true, named: true },
  ],
  categories: [],
};
const DICT = indexDict(RAW_DICT);

test('indexDict：建立 O(1) 查找索引，原数组保持不变', () => {
  assert.equal(DICT.eventIndex.get('chat_sse_send').label, '会话发送');
  assert.equal(DICT.pageIndex.get('/pages/chat/index').label, '会话页');
  assert.equal(DICT.events.length, 7);
  assert.equal(DICT.eventIndex.size, 7);
});

test('indexDict：脏输入不炸', () => {
  const d = indexDict(null);
  assert.deepEqual(d.events, []);
  assert.equal(d.eventIndex.size, 0);
});

test('recallCandidates：中文名子串命中', () => {
  const r = recallCandidates(['分享'], DICT, 'event');
  const names = r.events.map((e) => e.name);
  assert.ok(names.includes('dish_share_wechat'));
  assert.ok(names.includes('dish_share_save_photo'));
  assert.ok(names.includes('dish_share_page_load'));
  assert.deepEqual(r.pages, []);
});

test('recallCandidates：标识名子串命中（用户直接说事件名）', () => {
  const r = recallCandidates(['chat_sse'], DICT, 'event');
  assert.deepEqual(r.events.map((e) => e.name), ['chat_sse_send']);
});

test('recallCandidates：字典缺中文名的事件同样能被标识名召回', () => {
  // 回归锚点：这类事件占生产实际的一半以上，漏掉它们等于功能瞎一半
  const r = recallCandidates(['paywall'], DICT, 'event');
  assert.deepEqual(r.events.map((e) => e.name), ['baby_food_paywall_pay_success']);
});

test('recallCandidates：同族前缀扩展 —— 命中一个就把同前缀一族拉进来', () => {
  const r = recallCandidates(['保存分享图片'], DICT, 'event');
  const names = r.events.map((e) => e.name);
  assert.ok(names.includes('dish_share_wechat'), '同族 dish_share_* 应被一并召回');
  assert.ok(names.includes('dish_share_page_load'));
});

test('recallCandidates：同等字面强度下，高频事件排在低频前面', () => {
  // 频次是比字面匹配更强的相关性信号：都叫「分享」，一个月触发 5000 次的
  // 显然比触发 20 次的更可能是用户想问的那个
  const r = recallCandidates(['分享'], DICT, 'event');
  const idxWechat = r.events.findIndex((e) => e.name === 'dish_share_wechat');
  const idxLoad = r.events.findIndex((e) => e.name === 'dish_share_page_load');
  assert.ok(idxWechat < idxLoad, '5000 次的应排在 20 次的前面');
});

test('recallCandidates：已下线事件（live=false）被降权到活跃事件之后', () => {
  const r = recallCandidates(['分享'], DICT, 'event');
  const idxLegacy = r.events.findIndex((e) => e.name === 'dish_share_legacy');
  const idxLoad = r.events.findIndex((e) => e.name === 'dish_share_page_load');
  assert.ok(idxLegacy > idxLoad, '已下线的应排在活跃的之后');
  assert.ok(idxLegacy >= 0, '但不能直接丢弃 —— 用户可能就是要查历史数据');
});

test('recallCandidates：target=page 只查页面', () => {
  const r = recallCandidates(['宝宝辅食'], DICT, 'page');
  assert.deepEqual(r.pages.map((p) => p.path), ['/pages-agent/baby-food/index']);
  assert.deepEqual(r.events, []);
});

test('recallCandidates：召回的页面必须带库内原始 path（带前导斜杠）', () => {
  // 回归锚点：SQL 用的是 path 不是 key，少个斜杠就是 0 命中且不报错
  const r = recallCandidates(['会话'], DICT, 'page');
  assert.ok(r.pages[0].path.startsWith('/'));
});

test('recallCandidates：target=both 两边都查', () => {
  const r = recallCandidates(['会话'], DICT, 'both');
  assert.ok(r.events.length >= 1);
  assert.ok(r.pages.length >= 1);
});

test('recallCandidates：事件与页面合计截断到 30 条（不是各 30）', () => {
  const events = [];
  for (let i = 0; i < 40; i++) events.push({ name: `evt_x${i}`, label: `测试事件${i}`, count: i, live: true, named: true });
  const pages = [];
  for (let i = 0; i < 40; i++) pages.push({ path: `/p/x${i}`, key: `p/x${i}`, label: `测试页面${i}`, count: i, live: true, named: true });
  const r = recallCandidates(['测试'], indexDict({ events, pages }), 'both');
  assert.equal(r.events.length + r.pages.length, 30);
});

test('recallCandidates：空关键词 / 脏字典安全返回', () => {
  assert.deepEqual(recallCandidates([], DICT, 'both'), { events: [], pages: [] });
  assert.deepEqual(recallCandidates(['分享'], indexDict(null), 'both'), { events: [], pages: [] });
  assert.deepEqual(recallCandidates(null, DICT, 'both'), { events: [], pages: [] });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/plugins/tracking-stats/logic.test.js`
Expected: FAIL —— `indexDict is not a function`

- [ ] **Step 3: 写实现**

在 `logic.js` 末尾追加：

```js
/**
 * 给索引快照建 O(1) 查找表。
 *
 * 快照里 events/pages 是数组（要携带 count/live/named，字符串映射装不下），
 * 但校验环节要按标识名精确查 —— 每次线性扫 600+ 条不合适，这里一次性建 Map。
 * 纯函数：dict.js 加载时调用并缓存，测试里也能直接构造。
 */
export function indexDict(raw) {
  const events = Array.isArray(raw?.events) ? raw.events : [];
  const pages = Array.isArray(raw?.pages) ? raw.pages : [];
  return {
    events,
    pages,
    categories: Array.isArray(raw?.categories) ? raw.categories : [],
    eventIndex: new Map(events.map((e) => [e.name, e])),
    pageIndex: new Map(pages.map((p) => [p.path, p])),
    syncedAt: raw?.syncedAt || null,
  };
}

/** 召回上限：事件与页面**合计**取前 N 条（不是各 N 条）—— 精选阶段的 prompt 装不下更多 */
const RECALL_LIMIT = 30;

/** 字面匹配强度：标识名精确 > 中文名精确 > 标识名子串 > 中文名子串 > 同族扩展 */
const SCORE = { idExact: 100, labelExact: 90, idPart: 60, labelPart: 50, family: 20 };
/** 已下线条目的降权幅度 —— 降权而非丢弃：用户可能就是要查历史数据 */
const OFFLINE_PENALTY = 30;

/** 单条目对一组关键词的最高字面得分；0 表示未命中 */
function scoreEntry(id, label, keywords) {
  let best = 0;
  const lowerId = String(id).toLowerCase();
  for (const raw of keywords) {
    const kw = String(raw || '').trim();
    if (!kw) continue;
    const lowerKw = kw.toLowerCase();
    if (lowerId === lowerKw) best = Math.max(best, SCORE.idExact);
    else if (label === kw) best = Math.max(best, SCORE.labelExact);
    else if (lowerId.includes(lowerKw)) best = Math.max(best, SCORE.idPart);
    else if (label.includes(kw)) best = Math.max(best, SCORE.labelPart);
  }
  return best;
}

/**
 * 频次加成：用 log 缩放并封顶 25。
 *
 * 为什么不线性：触发次数跨 4-5 个数量级（个位数到十万级），线性加权会让
 * 一个高频但字面只是勉强沾边的事件，压过字面精确命中的低频事件。
 * log + 封顶保证「字面精确(100)」始终赢过「字面泛化(50)+ 最高频次加成(25)」。
 */
function freqBonus(count) {
  const n = Number(count) || 0;
  return n <= 0 ? 0 : Math.min(25, Math.round(Math.log10(n + 1) * 6));
}

/**
 * 三路召回后合并去重：中文名子串 / 标识名子串 / 同族前缀扩展。
 *
 * 同族扩展的意义：用户说「保存分享图片」只会字面命中一条，但他八成想看整个分享功能。
 * 命中 dish_share_save_photo 就把 dish_share_* 一族拉进候选，交给精选阶段去挑。
 *
 * @param {string[]} keywords 理解阶段产出的检索词（已做同义词扩展）
 * @param {ReturnType<typeof indexDict>} dict
 * @param {'event'|'page'|'both'} target
 * @returns {{ events: {name,label,count}[], pages: {path,label,count}[] }}
 */
export function recallCandidates(keywords, dict, target = 'both') {
  const kws = Array.isArray(keywords) ? keywords.filter((k) => String(k || '').trim()) : [];
  const events = Array.isArray(dict?.events) ? dict.events : [];
  const pages = Array.isArray(dict?.pages) ? dict.pages : [];
  if (!kws.length) return { events: [], pages: [] };

  const wantEvent = target === 'event' || target === 'both';
  const wantPage = target === 'page' || target === 'both';

  const hits = new Map(); // 标识 → { entry, kind, base }

  if (wantEvent) {
    for (const e of events) {
      const s = scoreEntry(e.name, e.label, kws);
      if (s > 0) hits.set(`e:${e.name}`, { entry: e, kind: 'event', base: s });
    }
    // 同族前缀扩展：对已命中的事件取前两段前缀，把同前缀的兄弟补进来（低分，排在直接命中之后）
    const families = new Set(
      [...hits.values()]
        .filter((h) => h.kind === 'event' && !h.entry.name.startsWith('$'))
        .map((h) => h.entry.name.split('_').slice(0, 2).join('_')),
    );
    for (const e of events) {
      if (hits.has(`e:${e.name}`) || e.name.startsWith('$')) continue;
      if (families.has(e.name.split('_').slice(0, 2).join('_'))) {
        hits.set(`e:${e.name}`, { entry: e, kind: 'event', base: SCORE.family });
      }
    }
  }

  if (wantPage) {
    for (const p of pages) {
      // 页面同时用 path 和归一化 key 参与匹配：用户可能带斜杠也可能不带
      const s = Math.max(scoreEntry(p.path, p.label, kws), scoreEntry(p.key || '', p.label, kws));
      if (s > 0) hits.set(`p:${p.path}`, { entry: p, kind: 'page', base: s });
    }
  }

  // 合并排序后统一截断：事件与页面竞争同一个 30 条预算
  const ranked = [...hits.values()]
    .map((h) => ({
      ...h,
      score: h.base + freqBonus(h.entry.count) - (h.entry.live === false ? OFFLINE_PENALTY : 0),
    }))
    .sort((a, b) => b.score - a.score || String(a.entry.name || a.entry.path).localeCompare(String(b.entry.name || b.entry.path)))
    .slice(0, RECALL_LIMIT);

  return {
    events: ranked
      .filter((h) => h.kind === 'event')
      .map((h) => ({ name: h.entry.name, label: h.entry.label, count: h.entry.count })),
    // path 必须是库内原始值（带前导斜杠）—— SQL 直接拿它去查，少个斜杠就是 0 命中且不报错
    pages: ranked
      .filter((h) => h.kind === 'page')
      .map((h) => ({ path: h.entry.path, label: h.entry.label, count: h.entry.count })),
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/plugins/tracking-stats/logic.test.js`
Expected: PASS，21 例全绿（8 触发解析 + 13 召回）

---

## Task 5: logic.js —— 时间区间收敛与 groupBy 推导

**Files:**
- Modify: `src/plugins/tracking-stats/logic.js`（追加）
- Modify: `src/plugins/tracking-stats/logic.test.js`（追加）

- [ ] **Step 1: 写失败测试**

import 追加 `normalizeRange, inferGroupBy, DEFAULT_RANGE_DAYS, MAX_RANGE_DAYS, RETENTION_DAYS`，文末追加：

```js
test('常量回归锚点', () => {
  assert.equal(DEFAULT_RANGE_DAYS, 7);
  assert.equal(MAX_RANGE_DAYS, 90);
  assert.equal(RETENTION_DAYS, 75);
});

test('normalizeRange：正常区间原样通过', () => {
  const r = normalizeRange({ start: '2026-08-12', end: '2026-08-19' }, '2026-08-19');
  assert.equal(r.start, '2026-08-12');
  assert.equal(r.end, '2026-08-19');
  assert.deepEqual(r.notes, []);
});

test('normalizeRange：缺省 / 非法 → 近 7 天', () => {
  const r = normalizeRange(null, '2026-08-19');
  assert.equal(r.start, '2026-08-13'); // 含今天共 7 天
  assert.equal(r.end, '2026-08-19');
  assert.ok(r.notes.some((n) => n.includes('默认')));
});

test('normalizeRange：跨度超 90 天 → 收敛并留痕', () => {
  const r = normalizeRange({ start: '2025-01-01', end: '2026-08-19' }, '2026-08-19');
  assert.equal(r.end, '2026-08-19');
  assert.equal(r.start, '2026-05-22'); // 含首尾共 90 天
  assert.ok(r.notes.some((n) => n.includes('90')));
});

test('normalizeRange：早于保留期 → 抬到保留期起点并留痕', () => {
  const r = normalizeRange({ start: '2026-01-01', end: '2026-01-31' }, '2026-08-19');
  assert.equal(r.start, '2026-06-05'); // 今天往前 75 天
  assert.ok(r.notes.some((n) => n.includes('保留')));
});

test('normalizeRange：start 晚于 end → 互换', () => {
  const r = normalizeRange({ start: '2026-08-19', end: '2026-08-12' }, '2026-08-19');
  assert.equal(r.start, '2026-08-12');
  assert.equal(r.end, '2026-08-19');
});

test('normalizeRange：end 超过今天 → 收敛到今天', () => {
  const r = normalizeRange({ start: '2026-08-12', end: '2026-12-31' }, '2026-08-19');
  assert.equal(r.end, '2026-08-19');
});

test('normalizeRange：includesToday 标记', () => {
  assert.equal(normalizeRange({ start: '2026-08-12', end: '2026-08-19' }, '2026-08-19').includesToday, true);
  assert.equal(normalizeRange({ start: '2026-08-10', end: '2026-08-15' }, '2026-08-19').includesToday, false);
});

test('inferGroupBy：跨度 > 1 天按天，单日不分组', () => {
  assert.equal(inferGroupBy({ start: '2026-08-12', end: '2026-08-19' }), 'day');
  assert.equal(inferGroupBy({ start: '2026-08-19', end: '2026-08-19' }), 'none');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/plugins/tracking-stats/logic.test.js`
Expected: FAIL —— `normalizeRange is not a function`

- [ ] **Step 3: 写实现**

在 `logic.js` 末尾追加：

```js
/** 未提及时间时的默认跨度（天，含今天） */
export const DEFAULT_RANGE_DAYS = 7;
/** 单次查询跨度上限（天）—— 超过会让 SQL 扫描量和 HTML 体积一起失控 */
export const MAX_RANGE_DAYS = 90;
/** 埋点数据保留期（天）—— 实测约 2.5 个月，取保守值 */
export const RETENTION_DAYS = 75;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' → UTC 零点毫秒（只做日期算术，不涉时区换算，故用 UTC 避免本机时区干扰） */
function dayToMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** UTC 毫秒 → 'YYYY-MM-DD' */
function msToDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * 把阶段 A 产出的区间收敛到可执行范围，并记录每一次调整。
 *
 * notes 不是可选装饰：区间被静默改写而报告上不写，用户会拿着一份「我以为查了半年」
 * 的报告去开会。任何调整都必须能在报告脚注里被看到。
 *
 * @param {{start?:string,end?:string}|null} range 阶段 A 的产出
 * @param {string} today 'YYYY-MM-DD'，北京时区的今天（由调用方注入，便于测试）
 * @returns {{ start:string, end:string, days:number, includesToday:boolean, notes:string[] }}
 */
export function normalizeRange(range, today) {
  const notes = [];
  const todayMs = dayToMs(today);
  let startMs = dayToMs(range?.start);
  let endMs = dayToMs(range?.end);

  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    endMs = todayMs;
    startMs = todayMs - (DEFAULT_RANGE_DAYS - 1) * DAY_MS;
    notes.push(`未识别到时间范围，默认统计最近 ${DEFAULT_RANGE_DAYS} 天`);
  }

  if (startMs > endMs) {
    [startMs, endMs] = [endMs, startMs];
    notes.push('起止时间顺序有误，已自动互换');
  }

  if (endMs > todayMs) {
    endMs = todayMs;
    notes.push('结束时间晚于今天，已收敛到今天');
  }

  const earliestMs = todayMs - RETENTION_DAYS * DAY_MS;
  if (startMs < earliestMs) {
    startMs = earliestMs;
    notes.push(`埋点数据仅保留约 ${RETENTION_DAYS} 天，起始时间已抬至 ${msToDay(startMs)}`);
  }

  const days = Math.round((endMs - startMs) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    startMs = endMs - (MAX_RANGE_DAYS - 1) * DAY_MS;
    notes.push(`单次查询最多 ${MAX_RANGE_DAYS} 天，起始时间已收敛到 ${msToDay(startMs)}`);
  }

  return {
    start: msToDay(startMs),
    end: msToDay(endMs),
    days: Math.round((endMs - startMs) / DAY_MS) + 1,
    includesToday: endMs === todayMs,
    notes,
  };
}

/**
 * groupBy 由跨度推导，不交给模型 —— 这一项没有歧义空间，交出去只会平白多一个出错面。
 * @returns {'day'|'none'}
 */
export function inferGroupBy(range) {
  return range?.start && range?.end && range.start !== range.end ? 'day' : 'none';
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/plugins/tracking-stats/logic.test.js`
Expected: PASS，24 例全绿

---

## Task 6: logic.js —— QuerySpec 校验

> **本任务在实现期随 Task 2 一并调整**：白名单查找从对象 `in` 判断改为索引 Map 查找。

**Files:**
- Modify: `src/plugins/tracking-stats/logic.js`（追加）
- Modify: `src/plugins/tracking-stats/logic.test.js`（追加）

- [ ] **Step 1: 写失败测试**

import 追加 `validateSelection, MAX_TARGETS`，文末追加（复用 Task 4 里已定义的 `DICT`）：

```js
test('MAX_TARGETS 回归锚点', () => {
  assert.equal(MAX_TARGETS, 20);
});

test('validateSelection：索引里不存在的事件名一律剔除（模型编造防线）', () => {
  const r = validateSelection(
    { events: [{ name: 'dish_share_wechat' }, { name: 'totally_made_up_event' }], pages: [] },
    DICT,
  );
  assert.deepEqual(r.events, [{ name: 'dish_share_wechat', label: '分享到微信' }]);
  assert.deepEqual(r.dropped, ['totally_made_up_event']);
});

test('validateSelection：label 一律以索引为准，忽略模型自己写的', () => {
  const r = validateSelection({ events: [{ name: 'chat_sse_send', label: '模型瞎编的名字' }] }, DICT);
  assert.equal(r.events[0].label, '会话发送');
});

test('validateSelection：字典缺中文名的事件照常通过，label 回退为标识名', () => {
  const r = validateSelection({ events: [{ name: 'baby_food_paywall_pay_success' }] }, DICT);
  assert.equal(r.empty, false);
  assert.equal(r.events[0].label, 'baby_food_paywall_pay_success');
});

test('validateSelection：页面走白名单，且必须用库内原始 path', () => {
  const r = validateSelection(
    { pages: [{ path: '/pages/chat/index' }, { path: '/pages/nope' }] },
    DICT,
  );
  assert.deepEqual(r.pages, [{ path: '/pages/chat/index', label: '会话页' }]);
  assert.deepEqual(r.dropped, ['/pages/nope']);
});

test('validateSelection：缺前导斜杠的页面路径被剔除而不是静默放行', () => {
  // 回归锚点：字典 key 无斜杠、库内有。若这里放行归一化形式，
  // SQL 会拿着 'pages/chat/index' 去查，0 命中且不报错 —— 报告写「该时段无数据」
  const r = validateSelection({ pages: [{ path: 'pages/chat/index' }] }, DICT);
  assert.equal(r.empty, true);
  assert.deepEqual(r.dropped, ['pages/chat/index']);
});

test('validateSelection：全部剔除后 empty=true（调用方据此不查询）', () => {
  const r = validateSelection({ events: [{ name: 'nope' }] }, DICT);
  assert.equal(r.empty, true);
});

test('validateSelection：合计超过 20 条截断', () => {
  const events = [];
  const picks = [];
  for (let i = 0; i < 25; i++) {
    events.push({ name: `evt_${i}`, label: `事件${i}`, count: 1, live: true, named: true });
    picks.push({ name: `evt_${i}` });
  }
  const r = validateSelection({ events: picks }, indexDict({ events, pages: [] }));
  assert.equal(r.events.length, 20);
  assert.ok(r.truncated);
});

test('validateSelection：去重（模型重复选同一个）', () => {
  const r = validateSelection(
    { events: [{ name: 'chat_sse_send' }, { name: 'chat_sse_send' }] },
    DICT,
  );
  assert.equal(r.events.length, 1);
});

test('validateSelection：脏输入安全返回 empty', () => {
  assert.equal(validateSelection(null, DICT).empty, true);
  assert.equal(validateSelection({ events: 'nope' }, DICT).empty, true);
  assert.equal(validateSelection({ events: [{ name: 'chat_sse_send' }] }, indexDict(null)).empty, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/plugins/tracking-stats/logic.test.js`
Expected: FAIL —— `validateSelection is not a function`

- [ ] **Step 3: 写实现**

在 `logic.js` 末尾追加：

```js
/** 单次查询的事件+页面合计上限 —— 防止模型一激动把整个分类全选上 */
export const MAX_TARGETS = 20;

/**
 * 精选阶段产出的硬校验：**只有索引里真实存在的标识才被采纳**。
 *
 * 这是整条链路上唯一挡住「模型编造标识」的闸门。编造出的事件名查不到数据，
 * 呈现出来是一张「该事件 0 次」的表 —— 比报错危险得多，因为它看着像个有效结论。
 *
 * label 一律以索引为准：模型写的中文名可能似是而非，报告上必须显示真名。
 * 页面必须完全匹配库内原始 path（带前导斜杠）—— 归一化形式拿去查是 0 命中且不报错。
 *
 * @param {{events?:{name:string}[], pages?:{path:string}[]}} picked 精选阶段原始产出
 * @param {ReturnType<typeof indexDict>} dict
 * @returns {{ events:{name,label}[], pages:{path,label}[], dropped:string[], truncated:boolean, empty:boolean }}
 */
export function validateSelection(picked, dict) {
  const eventIndex = dict?.eventIndex instanceof Map ? dict.eventIndex : new Map();
  const pageIndex = dict?.pageIndex instanceof Map ? dict.pageIndex : new Map();
  const dropped = [];

  const rawEvents = Array.isArray(picked?.events) ? picked.events : [];
  const rawPages = Array.isArray(picked?.pages) ? picked.pages : [];

  const seen = new Set();
  const events = [];
  for (const e of rawEvents) {
    const name = String(e?.name || '').trim();
    if (!name || seen.has(`e:${name}`)) continue;
    const entry = eventIndex.get(name);
    if (!entry) { dropped.push(name); continue; }
    seen.add(`e:${name}`);
    events.push({ name, label: entry.label || name });
  }

  const pages = [];
  for (const p of rawPages) {
    const path = String(p?.path || '').trim();
    if (!path || seen.has(`p:${path}`)) continue;
    const entry = pageIndex.get(path);
    if (!entry) { dropped.push(path); continue; }
    seen.add(`p:${path}`);
    pages.push({ path, label: entry.label || path });
  }

  // 合计截断：事件优先（业务事件的信息量通常高于页面 PV）
  let truncated = false;
  const outEvents = events.slice(0, MAX_TARGETS);
  const outPages = pages.slice(0, Math.max(0, MAX_TARGETS - outEvents.length));
  if (outEvents.length < events.length || outPages.length < pages.length) truncated = true;

  return {
    events: outEvents,
    pages: outPages,
    dropped,
    truncated,
    empty: outEvents.length === 0 && outPages.length === 0,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/plugins/tracking-stats/logic.test.js`
Expected: PASS，39 例全绿

---

## Task 7: logic.js —— 摘要文案与文件名

**Files:**
- Modify: `src/plugins/tracking-stats/logic.js`（追加）
- Modify: `src/plugins/tracking-stats/logic.test.js`（追加）

- [ ] **Step 1: 写失败测试**

import 追加 `buildSummaryText, buildReportFileName`，文末追加：

```js
test('buildSummaryText：完整数据的排版', () => {
  const text = buildSummaryText({
    title: '分享功能使用情况',
    range: '2026-08-12 ~ 2026-08-19',
    totalPv: 12847,
    totalUv: 3201,
    compareRate: 0.123,
    top: [
      { label: '分享到微信', pv: 5210 },
      { label: '保存分享图片', pv: 3120 },
      { label: '分享页加载', pv: 1900 },
    ],
  });
  assert.match(text, /分享功能使用情况/);
  assert.match(text, /2026-08-12 ~ 2026-08-19/);
  assert.match(text, /12,847/);       // 千分位
  assert.match(text, /3,201/);
  assert.match(text, /↑12\.3%/);
  assert.match(text, /分享到微信 5,210/);
});

test('buildSummaryText：环比为负显示下降箭头', () => {
  const text = buildSummaryText({ title: 'T', range: 'R', totalPv: 10, totalUv: 5, compareRate: -0.08, top: [] });
  assert.match(text, /↓8\.0%/);
});

test('buildSummaryText：环比缺失时不渲染该行', () => {
  const text = buildSummaryText({ title: 'T', range: 'R', totalPv: 10, totalUv: 5, compareRate: null, top: [] });
  assert.ok(!text.includes('↑') && !text.includes('↓'));
});

test('buildSummaryText：空结果给出明确结论而不是空白', () => {
  const text = buildSummaryText({ title: 'T', range: 'R', totalPv: 0, totalUv: 0, compareRate: null, top: [] });
  assert.match(text, /该时段无数据/);
});

test('buildReportFileName：含标题与时间戳，非法字符被替换', () => {
  const name = buildReportFileName('分享/功能: 使用<情况>', new Date('2026-08-19T10:30:00Z'), 480);
  assert.match(name, /^埋点统计_分享_功能_ 使用_情况__20260819_1830\.html$/);
});

test('buildReportFileName：超长标题被截断', () => {
  const name = buildReportFileName('标'.repeat(60), new Date('2026-08-19T02:30:00Z'), 480);
  assert.ok(name.length < 80);
  assert.ok(name.endsWith('.html'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/plugins/tracking-stats/logic.test.js`
Expected: FAIL —— `buildSummaryText is not a function`

- [ ] **Step 3: 写实现**

在 `logic.js` 末尾追加：

```js
/** 千分位 */
function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/**
 * 聊天内的文字摘要。
 *
 * 为什么附件之外还要发这段：飞书对 .html 不做在线预览，对方得下载后用浏览器打开。
 * 多发一段文字，对方在聊天里就能看到结论，想细看再点附件 —— 成本几乎为零。
 *
 * @param {{title:string, range:string, totalPv:number, totalUv:number, compareRate:number|null, top:{label:string,pv:number}[]}} s
 */
export function buildSummaryText(s) {
  const lines = [`📊 ${s?.title || '埋点统计'}`, `📅 ${s?.range || ''}`];
  const pv = Number(s?.totalPv || 0);
  const uv = Number(s?.totalUv || 0);

  if (pv === 0 && uv === 0) {
    lines.push('', '该时段无数据。');
    return lines.join('\n');
  }

  lines.push('', `总触发 ${fmtNum(pv)} 次 · 独立用户 ${fmtNum(uv)} 人`);

  const rate = s?.compareRate;
  if (typeof rate === 'number' && Number.isFinite(rate)) {
    const arrow = rate >= 0 ? '↑' : '↓';
    lines.push(`较上一周期 ${arrow}${(Math.abs(rate) * 100).toFixed(1)}%`);
  }

  const top = Array.isArray(s?.top) ? s.top.slice(0, 3) : [];
  if (top.length) {
    lines.push('', 'Top：');
    for (const t of top) lines.push(`  · ${t.label} ${fmtNum(t.pv)}`);
  }

  lines.push('', '详细报告见附件 👇');
  return lines.join('\n');
}

/**
 * 报告文件名。
 * @param {string} title
 * @param {Date} now
 * @param {number} tzOffsetMinutes 目标时区相对 UTC 的分钟偏移（北京 = 480）
 */
export function buildReportFileName(title, now, tzOffsetMinutes = 480) {
  // 文件名里的非法字符会让飞书上传或对方本地保存失败，统一替换成下划线
  const safe = String(title || '埋点统计').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 30);
  const t = new Date(now.getTime() + tzOffsetMinutes * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}_${p(t.getUTCHours())}${p(t.getUTCMinutes())}`;
  return `埋点统计_${safe}_${stamp}.html`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/plugins/tracking-stats/logic.test.js`
Expected: PASS，38 例全绿

---

## Task 8: 埋点索引加载器

> **本任务在实现期随 Task 2 一并调整**：加载后要用 `indexDict` 建查找表，并对「索引缺失」与
> 「中文名覆盖率异常」两种情况分别告警。

**Files:**
- Create: `src/plugins/tracking-stats/dict.js`

- [ ] **Step 1: 写实现**

创建 `src/plugins/tracking-stats/dict.js`：

```js
/**
 * 埋点索引快照的加载与缓存。
 *
 * 进程内缓存一份：约 1200 个条目、百来 KB，每条消息都读盘没必要。
 * 快照更新后需重启机器人生效 —— 可接受，因为同步本身就是个手工动作。
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../shared/logger.js';
import { indexDict } from './logic.js';

/** 超过这个天数未同步就告警：新埋点查不到时，日志里要有线索 */
const STALE_DAYS = 30;

let cached = null;

/** 快照文件路径（项目根 data/event-dict.json） */
function dictPath() {
  return path.join(process.cwd(), 'data', 'event-dict.json');
}

/**
 * 读取并索引快照。文件缺失或损坏时返回 null（调用方回告用户去跑同步脚本），
 * 不抛错 —— 索引问题不该表现为一个没头没尾的堆栈。
 * @returns {ReturnType<typeof indexDict>|null}
 */
export function loadDict() {
  if (cached) return cached;
  const p = dictPath();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(raw?.events) || !Array.isArray(raw?.pages)) {
      // 结构不对多半是快照还是旧版的 Record<name,label> 形态，提示重新同步而不是硬塞
      logger.error('tracking-stats', '索引快照结构不符（events/pages 应为数组），请重新同步', { path: p });
      return null;
    }

    const dict = indexDict(raw);
    const live = dict.events.filter((e) => e.live).length;
    const named = dict.events.filter((e) => e.live && e.named).length;

    const ageDays = (Date.now() - new Date(raw.syncedAt).getTime()) / 86400000;
    if (Number.isFinite(ageDays) && ageDays > STALE_DAYS) {
      logger.warn('tracking-stats', '索引快照已过期，新埋点可能查不到', {
        syncedAt: raw.syncedAt,
        ageDays: Math.round(ageDays),
        hint: 'node scripts/sync-event-dict.mjs <compass-agent 目录>',
      });
    }

    cached = dict;
    logger.info('tracking-stats', '埋点索引已加载', {
      liveEvents: live,
      namedRate: live ? `${Math.round((named / live) * 100)}%`,
      livePages: dict.pages.filter((p) => p.live).length,
      total: dict.events.length,
      syncedAt: raw.syncedAt,
    });
    return cached;
  } catch (e) {
    logger.error('tracking-stats', '索引快照读取失败', { path: p, err: e?.message || String(e) });
    return null;
  }
}

/** 测试用：清空缓存 */
export function resetDictCache() {
  cached = null;
}
```

- [ ] **Step 2: 验证能加载 Task 2 生成的快照**

Run:
```
node -e "import('./src/plugins/tracking-stats/dict.js').then(m=>{const d=m.loadDict();if(!d)return console.log('❌ 加载失败');console.log('live events:',d.events.filter(e=>e.live).length,'| live pages:',d.pages.filter(p=>p.live).length,'| index size:',d.eventIndex.size)})"
```
Expected: 打印形如 `live events: 600 | live pages: 82 | index size: 1000+`，且日志中出现「埋点索引已加载」并带 `namedRate`（预期在 40%~60% 之间 —— 这个数字本身就是字典维护缺口的度量）

- [ ] **Step 3: 验证页面 path 可直接用于 SQL**

Run:
```
node -e "import('./src/plugins/tracking-stats/dict.js').then(m=>{const d=m.loadDict();const p=d.pages.find(x=>x.live);console.log(p.path, '| 可被索引反查:', !!d.pageIndex.get(p.path))})"
```
Expected: 打印带前导斜杠的路径，且 `可被索引反查: true`

---

## Task 9: understand.js —— 两阶段 LLM 推理

**Files:**
- Create: `src/plugins/tracking-stats/understand.js`

**关键约束**：阶段 A 必须注入「今天是几号」。模型不知道当前日期，不给锚点，「最近一个月」会被算成训练数据里的某个月份 —— 日期格式正确、数字也查得出来，就是错的，比直接报错危险得多。

- [ ] **Step 1: 写实现**

创建 `src/plugins/tracking-stats/understand.js`：

```js
/**
 * 两阶段 Haiku 推理：口语 → 检索词 → 具体事件/页面。
 *
 * 为什么必须两阶段：纯关键词召回撑不住不专业的表述。用户说「小孩吃饭那块」，
 * 字面召回直接归零 —— 而召回不到的事件，后续模型再聪明也选不出来。
 * 阶段 A 先把口语转成规范检索词，阶段 B 再从召回结果里挑。
 */
import { runClassifierOnce } from '../../features/llm-classify.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

/** 与 intent.js 同口径的分类超时：10s（原两次 30s 串联是历史性能事故的成因） */
const TIMEOUT_MS = 10_000;
/** 阶段 A 塞进 prompt 的分类目录条数上限 */
const CATEGORY_MAX = 40;

/** 北京时区的今天 'YYYY-MM-DD' 与时刻 'HH:mm' */
export function beijingNow(now = new Date()) {
  const t = new Date(now.getTime() + 480 * 60 * 1000); // UTC+8
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`,
    time: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`,
  };
}

/** 阶段 A prompt */
export function buildUnderstandPrompt(body, dict, todayDate) {
  const cats = (dict?.categories || [])
    .slice(0, CATEGORY_MAX)
    .map((c) => `${c.prefix}(${c.label})`)
    .join('、');
  return `你在帮团队把一句口语化的埋点统计需求，翻译成结构化的检索条件。

今天是 ${todayDate}（北京时间）。所有相对时间都以此为基准计算。

可用的业务模块目录（前缀(中文名)）：
${cats}

用户的需求原文：
${body}

请输出一个 JSON 对象，不要输出任何其它内容：
{
  "range": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "target": "event" 或 "page" 或 "both",
  "keywords": ["检索词1", "检索词2"],
  "title": "报告标题"
}

规则：
1. range 用绝对日期。「最近一个月」=今天往前推 29 天到今天；「上个月」「7月」=该自然月的完整区间；「昨天」=昨天单日。用户没提时间就给最近 7 天。
2. target：用户明确说「页面」「访问」「浏览」用 page；说「点击」「按钮」「操作」用 event；说不清用 both。
3. keywords：把口语转成能在事件名和中文名里检索到的词，做同义词扩展。例如「小孩吃饭那块」应扩展为 ["宝宝辅食","baby_food","辅食","儿童"]。给 2-6 个词。
4. title：一句话概括这份报告统计的是什么。`;
}

/** 阶段 A：理解 */
export async function understandRequest(body, dict, now = new Date()) {
  const { date } = beijingNow(now);
  const out = await runClassifierOnce({
    prompt: buildUnderstandPrompt(body, dict, date),
    model: config.intent.classifyModel,
    logTag: 'tracking-stats/understand',
    timeoutMs: TIMEOUT_MS,
  });
  if (!out) {
    logger.warn('tracking-stats', '阶段 A 无输出（超时或解析失败）');
    return null;
  }
  // 语义校验留给调用方，这里只做形状兜底
  return {
    range: out.range && typeof out.range === 'object' ? out.range : null,
    target: ['event', 'page', 'both'].includes(out.target) ? out.target : 'both',
    keywords: Array.isArray(out.keywords) ? out.keywords.map((k) => String(k || '')).filter(Boolean) : [],
    title: String(out.title || '').trim() || '埋点统计',
  };
}

/** 阶段 B prompt */
export function buildPickPrompt(body, candidates) {
  const evLines = candidates.events.map((e) => `- ${e.name} : ${e.label}`).join('\n') || '（无）';
  const pgLines = candidates.pages.map((p) => `- ${p.path} : ${p.label}`).join('\n') || '（无）';
  return `用户的埋点统计需求：
${body}

以下是检索出的候选埋点。请只从候选里挑出真正符合需求的，**不要发明候选之外的标识**。

候选事件：
${evLines}

候选页面：
${pgLines}

请输出一个 JSON 对象，不要输出任何其它内容：
{
  "events": [{ "name": "候选里的事件名" }],
  "pages": [{ "path": "候选里的页面路径" }]
}

规则：
1. 只填真正相关的。宁可少选几个精准的，也不要把整个候选列表照抄一遍。
2. 用户只关心页面就让 events 为空数组，反之亦然。
3. 两个数组合计不要超过 20 条。`;
}

/** 阶段 B：精选。返回原始选择，硬校验由 logic.validateSelection 负责 */
export async function pickTargets(body, candidates) {
  const out = await runClassifierOnce({
    prompt: buildPickPrompt(body, candidates),
    model: config.intent.classifyModel,
    logTag: 'tracking-stats/pick',
    timeoutMs: TIMEOUT_MS,
  });
  if (!out) {
    logger.warn('tracking-stats', '阶段 B 无输出（超时或解析失败）');
    return null;
  }
  return {
    events: Array.isArray(out.events) ? out.events : [],
    pages: Array.isArray(out.pages) ? out.pages : [],
  };
}
```

- [ ] **Step 2: 验证 prompt 里确实注入了当天日期**

Run: `node -e "import('./src/plugins/tracking-stats/understand.js').then(m=>{const p=m.buildUnderstandPrompt('最近一个月宝宝辅食',{categories:[{prefix:'baby_food',label:'宝宝辅食',count:37}]},'2026-08-19');console.log(p.includes('2026-08-19')?'✅ 日期已注入':'❌ 缺日期锚点')})"`
Expected: `✅ 日期已注入`

---

## Task 10: Python 报告脚本 —— 数据查询

**Files:**
- Create: `src/plugins/tracking-stats/tracking_report.py`

- [ ] **Step 1: 确认 pymysql 可用**

Run: `python -c "import pymysql; print(pymysql.__version__)"`
Expected: 打印版本号。若报 ModuleNotFoundError，先 `pip install pymysql`

- [ ] **Step 2: 写查询部分**

创建 `src/plugins/tracking-stats/tracking_report.py`：

```python
#!/usr/bin/env python3
"""
埋点统计报告生成器。

输入：--spec <QuerySpec JSON 文件路径>
输出：stdout 一行 JSON {"htmlPath": ..., "summary": {...}}；失败输出 {"error": ...} 并退出码 1

约定（对齐 scripts/get_qrcode.py）：过程日志一律走 stderr，stdout 只留最终结果。
调用方只解析 stdout，混进日志会让 JSON 解析炸掉。
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import pymysql

BEIJING = timezone(timedelta(hours=8))

# 单次查询超时（秒）—— 生产库是共享资源，宁可失败也不能把它拖住
QUERY_TIMEOUT_S = 30
# 结果集行数上限
ROW_LIMIT = 50000


def log(msg):
    """过程日志走 stderr"""
    print(msg, file=sys.stderr)


def db_config():
    """数据库配置全部走环境变量。

    不硬编码密码：compass-agent 的 scripts/user_path_analyzer.py 把生产库密码写死在源码里，
    那是个已存在的安全问题，这里不复制它。
    """
    missing = [k for k in ("TRACKING_DB_HOST", "TRACKING_DB_USER", "TRACKING_DB_PASSWORD") if not os.environ.get(k)]
    if missing:
        raise RuntimeError(f"缺少环境变量：{', '.join(missing)}")
    return dict(
        host=os.environ["TRACKING_DB_HOST"],
        port=int(os.environ.get("TRACKING_DB_PORT", "3306")),
        database=os.environ.get("TRACKING_DB_NAME", "compass_prod"),
        user=os.environ["TRACKING_DB_USER"],
        password=os.environ["TRACKING_DB_PASSWORD"],
        charset="utf8mb4",
        connect_timeout=10,
        read_timeout=QUERY_TIMEOUT_S + 5,
        cursorclass=pymysql.cursors.DictCursor,
    )


def day_bounds_ms(start_day: str, end_day: str):
    """'YYYY-MM-DD' 起止 → 北京时区的毫秒时间戳区间 [start 00:00, end 次日 00:00)"""
    s = datetime.strptime(start_day, "%Y-%m-%d").replace(tzinfo=BEIJING)
    e = datetime.strptime(end_day, "%Y-%m-%d").replace(tzinfo=BEIJING) + timedelta(days=1)
    return int(s.timestamp() * 1000), int(e.timestamp() * 1000)


def fetch_internal_uids(cur):
    """内测用户名单从 internal_user 表实时读，不硬编码 —— 名单会变，硬编码必然过期。

    表不存在或查询失败时返回空集合并告警：排除名单缺失会让数字偏高，
    但比整个报告生成失败要好，且脚注里会写明。
    """
    try:
        cur.execute("SELECT uid FROM internal_user")
        return {str(r["uid"]) for r in cur.fetchall() if r.get("uid")}
    except Exception as e:  # noqa: BLE001
        log(f"⚠️ 内测名单读取失败，本次不排除内测用户：{e}")
        return set()


def build_event_sql(events, excl_uids, group_by_day):
    """事件维度 SQL。

    口径全部对齐 compass-agent 现有报表（statistics_data_repository.py），不自创：
    - 业务事件名在 properties.event_name，不是 event 字段
    - 排除微信开发者工具（$os = devtools）
    - 排除内测用户
    - 按北京时区分桶（CONVERT_TZ），与 user_behavior_service.py 一致
    所有值走占位符绑定：事件名虽已过白名单校验，仍不拼串（双保险）。
    """
    day_col = (
        "DATE(CONVERT_TZ(FROM_UNIXTIME(time/1000), '+00:00', '+08:00'))"
        if group_by_day
        else "'ALL'"
    )
    ev_ph = ", ".join(["%s"] * len(events))
    sql = f"""
        SELECT {day_col} AS d,
               JSON_UNQUOTE(JSON_EXTRACT(properties, '$.event_name')) AS k,
               COUNT(*) AS pv,
               COUNT(DISTINCT distinct_id) AS uv
        FROM statistics_data
        WHERE time >= %s AND time < %s
          AND is_deleted = 0
          AND JSON_UNQUOTE(JSON_EXTRACT(properties, '$.event_name')) IN ({ev_ph})
          AND JSON_UNQUOTE(JSON_EXTRACT(properties, '$."$os"')) != 'devtools'
    """
    params = []
    if excl_uids:
        uid_ph = ", ".join(["%s"] * len(excl_uids))
        sql += f"  AND distinct_id NOT IN ({uid_ph})\n"
    sql += f"        GROUP BY d, k LIMIT {ROW_LIMIT}"
    return sql, params


def build_page_sql(pages, excl_uids, group_by_day):
    """页面维度 SQL：页面访问走 $MPViewScreen + properties.$url_path

    传入的 path 必须是**库内原始值（带前导斜杠）**，即索引快照里的 pages[].path。
    快照里另有个 key 字段是去掉前导斜杠的归一化形式，那个只用于跟中文名字典比对，
    绝不能拿来查库 —— 实测字典 key 无斜杠、库内有，用错了是 0 命中且不报错，
    安静返回空表、报告照常生成并写「该时段无数据」，是最难发现的一类故障。
    """
    day_col = (
        "DATE(CONVERT_TZ(FROM_UNIXTIME(time/1000), '+00:00', '+08:00'))"
        if group_by_day
        else "'ALL'"
    )
    pg_ph = ", ".join(["%s"] * len(pages))
    sql = f"""
        SELECT {day_col} AS d,
               JSON_UNQUOTE(JSON_EXTRACT(properties, '$."$url_path"')) AS k,
               COUNT(*) AS pv,
               COUNT(DISTINCT distinct_id) AS uv
        FROM statistics_data
        WHERE time >= %s AND time < %s
          AND is_deleted = 0
          AND event = '$MPViewScreen'
          AND JSON_UNQUOTE(JSON_EXTRACT(properties, '$."$url_path"')) IN ({pg_ph})
          AND JSON_UNQUOTE(JSON_EXTRACT(properties, '$."$os"')) != 'devtools'
    """
    if excl_uids:
        uid_ph = ", ".join(["%s"] * len(excl_uids))
        sql += f"  AND distinct_id NOT IN ({uid_ph})\n"
    sql += f"        GROUP BY d, k LIMIT {ROW_LIMIT}"
    return sql


def query_rows(cur, sql, start_ms, end_ms, keys, excl_uids):
    params = [start_ms, end_ms, *keys, *sorted(excl_uids)]
    cur.execute(sql, params)
    return cur.fetchall()


def run_query(spec):
    """执行查询，返回 {rows, prev_total_pv, excluded_internal}"""
    cfg = db_config()
    start_ms, end_ms = day_bounds_ms(spec["range"]["start"], spec["range"]["end"])
    group_by_day = spec.get("groupBy") == "day"

    conn = pymysql.connect(**cfg)
    try:
        with conn.cursor() as cur:
            cur.execute(f"SET SESSION MAX_EXECUTION_TIME={QUERY_TIMEOUT_S * 1000}")
            excl = fetch_internal_uids(cur)

            rows = []
            if spec.get("events"):
                names = [e["name"] for e in spec["events"]]
                sql, _ = build_event_sql(names, excl, group_by_day)
                for r in query_rows(cur, sql, start_ms, end_ms, names, excl):
                    rows.append({**r, "kind": "event"})
                log(f"事件维度查得 {len(rows)} 行")

            if spec.get("pages"):
                paths = [p["path"] for p in spec["pages"]]
                sql = build_page_sql(paths, excl, group_by_day)
                n0 = len(rows)
                for r in query_rows(cur, sql, start_ms, end_ms, paths, excl):
                    rows.append({**r, "kind": "page"})
                log(f"页面维度查得 {len(rows) - n0} 行")

            # 环比：上一等长周期的总量
            prev_pv = None
            if spec.get("compare"):
                span = end_ms - start_ms
                p_start, p_end = start_ms - span, start_ms
                prev_pv = 0
                if spec.get("events"):
                    names = [e["name"] for e in spec["events"]]
                    sql, _ = build_event_sql(names, excl, False)
                    prev_pv += sum(int(r["pv"]) for r in query_rows(cur, sql, p_start, p_end, names, excl))
                if spec.get("pages"):
                    paths = [p["path"] for p in spec["pages"]]
                    sql = build_page_sql(paths, excl, False)
                    prev_pv += sum(int(r["pv"]) for r in query_rows(cur, sql, p_start, p_end, paths, excl))

            return {"rows": rows, "prevPv": prev_pv, "excludedInternal": len(excl)}
    finally:
        conn.close()
```

- [ ] **Step 3: 冒烟测试查询部分**

先手工造一份 spec 试跑（下一任务补 HTML 渲染后才有完整出口，这里只验证 SQL 不报错）：

Run:
```bash
python -c "
import os,sys,json
sys.path.insert(0,'src/plugins/tracking-stats')
os.environ.setdefault('TRACKING_DB_HOST','dongying-prod-public.rwlb.rds.aliyuncs.com')
os.environ.setdefault('TRACKING_DB_USER','compass_viewer')
os.environ.setdefault('TRACKING_DB_NAME','compass_prod')
import tracking_report as tr
spec={'range':{'start':'2026-08-16','end':'2026-08-19'},'groupBy':'day','compare':True,
      'events':[{'name':'chat_sse_send'}],'pages':[]}
print(json.dumps(tr.run_query(spec)['rows'][:5],default=str,ensure_ascii=False))
"
```
（运行前需在环境里提供 `TRACKING_DB_PASSWORD`）
Expected: 打印若干形如 `{"d": "2026-08-16", "k": "chat_sse_send", "pv": 812, "uv": 233, "kind": "event"}` 的行

---

## Task 11: Python 报告脚本 —— HTML 渲染与主入口

**Files:**
- Modify: `src/plugins/tracking-stats/tracking_report.py`（追加）

- [ ] **Step 1: 追加渲染与主函数**

在 `src/plugins/tracking-stats/tracking_report.py` 末尾追加：

```python
def aggregate(rows, spec):
    """行数据 → 明细汇总 + 每日序列 + 总量"""
    label_of = {}
    for e in spec.get("events", []):
        label_of[e["name"]] = e.get("label") or e["name"]
    for p in spec.get("pages", []):
        label_of[p["path"]] = p.get("label") or p["path"]

    detail = {}
    daily = {}
    for r in rows:
        k = r["k"]
        pv, uv = int(r["pv"]), int(r["uv"])
        d = detail.setdefault(k, {"key": k, "label": label_of.get(k, k), "pv": 0, "uv": 0})
        d["pv"] += pv
        d["uv"] += uv
        day = str(r["d"])
        if day != "ALL":
            daily[day] = daily.get(day, 0) + pv

    detail_list = sorted(detail.values(), key=lambda x: -x["pv"])
    total_pv = sum(d["pv"] for d in detail_list)
    # UV 不能跨事件相加（同一用户会被重复计数），取各事件最大值作为下界估计并在脚注说明
    total_uv = max((d["uv"] for d in detail_list), default=0)
    series = [{"day": d, "pv": daily[d]} for d in sorted(daily)]
    return detail_list, series, total_pv, total_uv


def svg_line_chart(series, width=720, height=220):
    """手写内联 SVG 折线图。

    不引 ECharts / CDN：报告是离线附件，引外链在断网或内网环境下变成一堆空白框；
    引库则让附件膨胀到 1MB 以上。数据量小，折线足够。
    """
    if not series:
        return '<p class="empty">该时段无数据</p>'
    pad_l, pad_b, pad_t = 48, 28, 12
    w, h = width, height
    max_pv = max(s["pv"] for s in series) or 1
    n = len(series)
    step = (w - pad_l - 12) / max(1, n - 1) if n > 1 else 0
    pts = []
    for i, s in enumerate(series):
        x = pad_l + i * step if n > 1 else pad_l + (w - pad_l) / 2
        y = pad_t + (h - pad_t - pad_b) * (1 - s["pv"] / max_pv)
        pts.append((x, y, s))
    path = " ".join(f"{'M' if i == 0 else 'L'}{x:.1f},{y:.1f}" for i, (x, y, _) in enumerate(pts))
    dots = "".join(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="#2563eb"><title>{s["day"]}: {s["pv"]}</title></circle>' for x, y, s in pts)
    # x 轴标签最多 8 个，避免挤成一团
    stride = max(1, n // 8)
    labels = "".join(
        f'<text x="{x:.1f}" y="{h - 8}" font-size="10" fill="#6b7280" text-anchor="middle">{s["day"][5:]}</text>'
        for i, (x, _, s) in enumerate(pts) if i % stride == 0
    )
    grid = "".join(
        f'<line x1="{pad_l}" y1="{pad_t + (h - pad_t - pad_b) * f:.1f}" x2="{w - 12}" y2="{pad_t + (h - pad_t - pad_b) * f:.1f}" stroke="#e5e7eb" stroke-width="1"/>'
        f'<text x="{pad_l - 6}" y="{pad_t + (h - pad_t - pad_b) * f + 3:.1f}" font-size="10" fill="#9ca3af" text-anchor="end">{int(max_pv * (1 - f))}</text>'
        for f in (0, 0.5, 1)
    )
    return f'<svg viewBox="0 0 {w} {h}" width="100%" height="{h}" xmlns="http://www.w3.org/2000/svg">{grid}<path d="{path}" fill="none" stroke="#2563eb" stroke-width="2"/>{dots}{labels}</svg>'


def esc(s):
    return (
        str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


def render_html(spec, detail, series, total_pv, total_uv, prev_pv, excluded_internal, notes):
    """渲染报告。样式全部内联，无任何外部依赖。"""
    rng = f"{spec['range']['start']} ~ {spec['range']['end']}"
    days = spec.get("rangeDays") or "-"
    now_bj = datetime.now(BEIJING)

    compare_html = ""
    if isinstance(prev_pv, int) and prev_pv > 0:
        rate = (total_pv - prev_pv) / prev_pv
        arrow, color = ("↑", "#059669") if rate >= 0 else ("↓", "#dc2626")
        compare_html = f'<div class="cmp" style="color:{color}">较上一周期 {arrow}{abs(rate) * 100:.1f}%</div>'
    elif spec.get("compare"):
        compare_html = '<div class="cmp muted">上一周期无数据，不计算环比</div>'

    rows_html = "".join(
        f"<tr><td>{esc(d['label'])}</td><td class='mono'>{esc(d['key'])}</td>"
        f"<td class='num'>{d['pv']:,}</td><td class='num'>{d['uv']:,}</td>"
        f"<td class='num'>{(d['pv'] / total_pv * 100) if total_pv else 0:.1f}%</td></tr>"
        for d in detail
    ) or '<tr><td colspan="5" class="empty">该时段无数据</td></tr>'

    note_items = "".join(f"<li>{esc(n)}</li>" for n in notes)

    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(spec.get('title', '埋点统计'))}</title>
<style>
* {{ box-sizing: border-box; }}
body {{ margin:0; padding:24px; background:#f8fafc; color:#111827;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }}
.wrap {{ max-width:860px; margin:0 auto; }}
.card {{ background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:20px; margin-bottom:16px; }}
h1 {{ font-size:22px; margin:0 0 6px; }}
.sub {{ color:#6b7280; font-size:13px; }}
.kpis {{ display:flex; gap:32px; flex-wrap:wrap; margin:8px 0 4px; }}
.kpi .v {{ font-size:32px; font-weight:700; letter-spacing:-0.5px; }}
.kpi .l {{ color:#6b7280; font-size:13px; }}
.cmp {{ font-size:14px; margin-top:8px; font-weight:600; }}
.muted {{ color:#9ca3af; font-weight:400; }}
table {{ width:100%; border-collapse:collapse; font-size:14px; }}
th,td {{ padding:9px 10px; border-bottom:1px solid #f1f5f9; text-align:left; }}
th {{ color:#6b7280; font-weight:600; font-size:12px; background:#fafafa; }}
.num {{ text-align:right; font-variant-numeric:tabular-nums; }}
.mono {{ font-family:ui-monospace,Consolas,monospace; font-size:12px; color:#6b7280; }}
.empty {{ color:#9ca3af; text-align:center; padding:24px; }}
.foot {{ font-size:12px; color:#6b7280; }}
.foot ul {{ margin:6px 0 0; padding-left:18px; }}
</style></head>
<body><div class="wrap">

<div class="card">
  <h1>{esc(spec.get('title', '埋点统计'))}</h1>
  <div class="sub">{rng} · {days} 天</div>
  <div class="kpis">
    <div class="kpi"><div class="v">{total_pv:,}</div><div class="l">总触发次数</div></div>
    <div class="kpi"><div class="v">{total_uv:,}</div><div class="l">独立用户数（下界）</div></div>
  </div>
  {compare_html}
</div>

<div class="card"><h2 style="font-size:15px;margin:0 0 12px">每日趋势</h2>{svg_line_chart(series)}</div>

<div class="card"><h2 style="font-size:15px;margin:0 0 12px">明细</h2>
<table><thead><tr><th>名称</th><th>标识</th><th class="num">次数</th><th class="num">用户数</th><th class="num">占比</th></tr></thead>
<tbody>{rows_html}</tbody></table></div>

<div class="card foot">
  <strong>查询口径</strong>
  <ul>
    <li>已排除微信开发者工具（$os = devtools）产生的数据</li>
    <li>已排除内测用户 {excluded_internal} 个（来自 internal_user 表）</li>
    <li>时间按北京时区分桶</li>
    <li>「独立用户数」取各项最大值作为下界 —— 同一用户可能触发多个事件，跨事件相加会重复计数</li>
    {note_items}
  </ul>
  <div style="margin-top:10px">生成时间：{now_bj.strftime('%Y-%m-%d %H:%M')}（北京时间）</div>
</div>

</div></body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True, help="QuerySpec JSON 文件路径")
    ap.add_argument("--out-dir", default="", help="HTML 输出目录，默认系统临时目录")
    ap.add_argument("--file-name", default="", help="输出文件名")
    args = ap.parse_args()

    try:
        with open(args.spec, "r", encoding="utf-8") as f:
            spec = json.load(f)

        log(f"开始查询：{spec.get('title')} {spec['range']['start']}~{spec['range']['end']}")
        res = run_query(spec)
        detail, series, total_pv, total_uv = aggregate(res["rows"], spec)

        notes = list(spec.get("notes") or [])
        if spec.get("includesToday"):
            notes.append(f"今日数据截至 {datetime.now(BEIJING).strftime('%H:%M')}，尚不完整")

        html = render_html(spec, detail, series, total_pv, total_uv, res["prevPv"], res["excludedInternal"], notes)

        out_dir = args.out_dir or os.path.join(os.environ.get("TEMP", "/tmp"), "tracking-reports")
        os.makedirs(out_dir, exist_ok=True)
        file_name = args.file_name or f"tracking_{datetime.now(BEIJING).strftime('%Y%m%d_%H%M%S')}.html"
        out_path = os.path.join(out_dir, file_name)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(html)
        log(f"报告已生成：{out_path}")

        prev = res["prevPv"]
        compare_rate = ((total_pv - prev) / prev) if isinstance(prev, int) and prev > 0 else None
        print(json.dumps({
            "htmlPath": out_path,
            "summary": {
                "title": spec.get("title", "埋点统计"),
                "range": f"{spec['range']['start']} ~ {spec['range']['end']}",
                "totalPv": total_pv,
                "totalUv": total_uv,
                "compareRate": compare_rate,
                "top": [{"label": d["label"], "pv": d["pv"]} for d in detail[:3]],
            },
        }, ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: 端到端跑一次真实报告**

Run:
```bash
python -c "
import json,tempfile,os
spec={'title':'会话发送冒烟','range':{'start':'2026-08-13','end':'2026-08-19'},'rangeDays':7,
      'groupBy':'day','compare':True,'includesToday':True,'notes':[],
      'events':[{'name':'chat_sse_send','label':'会话发送'}],'pages':[]}
p=os.path.join(tempfile.gettempdir(),'spec.json')
open(p,'w',encoding='utf-8').write(json.dumps(spec,ensure_ascii=False))
print(p)
" > /tmp/specpath.txt && python src/plugins/tracking-stats/tracking_report.py --spec "$(cat /tmp/specpath.txt)"
```
Expected: stdout 一行 JSON，含 `htmlPath` 与非零的 `totalPv`

- [ ] **Step 3: 断网检查渲染**

用浏览器打开上一步产出的 HTML（可先断开网络）。
Expected: 标题、两个大数字、折线图、明细表、脚注全部正常显示；**没有任何空白框或加载失败的图标**（若有，说明混进了外链资源，必须改成内联）

---

## Task 12: lark.js —— 上传与发送文件

**Files:**
- Modify: `src/integrations/lark.js`（在 `sendImageByUrl` 之后追加）

- [ ] **Step 1: 写实现**

在 `src/integrations/lark.js` 的 `sendImageByUrl`（约 163-169 行）之后追加：

```js
/**
 * 上传文件到飞书，返回 file_key（失败抛错，由调用方兜底）。
 * 与 uploadImage 同构：code-gen client 已剥外层信封 → file_key 在顶层，保留 .data 兜底。
 *
 * 飞书限制：文件 ≤ 30MB，且不允许空文件。任意扩展名走 file_type: 'stream'。
 * @param {Buffer} buf
 * @param {string} fileName 带扩展名
 * @param {'opus'|'mp4'|'pdf'|'doc'|'xls'|'ppt'|'stream'} [fileType]
 */
export async function uploadFile(buf, fileName, fileType = 'stream') {
  if (!buf || !buf.length) throw new Error('不能上传空文件');
  if (buf.length > 30 * 1024 * 1024) throw new Error(`文件超过 30MB 限制（${(buf.length / 1024 / 1024).toFixed(1)}MB）`);
  const r = await getClient().im.v1.file.create({
    data: { file_type: fileType, file_name: fileName, file: buf },
  });
  const key = r?.file_key || r?.data?.file_key || null;
  if (!key) throw new Error('上传文件未返回 file_key');
  return key;
}

/** 发送文件消息（已有 file_key） */
export async function sendFile(chatId, fileKey) {
  await getClient().im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      content: JSON.stringify({ file_key: fileKey }),
      msg_type: 'file',
    },
  });
  logger.info('lark', '发送文件', { chatId, fileKey });
}

/** 本地路径 → 上传 → 发文件消息。失败抛错（调用方回退发文字摘要）。 */
export async function sendFileByPath(chatId, filePath, fileName) {
  const buf = await fsp.readFile(filePath);
  const key = await uploadFile(buf, fileName || path.basename(filePath));
  await sendFile(chatId, key);
}
```

- [ ] **Step 2: 补文件头 import**

确认 `src/integrations/lark.js` 顶部已有：

```js
import fsp from 'node:fs/promises';
import path from 'node:path';
```

若无则添加（放在现有 import 之后）。

- [ ] **Step 3: 语法检查**

Run: `node --check src/integrations/lark.js`
Expected: 无输出（语法正确）

- [ ] **Step 4: 全量测试确认没打破既有用例**

Run: `npm test`
Expected: PASS

---

## Task 13: index.js —— 编排、门禁与插件注册

**Files:**
- Create: `src/plugins/tracking-stats/feature.js`（feature 本体）
- Create: `src/plugins/tracking-stats/index.js`（装配出口）
- Modify: `src/plugins/index.js`

> 命名说明：插件的 `index.js` 必须导出 `{ id, features }` 装配对象（见 `src/plugins/index.js:36-51` 的 `loadEnabledPluginFeatures`），feature 本体因此单独放 `feature.js`。

- [ ] **Step 1: 写 feature 本体**

创建 `src/plugins/tracking-stats/feature.js`：

```js
/**
 * feature: 埋点统计（`帮我统计埋点: <自然语言>`，可信提交人专属）。
 *
 * 前缀严格匹配开头（零 LLM）→ 阶段 A 理解（时间/目标/检索词）→ 纯函数召回
 * → 阶段 B 精选 + 硬校验 → Python 脚本查生产只读库并渲染 HTML → 附件 + 文字摘要送达。
 *
 * 与 \10001/\10002 的差别：那两个是全等匹配，本功能必须携带自然语言正文，
 * 只能用前缀匹配。安全边界因此放在「前缀足够长且不像日常用语」+「可信人门禁」两处。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScript } from '../../integrations/shell.js';
import { uploadFile, sendFile } from '../../integrations/lark.js';
import { getMyFeishuOpenId } from '../../store/settings.js';
import { resolveTrustedOpenIds, isTrustedSubmitter } from '../../shared/trusted-ids.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { loadDict } from './dict.js';
import { understandRequest, pickTargets, beijingNow } from './understand.js';
import {
  parseTrackingCommand,
  recallCandidates,
  normalizeRange,
  inferGroupBy,
  validateSelection,
  buildSummaryText,
  buildReportFileName,
} from './logic.js';

/** 脚本超时：SQL 30s + 渲染，留足余量但不至于让用户等到天荒地老 */
const SCRIPT_TIMEOUT_MS = 3 * 60 * 1000;

function isTrusted(ctx) {
  return isTrustedSubmitter(ctx, resolveTrustedOpenIds(getMyFeishuOpenId()));
}

/** 把 QuerySpec 写进临时文件传给脚本 —— 走命令行参数会撞长度与转义问题 */
async function writeSpecFile(spec) {
  const dir = path.join(os.tmpdir(), 'tracking-stats');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `spec-${Date.now()}.json`);
  await fs.writeFile(p, JSON.stringify(spec), 'utf8');
  return p;
}

/** 主流程。任何一步失败都必须回话 —— 静默失败是这个功能最糟的失败模式。 */
async function runReport(ctx, body) {
  const dict = loadDict();
  if (!dict) {
    return ctx.reply('❌ 埋点字典未就绪，请先运行：node scripts/sync-event-dict.mjs <compass-agent 目录>');
  }

  // 阶段 A：理解
  const understood = await understandRequest(body, dict);
  if (!understood) {
    return ctx.reply('没听懂这个统计需求，换个说法试试～例如「帮我统计埋点: 最近7天分享功能的点击」');
  }

  const { date: today, time: nowHm } = beijingNow();
  const range = normalizeRange(understood.range, today);

  // 召回（纯函数，零成本）
  const candidates = recallCandidates(understood.keywords, dict, understood.target);
  if (!candidates.events.length && !candidates.pages.length) {
    const cats = (dict.categories || []).slice(0, 12).map((c) => c.label).join('、');
    return ctx.reply(`没找到相关埋点～目前有数据的业务模块：${cats}\n换个说法再试试。`);
  }

  // 阶段 B：精选
  const picked = await pickTargets(body, candidates);
  if (!picked) {
    return ctx.reply('埋点匹配失败（模型无响应），稍后再试～');
  }
  const sel = validateSelection(picked, dict);
  if (sel.empty) {
    const hint = candidates.events.slice(0, 8).map((e) => e.label).join('、');
    return ctx.reply(`没匹配到具体埋点事件～你是想看这些吗：${hint}`);
  }
  if (sel.dropped.length) {
    logger.warn('tracking-stats', '剔除了字典中不存在的标识', { dropped: sel.dropped });
  }

  const spec = {
    title: understood.title,
    events: sel.events,
    pages: sel.pages,
    range: { start: range.start, end: range.end },
    rangeDays: range.days,
    includesToday: range.includesToday,
    metrics: ['pv', 'uv'],
    groupBy: inferGroupBy(range),
    compare: true,
    notes: [
      ...range.notes,
      ...(sel.truncated ? ['统计对象超过 20 项，已截断'] : []),
    ],
  };

  const specPath = await writeSpecFile(spec);
  const fileName = buildReportFileName(understood.title, new Date());
  logger.info('tracking-stats', '开始查询', {
    title: spec.title,
    events: spec.events.length,
    pages: spec.pages.length,
    range: `${spec.range.start}~${spec.range.end}`,
  });

  // 脚本随插件走，不用 config.scripts.dir —— 那条路径指向可写数据目录（APP_DATA_DIR），
  // 是给 action-runner 的用户自配动作脚本用的；本脚本与 Node 侧共享 QuerySpec 契约必须同版本
  const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tracking_report.py');
  const r = await runScript(
    config.scripts.pythonBin,
    [SCRIPT_PATH, '--spec', specPath, '--file-name', fileName],
    { env: { PYTHONIOENCODING: 'utf-8' }, timeoutMs: SCRIPT_TIMEOUT_MS },
  );

  if (!r.ok) {
    const tail = (r.err || r.msg || '').slice(-500);
    return ctx.reply(`❌ 统计失败\n${tail || '(无输出)'}`);
  }

  let out;
  try {
    out = JSON.parse((r.out || '').trim());
  } catch {
    return ctx.reply(`❌ 报告结果解析失败\n${(r.out || '').slice(-400)}`);
  }
  if (out.error) return ctx.reply(`❌ 统计失败：${out.error}`);

  const summaryText = buildSummaryText(out.summary);

  // 先发摘要再发附件：附件上传可能失败，摘要必须先到 —— 结论比文件重要
  await ctx.reply(summaryText).catch((e) => logger.warn('tracking-stats', '摘要发送失败', { err: e?.message }));

  const chatId = ctx.meta?.chatId || ctx.sessionKey;
  try {
    const buf = await fs.readFile(out.htmlPath);
    const key = await uploadFile(buf, fileName);
    await sendFile(chatId, key);
    logger.info('tracking-stats', '报告已送达', { chatId, fileName });
  } catch (e) {
    logger.error('tracking-stats', '附件发送失败', { err: e?.message || String(e) });
    await ctx
      .reply(`⚠️ 报告文件发送失败（${e?.message || e}），本地路径：${out.htmlPath}`)
      .catch(() => {});
  }
}

export default {
  name: 'tracking-stats',
  // any + match 自带可信门禁：非可信人发触发词不命中，自然落常规流程（不暴露功能存在）
  permission: 'any',
  intents: [],
  // 廉价判定在前（前缀比较），isTrusted 要读设置，别让每条消息都付这个成本
  match: (ctx) => parseTrackingCommand(ctx.text).hit && isTrusted(ctx),
  handle: async (ctx) => {
    const { body } = parseTrackingCommand(ctx.text);
    if (!body) {
      return ctx.reply('要统计什么埋点？例如：\n帮我统计埋点: 最近7天分享功能的点击情况');
    }

    // 即时应答不 await（与 bug-patrol 同理：发送失败不该中断统计启动）
    ctx.reply('📊 收到，正在理解需求并查询埋点…（约需 1 分钟，完成后在此回报）')
      .catch((e) => logger.warn('tracking-stats', '即时应答发送失败', { err: e?.message || String(e) }));

    // 异步执行：任何没被局部 catch 的异常都在这里兜底回告，绝不静默
    runReport(ctx, body).catch(async (e) => {
      logger.error('tracking-stats', '统计失败', { err: e?.message || String(e) });
      await ctx
        .reply(`❌ 统计失败：${(e?.message || String(e)).slice(0, 200)}`)
        .catch((e2) => logger.error('tracking-stats', '失败回告也发送失败', { err: e2?.message || String(e2) }));
    });
  },
};
```

- [ ] **Step 2: 注册插件**

在 `src/plugins/index.js` 的 `PLUGIN_MANIFEST` 数组末尾追加：

```js
  {
    id: 'tracking-stats',
    description: '埋点统计：「帮我统计埋点: <自然语言>」→ 两阶段推理 → 查生产埋点库 → HTML 报告附件',
    load: () => import('./tracking-stats/index.js'),
  },
```

再创建装配出口 `src/plugins/tracking-stats/index.js`：

```js
/**
 * 埋点统计插件装配。
 * order 16：必须小于内核 claude-exec(20)，否则触发消息会被 claude-exec 全接；
 * 与 bug-patrol(12)/status-report(14) 同属可信人专属指令区间。
 */
import trackingStats from './feature.js';

export default {
  id: 'tracking-stats',
  features: [{ order: 16, feature: trackingStats }],
};
```

- [ ] **Step 3: 语法与加载检查**

Run: `node --check src/plugins/tracking-stats/feature.js && node --check src/plugins/tracking-stats/index.js`
Expected: 无输出

Run: `node -e "import('./src/plugins/tracking-stats/index.js').then(m=>console.log(m.default.id, m.default.features[0].order, m.default.features[0].feature.name))"`
Expected: `tracking-stats 16 tracking-stats`

- [ ] **Step 4: 全量测试**

Run: `npm test`
Expected: PASS

---

## Task 14: 配置项与文档

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: 追加配置说明**

在 `.env.example` 末尾追加：

```bash
# ===== 埋点统计（tracking-stats 插件）=====
# 生产埋点库（只读账号）。密码必须走环境变量，不要写进源码。
TRACKING_DB_HOST=dongying-prod-public.rwlb.rds.aliyuncs.com
TRACKING_DB_PORT=3306
TRACKING_DB_NAME=compass_prod
TRACKING_DB_USER=compass_viewer
TRACKING_DB_PASSWORD=
# compass-agent 仓库路径，仅字典同步脚本使用：
#   node scripts/sync-event-dict.mjs
COMPASS_AGENT_DIR=
```

- [ ] **Step 1b: 把 `data/` 加进打包白名单（否则打包版必然失效）**

`scripts/prepare-sidecar.mjs:60` 的 staging 白名单是 `['server.js','package.json','package-lock.json','src','public']` —— **没有 `data`**。Tauri 打包后 `data/event-dict.json` 不存在，`loadDict()` 100% 返回 null，功能在打包版里完全不可用，而开发机上一切正常。这类「只在打包后才复现」的缺陷排查成本极高。

把 `'data'` 加进该白名单。

- [ ] **Step 2: 确认本地 .env 已填密码**

Run: `node -e "console.log(process.env.TRACKING_DB_PASSWORD?'已配置':'未配置')" `（需先加载 .env，或直接检查文件内容）
Expected: 已配置

---

## Task 15: 集成验证（人工，真机）

这些无法自动化，必须人工走一遍。

- [ ] **Step 1: 重启机器人**

Run: `pm2 restart claude-feishu`（或按项目实际启动方式）
检查启动日志中出现 `字典快照已加载 { events: 677, ... }` 与插件加载成功

- [ ] **Step 2: 正常路径**

在飞书发：`帮我统计埋点: 最近7天会话发送的情况`
Expected: 先收到「📊 收到，正在理解需求…」，随后收到文字摘要 + 一个 `.html` 附件

- [ ] **Step 3: 你举的那个例子**

发：`帮我统计埋点: 帮我拿最近一个月的宝宝辅食页面的埋点`
Expected: 报告的时间范围是「今天往前 30 天」，统计对象是宝宝辅食相关**页面**

- [ ] **Step 4: 只发前缀**

发：`帮我统计埋点`
Expected: 回追问文案，**不启动任何查询**

- [ ] **Step 5: 前缀不在开头**

发：`这个需求要帮我统计埋点: 分享`
Expected: **不触发**本功能，走常规流程

- [ ] **Step 6: 非可信人**

用另一个账号发触发指令
Expected: **不触发**本功能，走常规流程（不应回「你没权限」——功能存在本身都不该暴露）

- [ ] **Step 7: 匹配不到**

发：`帮我统计埋点: 统计一下火星移民的转化率`
Expected: 回「没找到相关埋点」+ 业务模块提示，不生成空报告

- [ ] **Step 8: 报告内容核对**

打开附件，逐项检查：
- 时间范围与请求一致
- 脚注写明「已排除 devtools」「已排除内测用户 N 个」
- 若区间含今天，脚注有「今日数据截至 HH:MM，尚不完整」
- 断网后重新打开，图表仍正常显示

- [ ] **Step 9: 数字交叉验证（最关键的一步）**

挑一个后台报表页已有的指标（如某天的会话发送次数），与机器人报告的数字对比。
Expected: 完全一致。**不一致说明口径没对齐，必须查清再交付** —— 一个对不上的数字会让整套系统失去信任。

- [ ] **Step 10: 群聊验证**

在群里 @ 机器人并发送触发指令
Expected: 正常工作；不 @ 时沉默

---

## 自查记录

**Spec 覆盖检查**：

| Spec 章节 | 对应任务 |
|---|---|
| §3 架构与模块划分 | Task 13 |
| §4 触发契约 | Task 3、Task 13 |
| §4 权限 | Task 1、Task 13 |
| §5 两阶段推理 | Task 9 |
| §5 召回三路合并 | Task 4 |
| §6 QuerySpec 与字段来源 | Task 6、Task 13 |
| §6 校验规则 | Task 6 |
| §7 SQL 口径 | Task 10 |
| §8 HTML 报告与脚注 | Task 11 |
| §8 脚本输出约定 | Task 11 |
| §9 lark 发文件 | Task 12 |
| §9 摘要文本 | Task 7、Task 13 |
| §10 失败处理全表 | Task 13 |
| §11 字典同步 | Task 2、Task 8 |
| §12 配置项 | Task 14 |
| §13 测试策略 | Task 3-7（单测）、Task 15（人工） |
| §14 时间解析口径 | Task 5（收敛）、Task 9（prompt 规则） |

无遗漏。

**额外纳入**：Task 1 修复 `resolveTrustedOpenIds` 误传参的既有 bug —— 该 bug 让 `\10001`/`\10002`/`feedback` 的可信名单门禁静默失效，且本功能要复用同一把尺子，不能复制这个错误。

**命名一致性检查**：`parseTrackingCommand` / `recallCandidates` / `normalizeRange` / `inferGroupBy` / `validateSelection` / `buildSummaryText` / `buildReportFileName` / `loadDict` / `understandRequest` / `pickTargets` / `beijingNow` / `uploadFile` / `sendFile` —— 定义处与调用处签名一致。

**已知取舍**：
- `total_uv` 取各项最大值作为下界，而非精确去重。精确跨事件去重需要一次额外的全表 `COUNT(DISTINCT)` 查询，成本高且对「看趋势」这个主要用途没有增益。报告脚注已写明这一点，避免被误读为精确值。


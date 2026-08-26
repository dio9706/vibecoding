# 新用户首次引导 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 首次打开应用（无任何模型凭证）时，用启动罩原地转成的全屏引导接管界面，走完「添加模型（必填）/ 飞书 open_id（选填）/ 飞书机器人（选填）/ 一键导入」才放行；同时补全配置导出包，纳入 `action-configs.json`。

**Architecture:** 复用现有启动罩 `#bootOverlay` 而非新建 overlay——LOGO 无卸载重建、视觉零闪断，且启动罩天然全屏，能挡住「点了必然报错」的侧栏/顶栏/输入框。`boot-gate.js` 只增加一个「撤罩前问一句有没有人接管」的 handoff 协议，引导逻辑全部落在新模块 `onboarding.js`。判定与表单校验抽成无 DOM、无 fetch 的纯函数 `onboarding.logic.js` 以便单测。厂商预设与配置导入流程从 `settings-panel.js` 抽出成共用模块，避免第二个使用方复制一份。

**Tech Stack:** 原生 ES modules（无构建）、CSS transform 动画、`node --test` 内置测试运行器。

**设计依据:** `docs/superpowers/specs/2026-08-26-onboarding-first-run-design.md`

---

## ⚠️ 本计划的提交约定（覆盖 skill 默认行为）

**每个任务末尾都不做 git 提交。** 用户的协作习惯是「改动留工作区，提交时机由我掌控」。因此各任务的收尾步骤是**自查**而非 `git commit`。执行者不得擅自 `git add` / `git commit` / 建分支。

## 文件结构

| 文件 | 性质 | 单一职责 |
|---|---|---|
| `public/js/vendor-presets.js` | 新增 | 只存厂商预设数据与 baseURL 反查表 |
| `public/js/vendor-presets.test.js` | 新增 | 上者单测（取代 `settings-panel.vendor.test.js`） |
| `public/js/config-import.js` | 新增 | 只做「解析配置文件 → 校验 → 可选确认 → POST」一件事 |
| `public/js/onboarding.logic.js` | 新增 | 只做新用户判定与表单校验的纯函数 |
| `public/js/onboarding.logic.test.js` | 新增 | 上者单测 |
| `public/js/onboarding.js` | 新增 | 只做引导的 DOM 编排、动画时序与请求发送 |
| `public/css/onboarding.css` | 新增 | 只放引导态样式（`app.css` 已 110KB，不再往里堆） |
| `public/index.html` | 改 | 启动罩内加包裹层与面板骨架、引入新 CSS |
| `public/js/boot-gate.js` | 改 | 增加撤罩 handoff 协议（职责仍是「等后端 + 撤罩」） |
| `public/app.js` | 改 | 注册 handoff |
| `public/js/settings-panel.js` | 改 | 删除已抽出的常量与导入流程，改为 import |
| `src/store/config-transfer.js` | 改 | 导出包升 version 2，多带 `actionConfigs` |
| `src/store/config-transfer.test.js` | 改 | 签名变更适配 + v2/v1 兼容用例 |
| `src/entrypoints/web/routes-settings.js` | 改 | export 带上 `getConfigs()`，import 落 `saveConfigs()` |
| `public/js/settings-panel.vendor.test.js` | 删除 | 被 `vendor-presets.test.js` 取代 |

---

## Task 1: 抽出 vendor-presets.js

把厂商预设从 `settings-panel.js` 抽成独立模块，让引导能复用。

**关键背景：** 现有 `public/js/settings-panel.vendor.test.js` 不 import 被测模块，而是 `fs.readFileSync` 读源码、用 `src.indexOf('const VENDOR_PRESETS')` 到 `src.indexOf('const SUBSCRIPTION_TYPES')` 切一段文本，再 `new Function` 执行。常量一搬走，`indexOf` 返回 -1，`before` 里的断言就会失败。所以本任务必须连带改造这个测试。原注释说明它这么写是因为「settings-panel.js 顶层 import 了 util/ui，在 node 里等于启动半个前端」——抽成纯数据模块后这个顾虑不存在，可以直接 import。

**注意 `SUBSCRIPTION_TYPES` 不抽：** 全库搜索它只有定义处、没有任何使用点（`#tokenSubscription` 的 options 硬编码在 `index.html`），是死代码。且后端 `handleSettings` 的 `tokens/add` 分支只调 `addToken(str(data.label), str(data.token))`，`subscription` 传了也被丢弃。本次不动它，留在 `settings-panel.js` 原处。

**Files:**
- Create: `public/js/vendor-presets.js`
- Create: `public/js/vendor-presets.test.js`
- Delete: `public/js/settings-panel.vendor.test.js`
- Modify: `public/js/settings-panel.js:1-55`（删除常量、加 import）

- [ ] **Step 1: 写新测试文件（此时会失败，模块还不存在）**

创建 `public/js/vendor-presets.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VENDOR_PRESETS, BASEURL_TO_VENDOR } from './vendor-presets.js';

/**
 * 自定义模型凭证的厂商预设与反查表。
 *
 * 背景：凭证列表一直显示「—」——前端 addCredentialUI 在 POST body 里传了 vendor，
 * 但后端 handleCredentialsAdd 只取 apiKey/baseURL/model/label 就把它丢了，
 * 而 renderCredList 又去读 c.vendor，于是那一列从上线起就没亮过。
 *
 * 补上存字段只能救新凭证，存量的仍然没有 vendor。BASEURL_TO_VENDOR 用 baseURL
 * 把厂商推回来，省掉一次数据迁移——预设的 baseURL 本来就是各厂商唯一的。
 *
 * 注：本测试原先叫 settings-panel.vendor.test.js，靠 fs 读源码 + new Function
 * 切一段文本来跑，因为常量埋在 settings-panel.js 里而那个文件顶层 import 了
 * util/ui（在 node 里等于启动半个前端）。常量抽成纯数据模块后可以直接 import，
 * 不必再依赖「源码里有 const VENDOR_PRESETS 这一行」这种脆弱前提。
 */

test('反查表：预设 baseURL 能推回厂商 key', () => {
  assert.equal(BASEURL_TO_VENDOR['https://api.deepseek.com/v1'], 'deepseek');
  assert.equal(BASEURL_TO_VENDOR['https://api.openai.com/v1'], 'openai');
  assert.equal(BASEURL_TO_VENDOR['https://open.bigmodel.cn/api/paas/v4'], 'zhipu');
});

// custom 的 baseURL 是空串。不过滤的话它会在表里占住 '' 这个键，
// 于是任何缺 baseURL 的凭证都会被误判成「其他（自定义）」。
test('反查表：custom 预设（空 baseURL）不进表', () => {
  assert.equal('' in BASEURL_TO_VENDOR, false);
  assert.equal(Object.values(BASEURL_TO_VENDOR).includes('custom'), false);
});

test('反查表：未知 baseURL 查不到（调用方据此显示「—」）', () => {
  assert.equal(BASEURL_TO_VENDOR['https://api.unknown-vendor.com/v1'], undefined);
  assert.equal(BASEURL_TO_VENDOR[undefined], undefined);
});

test('反查表：每个 value 都是 VENDOR_PRESETS 的合法 key', () => {
  for (const [baseURL, key] of Object.entries(BASEURL_TO_VENDOR)) {
    assert.ok(VENDOR_PRESETS[key], `${key} 不是合法厂商 key`);
    assert.equal(VENDOR_PRESETS[key].baseURL, baseURL, `${key} 的 baseURL 与反查表不一致`);
  }
});

// 反查靠 baseURL 唯一——两个厂商共用同一个 baseURL 会让后者覆盖前者，静默推错厂商
test('反查表：预设 baseURL 无重复（否则反查会覆盖）', () => {
  const urls = Object.values(VENDOR_PRESETS).map((p) => p.baseURL).filter(Boolean);
  assert.equal(new Set(urls).size, urls.length, '存在重复的预设 baseURL');
});

// 引导页的厂商下拉由 VENDOR_PRESETS 动态生成（不像设置页那样硬编码 option），
// 依赖每个预设都有 label 与 models 数组
test('每个预设都有 label 与 models 数组（引导页下拉生成依赖）', () => {
  for (const [key, p] of Object.entries(VENDOR_PRESETS)) {
    assert.equal(typeof p.label, 'string', `${key} 缺 label`);
    assert.ok(p.label.length > 0, `${key} 的 label 为空`);
    assert.ok(Array.isArray(p.models), `${key} 的 models 不是数组`);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test 2>&1 | grep -A 3 "vendor-presets"`
Expected: FAIL，报错形如 `Cannot find module .../public/js/vendor-presets.js`

- [ ] **Step 3: 创建 vendor-presets.js**

创建 `public/js/vendor-presets.js`，内容从 `settings-panel.js:7-50` 原样搬迁（注释一并搬走），加上 `export`：

```js
/** 自定义模型（openai-compat）凭证的厂商预设与 baseURL 反查表。
 *  独立成模块的原因：设置页与新用户引导两处都要用；留在 settings-panel.js 里的话
 *  第二个使用方只能复制一份，加厂商就变成改两处、必然漂移。
 *  纯数据、无副作用，node 下可直接 import 单测。 */

export const VENDOR_PRESETS = {
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o3-mini'],
  },
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  aliyun: {
    label: '阿里云百炼',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
  },
  moonshot: {
    label: '月之暗面',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  zhipu: {
    label: '智谱',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4', 'glm-4-flash'],
  },
  custom: {
    label: '其他（自定义）',
    baseURL: '',
    models: [],
  },
};

// baseURL → vendor key 反查表：vendor 字段是后加的，存量凭证没有它，
// 靠 baseURL 推回厂商，省掉一次数据迁移。
// 必须过滤空 baseURL —— custom 预设的 baseURL 是空串，不排除的话
// 会在表里占据 '' 这个键，把所有缺 baseURL 的凭证误判成「其他（自定义）」。
export const BASEURL_TO_VENDOR = Object.fromEntries(
  Object.entries(VENDOR_PRESETS)
    .filter(([, p]) => p.baseURL)
    .map(([k, p]) => [p.baseURL, k]),
);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test 2>&1 | grep -A 3 "vendor-presets"`
Expected: PASS，6 个 test 全绿

- [ ] **Step 5: 删除旧测试文件**

```bash
rm public/js/settings-panel.vendor.test.js
```

- [ ] **Step 6: 改 settings-panel.js 用 import**

删除 `public/js/settings-panel.js` 的第 7-50 行（从 `// ---- 模型配置预设 ----` 到 `BASEURL_TO_VENDOR` 定义结束的 `);`）。

**保留** 第 52-55 行的 `SUBSCRIPTION_TYPES`（本次不动，见任务开头说明）。

在第 5 行 `import { toast, confirmDialog, promptDialog } from './ui.js';` 之后插入：

```js
import { VENDOR_PRESETS, BASEURL_TO_VENDOR } from './vendor-presets.js';
```

改完后文件开头应是：

```js
/** 设置页面板：Claude 账号池 / 自定义模型凭证 / MCP 服务器 / 基础偏好 / 配置导入导出。
 *  机器人（凭证/角色/文案/动作）在 bots-panel.js。
 *  入口 loadSettings + bindConfigTransfer 由 showView('settings') 调用；设置按钮绑定留在 app.js。 */
import { $ } from './util.js';
import { toast, confirmDialog, promptDialog } from './ui.js';
import { VENDOR_PRESETS, BASEURL_TO_VENDOR } from './vendor-presets.js';

// 订阅类型配置：扩展时同步更新 index.html #tokenSubscription 的 options
const SUBSCRIPTION_TYPES = [
  { value: 'claude', label: 'Claude' },
];
```

- [ ] **Step 7: 验证抽出没破坏使用点**

`VENDOR_PRESETS` / `BASEURL_TO_VENDOR` 在 `settings-panel.js` 里的使用点只有三处（`setupVendorListener` 的 `VENDOR_PRESETS[vendor]`、`renderCredList` 的 `BASEURL_TO_VENDOR[c.baseURL]` 与 `VENDOR_PRESETS[vendorKey]?.label`），改 import 后行为不变。

Run: `rg -n "VENDOR_PRESETS|BASEURL_TO_VENDOR" public/js/settings-panel.js`
Expected: 4 行输出——1 行 import + 第 293 行附近 1 处 + 第 358-359 行附近 2 处，**没有** `const VENDOR_PRESETS =` 的定义行

Run: `npm test`
Expected: 全部通过，无新增失败

- [ ] **Step 8: 自查（不提交）**

确认改动仅涉及：新增 `vendor-presets.js` / `vendor-presets.test.js`，删除 `settings-panel.vendor.test.js`，`settings-panel.js` 净减约 44 行。**不要 git commit。**

---

## Task 2: config-transfer.js 升 version 2，纳入 actionConfigs

**Files:**
- Modify: `src/store/config-transfer.js`（全文重写）
- Modify: `src/store/config-transfer.test.js`（适配签名 + 新用例）

**破坏性变更提示：** `buildExport(settings, exportedAt)` 变为 `buildExport(settings, actionConfigs, exportedAt)`。现有测试第 17 行 `buildExport(settings, '2026-07-21T00:00:00.000Z')` 会把时间戳传进 `actionConfigs` 位，必须一并改。唯一的生产调用点是 `src/entrypoints/web/routes-settings.js:318`，在 Task 3 处理。

- [ ] **Step 1: 改测试（含现有用例适配 + 新用例）**

把 `src/store/config-transfer.test.js` 整个替换为：

```js
/**
 * 配置导入导出纯函数单测。
 * buildExport：把 settings + 托管配置包成带类型/版本标记的导出对象。
 * parseImport：校验导入对象的类型/版本/结构，返回 {ok, settings, actionConfigs} | {ok:false, error}。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_TYPE,
  CONFIG_VERSION,
  buildExport,
  parseImport,
} from './config-transfer.js';

test('buildExport：包上类型/版本/时间戳，原样带上 settings 与 actionConfigs', () => {
  const settings = { lark: { appId: 'cli_x' }, tokens: [{ id: 't1' }] };
  const actionConfigs = [{ id: 'ac_1', name: '清理账号数据' }];
  const out = buildExport(settings, actionConfigs, '2026-07-21T00:00:00.000Z');
  assert.equal(out.__type, CONFIG_TYPE);
  assert.equal(out.version, CONFIG_VERSION);
  assert.equal(out.exportedAt, '2026-07-21T00:00:00.000Z');
  assert.deepEqual(out.settings, settings);
  assert.deepEqual(out.actionConfigs, actionConfigs);
});

test('buildExport：缺省时间戳/settings/actionConfigs 有安全默认', () => {
  const out = buildExport();
  assert.equal(out.exportedAt, null);
  assert.deepEqual(out.settings, {});
  assert.deepEqual(out.actionConfigs, []);
});

// 非数组归一为 []：导出侧宁可写个空数组，也不要往包里塞一个字符串
// 让导入侧的 Array.isArray 判成 null（那会被当成「旧版包」而跳过写盘）
test('buildExport：actionConfigs 非数组 → 归一为空数组', () => {
  assert.deepEqual(buildExport({}, 'not-an-array').actionConfigs, []);
  assert.deepEqual(buildExport({}, null).actionConfigs, []);
  assert.deepEqual(buildExport({}, { a: 1 }).actionConfigs, []);
});

test('CONFIG_VERSION 已升到 2', () => {
  assert.equal(CONFIG_VERSION, 2);
});

test('parseImport：v2 合法对象通过，回传 settings 与 actionConfigs', () => {
  const raw = {
    __type: CONFIG_TYPE,
    version: 2,
    settings: { tokens: [] },
    actionConfigs: [{ id: 'ac_1' }],
  };
  const r = parseImport(raw);
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings, { tokens: [] });
  assert.deepEqual(r.actionConfigs, [{ id: 'ac_1' }]);
});

test('parseImport：v2 往返（buildExport → parseImport）', () => {
  const settings = { tokens: [{ id: 't1' }], bots: [{ id: 'b1' }] };
  const actionConfigs = [{ id: 'ac_1', botId: 'b1' }];
  const r = parseImport(buildExport(settings, actionConfigs, null));
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings, settings);
  assert.deepEqual(r.actionConfigs, actionConfigs);
});

// v1 包没有 actionConfigs 字段。回 null 而不是 [] —— 语义是「本次导入不涉及托管配置」，
// 调用方据此跳过写 action-configs.json。回 [] 会把用户现有的动作全清空。
test('parseImport：v1 旧包仍可导入，actionConfigs 为 null（不涉及）', () => {
  const raw = { __type: CONFIG_TYPE, version: 1, settings: { tokens: [] } };
  const r = parseImport(raw);
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings, { tokens: [] });
  assert.equal(r.actionConfigs, null);
});

test('parseImport：v2 包但 actionConfigs 非数组 → null（按不涉及处理，不清空用户数据）', () => {
  const base = { __type: CONFIG_TYPE, version: 2, settings: {} };
  assert.equal(parseImport({ ...base, actionConfigs: 'x' }).actionConfigs, null);
  assert.equal(parseImport({ ...base, actionConfigs: { a: 1 } }).actionConfigs, null);
  assert.equal(parseImport(base).actionConfigs, null);
});

test('parseImport：类型不符 → ok:false', () => {
  const r = parseImport({ __type: 'other', version: 1, settings: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /类型/);
});

test('parseImport：不支持的版本 → ok:false', () => {
  assert.equal(parseImport({ __type: CONFIG_TYPE, version: 3, settings: {} }).ok, false);
  assert.equal(parseImport({ __type: CONFIG_TYPE, version: 999, settings: {} }).ok, false);
  assert.equal(parseImport({ __type: CONFIG_TYPE, version: 0, settings: {} }).ok, false);
  assert.match(parseImport({ __type: CONFIG_TYPE, version: 3, settings: {} }).error, /版本/);
});

test('parseImport：settings 缺失/非对象 → ok:false', () => {
  assert.equal(parseImport({ __type: CONFIG_TYPE, version: CONFIG_VERSION }).ok, false);
  assert.equal(parseImport({ __type: CONFIG_TYPE, version: CONFIG_VERSION, settings: [] }).ok, false);
});

test('parseImport：非对象/null/数组入参 → ok:false，不抛', () => {
  assert.equal(parseImport(null).ok, false);
  assert.equal(parseImport('x').ok, false);
  assert.equal(parseImport([]).ok, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/store/config-transfer.test.js`
Expected: FAIL —— `CONFIG_VERSION 已升到 2` 断言失败（实际为 1）、`version: 3` 未被拒（当前只比对 `!== CONFIG_VERSION`，1 会被拒而 2 不被接受）、`actionConfigs` 相关断言全部 undefined

- [ ] **Step 3: 实现**

把 `src/store/config-transfer.js` 整个替换为：

```js
/**
 * 配置导入导出的纯函数（无 I/O，可单测）。
 * 唯一真源：导出包的类型标记与版本号。导入前用 parseImport 做结构校验。
 */
export const CONFIG_TYPE = 'claude-agent-config';
export const CONFIG_VERSION = 2;

// 导入侧接受的版本。v1 只有 settings；v2 起多一个顶层 actionConfigs。
// 保留 v1 是因为用户手里已经有导出过的旧包，拒掉等于让那些文件作废。
const SUPPORTED_VERSIONS = [1, 2];

/** 把 settings 与托管配置包成带类型/版本/时间戳的导出对象。
 *  actionConfigs 单独占一个顶层字段而不塞进 settings：它落盘在另一个文件
 *  （action-configs.json），混进 settings 会让导入侧分不清该往哪个文件写。 */
export function buildExport(settings, actionConfigs, exportedAt) {
  return {
    __type: CONFIG_TYPE,
    version: CONFIG_VERSION,
    exportedAt: exportedAt || null,
    settings: settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {},
    actionConfigs: Array.isArray(actionConfigs) ? actionConfigs : [],
  };
}

/** 校验导入对象；通过返回 {ok:true, settings, actionConfigs}，否则 {ok:false, error}。
 *
 *  actionConfigs 为 null 的语义是「本次导入不涉及托管配置」——v1 旧包没这个字段，
 *  或 v2 包里该字段是脏数据。调用方必须据此**跳过**写 action-configs.json，
 *  而不是拿一个空数组去覆盖，那会把用户现有的动作全部清空。 */
export function parseImport(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '配置文件格式不正确' };
  }
  if (raw.__type !== CONFIG_TYPE) {
    return { ok: false, error: '配置文件类型不匹配' };
  }
  if (!SUPPORTED_VERSIONS.includes(raw.version)) {
    return { ok: false, error: '配置文件版本不支持' };
  }
  if (!raw.settings || typeof raw.settings !== 'object' || Array.isArray(raw.settings)) {
    return { ok: false, error: '配置内容缺失' };
  }
  return {
    ok: true,
    settings: raw.settings,
    actionConfigs: Array.isArray(raw.actionConfigs) ? raw.actionConfigs : null,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/store/config-transfer.test.js`
Expected: PASS，13 个 test 全绿

- [ ] **Step 5: 自查（不提交）**

确认 `git diff --stat` 只涉及 `src/store/config-transfer.js` 与 `src/store/config-transfer.test.js`。**不要 git commit。**

---

## Task 3: routes-settings.js 导出/导入接入 action-configs

**Files:**
- Modify: `src/entrypoints/web/routes-settings.js:33`（import）、`:315-343`（export/import handler）

本任务无自动化测试（`routes-settings.js` 在项目里没有对应测试文件，路由层依赖 fs + 全局状态），靠 Task 11 的手工验证清单第 9、10 项覆盖。

- [ ] **Step 1: 补 import**

`src/entrypoints/web/routes-settings.js` 第 33 行现为：

```js
import { deleteConfigsByBot } from '../../store/action-configs.js';
```

改为：

```js
import { deleteConfigsByBot, getConfigs, saveConfigs } from '../../store/action-configs.js';
```

- [ ] **Step 2: 改导出 handler**

把 `handleSettingsExport`（约第 315-324 行）替换为：

```js
/** 导出全部配置（原始明文，含 token 值与 App Secret）。
 *  含托管配置（action-configs.json）：它与 bots 有 botId 引用关系，
 *  只导 bots 不导动作，换机导入后关联会断、托管配置整块丢失。 */
export function handleSettingsExport(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  const payload = buildExport(getSettings(), getConfigs(), new Date().toISOString());
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="claude-agent-config-${date}.json"`);
  res.writeHead(200);
  res.end(JSON.stringify(payload, null, 2));
}
```

- [ ] **Step 3: 改导入 handler**

把 `handleSettingsImport`（约第 326-343 行）替换为：

```js
/** 导入配置：校验类型/版本后整体覆盖写盘，重排 token 定时器。 */
export function handleSettingsImport(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (raw) => {
    const parsed = parseImport(raw);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
    try {
      replaceSettings(parsed.settings);
      // 托管配置必须在 migrateToBots 之前落盘：后者内部的 adoptOrphanConfigs 会读
      // action-configs.json 做「孤儿动作收养」，顺序反了就是拿导入前的旧动作去收养，
      // 新导入的动作永远认不到 bot。
      // null 表示本次不涉及托管配置（v1 旧包）——跳过而不是写空数组，否则清空用户现有动作。
      if (parsed.actionConfigs !== null) saveConfigs(parsed.actionConfigs);
      migrateToBots(); // 旧版配置文件（无 bots）→ 自动升级为机器人实体 + 动作收养
      // 导入的 token 可能带 rateLimited 的 resetsAt → 重排到点恢复定时器
      scheduleAllSwitchBacks();
    } catch (e) {
      return sendJson(res, 500, { error: '导入失败：' + (e?.message || e) });
    }
    logger.info('web', '配置已导入', {
      tokens: (parsed.settings.tokens || []).length,
      actionConfigs: parsed.actionConfigs === null ? '(旧版包，未包含)' : parsed.actionConfigs.length,
    });
    // actionConfigsImported 供前端区分提示文案：旧版包要告诉用户托管配置没带过来，
    // 否则他会以为配齐了，直到某天发现动作全没了
    return sendJson(res, 200, { ok: true, actionConfigsImported: parsed.actionConfigs !== null });
  });
}
```

- [ ] **Step 4: 验证语法与既有测试**

Run: `node --check src/entrypoints/web/routes-settings.js`
Expected: 无输出（语法通过）

Run: `npm test`
Expected: 全部通过，无新增失败

- [ ] **Step 5: 自查（不提交）**

确认 `buildExport` 已无遗留的两参调用：

Run: `rg -n "buildExport\(" src/`
Expected: 2 处——`config-transfer.js` 的定义、`routes-settings.js` 的三参调用。**不要 git commit。**

---

## Task 4: 抽出 config-import.js

把「解析文件 → 校验 → 确认 → POST」从 `settings-panel.js` 抽出，供设置页与引导共用。

**Files:**
- Create: `public/js/config-import.js`
- Modify: `public/js/settings-panel.js:97-163`（`bindConfigTransfer` 的导入分支）

- [ ] **Step 1: 创建 config-import.js**

```js
/** 配置文件导入流程：解析 → 类型前置校验 →（可选）覆盖确认 → POST → 结果。
 *  设置页与新用户引导共用。引导场景不传 confirm——新用户本来是空配置，
 *  「将覆盖当前全部配置」那句危险确认在那里纯属误导。 */

// 与后端 src/store/config-transfer.js 的 CONFIG_TYPE 保持一致。
// 前端无法 import src/（那是 Node 侧模块，浏览器取不到），只能硬编码一份；
// 这里只做「早失败」的前置校验，权威校验在后端 parseImport。
const CONFIG_TYPE = 'claude-agent-config';

/**
 * 读取并导入配置文件。
 * @param {File} file 用户选中的 .json 配置文件
 * @param {{confirm?: () => Promise<boolean>}} opts 省略 confirm 则跳过覆盖确认
 * @returns {Promise<{ok: boolean, error?: string, cancelled?: boolean, actionConfigsImported?: boolean}>}
 *   cancelled 与 error 分开：用户主动取消不该弹错误提示
 */
export async function importConfigFile(file, { confirm } = {}) {
  if (!file) return { ok: false, error: '未选择文件' };
  let raw;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    return { ok: false, error: '配置文件格式不正确' };
  }
  if (!raw || raw.__type !== CONFIG_TYPE) {
    return { ok: false, error: '配置文件类型不匹配' };
  }
  if (confirm && !(await confirm())) return { ok: false, cancelled: true };
  try {
    const r = await fetch('/api/settings/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(raw),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) return { ok: false, error: d.error || 'HTTP ' + r.status };
    return { ok: true, actionConfigsImported: !!d.actionConfigsImported };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}
```

- [ ] **Step 2: 改 settings-panel.js 调用它**

在 import 区（Task 1 加的 `vendor-presets.js` 那行之后）插入：

```js
import { importConfigFile } from './config-import.js';
```

把 `bindConfigTransfer` 里的 `fileInput.addEventListener('change', ...)` 整块（原第 127-162 行）替换为：

```js
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files && fileInput.files[0];
          fileInput.value = ''; // 允许再次选同一文件
          if (!file) return;
          const r = await importConfigFile(file, {
            confirm: () =>
              confirmDialog({
                title: '导入配置',
                message: '导入将覆盖当前全部配置（机器人 / 账号池 / 托管配置 / 偏好），确认继续？覆盖后不可恢复。',
                confirmText: '确认导入',
                danger: true,
              }),
          });
          if (r.cancelled) return;
          if (!r.ok) {
            toast('导入失败：' + r.error);
            return;
          }
          // 旧版包不含托管配置，得明说；否则用户以为配齐了，回头发现动作全没了
          toast(
            r.actionConfigsImported
              ? '导入成功（含托管配置），正在重新加载…'
              : '导入成功。该文件为旧版，不含托管配置，需到设置页重新配置动作',
          );
          setTimeout(() => location.reload(), r.actionConfigsImported ? 800 : 2400);
        });
```

注意确认文案里补了「托管配置」——导入现在真的会覆盖它，原文案已不准确。

- [ ] **Step 3: 验证语法**

Run: `node --check public/js/config-import.js && node --check public/js/settings-panel.js`
Expected: 无输出

Run: `npm test`
Expected: 全部通过

- [ ] **Step 4: 自查（不提交）**

确认 `settings-panel.js` 里已无 `JSON.parse(await file.text())` 与 `'/api/settings/import'` 的直接调用：

Run: `rg -n "settings/import|file.text\(\)" public/js/settings-panel.js`
Expected: 无输出。**不要 git commit。**

---

## Task 5: onboarding.logic.js 纯逻辑与单测

**Files:**
- Create: `public/js/onboarding.logic.js`
- Create: `public/js/onboarding.logic.test.js`

- [ ] **Step 1: 写测试**

创建 `public/js/onboarding.logic.test.js`：

```js
/**
 * 新用户引导的纯逻辑单测。
 * isNewUser：靠 settings.tokens 是否为空判定「还没配任何模型」。
 * validateOnboardForm：模型段必填（按 Tab 分支），飞书两段选填但「填了就要填全」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewUser, validateOnboardForm } from './onboarding.logic.js';

// ---- isNewUser ----

test('isNewUser：tokens 为空数组 → 新用户', () => {
  assert.equal(isNewUser({ tokens: [] }), true);
});

test('isNewUser：有任意 token → 老用户', () => {
  assert.equal(isNewUser({ tokens: [{ id: 't1' }] }), false);
});

// tokens 是两类模型（Claude 账号池 / openai-compat 凭证）的唯一存储，
// 所以一个 openai-compat 凭证也足以判定为老用户
test('isNewUser：只有 openai-compat 凭证也算老用户（共用 tokens 存储）', () => {
  assert.equal(isNewUser({ tokens: [{ id: 'c1', providerId: 'openai-compat' }] }), false);
});

// 脏数据/字段缺失按「未配置」处理：宁可多引导一次，也不要让真新用户
// 掉进一个必然报错的界面
test('isNewUser：字段缺失/非数组/入参为空 → 按新用户处理', () => {
  assert.equal(isNewUser({}), true);
  assert.equal(isNewUser({ tokens: 'x' }), true);
  assert.equal(isNewUser({ tokens: null }), true);
  assert.equal(isNewUser(null), true);
  assert.equal(isNewUser(undefined), true);
});

// ---- validateOnboardForm：模型段（必填）----

const CLAUDE_OK = { modelTab: 'claude', claude: { token: 'sk-ant-oat01-abc' } };
const CUSTOM_OK = {
  modelTab: 'custom',
  custom: { apiKey: 'sk-x', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
};

test('模型段 claude Tab：token 有值 → 通过', () => {
  const r = validateOnboardForm(CLAUDE_OK);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, {});
});

test('模型段 claude Tab：token 空/纯空格/缺失 → 报错', () => {
  assert.match(validateOnboardForm({ modelTab: 'claude', claude: { token: '' } }).errors.model, /Token/);
  assert.match(validateOnboardForm({ modelTab: 'claude', claude: { token: '   ' } }).errors.model, /Token/);
  assert.match(validateOnboardForm({ modelTab: 'claude', claude: {} }).errors.model, /Token/);
  assert.match(validateOnboardForm({ modelTab: 'claude' }).errors.model, /Token/);
});

test('模型段 custom Tab：三项齐 → 通过', () => {
  const r = validateOnboardForm(CUSTOM_OK);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, {});
});

test('模型段 custom Tab：缺 apiKey / baseURL / model 各自报错', () => {
  const mk = (patch) => ({ modelTab: 'custom', custom: { ...CUSTOM_OK.custom, ...patch } });
  assert.match(validateOnboardForm(mk({ apiKey: '' })).errors.model, /API Key/);
  assert.match(validateOnboardForm(mk({ baseURL: '' })).errors.model, /Base URL/);
  assert.match(validateOnboardForm(mk({ model: '' })).errors.model, /模型/);
});

// modelTab 缺失/非法时按 claude 分支走：默认 Tab 就是 Claude 账号，
// 不能因为一个脏枚举值把校验整段跳过、放一个空模型进去
test('模型段：modelTab 缺失或非法 → 按 claude 分支校验', () => {
  assert.match(validateOnboardForm({}).errors.model, /Token/);
  assert.match(validateOnboardForm({ modelTab: 'wat' }).errors.model, /Token/);
  assert.equal(validateOnboardForm({ modelTab: 'wat', claude: { token: 'x' } }).ok, true);
});

// ---- validateOnboardForm：open_id（选填）----

test('open_id：空 → 通过；正常值 → 通过', () => {
  assert.equal(validateOnboardForm({ ...CLAUDE_OK, openId: '' }).ok, true);
  assert.equal(validateOnboardForm({ ...CLAUDE_OK, openId: 'ou_abc123' }).ok, true);
});

test('open_id：超 128 字符 → 报错（对齐后端上限）', () => {
  const r = validateOnboardForm({ ...CLAUDE_OK, openId: 'o'.repeat(129) });
  assert.equal(r.ok, false);
  assert.match(r.errors.openId, /128/);
});

test('open_id：正好 128 字符 → 通过（边界）', () => {
  assert.equal(validateOnboardForm({ ...CLAUDE_OK, openId: 'o'.repeat(128) }).ok, true);
});

// ---- validateOnboardForm：机器人（选填，填了就要填全）----

const APP_ID = 'cli_0123456789abcdef';

test('机器人：三字段全空 → 视为未填，通过', () => {
  const r = validateOnboardForm({ ...CLAUDE_OK, bot: { name: '', appId: '', appSecret: '' } });
  assert.equal(r.ok, true);
  assert.equal(r.errors.bot, undefined);
});

test('机器人：appId + appSecret 齐 → 通过', () => {
  assert.equal(
    validateOnboardForm({ ...CLAUDE_OK, bot: { name: '助手', appId: APP_ID, appSecret: 's' } }).ok,
    true,
  );
});

// 只填了名称就动了这一段，此时缺 appId 必须拦住 ——
// 放过去就是拿一个后端存不进的半截配置去调 /api/bots
test('机器人：只填名称 → 要求补 App ID', () => {
  const r = validateOnboardForm({ ...CLAUDE_OK, bot: { name: '助手' } });
  assert.equal(r.ok, false);
  assert.match(r.errors.bot, /App ID/);
});

test('机器人：appId 格式非法 → 报错（对齐后端 cleanBotInput）', () => {
  const bad = ['cli_123', 'cli_0123456789abcdeg', 'xxx_0123456789abcdef', 'cli_0123456789ABCDEF0'];
  for (const appId of bad) {
    const r = validateOnboardForm({ ...CLAUDE_OK, bot: { appId, appSecret: 's' } });
    assert.equal(r.ok, false, `${appId} 应被拒`);
    assert.match(r.errors.bot, /App ID/);
  }
});

test('机器人：appId 大写十六进制合法', () => {
  assert.equal(
    validateOnboardForm({ ...CLAUDE_OK, bot: { appId: 'cli_0123456789ABCDEF', appSecret: 's' } }).ok,
    true,
  );
});

test('机器人：appId 填了但 secret 空 → 报错', () => {
  const r = validateOnboardForm({ ...CLAUDE_OK, bot: { appId: APP_ID, appSecret: '' } });
  assert.equal(r.ok, false);
  assert.match(r.errors.bot, /Secret/);
});

// ---- 多段同时出错 ----

test('多段同时出错 → errors 各段独立可读', () => {
  const r = validateOnboardForm({
    modelTab: 'claude',
    claude: { token: '' },
    openId: 'o'.repeat(200),
    bot: { name: '助手' },
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.model, /Token/);
  assert.match(r.errors.openId, /128/);
  assert.match(r.errors.bot, /App ID/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test public/js/onboarding.logic.test.js`
Expected: FAIL，`Cannot find module .../public/js/onboarding.logic.js`

- [ ] **Step 3: 实现**

创建 `public/js/onboarding.logic.js`：

```js
/** 新用户引导的纯逻辑：判定与表单校验。
 *  无 DOM、无 fetch —— 这层单独拆出来就是为了能在 node 下直接单测，
 *  DOM 编排与请求发送全在 onboarding.js。 */

const APP_ID_RE = /^cli_[0-9a-fA-F]{16}$/; // 与后端 cleanBotInput 的校验保持一致
const OPEN_ID_MAX = 128;                   // 与后端 handleSettings section:'profile' 的上限一致

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** 新用户 = 一个模型凭证都没有。
 *  tokens 是两类模型（Claude 账号池 / openai-compat 自定义凭证）的唯一存储，
 *  所以一个条件就覆盖两类。
 *  非数组（字段缺失 / 脏数据 / 读盘异常）一律按「未配置」处理：多引导一次只是打扰，
 *  漏引导会把真新用户丢进一个必然报错的界面。 */
export function isNewUser(settings) {
  const tokens = settings && settings.tokens;
  return !Array.isArray(tokens) || tokens.length === 0;
}

/**
 * 校验引导表单。
 * @param {{
 *   modelTab?: 'claude' | 'custom',
 *   claude?: { label?: string, token?: string },
 *   custom?: { vendor?: string, apiKey?: string, baseURL?: string, model?: string },
 *   openId?: string,
 *   bot?: { name?: string, appId?: string, appSecret?: string },
 * }} state
 * @returns {{ ok: boolean, errors: { model?: string, openId?: string, bot?: string } }}
 */
export function validateOnboardForm(state) {
  const s = state || {};
  const errors = {};

  // ① 模型段：必填。modelTab 非 'custom' 一律按 claude 分支走 ——
  //    脏枚举值不能让整段校验被跳过，那会放一个空模型进去
  if (s.modelTab === 'custom') {
    const c = s.custom || {};
    if (!str(c.apiKey)) errors.model = '请填写 API Key';
    else if (!str(c.baseURL)) errors.model = '请填写 Base URL';
    else if (!str(c.model)) errors.model = '请填写模型名';
  } else {
    if (!str((s.claude || {}).token)) errors.model = '请填写 Token';
  }

  // ② open_id：选填，填了才校验长度
  if (str(s.openId).length > OPEN_ID_MAX) {
    errors.openId = `open_id 不能超过 ${OPEN_ID_MAX} 字符`;
  }

  // ③ 机器人：选填。三字段全空 = 这段没动，合法；
  //    一旦动了任一个就要求 appId/appSecret 齐全且格式对 ——
  //    否则就是拿一个后端存不进去的半截配置去调 /api/bots
  const b = s.bot || {};
  const botTouched = !!(str(b.name) || str(b.appId) || str(b.appSecret));
  if (botTouched) {
    const appId = str(b.appId);
    if (!appId) errors.bot = '请填写 App ID';
    else if (!APP_ID_RE.test(appId)) errors.bot = 'App ID 格式应为 cli_ 加 16 位十六进制';
    else if (!str(b.appSecret)) errors.bot = '请填写 App Secret';
  }

  return { ok: Object.keys(errors).length === 0, errors };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test public/js/onboarding.logic.test.js`
Expected: PASS，19 个 test 全绿

- [ ] **Step 5: 自查（不提交）**

Run: `npm test`
Expected: 全部通过。**不要 git commit。**

---

## Task 6: boot-gate.js 撤罩 handoff 协议

**Files:**
- Modify: `public/js/boot-gate.js:14-20`（加 `setOverlayHandoff`）、`:71-75`（撤罩前插入接管询问）

- [ ] **Step 1: 加 setOverlayHandoff 导出**

`public/js/boot-gate.js` 第 14 行现为 `let _promise = null;`。在它之后插入：

```js
let _handoff = null;

/** 注册撤罩接管者：boot-gate 在撤罩前 await 它，返回 true 表示接管
 *  （罩子不 hide/remove，生命周期移交给接管者）。
 *  新用户引导用这个复用启动罩，避免另起一个 overlay 导致 LOGO 卸载重建闪断。
 *  必须在 whenBackendReady() 被调用前注册。 */
export function setOverlayHandoff(fn) {
  _handoff = fn;
}
```

- [ ] **Step 2: 撤罩前插入接管询问**

`_run()` 末尾现为：

```js
  if (overlay) {
    overlay.classList.add('hide');
    // 与 .boot-overlay.hide 的 opacity 过渡时长对齐；移除而非仅隐藏，避免残留罩子吃点击
    setTimeout(() => overlay.remove(), 320);
  }
}
```

替换为：

```js
  // 撤罩前问一句有没有人接管（新用户引导要原地复用这个罩子）。
  // 接管者抛异常也照常撤罩：引导炸了顶多没引导，把用户永久锁在罩子里是另一个量级的故障。
  if (_handoff) {
    let taken = false;
    try {
      taken = await _handoff(overlay);
    } catch (e) {
      console.error('[Boot] 撤罩接管者异常，照常撤罩', e);
    }
    if (taken) {
      console.log('[Boot] 启动罩已移交接管者');
      return;
    }
  }

  if (overlay) {
    overlay.classList.add('hide');
    // 与 .boot-overlay.hide 的 opacity 过渡时长对齐；移除而非仅隐藏，避免残留罩子吃点击
    setTimeout(() => overlay.remove(), 320);
  }
}
```

- [ ] **Step 3: 验证语法**

Run: `node --check public/js/boot-gate.js`
Expected: 无输出

- [ ] **Step 4: 自查（不提交）**

确认 `whenBackendReady` 的幂等语义未受影响（`_promise` 逻辑一行未改），且 `_handoff` 为 null 时行为与改动前完全一致。**不要 git commit。**

---

## Task 7: index.html 启动罩结构调整 + 引导面板骨架

**Files:**
- Modify: `public/index.html:7-11`（加 CSS 链接）、`:16-28`（启动罩结构）

**结构决策：** `.ob-status`（启动文案 + 「仍然进入」）放进 `.ob-brand` **内部**，不做兄弟节点。这样 `.boot-overlay` 只有 `brand` + `panel` 两个子节点：`.ob-brand` 内部用 `flex column / align-center / gap:16px`——与现有 `.boot-overlay` 的参数完全一致，非引导态视觉零回归；引导态 status `display:none` 后 brand 高度自然收缩，而它靠 `translate(-50%,-50%)` 定位，收缩后仍然居中，**垂直方向不需要任何硬编码偏移**。做兄弟节点的话，brand 一旦绝对定位，status 就得靠硬编码 top 偏移跟着走，非常脆。

- [ ] **Step 1: 引入 onboarding.css**

在 `public/index.html` 第 11 行 `<link rel="stylesheet" href="/css/req-workbench.css" />` 之后插入：

```html
    <!-- 新用户引导态：只在首次打开（无任何模型）时生效，放最后便于覆盖启动罩的居中布局 -->
    <link rel="stylesheet" href="/css/onboarding.css" />
```

- [ ] **Step 2: 改启动罩结构**

把第 14-28 行整块替换为：

```html
    <!-- 启动罩：后端冷启动期间盖住整个 UI（boot-gate.js 探到 /api/ping 通即撤）。
         写在静态 HTML 里而非 JS 生成，保证页面第一帧就是罩子，不会闪出一个点不动的界面。
         新用户（无任何模型）时不撤罩，由 onboarding.js 原地转成配置引导。 -->
    <div class="boot-overlay" id="bootOverlay">
      <!-- .ob-brand：LOGO / 标题 / 启动文案的共同父节点。
           引导态要把 LOGO 作为整体左移，必须有个承载 transform 的节点；
           启动文案放在内部而非做兄弟节点，是为了让它隐藏后 brand 高度自然收缩仍保持居中，
           省掉一个脆弱的硬编码垂直偏移。 -->
      <div class="ob-brand" id="obBrand">
        <svg class="boot-star" id="bootStar" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <g id="btri1">
            <polygon points="100,25 165,140 35,140" stroke="#d97757" stroke-width="1.5"/>
          </g>
          <g id="btri2">
            <polygon points="100,175 165,60 35,60" stroke="#e88f6f" stroke-width="1.5" fill="rgba(217,119,87,0.14)"/>
          </g>
        </svg>
        <div class="vibe-title" id="bootTitle">VIBE CODING</div>
        <!-- 引导态整块隐藏：此时「正在启动服务…」与「仍然进入」都已无意义 -->
        <div class="ob-status" id="bootStatus">
          <div class="boot-text" id="bootText">正在启动服务…</div>
          <button class="boot-skip" id="bootSkip" hidden>仍然进入</button>
        </div>
      </div>

      <!-- 引导面板：写静态 HTML 而非 JS 拼装 —— 与启动罩同源、第一帧就在 DOM 里，
           无二次挂载抖动，也便于直接改样式调试。
           厂商下拉的 option 由 onboarding.js 从 VENDOR_PRESETS 生成，不像设置页
           那样硬编码一份（那已经是第二份了，不再添第三份）。 -->
      <div class="ob-panel" id="obPanel" hidden>
        <div class="ob-head">
          <h2 class="ob-title">开始之前，先完成基础配置</h2>
          <p class="ob-sub">只有「添加模型」是必填。已有配置文件可以直接导入。</p>
        </div>

        <button class="ob-import" id="obImportBtn" type="button">⇪ 一键导入已有配置文件</button>
        <input type="file" id="obImportFile" accept="application/json,.json" hidden />

        <section class="ob-sec">
          <div class="ob-sec-head">
            <span class="ob-sec-no">①</span>
            <span class="ob-sec-label">添加模型</span>
            <span class="ob-req">* 必填</span>
          </div>
          <div class="ob-tabs" id="obModelTabs" role="tablist">
            <button class="ob-tab active" type="button" role="tab" aria-selected="true" data-tab="claude">Claude 账号</button>
            <button class="ob-tab" type="button" role="tab" aria-selected="false" data-tab="custom">自定义模型</button>
          </div>
          <div class="ob-pane" data-pane="claude">
            <label class="ob-field">
              <span class="ob-label">名称</span>
              <input id="obTokenLabel" placeholder="如 主力号（选填）" autocomplete="off" />
            </label>
            <label class="ob-field">
              <span class="ob-label">Token</span>
              <input id="obTokenValue" placeholder="sk-ant-oat01-…" autocomplete="off" />
            </label>
          </div>
          <div class="ob-pane" data-pane="custom" hidden>
            <label class="ob-field">
              <span class="ob-label">厂商</span>
              <select id="obCredVendor" class="ob-select"></select>
            </label>
            <label class="ob-field">
              <span class="ob-label">API Key</span>
              <input id="obCredApiKey" type="password" placeholder="sk-…" autocomplete="new-password" />
            </label>
            <label class="ob-field">
              <span class="ob-label">Base URL</span>
              <input id="obCredBaseURL" placeholder="https://api.xxx.com/v1" autocomplete="off" />
            </label>
            <label class="ob-field">
              <span class="ob-label">模型</span>
              <input id="obCredModel" list="obCredModelList" placeholder="先选厂商" autocomplete="off" />
              <datalist id="obCredModelList"></datalist>
            </label>
          </div>
        </section>

        <section class="ob-sec collapsed" id="obOpenIdSec">
          <button class="ob-sec-head ob-toggle" type="button">
            <span class="ob-sec-no">②</span>
            <span class="ob-sec-label">我的飞书 open_id</span>
            <span class="ob-opt">选填</span>
            <span class="ob-caret">▾</span>
          </button>
          <div class="ob-sec-body">
            <label class="ob-field">
              <span class="ob-label">open_id</span>
              <input id="obOpenId" placeholder="ou_…" autocomplete="off" maxlength="128" />
            </label>
            <p class="ob-hint">用于按「属于我的」筛选测试期 BUG。可稍后到设置页补。</p>
          </div>
        </section>

        <section class="ob-sec collapsed" id="obBotSec">
          <button class="ob-sec-head ob-toggle" type="button">
            <span class="ob-sec-no">③</span>
            <span class="ob-sec-label">飞书机器人</span>
            <span class="ob-opt">选填</span>
            <span class="ob-caret">▾</span>
          </button>
          <div class="ob-sec-body">
            <label class="ob-field">
              <span class="ob-label">名称</span>
              <input id="obBotName" placeholder="如 研发助手" autocomplete="off" />
            </label>
            <label class="ob-field">
              <span class="ob-label">App ID</span>
              <input id="obBotAppId" placeholder="cli_ 加 16 位十六进制" autocomplete="off" />
            </label>
            <label class="ob-field">
              <span class="ob-label">App Secret</span>
              <input id="obBotSecret" type="password" autocomplete="new-password" />
            </label>
            <p class="ob-hint">填了才会创建并启用机器人。可稍后到设置页补。</p>
          </div>
        </section>

        <div class="ob-foot">
          <span class="ob-err" id="obErr"></span>
          <button class="ob-submit" id="obSubmitBtn" type="button" disabled>完成，开始使用</button>
        </div>
      </div>
    </div>
```

- [ ] **Step 3: 验证既有节点 id 未丢**

Run: `rg -n "bootStar|btri1|btri2|bootText|bootSkip" public/index.html`
Expected: 5 个 id 都还在（`boot-gate.js` 依赖 `bootText` / `bootSkip`，`app.css` 依赖 `#bootStar #btri1` / `#btri2`）

Run: `rg -c "id=\"obPanel\"|id=\"obBrand\"|id=\"bootStatus\"" public/index.html`
Expected: 3

- [ ] **Step 4: 自查（不提交）**

此时 `onboarding.css` 还不存在，浏览器会 404 一条样式（不影响功能，下个任务补）。**不要 git commit。**

---

## Task 8: onboarding.css

**Files:**
- Create: `public/css/onboarding.css`

- [ ] **Step 1: 写样式**

创建 `public/css/onboarding.css`：

```css
/* 新用户引导态：启动罩原地转成「左 LOGO + 右配置面板」。
 * 只在 #bootOverlay 上加 .ob-arm / .ob-open 两个类时生效，
 * 不加类时这里的规则要让启动罩看起来与改造前完全一样。 */

:root {
  /* 引导态的水平位移。视觉盒推导：
   *   LOGO 96(=120×0.8) + gap 56 + 面板 420 = 572 → 左边缘 -286
   *   LOGO 中心 = -286 + 96/2  = -238
   *   面板中心 = -286 + 96 + 56 + 420/2 = 76
   * 改了 --ob-panel-w 就要按上面的公式重算这两个值。 */
  --ob-logo-x: -238px;
  --ob-panel-x: 76px;
  --ob-panel-w: 420px;
}

/* ---- 品牌区（LOGO / 标题 / 启动文案）---- */

/* 绝对定位 + translate(-50%,-50%) 而不是靠父级 flex 居中：
 * 位移动画必须走纯 transform（width/flex 那类属性不上合成层，会掉帧）。
 * 垂直方向永远是 -50%，所以启动文案隐藏后高度收缩了也还是居中。 */
.ob-brand {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px; /* 与改造前 .boot-overlay 的 gap 一致，保证非引导态零回归 */
  transition: transform 0.46s cubic-bezier(0.22, 1, 0.36, 1);
}
.ob-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

/* ---- 阶段一 .ob-arm：六芒星切成单次播放 ---- */

/* 罩子在后端冷启动期间已经转了不定圈数，等当前周期的 animationend 的话
 * 等待时间是 0~2.6s 随机，给不了确定的开场。这里换成单次 keyframe 并由 JS
 * 强制 reflow 重起播，拿到一个确定的 780ms 起点。 */
@keyframes vibeSpinOnce {
  from { transform: rotate(0deg); }
  to   { transform: rotate(120deg); }
}
@keyframes vibeSpinOnceRev {
  from { transform: rotate(0deg); }
  to   { transform: rotate(-120deg); }
}
.boot-overlay.ob-arm #bootStar #btri1,
.boot-overlay.ob-arm #bootStar #btri2 {
  animation: vibeSpinOnce 780ms cubic-bezier(0.7, 0, 0.25, 1) 1 both;
}
.boot-overlay.ob-arm #bootStar #btri2 {
  animation-name: vibeSpinOnceRev;
}

/* ---- 阶段二 .ob-open：LOGO 左移、标题淡出、启动文案撤场 ---- */

.boot-overlay.ob-open .ob-brand {
  transform: translate(calc(-50% + var(--ob-logo-x)), -50%) scale(0.8);
}
.boot-overlay.ob-open #bootTitle {
  opacity: 0;
  transform: translateY(-6px);
  transition: opacity 0.22s ease, transform 0.22s ease;
  pointer-events: none;
}
.boot-overlay.ob-open .ob-status {
  display: none;
}

/* ---- 引导面板 ---- */

.ob-panel {
  position: absolute;
  left: 50%;
  top: 50%;
  width: var(--ob-panel-w);
  max-height: 78vh;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 22px 24px 18px;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.09));
  border-radius: 14px;
  background: var(--panel, rgba(255, 255, 255, 0.03));
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  /* 进场初态：比目标位再往右 44px，配合 opacity 做「从 LOGO 右侧推出」的观感 */
  opacity: 0;
  transform: translate(calc(-50% + var(--ob-panel-x) + 44px), -50%);
  transition: opacity 0.38s ease, transform 0.38s cubic-bezier(0.22, 1, 0.36, 1);
}
.boot-overlay.ob-open .ob-panel:not([hidden]) {
  opacity: 1;
  transform: translate(calc(-50% + var(--ob-panel-x)), -50%);
}

.ob-head { margin-bottom: 14px; }
.ob-title {
  margin: 0 0 5px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text, #e8e6e3);
}
.ob-sub {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--faint, #8b8781);
}

.ob-import {
  width: 100%;
  margin-bottom: 16px;
  padding: 9px 12px;
  border: 1px dashed var(--accent, #d97757);
  border-radius: 8px;
  background: transparent;
  color: var(--accent, #d97757);
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.16s ease;
}
.ob-import:hover { background: rgba(217, 119, 87, 0.09); }

/* ---- 分段 ---- */

.ob-sec {
  padding-top: 14px;
  border-top: 1px solid var(--line, rgba(255, 255, 255, 0.08));
}
.ob-sec + .ob-sec { margin-top: 14px; }

.ob-sec-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-bottom: 10px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
}
.ob-toggle { cursor: pointer; }
.ob-sec-no { color: var(--accent, #d97757); font-size: 12.5px; }
.ob-sec-label { font-size: 13px; font-weight: 600; color: var(--text, #e8e6e3); }
.ob-req { margin-left: auto; font-size: 11px; color: var(--accent, #d97757); }
.ob-opt { margin-left: auto; font-size: 11px; color: var(--faint, #8b8781); }
.ob-caret {
  font-size: 11px;
  color: var(--faint, #8b8781);
  transition: transform 0.18s ease;
}
.ob-sec.collapsed .ob-caret { transform: rotate(-90deg); }
.ob-sec.collapsed .ob-sec-body { display: none; }
.ob-sec.collapsed .ob-sec-head { margin-bottom: 0; }

/* ---- Tab ---- */

.ob-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  padding: 3px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
}
.ob-tab {
  flex: 1;
  padding: 6px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted, #a8a39c);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
}
.ob-tab.active {
  background: rgba(217, 119, 87, 0.16);
  color: var(--accent, #d97757);
  font-weight: 600;
}

/* ---- 字段 ---- */

.ob-field {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 9px;
}
.ob-label {
  flex: 0 0 68px;
  font-size: 12px;
  color: var(--muted, #a8a39c);
}
.ob-field input,
.ob-field select {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
  border-radius: 7px;
  background: rgba(0, 0, 0, 0.18);
  color: var(--text, #e8e6e3);
  font-size: 12.5px;
  font-family: inherit;
}
.ob-field input:focus,
.ob-field select:focus {
  outline: none;
  border-color: var(--accent, #d97757);
}
.ob-field input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ob-hint {
  margin: 2px 0 0 78px;
  font-size: 11px;
  line-height: 1.55;
  color: var(--faint, #8b8781);
}

/* ---- 底栏 ---- */

.ob-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--line, rgba(255, 255, 255, 0.08));
}
.ob-err {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: #e5687a;
}
.ob-submit {
  flex: 0 0 auto;
  padding: 9px 18px;
  border: 0;
  border-radius: 8px;
  background: var(--accent, #d97757);
  color: #fff;
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: opacity 0.16s ease;
}
.ob-submit:hover:not(:disabled) { opacity: 0.88; }
.ob-submit:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ---- 降级：系统开启「减少动态效果」时全部一步到位 ---- */

@media (prefers-reduced-motion: reduce) {
  .ob-brand,
  .ob-panel,
  #bootTitle,
  .ob-caret,
  .ob-import,
  .ob-tab,
  .ob-submit {
    transition: none !important;
  }
  .boot-overlay.ob-arm #bootStar #btri1,
  .boot-overlay.ob-arm #bootStar #btri2 {
    animation: none !important;
  }
}
```

- [ ] **Step 2: 验证非引导态视觉零回归**

启动应用（此时应用还有模型配置，走老用户路径），确认启动罩与改造前一致：LOGO 居中、旋转动画照常、`VIBE CODING` 在 LOGO 下方、间距 16px。

Run: `npm start`
Expected: 打开 `http://localhost:<端口>`，启动罩外观与改动前无差异

- [ ] **Step 3: 自查（不提交）**

**不要 git commit。**

---

## Task 9: onboarding.js —— 判定、动画编排与表单交互

**Files:**
- Create: `public/js/onboarding.js`

- [ ] **Step 1: 写模块**

创建 `public/js/onboarding.js`：

```js
/** 新用户首次引导：接管启动罩 → LOGO 单次旋转后左移 → 右侧展开配置面板。
 *  判定与校验的纯逻辑在 onboarding.logic.js，本模块只做 DOM 编排、动画时序与请求。
 *  入口 maybeStartOnboarding 由 app.js 注册给 boot-gate 的撤罩 handoff。 */
import { isNewUser, validateOnboardForm } from './onboarding.logic.js';
import { VENDOR_PRESETS } from './vendor-presets.js';
import { importConfigFile } from './config-import.js';
import { toast } from './ui.js';

// 动画时序（ms）。SPIN_MS 与 onboarding.css 的 vibeSpinOnce 时长必须一致；
// 之后停 SETTLE_MS 让「转完停稳」有落定感，再开始左移。
const SPIN_MS = 780;
const SETTLE_MS = 320;
const PANEL_DELAY_MS = 180;
const PANEL_IN_MS = 380;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduceMotion = () =>
  !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const el = (id) => document.getElementById(id);

/** boot-gate 的撤罩接管者。返回 true 表示接管罩子（引导已启动，罩子不撤）。 */
export async function maybeStartOnboarding(overlay) {
  if (!overlay) return false;

  let settings;
  try {
    const r = await fetch('/api/settings', { cache: 'no-store' });
    if (!r.ok) return false;
    settings = await r.json();
  } catch {
    // 判定拿不到就不接管。漏一次引导可以接受（用户还能自己进设置页），
    // 把用户锁在一个空罩子里不行。这条同时覆盖了「点了仍然进入但后端其实没通」的场景。
    return false;
  }

  if (!isNewUser(settings)) return false;

  const panel = el('obPanel');
  if (!panel) {
    console.warn('[Onboarding] 缺少 #obPanel 骨架，放弃引导');
    return false; // HTML 未更新时宁可不引导，也不留一个撤不掉的空罩子
  }

  startOnboarding(overlay, panel); // 不 await：让 boot-gate 立刻拿到 true 去 return
  return true;
}

// ---- 引导启动与动画时序 ----

async function startOnboarding(overlay, panel) {
  fillVendorOptions();
  bindTabs();
  bindCollapse();
  bindVendorChange();
  bindImport();
  bindSubmit();
  bindLiveValidate();
  syncSubmitState();

  if (reduceMotion()) {
    overlay.classList.add('ob-arm', 'ob-open');
    panel.hidden = false;
    focusFirst();
    return;
  }

  overlay.classList.add('ob-arm');
  void overlay.offsetWidth; // 强制 reflow，让单次 keyframe 从头起播而不是接着上一轮

  // 时序用 setTimeout 链而不是监听 animationend：后台标签页会节流动画事件，
  // 动画被 CSS 覆盖或 reduced-motion 置 none 时根本不触发 —— 漏一次事件，
  // 引导就永久停在半路，用户对着一个不动的罩子干等。
  await sleep(SPIN_MS + SETTLE_MS);
  overlay.classList.add('ob-open');
  await sleep(PANEL_DELAY_MS);
  panel.hidden = false;
  await sleep(PANEL_IN_MS);
  focusFirst();
}

function focusFirst() {
  const pane = document.querySelector('.ob-pane:not([hidden])');
  pane?.querySelector('input')?.focus();
}

// ---- 表单填充与绑定 ----

/** 厂商下拉从 VENDOR_PRESETS 生成。设置页的 #credVendor 是硬编码 option（已经是第二份
 *  厂商清单），这里不再添第三份 —— 加厂商只需改 vendor-presets.js。 */
function fillVendorOptions() {
  const sel = el('obCredVendor');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- 选择厂商 --</option>';
  for (const [key, preset] of Object.entries(VENDOR_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = preset.label;
    sel.appendChild(opt);
  }
}

function bindTabs() {
  const tabs = el('obModelTabs');
  if (!tabs) return;
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.ob-tab');
    if (!btn) return;
    const tab = btn.dataset.tab;
    tabs.querySelectorAll('.ob-tab').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.ob-pane').forEach((p) => {
      p.hidden = p.dataset.pane !== tab;
    });
    syncSubmitState(); // 换 Tab 等于换校验分支，按钮可用性要跟着变
    focusFirst();
  });
}

function bindCollapse() {
  for (const id of ['obOpenIdSec', 'obBotSec']) {
    const sec = el(id);
    sec?.querySelector('.ob-toggle')?.addEventListener('click', () => {
      sec.classList.toggle('collapsed');
    });
  }
}

/** 选厂商时带入预设的 baseURL 与模型建议。
 *  模型框恒为自由输入：预设列表天然滞后于厂商上新，锁成只读下拉会逼用户
 *  改走「其他（自定义）」并重填 baseURL，白丢预设最有价值的那部分。 */
function bindVendorChange() {
  const sel = el('obCredVendor');
  const baseURL = el('obCredBaseURL');
  const model = el('obCredModel');
  const list = el('obCredModelList');
  if (!sel || !baseURL || !model || !list) return;

  sel.addEventListener('change', () => {
    const preset = VENDOR_PRESETS[sel.value];
    list.innerHTML = '';
    model.value = '';

    if (!sel.value || !preset) {
      model.placeholder = '先选厂商';
      baseURL.disabled = false;
      baseURL.value = '';
      syncSubmitState();
      return;
    }

    preset.models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      list.appendChild(opt);
    });

    if (sel.value === 'custom') {
      // 其他（自定义）：无预设可依，baseURL 与模型都由用户填
      model.placeholder = '模型名，如 my-model';
      baseURL.disabled = false;
      baseURL.placeholder = 'https://api.xxx.com/v1';
      baseURL.value = '';
    } else {
      model.placeholder = preset.models[0] || '模型名';
      model.value = preset.models[0] || '';
      baseURL.disabled = true;
      baseURL.value = preset.baseURL;
    }
    syncSubmitState();
  });
}

/** 逐键同步「完成」按钮可用性：模型段一填齐就解锁，用户不用先点一次才知道缺什么 */
function bindLiveValidate() {
  const ids = ['obTokenValue', 'obCredApiKey', 'obCredBaseURL', 'obCredModel'];
  for (const id of ids) el(id)?.addEventListener('input', syncSubmitState);
}

/** 「完成」只看模型段 —— 飞书两段是选填，它们的校验留到提交时报，
 *  否则用户展开了选填段填错一个字符，必填都填好了却点不动按钮 */
function syncSubmitState() {
  const btn = el('obSubmitBtn');
  if (!btn) return;
  const { errors } = validateOnboardForm(readForm());
  btn.disabled = !!errors.model;
  btn.title = errors.model || '';
}

function bindImport() {
  const btn = el('obImportBtn');
  const input = el('obImportFile');
  if (!btn || !input) return;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = ''; // 允许再次选同一文件
    if (!file) return;
    btn.disabled = true;
    // 不传 confirm：新用户本来是空配置，「将覆盖当前全部配置」那句危险确认在这里是误导
    const r = await importConfigFile(file);
    if (!r.ok) {
      btn.disabled = false;
      showErr('导入失败：' + r.error);
      return;
    }
    toast(
      r.actionConfigsImported
        ? '配置已导入（含托管配置），正在重新加载…'
        : '配置已导入。该文件为旧版，不含托管配置，需到设置页重新配置动作',
    );
    await sleep(r.actionConfigsImported ? 800 : 2400);
    location.reload();
  });
}

// ---- 读表单与提交 ----

const val = (id) => (el(id)?.value || '').trim();

function readForm() {
  const activeTab = document.querySelector('.ob-tab.active')?.dataset.tab || 'claude';
  return {
    modelTab: activeTab,
    claude: { label: val('obTokenLabel'), token: val('obTokenValue') },
    custom: {
      vendor: val('obCredVendor'),
      apiKey: val('obCredApiKey'),
      baseURL: val('obCredBaseURL'),
      model: val('obCredModel'),
    },
    openId: val('obOpenId'),
    bot: { name: val('obBotName'), appId: val('obBotAppId'), appSecret: val('obBotSecret') },
  };
}

function showErr(msg) {
  const box = el('obErr');
  if (box) box.textContent = msg || '';
}

/** POST 并归一化结果：成功返回 null，失败返回可直接展示的错误文案。
 *  后端有「200 + ok:false」的约定（前置条件不齐时），必须一起判。 */
async function post(url, body) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error || d.ok === false) return d.error || 'HTTP ' + r.status;
    return null;
  } catch (e) {
    return (e && e.message) || String(e);
  }
}

function bindSubmit() {
  el('obSubmitBtn')?.addEventListener('click', submit);
}

async function submit() {
  const state = readForm();
  const { ok, errors } = validateOnboardForm(state);
  if (!ok) {
    showErr(errors.model || errors.bot || errors.openId);
    // 报错在哪段就把那段展开，否则折叠着的错误提示指不到具体字段
    if (errors.bot) el('obBotSec')?.classList.remove('collapsed');
    else if (errors.openId) el('obOpenIdSec')?.classList.remove('collapsed');
    return;
  }

  const btn = el('obSubmitBtn');
  btn.disabled = true;
  btn.textContent = '正在保存…';
  showErr('');

  // ① 模型是硬门槛：存不进去就必须停在这里。放行等于把用户丢进一个必然报错的界面
  const modelErr = await saveModel(state);
  if (modelErr) {
    showErr('模型保存失败：' + modelErr);
    btn.disabled = false;
    btn.textContent = '完成，开始使用';
    return;
  }

  // ②③ 飞书两段是选填：失败只提示不阻塞，别拿一个可选配置把用户挡在门外
  const soft = [];
  if (state.openId) {
    const e = await post('/api/settings', { section: 'profile', myFeishuOpenId: state.openId });
    if (e) soft.push('open_id：' + e);
  }
  if (state.bot.appId) {
    // enabled:true 是必需的 —— 不带这个字段，用户填完机器人却不生效，等于白填
    const e = await post('/api/bots', {
      name: state.bot.name,
      platform: 'feishu',
      appId: state.bot.appId,
      appSecret: state.bot.appSecret,
      enabled: true,
    });
    if (e) soft.push('机器人：' + e);
  }

  if (soft.length) {
    toast('模型已保存。飞书配置未保存（' + soft.join('；') + '），可稍后到设置页补');
    await sleep(2600); // 留出读 toast 的时间再刷新
  }

  // reload 而不是就地初始化：app.js 的启动初始化早在罩子后面跑完了，
  // 它读的是引导前的空配置。重来一遍最省事，且此时已是老用户路径。
  location.reload();
}

async function saveModel(state) {
  if (state.modelTab === 'custom') {
    const c = state.custom;
    return await post('/api/credentials', {
      apiKey: c.apiKey,
      baseURL: c.baseURL,
      model: c.model,
      vendor: c.vendor,
    });
  }
  return await post('/api/settings', {
    section: 'tokens',
    action: 'add',
    label: state.claude.label,
    token: state.claude.token,
  });
}
```

- [ ] **Step 2: 验证语法**

Run: `node --check public/js/onboarding.js`
Expected: 无输出

- [ ] **Step 3: 自查（不提交）**

确认 `SPIN_MS = 780` 与 `onboarding.css` 里 `vibeSpinOnce 780ms` 一致（两处不同步会导致左移在旋转没结束时就开始）。

Run: `rg -n "780" public/js/onboarding.js public/css/onboarding.css`
Expected: 2 处，数值一致。**不要 git commit。**

---

## Task 10: app.js 注册 handoff

**Files:**
- Modify: `public/app.js:2`（import）、`:27` 之后（注册）

- [ ] **Step 1: 改 import**

`public/app.js` 第 2 行现为：

```js
import { whenBackendReady } from './js/boot-gate.js'; // 须在 bootstrap 之后：依赖其 fetch 补丁
```

改为：

```js
import { whenBackendReady, setOverlayHandoff } from './js/boot-gate.js'; // 须在 bootstrap 之后：依赖其 fetch 补丁
import { maybeStartOnboarding } from './js/onboarding.js';
```

- [ ] **Step 2: 注册 handoff**

在第 27 行 `bindConvNotify({ ... });` 之后插入：

```js
// 新用户引导：注册给 boot-gate 的撤罩钩子。必须在下方 whenBackendReady() 被调用前注册。
// 判定为老用户（已有任意模型）时 maybeStartOnboarding 返回 false，罩子照常撤，行为零变化。
setOverlayHandoff(maybeStartOnboarding);
```

- [ ] **Step 3: 验证注册早于调用**

Run: `rg -n "setOverlayHandoff|whenBackendReady\(\)" public/app.js`
Expected: `setOverlayHandoff(...)` 的行号**小于** `await whenBackendReady()` 的行号

Run: `node --check public/app.js`
Expected: 无输出

- [ ] **Step 4: 自查（不提交）**

**不要 git commit。**

---

## Task 11: 端到端手工验证

**Files:** 无改动，仅验证。

动画与 DOM 编排不写自动化测试（项目现无浏览器测试基建），改为手工逐项验证。

- [ ] **Step 1: 跑全量单测**

Run: `npm test`
Expected: 全部通过。新增的 `vendor-presets.test.js`（6）、`onboarding.logic.test.js`（19）、改造后的 `config-transfer.test.js`（13）都应出现在结果里，且**不应**再有 `settings-panel.vendor.test.js`。

- [ ] **Step 2: 备份真实配置**

后面几步要清空 `tokens`，先留个还原点：

```bash
cp settings.json "$TMPDIR/settings.json.bak" 2>/dev/null || cp settings.json ../settings.json.bak
cp action-configs.json ../action-configs.json.bak
```

- [ ] **Step 3: 老用户路径零回归（最重要的一项）**

保持 `settings.json` 原样（有 token），`npm start` 打开页面。

Expected：
- 启动罩外观与改动前一致（LOGO 居中、六芒星循环旋转、`VIBE CODING` 在下方、间距 16px）
- 后端就绪后罩子正常淡出并消失，进入对话界面
- 控制台**没有** `[Boot] 启动罩已移交接管者`
- 设置页「模型」tab 的厂商下拉、凭证列表的厂商列都正常（验证 Task 1 的抽出没破坏使用点）
- 设置页「托管配置」tab 的动作列表正常显示

- [ ] **Step 4: 新用户引导首次出现**

把 `settings.json` 的 `"tokens"` 改为 `[]`，重启后端并刷新页面。

Expected：
- 六芒星转一次（约 780ms）后停约 320ms
- LOGO 左移并缩小，`VIBE CODING` 与「正在启动服务…」一起消失
- 右侧面板从右侧推入淡入，焦点落在「名称」输入框
- 控制台出现 `[Boot] 启动罩已移交接管者`
- 面板无关闭按钮，「完成，开始使用」为 disabled 且 hover 提示「请填写 Token」

- [ ] **Step 5: Claude 账号路径**

只填 Token（如 `sk-ant-oat01-test`），点「完成，开始使用」。

Expected：页面 reload 后正常进入对话界面；设置页能看到该账号；再刷新不再出现引导。

- [ ] **Step 6: 自定义模型路径**

再把 `tokens` 改为 `[]` 重启。切到「自定义模型」Tab，选厂商 DeepSeek。

Expected：
- Base URL 自动填入 `https://api.deepseek.com/v1` 且变为 disabled
- 模型自动填入 `deepseek-chat`，下拉建议里有 `deepseek-reasoner`
- 选「其他（自定义）」时 Base URL 恢复可编辑并清空
- 填完 API Key 后「完成」解锁；提交后 reload，设置页凭证列表里厂商列显示「DeepSeek」

- [ ] **Step 7: 飞书选填项校验**

`tokens` 改 `[]` 重启。填好 Token，展开「飞书机器人」，App ID 填 `cli_123`（格式错），点完成。

Expected：底部红字提示「App ID 格式应为 cli_ 加 16 位十六进制」，机器人段保持展开，不 reload。

改填 `cli_0123456789abcdef` 但 Secret 留空 → 提示「请填写 App Secret」。

三个字段全清空 → 「完成」可点，提交后正常 reload（选填段未填不阻塞）。

- [ ] **Step 8: 后端不通时不卡死**

`tokens` 保持 `[]`，**不启动后端**，直接打开页面，等到「仍然进入」按钮出现后点它。

Expected：罩子正常撤掉，不卡在引导里（`maybeStartOnboarding` 的 `/api/settings` 请求失败 → 返回 false）。

- [ ] **Step 9: 减少动态效果降级**

系统开启「减少动态效果」（Windows：设置 → 辅助功能 → 视觉效果 → 动画效果 关闭），`tokens` 改 `[]` 重启刷新。

Expected：无动画，面板与左移后的 LOGO 直接到位，不干等 1.1 秒。

- [ ] **Step 10: 导出/导入含托管配置（v2）**

还原一份正常配置（有 token、有托管配置动作）。设置页点「导出配置」。

Run: `rg -o '"version": [0-9]+|"actionConfigs"' ~/Downloads/claude-agent-config-*.json`
Expected: `"version": 2` 与 `"actionConfigs"` 都在

清空 `action-configs.json` 为 `[]` 并重启，确认设置页「托管配置」为空；然后导入刚导出的文件。

Expected：确认弹窗文案含「托管配置」；导入后 toast 显示「导入成功（含托管配置）」；reload 后托管配置列表恢复。

- [ ] **Step 11: 旧版 v1 包兼容**

手工造一个 v1 包：

```bash
node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('settings.json','utf8'));fs.writeFileSync('/tmp/v1-pack.json',JSON.stringify({__type:'claude-agent-config',version:1,exportedAt:null,settings:s},null,2))"
```

设置页导入 `/tmp/v1-pack.json`。

Expected：
- 导入成功，toast 提示「该文件为旧版，不含托管配置，需到设置页重新配置动作」
- **现有托管配置未被清空**（这是关键：v1 包的 `actionConfigs` 为 null，导入侧应跳过写盘而不是写空数组）

- [ ] **Step 12: 还原配置**

```bash
cp ../settings.json.bak settings.json
cp ../action-configs.json.bak action-configs.json
```

- [ ] **Step 13: 汇报（不提交）**

把第 3~11 步的实际结果逐项报给用户，失败项附控制台/终端原文。**不要 git commit**，改动全部留在工作区。

---

## 自检记录

**Spec 覆盖核对**（逐节对到任务）：

| Spec 节 | 覆盖任务 |
|---|---|
| §3 D1/D2 判定与无 flag | Task 5（`isNewUser`）、Task 9（`maybeStartOnboarding`） |
| §3 D3 复用启动罩 | Task 6、Task 7 |
| §5.1 handoff 协议 | Task 6、Task 10 |
| §5.2 判定失败降级 | Task 9（catch 返回 false）、Task 11 Step 8 |
| §5.3 与启动初始化的关系 | Task 6（`return` 不阻塞 resolve）、Task 9（reload 注释） |
| §6.1 DOM 结构 | Task 7 |
| §6.2 布局数值 | Task 8（CSS 变量 + 推导注释） |
| §6.3 时序 | Task 8（keyframes）、Task 9（setTimeout 链） |
| §6.4 reduced-motion 降级 | Task 8（media query）、Task 9（分支）、Task 11 Step 9 |
| §7.1 模型两 Tab | Task 7（DOM）、Task 9（`saveModel`） |
| §7.2 open_id | Task 5（长度校验）、Task 9（`section:'profile'`） |
| §7.3 机器人 + `enabled:true` | Task 5（格式校验）、Task 9（POST body） |
| §7.4 失败语义 | Task 9（`submit` 的硬/软失败分流） |
| §7.5 完成按钮启用条件 | Task 9（`syncSubmitState`） |
| §7.6 一键导入 | Task 4、Task 9（`bindImport`） |
| §8.1 config-transfer v2 | Task 2 |
| §8.2 routes 接入 + 调用顺序 | Task 3 |
| §9.1/9.2 纯逻辑与单测 | Task 5 |
| §9.3 config-transfer 测试 | Task 2 |
| §9.5 手工验证清单 | Task 11 |

**对 spec 的三处偏离**（已在 spec 中同步修正）：

1. **§6.1 DOM 结构**：`.ob-status` 从「`.ob-brand` 的兄弟节点」改为「`.ob-brand` 的子节点」。原方案下 brand 绝对定位后 status 需要硬编码垂直偏移；改为子节点后垂直方向完全由 `translate(-50%,-50%)` 处理。
2. **§7.1 Claude Tab 字段**：去掉「订阅类型」下拉。`SUBSCRIPTION_TYPES` 全库无使用点（死代码），且后端 `tokens/add` 分支只取 `label` 与 `token`，`subscription` 传了也被丢弃——不该给用户一个唯一选项且存不下去的字段。
3. **§4 `vendor-presets.js` 职责**：只导出 `VENDOR_PRESETS` + `BASEURL_TO_VENDOR`，不含 `SUBSCRIPTION_TYPES`（同上）。

**额外发现并纳入计划的既有问题**：`settings-panel.vendor.test.js` 靠 `fs.readFileSync` + `indexOf` 源码切片跑测试，常量一抽出必炸。Task 1 Step 1/5 改造为直接 import 并删除旧文件。

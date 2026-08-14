# 机器人文案配置（设置页）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **注意：按用户全局规则，本计划不含任何 git 提交/分支操作。完成后由用户决定是否提交。**

**Goal:** 把飞书机器人 6 条门面文案（欢迎语等）收进 web 设置页统一配置，后端注册表可扩展、前端动态渲染。

**Architecture:** 文案注册表 `src/shared/messages.js`（key → 标签/默认值 + 纯回退/清洗逻辑）；`settings.json` 只存覆盖值（web 写、feishu 读，`readJson` 无缓存 → 保存后飞书下一条消息即生效，无热重载）；`POST /api/settings` 复用 `section` 分发加 `messages` 节；设置弹层新增分区按 API 动态渲染。

**Tech Stack:** Node.js ESM（无框架）、`node:test`、原生前端（`public/*` 无构建）。

**Spec:** `docs/superpowers/specs/2026-07-18-bot-messages-config-design.md`

**对 spec 的一处落地修正：** spec §3 写「`setMessages` 逐 key 校验存在于 `REGISTRY`」——直接实现会造成 `store/settings.js` ↔ `shared/messages.js` 循环导入。故校验挪到 `shared/messages.js` 的纯函数 `sanitizeMessages()`，由 API 层（server.js）先清洗再调 `setMessages`；store 保持哑存储。行为与 spec 等价。

---

### Task 1: store 层 `messages` 字段读写

**Files:**
- Modify: `src/store/settings.js`

**关键坑：** 现有 `getSettings()` 返回值只拼 `lark`/`tokens` 两个字段，而 `setLark`/`setTokens` 都是「`getSettings()` 改一字段后整体 `writeJson`」——若不把 `messages` 加进 `getSettings()` 返回值，保存飞书凭证/token 时会**静默丢掉**已配置的文案。

- [ ] **Step 1: 修改 `getSettings()` 与 `DEFAULTS`，透传 `messages` 字段**

`src/store/settings.js` 第 8 行 `DEFAULTS` 改为：

```js
const DEFAULTS = { lark: { appId: '', appSecret: '' }, tokens: [], messages: {} };
```

`getSettings()`（第 10-16 行）改为：

```js
export function getSettings() {
  const s = readJson(FILE, DEFAULTS);
  return {
    lark: { ...DEFAULTS.lark, ...(s.lark || {}) },
    tokens: Array.isArray(s.tokens) ? s.tokens : [],
    // 必须透传：setLark/setTokens 走「getSettings 改一字段整体回写」，漏了会丢文案
    messages: s.messages && typeof s.messages === 'object' && !Array.isArray(s.messages) ? s.messages : {},
  };
}
```

- [ ] **Step 2: 新增 `getMessages` / `setMessages`**

追加到 `src/store/settings.js` 文件末尾（`reorderTokens` 之后）：

```js
export function getMessages() {
  return getSettings().messages;
}

/** 整节覆盖；values 须已由 shared/messages.js 的 sanitizeMessages 清洗（只含注册表内非空值） */
export function setMessages(values) {
  const s = getSettings();
  s.messages = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  writeJson(FILE, s);
  return s.messages;
}
```

- [ ] **Step 3: 语法校验**

Run: `node --check src/store/settings.js`
Expected: 无输出（退出码 0）

### Task 2: 文案注册表与纯逻辑（TDD）

**Files:**
- Create: `src/shared/messages.js`
- Test: `src/shared/messages.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/shared/messages.test.js`（沿用 `token-rotation.test.js` 的 `node:test` 风格）：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY, MAX_LEN, resolveMessage, sanitizeMessages, listMessages } from './messages.js';

test('resolveMessage：有覆盖值用覆盖值', () => {
  assert.equal(resolveMessage('welcome', { welcome: '自定义欢迎' }), '自定义欢迎');
});

test('resolveMessage：无覆盖 / 空白覆盖 / 无 overrides 均回默认', () => {
  assert.equal(resolveMessage('welcome', {}), REGISTRY.welcome.defaultText);
  assert.equal(resolveMessage('welcome', { welcome: '   ' }), REGISTRY.welcome.defaultText);
  assert.equal(resolveMessage('welcome', undefined), REGISTRY.welcome.defaultText);
});

test('resolveMessage：未知 key 抛错（注册表与调用点不一致属开发错误）', () => {
  assert.throws(() => resolveMessage('nope', {}), /未知文案 key/);
});

test('sanitizeMessages：trim、剔除空值、过滤未知 key', () => {
  const r = sanitizeMessages({ welcome: '  hi  ', execNewChat: '   ', hacker: 'x' });
  assert.deepEqual(r, { ok: true, values: { welcome: 'hi' } });
});

test('sanitizeMessages：非对象入参报错', () => {
  assert.equal(sanitizeMessages(null).ok, false);
  assert.equal(sanitizeMessages([]).ok, false);
  assert.equal(sanitizeMessages('x').ok, false);
});

test('sanitizeMessages：单条超长报错并指明条目', () => {
  const r = sanitizeMessages({ welcome: 'x'.repeat(MAX_LEN + 1) });
  assert.equal(r.ok, false);
  assert.match(r.error, /欢迎语/);
});

test('listMessages：结构完整，key/label/defaultText/value 齐全', () => {
  const items = listMessages();
  assert.equal(items.length, Object.keys(REGISTRY).length);
  for (const it of items) {
    assert.ok(REGISTRY[it.key]);
    assert.equal(typeof it.label, 'string');
    assert.equal(typeof it.defaultText, 'string');
    assert.equal(typeof it.value, 'string');
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/shared/messages.test.js`
Expected: FAIL（`Cannot find module ... messages.js`）

- [ ] **Step 3: 实现 `src/shared/messages.js`**

```js
/**
 * 机器人文案注册表 —— 飞书侧用户可见「门面文案」唯一出口。
 * 覆盖值存 settings.json 的 messages 字段（web 写、feishu 读）；
 * readJson 无缓存 → 调用点必须在回复时调 msg()（勿存模块级常量），保存后下一条消息即生效。
 * 新增可配文案：这里加一个 key 即可，设置页按 GET /api/settings 动态渲染，前端零改动。
 */
import { getMessages } from '../store/settings.js';

export const MAX_LEN = 2000;

export const REGISTRY = {
  welcome: {
    label: '欢迎语（无匹配时兜底回复）',
    defaultText:
      '你好，我可以帮你：\n· 清理数据 —— 例如「帮我清一下 dev 环境数据」\n· 二维码功能（待配置）',
  },
  feedbackAck: {
    label: '需求/故障收集确认',
    defaultText: '问题/需求已收集，感谢反馈～ 后续我确认后会进行处理。',
  },
  execNewChat: { label: '新对话确认（owner）', defaultText: '🆕 已开始新对话' },
  execProcessing: { label: '处理中提示（owner）', defaultText: '🤔 处理中…' },
  cleanupAskPhone: {
    label: '清理流程·索要手机号',
    defaultText: '首次使用，请发送你的手机号（11 位），用于定位要清理的账号。',
  },
  cleanupAskEnv: { label: '清理流程·询问环境', defaultText: '要清理哪个环境的数据？回复 dev 或 test。' },
};

/** 纯逻辑：覆盖值（非空）优先；未知 key 抛错，开发期即暴露注册表与调用点不一致 */
export function resolveMessage(key, overrides) {
  const entry = REGISTRY[key];
  if (!entry) throw new Error(`未知文案 key：${key}`);
  const v = overrides?.[key];
  return typeof v === 'string' && v.trim() ? v : entry.defaultText;
}

/** 回复时调用（每次读盘）——保证设置保存后飞书侧下一条消息生效 */
export function msg(key) {
  return resolveMessage(key, getMessages());
}

/** 供 GET /api/settings：完整清单（默认值 + 当前覆盖值，无覆盖回 ''） */
export function listMessages() {
  const overrides = getMessages();
  return Object.entries(REGISTRY).map(([key, { label, defaultText }]) => ({
    key,
    label,
    defaultText,
    value: typeof overrides[key] === 'string' ? overrides[key] : '',
  }));
}

/** 纯逻辑：POST 入参清洗 —— 只收注册表内 key、trim、剔空；单条超长报错 */
export function sanitizeMessages(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, error: 'values 须为对象' };
  }
  const clean = {};
  for (const [key, entry] of Object.entries(REGISTRY)) {
    const v = values[key];
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!t) continue;
    if (t.length > MAX_LEN) return { ok: false, error: `「${entry.label}」超过 ${MAX_LEN} 字符` };
    clean[key] = t;
  }
  return { ok: true, values: clean };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/shared/messages.test.js`
Expected: 7 项全部 PASS

### Task 3: 替换 6 处调用点

**Files:**
- Modify: `src/app/dispatch.js:48-52`
- Modify: `src/features/feedback/index.js:27`
- Modify: `src/features/claude-exec/index.js:22,34`
- Modify: `src/features/data-cleanup/index.js:63,106`

所有调用点都在**回复时**调 `msg()`（不得提为模块级常量，否则失去即时生效）。

- [ ] **Step 1: `src/app/dispatch.js`**

顶部 import 区（第 8 行 logger import 后）加：

```js
import { msg } from '../shared/messages.js';
```

第 48-52 行的兜底回复：

```js
    // 3. 无匹配：帮助
    logger.info('dispatch', '无匹配 → 帮助');
    await ctx.reply(msg('welcome'));
```

- [ ] **Step 2: `src/features/feedback/index.js`**

顶部 import 区加：

```js
import { msg } from '../../shared/messages.js';
```

第 27 行（`[故障]/[需求]` 前缀仍由代码拼接）：

```js
    await ctx.reply(`${tag} ${msg('feedbackAck')}`);
```

- [ ] **Step 3: `src/features/claude-exec/index.js`**

顶部 import 区加：

```js
import { msg } from '../../shared/messages.js';
```

第 22 行：

```js
      return reply(msg('execNewChat'));
```

第 34 行（目录后缀仍由代码拼接）：

```js
    await reply(`${msg('execProcessing')}（完整能力${workDir ? ' @' + workDir : ''}）`);
```

- [ ] **Step 4: `src/features/data-cleanup/index.js`**

顶部 import 区加：

```js
import { msg } from '../../shared/messages.js';
```

第 63 行：

```js
    return reply(msg('cleanupAskPhone'));
```

第 106 行：

```js
      return reply(msg('cleanupAskEnv'));
```

- [ ] **Step 5: 语法校验 4 个文件**

Run:

```bash
node --check src/app/dispatch.js && node --check src/features/feedback/index.js && node --check src/features/claude-exec/index.js && node --check src/features/data-cleanup/index.js
```

Expected: 无输出（退出码 0）

### Task 4: web API（`GET`/`POST /api/settings` 加 `messages`）

**Files:**
- Modify: `src/entrypoints/web/server.js`（import 区 + `handleSettings` 函数，约 455-515 行）

- [ ] **Step 1: 扩展 import**

`src/entrypoints/web/server.js` 第 47-54 行的 store/settings import 加 `setMessages`：

```js
import {
  getLark,
  setLark,
  addToken,
  updateTokenMeta,
  removeToken,
  reorderTokens,
  setMessages,
} from '../../store/settings.js';
```

其后新增一行 import：

```js
import { listMessages, sanitizeMessages } from '../../shared/messages.js';
```

- [ ] **Step 2: `GET` 响应加 `messages`**

`handleSettings` 的 GET 分支（第 460-468 行）`sendJson` 对象加一字段：

```js
    return sendJson(res, 200, {
      lark: {
        appId: appId || '',
        appSecretMasked: appSecret ? '••••••••' + appSecret.slice(-4) : '',
      },
      feishu,
      tokens: status.tokens, // 已掩码
      active: status.active,
      messages: listMessages(),
    });
```

- [ ] **Step 3: `POST` 加 `messages` section**

`handleSettings` 的 POST 分支里，`if (data.section === 'tokens') {...}` 块结束之后、`return sendJson(res, 400, { error: '未知 section' });` 之前插入：

```js
      if (data.section === 'messages') {
        const r = sanitizeMessages(data.values);
        if (!r.ok) return sendJson(res, 400, { error: r.error });
        try {
          setMessages(r.values);
        } catch (e) {
          return sendJson(res, 500, { error: '保存失败：' + (e?.message || e) });
        }
        return sendJson(res, 200, { ok: true, messages: listMessages() });
      }
```

- [ ] **Step 4: 语法校验**

Run: `node --check src/entrypoints/web/server.js`
Expected: 无输出（退出码 0）

### Task 5: 设置页前端（分区 + 动态渲染 + 保存）

**Files:**
- Modify: `public/index.html`（设置弹层，约 137-166 行）
- Modify: `public/app.js`（settings 区，约 1592-1731 行）
- Modify: `public/app.css`（约 1277 行 `.set-actions` 附近）

- [ ] **Step 1: `index.html` 新增分区**

在「飞书凭证」`set-sec` 的闭合 `</div>`（第 151 行）与现有 `<div class="pop-divider"></div>`（第 153 行）之后、「Claude 账号」分区之前插入：

```html
          <div class="set-sec">
            <div class="set-sec-head">
              <span class="sec-label">机器人文案</span>
              <span class="msg-hint">留空用默认 · 保存后下一条消息生效</span>
            </div>
            <div class="msg-list" id="msgList"></div>
            <div class="set-actions">
              <button class="btn primary" id="msgSaveBtn">保存文案</button>
            </div>
          </div>

          <div class="pop-divider"></div>
```

（即：飞书凭证 → divider → 机器人文案 → divider → Claude 账号。）

- [ ] **Step 2: `app.js` 渲染与保存**

`loadSettings()` 末尾（第 1610 行 `renderTokenList(d.tokens || []);` 之后）加：

```js
        renderMessages(d.messages || []);
```

`renderTokenList` 函数之前（第 1613 行前）插入两个函数：

```js
      // 机器人文案：完全按 GET /api/settings 返回渲染，前端不写死任何 key/默认值
      function renderMessages(items) {
        const box = $('#msgList');
        box.innerHTML = '';
        items.forEach((m) => {
          const field = document.createElement('label');
          field.className = 'set-field msg-field';
          field.textContent = m.label;
          const ta = document.createElement('textarea');
          ta.dataset.key = m.key;
          ta.rows = Math.min(4, (m.defaultText.match(/\n/g) || []).length + 1);
          ta.placeholder = m.defaultText;
          ta.value = m.value || '';
          field.appendChild(ta);
          box.appendChild(field);
        });
      }

      async function saveMessages() {
        const values = {};
        $('#msgList').querySelectorAll('textarea').forEach((ta) => (values[ta.dataset.key] = ta.value));
        if (await postSettings({ section: 'messages', values })) {
          toast('文案已保存，下一条消息生效');
          await loadSettings();
        }
      }
```

事件绑定区（第 1731 行 `$('#tokenAddBtn')...` 之后）加：

```js
      $('#msgSaveBtn').addEventListener('click', saveMessages);
```

- [ ] **Step 3: `app.css` 样式**

第 1277 行 `.set-actions { ... }` 规则之后插入（textarea 样式对齐现有 `.set-field input`）：

```css
      .msg-hint { font-size: 11px; color: var(--faint); }
      .msg-list { display: flex; flex-direction: column; }
      .msg-field textarea {
        display: block; width: 100%; margin-top: 4px; box-sizing: border-box;
        padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
        background: var(--bg); color: var(--text); font-size: 13px;
        font-family: inherit; resize: vertical; min-height: 34px;
      }
```

- [ ] **Step 4: 语法校验**

Run: `node --check public/app.js`
Expected: 无输出（退出码 0）

### Task 6: 回归与手动验证

- [ ] **Step 1: 全量单测回归**

Run: `node --test src/**/*.test.js`
Expected: 既有 `history.test.js`、`token-rotation.test.js` 与新增 `messages.test.js` 全部 PASS

- [ ] **Step 2: 重启服务（需用户确认或由用户执行）**

Run: `pm2 restart claude-web claude-feishu`
（重启用户正在运行的服务属状态变更，执行前确认。）

- [ ] **Step 3: API 手动验证**

```bash
curl -s http://127.0.0.1:3000/api/settings | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).messages))"
```

Expected: 6 条 `{key,label,defaultText,value:''}`

```bash
curl -s -X POST http://127.0.0.1:3000/api/settings -H "Content-Type: application/json" -d "{\"section\":\"messages\",\"values\":{\"welcome\":\"测试欢迎语\"}}"
```

Expected: `{"ok":true,"messages":[...]}`，且 `settings.json` 出现 `"messages":{"welcome":"测试欢迎语"}`

- [ ] **Step 4: 浏览器 + 飞书端到端（手动清单，交用户确认）**

1. 打开 `http://127.0.0.1:3000` → ⚙ 设置 → 出现「机器人文案」分区，6 条 textarea，placeholder 为默认文案；
2. 修改「欢迎语」保存 → 给飞书机器人（guest 身份）发一条无匹配消息 → 收到新欢迎语；
3. 清空「欢迎语」保存 → 再发 → 回默认文案；
4. 改飞书凭证/token 排序后再查 `settings.json` → `messages` 字段仍在（Task 1 防丢回归点）。

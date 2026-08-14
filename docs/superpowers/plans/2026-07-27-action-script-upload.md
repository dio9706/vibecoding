# 动作脚本上传 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把动作配置的脚本从"手填文件名"改为"上传 .py/.js 文件"，脚本存到基于数据目录的统一脚本目录，桌面版与 PM2 都能命中。

**Architecture:** 新增 `POST /api/scripts/upload` 接口把脚本写入 `config.scripts.dir`；`config.scripts.dir` 改为基于 `APP_DATA_DIR` 的绝对路径（dev 兜底仓库根）；`script-runner` 与 `GET /api/scripts` 随之用绝对目录；动作表单用上传控件取代手填框，脚本类型按扩展名自动判定。

**Tech Stack:** Node.js (ESM, `node:test`)、原生 http handler、原生前端 JS（public/）。

**测试约定：** 框架 `node:test` + `node:assert/strict`；全量 `npm test`；单文件 `node --test src/<path>.test.js`。测试文件与源码同目录、以 `.test.js` 结尾。

**部署说明（重要）：** 本计划的改动落在仓库 `src/` 与 `public/`，PM2 的 web(`localhost:3000`)重启后即生效。**桌面版(Tauri)UI 与后端是打包快照**，需要**一次性重打包+重装**（`npm run tauri:build:win` 后重装）才能在桌面版里出现"上传"功能；此后新增/更新脚本就只走上传、无需再打包。`prepare-sidecar.mjs` 已包含 `src/`、`public/`，无需改动。

---

### Task 1: `config.scripts.dir` 改为基于数据目录的绝对路径

**Files:**
- Modify: `src/shared/config.js`
- Test: `src/shared/config.test.js`（新建）

- [ ] **Step 1: 写失败测试** — 新建 `src/shared/config.test.js`

```js
/** config.scriptsDirFor 解析规则单测 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// 隔离：import config.js 会连带初始化 store 数据目录，先把 APP_DATA_DIR 指向临时目录
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-test-'));
const { scriptsDirFor } = await import('./config.js');

test('scriptsDirFor: SCRIPTS_DIR 覆盖优先，原样返回', () => {
  assert.equal(scriptsDirFor({ SCRIPTS_DIR: 'D:\\custom\\scripts' }), 'D:\\custom\\scripts');
});

test('scriptsDirFor: APP_DATA_DIR → <APP_DATA_DIR>/scripts', () => {
  assert.equal(scriptsDirFor({ APP_DATA_DIR: 'D:\\data' }), path.join('D:\\data', 'scripts'));
});

test('scriptsDirFor: 无 env → 仓库根/scripts（绝对、以 scripts 结尾）', () => {
  const d = scriptsDirFor({});
  assert.ok(path.isAbsolute(d));
  assert.equal(path.basename(d), 'scripts');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/shared/config.test.js`
Expected: FAIL —「export named 'scriptsDirFor' not found」或断言失败。

- [ ] **Step 3: 实现** — 修改 `src/shared/config.js`

把文件顶部：

```js
import { getLark } from '../store/settings.js';
```

改为：

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLark } from '../store/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..'); // src/shared → 仓库根

/**
 * 脚本目录（绝对路径）：SCRIPTS_DIR 覆盖 > APP_DATA_DIR/scripts > 仓库根/scripts（dev 兜底）。
 * 纯函数，接收 env 便于测试；不依赖进程 cwd（打包后 cwd=AppData 会找不到脚本）。
 */
export function scriptsDirFor(env = process.env) {
  if (env.SCRIPTS_DIR) return env.SCRIPTS_DIR;
  if (env.APP_DATA_DIR) return path.join(env.APP_DATA_DIR, 'scripts');
  return path.join(REPO_ROOT, 'scripts');
}
```

再把 `scripts` 节：

```js
  scripts: {
    dir: process.env.SCRIPTS_DIR || 'scripts',
    pythonBin: process.env.PYTHON_BIN || 'python',
  },
```

改为：

```js
  scripts: {
    dir: scriptsDirFor(),
    pythonBin: process.env.PYTHON_BIN || 'python',
  },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/shared/config.test.js`
Expected: PASS（3 项）。

- [ ] **Step 5: 提交**

```bash
git add src/shared/config.js src/shared/config.test.js
git commit -m "feat(config): scripts.dir 改为基于数据目录的绝对路径解析"
```

---

### Task 2: `GET /api/scripts` 用绝对脚本目录（抽出 listScriptFiles）

**Files:**
- Modify: `src/entrypoints/web/routes-ops.js`
- Test: `src/entrypoints/web/routes-ops.test.js`（新建）

- [ ] **Step 1: 写失败测试** — 新建 `src/entrypoints/web/routes-ops.test.js`

```js
/** listScriptFiles 单测：只列 .py/.js，目录不存在返回 [] */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-'));
const { listScriptFiles } = await import('./routes-ops.js');

test('listScriptFiles 只返回 .py/.js', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-'));
  fs.writeFileSync(path.join(dir, 'a.py'), '');
  fs.writeFileSync(path.join(dir, 'b.js'), '');
  fs.writeFileSync(path.join(dir, 'c.txt'), '');
  assert.deepEqual(listScriptFiles(dir).sort(), ['a.py', 'b.js']);
});

test('listScriptFiles 目录不存在 → []', () => {
  assert.deepEqual(listScriptFiles(path.join(os.tmpdir(), 'no-such-dir-xyz')), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/routes-ops.test.js`
Expected: FAIL —「export named 'listScriptFiles' not found」。

- [ ] **Step 3: 实现** — 修改 `src/entrypoints/web/routes-ops.js`

在文件顶部导入区加一行（`import { execFile } ...` 下方即可）：

```js
import fs from 'node:fs';
```

把现有 `handleScripts`：

```js
/** GET /api/scripts — 列出 scripts 目录下的脚本文件 */
export async function handleScripts(res) {
  try {
    const { readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(process.cwd(), config.scripts.dir);
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && /\.(py|js)$/.test(f.name))
      .map((f) => f.name);
    sendJson(res, 200, files);
  } catch (e) {
    sendJson(res, 200, []); // 目录不存在或无文件，返回空数组
  }
}
```

替换为：

```js
/** 纯函数：列出目录下的 .py/.js 文件名；目录不存在或异常返回 [] */
export function listScriptFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && /\.(py|js)$/.test(f.name))
      .map((f) => f.name);
  } catch {
    return [];
  }
}

/** GET /api/scripts — 列出脚本目录（绝对，见 config.scripts.dir）下的脚本文件 */
export function handleScripts(res) {
  sendJson(res, 200, listScriptFiles(config.scripts.dir));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/routes-ops.test.js`
Expected: PASS（2 项）。

- [ ] **Step 5: 提交**

```bash
git add src/entrypoints/web/routes-ops.js src/entrypoints/web/routes-ops.test.js
git commit -m "refactor(scripts): handleScripts 用绝对脚本目录并抽出 listScriptFiles"
```

---

### Task 3: 脚本名校验（validateScriptName）

**Files:**
- Modify: `src/entrypoints/web/routes-files.js`
- Test: `src/entrypoints/web/routes-files.test.js`（新建）

- [ ] **Step 1: 写失败测试** — 新建 `src/entrypoints/web/routes-files.test.js`

```js
/** validateScriptName 单测：扩展名白名单、防穿越、文件名清洗、类型判定 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'files-test-'));
const { validateScriptName } = await import('./routes-files.js');

test('.py → ok，scriptType=python', () => {
  assert.deepEqual(validateScriptName('get_qrcode.py'), {
    ok: true, scriptName: 'get_qrcode.py', scriptType: 'python',
  });
});

test('.js → ok，scriptType=node', () => {
  assert.deepEqual(validateScriptName('notify.js'), {
    ok: true, scriptName: 'notify.js', scriptType: 'node',
  });
});

test('非法扩展名 → 拒绝', () => {
  assert.equal(validateScriptName('evil.txt').ok, false);
});

test('路径穿越被 basename 拦截，只留文件名', () => {
  const r = validateScriptName('../../etc/evil.py');
  assert.equal(r.ok, true);
  assert.equal(r.scriptName, 'evil.py');
});

test('空格/特殊字符清洗为下划线', () => {
  assert.equal(validateScriptName('my script!.py').scriptName, 'my_script_.py');
});

test('中文文件名保留', () => {
  assert.equal(validateScriptName('二维码.py').scriptName, '二维码.py');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/routes-files.test.js`
Expected: FAIL —「export named 'validateScriptName' not found」。

- [ ] **Step 3: 实现** — 修改 `src/entrypoints/web/routes-files.js`

在导入区加：

```js
import { config } from '../../shared/config.js';
```

在 `handleUpload` 函数**上方**新增（校验用常量 + 纯函数）：

```js
const SCRIPT_EXTS = { '.py': 'python', '.js': 'node' };
const SCRIPT_MAX = 1 * 1024 * 1024; // 脚本 1MB 上限

/**
 * 纯函数：校验/清洗上传脚本名。basename 防穿越 + 字符清洗；扩展名须 ∈ {.py,.js}。
 * @returns {{ok:true,scriptName:string,scriptType:string}|{ok:false,error:string}}
 */
export function validateScriptName(rawName) {
  const base = path.basename(String(rawName || '')).trim();
  const cleaned = base.replace(/[^\w.\-一-龥]/g, '_');
  const ext = path.extname(cleaned).toLowerCase();
  const scriptType = SCRIPT_EXTS[ext];
  if (!scriptType) return { ok: false, error: '仅支持 .py / .js 脚本' };
  return { ok: true, scriptName: cleaned, scriptType };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/routes-files.test.js`
Expected: PASS（6 项）。

- [ ] **Step 5: 提交**

```bash
git add src/entrypoints/web/routes-files.js src/entrypoints/web/routes-files.test.js
git commit -m "feat(scripts): 新增 validateScriptName 脚本名校验/清洗"
```

---

### Task 4: 上传接口 handleScriptUpload + 路由

**Files:**
- Modify: `src/entrypoints/web/routes-files.js`
- Modify: `src/entrypoints/web/server.js`
- （无独立单测：流式 handler，靠 Task 3 的纯函数覆盖 + Task 6 手测）

- [ ] **Step 1: 实现 handler** — 在 `src/entrypoints/web/routes-files.js` 的 `handleUpload` 函数**下方**新增：

```js
/**
 * POST /api/scripts/upload?name=<原文件名> —— 上传动作脚本到 config.scripts.dir（同名覆盖）。
 * 请求体为文件二进制；校验扩展名(.py/.js)与大小(≤1MB)；返回 { scriptName, scriptType }。
 */
export function handleScriptUpload(req, res, url) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  const v = validateScriptName(url.searchParams.get('name') || '');
  if (!v.ok) return sendJson(res, 400, { error: v.error });

  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > SCRIPT_MAX && !aborted) {
      aborted = true;
      sendJson(res, 413, { error: '脚本过大（>1MB）' });
      req.destroy();
      return;
    }
    if (!aborted) chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      const dir = config.scripts.dir;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, v.scriptName), Buffer.concat(chunks));
      sendJson(res, 200, { scriptName: v.scriptName, scriptType: v.scriptType });
    } catch (e) {
      sendJson(res, 500, { error: '保存失败：' + (e?.message || e) });
    }
  });
}
```

- [ ] **Step 2: 挂路由** — 修改 `src/entrypoints/web/server.js`

在 `routes-files.js` 的具名导入块（含 `handleUpload,`）中加一行：

```js
  handleScriptUpload,
```

在路由 `if (url.pathname === '/api/scripts') return handleScripts(res);` 这一行**上方**新增：

```js
  if (url.pathname === '/api/scripts/upload') return handleScriptUpload(req, res, url);
```

- [ ] **Step 3: 语法自检 + 全量测试**

Run: `node --check src/entrypoints/web/routes-files.js && node --check src/entrypoints/web/server.js && npm test`
Expected: `node --check` 无输出；`npm test` 全绿（含新加 3 个测试文件）。

- [ ] **Step 4: 手动冒烟（PM2 web）**

Run:
```bash
pm2 restart claude-web --update-env
printf 'print("hi")\n' > /tmp/probe.py
curl -s -X POST "http://127.0.0.1:3000/api/scripts/upload?name=probe.py" --data-binary @/tmp/probe.py
curl -s "http://127.0.0.1:3000/api/scripts"
```
Expected: 上传返回 `{"scriptName":"probe.py","scriptType":"python"}`；`/api/scripts` 列表含 `probe.py`；且 `%APPDATA%\com.claudeagent.desktop\scripts\probe.py` 存在。之后可删除 probe.py。

- [ ] **Step 5: 提交**

```bash
git add src/entrypoints/web/routes-files.js src/entrypoints/web/server.js
git commit -m "feat(scripts): 新增 POST /api/scripts/upload 上传接口与路由"
```

---

### Task 5: 动作表单改为上传控件（前端）

**Files:**
- Modify: `public/js/actions-panel.js`
- （无单测：前端无 DOM 测试框架，靠 Task 6 手测）

- [ ] **Step 1: 替换表单里的脚本类型/文件名两块** — 在 `showActionForm` 的 `form.innerHTML` 里，删除这两段：

```js
          <label>
            脚本类型：
            <select id="scriptType">
              <option value="python" ${action?.scriptType === 'python' ? 'selected' : ''}>Python</option>
              <option value="node" ${action?.scriptType === 'node' ? 'selected' : ''}>Node.js</option>
            </select>
          </label>
          <label>
            脚本文件名：<input type="text" id="scriptName" value="${escapeHtml(action?.scriptName || '')}" required />
          </label>
```

替换为：

```js
          <label>脚本文件（.py / .js）：</label>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <button type="button" id="uploadScriptBtn" class="btn">上传脚本</button>
            <input type="file" id="scriptFileInput" accept=".py,.js" style="display:none;" />
            <span id="currentScriptLabel" style="font-size:13px;color:var(--faint);"></span>
          </div>
```

- [ ] **Step 2: 表单状态 + 上传逻辑** — 在 `showActionForm` 里，`renderVariablesTable(action?.variables || []);` 这一行**下方**新增：

```js
        // 脚本以上传方式提供：用闭包变量承载，保存时读取（编辑时默认沿用原值）
        let currentScriptName = action?.scriptName || '';
        let currentScriptType = action?.scriptType || '';
        const scriptLabel = $('#currentScriptLabel');
        const paintScript = () => {
          scriptLabel.textContent = currentScriptName
            ? `当前脚本：${currentScriptName}（${currentScriptType || '?'}）`
            : '未选择脚本';
        };
        paintScript();

        const fileInput = $('#scriptFileInput');
        $('#uploadScriptBtn').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files[0];
          if (!file) return;
          try {
            const res = await fetch('/api/scripts/upload?name=' + encodeURIComponent(file.name), {
              method: 'POST',
              body: file,
            });
            const data = await res.json();
            if (res.ok) {
              currentScriptName = data.scriptName;
              currentScriptType = data.scriptType;
              paintScript();
              toast('脚本已上传：' + data.scriptName);
            } else {
              toast(data.error || '上传失败');
            }
          } catch (e) {
            toast('上传失败: ' + e.message);
          } finally {
            fileInput.value = '';
          }
        });
```

- [ ] **Step 3: 提交时读取闭包状态** — 把 `form.onsubmit`：

```js
        form.onsubmit = (e) => {
          e.preventDefault();
          saveAction(actionId, form);
        };
```

改为：

```js
        form.onsubmit = (e) => {
          e.preventDefault();
          saveAction(actionId, { scriptName: currentScriptName, scriptType: currentScriptType });
        };
```

- [ ] **Step 4: 改 saveAction 签名与 payload** — 把 `saveAction` 函数签名与其中的 `payload`：

```js
      async function saveAction(actionId, form) {
```
改为：
```js
      async function saveAction(actionId, scriptInfo) {
```

并把 payload 里：

```js
          scriptType: $('#scriptType').value,
          scriptName: $('#scriptName').value,
```
改为：
```js
          scriptType: scriptInfo.scriptType,
          scriptName: scriptInfo.scriptName,
```

在 `saveAction` 组装 `payload` **之前**加保护（缺脚本不提交）：

```js
        if (!scriptInfo.scriptName) {
          toast('请先上传脚本文件');
          return;
        }
```

> 注：`saveAction` 内不再引用 `form` 参数（其余字段仍用 `$('#actionName')` 等按 id 取值，不受影响）。

- [ ] **Step 5: 语法自检**

Run: `node --check public/js/actions-panel.js`
Expected: 无输出（通过）。

- [ ] **Step 6: 提交**

```bash
git add public/js/actions-panel.js
git commit -m "feat(ui): 动作表单脚本改为上传控件，类型按扩展名自动判定"
```

---

### Task 6: 端到端手动验证

**Files:** 无（验证）

- [ ] **Step 1: 重启 PM2 web 并打开设置页**

Run: `pm2 restart claude-web --update-env`
浏览器打开 `http://127.0.0.1:3000` → 设置 ⚙ → 动作配置 tab。

- [ ] **Step 2: 新建动作并上传脚本**

新建动作 → 填名称/意图/关键词 `二维码` → 点「上传脚本」选 `scripts/get_qrcode.py` → "当前脚本"显示 `get_qrcode.py（python）` → 加变量 `env` → 保存。
Expected: 列表出现该动作，脚本名 `get_qrcode.py`；`%APPDATA%\com.claudeagent.desktop\scripts\get_qrcode.py` 存在。

- [ ] **Step 3: 触发验证**

飞书发「正式版二维码」（PM2 claude-feishu 为唯一飞书连接时）。
Expected: 命中动作 → 跑 `AppData/scripts/get_qrcode.py --env prod` → 正常回复（PM2 侧带发图；桌面版重装前为文本链接）。

- [ ] **Step 4: 覆盖上传验证**

在表单里对同一动作重新上传改过的同名脚本 → 保存 → 再触发。
Expected: 执行到的是新版脚本（覆盖生效）。

- [ ] **Step 5: 全量测试收尾**

Run: `npm test`
Expected: 全绿。

---

## 自查（spec 覆盖对照）

- 上传接口（扩展名/大小/穿越/覆盖/返回值）→ Task 3（校验纯函数）+ Task 4（handler/路由/大小限制）✓
- scripts.dir 统一为绝对路径（APP_DATA_DIR/dev 兜底/SCRIPTS_DIR 覆盖）→ Task 1 ✓
- script-runner 定位不依赖 cwd → 由 Task 1 的 config 变更自动满足（`path.join(绝对, 名)`），无需改 script-runner 代码 ✓
- `GET /api/scripts` 用绝对目录 → Task 2 ✓
- UI 改上传控件、类型自动判定、编辑沿用原值、缺脚本拦截 → Task 5 ✓
- 向后兼容（老 scriptName 引用、默认清理动作）→ 不改 initializeDefaults；现有脚本已在 AppData/scripts ✓
- 测试（上传校验 / config 解析 / handleScripts）→ Task 1/2/3 单测 + Task 6 手测 ✓

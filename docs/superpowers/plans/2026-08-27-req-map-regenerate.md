# 需求地图「重新生成」实现计划

> **对于代理工作者：** 推荐使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 逐任务执行本计划。各步骤使用复选框（`- [ ]`）语法追踪进度。

**设计文档:** `docs/superpowers/specs/2026-08-27-req-map-regenerate-design.md`

**目标:** 为需求地图新增第四条产出链路 `mapregen` —— 以**当前代码实现**为准全量重扫，解决「开发途中改了逻辑，地图与实现对不上」的问题。

**架构:** 复用现有系统任务队列（`enqueueSystemTask` → 泵 → `dispatch`）与只读 Claude 外壳（`runReadonlyClaude`），落盘复用 `persistMap`。与另外三条链路的**唯一结构性差异**是 `resume: null`（全新 session）—— `docSession` 装的是评审期的代码理解，正是本次要推翻的对象。前端入口加在 `mountMap` 工具栏，评审期内嵌页签与开发期浮层两处自动都有。

**技术栈:** Node.js（ESM）、node:test、Vanilla JavaScript、CSS

---

## 文件结构

### 修改文件

| 文件 | 职责 | 改动范围 |
|------|------|--------|
| `src/entrypoints/web/req-map.logic.js` | `buildMapRegenPrompt` 纯函数 | ~60 行新增 |
| `src/entrypoints/web/req-map.logic.test.js` | prompt 单测 | ~50 行新增 |
| `src/entrypoints/web/requirement-ops.js` | `collectChangedFiles` / `runMapRegen` / dispatch 分支 | ~65 行新增 |
| `src/entrypoints/web/requirement-ops.test.js` | 收集与守卫单测 | ~60 行新增 |
| `src/entrypoints/web/routes-req-v2.js` | `POST /api/req/map/regen` | ~28 行新增 |
| `public/js/req-map.js` | 工具栏按钮 + `busy`/`onRegen` 入参 | ~35 行新增 |
| `public/css/req-v2.css` | `.rq-regen` 样式 | ~8 行新增 |
| `public/js/req-view.js` | 评审期接线 + busy 文案 | ~10 行修改 |
| `public/js/req-map-overlay.js` | 透传 `busy`/`onRegen` | ~5 行修改 |
| `public/js/req-chat.js` | 开发期接线 + `BUSY_KIND_LABELS` 补全 | ~8 行修改 |

**测试命令:** `npm test`（`node --test "src/**/*.test.js" "public/**/*.test.js"`）

---

## 任务分解

### Task 1: `buildMapRegenPrompt` 纯函数

**文件:** 修改 `src/entrypoints/web/req-map.logic.js`

- [ ] **Step 1: 在文件顶部常量区（`PAGE_STATES` 之后，第 19 行附近）追加上限常量**

```javascript
// 重新生成 prompt 的各段上限：改动文件清单在大需求上能到几百条，不设限会把 prompt 撑爆
const REGEN_MAX_FILES = 200;
const REGEN_MAX_CHANGES = 20;
const REGEN_CHANGE_CHARS = 300;
const REGEN_MAX_PAGES = 100;
```

- [ ] **Step 2: 在 `buildMapChangePrompt`（第 269-278 行）之后追加截断助手与主函数**

```javascript
/**
 * 列表截断成「前 N 项 + 剩余提示」。三处上限共用。
 * 超出时必须明确告诉模型「还有多少没列」——否则它会把截断后的清单当成全集，
 * 得出「这个需求只动了 200 个文件」这类错误结论。
 */
function clipList(items, max, unit) {
  const list = items.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, max);
  const rest = items.length - list.length;
  return rest > 0 ? [...list, `…另有 ${rest} ${unit}未列出`] : list;
}

/** 列表段落：每项前加「- 」，空列表返回空串（调用方据此决定要不要出这一段）。 */
function bulletBlock(items) {
  return items.map((x) => `- ${x}`).join('\n');
}

/**
 * 「重新生成」prompt：以**当前代码实现**为准全量重扫。
 *
 * 与 mapgen/mapfix/mapchange 的根本区别是它不做增量改写，也不 resume docSession
 *（见 spec 决策 1）——那个 session 装的是评审期的代码理解，正是本次要推翻的对象。
 *
 * @param {string} opts.docPath - 最新开发文档路径（必填，让模型现读）
 * @param {string[]} [opts.prevPageNames] - 上一版页面名清单。**只给名字不给 points**：
 *   设计稿回迁（normalizeMap）与变更高亮（markFreshPoints）都以页面名为键，名字漂了两者皆失效；
 *   而一旦给了 points，模型就会照抄旧结论，退化成 mapfix。
 * @param {string[]} [opts.changes] - 开发期「需求变动」正文（说明意图）
 * @param {string[]} [opts.changedFiles] - git 实际改动文件清单（说明结果）
 */
export function buildMapRegenPrompt({ docPath = '', prevPageNames = [], changes = [], changedFiles = [] } = {}) {
  const parts = [
    `开发已经进行了一段时间，代码可能与最初生成的需求地图不一致——开发途中的逻辑调整通常不会回写文档。\n` +
      `请**以当前代码的实际实现为准**，重新查证一遍，输出一份新的「需求地图」。`,
  ];

  if (docPath) {
    parts.push(
      `请先完整 Read 开发文档 ${docPath}。\n` +
        `注意：它代表的是**当初的需求意图**，不是事实来源。与代码冲突时一律以代码为准，` +
        `并在对应逻辑点的 after 里写清「实际实现与当初计划有何不同」。`,
    );
  }

  const changeLines = bulletBlock(
    clipList(changes.map((t) => String(t ?? '').trim().slice(0, REGEN_CHANGE_CHARS)), REGEN_MAX_CHANGES, '条'),
  );
  if (changeLines) {
    parts.push(
      `开发期间用户提过下列需求变动：\n${changeLines}\n\n` +
        `这些只说明**意图**——可能已完整实现、可能只实现了一部分、也可能被后续讨论推翻。请逐条到代码里查证实际状态。`,
    );
  }

  const fileLines = bulletBlock(clipList(changedFiles, REGEN_MAX_FILES, '个文件'));
  if (fileLines) {
    parts.push(
      `这是本需求分支相对基线**实际改动过的文件**：\n${fileLines}\n\n` +
        `请逐个查证它们带来的用户可见行为变化——这是判断「代码到底改了什么」最可靠的线索。`,
    );
  }

  const pageLines = bulletBlock(clipList(prevPageNames, REGEN_MAX_PAGES, '个页面'));
  if (pageLines) {
    parts.push(
      `上一版地图包含这些页面：\n${pageLines}\n\n` +
        `同一个页面请**沿用上面的原名**：用户已经按这些名字挂了 UI 设计稿，改名会让设计稿失联。\n` +
        `页面确已被删除或改名的，照实输出新情况，并在逻辑点里说明原因。`,
    );
  }

  parts.push(
    `需求地图回答的问题是：**哪个页面的哪个逻辑点被新增 / 修改 / 删除了**。\n` +
      `它给非技术人员看，用来核对「你理解的需求」和「我要的需求」是否一致。`,
  );

  return parts.join('\n\n') + '\n\n' + mapOutputContract();
}
```

**验证:** `node -e "import('./src/entrypoints/web/req-map.logic.js').then(m=>console.log(m.buildMapRegenPrompt({docPath:'/a/b.md',prevPageNames:['首页']})))"` 输出包含定调句、文档路径、页面名清单与输出契约。

---

### Task 2: `buildMapRegenPrompt` 单测

**文件:** 修改 `src/entrypoints/web/req-map.logic.test.js`

- [ ] **Step 1: 在文件顶部 import 列表中加入 `buildMapRegenPrompt`**

- [ ] **Step 2: 在文件末尾追加测试**

```javascript
test('buildMapRegenPrompt：定调以代码为准，并要求现读开发文档', () => {
  const p = buildMapRegenPrompt({ docPath: '/req/dev-doc-v3.md' });
  assert.ok(p.includes('以当前代码的实际实现为准'));
  assert.ok(p.includes('/req/dev-doc-v3.md'));
  // 输出契约必须带上，否则解析层拿不到约定结构
  assert.ok(p.includes('不要输出任何坐标字段'));
});

test('buildMapRegenPrompt：给了页面名则要求沿用原名，没给则不出该段', () => {
  const withPages = buildMapRegenPrompt({ docPath: '/a.md', prevPageNames: ['订单列表', '订单详情'] });
  assert.ok(withPages.includes('订单列表'));
  assert.ok(withPages.includes('沿用上面的原名'));

  const without = buildMapRegenPrompt({ docPath: '/a.md', prevPageNames: [] });
  assert.ok(!without.includes('沿用上面的原名'), '空清单不该留下空标题');
});

test('buildMapRegenPrompt：改动文件超上限时截断并注明剩余数量', () => {
  const files = Array.from({ length: 205 }, (_, i) => `src/f${i}.js`);
  const p = buildMapRegenPrompt({ docPath: '/a.md', changedFiles: files });
  assert.ok(p.includes('src/f199.js'));
  assert.ok(!p.includes('src/f200.js'));
  // 不注明剩余量，模型会把截断后的清单当成全集
  assert.ok(p.includes('另有 5 个文件未列出'));
});

test('buildMapRegenPrompt：需求变动逐条截断，且注明只代表意图', () => {
  const p = buildMapRegenPrompt({ docPath: '/a.md', changes: ['变'.repeat(400)] });
  assert.ok(p.includes('变'.repeat(300)));
  assert.ok(!p.includes('变'.repeat(301)));
  assert.ok(p.includes('只说明**意图**'));
});

test('buildMapRegenPrompt：空白项被剔除，不产生空行 bullet', () => {
  const p = buildMapRegenPrompt({ docPath: '/a.md', changedFiles: ['', '  ', 'src/a.js'] });
  assert.ok(p.includes('- src/a.js'));
  assert.ok(!p.includes('- \n'));
});
```

**验证:** `npm test` 中 `req-map.logic.test.js` 全绿。

---

### Task 3: `collectChangedFiles` 改动文件收集

**文件:** 修改 `src/entrypoints/web/requirement-ops.js`

- [ ] **Step 1: 在 import 块中补 `buildMapRegenPrompt`**

`req-map.logic.js` 的 import 列表（第 34-44 行）追加 `buildMapRegenPrompt,`。

- [ ] **Step 2: 在 `runMapChange`（第 973-987 行）之后追加**

```javascript
/**
 * 本需求分支相对基线的改动文件清单 —— 重扫地图的范围锚点（spec 决策 3）。
 * 复用归档链路的 defaultRunGitDiff，可注入供单测替真实 git 调用。
 *
 * 任何一个工程失败都只跳过它自己：清单是锦上添花，绝不能因为某个目录不是 git 仓库
 * 就把整次重扫拦下来。评审期 branches 为空，天然返回 []（那时也确实还没开始写代码）。
 */
export async function collectChangedFiles(req, { runGitDiff = defaultRunGitDiff } = {}) {
  const files = [];
  for (const b of req?.branches || []) {
    try {
      const r = await runGitDiff(b.dir, b.baseBranch, b.branch);
      if (r?.ok && r.out?.trim()) {
        files.push(...r.out.trim().split('\n').map((x) => x.trim()).filter(Boolean));
      }
    } catch (e) {
      logger.warn('req-ops', '改动文件清单读取失败（跳过该工程）', {
        reqId: req?.id,
        dir: b.dir,
        err: e?.message || String(e),
      });
    }
  }
  return files;
}
```

---

### Task 4: `runMapRegen` 任务执行 + dispatch 守卫

**文件:** 修改 `src/entrypoints/web/requirement-ops.js`

- [ ] **Step 1: 在 `IMPACT_TIMEOUT_MS`（第 788 行）附近追加超时常量**

```javascript
/**
 * 全量重扫比 docgen 更重，15 分钟的 DOCGEN_TIMEOUT_MS 偏紧，取 30 分钟。
 * 不像 runDocgen 那样干脆无超时：那条路径有配套的 /api/req/docgen/stop 可中止，
 * runReadonlyClaude 没有——无超时 + 无停止手段 = 卡住了只能重启进程。
 */
export const MAPREGEN_TIMEOUT_MS = 30 * 60_000;
```

- [ ] **Step 2: 在 `collectChangedFiles` 之后追加任务函数**

```javascript
/**
 * 重新生成地图：以当前代码为准全量重扫，出 v+1。
 *
 * 四条产地图链路里**唯一不 resume docSession** 的（spec 决策 1）。其余三条都续跑评审期
 * 那个 session 省 token，但那份上下文正是「开发前的代码理解」，带着它重扫等于让模型
 * 确认自己的旧结论，看不见代码已经变了。代价是要重新读一遍代码，这是固有成本。
 *
 * prev 允许为 null：地图从没生成成功过（如 docgen 后的 mapgen 挂了）时，这里是唯一的重试路径。
 */
export async function runMapRegen(req) {
  const docPath = req.devDoc?.versions?.at(-1)?.path || '';
  if (!docPath) throw new Error('尚无开发文档，无法重新生成需求地图');
  const prev = readMapVersion(req);
  const changedFiles = await collectChangedFiles(req);
  logger.info('req-ops', 'mapregen 起跑', {
    reqId: req.id,
    phase: req.phase,
    changedFiles: changedFiles.length,
    prevPages: (prev?.pages || []).length,
  });
  const { text } = await runReadonlyClaude(req, 'mapregen', {
    prompt: buildMapRegenPrompt({
      docPath,
      prevPageNames: (prev?.pages || []).map((p) => p.name),
      changes: (req.changes || []).map((c) => c.text),
      changedFiles,
    }),
    resume: null,
    startEvent: '开始重新生成需求地图（以当前代码为准）',
    timeoutMs: MAPREGEN_TIMEOUT_MS,
  });
  try {
    return persistMap(req, text, { prev, event: '需求地图重新生成完成' });
  } catch (e) {
    updateRequirement(req.id, { busy: null }, '需求地图重新生成失败：' + (e?.message || String(e)).slice(0, 160));
    throw e;
  }
}
```

- [ ] **Step 3: 在 `dispatch` 的 `mapchange` 分支（第 272-285 行）之后追加**

```javascript
  // 重新生成：三个阶段都有意义——评审期用于「地图跑歪了重来」，开发/测试期用于「代码变了重扫」。
  // phase 白名单与上面任何一组都不同（quizgen/mapgen/mapfix 仅 review，mapchange 仅 dev|test），故单列一支。
  if (kind === 'mapregen') {
    if (req.phase !== 'review' && req.phase !== 'dev' && req.phase !== 'test') {
      try {
        updateRequirement(reqId, {}, 'mapregen 作废：需求已进入归档阶段');
      } catch (e) {
        logger.error('req-ops', 'updateRequirement 失败', { reqId, kind, err: e?.message || String(e) });
      }
      return;
    }
    runMapRegen(req).catch((e) =>
      logger.error('req-ops', 'mapregen 任务异常（history 已记录失败原因）', { reqId, err: e?.message || String(e) }),
    );
    return;
  }
```

**注意:** 必须插在通用 phase 守卫（第 297 行 `if (req.phase !== 'dev' && req.phase !== 'test')`）**之前**，否则评审期的 mapregen 会被那道守卫误判作废。

---

### Task 5: 后端单测

**文件:** 修改 `src/entrypoints/web/requirement-ops.test.js`

- [ ] **Step 1: 追加 `collectChangedFiles` 测试**

```javascript
test('collectChangedFiles：合并多工程结果，单个工程失败只跳过它自己', async () => {
  const req = {
    id: 'r1',
    branches: [
      { dir: '/fe', baseBranch: 'main', branch: 'req/x' },
      { dir: '/be', baseBranch: 'main', branch: 'req/x' },
    ],
  };
  const runGitDiff = async (dir) =>
    dir === '/fe' ? { ok: true, out: 'src/a.js\nsrc/b.js\n' } : { ok: false, out: '' };
  const files = await collectChangedFiles(req, { runGitDiff });
  assert.deepEqual(files, ['src/a.js', 'src/b.js']);
});

test('collectChangedFiles：git 抛异常时不上抛（清单是锦上添花，不能拦下重扫）', async () => {
  const req = { id: 'r1', branches: [{ dir: '/x', baseBranch: 'main', branch: 'req/x' }] };
  const files = await collectChangedFiles(req, {
    runGitDiff: async () => {
      throw new Error('not a git repository');
    },
  });
  assert.deepEqual(files, []);
});

test('collectChangedFiles：评审期无 branches 返回空数组', async () => {
  assert.deepEqual(await collectChangedFiles({ id: 'r1', branches: [] }), []);
  assert.deepEqual(await collectChangedFiles({ id: 'r1' }), []);
});
```

- [ ] **Step 2: 追加 dispatch phase 守卫测试**

参照本文件中现有 dispatch 测试的桩风格（`getRequirement` / `updateRequirement` 的 mock 方式），补：

- `phase: 'review' | 'dev' | 'test'` 时 `mapregen` 不被作废
- `phase: 'archiving' | 'archived'` 时记 history「mapregen 作废：需求已进入归档阶段」

**验证:** `npm test` 全绿。

---

### Task 6: `POST /api/req/map/regen` 路由

**文件:** 修改 `src/entrypoints/web/routes-req-v2.js`

- [ ] **Step 1: 在 `handleMapAnnotate`（第 219-234 行）之后追加处理器**

```javascript
// ==== POST /api/req/map/regen {id} —— 以当前代码为准重新生成地图 ====
// 与 mapfix/mapchange 的区别：那两条是「拿上一版改」，这条是全量重扫（见 spec 决策 1）。
// 刻意**不要求已有地图**——地图从没生成成功过时（如 docgen 后的 mapgen 挂了），这里是唯一的重试入口。
function handleMapRegen(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = mustGet(res, id);
    if (!r) return;
    if (r.phase !== 'review' && r.phase !== 'dev' && r.phase !== 'test') {
      return sendJson(res, 409, { error: '仅评审/开发/测试期可重新生成需求地图' });
    }
    if (!r.devDoc?.versions?.length) return sendJson(res, 409, { error: '请先生成开发文档' });
    const { cwd } = pickCwdAndDirs(r.projects);
    if (!cwd) return sendJson(res, 400, { error: DOCGEN_GUIDE });
    if (r.busy || hasQueuedTasks(id)) return sendJson(res, 409, { error: '已有任务在进行或排队' });
    logger.info('req-v2', '收到重新生成地图请求', { reqId: id, phase: r.phase });
    enqueueSystemTask(id, 'mapregen', {});
    sendJson(res, 202, { ok: true });
  });
}
```

- [ ] **Step 2: 在分发表（第 348 行 `map/annotate` 之后）追加一行**

```javascript
  if (pathname === '/api/req/map/regen' && method === 'POST') return handleMapRegen(req, res), true;
```

**验证:** 起服务后 `curl -X POST localhost:<port>/api/req/map/regen -d '{"id":"不存在"}' -H 'Content-Type: application/json'` 返回 404。

---

### Task 7: 地图工具栏按钮

**文件:** 修改 `public/js/req-map.js`、`public/css/req-v2.css`

- [ ] **Step 1: 头部加 import（第 10-11 行之后）**

```javascript
import { confirmDialog } from './ui.js';
```

- [ ] **Step 2: 扩展入参解构（第 46 行）**

```javascript
const { reqId, phase, map, versions = [], version = null, busy = null, onReload, onRestore, onRegen } = opts;
```

同步更新函数头 JSDoc：

```javascript
 * @param {object|null} [opts.busy] - 需求当前的 busy（有则禁用「重新生成」）。不传时靠后端 409 兜底
 * @param {Function} [opts.onRegen] - 触发重新生成成功后的收尾（两处调用方的动作不同，故不复用 onReload）
```

- [ ] **Step 3: 工具栏 HTML 里，在 `'<span class="rq-ver"></span>'` 之前插入按钮**

```javascript
    '<button class="rq-regen" title="以当前代码实现为准，重新扫一遍出新版地图">↻ 重新生成</button>' +
    '<span class="rq-sep"></span>' +
```

- [ ] **Step 4: 在版本切换段（第 210-233 行）之前追加触发逻辑**

```javascript
  // ---------- 重新生成 ----------
  // 与「提交标注修订」并列的第二条回流路径，但驱动源不是用户挑错而是代码本身已经变了。
  const regenBtn = root.querySelector('.rq-regen');
  if (busy) {
    regenBtn.disabled = true;
    regenBtn.title = '系统任务运行中，请稍候';
  }
  regenBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '重新生成需求地图',
      message:
        '将忽略当前地图，重新通读一遍代码，按实际实现产出新版地图。\n' +
        '耗时通常数分钟到十几分钟。当前版本会保留，可随时切回。',
      confirmText: '开始重扫',
    });
    if (!ok) return;
    regenBtn.disabled = true;
    regenBtn.textContent = '已提交…';
    try {
      const r = await fetch('/api/req/map/regen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reqId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '触发失败');
      window.toast.success('已开始重新生成 · 完成后自动更新到新版本');
      onRegen?.();
    } catch (e) {
      window.toast.error('重新生成失败：' + (e?.message || e));
      regenBtn.disabled = false;
      regenBtn.textContent = '↻ 重新生成';
    }
  });
```

- [ ] **Step 5: 在 `public/css/req-v2.css` 的 `.rq-vbtn.on`（第 128 行）之后追加样式**

```css
.rq-regen {
  padding: 4px 10px; border-radius: 7px; font-size: 12px; color: var(--muted);
  background: var(--panel-2, #1b1c26); border: 1px solid var(--border-soft); cursor: pointer; transition: .13s;
}
.rq-regen:hover:not(:disabled) { color: var(--text); border-color: currentColor; }
.rq-regen:disabled { opacity: .45; cursor: not-allowed; }
```

**验证:** 打开任一有地图的需求，工具栏出现「↻ 重新生成」，点击弹确认框。

---

### Task 8: 评审期接线

**文件:** 修改 `public/js/req-view.js`

- [ ] **Step 1: `renderReportArea` 的 `mountMap` 调用（第 2955 行附近）补两个入参**

```javascript
    mountMap(host, {
      reqId: req.id,
      phase: req.phase,
      map: req.mapLatest,
      versions: (req.reqMap?.versions || []).map((x) => ({ v: x.v, at: x.at })),
      busy: req.busy,
      onRegen: () => loadAndRenderReq(req.id), // 刷新后 busy 非空，现有 3s 轮询接管进度
      onReload: () => loadAndRenderReq(req.id),
      // ... 现有 onRestore 保持不变
    });
```

- [ ] **Step 2: busy 卡片补 mapregen 文案（第 2824 行附近）**

现有代码只特判了 `quizgen`，其余一律走「开发文档生成中」文案。在 `if (req.busy.kind === 'quizgen')` 分支之后、默认分支之前插入：

```javascript
  // 重扫地图与生成文档耗时同量级，但做的事完全不同——显示「正在生成开发文档」是假话
  if (req.busy.kind === 'mapregen') {
    body.appendChild(e('span', null, '正在重新通读代码并生成需求地图…'));
    body.appendChild(document.createElement('br'));
    body.appendChild(e('span', 'muted', '已用时 ' + mins + ' 分钟 · 完成后自动切到新版本'));
    return body; // 或按该函数现有的收尾方式返回
  }
```

**注意:** 落地前先读该函数完整实现（第 2810-2870 行），按其真实的元素构造与返回方式对齐，上面是示意。

**验证:** 评审期点重新生成，主栏 busy 卡片显示地图重扫文案而非文档生成文案。

---

### Task 9: 开发/测试期接线

**文件:** 修改 `public/js/req-map-overlay.js`、`public/js/req-chat.js`

- [ ] **Step 1: `openMapOverlay` 扩展签名并透传（`req-map-overlay.js:12`）**

```javascript
export async function openMapOverlay({ reqId, phase, busy = null, onRegen }) {
```

`mountMap` 调用处补：

```javascript
      busy,
      onRegen: () => {
        close(); // 浮层展示的是旧版数据，留着只会让用户对着一张即将作废的图等
        onRegen?.();
      },
```

**注意:** 本文件刻意不 import `req-chat`（断依赖环，见文件头注释），回调必须由调用方注入，不要在这里直接调 `mountReqChrome`。

- [ ] **Step 2: `req-chat.js:625` 的调用处传参**

```javascript
    () => openMapOverlay({
      reqId: data.id,
      phase: data.phase,
      busy: data.busy,
      // 用 mountReqChrome 而非 refreshRail：后者只重画右栏、不启动轮询，用户看不到任何进度
      onRegen: () => mountReqChrome(data.id),
    }),
```

- [ ] **Step 3: 补全 `BUSY_KIND_LABELS`（`req-chat.js:293`）**

现存问题：map 系任务全部缺失，`mapgen`/`mapfix`/`mapchange` 跑起来时顶部芯片直接显示英文 kind。一并补齐：

```javascript
const BUSY_KIND_LABELS = {
  develop: '自动开发', 'api-fix': 'API 对照修正', 'bug-fix': 'BUG 修复',
  docgen: '文档生成', bitable: '表格巡检',
  mapgen: '地图生成', mapfix: '地图修订', mapchange: '地图更新', mapregen: '地图重新生成',
};
```

**验证:** 开发期浮层点重新生成 → 浮层关闭 → 顶部芯片显示「系统任务运行中（地图重新生成）」。

---

### Task 10: 全量测试与手工走查

- [ ] **Step 1: `npm test` 全绿**

- [ ] **Step 2: 开发期主路径**

需求处于 dev、代码已改过 → 浮层点重新生成 → 确认 → 浮层关闭、芯片显示进度 → 完成后右栏版本号 +1 → 打开新版：
- 已挂的 Figma 设计稿仍在（页面名回迁生效）
- 改动过的逻辑点带「本轮变化」高亮
- 版本页签能切回旧版

- [ ] **Step 3: 评审期路径**

地图页签点重新生成 → busy 卡片文案正确 → 完成后自动展示新版。

- [ ] **Step 4: 降级验证**

工程目录不是 git 仓库（或评审期无 branches）→ 重扫照常完成，日志中 `mapregen 起跑` 的 `changedFiles: 0`。

- [ ] **Step 5: 守卫验证**

- busy 期间按钮禁用
- 绕过前端直接 POST：无开发文档 409、归档态 409、busy 中 409

- [ ] **Step 6: 回填 spec 实现状态**

在 `docs/superpowers/specs/2026-08-27-req-map-regenerate-design.md` 末尾勾选任务并补「改动文件」「未提交说明」段落，对齐既有 spec 的收尾格式。

---

## 风险与注意事项

1. **dispatch 分支插入位置** —— 必须在通用 `phase !== 'dev' && phase !== 'test'` 守卫之前，否则评审期重扫会被静默作废。这是最容易出错的一处。
2. **不改 `mapgen`** —— 它「跟在 docgen 后 resume 同 session 省 token」的语义是对的，不要为了 DRY 把两者合并。
3. **不提交 git** —— 按项目约定，所有改动留工作区，提交时机由用户掌控。
4. **`req-view.js` Task 8 Step 2** 是示意代码，落地前必须先读该函数完整实现再对齐写法。

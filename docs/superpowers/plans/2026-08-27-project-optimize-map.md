# 维度① 项目地图自动修复 实现计划

> **设计依据：** `docs/superpowers/specs/2026-08-27-project-optimize-map-design.md`
>
> **执行纪律：** 本仓库规则是**不自动 git 提交，改动留工作区**。因此每个任务的收尾步骤是「跑测试验证」，不是 commit。提交时机由项目负责人掌控。

**目标：** 让一键优化支持维度① 地图的 M1（生成根地图）、M2（生成模块地图）、M3（过期地图追加核对块）、M4（死链修复）。

**架构：** M4 走纯确定性路径（复用全仓路径索引做 basename 唯一匹配，不调 LLM）；M1/M2/M3 走「Node 采集事实包 → 只读沙箱内的 LLM 生成 → Node 写盘」，模型全程没有写入能力。编排层扩成 rules + map 两条并列的选材/执行路径，M1 完成后重扫以拿到真实的 M2/M3/M4 清单。

**技术栈：** Node ESM、`node:test` + `node:assert/strict`、Claude Agent SDK（经 `src/integrations/claude.js`）、SSE。

**与 spec 的一处有意偏离：** spec 第八节设想了一个统一的 `task = {dim, kind, path, action, payload}` 模型。实现时放弃了它——rules 与 map 的执行语义差别太大（前者串行、带 `fatal` 熔断、失败要停后续；后者并发、单文件独立、一条失败不影响其余），套进同一个结构需要给 `demoteOne` 加一层包装，换来的只是"看起来统一"。改为两条并列路径，各自保持自己的执行纪律。`results` 数组仍然共用一种形状（`{file, status, reason, ...}`），前端和 `buildFixNotes` 据此统一消费。

**测试文件的 import：** 下面多个任务往同一个测试文件追加用例，为了让每步自成一体，示例代码里各带了自己的 `import`。ESM 的 import 声明会被提升，放在文件中部合法；但落地时请**合并到文件顶部的 import 行**，与本仓库既有测试（如 `fix-plan.logic.test.js:1-3`）保持一致。

---

## 文件结构

**新建**

| 文件 | 职责 |
|---|---|
| `src/features/llm-readonly-agent.js` | 只读沙箱调用骨架（三层权限闸 + 超时 + 中断 + JSON 提取）。与 `llm-classify.js` 平级：那个是「单轮零工具」，这个是「多轮只读」 |
| `src/features/project-optimize/fix-map.logic.js` (+test) | 纯逻辑：死链候选解析、行改写、核对块幂等合成、地图任务选材 |
| `src/features/project-optimize/map-facts.logic.js` (+test) | 纯逻辑：导出符号抽取、头部注释抽取、事实包文本格式化 |
| `src/features/project-optimize/map-facts.js` | fs 层：采集根/模块事实包 |
| `src/features/project-optimize/gen-map.logic.js` (+test) | 纯逻辑：生成 prompt 构造、产出质量闸 |
| `src/features/project-optimize/gen-map.js` | 执行层：调只读沙箱生成地图正文 |
| `src/features/project-optimize/fix-map.js` (+fs test) | 执行层：M1~M4 的写盘 |

**修改**

| 文件 | 改动 |
|---|---|
| `src/features/project-checkup/check-map.logic.js:137-160` | 给 M3/M4 的 issue 补结构化字段（`staleDays` / `ref`） |
| `src/features/project-optimize/fix-plan.logic.js` | `SUPPORTED_DIMENSIONS` 加 `'map'`；`buildFixNotes` 改成按实际维度生成 |
| `src/entrypoints/web/optimize-ops.js` | 任务模型编排、M1 重扫、受限并发、中断 |
| `src/entrypoints/web/routes-optimize.js` | 新增 `POST /api/optimize/fix/cancel` |
| `public/js/optimize-view.js` | 进度文案、取消按钮 |

---

## Task 1: M4 死链候选解析与行改写

**Files:**
- Create: `src/features/project-optimize/fix-map.logic.js`
- Test: `src/features/project-optimize/fix-map.logic.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/features/project-optimize/fix-map.logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeadLinkTarget, rewriteRefInLine } from './fix-map.logic.js';

// ---------- resolveDeadLinkTarget ----------

test('basename 在全仓唯一命中时给出目标路径', () => {
  const index = ['src/a/foo.js', 'src/b/bar.js', 'docs/readme.md'];
  assert.deepEqual(resolveDeadLinkTarget('src/old/foo.js', index), {
    status: 'unique', target: 'src/a/foo.js',
  });
});

test('basename 命中多个时判为歧义并列出候选', () => {
  // index.js 这类名字在仓库里遍地都是，改错一个比不改危险得多
  const index = ['src/a/index.js', 'src/b/index.js'];
  const out = resolveDeadLinkTarget('src/old/index.js', index);
  assert.equal(out.status, 'ambiguous');
  assert.deepEqual(out.candidates, ['src/a/index.js', 'src/b/index.js']);
});

test('basename 一个都不命中时判为无候选', () => {
  // check-map.logic.js:55-57 记录的 CDN/OSS 误报正落在这条分支上：
  // `static/font-webp/icon-star-white.webp` 在仓库里根本没有同名文件 → 不动它
  const index = ['src/a/foo.js'];
  assert.deepEqual(resolveDeadLinkTarget('static/font-webp/icon-star-white.webp', index), {
    status: 'none',
  });
});

test('目录引用按去掉尾斜杠后的名字匹配，目标补回尾斜杠', () => {
  const index = ['src/features/chat', 'src/x/y.js'];
  assert.deepEqual(resolveDeadLinkTarget('src/old/chat/', index), {
    status: 'unique', target: 'src/features/chat/',
  });
});

test('候选就是原路径本身时视为无候选', () => {
  // 原路径已经在索引里就不是死链，不该走到这儿；真走到了也不能产出「改成自己」的空操作
  const index = ['src/a/foo.js'];
  assert.deepEqual(resolveDeadLinkTarget('src/a/foo.js', index), { status: 'none' });
});

test('空输入不抛错', () => {
  assert.deepEqual(resolveDeadLinkTarget('', ['a.js']), { status: 'none' });
  assert.deepEqual(resolveDeadLinkTarget('a.js', []), { status: 'none' });
  assert.deepEqual(resolveDeadLinkTarget('a.js', null), { status: 'none' });
});

// ---------- rewriteRefInLine ----------

test('替换反引号包裹的路径字面量', () => {
  const line = '入口见 `src/old/foo.js`，注意顺序。';
  assert.equal(rewriteRefInLine(line, 'src/old/foo.js', 'src/a/foo.js'),
    '入口见 `src/a/foo.js`，注意顺序。');
});

test('保留行号后缀', () => {
  // 地图里习惯写 `src/a.js:123`，extractPathRefs 会把行号剥掉再报，
  // 改写时必须把它还回去，否则等于顺手删了作者的定位信息
  const line = '见 `src/old/foo.js:42`';
  assert.equal(rewriteRefInLine(line, 'src/old/foo.js', 'src/a/foo.js'),
    '见 `src/a/foo.js:42`');
});

test('同一行出现多次时全部替换', () => {
  const line = '`src/old/foo.js` 和 `src/old/foo.js:9`';
  assert.equal(rewriteRefInLine(line, 'src/old/foo.js', 'src/a/foo.js'),
    '`src/a/foo.js` 和 `src/a/foo.js:9`');
});

test('该行不含目标字面量时返回 null 而不是原样返回', () => {
  // 体检和优化之间文件可能被改过，行号会漂。返回 null 让调用方跳过，
  // 原样返回会被误当成「改写成功」
  assert.equal(rewriteRefInLine('完全无关的一行', 'src/old/foo.js', 'src/a/foo.js'), null);
});

test('不碰没有反引号包裹的同名文本', () => {
  // 裸文本里的路径可能是散文叙述的一部分，改它是篡改原文
  assert.equal(rewriteRefInLine('提到 src/old/foo.js 但没加反引号', 'src/old/foo.js', 'src/a/foo.js'), null);
});

test('路径含正则元字符时按字面量处理', () => {
  const line = '见 `src/a+b/c.js`';
  assert.equal(rewriteRefInLine(line, 'src/a+b/c.js', 'src/x/c.js'), '见 `src/x/c.js`');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/features/project-optimize/fix-map.logic.test.js
```

预期：`Cannot find module './fix-map.logic.js'`

- [ ] **Step 3: 写实现**

创建 `src/features/project-optimize/fix-map.logic.js`：

```js
/**
 * 维度① 地图修复的纯逻辑：不碰文件系统，不发 LLM 调用。
 *
 * 死链修复刻意做成**完全确定性**的：check-map.js 已经建好了全仓路径索引，
 * 「这条失效引用该指向哪」是个查表问题。引入模型只会把一个有确定答案的问题
 * 变成一个有概率答错的问题，而答错的代价是把地图里本来正确的路径改坏。
 */

/**
 * 为一条失效引用找出唯一的正确路径。
 *
 * 判据只有一条：**basename 在全仓索引里唯一命中**。歧义和无候选一律不改。
 *
 * 这条极保守的判据同时解决了 check-map.logic.js:55-57 记录的那类无法消除的误报——
 * 地图引用 OSS/CDN 资源时会省略域名前缀（`static/font-webp/icon-star-white.webp`），
 * 看起来和本地路径一模一样，检测器分不出来、必然报成死链。这类引用在仓库里
 * 找不到同名文件，落进 'none' 分支自然被跳过，不需要额外加规则去认它们。
 *
 * @param {string} ref 失效的引用（可能以 / 结尾表示目录）
 * @param {string[]} pathIndex 全仓相对路径索引（正斜杠），来自 check-map.js 的 buildPathIndex
 * @returns {{status:'unique',target:string}|{status:'ambiguous',candidates:string[]}|{status:'none'}}
 */
export function resolveDeadLinkTarget(ref, pathIndex) {
  const raw = String(ref ?? '').trim();
  const list = Array.isArray(pathIndex) ? pathIndex : [];
  if (!raw || !list.length) return { status: 'none' };

  const isDir = raw.endsWith('/');
  const needle = raw.replace(/\/+$/, '');
  const base = needle.split('/').filter(Boolean).pop();
  if (!base) return { status: 'none' };

  // 排除原路径自身：它在索引里就说明不是死链，产出「改成自己」是个空操作
  const hits = list.filter((p) => p !== needle && p.split('/').pop() === base);
  if (!hits.length) return { status: 'none' };
  if (hits.length > 1) return { status: 'ambiguous', candidates: hits };
  return { status: 'unique', target: isDir ? `${hits[0]}/` : hits[0] };
}

/** 正则元字符转义：路径里出现 `+`、`.`、`(` 都得按字面量匹配 */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 把一行里被反引号包裹的旧路径换成新路径。
 *
 * 两条刻意的约束：
 *
 * 1. **只认反引号包裹的**。裸文本里的同名字符串可能是散文叙述的一部分，
 *    改它就是篡改原文。这也和 extractPathRefs 的提取口径保持一致——
 *    提取时只认反引号，改写时也只认反引号，两边对得上才不会改到没被检测过的东西。
 * 2. **匹配不到返回 null**。体检和优化之间文件可能被人改过，报告里的行号会漂。
 *    返回 null 让调用方跳过这一条；原样返回会被误当成改写成功，
 *    结果是「报告说修好了、文件里那条死链还在」。
 *
 * 行号后缀（`src/a.js:123`）要保留：extractPathRefs 报上来的 ref 是剥掉行号的，
 * 改写时不还回去等于顺手删掉了作者的定位信息。
 *
 * @returns {string|null} 改写后的整行；该行不含目标字面量时为 null
 */
export function rewriteRefInLine(line, oldRef, newRef) {
  const text = String(line ?? '');
  const pattern = new RegExp('`' + escapeRe(oldRef) + '(:\\d+(?:-\\d+)?)?`', 'g');
  if (!pattern.test(text)) return null;
  pattern.lastIndex = 0;
  return text.replace(pattern, (_m, lineSuffix) => '`' + newRef + (lineSuffix || '') + '`');
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/features/project-optimize/fix-map.logic.test.js
```

预期：`pass 12`、`fail 0`

---

## Task 2: M3 核对块的幂等合成

**Files:**
- Modify: `src/features/project-optimize/fix-map.logic.js`
- Test: `src/features/project-optimize/fix-map.logic.test.js`

- [ ] **Step 1: 追加失败测试**

在 `src/features/project-optimize/fix-map.logic.test.js` 末尾追加：

```js
import { upsertStaleAudit, STALE_AUDIT_ANCHOR } from './fix-map.logic.js';

// ---------- upsertStaleAudit ----------

const auditArgs = { date: '2026-08-27', staleDays: 23, findings: ['`src/foo/bar.js` 已不存在', '新增了 `src/foo/baz.js`，地图未收录'] };

test('首次调用把核对块追加到末尾，原文一字不动', () => {
  const md = '# 模块地图\n\n人写的踩坑记录，绝对不能丢。\n';
  const out = upsertStaleAudit(md, auditArgs);
  assert.ok(out.startsWith('# 模块地图\n\n人写的踩坑记录，绝对不能丢。'));
  assert.ok(out.includes(STALE_AUDIT_ANCHOR));
  assert.ok(out.includes('## ⚠️ 自动核对（2026-08-27）'));
  assert.ok(out.includes('代码比本地图新 23 天'));
  assert.ok(out.includes('- `src/foo/bar.js` 已不存在'));
});

test('再次调用替换旧块而不是叠加第二块', () => {
  // 不幂等的话，每次优化都追加一块，跑三次地图末尾就挂三段过期的核对记录
  const once = upsertStaleAudit('# 图\n\n正文\n', auditArgs);
  const twice = upsertStaleAudit(once, { ...auditArgs, date: '2026-09-10', staleDays: 5, findings: ['只剩一条'] });
  assert.equal(twice.split(STALE_AUDIT_ANCHOR).length - 1, 1);
  assert.ok(twice.includes('2026-09-10'));
  assert.ok(!twice.includes('2026-08-27'));
  assert.ok(!twice.includes('src/foo/bar.js'));
  assert.ok(twice.startsWith('# 图\n\n正文'));
});

test('人写的正文在多次覆盖后依然完整', () => {
  // M3 的全部价值就在「只追加不覆盖」，这条断言是那个承诺的守门人
  const body = '# 图\n\n## 踩坑\n\n这里有一段模型从代码里绝对看不出来的口径约定。\n';
  let out = body;
  for (let i = 0; i < 3; i++) out = upsertStaleAudit(out, auditArgs);
  assert.ok(out.includes('这里有一段模型从代码里绝对看不出来的口径约定。'));
  assert.equal(out.split(STALE_AUDIT_ANCHOR).length - 1, 1);
});

test('findings 为空时也产出块（说明核对过但没发现差异）', () => {
  const out = upsertStaleAudit('# 图\n', { ...auditArgs, findings: [] });
  assert.ok(out.includes(STALE_AUDIT_ANCHOR));
  assert.ok(out.includes('未发现明显不符'));
});

test('空输入不抛错', () => {
  assert.ok(upsertStaleAudit('', auditArgs).includes(STALE_AUDIT_ANCHOR));
  assert.ok(upsertStaleAudit(null, auditArgs).includes(STALE_AUDIT_ANCHOR));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/features/project-optimize/fix-map.logic.test.js
```

预期：`SyntaxError` 或 `upsertStaleAudit is not a function`

- [ ] **Step 3: 写实现**

在 `src/features/project-optimize/fix-map.logic.js` 末尾追加：

```js
/**
 * 核对块的锚点。用 HTML 注释而不是标题文字做锚：标题带日期会变，
 * 用它去定位等于每次都找不到旧块、于是无限追加。
 */
export const STALE_AUDIT_ANCHOR = '<!-- checkup:stale-audit -->';

/**
 * 在过期地图末尾写入「自动核对」块——**只追加/替换这一块，正文一字不动**。
 *
 * 为什么不重写整篇：模块地图里往往有人手写的踩坑记录和口径约定，
 * 这些恰恰是模型从代码里看不出来的部分，重写必然丢失，而备份要用户主动去翻才发现。
 *
 * 幂等靠锚点实现：锚点总是位于文件末尾（本函数是唯一的写入者），
 * 所以再次调用时把锚点及其之后的内容整个截掉再重写。
 * 不幂等的后果是跑三次优化就在地图末尾挂三段互相矛盾的过期核对记录。
 *
 * ⚠️ 调用方必须知道：写入会刷新文件 mtime，而 check-map.js:107 判过期正是靠
 * 「代码 mtime - 地图 mtime」。也就是说这次写入会让该地图的 M3 告警在下次体检时消失，
 * 但地图正文并没有变新鲜。所以块内文案必须自己足够醒目——它是唯一还在提醒的人。
 *
 * @param {string} md 地图原文
 * @param {{date:string, staleDays:number, findings:string[]}} args
 * @returns {string}
 */
export function upsertStaleAudit(md, { date, staleDays, findings } = {}) {
  const list = (Array.isArray(findings) ? findings : []).map((f) => String(f ?? '').trim()).filter(Boolean);

  const body = list.length
    ? [`代码比本地图新 ${staleDays} 天。以下条目与当前代码不符，**地图正文尚未更新**：`, '', ...list.map((f) => `- ${f}`)]
    : [`代码比本地图新 ${staleDays} 天，自动核对**未发现明显不符**，但仍建议人工确认关键流程。`];

  const block = [
    STALE_AUDIT_ANCHOR,
    `## ⚠️ 自动核对（${date}）`,
    '',
    ...body,
    '',
  ].join('\n');

  const text = String(md ?? '').replace(/\r\n/g, '\n');
  const at = text.indexOf(STALE_AUDIT_ANCHOR);
  const keep = (at < 0 ? text : text.slice(0, at)).replace(/\s*$/, '');

  return keep ? `${keep}\n\n${block}` : block;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/features/project-optimize/fix-map.logic.test.js
```

预期：`pass 17`、`fail 0`

---

## Task 3: 检测器补结构化字段 + 地图任务选材

**Files:**
- Modify: `src/features/project-checkup/check-map.logic.js:137-160`
- Modify: `src/features/project-optimize/fix-map.logic.js`
- Test: `src/features/project-checkup/check-map.logic.test.js`、`src/features/project-optimize/fix-map.logic.test.js`

> **为什么要动「已定型」的检测器**：M3 的 `staleDays` 和 M4 的 `ref` 目前只存在于 `message` 文本里（`代码比地图新 23 天`、`引用的 xxx 不存在`）。修复逻辑要用这两个值，从人类可读文案里正则反解是典型的坏味道——文案一改，优化就静默失效。这里只**新增字段**，不改 `message`、不改分数、不改任何既有断言，风险与收益完全不对称。

- [ ] **Step 1: 给检测器补字段的测试**

在 `src/features/project-checkup/check-map.logic.test.js` 末尾追加：

```js
test('M3 issue 带结构化 staleDays，M4 issue 带结构化 ref', () => {
  // 修复逻辑要用这两个值。只留在 message 文本里的话，改一次文案就让自动修复静默失效
  const out = evaluateMap({
    hasRootMap: true,
    modules: [{ name: 'src/a', hasMap: true, staleDays: 23 }],
    deadLinks: [{ file: 'CLAUDE.md', line: 7, ref: 'src/gone.js' }],
    rootMapLines: 100,
  });
  const m3 = out.issues.find((i) => i.code === 'M3_STALE_MAP');
  const m4 = out.issues.find((i) => i.code === 'M4_DEAD_LINK');
  assert.equal(m3.staleDays, 23);
  assert.equal(m4.ref, 'src/gone.js');
  assert.equal(m4.line, 7);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/features/project-checkup/check-map.logic.test.js
```

预期：`AssertionError: undefined !== 23`

- [ ] **Step 3: 改检测器**

`src/features/project-checkup/check-map.logic.js` 中，M3 的 issue 推入处（约 138 行）改为：

```js
    issues.push({
      code: 'M3_STALE_MAP',
      severity: 'warn',
      file: `${m.name}/CLAUDE.md`,
      line: 1,
      message: `代码比地图新 ${m.staleDays} 天，地图可能已和实现脱节`,
      // 自动修复要按天数写进核对块。只留在 message 里的话，
      // 改一次文案就得同步改修复端的正则，而漏改不会报错、只会静默失效
      staleDays: m.staleDays,
      fixable: true,
      fixHint: '重新核对该模块地图的文件清单与关键流程',
    });
```

M4 的 issue 推入处（约 152 行）改为：

```js
    issues.push({
      code: 'M4_DEAD_LINK',
      severity: 'warn',
      file: d.file,
      line: d.line,
      message: `引用的 ${d.ref} 不存在`,
      // 同上：修复端要拿原始 ref 去查索引、去比对行内容，不能从文案里反解
      ref: d.ref,
      fixable: true,
      fixHint: '修正为正确路径，或删除该引用',
    });
```

- [ ] **Step 4: 跑检测器测试确认全绿**

```bash
node --test src/features/project-checkup/check-map.logic.test.js
```

预期：原有 28 条 + 新增 1 条全部 pass，`fail 0`

- [ ] **Step 5: 写选材函数的失败测试**

在 `src/features/project-optimize/fix-map.logic.test.js` 末尾追加：

```js
import { selectFixableMap, planMapFix } from './fix-map.logic.js';

// ---------- selectFixableMap ----------

const mapReport = (issues) => ({ dims: { map: { status: 'done', issues } } });

test('按 code 把地图 issue 分流到四条修复路径', () => {
  const r = mapReport([
    { code: 'M2_MISSING_MAP', file: 'src/foo/CLAUDE.md', fixable: true, message: 'a' },
    { code: 'M3_STALE_MAP', file: 'src/bar/CLAUDE.md', staleDays: 23, fixable: true, message: 'b' },
    { code: 'M4_DEAD_LINK', file: 'CLAUDE.md', line: 7, ref: 'src/gone.js', fixable: true, message: 'c' },
  ]);
  const out = selectFixableMap(r);
  assert.equal(out.rootMap, false);
  assert.deepEqual(out.modules, ['src/foo']);
  assert.deepEqual(out.stale, [{ file: 'src/bar/CLAUDE.md', staleDays: 23 }]);
  assert.deepEqual(out.deadLinks, [{ file: 'CLAUDE.md', line: 7, ref: 'src/gone.js' }]);
});

test('M1 命中时只产出根地图任务', () => {
  // check-map.logic.js:95 在没有根地图时 early-return，报告里压根不会有 M2/M3/M4。
  // 编排层据此决定「先生成根地图，然后必须重扫」
  const out = selectFixableMap(mapReport([
    { code: 'M1_NO_ROOT_MAP', file: 'CLAUDE.md', fixable: true, message: 'x' },
  ]));
  assert.equal(out.rootMap, true);
  assert.deepEqual(out.modules, []);
});

test('M5 不可修项进 blocked 而不是被丢掉', () => {
  // 静默丢弃会让用户以为地图维度已经全处理完了
  const out = selectFixableMap(mapReport([
    { code: 'M5_OVERSIZED', file: 'CLAUDE.md', fixable: false, message: '根地图 350 行' },
  ]));
  assert.equal(out.blocked.length, 1);
  assert.match(out.blocked[0].reason, /350 行/);
});

test('缺结构化字段的旧报告进 blocked 并提示重新体检', () => {
  // 落盘的 lastCheckup 可能是补字段之前的版本。从 message 正则反解是错的做法，
  // 如实告诉用户「这份报告太旧」才诚实
  const out = selectFixableMap(mapReport([
    { code: 'M4_DEAD_LINK', file: 'CLAUDE.md', line: 7, fixable: true, message: '引用的 src/gone.js 不存在' },
    { code: 'M3_STALE_MAP', file: 'src/bar/CLAUDE.md', fixable: true, message: '代码比地图新 23 天' },
  ]));
  assert.deepEqual(out.deadLinks, []);
  assert.deepEqual(out.stale, []);
  assert.equal(out.blocked.length, 2);
  assert.match(out.blocked[0].reason, /重新体检/);
});

test('map 维度缺失 / 报告为空都返回空结果而不抛错', () => {
  for (const bad of [null, undefined, {}, { dims: {} }, { dims: { map: {} } }]) {
    const out = selectFixableMap(bad);
    assert.equal(out.rootMap, false);
    assert.deepEqual(out.modules, []);
    assert.deepEqual(out.blocked, []);
  }
});

// ---------- planMapFix ----------

test('备份计划覆盖全部将被写入的文件，created 与 modified 分清', () => {
  // created 在 backup.logic.js:24 会被标成 backed:false，还原时靠删除它回到原状；
  // 标错成 modified 会让还原去找一份根本不存在的备份内容
  const entries = planMapFix({
    rootMap: true,
    modules: ['src/foo'],
    stale: [{ file: 'src/bar/CLAUDE.md', staleDays: 23 }],
    deadLinks: [{ file: 'CLAUDE.md', line: 7, ref: 'x' }, { file: 'src/bar/CLAUDE.md', line: 3, ref: 'y' }],
  });
  const byPath = Object.fromEntries(entries.map((e) => [e.path, e.action]));
  assert.equal(byPath['CLAUDE.md'], 'created');
  assert.equal(byPath['src/foo/CLAUDE.md'], 'created');
  assert.equal(byPath['src/bar/CLAUDE.md'], 'modified');
  assert.equal(entries.length, 3, '同一文件被多条任务碰到时只登记一次');
});

test('created 优先于 modified', () => {
  // 根地图这一轮是新建的，同时又要修它里面的死链——文件整体是「新建」，
  // 登记成 modified 会让还原去恢复一份优化前根本不存在的内容
  const entries = planMapFix({
    rootMap: true, modules: [], stale: [],
    deadLinks: [{ file: 'CLAUDE.md', line: 1, ref: 'x' }],
  });
  assert.deepEqual(entries, [{ path: 'CLAUDE.md', action: 'created' }]);
});

test('空选材产出空计划', () => {
  assert.deepEqual(planMapFix({ rootMap: false, modules: [], stale: [], deadLinks: [] }), []);
  assert.deepEqual(planMapFix(), []);
});
```

- [ ] **Step 6: 跑测试确认失败**

```bash
node --test src/features/project-optimize/fix-map.logic.test.js
```

预期：`selectFixableMap is not a function`

- [ ] **Step 7: 写实现**

在 `src/features/project-optimize/fix-map.logic.js` 末尾追加：

```js
/** 缺结构化字段时给用户的统一说法：报告版本旧，不是问题本身修不了 */
const STALE_REPORT_REASON = '体检报告缺少修复所需的结构化字段（版本较旧），请重新体检后再优化';

/**
 * 从体检报告里把地图维度的 issue 分流到四条修复路径。
 *
 * 与 selectFixableRules 并列而不是合并：两者的产物形状完全不同
 * （那边是文件名列表，这边是四类异构任务），硬塞进一个函数只会让两边都难读。
 *
 * **M1 的特殊性**：check-map.logic.js:95 在没有根地图时 early-return，
 * 那份报告里 M2/M3/M4 根本不存在。所以 rootMap 为真时，编排层必须在写完根地图后
 * 重新体检一次，才能拿到真实的其余清单。
 *
 * @param {object|null} report
 * @returns {{rootMap:boolean, modules:string[], stale:Array<{file:string,staleDays:number}>,
 *   deadLinks:Array<{file:string,line:number,ref:string}>, blocked:Array<{file:string,reason:string}>}}
 */
export function selectFixableMap(report) {
  const out = { rootMap: false, modules: [], stale: [], deadLinks: [], blocked: [] };
  const issues = report?.dims?.map?.issues;
  if (!Array.isArray(issues)) return out;

  for (const it of issues) {
    const file = String(it?.file || '');
    if (it?.fixable !== true) {
      out.blocked.push({ file, reason: String(it?.message || '检测器标记为不可自动修复') });
      continue;
    }

    switch (it.code) {
      case 'M1_NO_ROOT_MAP':
        out.rootMap = true;
        break;
      case 'M2_MISSING_MAP':
        out.modules.push(file.replace(/\/CLAUDE\.md$/, ''));
        break;
      case 'M3_STALE_MAP':
        // 从 message 里正则反解 staleDays 是错的：文案一改就静默失效。
        // 缺字段就如实说「报告太旧」，让用户重新体检——比猜一个数字诚实
        if (typeof it.staleDays === 'number') out.stale.push({ file, staleDays: it.staleDays });
        else out.blocked.push({ file, reason: STALE_REPORT_REASON });
        break;
      case 'M4_DEAD_LINK':
        if (typeof it.ref === 'string' && it.ref) out.deadLinks.push({ file, line: it.line, ref: it.ref });
        else out.blocked.push({ file, reason: STALE_REPORT_REASON });
        break;
      default:
        out.blocked.push({ file, reason: `未知的地图问题类型 ${it.code}，未做处理` });
    }
  }

  return out;
}

/**
 * 列出本次地图修复会写到的全部文件及动作，供 createBackup 打快照。
 *
 * **必须在任何写操作之前调用**，且本身无副作用（同 planDemote 的纪律）。
 *
 * created 与 modified 必须分对：backup.logic.js:24 对 created 标 `backed:false`，
 * 还原时靠删除它回到原状。标反了——把新建的根地图登记成 modified——
 * 还原会去找一份优化前根本不存在的备份内容，结果是文件留在原地删不掉。
 * 同理，一个文件既被新建又被改（根地图刚生成又要修它的死链），整体算 created。
 *
 * @param {ReturnType<typeof selectFixableMap>} [selection]
 * @returns {Array<{path:string, action:'created'|'modified'}>}
 */
export function planMapFix(selection) {
  const s = selection || {};
  const entries = new Map();

  const put = (p, action) => {
    if (!p) return;
    // created 覆盖 modified，反之不覆盖
    if (action === 'created' || !entries.has(p)) entries.set(p, action);
  };

  if (s.rootMap) put('CLAUDE.md', 'created');
  for (const mod of s.modules || []) put(`${mod}/CLAUDE.md`, 'created');
  for (const st of s.stale || []) put(st.file, 'modified');
  for (const dl of s.deadLinks || []) put(dl.file, 'modified');

  return [...entries].map(([path, action]) => ({ path, action }));
}
```

- [ ] **Step 8: 跑全部相关测试确认通过**

```bash
node --test src/features/project-optimize/fix-map.logic.test.js src/features/project-checkup/check-map.logic.test.js
```

预期：`fail 0`

---

## Task 4: 只读沙箱调用骨架

**Files:**
- Create: `src/features/llm-readonly-agent.js`

> 无单测：本模块几乎全是 SDK 参数装配，桩掉 `runClaude` 之后剩下的断言只是「我传了我打算传的参数」，属于把实现复述一遍的同义反复。真正的验证在 Task 15 的真实项目跑通，以及下一步的 `canUseTool` 拦截日志。

- [ ] **Step 1: 写实现**

创建 `src/features/llm-readonly-agent.js`：

```js
/**
 * 多轮**只读** LLM 调用骨架 —— 与 llm-classify.js 平级的另一种调用形态。
 *
 * 两者的分工：llm-classify 是「单轮 + 零工具」，处理已经给定的文本；
 * 本模块是「多轮 + 只读工具」，用于必须实地读代码才能作答的任务（生成项目地图）。
 *
 * ## 只读保证为什么需要三层
 *
 * 本仓库为这件事交过三次学费，三条教训方向各不相同，少任何一条防线都会漏：
 *
 * 1. **`allowedTools` 不是白名单**（describe-skill.js:15-24）。官方原文
 *    「This does not restrict Claude to only these tools」——它只是免确认列表。
 *    `allowedTools: ['Read']` 的真实效果是「全部工具可用，其中 Read 免确认」。
 * 2. **列名黑名单补不全**（llm-classify.js:125-129）。2026-08-24 实测中模型调用
 *    ToolSearch 把被禁的 Read 重新捞了出来。SDK 每加一个新工具，黑名单就多一个洞。
 * 3. **光传 canUseTool 会被架空**（run-claude.js:117-119）。用户全局 settings.json
 *    把 Bash/Edit/Write 整体 allow 时，**allow 规则优先于 canUseTool，回调根本不会被调用**。
 *
 * 前两条合起来说明：静态工具名单无论正列反列都给不了只读保证，唯一可靠的是运行时逐次裁决。
 * 第三条说明：运行时裁决还得先把裁决权夺回来。于是有了下面这三层，顺序不能少：
 *
 *   第 1 层 hooks.PreToolUse → 'ask'：夺回裁决权，让 canUseTool 一定会被调用
 *   第 2 层 canUseTool 白名单：无论工具怎么被捞回来，执行前都要过这一关
 *   第 3 层 disallowedTools：挡不住 ToolSearch，但能少让模型做无用尝试，省轮次和 token
 *
 * permissionMode 必须是 'default'。用 'bypassPermissions' 会把第 1、2 层一起绕过。
 */
import { runClaude } from '../integrations/claude.js';
import { claudeAuthOpts, getTokens, isPoolExhausted } from './token-rotation.js';
import { extractFirstJsonObject } from './llm-classify.js';
import { logger } from '../shared/logger.js';

/**
 * 运行时白名单。
 *
 * ToolSearch 放行是刻意的：它只返回工具的 schema 文本、不产生任何副作用，
 * 而模型被禁掉工具后的第一反应就是去搜。拦它只会白白吃掉轮次并让模型陷入重试循环；
 * 真正的闸是本白名单本身——它就算把 Write 捞回来，执行前照样在这里被拒。
 */
export const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'ToolSearch']);

/**
 * 默认超时。
 *
 * describe-skill.js:40-62 记录了单轮无工具调用的实测长尾已达 127s（预算 122s 时
 * 答案晚到 5 秒、整条落了兜底）。本模块是**多轮 + 每轮夹着工具调用**，
 * 长尾只会更长，所以起步给到 10 分钟。
 *
 * 多等的代价很小（一键优化是低频操作），超时的代价很大：地图生成不出来，
 * 而用户看到的是「优化完成」。宁可等。
 */
export const READONLY_AGENT_TIMEOUT_MS = 600_000;

/** 探索深度上限：够走完「列目录 → 读入口 → 抽查几个文件」，也兜住失控 */
const DEFAULT_MAX_TURNS = 30;

/** 第 3 层：静态黑名单。补不全（见文件头教训 2），只当减少尝试用 */
const DENIED_TOOLS = [
  'Write', 'Edit', 'NotebookEdit', 'Bash', 'BashOutput', 'KillShell',
  'Task', 'WebFetch', 'WebSearch', 'SlashCommand',
];

/** 第 1 层：把每次工具调用的裁决权从 settings.json 的 allow 规则手里夺回来 */
const FORCE_ASK_HOOKS = {
  PreToolUse: [{
    hooks: [async () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    })],
  }],
};

/**
 * 跑一次只读的多轮调用，返回模型输出里的首个 JSON 对象。
 *
 * 从不抛错：调用方（地图生成）处在优化流程中途，抛异常会把整批停在半路。
 * 一切失败都通过 `{data:null, reason}` 表达。
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {object} [opts.systemPrompt] runClaude 透传格式
 * @param {string} opts.cwd 项目目录 —— 模型的读取范围
 * @param {string|null} [opts.model] null = 跟随会话默认模型
 * @param {string} opts.logTag 日志标识
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxTurns]
 * @param {AbortSignal} [opts.signal] 外部取消（用户点「停止优化」）
 * @returns {Promise<{data:object|null, reason:'exhausted'|'cancelled'|'timeout'|'unparsable'|null,
 *   denied:string[]}>} denied 是被白名单拦下的工具名，用于排查模型是否在试图越权
 */
export async function runReadonlyAgent({
  prompt, systemPrompt, cwd, model = null, logTag,
  timeoutMs, maxTurns = DEFAULT_MAX_TURNS, signal,
} = {}) {
  // 额度耗尽 fail-fast：同 llm-classify.js:107 的理由——五小时限流窗口内
  // SDK 流可能永不结束，不发起注定失败的调用
  if (isPoolExhausted(getTokens())) {
    logger.warn('llm-readonly-agent', 'token 池全部耗尽，跳过调用（fail-fast）', { logTag });
    return { data: null, reason: 'exhausted', denied: [] };
  }
  if (signal?.aborted) return { data: null, reason: 'cancelled', denied: [] };

  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : READONLY_AGENT_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), budget);
  const relayAbort = () => abort.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });

  let out = '';
  const denied = [];

  try {
    const call = runClaude(prompt, {
      ...claudeAuthOpts(), // 跟随备用账号轮换，别烧主账号额度
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      persistSession: false, // 内部一次性调用，不污染磁盘历史列表
      permissionMode: 'default', // 不能用 bypassPermissions：会绕过下面两层
      maxTurns,
      disallowedTools: DENIED_TOOLS,
      hooks: FORCE_ASK_HOOKS,
      canUseTool: async (toolName) => {
        if (READONLY_TOOLS.has(toolName)) return { behavior: 'allow' };
        denied.push(toolName);
        logger.warn('llm-readonly-agent', '拦截了非只读工具调用', { logTag, tool: toolName });
        return {
          behavior: 'deny',
          message: '本次调用只允许读取（Read/Grep/Glob）。请不要尝试写入或执行，仅基于读到的内容作答。',
        };
      },
      abortController: abort,
      onText: (t) => (out += t),
      onResult: (info) => { if (!out && info.result) out = info.result; },
    });
    // race 放弃后该 promise 仍可能 reject，预挂 catch 防 unhandled（同 llm-classify.js:137）
    call.catch((e) => logger.warn('llm-readonly-agent', '调用异常（已落兜底）', { logTag, err: e?.message || String(e) }));
    await Promise.race([call, new Promise((resolve) => setTimeout(resolve, budget + 2_000))]);
  } catch {
    /* 超时 abort 或调用异常 → 落兜底 */
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }

  // 先尝试解析、再看是否超时：顺序同 llm-classify.js:72-74。
  // abort 只说明「流没按时结束」，模型常常早把答案吐完了而 SDK 流迟迟不收尾。
  // 此时手里已有完整结果还回一句失败，是白烧一次额度又骗了用户。
  const block = extractFirstJsonObject(out);
  if (block) {
    try { return { data: JSON.parse(block), reason: null, denied }; } catch { /* 归因到下面 */ }
  }
  // cancelled 要先于 timeout 判：两者都表现为 abort，但对用户是完全不同的两件事
  // （「你点了停止」vs「跑太久了」），归错会让人以为系统出故障
  if (signal?.aborted) return { data: null, reason: 'cancelled', denied };
  return { data: null, reason: abort.signal.aborted ? 'timeout' : 'unparsable', denied };
}
```

- [ ] **Step 2: 确认模块能被加载（语法与导入路径）**

```bash
node -e "import('./src/features/llm-readonly-agent.js').then((m) => console.log('OK', typeof m.runReadonlyAgent, [...m.READONLY_TOOLS]))"
```

预期：`OK function [ 'Read', 'Grep', 'Glob', 'ToolSearch' ]`

---

## Task 5: 事实包纯逻辑

**Files:**
- Create: `src/features/project-optimize/map-facts.logic.js`
- Test: `src/features/project-optimize/map-facts.logic.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/features/project-optimize/map-facts.logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractExports, headComment, formatFactPack } from './map-facts.logic.js';

// ---------- extractExports ----------

test('抽出具名导出的函数、常量、类', () => {
  const code = [
    'export function alpha() {}',
    'export async function beta() {}',
    'export const GAMMA = 1;',
    'export class Delta {}',
  ].join('\n');
  assert.deepEqual(extractExports(code), ['alpha', 'beta', 'GAMMA', 'Delta']);
});

test('忽略 re-export 与默认导出', () => {
  // `export * from` 没有具名信息；default 的名字对「这个模块提供什么」没有帮助
  const code = 'export * from "./x.js";\nexport default function () {}';
  assert.deepEqual(extractExports(code), []);
});

test('不把注释掉的导出算进去', () => {
  // 注释里的示例代码很常见，收进来会让地图列出根本不存在的 API
  const code = '// export function ghost() {}\nexport function real() {}';
  assert.deepEqual(extractExports(code), ['real']);
});

test('空输入返回空数组', () => {
  assert.deepEqual(extractExports(''), []);
  assert.deepEqual(extractExports(null), []);
});

// ---------- headComment ----------

test('取出文件顶部块注释的首个实义行', () => {
  const code = '/**\n * 维度①的文件系统层：遍历模块目录、比对 mtime。\n *\n * 更多细节……\n */\nimport fs from "fs";';
  assert.equal(headComment(code), '维度①的文件系统层：遍历模块目录、比对 mtime。');
});

test('没有块注释时返回空串', () => {
  assert.equal(headComment('import fs from "fs";'), '');
});

test('块注释不在文件开头时不取', () => {
  // 文件中部的注释描述的是局部逻辑，冒充文件职责会误导地图
  assert.equal(headComment('import fs from "fs";\n/** 局部说明 */'), '');
});

test('超长首行被截断', () => {
  const long = '/**\n * ' + 'x'.repeat(300) + '\n */';
  assert.ok(headComment(long).length <= 120);
});

// ---------- formatFactPack ----------

test('把事实包渲染成带小节标题的文本', () => {
  const text = formatFactPack([
    { title: '目录结构', body: 'src/\n  a/\n  b/' },
    { title: '常用命令', body: 'npm test' },
  ]);
  assert.ok(text.includes('### 目录结构'));
  assert.ok(text.includes('### 常用命令'));
  assert.ok(text.includes('npm test'));
});

test('空 body 的小节被整节丢掉', () => {
  // 留下「### 依赖\n（无）」这种空壳只会占 token，还让模型以为这是重要信息
  const text = formatFactPack([
    { title: '有内容', body: 'x' },
    { title: '空的', body: '' },
    { title: '也空', body: null },
  ]);
  assert.ok(text.includes('### 有内容'));
  assert.ok(!text.includes('### 空的'));
  assert.ok(!text.includes('### 也空'));
});

test('空输入返回空串', () => {
  assert.equal(formatFactPack([]), '');
  assert.equal(formatFactPack(null), '');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/features/project-optimize/map-facts.logic.test.js
```

预期：`Cannot find module './map-facts.logic.js'`

- [ ] **Step 3: 写实现**

创建 `src/features/project-optimize/map-facts.logic.js`：

```js
/**
 * 事实包的纯逻辑：从源码文本里抽取「这个文件/模块是干什么的」信号。
 *
 * 事实包的作用不是省 token，而是**保底**：模型拿着只读工具自由探索时，
 * 可能只读了两三个文件就下结论。事实包保证文件清单、导出符号这类硬事实至少是对的，
 * 模型的自由探索只用来补充「关键流程」这类需要理解才能写出来的部分。
 */

/** 单条注释摘要的最大长度：一行够说清职责，再长就是把整段文档搬进事实包 */
const COMMENT_CLIP = 120;

/**
 * 抽出文件的具名导出。
 *
 * 只认行首（允许前导空白）的 `export`，是为了排开注释里的示例代码——
 * 本仓库注释密度很高，注释里写 `// export function xxx()` 举例很常见，
 * 收进来会让地图列出根本不存在的 API。
 *
 * 不收 `export default` 和 `export * from`：前者没有对读者有用的名字，
 * 后者没有具名信息，两者对「这个模块提供什么」都不构成回答。
 *
 * @param {string} code
 * @returns {string[]}
 */
export function extractExports(code) {
  const text = String(code ?? '');
  const out = [];
  const re = /^[ \t]*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * 取文件顶部块注释的首个实义行，作为该文件的职责摘要。
 *
 * 必须在文件开头（允许前导空白）：文件中部的块注释描述的是局部逻辑，
 * 拿它冒充文件职责会让地图给出错误的导航。
 *
 * 本仓库几乎每个模块开头都有一段「为什么这么做」的块注释，信息密度极高——
 * 这是本项目特有的红利，比任何静态分析都准。
 *
 * @param {string} code
 * @returns {string} 摘要；没有开头块注释时为空串
 */
export function headComment(code) {
  const text = String(code ?? '');
  const m = /^\s*\/\*\*?([\s\S]*?)\*\//.exec(text);
  if (!m) return '';
  for (const raw of m[1].split('\n')) {
    const line = raw.replace(/^\s*\*?\s?/, '').trim();
    if (line) return line.slice(0, COMMENT_CLIP);
  }
  return '';
}

/**
 * 把若干小节渲染成喂给模型的事实包文本。
 *
 * 空小节整节丢掉：留下「### 依赖\n（无）」这种空壳既占 token，
 * 又让模型误以为「无」是一条需要写进地图的事实。
 *
 * @param {Array<{title:string, body:string}>} sections
 * @returns {string}
 */
export function formatFactPack(sections) {
  return (Array.isArray(sections) ? sections : [])
    .filter((s) => String(s?.body ?? '').trim())
    .map((s) => `### ${s.title}\n\n${String(s.body).trim()}`)
    .join('\n\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/features/project-optimize/map-facts.logic.test.js
```

预期：`pass 11`、`fail 0`

---

## Task 6: 事实包 fs 采集层

**Files:**
- Create: `src/features/project-optimize/map-facts.js`

- [ ] **Step 1: 写实现**

创建 `src/features/project-optimize/map-facts.js`：

```js
/**
 * 事实包的文件系统层：扫盘产出「模型自由探索之前就该知道的硬事实」。
 *
 * 全部只读，不写任何文件。所有失败都吞掉转成空串——事实包是**保底**信息，
 * 缺一节会让地图质量下降，为它中断整个生成得不偿失。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { shouldSkipDir } from '../project-checkup/scan-dirs.logic.js';
import { extractExports, headComment, formatFactPack } from './map-facts.logic.js';

const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|vue|py|go|rs|java|scss|css)$/i;
const TREE_DEPTH = 2;      // 根事实包的目录树深度：够看出项目分层，再深就是把 ls -R 塞进 prompt
const MAX_MODULE_FILES = 60; // 单模块列举上限：超大模块全列会挤爆 prompt，且长尾文件对导航价值递减
const README_LINES = 60;
const GIT_LOG_COUNT = 20;

const readText = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; } };

/** 目录树（限深），每行一个条目，目录带尾斜杠 */
function treeOf(dir, depth, prefix = '') {
  if (depth <= 0) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (shouldSkipDir(e.name, { skipHidden: true })) continue;
    if (e.isDirectory()) {
      out.push(`${prefix}${e.name}/`);
      out.push(...treeOf(path.join(dir, e.name), depth - 1, `${prefix}  `));
    } else if (CODE_EXT.test(e.name) || /\.(md|json)$/i.test(e.name)) {
      out.push(`${prefix}${e.name}`);
    }
  }
  return out;
}

/** 递归收集模块内的代码文件相对路径 */
function filesOf(dir, rel = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (shouldSkipDir(e.name, { skipHidden: true })) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesOf(path.join(dir, e.name), r));
    else if (CODE_EXT.test(e.name)) out.push(r);
  }
  return out;
}

/** 最近若干条提交的 subject。不是 git 仓库或 git 不可用都返回空串 */
function gitLog(projectDir) {
  try {
    return execFileSync('git', ['log', `-${GIT_LOG_COUNT}`, '--pretty=format:%s'], {
      cwd: projectDir, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * 根地图的事实包。
 *
 * 「已有的模块地图」这一节很关键：根地图要写模块路由表，而模块地图的存在与否
 * 决定了路由表该指向 `src/foo/CLAUDE.md` 还是直接指向源码目录。
 *
 * @returns {string} 已渲染的事实包文本
 */
export function collectRootFacts(projectDir) {
  const pkgRaw = readText(path.join(projectDir, 'package.json'));
  let pkgBody = '';
  try {
    const pkg = JSON.parse(pkgRaw);
    pkgBody = [
      pkg.name ? `名称：${pkg.name}` : '',
      pkg.description ? `描述：${pkg.description}` : '',
      pkg.type ? `模块制式：${pkg.type}` : '',
      pkg.main || pkg.bin ? `入口：${pkg.main || JSON.stringify(pkg.bin)}` : '',
      Object.keys(pkg.scripts || {}).length
        ? `脚本：\n${Object.entries(pkg.scripts).map(([k, v]) => `  npm run ${k}  →  ${v}`).join('\n')}`
        : '',
      Object.keys(pkg.dependencies || {}).length
        ? `主要依赖：${Object.keys(pkg.dependencies).slice(0, 25).join('、')}`
        : '',
    ].filter(Boolean).join('\n');
  } catch { /* 没有或读不出 package.json 的项目（Python/Go）照常走，这一节留空 */ }

  const existingMaps = [];
  const srcDir = path.join(projectDir, 'src');
  const base = fs.existsSync(srcDir) ? srcDir : projectDir;
  const prefix = fs.existsSync(srcDir) ? 'src/' : '';
  try {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || shouldSkipDir(e.name, { skipHidden: true })) continue;
      if (fs.existsSync(path.join(base, e.name, 'CLAUDE.md'))) existingMaps.push(`${prefix}${e.name}/CLAUDE.md`);
    }
  } catch { /* 读不到就当没有 */ }

  const readme = ['README.md', 'readme.md', 'README.zh-CN.md']
    .map((n) => readText(path.join(projectDir, n)))
    .find(Boolean) || '';

  return formatFactPack([
    { title: '目录结构（限两层）', body: treeOf(projectDir, TREE_DEPTH).join('\n') },
    { title: 'package.json 要点', body: pkgBody },
    { title: '已有的模块地图', body: existingMaps.join('\n') },
    { title: 'README 开头', body: readme.split('\n').slice(0, README_LINES).join('\n') },
    { title: `最近 ${GIT_LOG_COUNT} 条提交`, body: gitLog(projectDir) },
  ]);
}

/**
 * 单个模块的事实包。
 *
 * 「文件职责」那一节靠 headComment 抽取——本仓库几乎每个模块开头都有一段
 * 「为什么这么做」的块注释，密度和准确度都远超任何静态分析。
 *
 * @param {string} projectDir
 * @param {string} moduleRel 模块相对路径，如 'src/features'
 */
export function collectModuleFacts(projectDir, moduleRel) {
  const abs = path.join(projectDir, moduleRel);
  const files = filesOf(abs);
  const shown = files.slice(0, MAX_MODULE_FILES);

  const lines = shown.map((rel) => {
    const code = readText(path.join(abs, rel));
    const loc = code ? code.split('\n').length : 0;
    const duty = headComment(code);
    const exps = extractExports(code).slice(0, 8);
    const tail = [duty && `职责：${duty}`, exps.length && `导出：${exps.join(', ')}`].filter(Boolean).join('｜');
    return `- ${rel}（${loc} 行）${tail ? `　${tail}` : ''}`;
  });

  if (files.length > shown.length) {
    // 截断要说出来：不说的话模型会以为这就是全部文件，写出一份漏掉一半内容的地图
    lines.push(`- …另有 ${files.length - shown.length} 个文件未列出（模块过大，仅列前 ${MAX_MODULE_FILES} 个）`);
  }

  return formatFactPack([
    { title: `模块 ${moduleRel} 的文件清单`, body: lines.join('\n') },
    { title: '模块内已有的说明文档', body: filesOf(abs).length ? listMarkdown(abs).join('\n') : '' },
  ]);
}

/** 模块内的 markdown 文件（不含要生成的 CLAUDE.md 本身） */
function listMarkdown(abs) {
  try {
    return fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.md$/i.test(e.name) && e.name !== 'CLAUDE.md')
      .map((e) => e.name);
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: 在本仓库上手跑一次，肉眼确认事实包内容可用**

```bash
node -e "import('./src/features/project-optimize/map-facts.js').then(async (m) => { console.log('===ROOT==='); console.log(m.collectRootFacts(process.cwd()).slice(0, 2500)); console.log('===MODULE==='); console.log(m.collectModuleFacts(process.cwd(), 'src/features/project-optimize').slice(0, 2500)); })"
```

预期：根事实包含目录树、npm scripts、最近提交；模块事实包每行形如 `- describe-skill.js（327 行）　职责：rules → skill 降级时生成 skill 的 description 字段。｜导出：outlineOf, fallbackDescription, ...`。若「职责」大面积为空，说明 `headComment` 的正则与本仓库注释风格不符，回 Task 5 修正。

---

## Task 7: 生成 prompt 与质量闸

**Files:**
- Create: `src/features/project-optimize/gen-map.logic.js`
- Test: `src/features/project-optimize/gen-map.logic.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/features/project-optimize/gen-map.logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRootMapPrompt, buildModuleMapPrompt, buildStaleAuditPrompt,
  validateRootMap, validateModuleMap, validateStaleFindings, MAP_SYSTEM_PROMPT,
} from './gen-map.logic.js';

// ---------- prompt ----------

test('根地图 prompt 含事实包、三项必写内容与 JSON 输出约定', () => {
  const p = buildRootMapPrompt('### 目录结构\n\nsrc/');
  assert.ok(p.includes('### 目录结构'));
  assert.ok(p.includes('项目定位'));
  assert.ok(p.includes('常用命令'));
  assert.ok(p.includes('模块路由表'));
  assert.ok(p.includes('{"markdown":'), '必须要求返回 JSON 对象');
  assert.ok(p.includes('200'), '必须写明行数上限');
});

test('模块地图 prompt 带上模块路径', () => {
  const p = buildModuleMapPrompt('src/features', '### 文件清单\n\n- a.js');
  assert.ok(p.includes('src/features'));
  assert.ok(p.includes('- a.js'));
  assert.ok(p.includes('{"markdown":'));
});

test('核对 prompt 要求只报差异、不要重写地图', () => {
  // 这是 M3「只追加不覆盖」承诺在提示词层的落点
  const p = buildStaleAuditPrompt('src/a/CLAUDE.md', '# 旧地图', '### 文件清单');
  assert.ok(p.includes('# 旧地图'));
  assert.ok(p.includes('{"findings":'));
  assert.ok(/不要重写|不需要重写|只列/.test(p));
});

test('系统提示词声明只读，禁止写入', () => {
  assert.ok(/只(能)?读|禁止写入/.test(MAP_SYSTEM_PROMPT.custom));
  assert.equal(MAP_SYSTEM_PROMPT.type, 'custom');
});

// ---------- validateRootMap ----------

const goodRoot = ['# 某项目', '', '## 项目定位', '', '一个做 X 的工具。', '',
  '## 常用命令', '', '- `npm test` 跑测试', '', '## 模块路由表', '', '| 模块 | 职责 |', '| --- | --- |',
  '| `src/a/` | 干 A |'].join('\n');

test('合格的根地图通过质量闸', () => {
  assert.equal(validateRootMap(goodRoot).ok, true);
});

test('太短的产出被拒', () => {
  // 写一份糊弄的地图比不写更糟：M1/M2 不再报缺失、分数上涨，而内容是错的，
  // 之后每一次会话都会被它误导
  const out = validateRootMap('# 项目\n\n没了。');
  assert.equal(out.ok, false);
  assert.match(out.reason, /过短/);
});

test('缺「命令」相关内容的根地图被拒', () => {
  const out = validateRootMap(goodRoot.replace('## 常用命令', '## 别的东西').replace('- `npm test` 跑测试', '- 无关内容'.repeat(20)));
  assert.equal(out.ok, false);
  assert.match(out.reason, /命令/);
});

test('缺「模块」相关内容的根地图被拒', () => {
  const out = validateRootMap(goodRoot.replace('## 模块路由表', '## 杂项').replace('| 模块 | 职责 |', '| 甲 | 乙 |'));
  assert.equal(out.ok, false);
  assert.match(out.reason, /模块/);
});

test('超过 200 行的根地图被拒', () => {
  // 刚生成就撞上 M5 的阈值，等于生产一个新问题来换旧问题
  const out = validateRootMap(goodRoot + '\n' + '- 填充行\n'.repeat(210));
  assert.equal(out.ok, false);
  assert.match(out.reason, /200/);
});

test('非字符串输入被拒而不抛错', () => {
  for (const bad of [null, undefined, 42, {}]) assert.equal(validateRootMap(bad).ok, false);
});

// ---------- validateModuleMap ----------

test('合格的模块地图通过', () => {
  const md = ['# src/features', '', '## 文件清单', '', '- `a.js` 干 A', '',
    '## 关键流程', '', '调 a 再调 b。', '', '## 常见改动入口', '', '改 X 去 `a.js`。'].join('\n');
  assert.equal(validateModuleMap(md).ok, true);
});

test('只有文件清单、没有流程与改动入口的模块地图被拒', () => {
  // 这正是「纯事实包零工具」方案会产出的东西——ls 的复述，对导航没有增量价值
  const md = ['# src/features', '', '## 文件清单', '', ...Array.from({ length: 30 }, (_, i) => `- \`f${i}.js\` 是第 ${i} 个文件`)].join('\n');
  const out = validateModuleMap(md);
  assert.equal(out.ok, false);
  assert.match(out.reason, /流程|改动入口/);
});

// ---------- validateStaleFindings ----------

test('findings 数组被规整成字符串列表', () => {
  const out = validateStaleFindings(['  条目一  ', '条目二', '', null]);
  assert.equal(out.ok, true);
  assert.deepEqual(out.findings, ['条目一', '条目二']);
});

test('空数组是合法结果（核对过、没发现差异）', () => {
  const out = validateStaleFindings([]);
  assert.equal(out.ok, true);
  assert.deepEqual(out.findings, []);
});

test('非数组被拒', () => {
  assert.equal(validateStaleFindings('一条文本').ok, false);
  assert.equal(validateStaleFindings(null).ok, false);
});

test('条目过多时截断并保留说明', () => {
  const out = validateStaleFindings(Array.from({ length: 50 }, (_, i) => `第 ${i} 条`));
  assert.equal(out.ok, true);
  assert.equal(out.findings.length, 20);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/features/project-optimize/gen-map.logic.test.js
```

预期：`Cannot find module './gen-map.logic.js'`

- [ ] **Step 3: 写实现**

创建 `src/features/project-optimize/gen-map.logic.js`：

```js
/**
 * 地图生成的纯逻辑：prompt 构造与产出质量闸。
 *
 * ## 质量闸为什么必须存在
 *
 * 这里的失败模式和 describe-skill.js:6-8 是同一个：写一份糊弄的地图，
 * M1/M2 不再报缺失、map 分数上涨，**而地图内容是错的**。分数变好、实际变差，
 * 没有任何自动信号能发现。而地图比 skill description 更糟一层——
 * description 写砸只是让一份规范唤不起来，地图写砸会**主动误导之后的每一次会话**。
 *
 * 所以判据是「宁可不生成」：闸没过就不写文件、进 blocked 列表让用户看到，
 * 而不是写一个半成品上去。
 */

/** 根地图行数上限，对齐 check-map.logic.js:164-175 的 M5 阈值——刚生成就超标等于用新问题换旧问题 */
const ROOT_MAX_LINES = 200;
/** 判「模型这次没写出东西」的最短长度：三个小节的地图不可能短于此 */
const MIN_MAP_LEN = 200;
/** 核对条目上限：超过这个数说明地图已经全面失效，该重写而不是打补丁，列再多也没人看 */
const MAX_FINDINGS = 20;

/**
 * 系统提示词。
 *
 * 「你只能读」这一句是只读沙箱的第 4 层（软约束）。前三层硬闸在
 * llm-readonly-agent.js 里，这里的作用是掐掉「我先写个文件试试」这个念头本身——
 * 模型每试一次都要吃掉一轮 maxTurns，而它注定会被 canUseTool 拒掉。
 */
export const MAP_SYSTEM_PROMPT = {
  type: 'custom',
  custom:
    '你在为一个代码仓库撰写 CLAUDE.md 项目地图。这份地图会被 AI 在每次会话开始时读取，'
    + '用来快速定位「要改的东西在哪」。\n'
    + '你只能读取文件（Read/Grep/Glob），禁止写入、修改或执行任何东西——'
    + '写入请求会被拒绝，白白浪费你的轮次。生成的内容通过你的最终回复交出去即可。\n'
    + '写作要求：具体、可验证、不写空话。宁可少写一条，也不要写你没有读到证据的内容。\n'
    + '只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码围栏。',
};

/** 两个 prompt 共用的收尾约定，避免重复（DRY） */
function jsonTail(field) {
  return [
    '',
    '## 输出格式',
    '',
    `严格输出一个 JSON 对象（${field} 是字段，不要直接输出字符串）：`,
    `{"${field}":"...完整的 markdown 正文..."}`,
    '注意 markdown 里的换行要写成 \\n，引号要转义。',
  ];
}

/**
 * 根地图 prompt。
 *
 * 三项必写内容直接对齐 check-map.logic.js:107 的 M1 fixHint
 * （「项目定位 + 常用命令 + 模块路由表」）——检测器说缺什么，生成端就补什么，
 * 两边对不上的话会出现「生成完了，体检还在报同一个问题」。
 */
export function buildRootMapPrompt(factText) {
  return [
    '请为这个仓库写一份根 `CLAUDE.md` 项目地图。',
    '',
    '下面「已知事实」是程序扫描出来的，**可以直接采信**。',
    '你还有 Read/Grep/Glob 工具，请用它们读关键入口文件，补充事实包里看不出来的部分——',
    '尤其是「这个项目是干什么的」和「改动通常从哪里下手」。',
    '',
    '## 必须包含的三部分',
    '',
    '1. **项目定位**：一两句话说清这个项目是什么、解决什么问题。',
    '2. **常用命令**：怎么跑、怎么测、怎么构建。命令要从事实包的 scripts 里取，不要杜撰。',
    '3. **模块路由表**：表格形式，列出主要模块目录及其职责，让人一眼看出「要改 X 该去哪个目录」。',
    '   已有模块地图的，路由表里要指向那份地图。',
    '',
    '## 硬约束',
    '',
    `- 总长度不超过 ${ROOT_MAX_LINES} 行。这是官方建议值，超了会挤占上下文并降低遵循度。`,
    '- 只写你有证据的内容。没读到的不要猜，宁可不写这一条。',
    '- 不要写「本文档介绍了……」这类摘要腔，直接给信息。',
    '- 引用文件/目录路径时用反引号包裹，且必须是真实存在的路径。',
    ...jsonTail('markdown'),
    '',
    '## 已知事实',
    '',
    factText || '（扫描未产出事实，请完全依靠工具自行探索）',
  ].join('\n');
}

/**
 * 模块地图 prompt。
 *
 * 三项必写内容对齐 check-map.logic.js:129 的 M2 fixHint
 * （「文件清单 + 关键流程 + 常见改动入口」）。
 *
 * 后两项是这份地图存在的全部理由：文件清单机器自己就能列，
 * 而「关键流程」和「改动入口」必须读懂代码才写得出来——
 * 这也正是本方案给模型只读工具、而不是纯事实包单轮生成的原因。
 */
export function buildModuleMapPrompt(moduleRel, factText) {
  return [
    `请为模块 \`${moduleRel}\` 写一份 \`CLAUDE.md\` 模块地图。`,
    '',
    '下面「已知事实」是程序扫描出来的，**可以直接采信**。',
    '文件清单和导出符号已经给全了，你要用 Read/Grep/Glob 去读代码，',
    '补出事实包里没有的那两部分——它们才是这份地图存在的理由。',
    '',
    '## 必须包含的三部分',
    '',
    '1. **文件清单**：每个文件一行，说清它负责什么。可以直接用事实包里的职责摘要。',
    '2. **关键流程**：这个模块的主要执行路径是什么，数据/控制从哪个文件流到哪个文件。',
    '   这一部分必须读代码才写得出来，不要拿文件清单敷衍。',
    '3. **常见改动入口**：想改 X 应该从哪个文件下手。用「要做……就改……」的句式。',
    '',
    '## 硬约束',
    '',
    '- 只写你有证据的内容。没读到的不要猜。',
    '- 引用文件路径时用反引号包裹，路径要相对模块目录或仓库根，且必须真实存在。',
    '- 不要复述代码，写代码里看不出来的判断（为什么这么分层、哪个文件是入口）。',
    ...jsonTail('markdown'),
    '',
    '## 已知事实',
    '',
    factText || '（扫描未产出事实，请完全依靠工具自行探索）',
  ].join('\n');
}

/**
 * 过期地图的差异核对 prompt。
 *
 * 反复强调「不要重写」是必要的：模型看到一份过期文档的本能就是给你一份新的。
 * 而 M3 的全部承诺就是不覆盖人写的内容——提示词这一层拦不住的话，
 * 就要靠调用方丢弃整个产出，白烧一次额度。
 */
export function buildStaleAuditPrompt(mapRel, mapBody, factText) {
  return [
    `\`${mapRel}\` 这份地图比代码旧。请核对它与当前代码的差异。`,
    '',
    '**你的任务只是列出差异，不是重写地图。**',
    '不要输出新版地图，不要给修改建议的完整文本——只列出「地图里写的和代码现状对不上」的具体条目。',
    '',
    '## 重点核对',
    '',
    '- 地图里提到的文件/目录，现在还存在吗？',
    '- 地图描述的流程，和代码里的实际调用顺序一致吗？',
    '- 模块里新增了重要文件，但地图没收录吗？',
    '',
    '## 硬约束',
    '',
    '- 每条差异一句话说清，带上具体文件路径（反引号包裹）。',
    '- 只报你用工具读过、确认过的差异。拿不准的不要写——',
    '  误报会让人去改一个本来正确的地方。',
    `- 最多 ${MAX_FINDINGS} 条。没发现差异就返回空数组，这是完全正常的结果。`,
    '',
    '## 输出格式',
    '',
    '严格输出一个 JSON 对象：',
    '{"findings":["第一条差异","第二条差异"]}',
    '',
    '## 地图当前内容',
    '',
    mapBody || '（地图为空）',
    '',
    '## 程序扫描出的模块现状',
    '',
    factText || '（扫描未产出事实）',
  ].join('\n');
}

/** 质量闸的统一失败构造 */
const bad = (reason) => ({ ok: false, reason });

/** 两个 validate 共用的基础检查：类型与长度 */
function baseCheck(md) {
  if (typeof md !== 'string') return bad('产出不是字符串');
  const text = md.trim();
  if (text.length < MIN_MAP_LEN) return bad(`产出过短（${text.length} 字符），判定为模型未按要求生成`);
  return null;
}

/**
 * 根地图质量闸。
 *
 * 小节判定用宽松的关键词匹配而不是严格的标题结构：模型可能写「## 怎么跑起来」
 * 而不是「## 常用命令」，语义对了就该放行。卡格式只会把合格产出误杀。
 */
export function validateRootMap(md) {
  const base = baseCheck(md);
  if (base) return base;
  const text = md.trim();

  const lines = text.split('\n').length;
  if (lines > ROOT_MAX_LINES) {
    return bad(`产出 ${lines} 行，超过 ${ROOT_MAX_LINES} 行上限（刚生成就会被体检判为 M5 超长）`);
  }
  if (!/命令|scripts|npm |yarn |pnpm |怎么跑|运行|启动|构建/i.test(text)) {
    return bad('产出缺少「常用命令」相关内容');
  }
  if (!/模块|目录|结构|路由|架构/.test(text)) {
    return bad('产出缺少「模块路由表」相关内容');
  }
  return { ok: true, reason: '' };
}

/**
 * 模块地图质量闸。
 *
 * 「关键流程 / 改动入口」是硬性要求：没有这两部分的模块地图就是 `ls` 的复述，
 * 而文件清单机器自己就能列——不值得为它花一次 LLM 调用，更不值得让它去
 * 消掉一条 M2 告警（消掉之后就再没人提醒这个模块缺真正有用的地图了）。
 */
export function validateModuleMap(md) {
  const base = baseCheck(md);
  if (base) return base;
  const text = md.trim();

  if (!/流程|调用|执行路径|数据流|时序/.test(text)) {
    return bad('产出缺少「关键流程」相关内容，只有文件清单的地图没有导航价值');
  }
  if (!/改动|修改|入口|要做|新增.*去|从.*下手/.test(text)) {
    return bad('产出缺少「常见改动入口」相关内容');
  }
  return { ok: true, reason: '' };
}

/**
 * 核对结果的规整。
 *
 * 空数组是**合法**结果：核对过、确实没发现差异。把它判成失败会让
 * 「地图其实还准」这种好情况走进错误分支。
 *
 * @param {unknown} findings
 * @returns {{ok:boolean, findings:string[], reason:string}}
 */
export function validateStaleFindings(findings) {
  if (!Array.isArray(findings)) return { ok: false, findings: [], reason: 'findings 不是数组' };
  const list = findings
    .map((f) => String(f ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_FINDINGS);
  return { ok: true, findings: list, reason: '' };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/features/project-optimize/gen-map.logic.test.js
```

预期：`pass 17`、`fail 0`

---

## Task 8: 地图生成执行层

**Files:**
- Create: `src/features/project-optimize/gen-map.js`

- [ ] **Step 1: 写实现**

创建 `src/features/project-optimize/gen-map.js`：

```js
/**
 * 地图生成执行层：事实包 → 只读沙箱 → 质量闸 → 交出正文。
 *
 * **本模块不写任何文件**，只返回文本。写盘归 fix-map.js。
 * 这个分工是只读沙箱设计的直接推论：模型没有写工具，产出必然要经过 Node 的手，
 * 而经过 Node 的手就意味着备份、幂等、质量闸三件事都能在写盘前统一把关。
 *
 * 从不抛错：调用方处在优化流程中途，一切失败通过返回值的 ok/reason 表达。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runReadonlyAgent } from '../llm-readonly-agent.js';
import { logger } from '../../shared/logger.js';
import { collectRootFacts, collectModuleFacts } from './map-facts.js';
import {
  MAP_SYSTEM_PROMPT, buildRootMapPrompt, buildModuleMapPrompt, buildStaleAuditPrompt,
  validateRootMap, validateModuleMap, validateStaleFindings,
} from './gen-map.logic.js';

/**
 * 失败原因转中文说法。
 *
 * 分开归因的理由同 llm-classify.js:65-70 记录的事故：那次把「超时」说成「没听懂」，
 * 用户一遍遍改说法而毫无用处。这里同理——「额度耗尽」要用户去换账号，
 * 「模型没按格式返回」要用户重试，两者混为一谈会把人引进死路。
 */
const REASON_TEXT = {
  exhausted: 'token 池额度耗尽，未发起生成',
  cancelled: '用户取消了优化',
  timeout: '生成超时',
  unparsable: '模型未按要求返回 JSON',
};

const failed = (reason) => ({ ok: false, markdown: '', reason });

/**
 * 跑一次生成并做质量闸。三种失败——调用失败 / 字段缺失 / 闸没过——都归一成 {ok:false}。
 *
 * @param {object} args
 * @param {string} args.field 期望的 JSON 字段名
 * @param {(v:unknown)=>{ok:boolean,reason:string}} args.validate
 */
async function generateAndValidate({ prompt, cwd, logTag, signal, field, validate }) {
  const { data, reason, denied } = await runReadonlyAgent({
    prompt, cwd, logTag, signal, systemPrompt: MAP_SYSTEM_PROMPT,
  });

  // 模型试图越权时留一条日志：不影响结果（已被拦下），但能让「为什么这次生成质量差」
  // 有据可查——它可能把轮次都耗在被拒的写入尝试上了
  if (denied?.length) {
    logger.warn('gen-map', '模型尝试调用非只读工具（已拦截）', { logTag, tools: [...new Set(denied)] });
  }

  if (!data) return { ok: false, value: null, reason: REASON_TEXT[reason] || '生成失败' };

  const value = data[field];
  const v = validate(value);
  if (!v.ok) {
    // 质量闸拦下的产出要留证据：闸的判据可能需要按真实项目调整，
    // 只记「被拒了」而不记内容的话，事后无从判断是模型的问题还是判据太严
    logger.warn('gen-map', '产出未通过质量闸，不写文件', {
      logTag, reason: v.reason, preview: String(value ?? '').slice(0, 200),
    });
    return { ok: false, value: null, reason: v.reason };
  }
  return { ok: true, value, reason: '' };
}

/**
 * 生成根 CLAUDE.md 正文。
 *
 * @param {string} projectDir
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok:boolean, markdown:string, reason:string}>}
 */
export async function generateRootMap(projectDir, { signal } = {}) {
  const facts = collectRootFacts(projectDir);
  const out = await generateAndValidate({
    prompt: buildRootMapPrompt(facts),
    cwd: projectDir,
    logTag: 'optimize/map:root',
    signal,
    field: 'markdown',
    validate: validateRootMap,
  });
  return out.ok ? { ok: true, markdown: out.value.trim(), reason: '' } : failed(out.reason);
}

/**
 * 生成模块 CLAUDE.md 正文。
 *
 * @param {string} moduleRel 形如 'src/features'
 */
export async function generateModuleMap(projectDir, moduleRel, { signal } = {}) {
  const facts = collectModuleFacts(projectDir, moduleRel);
  const out = await generateAndValidate({
    prompt: buildModuleMapPrompt(moduleRel, facts),
    cwd: projectDir,
    logTag: `optimize/map:${moduleRel}`,
    signal,
    field: 'markdown',
    validate: validateModuleMap,
  });
  return out.ok ? { ok: true, markdown: out.value.trim(), reason: '' } : failed(out.reason);
}

/**
 * 核对一份过期地图，产出差异条目（不产出新地图正文）。
 *
 * @param {string} mapRel 地图相对路径，如 'src/a/CLAUDE.md'
 * @returns {Promise<{ok:boolean, findings:string[], reason:string}>}
 */
export async function generateStaleFindings(projectDir, mapRel, { signal } = {}) {
  let body = '';
  try {
    body = fs.readFileSync(path.join(projectDir, mapRel), 'utf8');
  } catch (e) {
    return { ok: false, findings: [], reason: `读不到地图文件：${e?.message || String(e)}` };
  }

  const moduleRel = path.dirname(mapRel).replace(/\\/g, '/');
  const facts = moduleRel === '.' ? collectRootFacts(projectDir) : collectModuleFacts(projectDir, moduleRel);

  const { data, reason, denied } = await runReadonlyAgent({
    prompt: buildStaleAuditPrompt(mapRel, body, facts),
    cwd: projectDir,
    logTag: `optimize/stale:${mapRel}`,
    signal,
    systemPrompt: MAP_SYSTEM_PROMPT,
  });
  if (denied?.length) {
    logger.warn('gen-map', '模型尝试调用非只读工具（已拦截）', { logTag: mapRel, tools: [...new Set(denied)] });
  }
  if (!data) return { ok: false, findings: [], reason: REASON_TEXT[reason] || '核对失败' };

  const v = validateStaleFindings(data.findings);
  if (!v.ok) return { ok: false, findings: [], reason: v.reason };
  return { ok: true, findings: v.findings, reason: '' };
}
```

- [ ] **Step 2: 确认模块能加载**

```bash
node -e "import('./src/features/project-optimize/gen-map.js').then((m) => console.log('OK', Object.keys(m)))"
```

预期：`OK [ 'generateRootMap', 'generateModuleMap', 'generateStaleFindings' ]`

---

## Task 9: M1~M4 写盘执行层

**Files:**
- Create: `src/features/project-optimize/fix-map.js`
- Test: `src/features/project-optimize/fix-map.fs.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/features/project-optimize/fix-map.fs.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixDeadLinks, writeGeneratedMap, writeStaleAudit } from './fix-map.js';

/** 造一个临时项目目录；返回绝对路径 */
function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixmap-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

// ---------- fixDeadLinks ----------

test('唯一命中的死链被改写', () => {
  const dir = tmpProject({
    'CLAUDE.md': '# 图\n\n入口见 `src/old/foo.js`。\n',
    'src/a/foo.js': '// 真身',
  });
  const out = fixDeadLinks(dir, [{ file: 'CLAUDE.md', line: 3, ref: 'src/old/foo.js' }]);
  assert.equal(out.updated.length, 1);
  assert.equal(out.updated[0].to, 'src/a/foo.js');
  assert.ok(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').includes('`src/a/foo.js`'));
});

test('无候选的死链原样不动', () => {
  // CDN 资源引用落在这条分支上，见 check-map.logic.js:55-57
  const before = '# 图\n\n图标 `static/cdn/icon.webp`。\n';
  const dir = tmpProject({ 'CLAUDE.md': before, 'src/a/foo.js': '' });
  const out = fixDeadLinks(dir, [{ file: 'CLAUDE.md', line: 3, ref: 'static/cdn/icon.webp' }]);
  assert.equal(out.updated.length, 0);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /没有找到/);
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), before);
});

test('多候选的死链原样不动并列出候选', () => {
  const before = '# 图\n\n见 `src/old/index.js`。\n';
  const dir = tmpProject({ 'CLAUDE.md': before, 'src/a/index.js': '', 'src/b/index.js': '' });
  const out = fixDeadLinks(dir, [{ file: 'CLAUDE.md', line: 3, ref: 'src/old/index.js' }]);
  assert.equal(out.updated.length, 0);
  assert.match(out.skipped[0].reason, /多个候选/);
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), before);
});

test('行号漂移时跳过而不是改错行', () => {
  // 体检和优化之间文件被人改过，报告里的行号会失效。
  // 认行号不认内容的话，会把无关的一行改坏
  const before = '# 图\n\n新插入的一行\n\n入口见 `src/old/foo.js`。\n';
  const dir = tmpProject({ 'CLAUDE.md': before, 'src/a/foo.js': '' });
  const out = fixDeadLinks(dir, [{ file: 'CLAUDE.md', line: 3, ref: 'src/old/foo.js' }]);
  assert.equal(out.updated.length, 1, '内容匹配兜底应该在别的行找到它');
  assert.ok(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').includes('`src/a/foo.js`'));
});

test('同一文件的多条死链一次写盘', () => {
  const dir = tmpProject({
    'CLAUDE.md': '`src/old/foo.js` 和 `src/old/bar.js`\n',
    'src/a/foo.js': '', 'src/b/bar.js': '',
  });
  const out = fixDeadLinks(dir, [
    { file: 'CLAUDE.md', line: 1, ref: 'src/old/foo.js' },
    { file: 'CLAUDE.md', line: 1, ref: 'src/old/bar.js' },
  ]);
  assert.equal(out.updated.length, 2);
  const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(md.includes('`src/a/foo.js`') && md.includes('`src/b/bar.js`'));
});

test('读不到的文件进 skipped 而不抛错', () => {
  const dir = tmpProject({ 'src/a/foo.js': '' });
  const out = fixDeadLinks(dir, [{ file: '不存在.md', line: 1, ref: 'src/old/foo.js' }]);
  assert.equal(out.updated.length, 0);
  assert.equal(out.skipped.length, 1);
});

// ---------- writeGeneratedMap ----------

test('生成的地图写到指定路径', async () => {
  const dir = tmpProject({});
  const r = await writeGeneratedMap(dir, 'CLAUDE.md', async () => ({ ok: true, markdown: '# 新地图\n\n正文', reason: '' }));
  assert.equal(r.status, 'done');
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# 新地图\n\n正文\n');
});

test('已存在的地图不被覆盖', async () => {
  // 覆盖用户手写的地图是不可逆的内容丢失，而跳过的代价只是这一条没优化成
  const dir = tmpProject({ 'CLAUDE.md': '# 人写的\n' });
  const r = await writeGeneratedMap(dir, 'CLAUDE.md', async () => ({ ok: true, markdown: '# 机器写的', reason: '' }));
  assert.equal(r.status, 'skipped');
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# 人写的\n');
});

test('生成失败时一个字节都不写', async () => {
  // 半成品地图比没有地图更糟：M2 不再报缺失、分数上涨，而内容是错的
  const dir = tmpProject({});
  const r = await writeGeneratedMap(dir, 'src/a/CLAUDE.md', async () => ({ ok: false, markdown: '', reason: '生成超时' }));
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /生成超时/);
  assert.equal(fs.existsSync(path.join(dir, 'src/a/CLAUDE.md')), false);
});

test('生成器抛错被兜住，不写文件也不向上抛', async () => {
  const dir = tmpProject({});
  const r = await writeGeneratedMap(dir, 'CLAUDE.md', async () => { throw new Error('boom'); });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /boom/);
  assert.equal(fs.existsSync(path.join(dir, 'CLAUDE.md')), false);
});

// ---------- writeStaleAudit ----------

test('核对块追加到过期地图末尾，正文保留', async () => {
  const dir = tmpProject({ 'src/a/CLAUDE.md': '# 图\n\n人写的踩坑记录。\n' });
  const r = await writeStaleAudit(dir, 'src/a/CLAUDE.md', 23, {
    generate: async () => ({ ok: true, findings: ['`src/a/gone.js` 已不存在'], reason: '' }),
    date: '2026-08-27',
  });
  assert.equal(r.status, 'done');
  const md = fs.readFileSync(path.join(dir, 'src/a/CLAUDE.md'), 'utf8');
  assert.ok(md.includes('人写的踩坑记录。'));
  assert.ok(md.includes('## ⚠️ 自动核对（2026-08-27）'));
  assert.ok(md.includes('`src/a/gone.js` 已不存在'));
});

test('核对失败时不写文件', async () => {
  const before = '# 图\n\n正文\n';
  const dir = tmpProject({ 'src/a/CLAUDE.md': before });
  const r = await writeStaleAudit(dir, 'src/a/CLAUDE.md', 23, {
    generate: async () => ({ ok: false, findings: [], reason: '生成超时' }),
    date: '2026-08-27',
  });
  assert.equal(r.status, 'failed');
  assert.equal(fs.readFileSync(path.join(dir, 'src/a/CLAUDE.md'), 'utf8'), before);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/features/project-optimize/fix-map.fs.test.js
```

预期：`Cannot find module './fix-map.js'`

- [ ] **Step 3: 写实现**

创建 `src/features/project-optimize/fix-map.js`：

```js
/**
 * 维度① 地图修复的执行层：写盘那一半。
 *
 * 三条纪律，与 fix-rules.js 一致：
 *
 * 1. **计划先于动作**：planMapFix（在 fix-map.logic.js）必须在任何写操作之前跑完，
 *    结果交给 createBackup 打快照。
 * 2. **从不抛异常**：一切通过返回值的 status/reason 表达。上层是循环，
 *    一次抛错会把整批停在半路。
 * 3. **绝不覆盖已有内容**：新建类操作遇到已存在的文件一律跳过；
 *    追加类操作只动自己的锚点块。
 *
 * 比 fix-rules 少一条「失败分级」：本模块的所有操作都是**单文件独立**的
 * （写一份地图、改一行引用），任何一个失败都不会让文件系统进入半完成状态，
 * 因此没有 fatal 的概念，一条失败不影响其余条目继续。
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../shared/logger.js';
import { resolveDeadLinkTarget, rewriteRefInLine, upsertStaleAudit } from './fix-map.logic.js';
import { generateStaleFindings } from './gen-map.js';

const msgOf = (e) => e?.message || String(e);

/**
 * 建立仓库内所有文件和目录的相对路径索引。
 *
 * 与 check-map.js 的 buildPathIndex 同一套口径（含点目录，因为地图会引用 `.claude/`），
 * 但那个函数没有导出。**不要为了复用去改动检测器**——它已定型且被 28 条测试钉住，
 * 而这里只是 20 行的目录遍历，复制一份的成本远低于动它的风险。
 */
function buildPathIndex(projectDir) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'worktrees']);
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
    }
  };
  walk(projectDir, '');
  return out;
}

/**
 * 修复死链：确定性重写，不调 LLM。
 *
 * 定位策略是「**先认报告给的行号，认不上就全文找**」。
 * 只认行号不行：体检和优化之间文件可能被改过，行号会漂，照着漂了的行号改会改坏无关内容。
 * 只全文找也不行：同一条引用可能在多处出现，行号能帮我们优先命中报告实际检出的那处。
 * 两者结合的关键是：**任何时候都以「这一行确实含有该字面量」为准**——
 * rewriteRefInLine 匹配不到就返回 null，这是唯一的放行条件。
 *
 * @param {string} projectDir
 * @param {Array<{file:string, line:number, ref:string}>} deadLinks
 * @returns {{updated:Array<{file:string,from:string,to:string}>, skipped:Array<{file:string,ref:string,reason:string}>}}
 */
export function fixDeadLinks(projectDir, deadLinks) {
  const updated = [];
  const skipped = [];
  const list = Array.isArray(deadLinks) ? deadLinks : [];
  if (!list.length) return { updated, skipped };

  const pathIndex = buildPathIndex(projectDir);

  // 按文件分组：同一份地图里的多条死链一次读、一次写，避免 N 次读写和中途状态不一致
  const byFile = new Map();
  for (const dl of list) {
    if (!byFile.has(dl.file)) byFile.set(dl.file, []);
    byFile.get(dl.file).push(dl);
  }

  for (const [rel, items] of byFile) {
    const abs = path.join(projectDir, rel);
    let raw;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      for (const it of items) skipped.push({ file: rel, ref: it.ref, reason: `读不到文件：${msgOf(e)}` });
      continue;
    }

    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    let dirty = false;

    for (const it of items) {
      const target = resolveDeadLinkTarget(it.ref, pathIndex);
      if (target.status === 'none') {
        skipped.push({ file: rel, ref: it.ref, reason: '仓库里没有找到同名文件，无法确定正确路径（可能是外部资源引用）' });
        continue;
      }
      if (target.status === 'ambiguous') {
        skipped.push({
          file: rel, ref: it.ref,
          reason: `有多个候选，无法确定改成哪个：${target.candidates.slice(0, 5).join('、')}`,
        });
        continue;
      }

      // 先试报告给的行号（1-based），不中再全文扫
      const idx = Number(it.line) - 1;
      let hit = -1;
      if (idx >= 0 && idx < lines.length && rewriteRefInLine(lines[idx], it.ref, target.target) !== null) {
        hit = idx;
      } else {
        hit = lines.findIndex((l) => rewriteRefInLine(l, it.ref, target.target) !== null);
      }
      if (hit < 0) {
        skipped.push({ file: rel, ref: it.ref, reason: '文件里已找不到这条引用（体检后被改过？）' });
        continue;
      }

      lines[hit] = rewriteRefInLine(lines[hit], it.ref, target.target);
      updated.push({ file: rel, from: it.ref, to: target.target });
      dirty = true;
    }

    if (!dirty) continue;
    try {
      fs.writeFileSync(abs, lines.join('\n'), 'utf8');
    } catch (e) {
      // 写失败要把这一批已记进 updated 的条目撤回来——它们并没有真的落盘，
      // 留在 updated 里就是在向用户谎报成功
      for (let i = updated.length - 1; i >= 0; i--) {
        if (updated[i].file !== rel) continue;
        skipped.push({ file: rel, ref: updated[i].from, reason: `写入失败：${msgOf(e)}` });
        updated.splice(i, 1);
      }
      logger.warn('fix-map', '死链修复写盘失败', { file: rel, err: msgOf(e) });
    }
  }

  return { updated, skipped };
}

/**
 * 写一份新生成的地图（M1 / M2 共用）。
 *
 * @param {string} projectDir
 * @param {string} rel 目标相对路径，如 'CLAUDE.md' 或 'src/a/CLAUDE.md'
 * @param {() => Promise<{ok:boolean, markdown:string, reason:string}>} generate
 *   生成器。单测注入桩件——否则每跑一次测试就是一次真实 LLM 调用，
 *   又慢又花钱，而这一层要验的是写盘流程不是文案质量
 * @returns {Promise<{file:string, kind:string, status:'done'|'skipped'|'failed', reason:string}>}
 */
export async function writeGeneratedMap(projectDir, rel, generate) {
  const base = { file: rel, kind: 'gen-map', reason: '' };
  const abs = path.join(projectDir, rel);

  // 已存在一律不覆盖：那可能是用户手写的地图，覆盖是不可逆的内容丢失，
  // 而跳过的代价只是这一条没优化成（同 fix-rules.js:148-152 的取舍）
  if (fs.existsSync(abs)) {
    return { ...base, status: 'skipped', reason: `${rel} 已存在，未覆盖` };
  }

  let out;
  try {
    out = await generate();
  } catch (e) {
    return { ...base, status: 'failed', reason: `生成异常：${msgOf(e)}` };
  }

  // 闸没过就一个字节都不写。写半成品会让 M1/M2 不再报缺失、分数上涨，
  // 而地图内容是错的——之后每一次会话都会被它误导（见 gen-map.logic.js 开头）
  if (!out?.ok || !out.markdown) {
    return { ...base, status: 'failed', reason: out?.reason || '生成失败' };
  }

  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${out.markdown.trimEnd()}\n`, 'utf8');
  } catch (e) {
    return { ...base, status: 'failed', reason: `写入失败：${msgOf(e)}` };
  }

  return { ...base, status: 'done' };
}

/**
 * 给一份过期地图追加「自动核对」块（M3）。
 *
 * ⚠️ 这次写入会刷新地图 mtime，从而让 check-map.js:107 判定的 staleDays 归零——
 * 下次体检不再报 M3、map 分数还会涨，**但地图正文并没有变新鲜**。
 * 这是「只追加不覆盖」这个选择的必然代价，应对是两条：
 * 追加块自带日期且足够醒目（upsertStaleAudit 负责），
 * 以及编排层在优化结果里显式告知用户（buildFixNotes 负责）。
 * 两条都别删。
 *
 * @param {string} projectDir
 * @param {string} rel 地图相对路径
 * @param {number} staleDays
 * @param {object} [opts]
 * @param {(dir:string, rel:string)=>Promise<{ok:boolean,findings:string[],reason:string}>} [opts.generate]
 * @param {string} [opts.date] 写进块标题的日期（注入以便测试）
 * @param {AbortSignal} [opts.signal]
 */
export async function writeStaleAudit(projectDir, rel, staleDays, { generate, date, signal } = {}) {
  const base = { file: rel, kind: 'stale-audit', reason: '' };
  const abs = path.join(projectDir, rel);

  const run = generate || ((d, r) => generateStaleFindings(d, r, { signal }));
  let out;
  try {
    out = await run(projectDir, rel);
  } catch (e) {
    return { ...base, status: 'failed', reason: `核对异常：${msgOf(e)}` };
  }
  if (!out?.ok) return { ...base, status: 'failed', reason: out?.reason || '核对失败' };

  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { ...base, status: 'failed', reason: `读不到地图文件：${msgOf(e)}` };
  }

  try {
    const stamp = date || new Date().toISOString().slice(0, 10);
    fs.writeFileSync(abs, upsertStaleAudit(raw, { date: stamp, staleDays, findings: out.findings }), 'utf8');
  } catch (e) {
    return { ...base, status: 'failed', reason: `写入失败：${msgOf(e)}` };
  }

  return { ...base, status: 'done', reason: out.findings.length ? `记录了 ${out.findings.length} 条差异` : '未发现明显差异' };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/features/project-optimize/fix-map.fs.test.js
```

预期：`pass 12`、`fail 0`

---

## Task 10: fix-plan.logic.js 扩展

**Files:**
- Modify: `src/features/project-optimize/fix-plan.logic.js`
- Test: `src/features/project-optimize/fix-plan.logic.test.js`

- [ ] **Step 1: 写失败测试**

在 `src/features/project-optimize/fix-plan.logic.test.js` 末尾追加：

```js
test('map 已进入支持的维度', () => {
  assert.ok(SUPPORTED_DIMENSIONS.includes('map'));
  assert.ok(SUPPORTED_DIMENSIONS.includes('rules'));
});

test('只勾 map 时不再提示「暂无自动修复能力」', () => {
  assert.deepEqual(buildFixNotes({ requested: ['map'], results: [] }), []);
});

test('勾了 comments 仍如实提示未处理', () => {
  const notes = buildFixNotes({ requested: ['map', 'comments'], results: [] });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /comments/);
  assert.ok(!/\bmap\b/.test(notes[0]), '已支持的维度不该出现在未处理提示里');
});

test('写过地图文件时提示 mtime 已被刷新', () => {
  // 这是 M3 过期告警会被本次写入清零的唯一提醒。删掉它，用户会把分数上涨
  // 误读成「地图已经更新了」——而地图正文其实一个字都没改
  const notes = buildFixNotes({
    requested: ['map'],
    results: [{ status: 'done', kind: 'stale-audit', file: 'src/a/CLAUDE.md' }],
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /时间戳|新鲜度|过期/);
  assert.match(notes[0], /自动核对/);
});

test('没有地图写入时不产生该提示', () => {
  const notes = buildFixNotes({
    requested: ['map'],
    results: [{ status: 'failed', kind: 'stale-audit', file: 'src/a/CLAUDE.md' }],
  });
  assert.deepEqual(notes, []);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/features/project-optimize/fix-plan.logic.test.js
```

预期：`AssertionError`（`SUPPORTED_DIMENSIONS` 不含 `'map'`）

- [ ] **Step 3: 改实现**

`src/features/project-optimize/fix-plan.logic.js`，第 6-7 行改为：

```js
/**
 * 已具备自动修复能力的维度。
 * 维度④（无用代码）明确不做；②⑤ 是分析类维度，检测器把全部 issue 标成 fixable:false
 * （高危：改提示词/注释要动源码，改错了比不改更误导人），没有自动修法。
 */
export const SUPPORTED_DIMENSIONS = ['rules', 'map'];
```

`buildFixNotes` 整个替换为：

```js
/**
 * 生成「机器做不了、需要你自己动手」的提示。
 *
 * 三条，每条都对应一种「不说就会被误以为已经处理好了」的情况：
 *
 * 1. **勾了不支持的维度**。静默忽略最糟——用户勾了注释维度，看到「优化完成」，
 *    合理地以为注释也处理过了。
 * 2. **根 CLAUDE.md 里还留着旧文件名**。项目地图常有一张「规则文件 | 覆盖范围」的索引表，
 *    表格里写的是裸文件名（`design-system.md`）而不是带目录的路径，
 *    replaceRuleRefs 只认反引号包裹的完整路径，匹配不到它 —— 于是表里留下一行
 *    指向已删除文件的条目。这个改不了自动化：表格的列结构因项目而异，
 *    机器分不清该改成技能名还是整行删掉，只能请用户看一眼。
 * 3. **地图文件被写过，M3 的过期告警会消失**。check-map.js:107 判过期靠
 *    「代码 mtime - 地图 mtime」，而本次写入把地图 mtime 推到了当下 → staleDays 归零 →
 *    下次体检不报 M3、map 分数还涨，**但地图正文并没有变新鲜**。
 *    这正是 describe-skill.js:6-8 警告的「分数变好、实际变差」形状。
 *    追加块自带日期是第一道提醒，这条 note 是第二道——两道都别删。
 *
 * @param {object} [args]
 * @param {string[]} [args.requested] 用户勾选的维度
 * @param {Array<{status:string,file:string,skillName?:string,kind?:string}>} [args.results]
 * @param {string|null} [args.rootClaudeMd] 降级完成后根 CLAUDE.md 的内容；读不到传 null
 * @returns {string[]}
 */
export function buildFixNotes({ requested, results, rootClaudeMd } = {}) {
  const notes = [];
  const list = Array.isArray(results) ? results : [];

  const unsupported = (Array.isArray(requested) ? requested : [])
    .filter((d) => !SUPPORTED_DIMENSIONS.includes(d));
  if (unsupported.length) {
    notes.push(`勾选的 ${unsupported.join('、')} 维度暂无自动修复能力，未做任何改动。`);
  }

  const md = typeof rootClaudeMd === 'string' ? rootClaudeMd : '';
  if (md) {
    const residual = list
      .filter((r) => r?.status === 'done' && r.skillName)
      // 比对原文件名而不是技能名：技能名会出现在刚替换好的 `/xxx` 里，拿它去搜必然误报
      .map((r) => String(r.file || '').slice(RULES_PREFIX.length))
      .filter((name) => name && md.includes(name));

    if (residual.length) {
      notes.push(
        `根 CLAUDE.md 里仍出现 ${residual.join('、')}（多半是索引表里的裸文件名，` +
        '自动替换只认带反引号的完整路径），请手工改成对应技能或删掉该行。',
      );
    }
  }

  const mapWrites = list.filter((r) => r?.status === 'done' && MAP_KINDS.has(r.kind));
  if (mapWrites.length) {
    notes.push(
      `本次改写了 ${mapWrites.length} 份地图文件，它们的时间戳已刷新——` +
      '「地图过期」告警在下次体检时会消失，但这不代表地图正文已经跟上代码。' +
      '请以地图末尾的「⚠️ 自动核对」块为准，那里列出的差异仍需人工处理。',
    );
  }

  return notes;
}
```

并在 `RULES_PREFIX` 常量下方补上：

```js
/** 会写地图文件的任务类型 —— 用来判断要不要发 mtime 提醒 */
const MAP_KINDS = new Set(['gen-map', 'stale-audit', 'dead-link']);
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/features/project-optimize/fix-plan.logic.test.js
```

预期：原有 13 条 + 新增 5 条全 pass。注意原有那条「勾选了尚不支持的维度要如实说明」断言里含 `map`，需同步把用例里的 `['rules','comments','map']` 改成 `['rules','comments','tests']` 并把 `assert.match(notes[0], /map/)` 改成 `/tests/`——否则它会因为 map 已被支持而失败。

---

## Task 11: 编排层接入地图维度

**Files:**
- Modify: `src/entrypoints/web/optimize-ops.js:299-419`

- [ ] **Step 1: 改 startFix 的选材**

`optimize-ops.js` 顶部 import 区补充：

```js
import { fixDeadLinks, writeGeneratedMap, writeStaleAudit } from '../../features/project-optimize/fix-map.js';
import { selectFixableMap, planMapFix } from '../../features/project-optimize/fix-map.logic.js';
import { generateRootMap, generateModuleMap } from '../../features/project-optimize/gen-map.js';
import { checkMap } from '../../features/project-checkup/check-map.js';
```

`startFix` 中第 303-304 行（`const { files, blocked } = selectFixableRules(report);` 与其后的 `if (!files.length)`）替换为：

```js
    // 维度勾选是**筛子**而不是摆设：用户只勾了 map 却把 rules 也改了，
    // 等于在用户没同意的情况下删文件。空数组视为「全都要」——
    // 那是老前端的行为，改成静默不做会让旧页面点了优化毫无反应
    const want = (d) => !dimensions.length || dimensions.includes(d);
    const rules = want('rules') ? selectFixableRules(report) : { files: [], blocked: [] };
    const map = want('map')
      ? selectFixableMap(report)
      : { rootMap: false, modules: [], stale: [], deadLinks: [], blocked: [] };

    const mapTaskCount = (map.rootMap ? 1 : 0) + map.modules.length + map.stale.length + map.deadLinks.length;
    const blocked = [...rules.blocked, ...map.blocked];
    if (!rules.files.length && !mapTaskCount) return { nothing: true, blocked };
```

> 注意 `startFix` 里 `acquireBusy` 之前的这段是只读的，把它整体前移到抢闸之前会破坏 `optimize-ops.js:310-313` 注释里说明的时序保证（闸必须抢在起 git 子进程之前）。保持它在 `try` 块内、`checkWorkspace` 之前的现有位置。

`runFix` 的调用处（第 337 行）改为：

```js
    runFix(job, {
      rules, map, blocked, dimensions,
      rulesBefore: report.dims?.rules?.score ?? null,
      mapBefore: report.dims?.map?.score ?? null,
    }).catch((e) => {
      logger.warn('optimize', '优化编排异常', { dir, err: e?.message || String(e) });
      finishFixJob(job, { error: e?.message || String(e) });
    });
```

- [ ] **Step 2: 改 runFix 主流程**

`runFix` 整个函数替换为：

```js
/**
 * 优化主流程：规划 → 快照 → 逐任务执行 → 记录优化后状态 → 重算静态分。
 *
 * 顺序不能动：快照必须在任何写操作之前（planDemote / planMapFix 都无副作用，专为此设计），
 * recordPostState 必须在全部写完之后（它记的是「优化后的内容哈希」，
 * 还原时靠它区分「用户事后又手工改过」和「优化本身造成的差异」）。
 */
async function runFix(job, { rules, map, blocked, dimensions, rulesBefore, mapBefore }) {
  const dir = job.dir;
  const results = [];
  let backupDir = null;

  try {
    // ---- M1 前置：没有根地图时，报告里 M2/M3/M4 根本不存在 ----
    // check-map.logic.js:95 在 !hasRootMap 时 early-return，只产出 M1 一条 issue。
    // 所以根地图必须先生成、再重扫，否则一个 map=0 的项目优化完只会多出一份根地图，
    // 用户还得再点一次才能补上模块地图。
    // 它发生在快照之前，因此单独打一份自己的快照（下面 createBackup 的 entries 里也含它）。
    let mapPlan = map;
    if (map.rootMap) {
      pushEvent(job, 'step', { phase: 'plan', text: '生成根项目地图（之后会重新扫描以发现模块级问题）' });
      const rootRes = await writeGeneratedMap(dir, 'CLAUDE.md', () => generateRootMap(dir, { signal: job.signal }));
      results.push(rootRes);
      pushEvent(job, 'file', rootRes);

      if (rootRes.status === 'done') {
        // 重扫拿真实的 M2/M3/M4。只有根地图写成功才有意义——失败时重扫结果仍是 M1
        const rescanned = selectFixableMap({ dims: { map: checkMap(dir) } });
        mapPlan = { ...rescanned, rootMap: false };
        pushEvent(job, 'step', {
          phase: 'plan',
          text: `重新扫描：发现 ${rescanned.modules.length} 个缺地图的模块、`
            + `${rescanned.stale.length} 份过期地图、${rescanned.deadLinks.length} 条死链`,
        });
      } else {
        mapPlan = { ...map, rootMap: false };
      }
    }

    const mapEntries = planMapFix(mapPlan);
    const rulePlan = rules.files.length ? planDemote(dir, rules.files) : [];
    pushEvent(job, 'step', {
      phase: 'plan',
      text: `规划 ${rulePlan.length} 个规则文件、${mapEntries.length} 个地图文件的改动`,
    });

    // 根地图那份 created 条目要一并登记：它已经写下去了，还原时必须能把它删掉。
    //
    // 这里有一个已知且可接受的时序窗口：根地图先于 createBackup 落盘。
    // 之所以能接受——created 类条目在 backup.logic.js:24 被标 backed:false（不备份内容），
    // 还原动作就是「删掉它」，所以备份的时机不影响还原的正确性，只要最终 manifest 里有这条记录。
    // 真正的风险窗口只有「根地图已写、createBackup 还没跑」这两行代码之间的崩溃，
    // 后果也仅仅是盘上多一个 CLAUDE.md 需要手删。
    //
    // 为消除这个窗口而把备份拆成两次（生成前一次、重扫后一次）代价大得多：
    // 会产生两个备份目录，还原要按顺序还两次，而 backup.js 没有「向已有快照追加条目」的 API。
    const allEntries = [...rulePlan, ...mapEntries];
    if (map.rootMap) allEntries.unshift({ path: 'CLAUDE.md', action: 'created' });

    const backup = createBackup(dir, allEntries, { dimensions });
    backupDir = backup.dirName;
    pushEvent(job, 'step', { phase: 'backup', text: `已快照 ${allEntries.length} 个文件`, backupDir });

    // ---- 顺序：死链 → 模块地图 → 过期核对 ----
    // 死链先做：它是确定性的、最快，且按行号定位。放在追加核对块之后的话，
    // 追加内容虽然在末尾不影响前面的行号，但死链修复本身会刷新 mtime，
    // 让「哪些地图过期」这件事在执行中途发生变化。清单已在 selectFixableMap 时固化，
    // 顺序仍按「不改变输入的操作优先」排，减少心智负担。
    if (mapPlan.deadLinks.length) {
      pushEvent(job, 'step', { phase: 'dead-link', text: `修复 ${mapPlan.deadLinks.length} 条死链` });
      const dl = fixDeadLinks(dir, mapPlan.deadLinks);
      for (const u of dl.updated) {
        const r = { file: u.file, kind: 'dead-link', status: 'done', reason: `${u.from} → ${u.to}` };
        results.push(r);
        pushEvent(job, 'file', r);
      }
      for (const s of dl.skipped) {
        const r = { file: s.file, kind: 'dead-link', status: 'skipped', reason: `${s.ref}：${s.reason}` };
        results.push(r);
        pushEvent(job, 'file', r);
      }
    }

    // 模块地图与过期核对都是独立的单文件 LLM 任务 → 受限并发
    const mapJobs = [
      ...mapPlan.modules.map((mod) => () =>
        writeGeneratedMap(dir, `${mod}/CLAUDE.md`, () => generateModuleMap(dir, mod, { signal: job.signal }))),
      ...mapPlan.stale.map((st) => () =>
        writeStaleAudit(dir, st.file, st.staleDays, { signal: job.signal })),
    ];
    if (mapJobs.length) {
      pushEvent(job, 'step', { phase: 'gen-map', text: `生成/核对 ${mapJobs.length} 份地图（并发 ${MAP_CONCURRENCY}）` });
      await runPool(mapJobs, MAP_CONCURRENCY, (r) => {
        results.push(r);
        pushEvent(job, 'file', r);
      }, job);
    }

    // ---- rules 降级（原有流程，一字未动的语义）----
    for (const f of rules.files) {
      if (job.signal?.aborted) break;
      const r = await demoteOne(dir, f, {
        onStep: (s) => pushEvent(job, 'step', { phase: s.step, file: s.file, skillName: s.skillName }),
      });
      results.push(r);
      pushEvent(job, 'file', r);
      if (r.fatal) {
        pushEvent(job, 'step', {
          phase: 'abort',
          text: `${r.file} 失败且改动已写到一半，已停止处理剩余规则文件`,
        });
        break;
      }
    }

    if (job.signal?.aborted) {
      pushEvent(job, 'step', { phase: 'abort', text: '已按你的要求停止；已完成的改动保留，可用「还原」撤销' });
    }

    // 中途 abort 也要记：记的是**实际落盘的状态**，部分完成的状态一样能当还原基准。
    // 记不上不会坏事，只是还原退化成无条件覆盖，所以失败仅告警不中断。
    try {
      recordPostState(dir, backupDir);
    } catch (e) {
      logger.warn('optimize', 'recordPostState 失败，还原将退化为无条件覆盖', { dir, err: e?.message || String(e) });
    }

    const report = refreshStaticReport(dir);
    const notes = buildFixNotes({ requested: dimensions, results, rootClaudeMd: readRootClaudeMd(dir) });

    const summary = {
      results,
      blocked,
      notes,
      backupDir,
      cancelled: !!job.signal?.aborted,
      rules: { before: rulesBefore, after: report.dims?.rules?.score ?? null },
      map: { before: mapBefore, after: report.dims?.map?.score ?? null },
      report,
    };
    saveFixResult(dir, {
      at: new Date().toISOString(),
      backupDir, dimensions, results, notes,
      rules: summary.rules,
      map: summary.map,
    });
    finishFixJob(job, summary);
  } catch (e) {
    // 已经动过盘就不能装作没发生：把已有结果和备份目录一起交出去，用户才知道能还原
    logger.warn('optimize', '优化执行失败', { dir, err: e?.message || String(e) });
    finishFixJob(job, { error: e?.message || String(e), results, backupDir });
  }
}
```

- [ ] **Step 3: 加并发池**

在 `optimize-ops.js` 的 `// ==================== 一键优化 ====================` 分隔线下方插入：

```js
/**
 * 地图生成的并发度。
 *
 * 不能更高：describe-skill.js:44-50 记录了实测数据——同一次跑里四个调用耗时
 * 34.9s / 35.3s / 91.6s / 127.1s，波动近 4 倍，原因是连续调用赶上限流排队。
 * 并发拉高只会加剧排队，把长尾推得更长，甚至触发更严格的限流。
 * 3 是「明显快于串行」和「不额外招惹限流」之间的折中。
 */
const MAP_CONCURRENCY = 3;

/**
 * 受限并发池：thunks 逐个取、最多 n 个同时在跑，每完成一个立刻回调（用于推 SSE）。
 *
 * 不用 Promise.all 分批：分批的话每批要等最慢的那个（长尾 127s vs 35s），
 * 白白浪费快的那几个的时间。这里是「谁空了谁取下一个」。
 *
 * 单个任务抛错不会掀翻整池——执行层承诺不抛（fix-map.js 开头纪律 2），
 * 这里的 catch 是防御性的，真抛了就当一条失败记下来继续。
 */
async function runPool(thunks, n, onDone, job) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < thunks.length) {
      if (job?.signal?.aborted) return;
      const mine = thunks[cursor++];
      let r;
      try {
        r = await mine();
      } catch (e) {
        r = { file: '(未知)', kind: 'gen-map', status: 'failed', reason: e?.message || String(e) };
      }
      onDone(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, thunks.length) }, worker));
}
```

- [ ] **Step 4: 给 job 加中断能力**

`startFix` 里创建 job 的对象字面量（第 324-333 行）加入 `abort` 与 `signal`：

```js
    gc();
    const ac = new AbortController();
    const job = {
      id: jobId,
      kind: 'fix',
      dir,
      status: 'running',
      events: [],
      done: null,
      subs: new Set(),
      // 中断句柄：用户选了「全量生成」，10+ 个模块可能跑十几分钟，
      // 没有取消点等于把人锁在进度条前面
      abort: () => ac.abort(),
      signal: ac.signal,
      updatedAt: Date.now(),
    };
```

在 `getFixJob` 下方新增：

```js
/**
 * 请求停止一次优化。
 *
 * 只发信号、不等它停：正在跑的 LLM 调用会被 abortController 打断，
 * 已经落盘的改动一律保留（备份还在，用户可以还原）。
 * 「停止」不等于「回滚」——把两者绑在一起会让用户在想中止时被迫接受回滚。
 *
 * @returns {boolean} 是否受理（job 不存在或已结束时为 false）
 */
export function cancelFixJob(id) {
  const job = getJob(id, 'fix');
  if (!job || job.status !== 'running') return false;
  job.abort();
  pushEvent(job, 'step', { phase: 'cancelling', text: '正在停止……已完成的改动会保留' });
  return true;
}
```

- [ ] **Step 5: 跑既有测试确认没打破编排层**

```bash
node --test src/entrypoints/web/routes-optimize.test.js
```

预期：`fail 0`。若因 `startFix` 返回结构变化而失败，按新结构（`nothing` 判定改为同时看 rules 与 map）修正断言。

---

## Task 12: 取消路由

**Files:**
- Modify: `src/entrypoints/web/routes-optimize.js`

- [ ] **Step 1: 加 handler**

`routes-optimize.js` 顶部 import 里把 `cancelFixJob` 加进 `optimize-ops.js` 的导入清单，并在 `handleFixStream`（第 103 行）下方插入：

```js
// ==== POST /api/optimize/fix/cancel {jobId} ====
// 只发停止信号，不回滚。已落盘的改动保留，用户可另行走 rollback
function handleFixCancel(req, res) {
  return withJsonBody(req, res, async (data) => {
    const jobId = str(data.jobId);
    if (!jobId) return sendJson(res, 400, { error: '缺少 jobId 参数' });
    // 找不到 job 一律回 404 而不是静默 200：前端据此提示「任务已结束」，
    // 回 200 会让用户以为点停止生效了、然后继续等一个不会来的停止事件
    if (!cancelFixJob(jobId)) return sendJson(res, 404, { error: '优化任务不存在或已结束' });
    sendJson(res, 200, { ok: true });
  });
}
```

- [ ] **Step 2: 注册路由**

在 `handleOptimizeRoutes` 的 `fix-stream` 分支（第 144-146 行）之后插入：

```js
  if (url.pathname === '/api/optimize/fix/cancel' && req.method === 'POST') {
    return handleFixCancel(req, res);
  }
```

- [ ] **Step 3: 语法检查**

```bash
node --check src/entrypoints/web/routes-optimize.js && echo "SYNTAX OK"
```

预期：`SYNTAX OK`

- [ ] **Step 4: 跑路由测试**

```bash
node --test src/entrypoints/web/routes-optimize.test.js
```

预期：`fail 0`

---

## Task 13: 前端进度与取消

**Files:**
- Modify: `public/js/optimize-view.js`
- Modify: `public/js/optimize-fix.logic.js` (+test)

> ⚠️ **本文件有一条硬性安全约定**（`optimize-view.js:4-5`）：所有来自后端的文本一律
> `createElement` + `textContent` 渲染，**禁止 innerHTML 拼接**。本次新增的展示内容
> （死链的 `from → to`、地图生成失败原因、核对块条目数）全都是后端/LLM 产出的不可信文本，
> 必须走 `textContent`。下面 Step 5 加的那个「停止」按钮是静态 HTML，不受此限。

- [ ] **Step 1: 给 stepLabel 补地图阶段的文案（先写测试）**

在 `public/js/optimize-fix.logic.test.js` 末尾追加：

```js
test('地图相关阶段有中文文案', () => {
  for (const phase of ['dead-link', 'gen-map', 'cancelling']) {
    const label = stepLabel({ phase });
    assert.ok(label && !label.includes(phase), `${phase} 应有中文文案，实际：${label}`);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test public/js/optimize-fix.logic.test.js
```

预期：`AssertionError`（文案里仍是英文 phase 名）

- [ ] **Step 3: 补文案**

在 `public/js/optimize-fix.logic.js` 的 `stepLabel` 所用的阶段映射表里补上：

```js
  'dead-link': '修复地图死链',
  'gen-map': '生成项目地图',
  cancelling: '正在停止',
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test public/js/optimize-fix.logic.test.js
```

预期：`fail 0`

- [ ] **Step 5: 加取消按钮**

在 `public/js/optimize-view.js` 里，`startFixStream`（第 455 行附近）记录当前 jobId：

```js
let fixJobId = null;
```

在建立 EventSource 处（第 455-456 行）之后补 `fixJobId = jobId;`，在 `stopFixStream`（第 348 行附近）里补 `fixJobId = null;`。

在优化按钮旁渲染取消按钮（沿用现有 `fixRunning` 状态驱动）：

```js
/**
 * 停止优化。
 *
 * 只发停止信号，不动已落盘的改动——用户想撤销要走「还原本次优化」。
 * 两者绑在一起会让「我不想再等了」变成「我要放弃已经生成好的 8 份地图」。
 */
async function cancelFix() {
  if (!fixJobId) return;
  const btn = $('#fixCancelBtn');
  btn.disabled = true;
  btn.textContent = '停止中…';
  const { ok } = await postJson('/api/optimize/fix/cancel', { jobId: fixJobId });
  if (!ok) toast.error('任务已结束，无需停止');
}
```

先定位优化按钮在 HTML 里的位置（`optimize-view.js:175` 用 `btn.textContent = fixButtonLabel(...)` 操作它，先找出它的 id）：

```bash
grep -n "fixButtonLabel\|fixBtn" public/js/optimize-view.js | head -5
grep -rn "id=\"fix" public/*.html
```

在查到的那个按钮之后插入同级按钮，class 沿用同一行里已有按钮的写法（本仓库没有统一组件库，照抄邻居是唯一正确的对齐方式）：

```html
<button id="fixCancelBtn" hidden>停止</button>
```

在 `optimize-view.js` 的渲染函数（第 173-175 行那段按 `fixRunning` 更新按钮状态的代码）里补上：

```js
  // 只在跑的时候露出来：优化没在跑时显示一个禁用的「停止」纯属噪声
  const cancelBtn = $('#fixCancelBtn');
  cancelBtn.hidden = !fixRunning;
  if (!fixRunning) { cancelBtn.disabled = false; cancelBtn.textContent = '停止'; }
```

并在初始化绑定处（与 `#fixBtn` 的 click 绑定相邻）加：

```js
  $('#fixCancelBtn').addEventListener('click', cancelFix);
```

- [ ] **Step 6: 跑前端测试**

```bash
node --test "public/**/*.test.js"
```

预期：除既有的 2 条 `.md` 图标断言漂移（`chat.path.test.js`，与本次无关，见交接文档）外 `fail 0`。

---

## Task 14: 全量测试

- [ ] **Step 1: 跑全套**

```bash
npm test 2>&1 | grep -E "^. (tests|pass|fail) "
```

预期：`fail 2`（既有的 `.md` 图标断言漂移）。若多于 2 条，逐条排查——本次改动不应引入任何新失败。

- [ ] **Step 2: 确认失败的确实是那两条既有项**

```bash
npm test 2>&1 | grep -A 3 "not ok"
```

预期：两条都来自 `public/js/chat.path.test.js`，断言内容是 `📄` vs `📝`。

---

## Task 15: 真实项目验收

> 交接文档「坑 5」的教训是：**单测只能证明代码符合我的预期，证明不了我的预期符合现实**。死链检测当年在根地图上把误报率压到 50%、自我感觉良好，一接模块地图发现 153 条里 152 条是误报。生成端同理——下面每一步都必须**人工读产出**，不能只看「文件生成了、分数涨了」。

- [ ] **Step 1: 本仓库跑 M1 全链路**

本仓库 `claude-p-web-demo` 自身 map=0（根本没有 CLAUDE.md），是 M1→重扫→M2 全链路最干净的样本。

```bash
npm start
```

浏览器打开优化面板 → 选本仓库目录 → 体检 → 只勾「项目地图」→ 一键优化。

预期进度流：`生成根项目地图 → 重新扫描：发现 N 个缺地图的模块… → 已快照 … → 生成/核对 N 份地图（并发 3）`

- [ ] **Step 2: 人工读根地图**

```bash
cat CLAUDE.md
```

逐条核对：
- 「常用命令」里的命令能否真的跑通（对照 `package.json` 的 scripts）
- 「模块路由表」里的每个路径是否真实存在
- 有没有编造出不存在的模块或功能

**任何一条编造内容都说明质量闸不够严**，回 Task 7 收紧 `validateRootMap`。

- [ ] **Step 3: 人工读两份模块地图**

挑 `src/features/project-optimize/`（本次新写的，你最熟）和 `src/entrypoints/web/`（最大最杂）各读一遍。重点看「关键流程」和「常见改动入口」两节是不是真的读过代码——如果只是文件清单的换句话说，说明只读工具没被有效使用，检查日志里有没有 `拦截了非只读工具调用`。

- [ ] **Step 4: 确认只读沙箱真的拦住了写入**

```bash
grep -c "拦截了非只读工具调用" logs/*.log 2>/dev/null || echo "无拦截记录"
```

两种结果都正常：有记录说明三层闸在起作用（模型试过写、被拒了）；无记录说明系统提示词那层软约束已经掐掉了念头。**但如果出现了本次优化范围之外的文件变动，说明沙箱漏了**，立刻停下来查 `llm-readonly-agent.js`。

```bash
git status --short
```

预期：只有 `CLAUDE.md`、各模块 `CLAUDE.md`、`.claude/optimize-backup/` 是新增的。**任何源码文件出现在这里都是重大缺陷。**

- [ ] **Step 5: 验证还原**

点「还原本次优化」，然后：

```bash
git status --short
```

预期：所有新生成的 CLAUDE.md 被删除（`planMapFix` 把它们登记为 `created`，`backup.logic.js:31-35` 的 `restoreActionsOf` 会转成 `remove`），工作区回到优化前。

- [ ] **Step 6: 在 kxmall-app-ui 上验 M3/M4**

该项目已知有 2 条死链（1 真 1 假，见交接文档验收表）和过期模块地图。

预期：
- 真死链被改写，假死链（CDN 资源）进 skipped 且原文未动
- 过期地图末尾出现「⚠️ 自动核对」块，**人写的正文一字未变**（用 `git diff` 逐行确认）
- 优化结果里出现那条 mtime 提醒 note

- [ ] **Step 7: 验证取消**

在 M2 生成到第 2、3 份时点「停止」。

预期：进度流出现「正在停止……已完成的改动会保留」，已生成的地图留在盘上，备份完整，「还原」可用。

- [ ] **Step 8: 回填实测数据到注释**

把 Step 1-7 实测到的单次生成耗时、并发下的长尾写进 `llm-readonly-agent.js` 的 `READONLY_AGENT_TIMEOUT_MS` 注释——**当前那个 600s 是拍的，不是测的**。describe-skill.js 那份注释之所以有价值，正是因为它记的是真实数字和撞过的坑。

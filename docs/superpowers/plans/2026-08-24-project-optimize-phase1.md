# 「项目优化」体检工具 · 阶段一实现计划（静态体检）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 web 执行台选一个本地项目、点「体检」，1 秒内看到「项目地图」和「rules 降级」两个维度的分数、总分和可定位到 `文件:行号` 的问题清单。

**Architecture:** 纯静态检测，无 LLM 参与。检测逻辑拆成「纯函数 logic 层」（接收已读入内存的数据，可单测）+ 「薄薄的文件系统层」（负责遍历和读文件）。后端走本项目既有的单入口子路由范式（对齐 `routes-memory.js`），前端走 SPA 的 `showView` + `panel-page` 范式。

**Tech Stack:** Node 原生 ESM（无框架、无构建）、`node:http`、`node --test`、原生 DOM。

**分期说明：** 本计划只覆盖阶段一。设计文档 `docs/superpowers/specs/2026-08-24-project-optimize-design.md` 中的 LLM 维度（②提示词 ⑤注释）、一键优化、备份还原属于阶段二至四，各自是能独立工作的子系统，计划待阶段一落地后另行编写。阶段一结束时：维度②⑤ 在 UI 上显示「未启用」，维度④ 置灰，总分只由 ①③ 按权重归一化计算。

**⚠️ 偏离 superpowers 默认约定：** 本项目 CLAUDE.md 规定「不要自动 git 提交，改动留工作区，提交时机由用户掌控」。因此各 Task 的最后一步是**验证 + 留工作区**，不含 `git commit`。用户指令优先于 skill 默认。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/store/optimize.js` | `optimize.json` 的读写，项目记录的增删改 |
| `src/features/project-checkup/frontmatter.logic.js` | 极简 YAML frontmatter 解析（只解析 `paths` 列表，不引第三方依赖） |
| `src/features/project-checkup/check-rules.logic.js` | 纯函数：给定 rules 文件描述数组 → 判定应降级 + 扣分 |
| `src/features/project-checkup/check-rules.js` | 文件系统层：扫 `.claude/rules/`，读文件，喂给 logic |
| `src/features/project-checkup/check-map.logic.js` | 纯函数：覆盖率、新鲜度、死链提取、判分 |
| `src/features/project-checkup/check-map.js` | 文件系统层：遍历模块目录、读地图、校验死链目标是否存在 |
| `src/features/project-checkup/score.logic.js` | 加权总分、N/A 权重重分配、档位映射 |
| `src/features/project-checkup/index.js` | 编排：调各检测器，产出完整报告对象 |
| `src/entrypoints/web/routes-optimize.js` | `/api/optimize/*` 子路由 |
| `public/js/optimize-view.logic.js` | 前端纯逻辑：问题分组、分数格式化 |
| `public/js/optimize-view.js` | 面板渲染、事件绑定、调接口 |

拆分依据：logic 层不碰文件系统所以能单测，fs 层薄到不需要测。这是本项目既有约定（见 `src/app/dispatch.test.js` 的写法）。

---

## Task 1: 测试夹具

**Files:**
- Create: `tests/fixtures/projects/healthy/CLAUDE.md`
- Create: `tests/fixtures/projects/healthy/.claude/rules/narrow-rule.md`
- Create: `tests/fixtures/projects/healthy/src/alpha/CLAUDE.md`
- Create: `tests/fixtures/projects/healthy/src/alpha/index.js`
- Create: `tests/fixtures/projects/no-map/src/beta/index.js`
- Create: `tests/fixtures/projects/kxmall-like/CLAUDE.md`
- Create: `tests/fixtures/projects/kxmall-like/.claude/rules/fat-wide-rule.md`
- Create: `tests/fixtures/projects/kxmall-like/src/gamma/index.js`

- [ ] **Step 1: 创建 healthy 夹具**

`tests/fixtures/projects/healthy/CLAUDE.md`：

```markdown
# Healthy 示例项目

模块索引见下表。

| 目录 | 职责 |
| --- | --- |
| `src/alpha/` | 示例模块 |
```

`tests/fixtures/projects/healthy/.claude/rules/narrow-rule.md`：

```markdown
---
paths:
  - 'src/alpha/**/*.js'
---

# 窄规则

体积小且 paths 窄，不应被判定为需要降级。
```

`tests/fixtures/projects/healthy/src/alpha/CLAUDE.md`：

```markdown
# alpha 模块

只有一个 `index.js`。
```

`tests/fixtures/projects/healthy/src/alpha/index.js`：

```js
export const alpha = 1;
```

- [ ] **Step 2: 创建 no-map 夹具**

`tests/fixtures/projects/no-map/src/beta/index.js`：

```js
export const beta = 2;
```

（该夹具刻意不含任何 `CLAUDE.md` 和 `.claude/` 目录，用于验证「未建立地图」路径。）

- [ ] **Step 3: 创建 kxmall-like 夹具**

`tests/fixtures/projects/kxmall-like/CLAUDE.md`：

```markdown
# kxmall-like 示例

引用一个已不存在的文件：`.claude/rules/popup-pattern.md`
再引用一个存在的文件：`src/gamma/index.js`
```

`tests/fixtures/projects/kxmall-like/.claude/rules/fat-wide-rule.md` —— 必须让正文超过 5KB。用下面这段重复 60 次填充：

```markdown
---
paths:
  - 'src/**'
---

# 又大又宽的规则

这一行是填充内容，用于把文件撑到 5KB 以上，模拟真实项目里那些体积大且 paths 过宽的规则文件。
```

生成命令（在项目根执行）：

```bash
mkdir -p tests/fixtures/projects/kxmall-like/.claude/rules
{ printf -- "---\npaths:\n  - 'src/**'\n---\n\n# 又大又宽的规则\n\n"; for i in $(seq 1 60); do echo "这一行是填充内容，用于把文件撑到 5KB 以上，模拟真实项目里那些体积大且 paths 过宽的规则文件。"; done; } > tests/fixtures/projects/kxmall-like/.claude/rules/fat-wide-rule.md
```

`tests/fixtures/projects/kxmall-like/src/gamma/index.js`：

```js
export const gamma = 3;
```

（该目录刻意不含 `CLAUDE.md`，用于验证覆盖率不足的扣分。）

- [ ] **Step 4: 验证夹具体积**

Run:
```bash
wc -c tests/fixtures/projects/kxmall-like/.claude/rules/fat-wide-rule.md
```
Expected: 大于 5120（若不足，增加 seq 上限重新生成）

- [ ] **Step 5: 改动留工作区，不提交**

---

## Task 2: frontmatter 解析

**Files:**
- Create: `src/features/project-checkup/frontmatter.logic.js`
- Test: `src/features/project-checkup/frontmatter.logic.test.js`

- [ ] **Step 1: 写失败测试**

`src/features/project-checkup/frontmatter.logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from './frontmatter.logic.js';

test('解析出 paths 列表', () => {
  const raw = "---\npaths:\n  - 'src/**'\n  - \"src/a/*.vue\"\n---\n\n# 标题\n";
  const fm = parseFrontmatter(raw);
  assert.deepEqual(fm.paths, ['src/**', 'src/a/*.vue']);
  assert.equal(fm.hasFrontmatter, true);
});

test('没有 frontmatter 时 paths 为 null', () => {
  const fm = parseFrontmatter('# 只有正文\n');
  assert.equal(fm.hasFrontmatter, false);
  assert.equal(fm.paths, null);
});

test('有 frontmatter 但没有 paths 字段', () => {
  const raw = '---\nname: foo\n---\n\n正文\n';
  const fm = parseFrontmatter(raw);
  assert.equal(fm.hasFrontmatter, true);
  assert.equal(fm.paths, null);
});

test('CRLF 换行也能解析', () => {
  const raw = "---\r\npaths:\r\n  - 'src/**'\r\n---\r\n\r\n正文\r\n";
  assert.deepEqual(parseFrontmatter(raw).paths, ['src/**']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/features/project-checkup/frontmatter.logic.test.js`
Expected: FAIL，报错 `Cannot find module './frontmatter.logic.js'`

- [ ] **Step 3: 实现**

`src/features/project-checkup/frontmatter.logic.js`：

```js
/**
 * 极简 YAML frontmatter 解析。
 *
 * 为什么不引 yaml 库：本项目零构建、依赖克制，而我们只需要读 `paths` 这一个
 * 字符串数组字段。完整 YAML 解析器的能力远超需要，徒增依赖面。
 */

/** 去掉两端的成对引号（单双引号都认） */
function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === "'" && t.at(-1) === "'") || (t[0] === '"' && t.at(-1) === '"'))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * @param {string} raw 文件全文
 * @returns {{hasFrontmatter: boolean, paths: string[]|null}}
 */
export function parseFrontmatter(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { hasFrontmatter: false, paths: null };

  const end = text.indexOf('\n---', 3);
  if (end === -1) return { hasFrontmatter: false, paths: null };

  const block = text.slice(4, end);
  const lines = block.split('\n');

  let inPaths = false;
  const paths = [];
  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
    if (inPaths) {
      const m = line.match(/^\s*-\s+(.+?)\s*$/);
      if (m) { paths.push(unquote(m[1])); continue; }
      // 顶格的新键意味着 paths 块结束
      if (/^\S/.test(line)) inPaths = false;
    }
  }

  return { hasFrontmatter: true, paths: paths.length ? paths : null };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/features/project-checkup/frontmatter.logic.test.js`
Expected: PASS，4 个测试全绿

- [ ] **Step 5: 改动留工作区，不提交**

---

## Task 3: rules 降级检测（logic 层）

**Files:**
- Create: `src/features/project-checkup/check-rules.logic.js`
- Test: `src/features/project-checkup/check-rules.logic.test.js`

- [ ] **Step 1: 写失败测试**

`src/features/project-checkup/check-rules.logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPathsWidth, evaluateRules } from './check-rules.logic.js';

test('paths 宽度分级', () => {
  assert.equal(classifyPathsWidth(null), 'unconditional');
  assert.equal(classifyPathsWidth(['src/**']), 'wide');
  assert.equal(classifyPathsWidth(['**/*']), 'wide');
  assert.equal(classifyPathsWidth(['src/**/*.vue']), 'medium');
  assert.equal(classifyPathsWidth(['src/components/*.ts']), 'narrow');
});

test('多条 paths 取最宽的那条', () => {
  assert.equal(classifyPathsWidth(['src/a/*.ts', 'src/**']), 'wide');
});

test('大且宽 → 判定应降级', () => {
  const r = evaluateRules([
    { name: 'fat', sizeBytes: 15000, paths: ['src/**'] },
  ]);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].code, 'R1_SHOULD_DEMOTE');
  assert.equal(r.issues[0].fixable, true);
  assert.ok(r.score < 100);
});

test('小文件即使 paths 宽也不判降级', () => {
  const r = evaluateRules([{ name: 'tiny', sizeBytes: 900, paths: ['src/**'] }]);
  assert.equal(r.issues.length, 0);
  assert.equal(r.score, 100);
});

test('大文件但 paths 窄，不判降级', () => {
  const r = evaluateRules([
    { name: 'bigNarrow', sizeBytes: 20000, paths: ['src/components/*.vue'] },
  ]);
  assert.equal(r.issues.length, 0);
});

test('单文件扣分上限 20', () => {
  const r = evaluateRules([{ name: 'huge', sizeBytes: 500000, paths: null }]);
  assert.equal(r.score, 80);
});

test('没有 rules 目录 → N/A', () => {
  const r = evaluateRules(null);
  assert.equal(r.score, null);
  assert.equal(r.status, 'na');
});

test('有目录但没文件 → 满分', () => {
  const r = evaluateRules([]);
  assert.equal(r.score, 100);
  assert.equal(r.status, 'done');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/features/project-checkup/check-rules.logic.test.js`
Expected: FAIL，`Cannot find module './check-rules.logic.js'`

- [ ] **Step 3: 实现**

`src/features/project-checkup/check-rules.logic.js`：

```js
/**
 * 维度③：判定 .claude/rules/ 下哪些规范应该降级为 skill。
 *
 * 判定的理由（来自 2026-08-24 kxmall-app-ui 实测）：path-scoped rule 是**被动注入**的，
 * 只要读到匹配文件就整份塞进上下文。体积大 + paths 宽的组合会让纯逻辑改动也吃满无关规范，
 * 且中途注入会打断 KV cache，代价比多几千 token 更高。这类规范应改为 skill 按需调用。
 */

const DEMOTE_SIZE_THRESHOLD = 5 * 1024; // 5KB
const MAX_DEDUCT_PER_FILE = 20;

/**
 * 判断 paths 的宽度等级。
 * @param {string[]|null} paths
 * @returns {'unconditional'|'wide'|'medium'|'narrow'}
 */
export function classifyPathsWidth(paths) {
  // 无 paths 字段 = 启动即无条件加载，最宽
  if (!paths || paths.length === 0) return 'unconditional';

  const rank = { narrow: 0, medium: 1, wide: 2 };
  let worst = 'narrow';

  for (const p of paths) {
    let level;
    // 带扩展名的 glob（如 src/**/*.vue）至少限定了文件类型
    if (/\*\*.*\.\w+$/.test(p)) level = 'medium';
    // 不限扩展名的全目录 glob（如 src/**、**/*）
    else if (/\*\*\/?\*?$/.test(p) || p === '**/*') level = 'wide';
    else level = 'narrow';

    if (rank[level] > rank[worst]) worst = level;
  }
  return worst;
}

/**
 * @param {Array<{name:string,sizeBytes:number,paths:string[]|null}>|null} files
 *   null 表示项目没有 .claude/rules 目录
 */
export function evaluateRules(files) {
  if (files === null) {
    return { score: null, status: 'na', issues: [], reason: '项目没有 .claude/rules 目录' };
  }

  const issues = [];
  let score = 100;

  for (const f of files) {
    const width = classifyPathsWidth(f.paths);
    const isWide = width === 'unconditional' || width === 'wide';
    if (f.sizeBytes <= DEMOTE_SIZE_THRESHOLD || !isWide) continue;

    const sizeKB = f.sizeBytes / 1024;
    score -= Math.min(MAX_DEDUCT_PER_FILE, sizeKB * 1.5);

    issues.push({
      code: 'R1_SHOULD_DEMOTE',
      severity: 'warn',
      file: `.claude/rules/${f.name}`,
      line: 1,
      message:
        `${sizeKB.toFixed(1)}KB 且 paths 宽度为 ${width}，` +
        `预估每次匹配注入约 ${Math.round(f.sizeBytes / 4)} tokens（估算值）`,
      fixable: true,
      fixHint: `降级为 /${f.name.replace(/\.md$/, '')} 技能，按需调用`,
      meta: { sizeBytes: f.sizeBytes, width },
    });
  }

  return {
    score: Math.max(0, Math.round(score)),
    status: 'done',
    issues,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/features/project-checkup/check-rules.logic.test.js`
Expected: PASS，8 个测试全绿

- [ ] **Step 5: 改动留工作区，不提交**

---

## Task 4: rules 检测（文件系统层）

**Files:**
- Create: `src/features/project-checkup/check-rules.js`

- [ ] **Step 1: 实现**

`src/features/project-checkup/check-rules.js`：

```js
/**
 * 维度③的文件系统层：读 .claude/rules/ 目录，喂给 logic 层判定。
 * 这一层刻意保持极薄且不含判断逻辑，所有可测的部分都在 check-rules.logic.js。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.logic.js';
import { evaluateRules } from './check-rules.logic.js';

export function checkRules(projectDir) {
  const rulesDir = path.join(projectDir, '.claude', 'rules');
  if (!fs.existsSync(rulesDir)) return evaluateRules(null);

  const files = [];
  for (const name of fs.readdirSync(rulesDir)) {
    if (!name.endsWith('.md')) continue;
    const full = path.join(rulesDir, name);
    const st = fs.statSync(full);
    if (!st.isFile()) continue;
    const raw = fs.readFileSync(full, 'utf8');
    files.push({ name, sizeBytes: st.size, paths: parseFrontmatter(raw).paths });
  }

  return evaluateRules(files);
}
```

- [ ] **Step 2: 手工验证（对夹具跑一次）**

Run:
```bash
node -e "import('./src/features/project-checkup/check-rules.js').then(m=>{console.log(JSON.stringify(m.checkRules('tests/fixtures/projects/kxmall-like'),null,2))})"
```
Expected: 输出含 1 条 `R1_SHOULD_DEMOTE`，`file` 为 `.claude/rules/fat-wide-rule.md`，score < 100

- [ ] **Step 3: 对 healthy 夹具验证不误报**

Run:
```bash
node -e "import('./src/features/project-checkup/check-rules.js').then(m=>{console.log(JSON.stringify(m.checkRules('tests/fixtures/projects/healthy')))})"
```
Expected: `{"score":100,"status":"done","issues":[]}`

- [ ] **Step 4: 对 no-map 夹具验证 N/A**

Run:
```bash
node -e "import('./src/features/project-checkup/check-rules.js').then(m=>{console.log(JSON.stringify(m.checkRules('tests/fixtures/projects/no-map')))})"
```
Expected: `status` 为 `"na"`，`score` 为 `null`

- [ ] **Step 5: 改动留工作区，不提交**

---

## Task 5: 地图检测（logic 层）

**Files:**
- Create: `src/features/project-checkup/check-map.logic.js`
- Test: `src/features/project-checkup/check-map.logic.test.js`

- [ ] **Step 1: 写失败测试**

`src/features/project-checkup/check-map.logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPathRefs, evaluateMap, STALE_DAYS } from './check-map.logic.js';

test('提取反引号里的路径引用', () => {
  const md = '见 `src/a/index.js` 和 `.claude/rules/x.md`，还有 `docs/y.md`。';
  assert.deepEqual(extractPathRefs(md), [
    { ref: 'src/a/index.js', line: 1 },
    { ref: '.claude/rules/x.md', line: 1 },
    { ref: 'docs/y.md', line: 1 },
  ]);
});

test('忽略非路径的反引号内容', () => {
  const md = '用 `npm start` 启动，变量叫 `foo`，命令 `pnpm type-check`。';
  assert.deepEqual(extractPathRefs(md), []);
});

test('记录正确行号', () => {
  const md = '第一行\n第二行有 `src/b.ts`\n第三行';
  assert.deepEqual(extractPathRefs(md), [{ ref: 'src/b.ts', line: 2 }]);
});

test('带行号后缀的引用会被剥掉后缀', () => {
  assert.deepEqual(extractPathRefs('见 `src/a.js:123`'), [{ ref: 'src/a.js', line: 1 }]);
});

test('无根地图 → 0 分', () => {
  const r = evaluateMap({ hasRootMap: false, modules: [], deadLinks: [], rootMapLines: 0 });
  assert.equal(r.score, 0);
  assert.equal(r.issues[0].code, 'M1_NO_ROOT_MAP');
});

test('全覆盖 + 无过期 + 无死链 → 80 分', () => {
  const r = evaluateMap({
    hasRootMap: true,
    modules: [
      { name: 'alpha', hasMap: true, staleDays: 0 },
      { name: 'beta', hasMap: true, staleDays: 0 },
    ],
    deadLinks: [],
    rootMapLines: 100,
  });
  // 基础 60 + 覆盖率 1.0 × 20 = 80
  assert.equal(r.score, 80);
  assert.equal(r.issues.length, 0);
});

test('覆盖率一半 → 70 分并报缺失', () => {
  const r = evaluateMap({
    hasRootMap: true,
    modules: [
      { name: 'alpha', hasMap: true, staleDays: 0 },
      { name: 'beta', hasMap: false, staleDays: 0 },
    ],
    deadLinks: [],
    rootMapLines: 50,
  });
  assert.equal(r.score, 70);
  assert.equal(r.issues.filter((i) => i.code === 'M2_MISSING_MAP').length, 1);
});

test('过期模块扣 4 分', () => {
  const r = evaluateMap({
    hasRootMap: true,
    modules: [{ name: 'alpha', hasMap: true, staleDays: STALE_DAYS + 1 }],
    deadLinks: [],
    rootMapLines: 50,
  });
  assert.equal(r.score, 76); // 60 + 20 - 4
  assert.equal(r.issues[0].code, 'M3_STALE_MAP');
});

test('死链每条扣 3 分', () => {
  const r = evaluateMap({
    hasRootMap: true,
    modules: [{ name: 'alpha', hasMap: true, staleDays: 0 }],
    deadLinks: [{ file: 'CLAUDE.md', line: 7, ref: '.claude/rules/gone.md' }],
    rootMapLines: 50,
  });
  assert.equal(r.score, 77);
  assert.equal(r.issues[0].code, 'M4_DEAD_LINK');
  assert.equal(r.issues[0].line, 7);
});

test('根地图超 300 行扣 10 分', () => {
  const r = evaluateMap({
    hasRootMap: true,
    modules: [{ name: 'alpha', hasMap: true, staleDays: 0 }],
    deadLinks: [],
    rootMapLines: 350,
  });
  assert.equal(r.score, 70);
  assert.equal(r.issues[0].code, 'M5_OVERSIZED');
});

test('没有可统计的模块时覆盖率算满分', () => {
  const r = evaluateMap({ hasRootMap: true, modules: [], deadLinks: [], rootMapLines: 10 });
  assert.equal(r.score, 80);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/features/project-checkup/check-map.logic.test.js`
Expected: FAIL，`Cannot find module './check-map.logic.js'`

- [ ] **Step 3: 实现**

`src/features/project-checkup/check-map.logic.js`：

```js
/**
 * 维度①：项目地图的完备性与新鲜度。
 *
 * 死链检测是这里最有价值的一条：地图会过期，但过期得悄无声息。
 * 引用路径失效是「地图和代码脱节」最容易机器验证的信号。
 */

export const STALE_DAYS = 14;

// 认得出的源码/文档扩展名，用于把「路径引用」和「命令、变量名」区分开
const PATH_EXT = /\.(md|js|mjs|cjs|ts|tsx|jsx|vue|py|go|rs|java|json|scss|css|html|yml|yaml|sh|toml)$/i;

/**
 * 从 markdown 正文里提取路径引用（反引号包裹的部分）。
 * @returns {Array<{ref:string,line:number}>}
 */
export function extractPathRefs(md) {
  const out = [];
  const lines = String(md || '').split('\n');

  lines.forEach((text, idx) => {
    // 逐个匹配反引号 span
    const re = /`([^`\n]+)`/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      let ref = m[1].trim();
      // 剥掉 `src/a.js:123` 这类行号后缀——地图里习惯这么写
      ref = ref.replace(/:\d+(-\d+)?$/, '');
      // 命令行、含空格的内容不是路径
      if (/\s/.test(ref)) continue;
      if (!PATH_EXT.test(ref) && !/\/$/.test(ref)) continue;
      if (!ref.includes('/')) continue;
      out.push({ ref, line: idx + 1 });
    }
  });

  return out;
}

/**
 * @param {object} input
 * @param {boolean} input.hasRootMap
 * @param {Array<{name:string,hasMap:boolean,staleDays:number}>} input.modules
 * @param {Array<{file:string,line:number,ref:string}>} input.deadLinks
 * @param {number} input.rootMapLines
 */
export function evaluateMap({ hasRootMap, modules, deadLinks, rootMapLines }) {
  if (!hasRootMap) {
    return {
      score: 0,
      status: 'done',
      issues: [{
        code: 'M1_NO_ROOT_MAP',
        severity: 'error',
        file: 'CLAUDE.md',
        line: 1,
        message: '项目根没有 CLAUDE.md，每次会话都要从零摸索代码结构',
        fixable: true,
        fixHint: '生成根地图：项目定位 + 常用命令 + 模块路由表',
      }],
    };
  }

  const issues = [];
  let score = 60;

  // 覆盖率：没有可统计模块时视为满分，避免小项目被误判
  const total = modules.length;
  const covered = modules.filter((m) => m.hasMap).length;
  const coverage = total === 0 ? 1 : covered / total;
  score += coverage * 20;

  for (const m of modules) {
    if (!m.hasMap) {
      issues.push({
        code: 'M2_MISSING_MAP',
        severity: 'warn',
        file: `${m.name}/CLAUDE.md`,
        line: 1,
        message: `模块 ${m.name} 没有地图，AI 定位这个模块要靠全仓搜索`,
        fixable: true,
        fixHint: '生成模块地图：文件清单 + 关键流程 + 常见改动入口',
      });
    }
  }

  // 过期扣分，下限 -20
  const staleList = modules.filter((m) => m.hasMap && m.staleDays > STALE_DAYS);
  score -= Math.min(20, staleList.length * 4);
  for (const m of staleList) {
    issues.push({
      code: 'M3_STALE_MAP',
      severity: 'warn',
      file: `${m.name}/CLAUDE.md`,
      line: 1,
      message: `代码比地图新 ${m.staleDays} 天，地图可能已和实现脱节`,
      fixable: true,
      fixHint: '重新核对该模块地图的文件清单与关键流程',
    });
  }

  // 死链扣分，下限 -15
  score -= Math.min(15, deadLinks.length * 3);
  for (const d of deadLinks) {
    issues.push({
      code: 'M4_DEAD_LINK',
      severity: 'warn',
      file: d.file,
      line: d.line,
      message: `引用的 ${d.ref} 不存在`,
      fixable: true,
      fixHint: '修正为正确路径，或删除该引用',
    });
  }

  // 根地图体积（官方建议 < 200 行）
  if (rootMapLines > 300) {
    score -= 10;
    issues.push({
      code: 'M5_OVERSIZED',
      severity: 'info',
      file: 'CLAUDE.md',
      line: 1,
      message: `根地图 ${rootMapLines} 行，超过官方建议的 200 行，会挤占上下文并降低遵循度`,
      fixable: false,
      fixHint: '把只在特定任务用得上的内容下沉到模块地图或 skill',
    });
  } else if (rootMapLines > 200) {
    score -= 5;
    issues.push({
      code: 'M5_OVERSIZED',
      severity: 'info',
      file: 'CLAUDE.md',
      line: 1,
      message: `根地图 ${rootMapLines} 行，超过官方建议的 200 行`,
      fixable: false,
      fixHint: '把只在特定任务用得上的内容下沉到模块地图或 skill',
    });
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), status: 'done', issues };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/features/project-checkup/check-map.logic.test.js`
Expected: PASS，11 个测试全绿

- [ ] **Step 5: 改动留工作区，不提交**

---

## Task 6: 地图检测（文件系统层）

**Files:**
- Create: `src/features/project-checkup/check-map.js`

- [ ] **Step 1: 实现**

`src/features/project-checkup/check-map.js`：

```js
/**
 * 维度①的文件系统层：遍历模块目录、比对 mtime、校验死链目标是否存在。
 */
import fs from 'node:fs';
import path from 'node:path';
import { extractPathRefs, evaluateMap } from './check-map.logic.js';

const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|vue|py|go|rs|java|scss|css)$/i;
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const MIN_FILES_FOR_MODULE = 3; // 文件太少的目录不值得单独建地图

/** 递归取目录下代码文件的最新 mtime 和文件数 */
function scanDir(dir) {
  let latest = 0;
  let count = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!CODE_EXT.test(e.name)) continue;
      count += 1;
      try {
        const mt = fs.statSync(full).mtimeMs;
        if (mt > latest) latest = mt;
      } catch { /* 文件读不到就跳过，不影响整体体检 */ }
    }
  };
  walk(dir);
  return { latestMtime: latest, fileCount: count };
}

function findRootMap(projectDir) {
  for (const rel of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')]) {
    const full = path.join(projectDir, rel);
    if (fs.existsSync(full)) return { rel, full };
  }
  return null;
}

/** 收集所有地图文件（根 + 模块），用于死链扫描 */
function collectMapFiles(projectDir, rootMap, moduleDirs) {
  const list = [];
  if (rootMap) list.push({ rel: rootMap.rel, full: rootMap.full });
  for (const m of moduleDirs) {
    const full = path.join(projectDir, m.rel, 'CLAUDE.md');
    if (fs.existsSync(full)) list.push({ rel: `${m.rel}/CLAUDE.md`, full });
  }
  return list;
}

export function checkMap(projectDir, now = Date.now()) {
  const rootMap = findRootMap(projectDir);
  if (!rootMap) {
    return evaluateMap({ hasRootMap: false, modules: [], deadLinks: [], rootMapLines: 0 });
  }

  // 模块 = src/ 下一级目录；没有 src/ 就退化为项目根下一级目录
  const srcDir = path.join(projectDir, 'src');
  const baseDir = fs.existsSync(srcDir) ? srcDir : projectDir;
  const baseRel = fs.existsSync(srcDir) ? 'src' : '.';

  const moduleDirs = [];
  let entries = [];
  try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch { /* 读不到就当没有模块 */ }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue;
    const full = path.join(baseDir, e.name);
    const { latestMtime, fileCount } = scanDir(full);
    if (fileCount < MIN_FILES_FOR_MODULE) continue;
    moduleDirs.push({
      name: e.name,
      rel: baseRel === '.' ? e.name : `${baseRel}/${e.name}`,
      full,
      latestMtime,
    });
  }

  const modules = moduleDirs.map((m) => {
    const mapFile = path.join(m.full, 'CLAUDE.md');
    if (!fs.existsSync(mapFile)) return { name: m.rel, hasMap: false, staleDays: 0 };
    const mapMtime = fs.statSync(mapFile).mtimeMs;
    const diffMs = m.latestMtime - mapMtime;
    const staleDays = diffMs > 0 ? Math.floor(diffMs / 86400000) : 0;
    return { name: m.rel, hasMap: true, staleDays };
  });

  // 死链：扫所有地图文件里的路径引用，校验目标是否存在
  const deadLinks = [];
  for (const mf of collectMapFiles(projectDir, rootMap, moduleDirs)) {
    let raw;
    try { raw = fs.readFileSync(mf.full, 'utf8'); } catch { continue; }
    for (const { ref, line } of extractPathRefs(raw)) {
      // 相对引用先按项目根解析；解析不到再按该地图所在目录解析
      const asRoot = path.join(projectDir, ref);
      const asLocal = path.join(path.dirname(mf.full), ref);
      if (fs.existsSync(asRoot) || fs.existsSync(asLocal)) continue;
      deadLinks.push({ file: mf.rel, line, ref });
    }
  }

  const rootMapLines = fs.readFileSync(rootMap.full, 'utf8').split('\n').length;

  return evaluateMap({ hasRootMap: true, modules, deadLinks, rootMapLines });
}
```

- [ ] **Step 2: 对 kxmall-like 夹具验证死链被捞出**

Run:
```bash
node -e "import('./src/features/project-checkup/check-map.js').then(m=>{const r=m.checkMap('tests/fixtures/projects/kxmall-like');console.log(JSON.stringify(r,null,2))})"
```
Expected: `issues` 含一条 `M4_DEAD_LINK`，`ref` 为 `.claude/rules/popup-pattern.md`；另含一条 `M2_MISSING_MAP`（gamma 模块无地图）

- [ ] **Step 3: 对 no-map 夹具验证 0 分**

Run:
```bash
node -e "import('./src/features/project-checkup/check-map.js').then(m=>{console.log(JSON.stringify(m.checkMap('tests/fixtures/projects/no-map')))})"
```
Expected: `score` 为 0，`issues[0].code` 为 `M1_NO_ROOT_MAP`

- [ ] **Step 4: 对真实项目冒烟（验证不崩、不超时）**

Run:
```bash
node -e "console.time('t');import('./src/features/project-checkup/check-map.js').then(m=>{const r=m.checkMap('C:/Users/DELL/Desktop/kxmall-app-ui');console.timeEnd('t');console.log('score',r.score,'issues',r.issues.length)})"
```
Expected: 耗时 < 3000ms，输出分数和问题数，不抛异常

- [ ] **Step 5: 改动留工作区，不提交**

---

## Task 7: 评分聚合

**Files:**
- Create: `src/features/project-checkup/score.logic.js`
- Test: `src/features/project-checkup/score.logic.test.js`

- [ ] **Step 1: 写失败测试**

`src/features/project-checkup/score.logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEIGHTS, aggregateScore, gradeOf } from './score.logic.js';

test('权重合计为 100', () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100);
});

test('全维度可用时按权重加权', () => {
  const r = aggregateScore({
    map: { score: 100, status: 'done' },
    prompts: { score: 100, status: 'done' },
    rules: { score: 100, status: 'done' },
    comments: { score: 100, status: 'done' },
  });
  assert.equal(r.total, 100);
});

test('N/A 维度的权重按比例分给其余维度', () => {
  // rules N/A，其余满分 → 总分仍应是 100
  const r = aggregateScore({
    map: { score: 100, status: 'done' },
    prompts: { score: 100, status: 'done' },
    rules: { score: null, status: 'na' },
    comments: { score: 100, status: 'done' },
  });
  assert.equal(r.total, 100);
});

test('pending 维度不计入总分', () => {
  const r = aggregateScore({
    map: { score: 80, status: 'done' },
    prompts: { score: null, status: 'pending' },
    rules: { score: 60, status: 'done' },
    comments: { score: null, status: 'pending' },
  });
  // 只有 map(35) 和 rules(15) 参与：(80×35 + 60×15) / 50 = 74
  assert.equal(r.total, 74);
  assert.deepEqual(r.countedDims.sort(), ['map', 'rules']);
});

test('全部不可用时总分为 null', () => {
  const r = aggregateScore({
    map: { score: null, status: 'pending' },
    prompts: { score: null, status: 'pending' },
    rules: { score: null, status: 'na' },
    comments: { score: null, status: 'pending' },
  });
  assert.equal(r.total, null);
});

test('档位映射', () => {
  assert.equal(gradeOf(95).key, 'healthy');
  assert.equal(gradeOf(90).key, 'healthy');
  assert.equal(gradeOf(89).key, 'good');
  assert.equal(gradeOf(70).key, 'good');
  assert.equal(gradeOf(69).key, 'needs-work');
  assert.equal(gradeOf(50).key, 'needs-work');
  assert.equal(gradeOf(49).key, 'poor');
  assert.equal(gradeOf(0).key, 'poor');
  assert.equal(gradeOf(null), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/features/project-checkup/score.logic.test.js`
Expected: FAIL，`Cannot find module './score.logic.js'`

- [ ] **Step 3: 实现**

`src/features/project-checkup/score.logic.js`：

```js
/**
 * 总分聚合。
 *
 * 权重不等权的理由：地图和提示词影响的是「以后每一次开发的速度」，有复利效应；
 * rules 降级是一次性配置问题；注释是代码卫生，影响可读性但不直接拖慢 AI。
 * 维度④（无用代码）阶段一不做，不出现在权重表里。
 */

export const WEIGHTS = {
  map: 35,
  prompts: 30,
  rules: 15,
  comments: 20,
};

const GRADES = [
  { key: 'healthy', min: 90, label: '健康', cssVar: '--green' },
  { key: 'good', min: 70, label: '良好', cssVar: '--accent-hi' },
  { key: 'needs-work', min: 50, label: '需优化', cssVar: '--amber' },
  { key: 'poor', min: 0, label: '较差', cssVar: '--danger' },
];

export function gradeOf(total) {
  if (total === null || total === undefined) return null;
  return GRADES.find((g) => total >= g.min) || GRADES.at(-1);
}

/**
 * 只有 status === 'done' 且 score 是数字的维度参与计算。
 * na / pending / timeout / error 一律排除，权重按比例分摊给参与者。
 */
export function aggregateScore(dims) {
  const counted = [];
  let weightSum = 0;
  let weighted = 0;

  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const d = dims[key];
    if (!d || d.status !== 'done' || typeof d.score !== 'number') continue;
    counted.push(key);
    weightSum += weight;
    weighted += d.score * weight;
  }

  if (weightSum === 0) return { total: null, countedDims: [], grade: null };

  const total = Math.round(weighted / weightSum);
  return { total, countedDims: counted, grade: gradeOf(total) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/features/project-checkup/score.logic.test.js`
Expected: PASS，6 个测试全绿

- [ ] **Step 5: 改动留工作区，不提交**

---

## Task 8: 体检编排入口

**Files:**
- Create: `src/features/project-checkup/index.js`

- [ ] **Step 1: 实现**

`src/features/project-checkup/index.js`：

```js
/**
 * 体检编排：阶段一只跑静态检测器（维度①③）。
 * 维度②⑤ 需要 LLM，阶段二实现，此处先以 pending 占位；维度④ 阶段一不做，标 disabled。
 */
import fs from 'node:fs';
import { checkMap } from './check-map.js';
import { checkRules } from './check-rules.js';
import { aggregateScore } from './score.logic.js';

export function runStaticCheckup(projectDir, now = Date.now()) {
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new Error('目录不存在或不可读');
  }

  const dims = {
    map: checkMap(projectDir, now),
    prompts: { score: null, status: 'pending', issues: [], reason: '阶段二支持' },
    rules: checkRules(projectDir),
    deadcode: { score: null, status: 'disabled', issues: [], reason: '即将支持' },
    comments: { score: null, status: 'pending', issues: [], reason: '阶段二支持' },
  };

  const { total, countedDims, grade } = aggregateScore(dims);
  const issueCount = Object.values(dims).reduce((n, d) => n + (d.issues?.length || 0), 0);

  return {
    dir: projectDir,
    at: new Date(now).toISOString(),
    score: total,
    grade: grade ? grade.key : null,
    countedDims,
    issueCount,
    dims,
  };
}
```

- [ ] **Step 2: 对三个夹具跑通**

Run:
```bash
node -e "import('./src/features/project-checkup/index.js').then(m=>{for(const p of ['healthy','no-map','kxmall-like']){const r=m.runStaticCheckup('tests/fixtures/projects/'+p);console.log(p,'→ score',r.score,'grade',r.grade,'issues',r.issueCount)}})"
```
Expected: 三行输出。`healthy` 分数最高，`no-map` 的 map 维度为 0 分导致总分明显偏低，`kxmall-like` 居中且 issues > 0

- [ ] **Step 3: 改动留工作区，不提交**

---

## Task 9: 数据层

**Files:**
- Create: `src/store/optimize.js`

- [ ] **Step 1: 实现**

`src/store/optimize.js`：

```js
/**
 * optimize.json 的读写。沿用本项目 store 层的 readJson/updateJson 范式。
 * 用项目绝对路径作为 key——同一台机器上路径唯一，不需要额外生成 id。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'optimize.json';
const EMPTY = () => ({ projects: {} });
const HISTORY_LIMIT = 20;

export function readOptimizeStore() {
  const data = readJson(FILE, EMPTY());
  if (!data.projects || typeof data.projects !== 'object') data.projects = {};
  return data;
}

export function getProjectRecord(dir) {
  const data = readOptimizeStore();
  return data.projects[dir] || null;
}

/** 存一次体检结果，并把分数追加到历史（用于画趋势线） */
export function saveCheckup(dir, report) {
  return updateJson(FILE, EMPTY(), (data) => {
    if (!data.projects) data.projects = {};
    const rec = data.projects[dir] || { history: [], busy: null, backups: [] };
    rec.lastCheckup = report;
    if (typeof report.score === 'number') {
      rec.history = [...(rec.history || []), { at: report.at, score: report.score }].slice(-HISTORY_LIMIT);
    }
    data.projects[dir] = rec;
    return data;
  });
}
```

- [ ] **Step 2: 手工验证读写**

Run:
```bash
node -e "import('./src/store/optimize.js').then(async m=>{const c=await import('./src/features/project-checkup/index.js');const r=c.runStaticCheckup('tests/fixtures/projects/healthy');m.saveCheckup('__test__',r);console.log('saved, score=',m.getProjectRecord('__test__').lastCheckup.score)})"
```
Expected: 打印 `saved, score= <数字>`，且项目根出现 `optimize.json`

- [ ] **Step 3: 清理测试数据**

Run:
```bash
node -e "import('./src/store/index.js').then(m=>{const d=m.readJson('optimize.json',{projects:{}});delete d.projects.__test__;m.writeJson('optimize.json',d);console.log('cleaned')})"
```
Expected: 打印 `cleaned`

- [ ] **Step 4: 把 optimize.json 加入 .gitignore**

在 `.gitignore` 中追加一行（与其它运行时 JSON 放在一起）：

```
optimize.json
```

先确认该文件是否已被忽略：

```bash
grep -n "optimize.json" .gitignore || echo "需要追加"
```

- [ ] **Step 5: 改动留工作区，不提交**

---

## Task 10: 后端路由

**Files:**
- Create: `src/entrypoints/web/routes-optimize.js`
- Modify: `src/entrypoints/web/server.js`（import 区约 67 行、路由分发区约 168 行）

- [ ] **Step 1: 实现子路由**

`src/entrypoints/web/routes-optimize.js`：

```js
/**
 * 项目优化 HTTP 接口。沿用本项目单入口子路由范式（对齐 routes-memory.js）。
 * 阶段一只有两个只读接口：取上次报告、跑一次静态体检。
 */
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';
import { logger } from '../../shared/logger.js';
import { runStaticCheckup } from '../../features/project-checkup/index.js';
import { getProjectRecord, saveCheckup } from '../../store/optimize.js';

// ==== GET /api/optimize/report?dir=xxx ====
function handleReport(res, url) {
  const dir = str(url.searchParams.get('dir'));
  if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });
  const rec = getProjectRecord(dir);
  sendJson(res, 200, {
    report: rec?.lastCheckup || null,
    history: rec?.history || [],
  });
}

// ==== POST /api/optimize/checkup {dir} ====
function handleCheckup(req, res) {
  return withJsonBody(req, res, (data) => {
    const dir = str(data.dir);
    if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });

    let report;
    try {
      report = runStaticCheckup(dir);
    } catch (e) {
      logger.warn?.('[optimize] 体检失败', { dir, err: e.message });
      return sendJson(res, 400, { error: e.message });
    }

    saveCheckup(dir, report);
    sendJson(res, 200, { report });
  });
}

export function handleOptimizeRoutes(req, res, url) {
  if (url.pathname === '/api/optimize/report' && req.method === 'GET') {
    return handleReport(res, url);
  }
  if (url.pathname === '/api/optimize/checkup' && req.method === 'POST') {
    return handleCheckup(req, res);
  }
  return sendJson(res, 404, { error: 'not found' });
}
```

- [ ] **Step 2: 挂到主路由**

在 `src/entrypoints/web/server.js` 的 import 区（第 67 行 `import { handleMemoryRoutes }` 那行下方）加：

```js
import { handleOptimizeRoutes } from './routes-optimize.js';
```

在路由分发区（第 168 行 `if (url.pathname.startsWith('/api/memory/'))` 那行下方）加：

```js
  if (url.pathname.startsWith('/api/optimize/')) return handleOptimizeRoutes(req, res, url);
```

- [ ] **Step 3: 启动服务验证接口**

Run（终端 A 启动，终端 B 请求）：

```bash
npm start
```

```bash
curl -s -X POST http://127.0.0.1:3000/api/optimize/checkup -H "Content-Type: application/json" -d "{\"dir\":\"tests/fixtures/projects/kxmall-like\"}"
```

Expected: 返回 JSON，含 `report.score`、`report.dims.map.issues` 数组非空

> 端口若不是 3000，看启动日志里打印的实际端口。

- [ ] **Step 4: 验证 report 接口**

Run:
```bash
curl -s "http://127.0.0.1:3000/api/optimize/report?dir=tests/fixtures/projects/kxmall-like"
```
Expected: 返回上一步保存的报告，`history` 数组含 1 条记录

- [ ] **Step 5: 验证错误路径**

Run:
```bash
curl -s -X POST http://127.0.0.1:3000/api/optimize/checkup -H "Content-Type: application/json" -d "{\"dir\":\"C:/definitely/not/exist\"}"
```
Expected: HTTP 400，body 为 `{"error":"目录不存在或不可读"}`

- [ ] **Step 6: 改动留工作区，不提交**

---

## Task 11: 前端纯逻辑

**Files:**
- Create: `public/js/optimize-view.logic.js`
- Test: `public/js/optimize-view.logic.test.js`

- [ ] **Step 1: 写失败测试**

`public/js/optimize-view.logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIM_META, dimListFrom, severityRank, sortIssues } from './optimize-view.logic.js';

test('维度元信息覆盖五个维度且顺序固定', () => {
  assert.deepEqual(DIM_META.map((d) => d.key), ['map', 'prompts', 'rules', 'deadcode', 'comments']);
});

test('从报告生成维度列表，带上可勾选状态', () => {
  const report = {
    dims: {
      map: { score: 80, status: 'done', issues: [{ code: 'X' }] },
      prompts: { score: null, status: 'pending', issues: [] },
      rules: { score: 55, status: 'done', issues: [] },
      deadcode: { score: null, status: 'disabled', issues: [] },
      comments: { score: null, status: 'pending', issues: [] },
    },
  };
  const list = dimListFrom(report);
  assert.equal(list[0].key, 'map');
  assert.equal(list[0].scoreText, '80');
  assert.equal(list[0].selectable, true);
  assert.equal(list[0].issueCount, 1);

  // disabled 不可勾选
  const deadcode = list.find((d) => d.key === 'deadcode');
  assert.equal(deadcode.selectable, false);
  assert.equal(deadcode.scoreText, '--');

  // pending 不可勾选（还没结果，无从优化）
  assert.equal(list.find((d) => d.key === 'prompts').selectable, false);
});

test('报告为空时全部维度显示 --', () => {
  const list = dimListFrom(null);
  assert.equal(list.length, 5);
  assert.ok(list.every((d) => d.scoreText === '--' && d.selectable === false));
});

test('问题按严重度再按文件排序', () => {
  const issues = [
    { severity: 'info', file: 'b.md', line: 1 },
    { severity: 'error', file: 'a.md', line: 5 },
    { severity: 'warn', file: 'a.md', line: 2 },
  ];
  const sorted = sortIssues(issues);
  assert.deepEqual(sorted.map((i) => i.severity), ['error', 'warn', 'info']);
});

test('同严重度按文件名和行号排', () => {
  const issues = [
    { severity: 'warn', file: 'b.md', line: 1 },
    { severity: 'warn', file: 'a.md', line: 9 },
    { severity: 'warn', file: 'a.md', line: 2 },
  ];
  const sorted = sortIssues(issues);
  assert.deepEqual(sorted.map((i) => `${i.file}:${i.line}`), ['a.md:2', 'a.md:9', 'b.md:1']);
});

test('severityRank 未知值排最后', () => {
  assert.ok(severityRank('unknown') > severityRank('info'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test public/js/optimize-view.logic.test.js`
Expected: FAIL，`Cannot find module './optimize-view.logic.js'`

- [ ] **Step 3: 实现**

`public/js/optimize-view.logic.js`：

```js
/**
 * 项目优化面板的纯逻辑层：不碰 DOM，可在 node 下单测。
 */

export const DIM_META = [
  { key: 'map', label: '项目地图', hint: '地图是否建立、是否过期、引用是否失效' },
  { key: 'prompts', label: '提示词质量', hint: '规则是否过度宽泛、是否互相冲突' },
  { key: 'rules', label: '规范加载方式', hint: '大块规范是否该从 rules 降级为 skill' },
  { key: 'deadcode', label: '无用代码', hint: '即将支持' },
  { key: 'comments', label: '注释合理性', hint: '注释是否解释「为什么」、是否已过期' },
];

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

export function severityRank(s) {
  const r = SEVERITY_ORDER[s];
  return r === undefined ? 99 : r;
}

export function sortIssues(issues) {
  return [...(issues || [])].sort((a, b) => {
    const d = severityRank(a.severity) - severityRank(b.severity);
    if (d !== 0) return d;
    const f = String(a.file || '').localeCompare(String(b.file || ''));
    if (f !== 0) return f;
    return (a.line || 0) - (b.line || 0);
  });
}

/**
 * 把报告摊平成 UI 需要的维度列表。
 * selectable 的含义是「这个维度能不能参与一键优化」——只有跑出结果的才行。
 */
export function dimListFrom(report) {
  return DIM_META.map((meta) => {
    const d = report?.dims?.[meta.key];
    const status = d?.status || 'idle';
    const hasScore = typeof d?.score === 'number';
    return {
      ...meta,
      status,
      score: hasScore ? d.score : null,
      scoreText: hasScore ? String(d.score) : '--',
      issueCount: d?.issues?.length || 0,
      issues: sortIssues(d?.issues),
      reason: d?.reason || '',
      selectable: status === 'done',
    };
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test public/js/optimize-view.logic.test.js`
Expected: PASS，6 个测试全绿

- [ ] **Step 5: 改动留工作区，不提交**

---

## Task 12: UI 骨架（HTML + CSS）

**Files:**
- Modify: `public/index.html`（工具区约 54 行、面板区约 462 行）
- Modify: `public/app.css`（追加到文件末尾）

- [ ] **Step 1: 加侧栏入口**

在 `public/index.html` 第 54 行 `<button class="tool-item" id="toolMemory" data-tool="memory">` 所在的按钮**之后**，插入同级按钮：

```html
          <button class="tool-item" id="toolOptimize" data-tool="optimize">
            <span class="tool-name">项目优化</span>
            <span class="tool-desc">体检并修复拖慢 AI 的配置问题</span>
          </button>
```

> 内部 span 的 class 名需与 `#toolMemory` 按钮内实际使用的保持一致。执行前先读第 54-60 行确认，若结构不同则照抄该结构。

- [ ] **Step 2: 加面板容器**

在 `public/index.html` 第 462 行 `<div class="panel-page" data-view="memory" hidden>` 这个 div **闭合之后**，插入：

```html
        <div class="panel-page" data-view="optimize" hidden>
          <div class="panel-head">
            <h3>项目优化</h3>
            <button class="panel-close">✕</button>
          </div>

          <div class="opt-body">
            <div class="opt-picker">
              <label for="optDirInput">项目目录</label>
              <input id="optDirInput" type="text" placeholder="选择或输入项目绝对路径" />
              <button id="optPickDir" class="btn-ghost">浏览…</button>
            </div>

            <div class="opt-score">
              <div class="opt-ring" id="optRing">
                <span class="opt-ring-num" id="optScoreNum">--</span>
              </div>
              <div class="opt-score-side">
                <div class="opt-grade" id="optGrade">未体检</div>
                <div class="opt-issue-count" id="optIssueCount"></div>
                <div class="opt-last-at" id="optLastAt"></div>
              </div>
              <button id="optRunCheckup" class="btn-primary">体检</button>
            </div>

            <div class="opt-dims" id="optDims"></div>

            <div class="opt-actions">
              <button id="optFix" class="btn-primary" disabled>一键优化</button>
              <span class="opt-phase-note">阶段一仅支持体检，一键优化即将开放</span>
            </div>
          </div>
        </div>
```

- [ ] **Step 3: 加样式**

追加到 `public/app.css` 末尾：

```css
/* ===== 项目优化面板 ===== */
:root { --danger: #e5534b; }

.opt-body { padding: 16px; display: flex; flex-direction: column; gap: 16px; }

.opt-picker { display: flex; align-items: center; gap: 8px; }
.opt-picker label { color: var(--muted); font-size: 13px; white-space: nowrap; }
.opt-picker input { flex: 1; padding: 6px 10px; }

.opt-score { display: flex; align-items: center; gap: 16px; }
.opt-ring {
  width: 96px; height: 96px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  border: 6px solid var(--faint);
  transition: border-color .3s ease;
}
.opt-ring.is-healthy { border-color: var(--green); }
.opt-ring.is-good { border-color: var(--accent-hi); }
.opt-ring.is-needs-work { border-color: var(--amber); }
.opt-ring.is-poor { border-color: var(--danger); }
.opt-ring-num { font-size: 28px; font-weight: 600; }

.opt-score-side { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.opt-grade { font-size: 15px; font-weight: 600; }
.opt-issue-count, .opt-last-at { color: var(--muted); font-size: 12px; }

.opt-dims { display: flex; flex-direction: column; gap: 8px; }

.opt-dim {
  border: 1px solid var(--faint); border-radius: 6px; padding: 10px 12px;
}
.opt-dim.is-disabled { opacity: .45; }
.opt-dim-head { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.opt-dim-head input[type="checkbox"] { cursor: pointer; }
.opt-dim-label { font-weight: 500; }
.opt-dim-hint { color: var(--muted); font-size: 12px; flex: 1; }
.opt-dim-score { font-size: 18px; font-weight: 600; min-width: 36px; text-align: right; }
.opt-dim-badge { color: var(--muted); font-size: 12px; }

.opt-issues { margin-top: 8px; display: none; flex-direction: column; gap: 4px; }
.opt-dim.is-open .opt-issues { display: flex; }
.opt-issue { display: flex; gap: 8px; font-size: 12px; align-items: baseline; }
.opt-issue-sev { min-width: 40px; }
.opt-issue-sev.sev-error { color: var(--danger); }
.opt-issue-sev.sev-warn { color: var(--amber); }
.opt-issue-sev.sev-info { color: var(--muted); }
.opt-issue-loc { color: var(--accent-hi); white-space: nowrap; }
.opt-issue-msg { color: var(--muted); }

.opt-actions { display: flex; align-items: center; gap: 12px; }
.opt-phase-note { color: var(--muted); font-size: 12px; }
```

> `--danger` 是新增变量。若 `app.css` 顶部已有 `:root` 块，把这一行并进去而不是新开一个 `:root`。

- [ ] **Step 4: 视觉验证**

启动 `npm start`，浏览器打开执行台，点侧栏「项目优化」。
Expected: 面板能打开，显示目录输入框、灰色圆环显示 `--`、五张维度卡片区为空、底部按钮禁用。

- [ ] **Step 5: 改动留工作区，不提交**

---

## Task 13: 面板逻辑

**Files:**
- Create: `public/js/optimize-view.js`
- Modify: `public/app.js`（import 区约 16 行、showView 分支约 54 行、工具绑定约 104 行）

- [ ] **Step 1: 实现面板**

`public/js/optimize-view.js`：

```js
/**
 * 项目优化面板。阶段一只做体检展示，一键优化按钮保持禁用。
 *
 * 安全约定：所有来自后端/LLM 的文本一律 createElement + textContent 渲染，
 * 禁止 innerHTML 拼接（本项目硬性约定）。
 */
import { $ } from './util.js';
import { toast } from './toast.js';
import { dimListFrom } from './optimize-view.logic.js';

let inited = false;
let currentReport = null;

const GRADE_LABEL = {
  healthy: '健康',
  good: '良好',
  'needs-work': '需优化',
  poor: '较差',
};

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function renderScore(report) {
  const ring = $('#optRing');
  const num = $('#optScoreNum');
  const grade = $('#optGrade');
  const count = $('#optIssueCount');
  const lastAt = $('#optLastAt');

  ring.className = 'opt-ring';
  if (!report || typeof report.score !== 'number') {
    num.textContent = '--';
    grade.textContent = '未体检';
    count.textContent = '';
    lastAt.textContent = '';
    return;
  }

  num.textContent = String(report.score);
  ring.classList.add(`is-${report.grade}`);
  grade.textContent = GRADE_LABEL[report.grade] || '';
  count.textContent = `发现 ${report.issueCount} 项问题`;
  lastAt.textContent = `上次体检 ${new Date(report.at).toLocaleString()}`;
}

function renderIssues(box, issues) {
  for (const it of issues) {
    const row = el('div', 'opt-issue');
    row.appendChild(el('span', `opt-issue-sev sev-${it.severity}`, it.severity));
    row.appendChild(el('span', 'opt-issue-loc', `${it.file}:${it.line}`));
    row.appendChild(el('span', 'opt-issue-msg', it.message));
    box.appendChild(row);
  }
}

function renderDims(report) {
  const host = $('#optDims');
  host.textContent = '';

  for (const d of dimListFrom(report)) {
    const card = el('div', 'opt-dim');
    if (d.status === 'disabled') card.classList.add('is-disabled');

    const head = el('div', 'opt-dim-head');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = d.selectable;      // 默认全选（可选的才选中）
    cb.disabled = !d.selectable;
    head.appendChild(cb);

    head.appendChild(el('span', 'opt-dim-label', d.label));

    // pending / disabled 用文案说明为什么没分，避免用户以为坏了
    const hintText = d.status === 'done' ? d.hint : d.reason || d.hint;
    head.appendChild(el('span', 'opt-dim-hint', hintText));

    if (d.issueCount > 0) head.appendChild(el('span', 'opt-dim-badge', `${d.issueCount} 项`));
    head.appendChild(el('span', 'opt-dim-score', d.scoreText));

    // 点头部展开问题清单；勾选框自己的点击不应触发展开
    head.addEventListener('click', (e) => {
      if (e.target === cb) return;
      if (d.issueCount > 0) card.classList.toggle('is-open');
    });

    card.appendChild(head);

    if (d.issueCount > 0) {
      const box = el('div', 'opt-issues');
      renderIssues(box, d.issues);
      card.appendChild(box);
    }

    host.appendChild(card);
  }
}

function render() {
  renderScore(currentReport);
  renderDims(currentReport);
}

async function loadReport(dir) {
  if (!dir) { currentReport = null; render(); return; }
  try {
    const r = await fetch(`/api/optimize/report?dir=${encodeURIComponent(dir)}`);
    const data = await r.json();
    currentReport = data.report;
  } catch {
    currentReport = null;
  }
  render();
}

async function runCheckup() {
  const dir = $('#optDirInput').value.trim();
  if (!dir) { toast('请先选择项目目录'); return; }

  const btn = $('#optRunCheckup');
  btn.disabled = true;
  btn.textContent = '体检中…';

  try {
    const r = await fetch('/api/optimize/checkup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    });
    const data = await r.json();
    if (!r.ok) { toast(data.error || '体检失败'); return; }
    currentReport = data.report;
    localStorage.setItem('optimize.lastDir', dir);
    render();
  } catch (e) {
    toast('体检失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '体检';
  }
}

export function initOptimizePanel() {
  if (!inited) {
    inited = true;
    $('#optRunCheckup')?.addEventListener('click', runCheckup);
    $('#optDirInput')?.addEventListener('change', (e) => loadReport(e.target.value.trim()));

    // 浏览目录：复用已有的目录选择接口
    $('#optPickDir')?.addEventListener('click', async () => {
      try {
        const r = await fetch('/api/dirs/pick', { method: 'POST' });
        const data = await r.json();
        if (data.dir) {
          $('#optDirInput').value = data.dir;
          loadReport(data.dir);
        }
      } catch {
        toast('打开目录选择器失败，可直接粘贴路径');
      }
    });

    const last = localStorage.getItem('optimize.lastDir');
    if (last) $('#optDirInput').value = last;
  }

  loadReport($('#optDirInput').value.trim());
}
```

> `/api/dirs/pick` 的实际请求方法（GET 还是 POST）和返回字段名需在执行时核对 `src/entrypoints/web/routes-files.js`，若不符按实际调整。

- [ ] **Step 2: 接进 app.js**

在 `public/app.js` 第 16 行（`import { initMemoryPanel, refreshMemBadge } from './js/memory-view.js';`）下方加：

```js
import { initOptimizePanel } from './js/optimize-view.js';
```

在第 54 行（`else if (name === 'memory') initMemoryPanel();`）下方加：

```js
        else if (name === 'optimize') initOptimizePanel();
```

在第 104 行（`$('#toolMemory')?.addEventListener(...)`）下方加：

```js
        $('#toolOptimize')?.addEventListener('click', () => showView('optimize'));
```

- [ ] **Step 3: 端到端验证**

启动 `npm start`，打开执行台：

1. 点侧栏「项目优化」→ 面板打开
2. 目录框粘贴 `C:/Users/DELL/Desktop/kxmall-app-ui` → 回车
3. 点「体检」

Expected:
- 1 秒内出分，圆环有颜色
- 「项目地图」和「规范加载方式」两张卡有分数
- 「提示词质量」「注释合理性」显示「阶段二支持」且勾选框禁用
- 「无用代码」灰色，显示「即将支持」
- 点有问题数的卡片能展开问题清单，每条显示 `文件:行号` + 说明

- [ ] **Step 4: 验证刷新后状态保持**

刷新页面 → 重新点「项目优化」
Expected: 目录框自动填上次的路径，且自动加载出上次的报告（不需要重新体检）

- [ ] **Step 5: 跑全量测试**

Run: `npm test`
Expected: 全绿，无新增失败

- [ ] **Step 6: 改动留工作区，不提交**

---

## Task 14: 收尾验证

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 2: 对本仓库自体检（吃自己的狗粮）**

在面板里对 `C:/Users/DELL/Desktop/claude-p-web-demo` 自身跑一次体检。
Expected: 出分且不崩。记录分数——这是本工具的第一个真实基线。

- [ ] **Step 3: 确认改动清单**

Run: `git status --short`
Expected: 只包含本计划涉及的文件，无意外改动。

- [ ] **Step 4: 交付说明**

向用户汇报：改动留工作区未提交，阶段一可用范围（只有静态体检），以及对两个真实项目的体检分数。

---

## 自查结果

**Spec 覆盖检查（对照 `2026-08-24-project-optimize-design.md`）：**

| Spec 章节 | 阶段一覆盖情况 |
|---|---|
| §4 维度① 地图 | ✅ Task 5/6 全部五个检测项 M1-M5 |
| §4 维度② 提示词 | ⏭ 阶段二（UI 占位已做） |
| §4 维度③ rules 降级 | ✅ Task 3/4 |
| §4 维度④ 无用代码 | ✅ 按 spec 置灰（Task 11/13） |
| §4 维度⑤ 注释 | ⏭ 阶段二（UI 占位已做） |
| §5 评分模型 | ✅ Task 7，含 N/A 权重重分配与档位映射 |
| §6 一键优化 | ⏭ 阶段三/四 |
| §7 架构 | ✅ 静态部分同步返回已实现；SSE 属阶段二 |
| §8 数据结构 | ✅ Task 9（backups 字段阶段三才写入） |
| §9 API 契约 | ✅ report / checkup 两个；其余属后续阶段 |
| §10 UI 规格 | ✅ Task 12/13；diff 弹层属阶段四；趋势线阶段一未做（history 数据已存） |
| §11 错误处理 | ✅ 目录不存在、非 Claude 项目两条；LLM 相关属阶段二 |
| §12 测试策略 | ✅ Task 1 夹具 + 四个 logic 层单测 |

**已知的阶段一缺口（有意为之，非遗漏）：** 迷你趋势线（数据已存但未渲染）、一键优化按钮（禁用占位）。

**类型一致性检查：** 各维度结果统一为 `{score, status, issues[], reason?}`；issue 统一为 `{code, severity, file, line, message, fixable, fixHint}`；`status` 取值集合固定为 `done | pending | na | disabled`（阶段二会增加 `timeout | error`）。前后端共用同一组字段名，`dimListFrom` 消费的字段与 `runStaticCheckup` 产出的字段已逐一核对一致。

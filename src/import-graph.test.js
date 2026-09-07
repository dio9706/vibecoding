/**
 * 全仓 import 图的架构护栏。
 *
 * ## 为什么需要它
 *
 * 2026-09-04 的体检在 `team-tools` 里检出两个真实 import 环：
 *
 * ```
 * task-ops → task-notify → auto-dev/index → task-ops     （三文件环）
 * task-notify ⇄ auto-dev/index                            （二文件环）
 * ```
 *
 * 它们不是谁写错了一行，而是「入队 API 和执行管线住在同一个文件里」这个结构必然导出的结果：
 * 通知模块要入队 → 只能 import 整个执行管线 → 而执行管线完成后要发通知卡片。
 * 修法是把入队 API 拆成零重依赖叶子（`auto-dev/queue.js`）。
 *
 * 但**结构性问题会以同样的形状复发**——下一个人只要图省事从 `auto-dev/index.js` 引一次入队，
 * 环就原样回来。而 ESM 环的后果是顶层求值顺序不可预期，`src/app/CLAUDE.md` 记着
 * 这个项目已经为此吃过一次亏（「ESM 循环 + 顶层 await 会死锁在模块图上」）。
 * 靠人盯不住，所以钉成测试。
 *
 * ## 复用体检维度的纯函数
 *
 * `extractImports` / `findCycles` 就是 `structure` 维度用来扫依赖图的那两个函数。
 * 这里直接复用，好处是**这条护栏与体检用的是同一份实现**：护栏绿而体检报环（或反之）
 * 这种自相矛盾的情况不可能发生。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractImports, findCycles, resolveRelative,
} from './features/project-checkup/evidence/selectors-project.logic.js';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/** 收集 src 下全部 js/mjs，路径统一为 `src/...` 正斜杠形式（与 extractImports 的口径一致） */
function collectSources() {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const nextAbs = path.join(abs, e.name);
      const nextRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(nextAbs, nextRel);
      else if (/\.m?js$/.test(e.name)) out.push({ rel: `src/${nextRel}`, abs: nextAbs });
    }
  };
  walk(ROOT, '');
  return out;
}

const SOURCES = collectSources();
const KNOWN = new Set(SOURCES.map((f) => f.rel));

/** `./a` → `./a.js`：import 里常省扩展名，不补全会让边整条丢失（丢边 = 漏环） */
function resolveToKnown(target) {
  if (KNOWN.has(target)) return target;
  for (const ext of ['.js', '.mjs']) if (KNOWN.has(target + ext)) return target + ext;
  for (const idx of ['/index.js', '/index.mjs']) if (KNOWN.has(target + idx)) return target + idx;
  return null;
}

function buildGraph() {
  const graph = new Map();
  for (const f of SOURCES) {
    const text = fs.readFileSync(f.abs, 'utf8');
    const deps = [];
    for (const imp of extractImports(text, f.rel)) {
      if (!imp.relative) continue;
      const hit = resolveToKnown(imp.target);
      if (hit && hit !== f.rel) deps.push(hit);
    }
    graph.set(f.rel, deps);
  }
  return graph;
}

test('src 下不存在 import 环', () => {
  const cycles = findCycles(buildGraph());
  const rendered = cycles.map((c) => `\n  ${c.join('\n  → ')}\n  → ${c[0]}`).join('\n');
  assert.equal(
    cycles.length,
    0,
    `检出 ${cycles.length} 个 import 环：${rendered}\n`
    + 'ESM 环下顶层求值顺序不可预期（本项目已为此吃过一次亏，见 src/app/CLAUDE.md §C）。'
    + '断环的常规手法是把「被双方共用的那一小块」拆成零依赖叶子——'
    + '参照 src/app/signals.js 与 src/plugins/team-tools/auto-dev/queue.js。',
  );
});

test('两个刻意的零依赖叶子必须保持零 import（下层可 import 上层这条例外的前提）', () => {
  // 根 CLAUDE.md 的通则是「下层不得 import 上层」，而这两个文件被下层 import
  // 是刻意允许的例外（理由见 src/app/CLAUDE.md §C）。例外成立的**唯一**前提是它们零依赖：
  // 一旦其中任何一个开始 import（哪怕只是 logger），下层对它的引用就变成真实的反向依赖
  for (const rel of ['src/app/signals.js', 'src/app/intent-keywords.js']) {
    const text = fs.readFileSync(path.join(ROOT, '..', rel), 'utf8');
    const imports = extractImports(text, rel);
    assert.deepEqual(
      imports.map((i) => i.spec),
      [],
      `${rel} 出现了 import：${imports.map((i) => i.spec).join(', ')}。`
      + '它被下层模块 import，零依赖是那条例外成立的前提；要加依赖请先把调用方改成不依赖它。',
    );
  }
});

test('auto-dev/queue.js 只许依赖 store/tasks（破了纪律 import 环会原样回来）', () => {
  const rel = 'src/plugins/team-tools/auto-dev/queue.js';
  const text = fs.readFileSync(path.join(ROOT, '..', rel), 'utf8');
  const targets = extractImports(text, rel)
    .filter((i) => i.relative)
    .map((i) => i.target);
  assert.deepEqual(
    targets,
    ['src/store/tasks.js'],
    `${rel} 的依赖变成了 ${targets.join(', ')}。`
    + '它是入队 API 的零重依赖叶子，一旦引入 git / 网络 / LLM，'
    + 'task-notify 与执行管线的环就会复活——新东西请放进 auto-dev/index.js。',
  );
});

test('resolveRelative 与本护栏的路径口径一致（自检，防护栏本身失效）', () => {
  // 护栏靠解析相对 import 建图。如果解析口径与被测代码不一致，
  // 边会整条丢失，而丢边的表现是「护栏永远绿」——最坏的那种失效
  assert.equal(resolveRelative('src/a/b.js', '../c/d.js'), 'src/c/d.js');
  assert.ok(SOURCES.length > 50, `只扫到 ${SOURCES.length} 个源文件，路径口径可能不对`);
  assert.ok(KNOWN.has('src/app/dispatch.js'), '扫不到已知文件，说明路径拼装错了');
});

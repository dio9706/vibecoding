import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPathRefs, candidatePaths, evaluateMap, STALE_DAYS } from './check-map.logic.js';

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
  assert.deepEqual(extractPathRefs('见 `src/a.js:12-34`'), [{ ref: 'src/a.js', line: 1 }]);
});

test('跳过 glob 字面量,避免假死链', () => {
  assert.deepEqual(extractPathRefs('规则 `src/**/*.vue` 和 `src/**/*.scss`'), []);
  assert.deepEqual(extractPathRefs('见 `docs/a_*.csv`'), []);
});

test('跳过含尖括号的占位符模板', () => {
  assert.deepEqual(extractPathRefs('读 `src/api/<业务域>/`'), []);
});

test('src/ 和 .claude/ 开头的目录引用要提取(模块路由表就是这种)', () => {
  assert.deepEqual(extractPathRefs('见 `src/pages/` 和 `.claude/rules/`'), [
    { ref: 'src/pages/', line: 1 },
    { ref: '.claude/rules/', line: 1 },
  ]);
});

test('无明确前缀的目录引用仍然跳过', () => {
  // 这类是概念性指代，解析基准不确定，上一轮实测是误报来源
  assert.deepEqual(extractPathRefs('封装在 `request/`，文档投到 `.uploads/`'), []);
  assert.deepEqual(extractPathRefs('见 `today-food/components/`'), []);
});

test('含尖括号的 src/ 目录引用仍被占位符规则拦下', () => {
  assert.deepEqual(extractPathRefs('读 `src/api/<业务域>/`'), []);
});

test('概念性目录指代不当作路径引用', () => {
  assert.deepEqual(extractPathRefs('封装在 `request/`，文档放 `.uploads/`'), []);
});

test('无扩展名且无斜杠的普通词不算路径', () => {
  assert.deepEqual(extractPathRefs('变量 `foo`，符号 `bar`'), []);
});

test('csv 等扩展名在白名单内', () => {
  assert.deepEqual(extractPathRefs('见 `docs/report.csv`'), [{ ref: 'docs/report.csv', line: 1 }]);
});

test('brace 展开记法不当作路径', () => {
  assert.deepEqual(extractPathRefs('见 `a/plate-picker-{cocreate,text2plate}.vue`'), []);
});

test('范围简写记法不当作路径', () => {
  assert.deepEqual(extractPathRefs('见 `supp-step1~3/index.vue`'), []);
});

test('xxx 占位符段不当作路径', () => {
  assert.deepEqual(extractPathRefs('见 `.claude/rules/xxx.md`'), []);
  assert.deepEqual(extractPathRefs('放 `src/api/xxx/`'), []);
  assert.deepEqual(extractPathRefs('加 `__tests__/xxx.test.ts`'), []);
});

test('xxx 只按整段匹配,不误伤真实文件名', () => {
  // xxxService.ts 是合法命名，不该被当占位符跳过
  assert.deepEqual(extractPathRefs('见 `src/xxxService.ts`'), [
    { ref: 'src/xxxService.ts', line: 1 },
  ]);
});

test('候选路径包含原样和 src/ 前缀两种', () => {
  assert.deepEqual(candidatePaths('hooks/a.ts'), ['hooks/a.ts', 'src/hooks/a.ts']);
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
  assert.equal(r.score, 80); // 基础 60 + 覆盖率 1.0 × 20
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

test('刚好等于阈值不算过期', () => {
  const r = evaluateMap({
    hasRootMap: true,
    modules: [{ name: 'alpha', hasMap: true, staleDays: STALE_DAYS }],
    deadLinks: [],
    rootMapLines: 50,
  });
  assert.equal(r.score, 80);
  assert.equal(r.issues.length, 0);
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

test('死链扣分有下限 15', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ file: 'CLAUDE.md', line: i + 1, ref: 'x' + i }));
  const r = evaluateMap({
    hasRootMap: true,
    modules: [{ name: 'alpha', hasMap: true, staleDays: 0 }],
    deadLinks: many,
    rootMapLines: 50,
  });
  assert.equal(r.score, 65); // 80 - 15(封顶)
});

test('过期扣分有下限 20', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ name: 'm' + i, hasMap: true, staleDays: 99 }));
  const r = evaluateMap({ hasRootMap: true, modules: many, deadLinks: [], rootMapLines: 50 });
  assert.equal(r.score, 60); // 80 - 20(封顶)
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

test('根地图 200-300 行扣 5 分', () => {
  const r = evaluateMap({
    hasRootMap: true,
    modules: [{ name: 'alpha', hasMap: true, staleDays: 0 }],
    deadLinks: [],
    rootMapLines: 250,
  });
  assert.equal(r.score, 75);
});

test('没有可统计的模块时覆盖率算满分', () => {
  const r = evaluateMap({ hasRootMap: true, modules: [], deadLinks: [], rootMapLines: 10 });
  assert.equal(r.score, 80);
});

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

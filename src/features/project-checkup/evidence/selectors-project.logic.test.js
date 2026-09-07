import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRelative, packageNameOf, isRelative, extractImports, layerOf, findCycles,
  recallImportGraph, recallDepManifest, recallOnboardingDocs, recallSuspiciousTracked,
} from './selectors-project.logic.js';

test('resolveRelative 用正斜杠解出仓库内路径', () => {
  assert.equal(resolveRelative('src/a/b.js', '../c/d.js'), 'src/c/d.js');
  assert.equal(resolveRelative('src/a/b.js', './e.js'), 'src/a/e.js');
  assert.equal(resolveRelative('a.js', './b.js'), 'b.js');
  assert.equal(resolveRelative('src/a/b/c.js', '../../x.js'), 'src/x.js');
});

test('packageNameOf 保留 scope、剥掉子路径', () => {
  assert.equal(packageNameOf('lodash/get'), 'lodash');
  assert.equal(packageNameOf('@anthropic-ai/claude-agent-sdk'), '@anthropic-ai/claude-agent-sdk');
  assert.equal(packageNameOf('node:fs'), 'fs');
});

test('isRelative 只认 . 与 / 开头', () => {
  assert.ok(isRelative('./a'));
  assert.ok(isRelative('../a'));
  assert.ok(!isRelative('lodash'));
});

test('extractImports 覆盖 ESM / CJS / 动态 / Python / Go', () => {
  const specs = extractImports([
    "import fs from 'node:fs';",
    "import { a } from './a.js';",
    "export { b } from './b.js';",
    "const c = require('./c.js');",
    "await import('./d.js');",
  ].join('\n'), 'src/x.js').map((i) => i.spec).sort();
  assert.deepStrictEqual(specs, ['./a.js', './b.js', './c.js', './d.js', 'node:fs']);

  const py = extractImports('from pkg.mod import thing\nimport os\n', 'm.py').map((i) => i.spec).sort();
  assert.deepStrictEqual(py, ['os', 'pkg.mod']);
});

test('extractImports 跳过注释行里的 import 字样', () => {
  const out = extractImports("// import { x } from './nope.js';\nimport { y } from './yes.js';", 'a.js');
  assert.deepStrictEqual(out.map((i) => i.spec), ['./yes.js']);
});

test('layerOf 取前两段路径作为层', () => {
  assert.equal(layerOf('src/features/a/b.js'), 'src/features');
  assert.equal(layerOf('src/a.js'), 'src/a.js');
  assert.equal(layerOf('server.js'), 'server.js');
});

test('findCycles 找到环且同一个环只报一次', () => {
  const g = new Map([
    ['a', ['b']],
    ['b', ['c']],
    ['c', ['a']],
    ['d', ['a']],
  ]);
  const cycles = findCycles(g);
  assert.equal(cycles.length, 1);
  assert.deepStrictEqual([...cycles[0]].sort(), ['a', 'b', 'c']);
});

test('findCycles 无环时返回空', () => {
  assert.deepStrictEqual(findCycles(new Map([['a', ['b']], ['b', []]])), []);
});

test('recallImportGraph 把跨层依赖聚合成「目录对」而不是逐文件', () => {
  const files = [
    { rel: 'src/entrypoints/a.js', text: "import { x } from '../store/s.js';" },
    { rel: 'src/entrypoints/b.js', text: "import { y } from '../store/s.js';" },
    { rel: 'src/store/s.js', text: 'export const x = 1; export const y = 2;' },
  ];
  const { candidates, sharedContext } = recallImportGraph({ files, conventions: 'A → B 单向' });
  const edges = candidates.filter((c) => c.meta.kind === 'layer-edge');
  assert.equal(edges.length, 1, '两个文件同一条边，只该产出一条候选');
  assert.equal(edges[0].meta.count, 2);
  assert.equal(edges[0].meta.from, 'src/entrypoints');
  assert.equal(edges[0].meta.to, 'src/store');
  assert.ok(sharedContext.includes('A → B 单向'));
});

test('recallImportGraph 无扩展名的 import 也能对上磁盘文件', () => {
  const files = [
    { rel: 'src/app/a.js', text: "import { x } from '../lib/mod';" },
    { rel: 'src/lib/mod.js', text: 'export const x = 1;' },
  ];
  const edges = recallImportGraph({ files }).candidates.filter((c) => c.meta.kind === 'layer-edge');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].meta.to, 'src/lib');
});

test('recallImportGraph 把 import 环单独列为候选', () => {
  const files = [
    { rel: 'src/a/one.js', text: "import './two.js';" },
    { rel: 'src/a/two.js', text: "import './one.js';" },
  ];
  const cycles = recallImportGraph({ files }).candidates.filter((c) => c.meta.kind === 'import-cycle');
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].meta.cycle.length, 2);
});

test('recallDepManifest 分出未使用 / 缺失，并附一条整体重复候选', () => {
  const { candidates } = recallDepManifest({
    files: [{ rel: 'src/a.js', text: "import axios from 'axios';\nimport lodash from 'lodash/get';\nimport fs from 'node:fs';" }],
    manifest: { file: 'package.json', deps: { axios: '^1', unusedpkg: '^2' }, devDeps: {} },
  });
  const kinds = candidates.map((c) => c.meta.kind);
  assert.ok(kinds.includes('unused-dep'));
  assert.equal(candidates.find((c) => c.meta.kind === 'unused-dep').meta.name, 'unusedpkg');
  assert.equal(candidates.find((c) => c.meta.kind === 'missing-dep').meta.name, 'lodash');
  assert.equal(kinds.filter((k) => k === 'dep-overlap').length, 1);
  assert.ok(!kinds.includes('missing-dep') || !candidates.some((c) => c.meta.name === 'fs'), 'node 内建不算缺依赖');
});

test('recallDepManifest 没有清单时不产出任何候选', () => {
  assert.deepStrictEqual(recallDepManifest({ files: [], manifest: null }).candidates, []);
});

test('recallOnboardingDocs 缺 README 直接一条候选，并把真实脚本放进共享上下文', () => {
  const { candidates, sharedContext } = recallOnboardingDocs({
    readme: null,
    manifest: { scripts: { start: 'node server.js' } },
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].meta.kind, 'no-readme');
  assert.ok(sharedContext.includes('node server.js'));
});

test('recallOnboardingDocs 逐个命令块成候选，非命令的代码块不收', () => {
  const md = [
    '# Demo',
    '```bash',
    'npm install',
    'npm start',
    '```',
    '```js',
    'const a = 1;',
    '```',
  ].join('\n');
  const { candidates } = recallOnboardingDocs({
    readme: { rel: 'README.md', text: md },
    manifest: { scripts: { start: 'node server.js' } },
  });
  const blocks = candidates.filter((c) => c.meta.kind === 'command-block');
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].text.includes('npm install'));
  assert.ok(!blocks[0].text.includes('const a = 1'));
});

test('recallOnboardingDocs 有 README 但没有任何命令 → 单独一条候选', () => {
  const { candidates } = recallOnboardingDocs({
    readme: { rel: 'README.md', text: '# Demo\n\n这是一个项目。' },
    manifest: null,
  });
  assert.deepStrictEqual(candidates.map((c) => c.meta.kind), ['no-commands']);
});

test('recallSuspiciousTracked 补召回率，但跳过确定性规则已覆盖的与夹具', () => {
  const { candidates } = recallSuspiciousTracked({
    tracked: [
      { rel: 'src/a.js', size: 100 },
      { rel: 'cobe-probe.tmp.mjs', size: 100 },
      { rel: 'notes.bak', size: 100 },
      { rel: 'data.jsonl', size: 100 },
      { rel: 'tmp-thing.mjs', size: 100 },
      { rel: 'tests/fixtures/big.bin', size: 5 * 1024 * 1024 },
      { rel: 'assets/huge.psd', size: 3 * 1024 * 1024 },
    ],
  });
  const rels = candidates.map((c) => c.file).sort();
  assert.deepStrictEqual(rels, ['assets/huge.psd', 'cobe-probe.tmp.mjs', 'notes.bak']);
});

test('recallImportGraph 带出相关模块自己的文档（分层例外只写在那里）', () => {
  // 实测事故（2026-09-04）：根文档写「下层不得 import 上层」，而 src/shared/CLAUDE.md
  // 写明 config/messages/bot-activity「刻意反向 import」并给了理由。
  // 只喂根文档，这两条有据可依的设计就被判成了违规
  const files = [
    { rel: 'src/shared/bot-activity.js', text: "import { x } from '../store/settings.js';" },
    { rel: 'src/store/settings.js', text: 'export const x = 1;' },
  ];
  const { sharedContext } = recallImportGraph({
    files,
    conventions: '下层不得 import 上层',
    moduleConventions: {
      'src/shared': '这里的 config / bot-activity **刻意反向 import** store，为了让埋点只有一个出口。',
      'src/plugins': '与本轮候选无关的文档',
    },
  });

  assert.match(sharedContext, /刻意反向 import/, '例外原文必须进 prompt');
  assert.match(sharedContext, /src\/shared` 自己的模块文档/);
  assert.ok(!sharedContext.includes('与本轮候选无关的文档'), '无关模块的文档不该挤占注意力');
});

test('recallImportGraph 明确告知「目录级反向边不等于 import 环」', () => {
  // 模型据两条方向相反的目录边推断出了一个不存在的环，还描述了它的「后果」。
  // 实地核对：那几个文件的可达图完全无环
  const { sharedContext } = recallImportGraph({ files: [], conventions: 'x' });
  assert.match(sharedContext, /不等于存在 import 环/);
  assert.match(sharedContext, /真正的文件级环会作为独立的「import 环」候选单独给出/);
});

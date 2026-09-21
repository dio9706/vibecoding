import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByModule, buildRetestList, firstParagraph } from './retest.logic.js';

// ---------- groupByModule ----------

test('groupByModule：按目录归拢改动文件', () => {
  const out = groupByModule(['src/app/dispatch.js', 'src/app/intent.js', 'public/js/chat.js']);
  assert.deepEqual(out, {
    'src/app': ['src/app/dispatch.js', 'src/app/intent.js'],
    'public/js': ['public/js/chat.js'],
  });
});

test('groupByModule：Windows 反斜杠路径归一为正斜杠', () => {
  // 后端在 win32 下产出的 file 可能带反斜杠，不归一会和 posix 路径分成两组
  assert.deepEqual(groupByModule(['src\\app\\dispatch.js']), { 'src/app': ['src/app/dispatch.js'] });
});

test('groupByModule：根目录文件归到 "."', () => {
  assert.deepEqual(groupByModule(['README.md']), { '.': ['README.md'] });
});

test('groupByModule：空值与脏值不炸', () => {
  assert.deepEqual(groupByModule([]), {});
  assert.deepEqual(groupByModule(null), {});
  assert.deepEqual(groupByModule(['', null, undefined]), {});
});

// ---------- firstParagraph ----------

test('firstParagraph：取正文首段，跳过标题', () => {
  const md = '# src/app · 模块地图\n\n本目录负责分发与意图识别。\n\n第二段不要。';
  assert.equal(firstParagraph(md), '本目录负责分发与意图识别。');
});

test('firstParagraph：引用块是导读，剥掉标记当职责用而不是跳过', () => {
  // src/entrypoints/CLAUDE.md 就是这个结构：标题之后紧跟 > 导读块写明模块职责。
  // 跳过它会取到下方某个实现细节段落，那不是职责描述
  const md = '# src/entrypoints · 模块地图\n\n> 本目录是「渠道 → 业务」之间的组装层。\n\n## 一、文件清单';
  assert.equal(firstParagraph(md), '本目录是「渠道 → 业务」之间的组装层。');
});

test('firstParagraph：跳过列表、表格与代码围栏', () => {
  const md = '# 标题\n\n- 列表项\n\n| 表 | 头 |\n\n```js\ncode\n```\n\n真正的职责描述。';
  assert.equal(firstParagraph(md), '真正的职责描述。');
});

test('firstParagraph：没有正文时返回空串（不编造）', () => {
  assert.equal(firstParagraph('# 只有标题'), '');
  assert.equal(firstParagraph(''), '');
  assert.equal(firstParagraph(null), '');
});

// ---------- buildRetestList ----------

test('buildRetestList：有地图就带职责，没有就只列文件', () => {
  const out = buildRetestList(
    ['src/app/dispatch.js', 'scripts/foo.js'],
    { 'src/app': '本目录负责分发与意图识别。' },
  );
  assert.deepEqual(out, [
    { dir: 'scripts', responsibility: '', files: ['scripts/foo.js'] },
    { dir: 'src/app', responsibility: '本目录负责分发与意图识别。', files: ['src/app/dispatch.js'] },
  ]);
});

test('buildRetestList：按目录名排序，输出稳定', () => {
  const out = buildRetestList(['z/a.js', 'a/b.js', 'm/c.js'], {});
  assert.deepEqual(out.map((m) => m.dir), ['a', 'm', 'z']);
});

test('buildRetestList：空改动返回空数组', () => {
  assert.deepEqual(buildRetestList([], {}), []);
  assert.deepEqual(buildRetestList(null), []);
});

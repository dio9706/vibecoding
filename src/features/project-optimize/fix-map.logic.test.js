import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDeadLinkTarget, rewriteRefInLine, upsertStaleAudit, STALE_AUDIT_ANCHOR,
  selectFixableMap, planMapFix,
} from './fix-map.logic.js';

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

// ---------- upsertStaleAudit ----------

const auditArgs = {
  date: '2026-08-27',
  staleDays: 23,
  findings: ['`src/foo/bar.js` 已不存在', '新增了 `src/foo/baz.js`，地图未收录'],
};

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
  const twice = upsertStaleAudit(once, { date: '2026-09-10', staleDays: 5, findings: ['只剩一条'] });
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

/**
 * fs-search 单测 —— 重点是**边界**：越界读取、敏感文件、符号链接逃逸。
 * 这三样漏掉任何一个，给模型的就不是「查代码」而是「读任意文件」，
 * 而目标仓库根目录就躺着 .env.local 和小程序私钥（实测存在）。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScopedSearch, isDenied, resolveInside } from './fs-search.js';

let ROOT;
let OUTSIDE;

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-root-'));
  OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-out-'));
  fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'src', 'a.vue'), "trackClickApi('my_recipe_plate_tab', { tab: 'official' })\n第二行\n");
  fs.writeFileSync(path.join(ROOT, 'docs', 'events.md'), '| `my_recipe_plate_tab` | 摆盘页-切 Tab |\n');
  fs.writeFileSync(path.join(ROOT, '.env.local'), 'SECRET=should_never_be_read\n');
  fs.writeFileSync(path.join(ROOT, 'private.wx123.key'), 'PRIVATE KEY MATERIAL\n');
  fs.writeFileSync(path.join(ROOT, 'node_modules', 'junk', 'big.js'), "trackClickApi('noise')\n");
  fs.writeFileSync(path.join(OUTSIDE, 'secret.md'), 'OUTSIDE SECRET\n');
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

describe('isDenied —— 敏感文件黑名单', () => {
  for (const p of [
    '.env', '.env.local', '.env.prod', 'sub/.env',
    'private.wx123.key', 'a/b/server.pem', 'cert.p12',
    'id_rsa', '.npmrc', '.git/config', 'credentials.json', 'secrets.yaml',
  ]) {
    it(`拒绝 ${p}`, () => assert.equal(isDenied(p), true));
  }

  for (const p of ['src/a.vue', 'docs/events.md', 'keyboard.js', 'monkey.ts']) {
    it(`放行 ${p}`, () => assert.equal(isDenied(p), false));
  }

  it('反斜杠路径同样判定（Windows）', () => {
    assert.equal(isDenied('sub\\.env.local'), true);
    assert.equal(isDenied('a\\b\\x.key'), true);
  });
});

describe('resolveInside —— 路径不得逃出 root', () => {
  it('正常相对路径放行', () => {
    assert.ok(resolveInside(ROOT, 'src/a.vue'));
  });

  it('../ 逃逸被挡', () => {
    assert.equal(resolveInside(ROOT, '../'), null);
    assert.equal(resolveInside(ROOT, '../../etc/passwd'), null);
    assert.equal(resolveInside(ROOT, path.join('..', path.basename(OUTSIDE), 'secret.md')), null);
  });

  it('绝对路径被挡', () => {
    assert.equal(resolveInside(ROOT, path.join(OUTSIDE, 'secret.md')), null);
  });

  it('敏感文件即便在 root 内也被挡', () => {
    assert.equal(resolveInside(ROOT, '.env.local'), null);
    assert.equal(resolveInside(ROOT, 'private.wx123.key'), null);
  });
});

describe('search', () => {
  it('能搜到源码与文档里的埋点 key', () => {
    const s = createScopedSearch(ROOT);
    const r = s.search('my_recipe_plate_tab');
    const files = r.matches.map((m) => m.file).sort();
    assert.deepEqual(files, ['docs/events.md', 'src/a.vue']);
    assert.equal(r.matches[0].line > 0, true, '要给行号，便于人去核对');
  });

  it('跳过 node_modules（体积大且无信息量）', () => {
    const r = createScopedSearch(ROOT).search('noise');
    assert.equal(r.matches.length, 0);
  });

  it('搜不到敏感文件的内容', () => {
    const r = createScopedSearch(ROOT).search('should_never_be_read');
    assert.deepEqual(r.matches, [], '.env.local 的内容绝不能出现在结果里');
    const r2 = createScopedSearch(ROOT).search('PRIVATE KEY MATERIAL');
    assert.deepEqual(r2.matches, []);
  });

  it('大小写不敏感', () => {
    assert.ok(createScopedSearch(ROOT).search('MY_RECIPE_PLATE_TAB').matches.length > 0);
  });

  it('查询串按字面量处理，不当正则（防灾难性回溯）', () => {
    const r = createScopedSearch(ROOT).search('(a+)+$');
    assert.equal(Array.isArray(r.matches), true, '不该抛，也不该卡住');
  });

  it('命中数封顶并标记 truncated', () => {
    const r = createScopedSearch(ROOT).search('e', { max: 2 });
    assert.equal(r.matches.length, 2);
    assert.equal(r.truncated, true);
  });

  it('空检索词报错而不是返回全部', () => {
    assert.ok(createScopedSearch(ROOT).search('  ').error);
  });

  it('root 不存在时给出明确 error，不抛', () => {
    const s = createScopedSearch(path.join(os.tmpdir(), 'definitely-not-here-xyz'));
    assert.equal(s.ok, false);
    assert.ok(s.search('x').error);
  });
});

describe('read', () => {
  it('读 root 内的普通文件', () => {
    const r = createScopedSearch(ROOT).read('docs/events.md');
    assert.match(r.content, /摆盘页/);
    assert.equal(r.truncated, false);
  });

  it('拒绝越界读取', () => {
    const r = createScopedSearch(ROOT).read(path.join(OUTSIDE, 'secret.md'));
    assert.ok(r.error);
    assert.equal(r.content, undefined);
  });

  it('拒绝敏感文件', () => {
    for (const f of ['.env.local', 'private.wx123.key']) {
      const r = createScopedSearch(ROOT).read(f);
      assert.ok(r.error, f + ' 必须拒绝');
      assert.equal(r.content, undefined);
    }
  });

  it('超长文件截断并标记', () => {
    const r = createScopedSearch(ROOT).read('src/a.vue', { maxBytes: 10 });
    assert.equal(r.truncated, true);
    assert.equal(r.content.length <= 10, true);
  });

  it('不存在的文件返回 error 而不是抛', () => {
    assert.ok(createScopedSearch(ROOT).read('nope.md').error);
  });
});

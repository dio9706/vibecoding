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
  // CDN 资源引用落在这条分支上，见 check-map.logic.js 的 extractPathRefs 注释
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

test('行号漂移时靠内容匹配兜底，而不是改错行', () => {
  // 体检和优化之间文件被人改过，报告里的行号会失效。
  // 认行号不认内容的话，会把无关的一行改坏
  const before = '# 图\n\n新插入的一行\n\n入口见 `src/old/foo.js`。\n';
  const dir = tmpProject({ 'CLAUDE.md': before, 'src/a/foo.js': '' });
  const out = fixDeadLinks(dir, [{ file: 'CLAUDE.md', line: 3, ref: 'src/old/foo.js' }]);
  assert.equal(out.updated.length, 1, '内容匹配兜底应该在别的行找到它');
  const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(md.includes('`src/a/foo.js`'));
  assert.ok(md.includes('新插入的一行'), '无关行不能被动过');
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

test('空清单不做任何事', () => {
  const dir = tmpProject({ 'CLAUDE.md': '# 图\n' });
  assert.deepEqual(fixDeadLinks(dir, []), { updated: [], skipped: [] });
  assert.deepEqual(fixDeadLinks(dir, null), { updated: [], skipped: [] });
});

// ---------- writeGeneratedMap ----------

test('生成的地图写到指定路径', async () => {
  const dir = tmpProject({});
  const r = await writeGeneratedMap(dir, 'CLAUDE.md', async () => ({ ok: true, markdown: '# 新地图\n\n正文', reason: '' }));
  assert.equal(r.status, 'done');
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# 新地图\n\n正文\n');
});

test('嵌套路径会自动建目录', async () => {
  const dir = tmpProject({});
  const r = await writeGeneratedMap(dir, 'src/a/CLAUDE.md', async () => ({ ok: true, markdown: '# 模块图', reason: '' }));
  assert.equal(r.status, 'done');
  assert.ok(fs.existsSync(path.join(dir, 'src/a/CLAUDE.md')));
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

test('核对器抛错被兜住', async () => {
  const before = '# 图\n\n正文\n';
  const dir = tmpProject({ 'src/a/CLAUDE.md': before });
  const r = await writeStaleAudit(dir, 'src/a/CLAUDE.md', 23, {
    generate: async () => { throw new Error('boom'); },
    date: '2026-08-27',
  });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /boom/);
  assert.equal(fs.readFileSync(path.join(dir, 'src/a/CLAUDE.md'), 'utf8'), before);
});

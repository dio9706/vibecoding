import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readFile,
  writeFile,
  appendFile,
  ensurePitfallsPath,
  ensureClaudeMdPath,
  writePitfalls,
  ensureClaudeMdRef,
} from './req-pitfalls.js';

test('ensurePitfallsPath：返回 <projectDir>/.claude/pitfalls.md 路径', () => {
  const dir = 'C:\\work\\my-project';
  const result = ensurePitfallsPath(dir);
  assert.match(result, /\.claude[/\\]pitfalls\.md$/);
  assert.ok(result.startsWith(dir));
});

test('ensureClaudeMdPath：返回 <projectDir>/CLAUDE.md 路径', () => {
  const dir = 'C:\\work\\my-project';
  const result = ensureClaudeMdPath(dir);
  assert.match(result, /CLAUDE\.md$/);
  assert.ok(result.startsWith(dir));
});

test('readFile：存在则返回内容，ENOENT 返回 null', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-pf-'));
  try {
    const file = path.join(tmpDir, 'test.txt');

    // 文件不存在
    assert.equal(await readFile(file), null);

    // 写入并读取
    fs.writeFileSync(file, 'hello world');
    assert.equal(await readFile(file), 'hello world');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readFile：ENOENT 返回 null 而不抛错（父目录不存在也是 ENOENT）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-pf-'));
  try {
    const file = path.join(tmpDir, 'nope', 'nope.txt');
    // 不存在的父目录会抛 ENOENT，但 readFile 捕获并返回 null
    const result = await readFile(file);
    assert.equal(result, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeFile：自动创建父目录，覆盖已存在的文件', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-pf-'));
  try {
    const file = path.join(tmpDir, 'a', 'b', 'test.txt');

    // 第一次写入
    await writeFile(file, 'first');
    assert.equal(fs.readFileSync(file, 'utf8'), 'first');

    // 覆盖
    await writeFile(file, 'second');
    assert.equal(fs.readFileSync(file, 'utf8'), 'second');

    // 验证父目录已建
    assert.ok(fs.statSync(path.dirname(file)).isDirectory());
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('appendFile：文件不存在新建，存在则追加，末尾加换行', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-pf-'));
  try {
    const file = path.join(tmpDir, 'a', 'b', 'append.txt');

    // 不存在则新建
    await appendFile(file, 'line1');
    assert.equal(fs.readFileSync(file, 'utf8'), 'line1\n');

    // 追加（自动补前置换行）
    await appendFile(file, 'line2');
    assert.equal(fs.readFileSync(file, 'utf8'), 'line1\nline2\n');

    // 再追加
    await appendFile(file, 'line3');
    assert.equal(fs.readFileSync(file, 'utf8'), 'line1\nline2\nline3\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writePitfalls：新建并写入条目，末尾加换行', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-pf-'));
  try {
    const claudeDir = path.join(tmpDir, '.claude');
    const file = path.join(claudeDir, 'pitfalls.md');

    // 写入条目
    const items = ['避坑1：前端组件库版本管理', '避坑2：后端接口兼容性'];
    await writePitfalls(tmpDir, items);

    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /- 避坑1：前端组件库版本管理/);
    assert.match(content, /- 避坑2：后端接口兼容性/);
    assert.ok(content.endsWith('\n'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writePitfalls：重复调用去重，新条目仅在首 20 字不重复时追加', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-pf-'));
  try {
    // 第一次写入：2 条
    // 使用英文使 slice(0, 20) 更容易控制
    const items1 = ['pitfall1-important-bug-in-rendering', 'pitfall2-backend-connection'];
    await writePitfalls(tmpDir, items1);
    const file1 = fs.readFileSync(path.join(tmpDir, '.claude', 'pitfalls.md'), 'utf8');
    assert.equal((file1.match(/^-/gm) || []).length, 2);

    // 第二次写入：首 20 字相同的被去重
    // 'pitfall1-important-bug-in-rendering'.slice(0, 20) = 'pitfall1-important-'
    // 'pitfall1-important-bug-in-something'.slice(0, 20) = 'pitfall1-important-'
    // 这样首 20 字相同，应该被去重
    const items2 = ['pitfall1-important-bug-in-something', 'pitfall3-new-issue'];
    await writePitfalls(tmpDir, items2);
    const file2 = fs.readFileSync(path.join(tmpDir, '.claude', 'pitfalls.md'), 'utf8');
    const lines = (file2.match(/^-/gm) || []).length;
    assert.equal(lines, 3); // items1 的 2 条 + items2 中新的 pitfall3（pitfall1 被去重）
    assert.match(file2, /pitfall3-new-issue/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ensureClaudeMdRef：CLAUDE.md 不存在时创建并仅含引用行', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-pf-'));
  try {
    const file = path.join(tmpDir, 'CLAUDE.md');

    // 不存在则创建
    await ensureClaudeMdRef(tmpDir);
    assert.ok(fs.existsSync(file));

    const content = fs.readFileSync(file, 'utf8');
    assert.equal(content, '@.claude/pitfalls.md\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ensureClaudeMdRef：已含引用时不重复插入', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-pf-'));
  try {
    const file = path.join(tmpDir, 'CLAUDE.md');

    // 首次创建
    await ensureClaudeMdRef(tmpDir);
    const first = fs.readFileSync(file, 'utf8');

    // 再调用一次
    await ensureClaudeMdRef(tmpDir);
    const second = fs.readFileSync(file, 'utf8');

    // 内容应完全相同
    assert.equal(first, second);
    assert.equal((second.match(/@\.claude\/pitfalls\.md/g) || []).length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ensureClaudeMdRef：无引用时追加（前加空行）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-pf-'));
  try {
    const file = path.join(tmpDir, 'CLAUDE.md');

    // 先写入其他内容（末尾有换行）
    fs.writeFileSync(file, '# My Project\n');

    // 追加引用
    await ensureClaudeMdRef(tmpDir);

    const content = fs.readFileSync(file, 'utf8');
    // 末尾已有换行，所以只需再加一个空行 + 引用行
    assert.match(content, /# My Project\n\n@\.claude\/pitfalls\.md\n/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ensureClaudeMdRef：无换行结尾的文件追加引用时需加空行', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-pf-'));
  try {
    const file = path.join(tmpDir, 'CLAUDE.md');

    // 写入末尾无换行的内容
    fs.writeFileSync(file, '# My Project');

    // 追加引用：末尾无换行，所以前面加 \n\n（一个作为旧内容补全，一个作为空行）
    await ensureClaudeMdRef(tmpDir);

    const content = fs.readFileSync(file, 'utf8');
    // 末尾无换行时，应该添加 \n\n + 引用行
    assert.match(content, /# My Project\n\n@\.claude\/pitfalls\.md\n/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

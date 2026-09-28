/**
 * 附件下载端点（/api/fs/download）的安全边界测试。
 *
 * 为什么单独成文件而不并进 routes-files.fs.test.js：`UPLOADS_DIR` 是模块求值时
 * 由 `APP_DATA_DIR` 固化的常量，必须**先设环境变量再动态 import** 才能把白名单根
 * 指到临时目录上。那个文件是静态 import 的，混进去会让两边互相踩。
 *
 * 盯死的两件事，都是这类端点的经典破口：
 * 1. **目录穿越** —— 这个端点放开了扩展名（附件可能是任何类型），若不限目录，
 *    `?path=C:\Users\x\.ssh\id_rsa` 就能把私钥下走。它与 /api/fs/read 的边界刻意不同。
 * 2. **header 注入** —— 文件名直接进 Content-Disposition，带引号或 CRLF 就能提前闭合值。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let validateDownloadPath;
let buildContentDisposition;
let tmpRoot;
let uploadsDir;
const prevEnv = process.env.APP_DATA_DIR;

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  process.env.APP_DATA_DIR = tmpRoot;
  uploadsDir = path.join(tmpRoot, '.uploads');
  fs.mkdirSync(path.join(uploadsDir, 'apidocs'), { recursive: true });
  ({ validateDownloadPath, buildContentDisposition } = await import('./routes-files.js'));
});

after(() => {
  if (prevEnv === undefined) delete process.env.APP_DATA_DIR;
  else process.env.APP_DATA_DIR = prevEnv;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('validateDownloadPath：放行 .uploads 树内的文件，扩展名不设限', () => {
  for (const p of [
    path.join(uploadsDir, 'a.md'),
    path.join(uploadsDir, 'apidocs', 'muc9-order-api.json'), // 子目录 + 非 md
    path.join(uploadsDir, 'feishu', 'muc4-spec.yaml'),
    path.join(uploadsDir, 'noext'),
  ]) {
    assert.equal(validateDownloadPath(p).ok, true, `应放行 ${p}`);
  }
});

test('validateDownloadPath：挡住白名单根之外的一切路径（回归：任意文件读取）', () => {
  const outside = process.platform === 'win32' ? 'C:\\Users\\x\\.ssh\\id_rsa' : '/home/x/.ssh/id_rsa';
  assert.equal(validateDownloadPath(outside).ok, false, '根之外的绝对路径必须拒绝');
  assert.equal(validateDownloadPath(path.join(tmpRoot, 'settings.json')).ok, false, '数据目录但在 .uploads 外，拒绝');
  // 穿越：resolve 会把 .. 折叠掉，折叠后落在根外就该拒
  assert.equal(validateDownloadPath(path.join(uploadsDir, '..', 'settings.json')).ok, false, '.. 穿越必须拒绝');
  assert.equal(
    validateDownloadPath(path.join(uploadsDir, 'apidocs', '..', '..', 'settings.json')).ok,
    false,
    '多级 .. 穿越必须拒绝',
  );
  assert.equal(validateDownloadPath(uploadsDir).ok, false, '目录本身不是可下载文件');
});

test('validateDownloadPath：脏输入与相对路径一律拒绝', () => {
  for (const bad of ['', null, undefined, 123, {}, 'relative/a.md', '.uploads/a.md']) {
    assert.equal(validateDownloadPath(bad).ok, false, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('validateDownloadPath：盘符大小写不该影响归属判定（win32 路径大小写不敏感）', () => {
  if (process.platform !== 'win32') return; // 仅 win32 有此语义
  const p = path.join(uploadsDir, 'a.md');
  const flipped = p[0] === p[0].toUpperCase() ? p[0].toLowerCase() + p.slice(1) : p[0].toUpperCase() + p.slice(1);
  assert.equal(validateDownloadPath(flipped).ok, true, '换个盘符大小写仍应放行，否则下载会莫名 400');
});

test('buildContentDisposition：同时给 ASCII 与 RFC 5987 两份文件名', () => {
  const h = buildContentDisposition('接口文档.md');
  assert.match(h, /^attachment; /);
  assert.match(h, /filename="[^"]*\.md"/, 'ASCII 份必须保住扩展名');
  assert.match(h, /filename\*=UTF-8''/, '必须带 RFC 5987 份，否则中文名下出来是乱码');
  assert.ok(h.includes(encodeURIComponent('接口文档.md')), '中文名须 percent-encode');
});

test('buildContentDisposition：剥掉引号与控制字符（回归：header 注入）', () => {
  const h = buildContentDisposition('a".md\r\nX-Injected: 1');
  assert.ok(!/[\r\n]/.test(h), 'CRLF 必须剥掉，否则能注入任意响应头');
  assert.ok(!h.includes('X-Injected: 1\r\n'), '不得留下可被解析成新 header 的片段');
  // ASCII 份里不能出现裸引号——那会提前闭合 filename="..." 的值
  assert.equal((h.match(/filename="([^"]*)"/)?.[1] || '').includes('"'), false);
});

test('buildContentDisposition：空 / 脏名回落到 download，不产出空文件名', () => {
  for (const bad of ['', null, undefined]) {
    assert.match(buildContentDisposition(bad), /filename="download"/);
  }
});

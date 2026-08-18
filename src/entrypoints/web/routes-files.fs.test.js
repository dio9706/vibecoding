import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { statPaths, validateReadPath } from './routes-files.js';

test('statPaths 区分文件 / 目录 / 不存在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsstat-'));
  const file = path.join(dir, 'a.md');
  fs.writeFileSync(file, 'hello');

  const [rFile, rDir, rMissing] = statPaths([file, dir, path.join(dir, 'nope.md')]);
  assert.equal(rFile.kind, 'file');
  assert.equal(rFile.size, 5);
  assert.equal(rDir.kind, 'dir');
  assert.equal(rMissing.kind, 'missing');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('statPaths 对非字符串与空串归为 missing 而不抛异常', () => {
  // str() 是 fail-closed 的：非字符串归空串。这里确认不会因为脏输入炸掉整个批次
  const r = statPaths([null, 123, '', {}]);
  assert.equal(r.length, 4);
  assert.ok(r.every((x) => x.kind === 'missing'));
});

test('statPaths 无扩展名文件判为 file 而非 dir', () => {
  // 旧的前端启发式（最后一段不含 . 即目录）会把 Dockerfile 判成文件夹，
  // 引入这个接口的首要动机就是消灭这类误判
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsstat-'));
  const file = path.join(dir, 'Dockerfile');
  fs.writeFileSync(file, 'FROM node');
  assert.equal(statPaths([file])[0].kind, 'file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateReadPath 只放行绝对路径的 .md / .markdown', () => {
  assert.equal(validateReadPath('relative.md').ok, false);
  assert.equal(validateReadPath('').ok, false);
  assert.equal(validateReadPath(null).ok, false);

  const abs = process.platform === 'win32' ? 'C:\\tmp\\a.exe' : '/tmp/a.exe';
  assert.equal(validateReadPath(abs).ok, false);

  const ok = process.platform === 'win32' ? 'C:\\tmp\\a.MD' : '/tmp/a.MD';
  assert.equal(validateReadPath(ok).ok, true, '扩展名判定须大小写不敏感');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gitTrackedFiles } from './git-tracked.js';

function tmpDir(t, name) {
  const dir = path.join(os.tmpdir(), `cad-gittracked-${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const git = (dir, args) => execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: 'pipe' });

function initRepo(dir) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'T']);
}

test('真实仓库：只返回被追踪的文件，gitignore 的产物不在其中', async (t) => {
  const dir = tmpDir(t, 'repo');
  initRepo(dir);

  fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\n*.log\n');
  fs.writeFileSync(path.join(dir, 'a.js'), '// a\n');
  fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'build', 'a.js'), '// 构建产物副本\n');
  fs.writeFileSync(path.join(dir, 'run.log'), 'x\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);

  const tracked = await gitTrackedFiles(dir);
  assert.ok(tracked instanceof Set);
  assert.equal(tracked.has('a.js'), true, '真实源码在清单里');
  assert.equal(tracked.has('build/a.js'), false, '构建产物不在清单里');
  assert.equal(tracked.has('run.log'), false, '日志不在清单里');
  assert.equal(tracked.has('.gitignore'), true);
});

test('路径用正斜杠，且相对传入目录（子目录也成立）', async (t) => {
  const dir = tmpDir(t, 'sub');
  initRepo(dir);
  fs.mkdirSync(path.join(dir, 'src', 'store'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'store', 'x.js'), '// x\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);

  const fromRoot = await gitTrackedFiles(dir);
  assert.equal(fromRoot.has('src/store/x.js'), true, '相对仓库根');

  const fromSub = await gitTrackedFiles(path.join(dir, 'src'));
  assert.equal(fromSub.has('store/x.js'), true, '相对传入的子目录，不带 src/ 前缀');
});

test('非 git 目录 → null（调用方据此降级为目录遍历）', async (t) => {
  const dir = tmpDir(t, 'plain');
  fs.writeFileSync(path.join(dir, 'a.js'), '// a\n');
  assert.equal(await gitTrackedFiles(dir), null);
});

test('目录不存在 → null，不抛', async () => {
  assert.equal(await gitTrackedFiles(path.join(os.tmpdir(), 'cad-no-such-dir-xyz')), null);
});

test('仓库存在但零追踪文件 → null（降级而不是「什么都别扫」）', async (t) => {
  const dir = tmpDir(t, 'bare');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'a.js'), '// a\n'); // 只有未追踪文件
  assert.equal(await gitTrackedFiles(dir), null, '空清单必须当 null，否则会把整个项目排除掉');
});

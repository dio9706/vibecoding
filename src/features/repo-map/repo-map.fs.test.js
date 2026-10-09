/**
 * repo-map 真文件系统测试：临时 git 仓库 + 注入 cache/read 计数桩。
 *
 * 用真 git 而不是注入 trackedFn：`gitTrackedFiles` 是「什么算源码」的权威口径
 * （.gitignore 挡构建产物/密钥），这条链路必须真验一次。缓存/读文件用桩注入，
 * 才能断言「第二次零读取」「只重解析改动文件」这类增量性质。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildRepoMap, getRepoMap, isSourcePath } from './index.js';

const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function makeRepo({ git = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-'));
  dirs.push(dir);
  const g = (args) => execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: 'pipe' });
  if (git) {
    g(['init', '-q']);
    g(['config', 'user.email', 't@example.com']);
    g(['config', 'user.name', 'T']);
  }
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(dir, 'src', 'core.js'), 'export function createCore() {\n  return 1;\n}\n');
  fs.writeFileSync(
    path.join(dir, 'src', 'use-core.js'),
    "import { createCore } from './core.js';\nexport function useCore() {\n  return createCore();\n}\n",
  );
  fs.writeFileSync(path.join(dir, 'src', 'helper.js'), 'export const helper = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'core.test.js'), "import { createCore } from './core.js';\n");
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'export const x = 1;\n');
  if (git) {
    g(['add', '-A']);
    g(['commit', '-qm', 'init']);
  }
  return dir;
}

/** 内存缓存 + 读计数桩：验证缓存命中与增量的「零重复读」 */
function makeHarness() {
  let store = null;
  let reads = 0;
  return {
    deps: {
      cacheGet: () => store,
      cachePut: (_root, record) => {
        store = record;
      },
      readFn: async (p) => {
        reads += 1;
        return fs.promises.readFile(p, 'utf8');
      },
    },
    get reads() {
      return reads;
    },
  };
}

test('基本出图：只收 git 追踪的源文件；测试文件与 node_modules 排除；引用度排序生效', async () => {
  const dir = makeRepo();
  const map = await buildRepoMap({ cwd: dir }, makeHarness().deps);
  assert.match(map, /src\/core\.js/);
  assert.match(map, /src\/use-core\.js/);
  assert.match(map, /createCore|useCore/);
  assert.ok(!map.includes('core.test.js'), '测试文件不进地图');
  assert.ok(!map.includes('node_modules'), '依赖目录不在 git 清单里');
  const coreAt = map.indexOf('src/core.js');
  const helperAt = map.indexOf('src/helper.js');
  assert.ok(coreAt >= 0 && helperAt >= 0 && coreAt < helperAt, 'core 被引用且被 import → 排在 helper 前');
});

test('缓存命中：第二次调用零文件读取（只 stat + 重排序）', async () => {
  const dir = makeRepo();
  const h = makeHarness();
  await buildRepoMap({ cwd: dir }, h.deps);
  const first = h.reads;
  assert.equal(first, 3, '三个源文件各读一次（test 文件已过滤）');
  await buildRepoMap({ cwd: dir }, h.deps);
  assert.equal(h.reads, first, '第二次零读取');
});

test('增量：改一个文件只重解析那一个；删一个文件从地图消失', async () => {
  const dir = makeRepo();
  const h = makeHarness();
  await buildRepoMap({ cwd: dir }, h.deps);
  const before = h.reads;

  const target = path.join(dir, 'src', 'helper.js');
  fs.writeFileSync(target, 'export const helper = 2;\nexport function helperPlus() {\n  return helper + 1;\n}\n');
  const future = new Date(Date.now() + 5000); // 强制 mtime 变化（部分文件系统 mtime 精度只有毫秒）
  fs.utimesSync(target, future, future);
  await buildRepoMap({ cwd: dir }, h.deps);
  assert.equal(h.reads, before + 1, '只重读改动的那一个文件');

  fs.rmSync(target); // 未 git rm：ls-files 仍列出，但 stat 失败 → 应消失
  const after = await buildRepoMap({ cwd: dir }, h.deps);
  assert.ok(!after.includes('src/helper.js'), '删除的文件不进地图');
});

test('非 git 目录：返回空串（拍板：仅 git 仓库启用）', async () => {
  const dir = makeRepo({ git: false });
  assert.equal(await buildRepoMap({ cwd: dir }, makeHarness().deps), '');
});

test('查询加权：带任务关键词时目标文件置顶', async () => {
  const dir = makeRepo();
  const map = await buildRepoMap({ cwd: dir, query: 'fix helper regression' }, makeHarness().deps);
  const helperAt = map.indexOf('src/helper.js');
  const coreAt = map.indexOf('src/core.js');
  assert.ok(helperAt >= 0 && coreAt >= 0 && helperAt < coreAt, 'helper 命中关键词后被加权置顶');
});

test('getRepoMap：任何异常 fail-open 返回空串', async () => {
  const dir = makeRepo();
  const out = await getRepoMap({ cwd: dir }, {
    trackedFn: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(out, '');
});

test('isSourcePath：扩展名 / 测试文件 / 跳过目录的纯判定', () => {
  assert.equal(isSourcePath('src/a.js'), true);
  assert.equal(isSourcePath('src/a.ts'), true);
  assert.equal(isSourcePath('src/a.py'), true);
  assert.equal(isSourcePath('src/a.vue'), false, 'vue 不在抽取器支持家族内');
  assert.equal(isSourcePath('src/a.test.js'), false);
  assert.equal(isSourcePath('tests/a.js'), false);
  assert.equal(isSourcePath('src/node_modules/a.js'), false);
  assert.equal(isSourcePath('src/.hidden/a.js'), false);
  assert.equal(isSourcePath('public/vendor/lib/a.js'), false);
});

test('Phase 2：类方法进地图（附加抽取器；共享抽取器零改动）', async () => {
  const dir = makeRepo();
  fs.writeFileSync(
    path.join(dir, 'src', 'store.js'),
    'export class Store {\n  async load(id) {\n    return id;\n  }\n\n  static create() {\n    return new Store();\n  }\n}\n',
  );
  execFileSync('git', ['add', 'src/store.js'], { cwd: dir, windowsHide: true, stdio: 'pipe' });
  const map = await buildRepoMap({ cwd: dir }, makeHarness().deps);
  assert.match(map, /src\/store\.js/);
  assert.match(map, /load\(id\)/, '类方法进地图');
  assert.match(map, /static create\(\)/);
});

test('refresh=true：忽略缓存全量重解析；普通调用继续零读取', async () => {
  const dir = makeRepo();
  const h = makeHarness();
  await buildRepoMap({ cwd: dir }, h.deps);
  const first = h.reads;
  await buildRepoMap({ cwd: dir }, h.deps);
  assert.equal(h.reads, first, '默认增量：零读取');
  await buildRepoMap({ cwd: dir, refresh: true }, h.deps);
  assert.equal(h.reads, first * 2, 'refresh 强制重读全部源文件');
});

test('缓存版本升级：记录带版本；旧版本记录整体作废（不留陈旧地图）', async () => {
  const dir = makeRepo();
  let store = null;
  let reads = 0;
  const deps = {
    cacheGet: () => store,
    cachePut: (_root, rec) => {
      store = rec;
    },
    readFn: async (p) => {
      reads += 1;
      return fs.promises.readFile(p, 'utf8');
    },
  };
  await buildRepoMap({ cwd: dir }, deps);
  assert.equal(store.version, 2, '新记录带缓存版本（抽取器口径）');
  store = { ...store, version: 1 };
  const before = reads;
  await buildRepoMap({ cwd: dir }, deps);
  assert.equal(reads, before + 3, '旧版本缓存不复用（全量重解析）');
});

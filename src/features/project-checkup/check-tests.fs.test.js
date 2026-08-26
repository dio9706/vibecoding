import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runProjectTests } from './check-tests.js';

function tmpProject(t, name, pkg) {
  const dir = path.join(os.tmpdir(), `cad-checktests-${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('没有 package.json → na，不执行任何命令', async (t) => {
  const dir = tmpProject(t, 'nopkg', null);
  const r = await runProjectTests(dir);
  assert.equal(r.status, 'na');
  assert.match(r.reason, /package\.json/);
});

test('未定义 test 脚本 → na', async (t) => {
  const dir = tmpProject(t, 'noscript', { name: 'x', scripts: { build: 'echo 1' } });
  const r = await runProjectTests(dir);
  assert.equal(r.status, 'na');
});

test('npm init 的占位脚本 → na（不能报成测试失败）', async (t) => {
  // 最容易踩的误报：npm init 默认生成 `exit 1`，不识别的话每个没写测试的项目
  // 都会被报成 error 级「测试失败」
  const dir = tmpProject(t, 'placeholder', {
    name: 'x',
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
  });
  const r = await runProjectTests(dir);
  assert.equal(r.status, 'na', '占位脚本必须识别为 na');
  assert.match(r.reason, /占位/);
});

test('测试通过 → pass', async (t) => {
  const dir = tmpProject(t, 'pass', { name: 'x', scripts: { test: 'node -e "process.exit(0)"' } });
  const r = await runProjectTests(dir);
  assert.equal(r.status, 'pass');
});

test('测试失败 → fail，带退出码', async (t) => {
  const dir = tmpProject(t, 'fail', { name: 'x', scripts: { test: 'node -e "process.exit(3)"' } });
  const r = await runProjectTests(dir);
  assert.equal(r.status, 'fail');
  assert.match(r.reason, /3|未通过/);
});

test('超时 → timeout（不是 fail）', async (t) => {
  const dir = tmpProject(t, 'timeout', {
    name: 'x',
    scripts: { test: 'node -e "setTimeout(()=>{},60000)"' },
  });
  const r = await runProjectTests(dir, { timeoutMs: 1500 });
  assert.equal(r.status, 'timeout', '超时不能判成测试失败');
});

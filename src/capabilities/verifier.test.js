/**
 * verifier.js 真 shell 测试 —— 在临时目录里跑真脚本，全离线。
 * 命令一律写成「node 脚本文件」而不是 `node -e "..."`，避免各平台 shell 引号转义差异
 * （同 providers/builtin-tools.test.js 的做法）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { resolveVerifyCommand, runVerify } = await import('./verifier.js');

const tmpDirs = [];
after(async () => {
  // 被超时杀掉的子进程在 Windows 上释放目录句柄有延迟：等一拍再清，失败不影响测试结论
  await new Promise((r) => setTimeout(r, 1200));
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      /* 临时目录清理失败可接受 */
    }
  }
});

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'pass.js'), 'console.log("all good");\n');
  fs.writeFileSync(path.join(dir, 'fail.js'), 'console.log("1 passed, 2 failed");\nprocess.exit(1);\n');
  fs.writeFileSync(path.join(dir, 'slow.js'), 'setTimeout(() => {}, 5000);\n');
  return dir;
}

test('runVerify：未配置 → skipped 且 ok=true（fail-open）', async () => {
  const r = await runVerify({ cwd: makeWorkspace(), command: '   ' });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, '未配置验证命令');
  assert.equal(r.summary, '未配置验证命令');
});

test('runVerify：通过 → ok，摘要含命令与耗时', async () => {
  const r = await runVerify({ cwd: makeWorkspace(), command: 'node pass.js' });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /all good/);
  assert.match(r.summary, /^node pass\.js 通过（\d+s）$/);
});

test('runVerify：非零退出 → 失败，摘要带尾部输出', async () => {
  const r = await runVerify({ cwd: makeWorkspace(), command: 'node fail.js' });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /1 passed, 2 failed/);
  assert.match(r.summary, /node fail\.js 失败（退出码 1：1 passed, 2 failed）/);
});

test('runVerify：命令不存在 → skipped（配置问题，不算任务失败）', async () => {
  const r = await runVerify({ cwd: makeWorkspace(), command: 'zzz-no-such-command-12345' });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /命令不存在|无法执行/);
});

test('runVerify：超时 → 失败且 timedOut，不拖死调用方', async () => {
  const t0 = Date.now();
  const r = await runVerify({ cwd: makeWorkspace(), command: 'node slow.js', timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(r.summary, /超时/);
  assert.ok(Date.now() - t0 < 4000, '超时后应快速返回');
});

test('runVerify：命令确实失败不算 fail-open（退出码 127 但非 not-found 文案）', async () => {
  // 直接 exit 127 但没有「找不到命令」文案：按真实失败处理（证明 not-found 判定不只看退出码）
  const dir = makeWorkspace();
  fs.writeFileSync(path.join(dir, 'weird.js'), 'process.exit(127);\n');
  const r = await runVerify({ cwd: dir, command: 'node weird.js' });
  assert.equal(r.skipped, false);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 127);
});

test('resolveVerifyCommand：显式配置优先且 trim，不读文件', async () => {
  let reads = 0;
  const cmd = await resolveVerifyCommand({
    configured: '  make test  ',
    cwd: 'whatever',
    readFileFn: async () => {
      reads += 1;
      return '{}';
    },
  });
  assert.equal(cmd, 'make test');
  assert.equal(reads, 0);
});

test('resolveVerifyCommand：未配置 → 从 cwd 的 package.json 发现 npm test', async () => {
  const dir = makeWorkspace();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node pass.js' } }));
  assert.equal(await resolveVerifyCommand({ configured: '', cwd: dir }), 'npm test');
});

test('resolveVerifyCommand：无 package.json / 坏 JSON / 无 test 脚本 → 空串（fail-open 不验证）', async () => {
  const dir = makeWorkspace();
  assert.equal(await resolveVerifyCommand({ cwd: dir }), '');
  fs.writeFileSync(path.join(dir, 'package.json'), '{ 这不是 JSON');
  assert.equal(await resolveVerifyCommand({ cwd: dir }), '');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'webpack' } }));
  assert.equal(await resolveVerifyCommand({ cwd: dir }), '');
  assert.equal(await resolveVerifyCommand({ configured: '', cwd: '' }), '', '无 cwd 不发现');
});

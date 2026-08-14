import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript } from '../integrations/shell.js';

/**
 * 背景：全仓 grep uncaughtException|unhandledRejection **零命中**，
 * 而 Node ≥15 默认把未处理的 rejection 也当成致命错误。
 * store/runs.js 自陈「仅内存，扛不了进程重启」——一次崩溃 = 所有在跑的 Claude 任务全灭。
 * 这一层是最后兜底：即便前面所有输入校验都漏了，也不能让单个请求打死整个进程。
 */

// 必须用 file:// URL 而非 Windows 绝对路径：ESM loader 不接受 'c:' 协议
const GUARD = new URL('./process-guard.js', import.meta.url).href;
let dir;

/** 生成一个子进程脚本：装上兜底 → 触发致命错误 → 若仍存活则打印 ALIVE */
function childScript(trigger) {
  return `
import { installProcessGuards } from ${JSON.stringify(GUARD)};
installProcessGuards();
setTimeout(() => { ${trigger} }, 10);
setTimeout(() => { console.log('ALIVE'); process.exit(0); }, 300);
`;
}

async function runChild(name, trigger) {
  const f = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(f, childScript(trigger));
  return runScript(process.execPath, [f]);
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-guard-'));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installProcessGuards：同步抛出的未捕获异常不再终结进程', async () => {
  const r = await runChild('sync-throw', `throw new Error('(123).trim is not a function');`);
  assert.equal(r.ok, true, `进程应存活退出，实际 code=${r.code} err=${r.err}`);
  assert.match(r.out, /ALIVE/);
});

test('installProcessGuards：未处理的 Promise rejection 不再终结进程', async () => {
  const r = await runChild('rejection', `Promise.reject(new Error('startClaudeRun 炸了'));`);
  assert.equal(r.ok, true, `进程应存活退出，实际 code=${r.code} err=${r.err}`);
  assert.match(r.out, /ALIVE/);
});

test('installProcessGuards：URIError（畸形百分号路径）同样被兜住', async () => {
  const r = await runChild('urierror', `decodeURIComponent('%');`);
  assert.equal(r.ok, true, `进程应存活退出，实际 code=${r.code} err=${r.err}`);
  assert.match(r.out, /ALIVE/);
});

test('对照：不装兜底时上述错误确实会终结进程（证明测试有效）', async () => {
  const f = path.join(dir, 'no-guard.mjs');
  fs.writeFileSync(
    f,
    `setTimeout(() => { throw new Error('boom'); }, 10);
     setTimeout(() => { console.log('ALIVE'); process.exit(0); }, 300);`,
  );
  const r = await runScript(process.execPath, [f]);
  assert.equal(r.ok, false, '没有兜底时进程就该死——否则本测试没有区分力');
  assert.equal(r.out.includes('ALIVE'), false);
});

test('installProcessGuards：重复安装不叠加监听器（模块可能被多入口 import）', async () => {
  const f = path.join(dir, 'idempotent.mjs');
  fs.writeFileSync(
    f,
    `import { installProcessGuards } from ${JSON.stringify(GUARD)};
     installProcessGuards();
     installProcessGuards();
     installProcessGuards();
     console.log(process.listenerCount('uncaughtException'));`,
  );
  const r = await runScript(process.execPath, [f]);
  assert.equal(r.ok, true);
  assert.equal(r.out.trim(), '1');
});

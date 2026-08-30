import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript } from '../integrations/shell.js';
import { throttleDecide, describeReason } from './process-guard.js';

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

// ── 日志节流 ──────────────────────────────────────────────────
// 「继续存活」的副作用是错误源不消失：定时器里的 rejection 会每轮抛一次。
// logger 是同步 appendFileSync，不节流就会拖慢事件循环并撑爆日志文件。

test('throttleDecide：首条放行，窗口内后续压制并计数', () => {
  const s = new Map();
  assert.deepEqual(throttleDecide(s, 'k', 1000), { log: true, suppressed: 0 });
  assert.deepEqual(throttleDecide(s, 'k', 2000), { log: false, count: 2 });
  assert.deepEqual(throttleDecide(s, 'k', 3000), { log: false, count: 3 });
});

test('throttleDecide：越过窗口重新放行，并报告上一窗口被压掉的条数', () => {
  const s = new Map();
  throttleDecide(s, 'k', 0); // 首条，已记
  throttleDecide(s, 'k', 10); // 压制 1
  throttleDecide(s, 'k', 20); // 压制 2
  // 窗口默认 60s，越过后应放行且报告前一窗口压了 2 条（首条不算被压）
  assert.deepEqual(throttleDecide(s, 'k', 60_001), { log: true, suppressed: 2 });
});

test('throttleDecide：不同 key 互不影响', () => {
  const s = new Map();
  assert.equal(throttleDecide(s, 'a', 0).log, true);
  assert.equal(throttleDecide(s, 'b', 0).log, true, '另一个错误不该被 a 压掉');
  assert.equal(throttleDecide(s, 'a', 1).log, false);
});

test('throttleDecide：key 数量封顶后清表，不无限增长', () => {
  const s = new Map();
  for (let i = 0; i < 200; i++) throttleDecide(s, 'k' + i, 0);
  assert.equal(s.size, 200);
  throttleDecide(s, 'overflow', 0); // 触发清表
  assert.equal(s.size, 1, '应清空后只留新 key —— 否则错误消息带随机路径时这张表就是内存泄漏');
});

// ── 非 Error 值的信息提取 ─────────────────────────────────────

test('describeReason：Error 取 message 与栈，指纹含栈首帧', () => {
  const e = new Error('炸了');
  const d = describeReason(e);
  assert.equal(d.msg, '炸了');
  assert.ok(d.stack?.includes('Error: 炸了'));
  assert.ok(d.fingerprint.startsWith('Error:炸了:'));
});

test('describeReason：对象不得退化成 [object Object]（网络类 rejection 的常见形状）', () => {
  const d = describeReason({ code: 'ECONNRESET', syscall: 'read' });
  assert.equal(d.msg.includes('[object Object]'), false, '这正是原实现丢信息的地方');
  assert.ok(d.msg.includes('ECONNRESET'));
});

test('describeReason：字符串 / undefined / null 都不抛错', () => {
  assert.equal(describeReason('纯字符串原因').msg, '纯字符串原因');
  assert.equal(describeReason(undefined).msg, 'undefined');
  assert.equal(describeReason(null).msg, 'null');
});

test('describeReason：循环引用对象不抛错（JSON.stringify 会失败）', () => {
  const o = { a: 1 };
  o.self = o;
  const d = describeReason(o);
  assert.equal(typeof d.msg, 'string');
  assert.ok(d.msg.length > 0);
});

test('describeReason：同名错误创建于不同位置 → 指纹不同（不该互相压制）', () => {
  // 指纹取的是「Error 被 new 出来的那一帧」。必须在两个不同的源码位置各建一个，
  // 若都在同一个工厂函数里创建，栈首帧相同、指纹相同 —— 那才是预期行为（同一处反复抛出归为一类）。
  const a = describeReason(new Error('同样的话'));
  const b = describeReason(new Error('同样的话'));
  assert.notEqual(a.fingerprint, b.fingerprint, '不同代码位置的同名错误应分别计数');
});

test('describeReason：同一处代码反复抛出 → 指纹相同（这是节流生效的前提）', () => {
  const mk = () => new Error('轮询炸了');
  assert.equal(describeReason(mk()).fingerprint, describeReason(mk()).fingerprint);
});

test('端到端：同一 rejection 连抛 5 次，日志只出现 1 条（证明节流真的接上了）', async () => {
  const f = path.join(dir, 'throttle-e2e.mjs');
  fs.writeFileSync(
    f,
    `import { installProcessGuards } from ${JSON.stringify(GUARD)};
     installProcessGuards();
     // 同一处代码反复 reject —— 指纹相同，应被压成一条
     for (let i = 0; i < 5; i++) Promise.reject(new Error('轮询又炸了'));
     setTimeout(() => { console.log('DONE'); process.exit(0); }, 300);`,
  );
  const r = await runScript(process.execPath, [f]);
  assert.equal(r.ok, true);
  const all = r.out + r.err;
  const hits = all.match(/未处理的 Promise rejection/g) || [];
  assert.equal(hits.length, 1, `应节流成 1 条，实际 ${hits.length} 条`);
  assert.match(all, /DONE/);
});

test('端到端：不同 rejection 各记一条（节流不能把不同错误也吞掉）', async () => {
  const f = path.join(dir, 'throttle-distinct.mjs');
  fs.writeFileSync(
    f,
    `import { installProcessGuards } from ${JSON.stringify(GUARD)};
     installProcessGuards();
     Promise.reject(new Error('错误甲'));
     Promise.reject(new Error('错误乙'));
     setTimeout(() => { console.log('DONE'); process.exit(0); }, 300);`,
  );
  const r = await runScript(process.execPath, [f]);
  assert.equal(r.ok, true);
  const all = r.out + r.err;
  const hits = all.match(/未处理的 Promise rejection/g) || [];
  assert.equal(hits.length, 2, `两个不同错误应各记一条，实际 ${hits.length} 条`);
});

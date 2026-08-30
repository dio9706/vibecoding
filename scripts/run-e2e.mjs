#!/usr/bin/env node
/**
 * e2e 门禁批量执行器 —— `npm run test:e2e`
 *
 * ## 为什么需要它
 *
 * `tests/e2e-*.mjs` 这套 playwright 门禁是当年拆分 app.js（4342 行 → 16 模块）
 * 的安全网，但它有两个致命的**流程**缺陷：
 *   1. 不在 `npm test` 的 glob 里（那只收 `*.test.js`），跑它得有人记得；
 *   2. 每个脚本都要求「先手动起 localhost:3000」，多一道门槛就少一次执行。
 *
 * 结果是 2026-08-28 体检时发现：`e2e-panels-smoke` 里硬编码的三个设置 tab
 * （lark / messages / tokens）早已被重构掉，这道门禁**长期失败而无人知晓**。
 * 安全网锈掉最危险的地方在于，它让人以为重构有保护。
 *
 * 所以这个执行器把「起服务 + 依次跑 + 汇总」变成一条命令，让它能进日常流程。
 *
 * ## 用法
 *
 *   npm run test:e2e                     # 跑全部
 *   npm run test:e2e -- panels-smoke     # 只跑名字含该关键字的
 *
 * 端口占用时会复用已有服务（不接管、不关闭它）；否则自己起、跑完关。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests');
const PORT = 3000; // e2e 脚本里硬编码了这个端口
const BASE = `http://127.0.0.1:${PORT}`;

const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const files = fs
  .readdirSync(TESTS_DIR)
  .filter((f) => f.startsWith('e2e-') && f.endsWith('.mjs'))
  .filter((f) => !filters.length || filters.some((k) => f.includes(k)))
  .sort();

if (!files.length) {
  console.error('没有匹配的 e2e 脚本' + (filters.length ? `（过滤词：${filters.join(', ')}）` : ''));
  process.exit(1);
}

/** 后端是否已在跑 */
async function backendUp() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2000);
    const r = await fetch(BASE + '/api/ping', { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

/** 起一个后端子进程并等它就绪 */
async function startBackend() {
  const child = spawn(process.execPath, [path.join(ROOT, 'web.js')], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT) },
    detached: false,
  });
  const deadline = Date.now() + 40_000; // 与桌面版的健康检查窗口同量级
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    if (await backendUp()) return child;
    if (child.exitCode !== null) throw new Error(`后端进程提前退出（code=${child.exitCode}）`);
  }
  child.kill();
  throw new Error('后端 40s 内未就绪');
}

/** 跑一个 e2e 脚本，返回是否通过 */
function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(TESTS_DIR, file)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    // 单个脚本兜底超时：playwright 自己的 30s 定位超时之上再留余量，
    // 免得一个挂死的脚本把整轮门禁拖住
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out });
    });
  });
}

let backend = null;
const reused = await backendUp();
if (reused) {
  console.log(`↻ 复用已在 ${PORT} 端口运行的后端\n`);
} else {
  console.log(`▶ 启动后端（PORT=${PORT}）…`);
  try {
    backend = await startBackend();
    console.log('✓ 后端已就绪\n');
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exit(1);
  }
}

const results = [];
for (const f of files) {
  process.stdout.write(`▶ ${f} … `);
  const r = await runOne(f);
  console.log(r.ok ? '✔ 通过' : `✖ 失败 (code=${r.code})`);
  if (!r.ok) {
    // 只回显尾部：playwright 的 call log 很长，前面多是等待过程
    const tail = r.out.trim().split('\n').slice(-12).join('\n');
    console.log(tail.replace(/^/gm, '    '));
  }
  results.push({ file: f, ...r });
}

if (backend) backend.kill();

const failed = results.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${results.length - failed.length} / ${results.length}`);
if (failed.length) {
  console.log('失败：' + failed.map((r) => r.file).join(', '));
  process.exit(1);
}

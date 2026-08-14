import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 背景（已实测复现的数据丢失）：
 *   readJson / updateJson 里的读取都是**裸 catch 吞一切异常** → `cur = fallback`，
 *   随后把 fallback normalize 后**整份写回**。
 *   实测：写入 2 个 token → 把 settings.json 截断到 60% → 一次无关的写入（setUiPrefs）之后，
 *   token 池 / 飞书 appId+appSecret / bots / mcpServers 全部归零，无报错、无备份、不可恢复。
 *
 * 触发面比想象宽：断电、进程被杀，以及 Windows 上杀毒/索引服务持句柄造成的 EBUSY/EPERM。
 *
 * 修复原则：只有 ENOENT（文件还没建）才允许用 fallback；
 * 解析失败/读取失败一律**抛错并拒绝写盘**，同时把坏文件另存为 .bak 供人工恢复。
 */

let dir;
let store;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-corrupt-'));
  process.env.APP_DATA_DIR = dir;
  // 必须在设置 APP_DATA_DIR 之后再加载：模块在求值时就固化了 DATA_DIR
  store = await import('./index.js');
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
});

const NAME = 'probe.json';
const file = () => path.join(dir, NAME);

// ── readJson ───────────────────────────────────────────────────

test('readJson：文件不存在（ENOENT）时返回 fallback —— 首次启动的正常路径', () => {
  assert.deepEqual(store.readJson(NAME, { a: 1 }), { a: 1 });
});

test('readJson：正常 JSON 正常解析', () => {
  fs.writeFileSync(file(), JSON.stringify({ tokens: ['A'] }));
  assert.deepEqual(store.readJson(NAME, {}), { tokens: ['A'] });
});

test('readJson：文件损坏时抛错，绝不返回 fallback（核心回归）', () => {
  fs.writeFileSync(file(), '{"tokens":["A","B"],"lar');
  assert.throws(() => store.readJson(NAME, { tokens: [] }), /损坏|corrupt/i);
});

// ── updateJson ─────────────────────────────────────────────────

test('updateJson：文件不存在时用 fallback 起步并正常落盘', () => {
  const r = store.updateJson(NAME, { tokens: [] }, (cur) => ({ ...cur, tokens: ['A'] }));
  assert.deepEqual(r, { tokens: ['A'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file(), 'utf8')), { tokens: ['A'] });
});

test('updateJson：损坏文件不得被 fallback 覆盖 —— 原始字节必须原封不动（核心回归）', () => {
  const corrupt = '{"tokens":[{"token":"sk-ant-REAL"},{"token":"sk-ant-REAL2"}],"lark":{"appSec';
  fs.writeFileSync(file(), corrupt);

  // 模拟「一次完全无关的写入」（真实场景：飞书进程上报一次限流 / web 改一次 UI 偏好）
  assert.throws(() => store.updateJson(NAME, { tokens: [] }, (cur) => ({ ...cur, ui: 'x' })), /损坏|corrupt/i);

  // 关键断言：坏文件仍在原地，一个字节都没被改写
  assert.equal(fs.readFileSync(file(), 'utf8'), corrupt);
});

test('updateJson：检测到损坏时把坏文件另存为 .bak，供人工恢复', () => {
  fs.writeFileSync(file(), '{"tokens":["sk-ant-REAL"],,,');
  try {
    store.updateJson(NAME, {}, (cur) => cur);
  } catch {
    /* 预期抛错 */
  }
  const baks = fs.readdirSync(dir).filter((f) => f.startsWith(NAME) && f.includes('corrupt'));
  assert.equal(baks.length, 1, `应生成一个 .bak，实际目录内容：${fs.readdirSync(dir)}`);
  assert.match(fs.readFileSync(path.join(dir, baks[0]), 'utf8'), /sk-ant-REAL/);
});

test('updateJson：fn 返回 undefined 表示放弃写盘，文件不变', () => {
  fs.writeFileSync(file(), JSON.stringify({ tokens: ['A'] }));
  const before = fs.readFileSync(file(), 'utf8');
  store.updateJson(NAME, {}, () => undefined);
  assert.equal(fs.readFileSync(file(), 'utf8'), before);
});

// ── 原子写 ──────────────────────────────────────────────────────

test('writeJson：不留 .tmp 残留，内容可完整读回', () => {
  store.writeJson(NAME, { tokens: ['A', 'B'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file(), 'utf8')), { tokens: ['A', 'B'] });
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '不应残留 tmp 文件');
});

test('空文件（断电常见形态：rename 已落但数据块未落）视为损坏而非空对象', () => {
  fs.writeFileSync(file(), '');
  assert.throws(() => store.readJson(NAME, { tokens: [] }), /损坏|corrupt/i);
});

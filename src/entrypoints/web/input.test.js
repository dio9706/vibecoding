import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMode, str, safeDecodeId } from './input.js';

// ── str：字段类型归一 ───────────────────────────────────────────
// 背景：15+ 处写成 `(data.X || '').trim()`，body 传 {"runId":123} 时
// `(123).trim is not a function` 抛在 req 的 'end' 监听器里 → uncaughtException → 进程退出
// （已实机复现）。而 runs 是纯内存的，一次崩溃 = 所有在跑的任务全灭。

test('str：字符串 trim 后返回', () => {
  assert.equal(str('  hi  '), 'hi');
  assert.equal(str('hi'), 'hi');
  assert.equal(str(''), '');
});

test('str：非字符串一律归空串，绝不抛异常（核心回归）', () => {
  assert.equal(str(123), '');
  assert.equal(str(null), '');
  assert.equal(str(undefined), '');
  assert.equal(str({}), '');
  assert.equal(str([]), '');
  assert.equal(str(['a']), '');
  assert.equal(str(true), '');
  assert.equal(str(() => {}), '');
});

test('str：原型链上的 trim 不会被误用（Object.create(String.prototype)）', () => {
  assert.equal(str(Object.create(String.prototype)), '');
});

// ── safeDecodeId：路径段解码 ────────────────────────────────────
// 背景：routes-settings.js 有 7 处裸 decodeURIComponent(url.pathname.slice(...))，
// `PUT /api/bots/%` → URIError: URI malformed → uncaughtException → 进程退出（已实机复现）。

test('safeDecodeId：普通 id 原样返回', () => {
  assert.equal(safeDecodeId('abc-123'), 'abc-123');
});

test('safeDecodeId：正常百分号编码可解（含中文）', () => {
  assert.equal(safeDecodeId('a%20b'), 'a b');
  assert.equal(safeDecodeId('%E4%B8%AD'), '中');
});

test('safeDecodeId：畸形百分号返回 null 而不是抛 URIError（核心回归）', () => {
  assert.equal(safeDecodeId('%'), null);
  assert.equal(safeDecodeId('%E4%'), null);
  assert.equal(safeDecodeId('%ZZ'), null);
});

test('safeDecodeId：空值与非字符串返回 null', () => {
  assert.equal(safeDecodeId(''), null);
  assert.equal(safeDecodeId(undefined), null);
  assert.equal(safeDecodeId(null), null);
  assert.equal(safeDecodeId(123), null);
});

// mode 会原样落到 SDK 的 permissionMode（run-claude.js:77）。
// 'bypassPermissions' = 免审批执行任意工具，因此这里必须是白名单而非透传，
// 且非法值要**降级到最严格档**（default=逐次询问），保证 fail-closed。

test('normalizeMode：四个合法档位原样保留', () => {
  assert.equal(normalizeMode('default'), 'default');
  assert.equal(normalizeMode('acceptEdits'), 'acceptEdits');
  assert.equal(normalizeMode('plan'), 'plan');
  assert.equal(normalizeMode('bypassPermissions'), 'bypassPermissions');
});

test('normalizeMode：缺省/空值归 default（不是归 bypass）', () => {
  assert.equal(normalizeMode(''), 'default');
  assert.equal(normalizeMode(undefined), 'default');
  assert.equal(normalizeMode(null), 'default');
});

test('normalizeMode：非字符串不抛异常，归 default', () => {
  assert.equal(normalizeMode(123), 'default');
  assert.equal(normalizeMode({}), 'default');
  assert.equal(normalizeMode(['bypassPermissions']), 'default');
});

test('normalizeMode：白名单外的值一律降级到 default', () => {
  assert.equal(normalizeMode('evil'), 'default');
  assert.equal(normalizeMode('__proto__'), 'default');
  assert.equal(normalizeMode('constructor'), 'default');
});

test('normalizeMode：大小写变体不放行（严格全等，防绕过）', () => {
  assert.equal(normalizeMode('BYPASSPERMISSIONS'), 'default');
  assert.equal(normalizeMode('bypasspermissions'), 'default');
});

test('normalizeMode：前后空白容错（前端可能带空格）', () => {
  assert.equal(normalizeMode('  plan  '), 'plan');
  assert.equal(normalizeMode('\tacceptEdits\n'), 'acceptEdits');
});

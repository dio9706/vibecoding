import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin, checkOrigin } from './origin.js';

// ── isAllowedOrigin：白名单本体 ─────────────────────────────────
// 放行面必须覆盖三种真实来源（改窄会把桌面版整个锁死）：
//   1. 打包 release：webview 源 tauri.localhost，跨源打 127.0.0.1:<动态端口>
//   2. tauri dev / PM2 web：同源 127.0.0.1:9701 / :3000
//   3. 浏览器直访 localhost
// 端口不固定（sidecar 冲突时 9701 自增、PM2 走 3000），故按「回环主机 + 任意端口」放行。

test('isAllowedOrigin：回环主机任意端口放行（PM2 3000 / sidecar 9701+）', () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1:3000'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:9701'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:9788'), true);
  assert.equal(isAllowedOrigin('http://localhost:3000'), true);
  assert.equal(isAllowedOrigin('http://[::1]:3000'), true);
});

test('isAllowedOrigin：Tauri webview 三种源放行（win/mac/linux 形态不同）', () => {
  assert.equal(isAllowedOrigin('http://tauri.localhost'), true);
  assert.equal(isAllowedOrigin('https://tauri.localhost'), true);
  assert.equal(isAllowedOrigin('tauri://localhost'), true);
});

test('isAllowedOrigin：外部站点一律拒绝', () => {
  assert.equal(isAllowedOrigin('https://evil.example'), false);
  assert.equal(isAllowedOrigin('http://evil.example:3000'), false);
});

test('isAllowedOrigin：后缀/前缀混淆的仿冒域名必须拒绝（防白名单绕过）', () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1.evil.com'), false);
  assert.equal(isAllowedOrigin('http://localhost.evil.com'), false);
  assert.equal(isAllowedOrigin('http://tauri.localhost.evil.com'), false);
  assert.equal(isAllowedOrigin('http://evillocalhost'), false);
  assert.equal(isAllowedOrigin('http://not-tauri.localhost'), false);
});

test('isAllowedOrigin：局域网地址不算回环，拒绝', () => {
  assert.equal(isAllowedOrigin('http://192.168.1.5:3000'), false);
  assert.equal(isAllowedOrigin('http://10.0.0.2:3000'), false);
});

test('isAllowedOrigin：null 源（sandbox iframe / file://）与畸形值拒绝，不抛异常', () => {
  assert.equal(isAllowedOrigin('null'), false);
  assert.equal(isAllowedOrigin('http://'), false);
  assert.equal(isAllowedOrigin('%%%'), false);
  assert.equal(isAllowedOrigin(123), false);
  assert.equal(isAllowedOrigin(null), false);
});

// ── checkOrigin：请求级裁决 ─────────────────────────────────────

test('checkOrigin：无 Origin 头（非浏览器/同源导航/server-to-server）放行且不回 ACAO', () => {
  assert.deepEqual(checkOrigin(undefined), { ok: true, allowOrigin: null });
  assert.deepEqual(checkOrigin(''), { ok: true, allowOrigin: null });
});

test('checkOrigin：白名单源放行并回显该源（不能回 *，否则等于没收窄）', () => {
  assert.deepEqual(checkOrigin('http://tauri.localhost'), {
    ok: true,
    allowOrigin: 'http://tauri.localhost',
  });
  assert.deepEqual(checkOrigin('http://127.0.0.1:9701'), {
    ok: true,
    allowOrigin: 'http://127.0.0.1:9701',
  });
});

test('checkOrigin：非白名单源判负，且不得回任何 ACAO 头', () => {
  const r = checkOrigin('https://evil.example');
  assert.equal(r.ok, false);
  assert.equal(r.allowOrigin, null);
});

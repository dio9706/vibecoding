/**
 * 外链归属判定的纯逻辑测试。
 *
 * 这条规则曾把桌面版整个打挂：Windows 上 Tauri 的自定义协议是
 * http://tauri.localhost/，白名单里只写了 127.0.0.1 / localhost，
 * 于是应用首页被判成「外链」——Rust 侧 on_navigation 把它丢给系统浏览器
 * 并阻断了 WebView 导航，表现为「一打开工程就弹网页、窗口空白」。
 * 抽成纯函数后在这里钉死，避免再踩。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInternalHost, shouldOpenExternally } from './nav-guard.js';

test('isInternalHost：Tauri 自定义协议的 *.localhost 一律算内部', () => {
  // 回归钉子：这三个是 Windows/Android 上 Tauri 暴露内部资源的真实 host
  assert.equal(isInternalHost('tauri.localhost'), true, '应用页面本身，判错就打不开窗口');
  assert.equal(isInternalHost('asset.localhost'), true);
  assert.equal(isInternalHost('ipc.localhost'), true);
});

test('isInternalHost：本机后端算内部', () => {
  assert.equal(isInternalHost('127.0.0.1'), true);
  assert.equal(isInternalHost('localhost'), true);
});

test('isInternalHost：外部域名算外部', () => {
  assert.equal(isInternalHost('example.com'), false);
  assert.equal(isInternalHost('anthropic.com'), false);
  // 后缀匹配不能退化成子串匹配：这两个都不是 .localhost 子域
  assert.equal(isInternalHost('notlocalhost'), false);
  assert.equal(isInternalHost('evil-localhost.com'), false);
});

test('shouldOpenExternally：只接管 http/https，其余协议交还浏览器默认行为', () => {
  assert.equal(shouldOpenExternally(new URL('https://example.com/x')), true);
  assert.equal(shouldOpenExternally(new URL('http://example.com/x')), true);
  // mailto/blob/data 不该被 opener 接管
  assert.equal(shouldOpenExternally(new URL('mailto:a@b.com')), false);
  assert.equal(shouldOpenExternally(new URL('blob:http://tauri.localhost/abc')), false);
});

test('shouldOpenExternally：打包版站内链接与 hash 锚点不外弹', () => {
  const page = 'http://tauri.localhost/index.html';
  assert.equal(shouldOpenExternally(new URL('#settings', page)), false, 'hash 锚点属于站内');
  assert.equal(shouldOpenExternally(new URL('/docs/a.html', page)), false, '相对路径属于站内');
  assert.equal(shouldOpenExternally(new URL('http://127.0.0.1:9701/api/x', page)), false, '本机后端');
});

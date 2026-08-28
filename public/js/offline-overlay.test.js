/**
 * 后端掉线罩的 DOM 测试。
 *
 * 三条不变量，每条都对应一个真实故障：
 *  1. LOGO 必须用独立 id 内联 —— 撞上启动罩的 id 是脏 DOM，且 app.css 的动画规则按
 *     #offlineStar #obtri1 限定作用域，id 一撞就没动画（罩子变成一张静止图）。
 *  2. 必须带 .ob-titlebar —— 窗口无边框（decorations(false)），inset:0 的罩子盖住
 *     header.topbar 之后窗口拖不动也关不掉，只剩托盘和 Alt+F4。
 *  3. show/hide 必须幂等 —— 多路轮询会在同一时刻集中失败，并发升罩不能堆出多个罩子。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

let dom;
let showOfflineOverlay;
let hideOfflineOverlay;

before(async () => {
  // 用真实 index.html 当骨架：需要启动罩的 #bootOverlay 结构，供末尾那条
  // 「不依赖启动罩」用例把它 remove 掉再验证掉线罩仍能正常升起
  const html = fs.readFileSync('public/index.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  dom = new JSDOM(html, { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.localStorage = dom.window.localStorage;
  // import 链会拉起 tauri-init → bootstrap，后者顶层发一个诊断 ping。
  // 不 stub 会留下 unhandled rejection 污染测试输出。
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  globalThis.EventSource = class { addEventListener() {} close() {} };

  const mod = await import('./offline-overlay.js');
  showOfflineOverlay = mod.showOfflineOverlay;
  hideOfflineOverlay = mod.hideOfflineOverlay;
});

after(() => {
  dom?.window?.close();
});

beforeEach(() => {
  hideOfflineOverlay();
});

test('升罩：建出罩子，文案为「服务器后台异常」', () => {
  showOfflineOverlay();
  const el = document.getElementById('offlineOverlay');
  assert.ok(el, '应建出 #offlineOverlay');
  assert.equal(el.hidden, false, '升罩后不应是 hidden');
  assert.ok(el.classList.contains('boot-overlay'), '应复用 .boot-overlay 布局');
  assert.ok(el.classList.contains('offline-overlay'), '应带 .offline-overlay 覆盖层级');
  assert.match(el.textContent, /服务器后台异常/, '主文案应为「服务器后台异常」');
  assert.match(el.textContent, /正在尝试重新连接/, '应有重连副文案');
});

test('LOGO 内联且用独立 id（动画规则按 id 限定作用域，撞 id 就没动画）', () => {
  showOfflineOverlay();
  const el = document.getElementById('offlineOverlay');
  const star = el.querySelector('#offlineStar');
  assert.ok(star, '应有内联的 #offlineStar');
  assert.ok(star.classList.contains('boot-star'), '应带 .boot-star 尺寸样式');
  assert.ok(star.querySelector('#obtri1'), '内层三角 id 应为 #obtri1');
  assert.ok(star.querySelector('#obtri2'), '内层三角 id 应为 #obtri2');
  // 不能撞上启动罩的 id：撞了既是重复 id，也会让 app.css 的
  // `#offlineStar #obtri1` 规则选不中（动画丢失，罩子变一张静止图）
  assert.equal(el.querySelector('#bootStar'), null, '不该出现启动罩的 #bootStar');
  assert.equal(el.querySelector('#btri1'), null, '不该出现启动罩的 #btri1');
  assert.equal(el.querySelector('#btri2'), null, '不该出现启动罩的 #btri2');
});

test('带罩内标题栏：否则无边框窗口拖不动也关不掉', () => {
  showOfflineOverlay();
  const el = document.getElementById('offlineOverlay');
  assert.ok(el.querySelector('.ob-titlebar'), '应有罩内标题栏');
  assert.ok(el.querySelector('.ob-titlebar-drag[data-tauri-drag-region]'), '应有拖拽区');
  assert.ok(el.querySelector('.wc-min'), '应有最小化按钮');
  assert.ok(el.querySelector('.wc-max'), '应有最大化按钮');
  assert.ok(el.querySelector('.wc-close'), '应有关闭按钮');
});

test('show/hide 幂等：并发升罩不堆出多个罩子', () => {
  showOfflineOverlay();
  showOfflineOverlay();
  showOfflineOverlay();
  assert.equal(document.querySelectorAll('#offlineOverlay').length, 1, '只应有一个罩子');

  hideOfflineOverlay();
  hideOfflineOverlay();
  assert.equal(document.getElementById('offlineOverlay').hidden, true, '撤罩后应为 hidden');

  // 再升起：复用同一节点，不重建
  showOfflineOverlay();
  assert.equal(document.querySelectorAll('#offlineOverlay').length, 1, '复用同一节点');
  assert.equal(document.getElementById('offlineOverlay').hidden, false);
});

test('「重新加载」按钮存在且可点（不在测试里真的 reload）', () => {
  showOfflineOverlay();
  const btn = document.querySelector('#offlineOverlay #offlineReload');
  assert.ok(btn, '应有「重新加载」按钮');
  assert.match(btn.textContent, /重新加载/);
});

test('不依赖启动罩存在：启动罩被 remove 掉之后仍能正常升罩', () => {
  // boot-gate 撤罩走 remove()，所以运行时掉线发生时 #bootOverlay 早已不在 DOM。
  // 这条用例锁住「两个罩子之间没有 DOM 依赖」这个边界 —— 曾经用克隆实现时，
  // 这种情况下 LOGO 会静默消失（cloneStar 返回 null 且不报错）。
  document.getElementById('bootOverlay')?.remove();
  document.getElementById('offlineOverlay')?.remove();

  showOfflineOverlay();
  const el = document.getElementById('offlineOverlay');
  assert.ok(el, '启动罩不在也应能建出掉线罩');
  assert.ok(el.querySelector('#offlineStar'), 'LOGO 不该缺失');
  assert.ok(el.querySelector('#obtri1') && el.querySelector('#obtri2'), '两个三角都该在');
  assert.match(el.textContent, /服务器后台异常/, '文案照旧');
});

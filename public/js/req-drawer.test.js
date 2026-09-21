import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

/**
 * 右侧抽屉原语。三件事值得钉死，都是「去掉遮罩」之后才冒出来的：
 *
 * 1. **单例**：遮罩没了，需求管理右栏的另外两个入口全程可点，不关旧的就会叠两层。
 * 2. **延一轮挂 mousedown**：打开抽屉的那一次点击还在冒泡，立刻挂监听会被它自己
 *    当成「点了外部」，表现为抽屉一闪就没。
 * 3. **停靠随布局走**：同一个选人抽屉评审期 / 开发期都开，右栏不在时得贴窗口右边缘。
 */

let dom;
let openReqDrawer;

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div class="app"></div></body></html>');
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  ({ openReqDrawer } = await import('./req-drawer.js'));
});

const app = () => document.querySelector('.app');
const drawers = () => [...document.querySelectorAll('.rq-drawer')];
const tick = () => new Promise((r) => setTimeout(r, 0)); // 等 mousedown 监听挂上

beforeEach(() => {
  app().className = 'app';
  drawers().forEach((d) => d.remove());
});

function open(opts = {}) {
  return openReqDrawer({ title: 't', bodyHtml: '<b class="inner">x</b>', footHtml: '<button class="ok">ok</button>', ...opts });
}
const pressEsc = () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
const clickOutside = () => document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));

test('挂出 head/body/foot 三段，内容落到 body 与 foot', () => {
  const { root } = open();
  assert.equal(root.querySelector('.head h3').textContent, 't');
  assert.ok(root.querySelector('.body .inner'));
  assert.ok(root.querySelector('.confirm-foot .ok'));
});

test('复用 .modal 的基础外观类', () => {
  // 抽屉只覆盖定位与尺寸，head/body/foot 的排版全靠 .modal 那份样式
  assert.ok(open().root.classList.contains('modal'));
});

test('开发期贴右栏左边缘，评审期贴窗口右边缘', () => {
  app().classList.add('req-rail-open');
  assert.ok(open().root.classList.contains('with-rail'));

  // 评审期走 panel-view：右栏被 .app.in-panel 隐藏，抽屉不能再让出那 300px
  app().classList.add('in-panel');
  assert.equal(open().root.classList.contains('with-rail'), false);

  app().className = 'app';
  assert.equal(open().root.classList.contains('with-rail'), false);
});

test('单例：开第二个会收掉第一个，并跑它的清理', () => {
  let cleaned = 0;
  open({ onClose: () => (cleaned += 1) });
  open();
  assert.equal(drawers().length, 1, '两层抽屉会彼此错位');
  assert.equal(cleaned, 1, '旧抽屉的定时器/在途请求必须被清掉');
});

test('Esc 关闭并跑 onClose', () => {
  let cleaned = 0;
  open({ onClose: () => (cleaned += 1) });
  pressEsc();
  assert.equal(drawers().length, 0);
  assert.equal(cleaned, 1);
});

test('关闭后解绑 keydown，不留永久监听', () => {
  let cleaned = 0;
  open({ onClose: () => (cleaned += 1) });
  pressEsc();
  pressEsc();
  assert.equal(cleaned, 1, '已关闭的抽屉不该再响应 Esc');
});

test('点抽屉外部关闭，点内部不关', async () => {
  const { root } = open();
  await tick();
  root.querySelector('.inner').dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(drawers().length, 1, '点内容区不该关窗——否则选文字、点按钮都会误关');
  clickOutside();
  assert.equal(drawers().length, 0);
});

test('打开时那一次点击不会立刻把自己关掉', () => {
  open();
  clickOutside(); // 同一轮事件循环里：mousedown 监听还没挂上
  assert.equal(drawers().length, 1, '立刻挂监听会让抽屉一闪就没');
});

test('canClose 为假时 Esc 与点外部都不关', async () => {
  let busy = true;
  open({ canClose: () => !busy });
  await tick();
  pressEsc();
  clickOutside();
  assert.equal(drawers().length, 1, '提交中被关掉会让用户以为提交没发出去');
  busy = false;
  pressEsc();
  assert.equal(drawers().length, 0);
});

test('点压在抽屉之上的确认弹框不会连带关掉抽屉', async () => {
  open();
  await tick();
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML = '<div class="modal"><button class="yes">确定</button></div>';
  document.body.appendChild(mask);
  mask.querySelector('.yes').dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(drawers().length, 1);
  mask.remove();
});

test('close 幂等：调用方点按钮关过之后，Esc 不再触发第二次清理', async () => {
  let cleaned = 0;
  const { close } = open({ onClose: () => (cleaned += 1) });
  await tick();
  close();
  pressEsc();
  clickOutside();
  assert.equal(cleaned, 1);
});

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

/**
 * 业务弹窗（同事对话 / 导入同事 / 指派 / 需求变动 / UI 规范）原先只能点遮罩或按钮关闭，
 * 按 Esc 没反应 —— 而 ui.js 的 confirm/prompt/textarea 三个原语一直是支持 Esc 的，
 * 同一个应用里两种关法，用户只能靠试。
 *
 * 第二件事比缺 Esc 更隐蔽：keydown 得挂在 document 上，关闭时若不解绑，
 * 每开一次弹窗就在 document 上永久多留一个监听器，且它还闭包着已卸载的 DOM。
 */

let dom;
let bindDialogDismiss;

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  ({ bindDialogDismiss } = await import('./dialog-dismiss.js'));
});

let mask;
beforeEach(() => {
  document.body.innerHTML = '';
  mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML = '<div class="modal"><button class="inner">x</button></div>';
  document.body.appendChild(mask);
});

function pressEsc() {
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
}

test('按 Esc 关闭弹窗', () => {
  let closed = 0;
  bindDialogDismiss(mask, () => { closed += 1; });
  pressEsc();
  assert.equal(closed, 1);
});

test('点遮罩本体关闭，点弹窗内部不关闭', () => {
  let closed = 0;
  bindDialogDismiss(mask, () => { closed += 1; });
  mask.querySelector('.inner').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(closed, 0, '点内容区不该关窗——否则选文字、点按钮都会误关');
  mask.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(closed, 1);
});

test('关闭后解绑 document 上的 keydown，不留永久监听', () => {
  let closed = 0;
  bindDialogDismiss(mask, () => { closed += 1; });
  pressEsc();
  pressEsc();
  pressEsc();
  assert.equal(closed, 1, '已关闭的弹窗不该再响应 Esc');
});

test('调用方主动关闭（点按钮）走返回的 close，同样解绑', () => {
  let closed = 0;
  const close = bindDialogDismiss(mask, () => { closed += 1; });
  close();
  assert.equal(closed, 1);
  pressEsc();
  assert.equal(closed, 1, '主动关闭后 Esc 不该再触发一次');
});

test('Esc 只认 Escape，别的键不关窗', () => {
  let closed = 0;
  bindDialogDismiss(mask, () => { closed += 1; });
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
  assert.equal(closed, 0);
});

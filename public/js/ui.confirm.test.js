import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

/**
 * confirmDialog 的 hideCancel：纯告知型弹窗只留一个按钮。
 * 单测这一个 flag 的理由——它的生效依赖 UA 的 [hidden]{display:none}，
 * 哪天有人给 .btn 设了 display 就会静默失效（本仓库 app.css 里同款坑记录过七次）。
 */

let dom;
let confirmDialog;

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  ({ confirmDialog } = await import('./ui.js'));
});

beforeEach(() => {
  document.body.innerHTML = '';
});

// confirmDialog 返回的 Promise 只在点击/按键后才 resolve，这里不 await 它本身——
// 拿到 DOM 断言完，用点击 OK 收尾即可，避免测试挂起。
test('hideCancel:true 时取消按钮被隐藏', () => {
  confirmDialog({ title: '提示', message: '内容', hideCancel: true });
  const cancel = document.querySelector('.confirm-foot .cancel');
  const ok = document.querySelector('.confirm-foot .ok');
  assert.equal(cancel.hidden, true);
  ok.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});

test('缺省（hideCancel 未传）时取消按钮可见', () => {
  confirmDialog({ title: '提示', message: '内容' });
  const cancel = document.querySelector('.confirm-foot .cancel');
  const ok = document.querySelector('.confirm-foot .ok');
  assert.equal(cancel.hidden, false);
  ok.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});

test('hideCancel:true 时焦点落在 OK 按钮，不落在被隐藏的取消按钮上', () => {
  confirmDialog({ title: '提示', message: '内容', hideCancel: true });
  const ok = document.querySelector('.confirm-foot .ok');
  assert.equal(document.activeElement, ok);
  ok.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});

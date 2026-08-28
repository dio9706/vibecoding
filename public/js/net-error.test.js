/**
 * 错误分类的纯逻辑测试。
 *
 * 这段逻辑此前无法被测：它长在 bootstrap.js 的 fetch 包装里，而那个包装在 jsdom 下
 * 刻意不安装（jsdom 无 window.fetch），于是四条分类规则全靠端到端兜，而端到端只跑
 * web 模式。抽成纯函数后这里能直接钉住每一条。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NETWORK_ERROR_MSG,
  makeNetworkError,
  isNetworkError,
  classifyFetchRejection,
} from './net-error.js';

test('makeNetworkError：带标记、带文案、保留 cause', () => {
  const cause = new TypeError('Failed to fetch');
  const e = makeNetworkError(cause);
  assert.equal(e.message, NETWORK_ERROR_MSG);
  assert.equal(e.isNetworkError, true);
  assert.equal(e.cause, cause, '应保留原始错误便于排查');
  assert.ok(e instanceof Error);
});

test('isNetworkError：只认标记，不认文案', () => {
  assert.equal(isNetworkError(makeNetworkError(new Error('x'))), true);
  // 文案相同但没标记 → false。这条钉住「判标记不判文本」的契约：
  // 若哪天有人改回比对 message，这里会挂
  assert.equal(isNetworkError(new Error(NETWORK_ERROR_MSG)), false);
  assert.equal(isNetworkError(new Error('别的错')), false);
  assert.equal(isNetworkError(null), false);
  assert.equal(isNetworkError(undefined), false);
});

test('分类：AbortError 不上报且原样抛（主动取消不是掉线）', () => {
  const e = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const r = classifyFetchRejection(e, {});
  assert.equal(r.report, false);
  assert.equal(r.error, e, '应原样抛出，不包装');
});

test('分类：__skipGuard 不上报且原样抛（启动期探测的旁路）', () => {
  const e = new TypeError('Failed to fetch');
  const r = classifyFetchRejection(e, { __skipGuard: true });
  assert.equal(r.report, false);
  assert.equal(r.error, e, '应原样抛出，不包装');
});

test('分类：普通网络层失败 → 上报 + 包装成带标记的错误', () => {
  const e = new TypeError('Failed to fetch');
  const r = classifyFetchRejection(e, {});
  assert.equal(r.report, true);
  assert.equal(isNetworkError(r.error), true);
  assert.equal(r.error.message, NETWORK_ERROR_MSG);
  assert.equal(r.error.cause, e);
});

test('分类：init 缺省也能工作（Request 对象形式的调用没有 init）', () => {
  const e = new TypeError('Failed to fetch');
  const r = classifyFetchRejection(e, undefined);
  assert.equal(r.report, true, 'init 为 undefined 不该崩，也不该被当成旁路');
});

test('分类：AbortError 优先于 __skipGuard（两者同时出现时都不上报，结果一致）', () => {
  const e = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const r = classifyFetchRejection(e, { __skipGuard: true });
  assert.equal(r.report, false);
  assert.equal(r.error, e);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPageToken, MAX_PAGES } from './lark.js';

// 群列表 / 群成员两个接口都是 do-while 翻页，终止条件原本只看 has_more。
// 飞书侧任何一种异常（has_more 恒真、page_token 不前进）都会让 web 进程
// 无限发 HTTP：该请求永不返回、前端挂死、还会打爆对方限流。终止判据收在这个纯函数里。

test('nextPageToken：还有下一页时返回新 token', () => {
  assert.equal(
    nextPageToken({ hasMore: true, pageToken: 'tk_2', prevToken: 'tk_1', pageIndex: 0 }),
    'tk_2',
  );
});

test('nextPageToken：has_more 为假即停', () => {
  assert.equal(nextPageToken({ hasMore: false, pageToken: 'tk_2', prevToken: 'tk_1', pageIndex: 0 }), null);
});

test('nextPageToken：has_more 为真但没给 token —— 停，不能拿空 token 再请求一遍首页', () => {
  assert.equal(nextPageToken({ hasMore: true, pageToken: '', prevToken: 'tk_1', pageIndex: 0 }), null);
  assert.equal(nextPageToken({ hasMore: true, pageToken: undefined, prevToken: 'tk_1', pageIndex: 0 }), null);
});

test('nextPageToken：token 与上一页相同 —— 停，再请求就是原地死循环', () => {
  assert.equal(nextPageToken({ hasMore: true, pageToken: 'tk_1', prevToken: 'tk_1', pageIndex: 0 }), null);
});

test('nextPageToken：到页数上限即停（token 一直在变也兜得住）', () => {
  assert.equal(
    nextPageToken({ hasMore: true, pageToken: 'tk_x', prevToken: 'tk_w', pageIndex: MAX_PAGES - 1 }),
    null,
  );
  assert.ok(MAX_PAGES >= 10, '上限要够大，别把正常的多页场景截断');
});

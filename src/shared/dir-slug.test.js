import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirSlug } from './dir-slug.js';

// 这几条原本在 entrypoints/web/req-uispec.logic.test.js 里，
// 随 dirSlug 一起迁来（它是存储层用的纯函数，不属于 web 入口）。

test('dirSlug 取目录尾段并带路径哈希', () => {
  const s = dirSlug('D:/work/op-admin-web');
  assert.match(s, /^op-admin-web-[0-9a-z]{6}$/);
});

test('dirSlug 对同名不同路径给出不同 slug', () => {
  // 前后端仓库都叫 web 是常态，撞名会让两个项目共用一份数据
  assert.notEqual(dirSlug('D:/a/web'), dirSlug('D:/b/web'));
});

test('dirSlug 忽略末尾分隔符与正反斜杠差异', () => {
  assert.equal(dirSlug('D:/work/web'), dirSlug('D:\\work\\web\\'));
});

test('dirSlug 清洗尾段里的非法文件名字符', () => {
  assert.match(dirSlug('D:/work/my proj@1'), /^my-proj-1-[0-9a-z]{6}$/);
});

test('dirSlug 空目录返回稳定兜底值', () => {
  assert.equal(dirSlug(''), dirSlug(''));
  assert.ok(dirSlug('').length > 0);
});

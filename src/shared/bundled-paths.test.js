/**
 * bundled-paths.js 测试：路径解析的形状与相对结构（开发/打包同构的支点）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledDir } from './bundled-paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // src/shared

test('bundledDir：从 src/shared 上溯两级到 assets/builtin，拼段正确且为绝对路径', () => {
  const p = bundledDir('superpowers', 'skills');
  assert.ok(path.isAbsolute(p));
  assert.equal(p, path.join(HERE, '..', '..', 'assets', 'builtin', 'superpowers', 'skills'));
  assert.ok(p.endsWith(path.join('assets', 'builtin', 'superpowers', 'skills')));
});

test('bundledDir：无参数 = assets/builtin 根；不产生多余分隔', () => {
  const root = bundledDir();
  assert.ok(root.endsWith(path.join('assets', 'builtin')));
  assert.equal(bundledDir('a'), path.join(root, 'a'));
});

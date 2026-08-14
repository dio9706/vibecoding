import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMaterial,
  hasMaterials,
  drainMaterials,
  materialDetailLine,
  clearPool,
} from './material-pool.js';

beforeEach(() => clearPool());

test('addMaterial 后 hasMaterials 为真，drain 取出并清空', () => {
  const t0 = 1_000_000;
  addMaterial('u1', 'c1', { kind: 'image', path: 'C:/x/a.png' }, t0);
  assert.equal(hasMaterials('u1', 'c1', t0), true);
  const mats = drainMaterials('u1', 'c1', t0);
  assert.equal(mats.length, 1);
  assert.equal(mats[0].kind, 'image');
  assert.equal(hasMaterials('u1', 'c1', t0), false);
});

test('不同 openId/chatId 互相隔离', () => {
  const t0 = 1_000_000;
  addMaterial('u1', 'c1', { kind: 'file', path: 'C:/x/a.pdf' }, t0);
  assert.equal(hasMaterials('u1', 'c2', t0), false);
  assert.equal(hasMaterials('u2', 'c1', t0), false);
});

test('TTL 10 分钟：过期材料不可见也不被 drain 出', () => {
  const t0 = 1_000_000;
  addMaterial('u1', 'c1', { kind: 'text', path: 'C:/x/m.md' }, t0);
  const later = t0 + 10 * 60 * 1000 + 1;
  assert.equal(hasMaterials('u1', 'c1', later), false);
  assert.deepEqual(drainMaterials('u1', 'c1', later), []);
});

test('单 key 上限 10 条，超出丢最旧', () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 12; i++) {
    addMaterial('u1', 'c1', { kind: 'image', path: `C:/x/${i}.png` }, t0 + i);
  }
  const mats = drainMaterials('u1', 'c1', t0 + 20);
  assert.equal(mats.length, 10);
  assert.equal(mats[0].path, 'C:/x/2.png'); // 0、1 被挤掉
});

test('materialDetailLine 按 kind 格式化', () => {
  assert.equal(materialDetailLine({ kind: 'image', path: 'C:/a.png' }), '[补充截图] C:/a.png');
  assert.equal(materialDetailLine({ kind: 'file', path: 'C:/a.pdf', title: '接口文档.pdf' }), '[附件] 接口文档.pdf：C:/a.pdf');
  assert.equal(materialDetailLine({ kind: 'file', path: 'C:/a.pdf' }), '[附件] C:/a.pdf');
  assert.equal(materialDetailLine({ kind: 'doc', path: 'C:/d.md', title: '联调文档' }), '[参考文档] 联调文档：C:/d.md');
  assert.equal(materialDetailLine({ kind: 'text', path: 'C:/m.md' }), '[参考材料] C:/m.md');
});

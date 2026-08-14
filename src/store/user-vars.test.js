/**
 * user-vars.js 用户变量存储 CRUD 单测。
 * 隔离：必须在动态 import 之前设 APP_DATA_DIR（store/index.js 在模块初始化时读取并定死数据目录），
 * 否则会读写项目根的真实 user-vars.json——既污染本机数据，也被本机数据污染断言。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'user-vars-test-'));
process.env.APP_DATA_DIR = TMP_DIR;
const { getVars, getVar, setVar } = await import('./user-vars.js');

after(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

test('获取空用户返回空对象', () => {
  assert.deepEqual(getVars('ou_nobody'), {});
});

test('设置和获取单个变量', () => {
  setVar('ou_user1', 'phone', '15901039503');
  assert.equal(getVar('ou_user1', 'phone'), '15901039503');
});

test('多个用户变量互不影响', () => {
  setVar('ou_user1', 'phone', '15901039503');
  setVar('ou_user1', 'email', 'test@example.com');
  setVar('ou_user2', 'phone', '13800138000');

  assert.equal(getVar('ou_user1', 'phone'), '15901039503');
  assert.equal(getVar('ou_user1', 'email'), 'test@example.com');
  assert.equal(getVar('ou_user2', 'phone'), '13800138000');
  assert.equal(getVar('ou_user2', 'email'), null);

  assert.deepEqual(getVars('ou_user1'), { phone: '15901039503', email: 'test@example.com' });
  assert.deepEqual(getVars('ou_user2'), { phone: '13800138000' });
});

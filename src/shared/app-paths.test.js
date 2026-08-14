import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { appDataDir, appDataPath, isPackaged } from './app-paths.js';

/**
 * 背景：可写目录的解析逻辑被复制了三份，其中三处**都漏了 APP_DATA_DIR**：
 *   - shared/logger.js:11        → 打包后写不进去，两处 try/catch 静默吞掉，生产环境**零日志**
 *   - integrations/lark.js:14    → mkdirSync 抛 EPERM，飞书图片/文件/文档下载全链路失效
 *   - plugins/team-tools/material-pool.js:13 → 同上
 * 打包后 __dirname 指向只读安装目录（C:\Program Files\...），必须优先用 Tauri 注入的
 * APP_DATA_DIR。store/index.js 与 routes-files.js 是写对了的两处，本模块把规则收敛成唯一来源。
 *
 * 注意：解析必须**在调用时**读环境变量，而不是模块求值时固化——否则测试无法注入，
 * 且未来若有人在启动早期改 env 也会静默失效。
 */

const ORIG = process.env.APP_DATA_DIR;
afterEach(() => {
  if (ORIG === undefined) delete process.env.APP_DATA_DIR;
  else process.env.APP_DATA_DIR = ORIG;
});

test('appDataDir：设置了 APP_DATA_DIR 时以它为准（打包态）', () => {
  process.env.APP_DATA_DIR = path.join('C:', 'Users', 'x', 'AppData', 'Roaming', 'app');
  assert.equal(appDataDir(), path.join('C:', 'Users', 'x', 'AppData', 'Roaming', 'app'));
});

test('appDataDir：未设置时回退到项目根（开发态）', () => {
  delete process.env.APP_DATA_DIR;
  const d = appDataDir();
  assert.ok(path.isAbsolute(d), '必须是绝对路径');
  // 回退值应当是仓库根（本文件在 src/shared/ 下）
  assert.ok(d.endsWith('claude-p-web-demo'), `回退目录不像项目根：${d}`);
});

test('appDataDir：空串 / 纯空白的 APP_DATA_DIR 视为未设置', () => {
  process.env.APP_DATA_DIR = '';
  const a = appDataDir();
  process.env.APP_DATA_DIR = '   ';
  const b = appDataDir();
  delete process.env.APP_DATA_DIR;
  const fallback = appDataDir();
  assert.equal(a, fallback);
  assert.equal(b, fallback);
});

test('appDataDir：每次调用都重新读环境变量（不在模块求值时固化）', () => {
  process.env.APP_DATA_DIR = path.join('C:', 'one');
  assert.equal(appDataDir(), path.join('C:', 'one'));
  process.env.APP_DATA_DIR = path.join('C:', 'two');
  assert.equal(appDataDir(), path.join('C:', 'two'), '仍返回旧值 → 说明被固化了');
});

test('appDataPath：按段拼接到可写目录下', () => {
  process.env.APP_DATA_DIR = path.join('C:', 'data');
  assert.equal(appDataPath('logs'), path.join('C:', 'data', 'logs'));
  assert.equal(appDataPath('.uploads', 'feishu'), path.join('C:', 'data', '.uploads', 'feishu'));
});

test('appDataPath：无参数时等价于 appDataDir', () => {
  process.env.APP_DATA_DIR = path.join('C:', 'data');
  assert.equal(appDataPath(), appDataDir());
});

test('isPackaged：按 APP_DATA_DIR 是否存在判定', () => {
  process.env.APP_DATA_DIR = path.join('C:', 'data');
  assert.equal(isPackaged(), true);
  delete process.env.APP_DATA_DIR;
  assert.equal(isPackaged(), false);
});

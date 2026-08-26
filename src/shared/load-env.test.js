import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { envFileCandidates, loadAppEnv, REPO_ENV_FILE } from './load-env.js';

// 纯函数 + 依赖注入：真调 process.loadEnvFile 会污染本测试进程的环境，
// 真读 fs 又会让结果取决于这台机器上有没有 .env。两者一律注入假实现。
// log 也注入掉，否则每个用例都往测试输出里插一行噪音。
const quiet = { log: () => {} };

test('envFileCandidates：打包态优先 APP_DATA_DIR/.env，仓库根作兜底', () => {
  // 回归锚点：打包后安装目录（Program Files）只读，配置只能放可写的 APP_DATA_DIR。
  // 顺序反了会在开发机上「看起来是对的」，装到别人机器上永远读不到配置。
  const c = envFileCandidates({ APP_DATA_DIR: 'D:\\data' });
  assert.equal(c[0], path.join('D:\\data', '.env'));
  assert.equal(c[1], REPO_ENV_FILE);
});

test('envFileCandidates：开发态只有仓库根 .env', () => {
  assert.deepEqual(envFileCandidates({}), [REPO_ENV_FILE]);
});

test('envFileCandidates：APP_DATA_DIR 为空/空白视为未注入', () => {
  // 空串会拼出 '.env' 这种相对路径（落到 cwd 上），而打包后 cwd 是 AppData —— 静默读错文件。
  // app-paths.js 的 isPackaged() 用的是同一套「trim 后非空」判定，两处必须一致。
  assert.deepEqual(envFileCandidates({ APP_DATA_DIR: '' }), [REPO_ENV_FILE]);
  assert.deepEqual(envFileCandidates({ APP_DATA_DIR: '   ' }), [REPO_ENV_FILE]);
});

test('envFileCandidates：脏 env 不炸', () => {
  assert.deepEqual(envFileCandidates(null), [REPO_ENV_FILE]);
  assert.deepEqual(envFileCandidates(undefined ?? {}), [REPO_ENV_FILE]);
});

test('loadAppEnv：加载第一个存在的候选，后续不再加载', () => {
  const loaded = [];
  const r = loadAppEnv({
    ...quiet,
    env: { APP_DATA_DIR: 'D:\\data' },
    exists: () => true, // 两个候选都存在
    load: (p) => loaded.push(p),
  });
  assert.deepEqual(loaded, [path.join('D:\\data', '.env')], '只应加载优先级最高的那个');
  assert.equal(r.loaded, path.join('D:\\data', '.env'));
});

test('loadAppEnv：优先级高的不存在时回落到下一个', () => {
  const loaded = [];
  const r = loadAppEnv({
    ...quiet,
    env: { APP_DATA_DIR: 'D:\\data' },
    exists: (p) => p === REPO_ENV_FILE,
    load: (p) => loaded.push(p),
  });
  assert.deepEqual(loaded, [REPO_ENV_FILE]);
  assert.equal(r.loaded, REPO_ENV_FILE);
});

test('loadAppEnv：一个候选都不存在时安静返回，绝不抛', () => {
  // 生产/CI 常靠外部注入环境变量而根本没有 .env 文件，这是正常路径而非故障
  const r = loadAppEnv({ ...quiet, env: {}, exists: () => false, load: () => assert.fail('不该加载') });
  assert.equal(r.loaded, null);
  assert.equal(r.error, undefined);
});

test('loadAppEnv：解析失败不能拖垮启动', () => {
  // .env 写坏（比如粘进一段 YAML）不该让整个机器人起不来 —— 缺变量的报错比进程秒退可读得多
  const r = loadAppEnv({
    ...quiet,
    env: {},
    exists: () => true,
    load: () => {
      throw new Error('bad syntax');
    },
  });
  assert.equal(r.loaded, null);
  assert.match(r.error, /bad syntax/);
});

test('loadAppEnv：自身不改写任何 env 键', () => {
  // 覆盖语义完全交给 process.loadEnvFile（它不动已存在的键，Node 24 实测）。
  // 这条钉住的是「我们没有自作聪明地 assign」—— 一旦自行赋值，
  // Tauri 注入的 PORT/APP_DATA_DIR 就会被文件里的旧值盖掉。
  const env = { APP_DATA_DIR: 'D:\\data', TRACKING_DB_HOST: 'from-parent' };
  loadAppEnv({ ...quiet, env, exists: () => true, load: () => {} });
  assert.deepEqual(env, { APP_DATA_DIR: 'D:\\data', TRACKING_DB_HOST: 'from-parent' });
});

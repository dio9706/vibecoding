import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// —— 依赖注入手法：见 lark.file.test.js 的详细说明 ——
// SDK 是 CJS 包，ESM 侧 `import * as Lark` 只在该模块首次被 ESM 引入时从 exports 快照命名导出。
// 必须在 import lark.js **之前**把 Client 换掉，晚一步快照就定型了。
const require = createRequire(import.meta.url);
const larkCjs = require('@larksuiteoapi/node-sdk');

/** 每个用例可改写：request 的返回值（或抛错） */
let requestImpl = () => ({ data: { user: { name: '默认名' } } });
/** 记录打到「飞书」的请求，用于断言 URL / user_id_type（绝不真的发请求） */
let calls = [];

class FakeClient {
  constructor(cfg) {
    this.cfg = cfg;
  }
  async request(opts) {
    calls.push(opts);
    return requestImpl(opts);
  }
}
larkCjs.Client = FakeClient;

process.env.LARK_APP_ID = process.env.LARK_APP_ID || 'cli_test';
process.env.LARK_APP_SECRET = process.env.LARK_APP_SECRET || 'secret_test';

const lark = await import('./lark.js');

function reset() {
  calls = [];
  lark.resetApiClient({ appId: 'cli_test', appSecret: 'secret_test' }); // 顺带清姓名缓存
}

test('getUserName: ou_ 前缀 → user_id_type=open_id，返回姓名', async () => {
  reset();
  requestImpl = () => ({ data: { user: { name: '申孟涛' } } });

  const name = await lark.getUserName('ou_0af8c9b5');
  assert.equal(name, '申孟涛');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/open-apis\/contact\/v3\/users\/ou_0af8c9b5$/);
  assert.equal(calls[0].params.user_id_type, 'open_id');
});

test('getUserName: 非 ou_ 前缀 → user_id_type=user_id（卡片回调给的是内部 userId）', async () => {
  reset();
  requestImpl = () => ({ data: { user: { name: '李四' } } });

  assert.equal(await lark.getUserName('7f8e9d0c'), '李四');
  assert.equal(calls[0].params.user_id_type, 'user_id');
});

test('getUserName: 正缓存命中，不重复请求', async () => {
  reset();
  requestImpl = () => ({ data: { user: { name: '申孟涛' } } });

  await lark.getUserName('ou_cache');
  await lark.getUserName('ou_cache');
  await lark.getUserName('ou_cache');
  assert.equal(calls.length, 1, '同一 id 只应请求一次');
});

test('getUserName: HTTP 200 但业务 code≠0 → 返回 null 并进负缓存', async () => {
  reset();
  requestImpl = () => ({ code: 99991672, msg: 'no permission' });

  assert.equal(await lark.getUserName('ou_nope'), null, 'code≠0 必须当失败');
  assert.equal(await lark.getUserName('ou_nope'), null);
  assert.equal(calls.length, 1, '负缓存生效：TTL 内不重复请求');
});

test('getUserName: 抛错 → 返回 null，不冒泡', async () => {
  reset();
  requestImpl = () => {
    throw new Error('network down');
  };
  assert.equal(await lark.getUserName('ou_err'), null);
});

test('getUserName: 负缓存按 id 粒度，一个查不到不连带压掉别人', async () => {
  reset();
  requestImpl = (opts) =>
    opts.url.endsWith('ou_bad') ? { code: 1, msg: 'not found' } : { data: { user: { name: '王五' } } };

  assert.equal(await lark.getUserName('ou_bad'), null);
  assert.equal(await lark.getUserName('ou_good'), '王五', '别的 id 必须照常解析');
});

test('getUserName: 空 id 直接返回 null，不发请求', async () => {
  reset();
  assert.equal(await lark.getUserName(''), null);
  assert.equal(await lark.getUserName(null), null);
  assert.equal(calls.length, 0);
});

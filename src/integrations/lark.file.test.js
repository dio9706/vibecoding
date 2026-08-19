import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// —— 依赖注入手法说明 ——
// lark.js 里的 client 是模块私有的 `_client`，外部拿不到；而 `resetApiClient()` 里写死了
// `new Lark.Client(...)`。要在不改动生产代码的前提下换掉它，只剩一个口子：
// SDK 是 CJS 包，ESM 侧的 `import * as Lark` 只在**该模块第一次被 ESM 引入时**
// 从 CJS 的 exports 上快照一次命名导出。所以必须抢在 lark.js 被 import 之前，
// 用 require 拿到同一个 exports 对象把 Client 换成假的 —— 换晚一步（哪怕只晚到
// import 语句执行后）快照就已经定型，替换不再生效（实测如此）。
// 正因为有这个「顺序」硬约束，下面对 lark.js 只能用动态 import，不能写成顶部 import。
const require = createRequire(import.meta.url);
const larkCjs = require('@larksuiteoapi/node-sdk');

/** 每个用例可改写的 im.v1.file.create 返回值 */
let fileCreateResult = { file_key: 'default-key' };
/** 记录打到「飞书」的调用，用于断言参数（绝不真的发请求） */
const calls = { file: [], message: [] };

class FakeClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.im = {
      v1: {
        file: {
          create: async (payload) => {
            calls.file.push(payload);
            return typeof fileCreateResult === 'function' ? fileCreateResult() : fileCreateResult;
          },
        },
        message: {
          create: async (payload) => {
            calls.message.push(payload);
            return { data: { message_id: 'msg-1' } };
          },
        },
      },
    };
  }
}
larkCjs.Client = FakeClient;

const { uploadFile, sendFile, sendFileByPath, resetApiClient } = await import('./lark.js');

beforeEach(() => {
  calls.file.length = 0;
  calls.message.length = 0;
  fileCreateResult = { file_key: 'default-key' };
  // 传显式凭证：避免读到本机 settings/env 的真实配置
  resetApiClient({ appId: 'test-app', appSecret: 'test-secret' });
});

// ==================== uploadFile：上传前的前置校验 ====================
// 这两条刻意在本地挡掉而不是交给接口报错，测试要守住的正是「没打网络请求」这一点。

test('uploadFile：空 Buffer 直接抛错，且不发起上传请求', async () => {
  await assert.rejects(() => uploadFile(Buffer.alloc(0), 'a.html'), (e) => {
    assert.match(e.message, /空文件/);
    return true;
  });
  assert.equal(calls.file.length, 0, '空文件不应该白跑一次网络请求');
});

test('uploadFile：buf 为 null/undefined 同样按空文件挡掉', async () => {
  await assert.rejects(() => uploadFile(null, 'a.html'), /空文件/);
  await assert.rejects(() => uploadFile(undefined, 'a.html'), /空文件/);
  assert.equal(calls.file.length, 0);
});

test('uploadFile：超过 30MB 抛错，错误信息里带上实际大小', async () => {
  const big = Buffer.alloc(31 * 1024 * 1024);
  await assert.rejects(() => uploadFile(big, 'big.bin'), (e) => {
    assert.match(e.message, /30MB/, '要说清限制是多少');
    // 只说「超限」用户不知道差多少，得把实际体积摆出来才知道该怎么裁
    assert.match(e.message, /31\.0MB/, `错误信息应包含实际大小，实际：${e.message}`);
    return true;
  });
  assert.equal(calls.file.length, 0);
});

test('uploadFile：恰好 30MB 属于合法（边界不能误杀）', async () => {
  fileCreateResult = { file_key: 'edge' };
  const key = await uploadFile(Buffer.alloc(30 * 1024 * 1024), 'edge.bin');
  assert.equal(key, 'edge');
  assert.equal(calls.file.length, 1);
});

// ==================== uploadFile：两种响应形状的取值兜底 ====================
// code-gen client 会剥掉外层信封，但不同 SDK 版本/不同调用路径下未必都剥，
// 两种形状都得能取到 key —— 只认一种，换个版本就静默失败。

test('uploadFile：响应顶层带 file_key 时能取到', async () => {
  fileCreateResult = { file_key: 'top-level' };
  assert.equal(await uploadFile(Buffer.from('x'), 'a.html'), 'top-level');
});

test('uploadFile：响应包在 data 里时也能取到', async () => {
  fileCreateResult = { data: { file_key: 'nested' } };
  assert.equal(await uploadFile(Buffer.from('x'), 'a.html'), 'nested');
});

test('uploadFile：响应里没有 file_key 时抛错，不返回 null 让调用方裸奔', async () => {
  fileCreateResult = { code: 0, msg: 'ok' };
  await assert.rejects(() => uploadFile(Buffer.from('x'), 'a.html'), /未返回 file_key/);
});

// ==================== uploadFile：透传给 SDK 的参数 ====================

test('uploadFile：默认走 file_type=stream，file_name 与 Buffer 原样透传', async () => {
  const buf = Buffer.from('hello');
  await uploadFile(buf, '报告.html');
  assert.equal(calls.file.length, 1);
  assert.deepEqual(calls.file[0], {
    data: { file_type: 'stream', file_name: '报告.html', file: buf },
  });
});

test('uploadFile：显式指定 fileType 时按指定值上传', async () => {
  await uploadFile(Buffer.from('x'), 'a.pdf', 'pdf');
  assert.equal(calls.file[0].data.file_type, 'pdf');
});

// ==================== sendFile ====================

test('sendFile：以 msg_type=file、content 只含 file_key 发到 chat_id', async () => {
  await sendFile('oc_chat', 'fk_123');
  assert.equal(calls.message.length, 1);
  const p = calls.message[0];
  assert.equal(p.params.receive_id_type, 'chat_id');
  assert.equal(p.data.receive_id, 'oc_chat');
  assert.equal(p.data.msg_type, 'file');
  assert.deepEqual(JSON.parse(p.data.content), { file_key: 'fk_123' });
});

// ==================== sendFileByPath ====================

test('sendFileByPath：读本地文件 → 上传 → 发文件消息，fileName 缺省取 basename', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-file-'));
  const file = path.join(dir, 'tracking-report.html');
  fs.writeFileSync(file, '<html>report</html>');
  try {
    fileCreateResult = { file_key: 'fk_report' };
    await sendFileByPath('oc_chat', file);
    assert.equal(calls.file[0].data.file_name, 'tracking-report.html');
    assert.equal(calls.file[0].data.file.toString(), '<html>report</html>');
    assert.deepEqual(JSON.parse(calls.message[0].data.content), { file_key: 'fk_report' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sendFileByPath：显式传入 fileName 时优先于 basename', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-file-'));
  const file = path.join(dir, 'tmp_abc123.html');
  fs.writeFileSync(file, 'x');
  try {
    await sendFileByPath('oc_chat', file, '埋点统计_0819.html');
    assert.equal(calls.file[0].data.file_name, '埋点统计_0819.html');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sendFileByPath：文件不存在时抛错（由调用方回退发文字摘要），不会误发空消息', async () => {
  const missing = path.join(os.tmpdir(), 'definitely-not-here-' + Date.now() + '.html');
  await assert.rejects(() => sendFileByPath('oc_chat', missing), /ENOENT/);
  assert.equal(calls.message.length, 0);
});

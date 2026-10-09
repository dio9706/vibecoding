/**
 * /api/credentials 多模型链路测试（spec `2026-10-08-credential-multi-model-design.md`）：
 * 添加不再要求 model；刷新模型列表走全局 fetch 桩（零网络）；legacy model 读侧回落为单模型列表。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-credentials-'));

const { handleCredentialsAdd, handleCredentialsList, handleCredentialsRefreshModels } = await import('./routes-settings.js');

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

function mockReq(body) {
  return Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))]);
}
function mockRes() {
  const cap = { code: 0, body: null };
  const res = {
    headersSent: false,
    setHeader() {},
    writeHead(code) {
      cap.code = code;
      res.headersSent = true;
    },
    end(text) {
      cap.body = text ? JSON.parse(text) : null;
    },
  };
  return { res, cap };
}
async function add(body) {
  const { res, cap } = mockRes();
  await handleCredentialsAdd(mockReq(body), res);
  return cap;
}
async function list() {
  const { res, cap } = mockRes();
  handleCredentialsList(res);
  return cap;
}
async function refresh(id) {
  const { res, cap } = mockRes();
  await handleCredentialsRefreshModels(mockReq(undefined), res, {
    pathname: `/api/credentials/${encodeURIComponent(id)}/refresh-models`,
  });
  return cap;
}
const findCred = (l, id) => l.body.credentials.find((x) => x.id === id);

test('add：不再要求 model；返回 credential.id，list 可见（models 暂空）', async () => {
  const cap = await add({ label: 'DeepSeek', apiKey: 'sk-a', baseURL: 'https://api.deepseek.com/v1', vendor: 'deepseek' });
  assert.equal(cap.code, 200);
  const id = cap.body.credential?.id;
  assert.ok(id, '返回新建凭证 id（前端据此接着调 refresh-models）');
  const c = findCred(await list(), id);
  assert.equal(c.vendor, 'deepseek');
  assert.deepEqual(c.models, [], '尚未发现模型');
  assert.equal(c.model, '', '新链路不写 legacy model');
});

test('add：缺 apiKey / baseURL → 400；带 legacy model 仍兼容（读侧回落单模型）', async () => {
  assert.equal((await add({ apiKey: 'sk', baseURL: '' })).code, 400);
  assert.equal((await add({ apiKey: '', baseURL: 'https://x/v1' })).code, 400);
  const cap = await add({ label: '旧凭证', apiKey: 'sk-old', baseURL: 'https://api.zhipu.com/v1', model: 'glm-4' });
  const c = findCred(await list(), cap.body.credential.id);
  assert.deepEqual(c.models, [{ id: 'glm-4' }], 'legacy model 回落为单模型列表');
  assert.equal(c.model, 'glm-4', 'legacy 字段原样保留');
});

test('refresh-models：成功拉取并落盘（list 可见 + modelsUpdatedAt），apiKey 不回显', async () => {
  const cap = await add({ label: 'DS2', apiKey: 'sk-b', baseURL: 'https://api.deepseek.com/v1' });
  const id = cap.body.credential.id;
  globalThis.fetch = async (url, opts) => {
    assert.equal(url, 'https://api.deepseek.com/v1/models');
    assert.equal(opts.headers.Authorization, 'Bearer sk-b');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }, { id: 'deepseek-v4-pro' }] }),
    };
  };
  const r = await refresh(id);
  assert.equal(r.code, 200);
  assert.equal(r.body.models.length, 2);
  const c = findCred(await list(), id);
  assert.deepEqual(c.models.map((m) => m.id), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(c.models[0].name, 'DeepSeek V4.1 Flash');
  assert.ok(c.modelsUpdatedAt);
  assert.equal(JSON.stringify(c).includes('sk-b'), false, 'apiKey 不回显');
});

test('refresh-models：上游失败 → 502 人话错误；未知 id / 非 refresh 路径 → 404', async () => {
  const cap = await add({ label: 'DS3', apiKey: 'sk-c', baseURL: 'https://api.deepseek.com/v1' });
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  const r = await refresh(cap.body.credential.id);
  assert.equal(r.code, 502);
  assert.match(r.body.error, /鉴权失败/);
  assert.equal((await refresh('tk_gone')).code, 404);

  const { res, cap: cap2 } = mockRes();
  await handleCredentialsRefreshModels(mockReq(undefined), res, { pathname: '/api/credentials/tk_x/whatever' });
  assert.equal(cap2.code, 404, '前缀下未识别的子路由 404，不误接');
});

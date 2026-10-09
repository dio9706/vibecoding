/**
 * /api/builtins 路由测试：假 req/res 直调 handler，隔离数据目录。
 *
 * GET 会对带 probe 的内置项做本地服务探测（figma-devmode）——测试里把全局 fetch 换成桩，
 * 避免真连本机 3845 端口（结果随机且可能拖慢）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

delete process.env.LARK_APP_ID;
delete process.env.LARK_APP_SECRET;
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-builtins-'));

const { handleBuiltinsList, handleBuiltinsUpdate } = await import('./routes-settings.js');

const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200 }); // 探测桩：恒可达
after(() => {
  globalThis.fetch = realFetch;
});

function mockReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body))]);
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
async function put(body) {
  const { res, cap } = mockRes();
  await handleBuiltinsUpdate(mockReq(body), res);
  return cap;
}
async function get() {
  const { res, cap } = mockRes();
  await handleBuiltinsList(res);
  return cap;
}

test('GET：返回内置 MCP 清单（含开关/路径/密钥状态/探测），默认 context7 开、figma 关', async () => {
  const cap = await get();
  assert.equal(cap.code, 200);
  const byId = Object.fromEntries(cap.body.mcp.map((m) => [m.id, m]));
  assert.deepEqual(Object.keys(byId).sort(), ['context7', 'figma-devmode', 'figma-framelink']);
  assert.equal(byId.context7.enabled, true, '默认开');
  assert.equal(byId.context7.hasKey, false);
  assert.deepEqual(byId.context7.paths, ['claude', 'openai']);
  assert.equal(byId['figma-devmode'].enabled, false, '默认关');
  assert.equal(byId['figma-devmode'].available, true, '探测被打桩');
  assert.equal(byId['figma-framelink'].needsKey.required, true);
  assert.equal(cap.body.skills.length, 1, '内置 Skills 清单');
  assert.equal(cap.body.skills[0].id, 'superpowers');
  assert.equal(cap.body.skills[0].enabled, false, '默认关');
  assert.equal(typeof cap.body.skills[0].installed, 'boolean');
  assert.deepEqual(cap.body.skills[0].disabledSkills, []);
  assert.ok(Array.isArray(cap.body.skills[0].skills), 'per-skill 清单随 GET 返回');
});

test('PUT：切开关与存密钥，GET 回读一致', async () => {
  const off = await put({ kind: 'mcp', id: 'context7', enabled: false });
  assert.equal(off.code, 200);
  let cap = await get();
  assert.equal(cap.body.mcp.find((m) => m.id === 'context7').enabled, false);

  const key = await put({ kind: 'mcp', id: 'figma-framelink', apiKey: 'fig-key', enabled: true });
  assert.equal(key.code, 200);
  cap = await get();
  const fig = cap.body.mcp.find((m) => m.id === 'figma-framelink');
  assert.equal(fig.hasKey, true);
  assert.equal(fig.enabled, true);

  // 空串清 key
  await put({ kind: 'mcp', id: 'figma-framelink', apiKey: '' });
  cap = await get();
  assert.equal(cap.body.mcp.find((m) => m.id === 'figma-framelink').hasKey, false);
});

test('PUT：未知 id 404；非法 kind 400；缺字段 400；skill 开关可用', async () => {
  assert.equal((await put({ kind: 'mcp', id: 'nope', enabled: true })).code, 404);
  assert.equal((await put({ kind: 'wat', id: 'context7', enabled: true })).code, 400);
  assert.equal((await put({ kind: 'mcp', id: 'context7' })).code, 400);
  assert.equal((await put({ kind: 'skill', id: 'superpowers', enabled: 'yes' })).code, 400);
  assert.equal((await put({ kind: 'skill', id: 'superpowers', enabled: true })).code, 200);
  const afterSkill = await get();
  assert.equal(afterSkill.body.skills.find((s) => s.id === 'superpowers').enabled, true);
  assert.equal((await put({ kind: 'skill', id: 'ghost', enabled: true })).code, 400);
});

test('PUT：per-skill 开关（skillId）落盘并回读；未知技能项 400', async () => {
  assert.equal((await put({ kind: 'skill', id: 'superpowers', skillId: 'brainstorming', enabled: false })).code, 200);
  const cap = await get();
  const sp = cap.body.skills.find((s) => s.id === 'superpowers');
  assert.deepEqual(sp.disabledSkills, ['brainstorming'], '停用清单只存被停用项');
  const item = sp.skills.find((i) => i.id === 'brainstorming');
  if (item) assert.equal(item.enabled, false, '已安装环境应反映 per-skill 状态');

  assert.equal((await put({ kind: 'skill', id: 'superpowers', skillId: 'nope', enabled: false })).code, 400);
  assert.equal((await put({ kind: 'skill', id: 'superpowers', skillId: '', enabled: false })).code, 400);
  assert.equal((await put({ kind: 'skill', id: 'superpowers', skillId: 'brainstorming' })).code, 400, 'skillId 需要 enabled');

  // 恢复启用 → 清单清空
  assert.equal((await put({ kind: 'skill', id: 'superpowers', skillId: 'brainstorming', enabled: true })).code, 200);
  assert.deepEqual((await get()).body.skills.find((s) => s.id === 'superpowers').disabledSkills, []);
});

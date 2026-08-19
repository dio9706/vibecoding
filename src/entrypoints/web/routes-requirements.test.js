/**
 * routes-requirements 单测 —— 真实 HTTP server + fetch 联调，验证响应形状/状态码/接线契约。
 * 只挂 handleRequirementRoutes 本身（不经完整 server.js），避免拉起飞书/token 等无关依赖；
 * 不调用 startRequirementPump —— 队列只入不出，断言基于 hasQueuedTasks 而非真正派发。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';

// 防 env 污染：bitable 路由的「必然失败路径」测试依赖空凭证时 Lark SDK 同步抛错（见对应用例注释）。
// 若 shell 环境导出了真实 LARK_APP_ID/LARK_APP_SECRET，会变成真的发起网络请求，必须先清空。
delete process.env.LARK_APP_ID;
delete process.env.LARK_APP_SECRET;

// 隔离数据目录：本模块间接 import store/requirements.js（读盘），须在 import 前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'req-routes-'));

const { handleRequirementRoutes } = await import('./routes-requirements.js');
const { updateRequirement, getRequirement } = await import('../../store/requirements.js');
const { hasQueuedTasks, reqDir } = await import('./requirement-ops.js');
const { setMyFeishuOpenId } = await import('../../store/settings.js');

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    handleRequirementRoutes(req, res, url);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let server;
let base;
test.before(async () => {
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(pathname, method, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(base + pathname, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const get = (p) => call(p, 'GET');
const post = (p, b) => call(p, 'POST', b ?? {});
const put = (p, b) => call(p, 'PUT', b ?? {});
const del = (p, b) => call(p, 'DELETE', b ?? {});

async function createReq(title) {
  const r = await post('/api/req/create', { title });
  return r.json;
}

test('create → list → get 回读：201/200，list 投影字段，get 含 devDocLatest:null', async () => {
  const created = await post('/api/req/create', { title: '测试需求A' });
  assert.equal(created.status, 201);
  assert.equal(created.json.title, '测试需求A');
  assert.equal(created.json.phase, 'review');
  const id = created.json.id;

  const list = await get('/api/req/list');
  assert.equal(list.status, 200);
  const item = list.json.requirements.find((r) => r.id === id);
  assert.ok(item, '新建需求应出现在列表中');
  assert.deepEqual(Object.keys(item).sort(), ['busy', 'id', 'phase', 'sessions', 'title', 'updatedAt'].sort());
  assert.equal(item.busy, false);

  const got = await get('/api/req/get?id=' + id);
  assert.equal(got.status, 200);
  assert.equal(got.json.id, id);
  assert.equal(got.json.devDocLatest, null);
});

test('doc：指定版本成功回读；版本不存在 404；需求不存在 404', async () => {
  const req = await createReq('doc测试需求');
  const id = req.id;
  const docPath = reqDir(id, 'dev-doc-v1.md');
  fs.writeFileSync(docPath, '# 开发文档 v1 正文', 'utf8');
  updateRequirement(id, { devDoc: { versions: [{ v: 1, path: docPath, summary: 's', at: new Date().toISOString() }] } });

  const ok = await get(`/api/req/doc?id=${id}&v=1`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.content, '# 开发文档 v1 正文');

  const missingV = await get(`/api/req/doc?id=${id}&v=2`);
  assert.equal(missingV.status, 404);

  const missingId = await get('/api/req/doc?id=r_not_exist&v=1');
  assert.equal(missingId.status, 404);
});

test('create：空 title → 400', async () => {
  const r = await post('/api/req/create', { title: '   ' });
  assert.equal(r.status, 400);
});

test('create：title 超过 60 字符 → 400', async () => {
  const r = await post('/api/req/create', { title: 'a'.repeat(61) });
  assert.equal(r.status, 400);
});

test('config：正常写入；dev 期修改被拒 409；title 不被 config 修改', async () => {
  const req = await createReq('配置测试需求');
  const id = req.id;

  const cfg = await put('/api/req/config', {
    id,
    title: '想篡改的标题',
    projects: { frontend: { dir: 'D:/fe', dev: true }, backend: null },
    reqDoc: { name: 'req.md', text: '需求正文' },
  });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.json.projects.frontend.dir, 'D:/fe');
  assert.equal(cfg.json.reqDoc.name, 'req.md');
  assert.equal(cfg.json.title, '配置测试需求'); // 未被篡改

  updateRequirement(id, { phase: 'dev' });
  const cfg2 = await put('/api/req/config', { id, projects: { frontend: { dir: 'D:/fe2', dev: true } } });
  assert.equal(cfg2.status, 409);
});

test('config：projects 字段非法（dir 为空 / dev 非 boolean）→ 400', async () => {
  const req = await createReq('config校验测试需求');
  const bad1 = await put('/api/req/config', { id: req.id, projects: { frontend: { dir: '', dev: true } } });
  assert.equal(bad1.status, 400);
  const bad2 = await put('/api/req/config', { id: req.id, projects: { frontend: { dir: 'D:/x', dev: 'yes' } } });
  assert.equal(bad2.status, 400);
});

test('config：projects 传数组 → 400（防 [] 静默 200 无操作）', async () => {
  const req = await createReq('config数组校验测试需求');
  const bad = await put('/api/req/config', { id: req.id, projects: [] });
  assert.equal(bad.status, 400);
});

test('config：reqDoc.path 不存在 → 400', async () => {
  const req = await createReq('reqDoc路径测试需求');
  const r = await put('/api/req/config', { id: req.id, reqDoc: { name: 'x.md', path: 'D:/__not_exist__.md' } });
  assert.equal(r.status, 400);
});

test('config：需求不存在 → 404', async () => {
  const r = await put('/api/req/config', { id: 'r_not_exist', projects: {} });
  assert.equal(r.status, 404);
});

test('docgen：非评审期 → 409（对齐 config/supplement/apidoc/guidelines 同类守卫）', async () => {
  const req = await createReq('docgen非评审期测试需求');
  updateRequirement(req.id, { phase: 'dev' });
  const r = await post('/api/req/docgen', { id: req.id });
  assert.equal(r.status, 409);
});

test('docgen：无工程/无 reqDoc → 400；配置齐全后 202 且 hasQueuedTasks；重复请求 409', async () => {
  const req = await createReq('docgen测试需求');
  const id = req.id;

  const bad = await post('/api/req/docgen', { id });
  assert.equal(bad.status, 400);

  await put('/api/req/config', {
    id,
    projects: { frontend: { dir: 'D:/fe-docgen', dev: true }, backend: null },
    reqDoc: { name: 'req.md', text: '需求正文' },
  });

  const ok = await post('/api/req/docgen', { id });
  assert.equal(ok.status, 202);
  assert.equal(hasQueuedTasks(id), true);

  // 202 仅代表入队（busy 要等泵 tick 派发时才写入）：get/list 必须暴露排队态，
  // 否则前端 202 后立即刷新拿到 busy=null，既不亮 loading 也不启动轮询
  const got = await get('/api/req/get?id=' + id);
  assert.equal(got.json.queued, true);
  const list = await get('/api/req/list');
  assert.equal(list.json.requirements.find((r) => r.id === id).busy, true);

  const dup = await post('/api/req/docgen', { id });
  assert.equal(dup.status, 409);
});

test('supplement：先落盘再入队（202 后 supplements.length===1 且 hasQueuedTasks true）', async () => {
  const req = await createReq('supplement测试需求');
  const id = req.id;
  await put('/api/req/config', {
    id,
    projects: { frontend: { dir: 'D:/fe-supp', dev: true }, backend: null },
    reqDoc: { name: 'req.md', text: '需求正文' },
  });

  const r = await post('/api/req/supplement', { id, text: '补充说明1' });
  assert.equal(r.status, 202);
  const after = getRequirement(id);
  assert.equal(after.supplements.length, 1);
  assert.equal(after.supplements[0].text, '补充说明1');
  assert.equal(hasQueuedTasks(id), true);
});

test('supplement：未配置 reqDoc/工程时 → 200 且不入队，仅落盘', async () => {
  const req = await createReq('supplement未配置测试需求');
  const id = req.id;
  const r = await post('/api/req/supplement', { id, text: '先记一笔' });
  assert.equal(r.status, 200);
  assert.match(r.json.note, /已记录/);
  assert.equal(getRequirement(id).supplements.length, 1);
  assert.equal(hasQueuedTasks(id), false);
});

test('supplement：text 空且 files 空 → 400', async () => {
  const req = await createReq('supplement空提交测试需求');
  const r = await post('/api/req/supplement', { id: req.id, text: '  ' });
  assert.equal(r.status, 400);
});

test('supplement：files 数组里全是 name/path 均空的占位条目 → 视为空，400（不误判为有附件）', async () => {
  const req = await createReq('supplement占位files测试需求');
  const r = await post('/api/req/supplement', { id: req.id, text: '  ', files: [{}] });
  assert.equal(r.status, 400);
});

test('supplement：仅 files 无 text → 202（配置齐全时）', async () => {
  const req = await createReq('supplement仅files测试需求');
  const id = req.id;
  await put('/api/req/config', {
    id,
    projects: { frontend: { dir: 'D:/fe-supp-files', dev: true }, backend: null },
    reqDoc: { name: 'req.md', text: '需求正文' },
  });
  const r = await post('/api/req/supplement', { id, files: [{ name: 'a.png', path: 'D:/a.png' }] });
  assert.equal(r.status, 202);
  const after = getRequirement(id);
  assert.equal(after.supplements.length, 1);
  assert.equal(after.supplements[0].text, '');
  assert.deepEqual(after.supplements[0].files, [{ name: 'a.png', path: 'D:/a.png' }]);
});

test('finalize：需求不存在 → 404（不走 finalizeGuard 的误导性 409）', async () => {
  const r = await post('/api/req/finalize', { id: 'r_not_exist' });
  assert.equal(r.status, 404);
});

test('apidoc：仅 dev 期可维护，review 期 409；dev 期新增/更新/删除 202', async () => {
  const req = await createReq('apidoc测试需求');
  const id = req.id;
  const tmpFile = path.join(os.tmpdir(), 'apidoc-test-' + Date.now() + '.md');
  fs.writeFileSync(tmpFile, '# api');

  const early = await post('/api/req/apidoc', { id, name: 'a.md', path: tmpFile });
  assert.equal(early.status, 409);

  updateRequirement(id, { phase: 'dev' });
  const added = await post('/api/req/apidoc', { id, name: 'a.md', path: tmpFile });
  assert.equal(added.status, 202);
  assert.equal(added.json.action, '新增');
  assert.equal(getRequirement(id).apiDocs.length, 1);

  const updated = await post('/api/req/apidoc', { id, name: 'a.md', path: tmpFile });
  assert.equal(updated.status, 202);
  assert.equal(updated.json.action, '更新');
  assert.equal(getRequirement(id).apiDocs.length, 1); // 同名替换而非追加

  const docId = getRequirement(id).apiDocs[0].id;
  const removed = await del('/api/req/apidoc', { id, docId });
  assert.equal(removed.status, 202);
  assert.equal(removed.json.action, '删除');
  assert.equal(getRequirement(id).apiDocs.length, 0);

  fs.unlinkSync(tmpFile);
});

test('guidelines：仅 dev/test 期可编辑，review 期 409；dev 期写入并截断至 5000 字符', async () => {
  const req = await createReq('guidelines测试需求');
  const id = req.id;
  const early = await put('/api/req/guidelines', { id, text: 'x' });
  assert.equal(early.status, 409);

  updateRequirement(id, { phase: 'dev' });
  const r = await put('/api/req/guidelines', { id, text: 'y'.repeat(6000) });
  assert.equal(r.status, 200);
  assert.equal(getRequirement(id).designGuidelines.length, 5000);
});

test('guidelines：test 期同样允许编辑（非 review 期即可，不限定 dev）', async () => {
  const req = await createReq('guidelines测试期测试需求');
  const id = req.id;
  updateRequirement(id, { phase: 'test' });
  const r = await put('/api/req/guidelines', { id, text: '测试期准则' });
  assert.equal(r.status, 200);
  assert.equal(getRequirement(id).designGuidelines, '测试期准则');
});

test('guidelines：text 非字符串（如对象）→ fail-closed 归空串，不落盘 [object Object]', async () => {
  const req = await createReq('guidelines非法类型测试需求');
  const id = req.id;
  updateRequirement(id, { phase: 'dev' });
  const r = await put('/api/req/guidelines', { id, text: { evil: true } });
  assert.equal(r.status, 200);
  assert.equal(getRequirement(id).designGuidelines, '');
});

test('conv：绑定会话可覆盖', async () => {
  const req = await createReq('conv测试需求');
  const id = req.id;
  const r1 = await post('/api/req/conv', { id, convId: 'c1' });
  assert.equal(r1.status, 200);
  assert.equal(getRequirement(id).convId, 'c1');
  const r2 = await post('/api/req/conv', { id, convId: 'c2' });
  assert.equal(r2.status, 200);
  assert.equal(getRequirement(id).convId, 'c2');
});

test('conv：convId 空 → 400', async () => {
  const req = await createReq('conv空测试需求');
  const r = await post('/api/req/conv', { id: req.id, convId: '' });
  assert.equal(r.status, 400);
});

test('dev-done：review 期 409；dev 期 busy 非空 409；busy 清空后 200 phase=test', async () => {
  const req = await createReq('devdone测试需求');
  const id = req.id;

  const r1 = await post('/api/req/dev-done', { id });
  assert.equal(r1.status, 409); // review → test 不是相邻推进

  updateRequirement(id, { phase: 'dev', busy: { kind: 'develop', runId: 'x' } });
  const r2 = await post('/api/req/dev-done', { id });
  assert.equal(r2.status, 409);

  updateRequirement(id, { busy: null });
  const r3 = await post('/api/req/dev-done', { id });
  assert.equal(r3.status, 200);
  assert.equal(r3.json.phase, 'test');
});

test('test-pass：dev 期 409（不是相邻推进）；test 期正常 → archiving', async () => {
  const req = await createReq('testpass测试需求');
  const id = req.id;
  updateRequirement(id, { phase: 'dev' });
  const bad = await post('/api/req/test-pass', { id });
  assert.equal(bad.status, 409);

  updateRequirement(id, { phase: 'test' });
  const ok = await post('/api/req/test-pass', { id });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.phase, 'archiving');
});

test('未知子路径 404', async () => {
  const r1 = await get('/api/req/unknown-path');
  assert.equal(r1.status, 404);
});

test('archive：需求不存在 404；非 archiving 期（相邻推进不满足）409；archiving 期成功 200 且回读 phase=archived', async () => {
  const missing = await post('/api/req/archive', { id: 'r_not_exist', note: '备注' });
  assert.equal(missing.status, 404);

  const req = await createReq('归档测试需求');
  const early = await post('/api/req/archive', { id: req.id, note: '备注' });
  assert.equal(early.status, 409); // 默认 review 期，不是相邻推进

  updateRequirement(req.id, { phase: 'archiving', branches: [] }); // branches 留空数组，零 git 依赖
  const ok = await post('/api/req/archive', { id: req.id, note: '本次改动备注' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);

  const after = getRequirement(req.id);
  assert.equal(after.phase, 'archived');
  assert.ok(after.archive?.summary);
  assert.equal(after.archive.note, '本次改动备注');
});

test('bitable：需求不存在 404；非测试期 409；busy/排队中 409', async () => {
  const missing = await post('/api/req/bitable', { id: 'r_not_exist', url: 'https://x.feishu.cn/base/bascnAAA' });
  assert.equal(missing.status, 404);

  const req = await createReq('bitable非测试期测试需求');
  const early = await post('/api/req/bitable', { id: req.id, url: 'https://x.feishu.cn/base/bascnAAA' });
  assert.equal(early.status, 409); // 默认 review 期

  updateRequirement(req.id, { phase: 'test', busy: { kind: 'develop', runId: 'r1' } });
  const busyBlocked = await post('/api/req/bitable', { id: req.id, url: 'https://x.feishu.cn/base/bascnAAA' });
  assert.equal(busyBlocked.status, 409);
});

test('bitable：身份未配置（myFeishuOpenId 空且无可信名单）→ 400，不受理（N2：受理前预检，不必等巡检自己失败才让用户发现）', async () => {
  const req = await createReq('bitable身份未配置测试需求');
  updateRequirement(req.id, { phase: 'test' });
  setMyFeishuOpenId(''); // 显式清空，不受其他测试残留影响
  const r = await post('/api/req/bitable', { id: req.id, url: 'https://x.feishu.cn/base/bascnNOIDENTITY' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /我的飞书/);
});

test('bitable：url 解析不出多维表格链接 → 400', async () => {
  const req = await createReq('bitable非法链接测试需求');
  updateRequirement(req.id, { phase: 'test' });
  setMyFeishuOpenId('ou_test_badurl_route'); // 先满足身份预检，确保命中的是 url 解析这道守卫
  const r = await post('/api/req/bitable', { id: req.id, url: '这不是一个链接' });
  assert.equal(r.status, 400);
});

test('bitable：正常受理 202，巡检自跑（无真实凭证必然失败）；history 留痕「开始表格巡检」与失败原因，最终 busy 被清', async () => {
  const req = await createReq('bitable正常受理测试需求');
  updateRequirement(req.id, { phase: 'test' });
  setMyFeishuOpenId('ou_test_identity_' + Date.now());

  const r = await post('/api/req/bitable', { id: req.id, url: 'https://x.feishu.cn/base/bascnTESTTOKEN123' });
  assert.equal(r.status, 202);
  assert.equal(r.json.ok, true);

  // inspectBitable 的失败路径全程只经 microtask（无真实凭证时 lark client 同步抛错，不发起网络请求），
  // 一次 setTimeout 落地即可保证其已跑完；不依赖真实网络，也不断言执行期间的中间态（避免时序竞争）。
  await new Promise((resolve) => setTimeout(resolve, 50));
  const after = getRequirement(req.id);
  assert.equal(after.busy, null);
  assert.ok(after.history.some((h) => h.event === '开始表格巡检'));
  assert.ok(after.history.some((h) => h.event.startsWith('表格巡检失败')));
});

test('bug/confirm|ignore|retry：需求不存在 → 404；bugId 空 → 400', async () => {
  const missing = await post('/api/req/bug/confirm', { id: 'r_not_exist', bugId: 'b1' });
  assert.equal(missing.status, 404);

  const req = await createReq('bug操作参数校验测试需求');
  const noBugId = await post('/api/req/bug/ignore', { id: req.id });
  assert.equal(noBugId.status, 400);
});

test('bug/confirm：doubt 态确认 → 200，转 pending 并入队 bug-fix；BUG 不存在 → 404', async () => {
  const req = await createReq('bugconfirm测试需求');
  const id = req.id;
  updateRequirement(id, {
    bugs: [{ id: 'b1', recordId: 'rec1', title: 'T1', detail: 'D1', verdict: 'doubt', reason: '不确定', status: 'pending', at: new Date().toISOString() }],
  });
  const r = await post('/api/req/bug/confirm', { id, bugId: 'b1' });
  assert.equal(r.status, 200);
  assert.equal(getRequirement(id).bugs[0].status, 'pending');
  assert.equal(getRequirement(id).bugs[0].verdict, 'sure'); // N3：确认后 verdict 转 sure，前端不再残留「确认」按钮
  assert.equal(hasQueuedTasks(id), true);

  const missingBug = await post('/api/req/bug/confirm', { id, bugId: 'no-such-bug' });
  assert.equal(missingBug.status, 404);
});

test('bug/ignore：正常忽略 → 200 且状态 ignored；修复中的 BUG 忽略 → 409', async () => {
  const req = await createReq('bugignore测试需求');
  const id = req.id;
  updateRequirement(id, {
    bugs: [
      { id: 'b1', recordId: 'rec1', title: 'T1', detail: 'D1', verdict: 'sure', reason: '', status: 'pending', at: new Date().toISOString() },
      { id: 'b2', recordId: 'rec2', title: 'T2', detail: 'D2', verdict: 'sure', reason: '', status: 'fixing', at: new Date().toISOString() },
    ],
  });
  const r = await post('/api/req/bug/ignore', { id, bugId: 'b1' });
  assert.equal(r.status, 200);
  assert.equal(getRequirement(id).bugs.find((b) => b.id === 'b1').status, 'ignored');

  const blocked = await post('/api/req/bug/ignore', { id, bugId: 'b2' });
  assert.equal(blocked.status, 409);
});

test('bug/retry：failed 态重试 → 200，转 pending 并入队；非 failed 态重试 → 409', async () => {
  const req = await createReq('bugretry测试需求');
  const id = req.id;
  updateRequirement(id, {
    bugs: [
      { id: 'b1', recordId: 'rec1', title: 'T1', detail: 'D1', verdict: 'sure', reason: '', status: 'failed', at: new Date().toISOString() },
      { id: 'b2', recordId: 'rec2', title: 'T2', detail: 'D2', verdict: 'sure', reason: '', status: 'pending', at: new Date().toISOString() },
    ],
  });
  const r = await post('/api/req/bug/retry', { id, bugId: 'b1' });
  assert.equal(r.status, 200);
  assert.equal(getRequirement(id).bugs.find((b) => b.id === 'b1').status, 'pending');
  assert.equal(hasQueuedTasks(id), true);

  const notFailed = await post('/api/req/bug/retry', { id, bugId: 'b2' });
  assert.equal(notFailed.status, 409);
});

test('session：POST 新建子会话登记，sessionId 可空', async () => {
  const req = await createReq('会话新建测试需求');
  const id = req.id;

  const r = await post('/api/req/session', { id, convId: 'conv_sub1', title: '子会话1', kind: 'sub' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);

  const after = getRequirement(id);
  const sessions = after.sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].convId, 'conv_sub1');
  assert.equal(sessions[0].title, '子会话1');
  assert.equal(sessions[0].kind, 'sub');
  assert.equal(sessions[0].sessionId, null);
});

test('session：POST 补齐 sessionId 幂等（已存在的 convId 不改 kind）', async () => {
  const req = await createReq('会话补齐测试需求');
  const id = req.id;

  // 首次新建无 sessionId
  const r1 = await post('/api/req/session', { id, convId: 'conv_sub1', title: '子会话1', kind: 'sub' });
  assert.equal(r1.status, 200);
  let after = getRequirement(id);
  assert.equal(after.sessions[0].sessionId, null);

  // 补齐 sessionId
  const r2 = await post('/api/req/session', { id, convId: 'conv_sub1', sessionId: 'session_123', title: '子会话1', kind: 'sub' });
  assert.equal(r2.status, 200);
  after = getRequirement(id);
  assert.equal(after.sessions[0].sessionId, 'session_123');
  assert.equal(after.sessions.length, 1); // 幂等，没有增加新记录
  assert.equal(after.sessions[0].kind, 'sub'); // kind 未改
});

test('session：DELETE 删除子会话，不能删 main', async () => {
  const req = await createReq('会话删除测试需求');
  const id = req.id;

  // 新建两个会话
  await post('/api/req/session', { id, convId: 'conv_sub1', title: '子会话1', kind: 'sub' });
  await post('/api/req/session', { id, convId: 'conv_main', sessionId: 'session_main', title: '主会话', kind: 'main' });

  let after = getRequirement(id);
  assert.equal(after.sessions.length, 2);

  // 删除子会话成功
  const r1 = await del('/api/req/session', { id, convId: 'conv_sub1' });
  assert.equal(r1.status, 200);

  after = getRequirement(id);
  assert.equal(after.sessions.length, 1);
  assert.equal(after.sessions[0].kind, 'main');

  // 尝试删 main 被拒 409
  const r2 = await del('/api/req/session', { id, convId: 'conv_main' });
  assert.equal(r2.status, 409);
  assert.match(r2.json.error, /不能删除主会话/);

  after = getRequirement(id);
  assert.equal(after.sessions.length, 1); // 仍然有 main
});

test('session：DELETE 会话不存在 404', async () => {
  const req = await createReq('会话删除不存在测试需求');
  const r = await del('/api/req/session', { id: req.id, convId: 'not_exist_conv' });
  assert.equal(r.status, 404);
});

test('pitfalls：POST 写入前端避坑清单（需要前端工程配置）', async () => {
  const req = await createReq('避坑清单前端测试需求');
  const id = req.id;

  // 未配置工程时被跳过
  const r1 = await post('/api/req/pitfalls', { id, frontend: ['避坑1'], backend: [] });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.written.frontend, 0);
  assert.equal(r1.json.skipped.length, 1);
  assert.match(r1.json.skipped[0].error, /前端工程未配置/);

  // 配置工程并重试
  const tmpDir = path.join(os.tmpdir(), 'pitfalls-fe-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  await put('/api/req/config', {
    id,
    projects: { frontend: { dir: tmpDir, dev: true }, backend: null },
  });

  const r2 = await post('/api/req/pitfalls', { id, frontend: ['避坑1', '避坑2'], backend: [] });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.written.frontend, 2);
  assert.equal(r2.json.written.backend, 0);

  // 验证文件已写入
  const pitfallsPath = path.join(tmpDir, '.claude', 'pitfalls.md');
  assert.ok(fs.existsSync(pitfallsPath));
  const content = fs.readFileSync(pitfallsPath, 'utf8');
  assert.match(content, /避坑1/);
  assert.match(content, /避坑2/);

  // 清理
  fs.rmSync(tmpDir, { recursive: true });
});

test('pitfalls：POST 后端仅写 dev=true 的工程，read-only 工程不写', async () => {
  const req = await createReq('避坑清单后端readonly测试需求');
  const id = req.id;

  const tmpDir = path.join(os.tmpdir(), 'pitfalls-be-readonly-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  // 配置后端为 read-only
  await put('/api/req/config', {
    id,
    projects: { frontend: null, backend: { dir: tmpDir, dev: false } },
  });

  const r = await post('/api/req/pitfalls', { id, frontend: [], backend: ['后端避坑1'] });
  assert.equal(r.status, 200);
  assert.equal(r.json.written.backend, 0);
  assert.equal(r.json.skipped.length, 1);
  assert.match(r.json.skipped[0].error, /后端为只读工程/);

  // 验证文件未写入
  const pitfallsPath = path.join(tmpDir, '.claude', 'pitfalls.md');
  assert.ok(!fs.existsSync(pitfallsPath));

  // 清理
  fs.rmSync(tmpDir, { recursive: true });
});

test('get：返回体含 sessions 与 seed 派生字段', async () => {
  const req = await createReq('get派生字段测试需求');
  const id = req.id;

  updateRequirement(id, { phase: 'dev' });
  const r = await get('/api/req/get?id=' + id);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.sessions));
  assert.ok(typeof r.json.seed === 'string');

  // review 期 seed 应为 null
  updateRequirement(id, { phase: 'review' });
  const r2 = await get('/api/req/get?id=' + id);
  assert.equal(r2.json.seed, null);
});

test('POST /api/req/session：尝试改变已有会话的 kind 应返回 409', async () => {
  const req = await createReq('kind改变测试');
  const id = req.id;
  const convId = 'c_kind_test_123';

  // 先创建 sub 会话
  const first = await post('/api/req/session', { id, convId, kind: 'sub', title: '子会话' });
  assert.equal(first.status, 200);

  // 再试图改为 main → 应 409
  const second = await post('/api/req/session', { id, convId, kind: 'main', title: '试图改为主' });
  assert.equal(second.status, 409);
  assert.match(second.json.error, /kind/);
});

test('POST /api/req/session：main kind 时应补齐 devSession', async () => {
  const req = await createReq('devSession回填测试');
  const id = req.id;
  const convId = 'c_main_dev_test_456';

  // 创建 main 会话并补齐 sessionId
  const res = await post('/api/req/session', {
    id,
    convId,
    sessionId: 's_dev_789',
    kind: 'main',
    title: '主会话'
  });
  assert.equal(res.status, 200);

  // 查询需求，验证 devSession 是否被回填
  const updated = getRequirement(id);
  assert.equal(updated.devSession, 's_dev_789');
});

test('POST /api/req/pitfalls：前端工程 dev=false 时应跳过', async () => {
  const req = await createReq('前端dev=false测试');
  const id = req.id;

  const tmpDir = path.join(os.tmpdir(), 'pitfalls-fe-readonly-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  // 配置前端为 read-only
  await put('/api/req/config', {
    id,
    projects: {
      frontend: { dir: tmpDir, dev: false },
      backend: null,
    },
  });

  // 试图写规则到 read-only 前端
  const res = await post('/api/req/pitfalls', {
    id,
    frontend: ['条目1'],
    backend: [],
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.written.frontend, 0);
  assert.ok(res.json.skipped.some(s => s.side === 'frontend'));

  // 清理
  fs.rmSync(tmpDir, { recursive: true });
});

// ==== 回归：会话标题被「新会话」覆盖（2026-08-13）====
// 症状：需求会话树里所有标题都变成「新会话」，用户改的标题不生效。
// 根因：chat.js 在 run 启动回填 sessionId 时只带 sessionId，不带 title；
// 后端把缺失的 title 兜底成 '新会话' 后无条件覆盖已有标题 → 跑一次 run 标题就被打回。
// 契约：只有「显式传了 title」才允许改标题；不传 = 不动。
test('session：回填 sessionId 不带 title 时，不得覆盖已有标题', async () => {
  const req = await createReq('标题保护测试需求');
  const id = req.id;

  await post('/api/req/session', { id, convId: 'conv_t1', title: '登录页修复', kind: 'sub' });

  // 模拟 chat.js 的 sessionId 回填：只有 id/convId/sessionId
  const r = await post('/api/req/session', { id, convId: 'conv_t1', sessionId: 'sess_t1' });
  assert.equal(r.status, 200);

  const after = getRequirement(id);
  assert.equal(after.sessions.length, 1);
  assert.equal(after.sessions[0].sessionId, 'sess_t1');
  assert.equal(after.sessions[0].title, '登录页修复', 'title 未显式传入时不应被兜底值覆盖');
});

// 新建仍需兜底：没有既有记录可保，空 title 只能给默认名，否则会话树出现空白行
test('session：新建会话不带 title 时兜底为「新会话」', async () => {
  const req = await createReq('标题兜底测试需求');
  const id = req.id;

  const r = await post('/api/req/session', { id, convId: 'conv_t2', sessionId: 'sess_t2' });
  assert.equal(r.status, 200);

  const after = getRequirement(id);
  assert.equal(after.sessions[0].title, '新会话');
});

// 连带缺陷：回填不带 kind → 后端默认 'sub' → `kind === 'main'` 永不成立 → devSession 回填不了。
// 修法是认「既有记录的 kind」而非请求传入的 kind，这样前端漏传也能正确回填。
test('session：main 会话回填 sessionId 不带 kind 时，仍应回写 devSession', async () => {
  const req = await createReq('devSession回填测试需求');
  const id = req.id;

  await post('/api/req/session', { id, convId: 'conv_m1', title: '主会话', kind: 'main' });
  const r = await post('/api/req/session', { id, convId: 'conv_m1', sessionId: 'sess_m1' });
  assert.equal(r.status, 200);

  const after = getRequirement(id);
  assert.equal(after.sessions[0].sessionId, 'sess_m1');
  assert.equal(after.devSession, 'sess_m1', 'main 会话的 sessionId 应同步回写 devSession');
});

// ==== 回归：需求列表 30s 轮询后会话树消失（2026-08-13）====
// 症状：开发/测试期的需求下拉「自动收起」。
// 根因：前端 refreshReqList 用本接口返回值整体替换 lastList，而本接口不返回 sessions，
// 子会话行的渲染条件是 sessions.length > 0 → 轮询一到子行全没了（展开态其实没丢，是数据被抹）。
test('list：返回体应带 sessions，否则前端轮询会抹掉会话树', async () => {
  const req = await createReq('列表会话字段测试需求');
  const id = req.id;
  await post('/api/req/session', { id, convId: 'conv_l1', title: '子会话L', kind: 'sub' });

  const list = await get('/api/req/list');
  assert.equal(list.status, 200);
  const item = list.json.requirements.find((r) => r.id === id);
  assert.ok(Array.isArray(item.sessions), 'list 投影应包含 sessions 数组');
  assert.equal(item.sessions.length, 1);
  assert.equal(item.sessions[0].title, '子会话L');
});

// ==== Task 6：功能标签路由 + seed 快照注入 ====
test('PUT /api/req/feature-tag：设置功能标签', async () => {
  const req = await createReq('改宝宝辅食');
  const res = await put('/api/req/feature-tag', {
    id: req.id,
    tag: '宝宝辅食',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.featureTag, '宝宝辅食');

  // 验证持久化
  const getRes = await get(`/api/req/get?id=${req.id}`);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.json.featureTag, '宝宝辅食');
});

test('PUT /api/req/feature-tag：tag 为空字符串时清除标签', async () => {
  const req = await createReq('清标签测试');
  const id = req.id;

  // 先设置
  await put('/api/req/feature-tag', { id, tag: '宝宝辅食' });

  // 再清除
  const res = await put('/api/req/feature-tag', { id, tag: '' });
  assert.equal(res.status, 200);
  assert.equal(res.json.featureTag, null);

  // 验证持久化
  const getRes = await get(`/api/req/get?id=${id}`);
  assert.equal(getRes.json.featureTag, null);
});

test('GET /api/feature-index：返回功能账本', async () => {
  const res = await get('/api/feature-index');
  assert.equal(res.status, 200);
  assert.ok('index' in res.json);
  assert.ok(typeof res.json.index === 'object');
});

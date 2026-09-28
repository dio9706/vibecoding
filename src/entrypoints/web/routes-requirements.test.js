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
import { Readable } from 'node:stream';

// 防 env 污染：bitable 路由的「必然失败路径」测试依赖空凭证时 Lark SDK 同步抛错（见对应用例注释）。
// 若 shell 环境导出了真实 LARK_APP_ID/LARK_APP_SECRET，会变成真的发起网络请求，必须先清空。
delete process.env.LARK_APP_ID;
delete process.env.LARK_APP_SECRET;

// 隔离数据目录：本模块间接 import store/requirements.js（读盘），须在 import 前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'req-routes-'));

const { handleRequirementRoutes, handleColleagueAgentTurn, handleColleagueMessages, handleDelete } = await import('./routes-requirements.js');
const { updateRequirement, getRequirement, createRequirement } = await import('../../store/requirements.js');
const { hasQueuedTasks, reqDir } = await import('./requirement-ops.js');
const { setMyFeishuOpenId } = await import('../../store/settings.js');
const { appendTo, getColleagueThread } = await import('../../store/colleague-messages.js');
const { createRun, finishRun } = await import('../../store/runs.js');

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
  assert.deepEqual(
    Object.keys(item).sort(),
    ['busy', 'id', 'phase', 'sessions', 'title', 'unreadTotal', 'updatedAt'].sort(),
  );
  assert.equal(item.busy, false);
  assert.equal(item.unreadTotal, 0, '无同事消息时未读数为 0（侧栏据此决定不打小红点）');

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

test('config：reqDoc 透传 url/fetchedAt（在线来源的溯源信息，界面据此给「刷新」）', async () => {
  const req = await createReq('reqDoc溯源测试需求');
  const url = 'https://x.feishu.cn/docx/AbCd1234';
  const at = '2026-08-25T06:30:00.000Z';
  const r = await put('/api/req/config', {
    id: req.id,
    reqDoc: { name: '来自飞书.md', text: '正文', url, fetchedAt: at },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.reqDoc.url, url);
  assert.equal(r.json.reqDoc.fetchedAt, at);
  assert.ok(fs.existsSync(r.json.reqDoc.path), '带 url 的 text 来源仍要落盘');

  // 粘贴/上传来源不该凭空长出这两个字段，否则界面会给一个刷不动的「刷新」按钮
  const plain = await put('/api/req/config', { id: req.id, reqDoc: { name: '手打.md', text: '正文' } });
  assert.equal(plain.json.reqDoc.url, undefined);
  assert.equal(plain.json.reqDoc.fetchedAt, undefined);
});

test('doc-from-link：需求不存在 404；非评审期 409', async () => {
  const bad = await post('/api/req/doc-from-link', { id: 'r_not_exist', url: 'https://x.feishu.cn/docx/A1' });
  assert.equal(bad.status, 404);

  const req = await createReq('飞书链接非评审期测试需求');
  updateRequirement(req.id, { phase: 'dev' });
  const r = await post('/api/req/doc-from-link', { id: req.id, url: 'https://x.feishu.cn/docx/A1' });
  assert.equal(r.status, 409);
});

test('doc-from-link：非飞书链接 / 空链接 → 400（且错误里说清支持什么）', async () => {
  const req = await createReq('飞书链接校验测试需求');

  const notFeishu = await post('/api/req/doc-from-link', { id: req.id, url: 'https://example.com/doc/123' });
  assert.equal(notFeishu.status, 400);
  assert.match(notFeishu.json.error, /docx|wiki/);

  // 没传 url 且 reqDoc 也没有 url（不是飞书来源）→ 无从刷起
  const empty = await post('/api/req/doc-from-link', { id: req.id });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /链接/);
});

test('doc-from-link：链接合法但飞书调用失败 → 502，且提示补权限的做法', async () => {
  // 顶部已清空 LARK_APP_ID/SECRET，Lark SDK 在空凭证下必然失败——正是要覆盖的那条路径：
  // 用户最常见的失败是机器人没被加为文档协作者，错误里必须给出解法而不只是转述 SDK 原文
  const req = await createReq('飞书链接拉取失败测试需求');
  const r = await post('/api/req/doc-from-link', { id: req.id, url: 'https://x.feishu.cn/docx/AbCd1234' });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /协作者/);
  assert.equal(getRequirement(req.id).reqDoc, null, '拉取失败不得改动已有配置');
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

// 本用例必须排在文件末尾：它是这里唯一配「真实存在的目录」的地方，配完新建的需求就会继承到
// 工程，会击穿前面「无工程 → 400」那类断言。收尾处还要把两条需求的 projects 清回空。
test('create：工程配置沿用上一个需求（含只读标记）；目录已不存在的槽位不继承', async () => {
  const liveDir = process.env.APP_DATA_DIR; // 测试数据目录，确定存在
  const prev = await createReq('工程继承源需求');
  const cfg = await put('/api/req/config', {
    id: prev.id,
    // 后端故意配成只读 + 不存在的目录：一次同时钉住 dev 标记要跟着走、坏路径不跟着走
    projects: { frontend: { dir: liveDir, dev: false }, backend: { dir: 'D:/not-exist-backend', dev: false } },
  });
  assert.equal(cfg.status, 200);

  const next = await createReq('工程继承测试需求');
  assert.deepEqual(next.projects.frontend, { dir: liveDir, dev: false }, '前端工程连同只读标记一并沿用');
  assert.equal(next.projects.backend, null, '目录已不存在的槽位留空，不继承坏路径');

  updateRequirement(prev.id, { projects: { frontend: null, backend: null } });
  updateRequirement(next.id, { projects: { frontend: null, backend: null } });
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

// ==== 问卷必答 + 生成前背景（工作台改版）====
// plan: docs/superpowers/plans/2026-08-25-req-workbench.md
//
// 必答规则不能只靠前端 UI 保证：接口是公开的，绕过界面就能提交半份问卷，
// 而缺题的问卷会让 answersToPromptPart 静默落到 AI 猜测项——用户以为自己
// 定了口径，实际模型按默认值走了。故必须在路由层兜住。

const UNSURE = '__unsure__';

/** 造一份 status=ready 的三题问卷，形状与 parseQuiz 的输出一致。 */
function plantQuiz(id, n = 3) {
  const questions = Array.from({ length: n }, (_, i) => ({
    id: 'Q' + (i + 1),
    title: '问题' + (i + 1),
    hint: '',
    why: '',
    opts: [
      { v: 'a', lab: '选项A', desc: '', guess: true },
      { v: 'b', lab: '选项B', desc: '', guess: false },
    ],
  }));
  updateRequirement(id, { quiz: { status: 'ready', questions, answers: {}, at: new Date().toISOString() } });
  return questions;
}

test('PUT /api/req/quiz：缺题提交回 400，且不入队 docgen', async () => {
  const { id } = await createReq('必答-缺题');
  plantQuiz(id);
  const res = await put('/api/req/quiz', { id, answers: { Q1: { v: 'a' } } });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /未作答/);
  // 关键：被拒的提交不该留下队列任务，否则用户会看到「生成中」却没答完问卷
  assert.equal(hasQueuedTasks(id), false);
  assert.equal(getRequirement(id).quiz.status, 'ready', '被拒后仍是待答态');
});

test('PUT /api/req/quiz：全部作答（含「不确定」）回 202，unsure 原值落盘', async () => {
  const { id } = await createReq('必答-全答');
  plantQuiz(id);
  const res = await put('/api/req/quiz', {
    id,
    answers: {
      Q1: { v: 'b', note: '' },
      Q2: { v: UNSURE, note: '得问下设计' },
      Q3: { v: 'a', note: '但列表页不要跟着改' },
    },
  });
  assert.equal(res.status, 202);
  assert.equal(res.json.answered, 3);
  const q = getRequirement(id).quiz;
  assert.equal(q.status, 'answered');
  // 「不确定」是前端注入的保留值，不在 LLM 出的 opts 里，必须被放行且原值保存——
  // 落成空串就和「未作答」混为一谈了，两者给模型的授权强度不同
  assert.equal(q.answers.Q2.v, UNSURE);
  assert.equal(q.answers.Q2.note, '得问下设计');
  assert.equal(q.answers.Q3.note, '但列表页不要跟着改');
  assert.equal(hasQueuedTasks(id), true, '答完应入队 docgen');
});

test('PUT /api/req/quiz：非法选项值视为未答，仍回 400', async () => {
  const { id } = await createReq('必答-脏值');
  plantQuiz(id);
  const res = await put('/api/req/quiz', {
    id,
    answers: { Q1: { v: 'a' }, Q2: { v: '不存在的选项' }, Q3: { v: 'a' } },
  });
  assert.equal(res.status, 400);
  assert.equal(hasQueuedTasks(id), false);
});

test('PUT /api/req/quiz：只写补充不选选项不算作答（必答不被 note 绕过）', async () => {
  const { id } = await createReq('必答-只写note');
  plantQuiz(id);
  const res = await put('/api/req/quiz', {
    id,
    answers: { Q1: { v: 'a' }, Q2: { v: '', note: '我也不知道' }, Q3: { v: 'a' } },
  });
  assert.equal(res.status, 400);
});

test('PUT /api/req/prime：保存/回读/清空，且不留 history、不触发生成', async () => {
  const { id } = await createReq('背景补充');
  const before = getRequirement(id).history.length;

  const saved = await put('/api/req/prime', {
    id,
    text: '旧版本地筛选卡死过',
    files: [{ name: '复盘.md', path: '/t/f.md' }],
  });
  assert.equal(saved.status, 200);
  let r = getRequirement(id);
  assert.equal(r.prime.text, '旧版本地筛选卡死过');
  assert.equal(r.prime.files.length, 1);
  assert.ok(r.prime.at);
  // 前端按防抖自动保存，逐次写 history 会把时间线冲爆
  assert.equal(r.history.length, before, '自动保存不留痕');
  // 背景是随下一次生成一并生效的草稿，本身绝不该触发 docgen
  assert.equal(hasQueuedTasks(id), false);

  // 用户删干净 → 归 null，而不是留一条空记录
  await put('/api/req/prime', { id, text: '', files: [] });
  assert.equal(getRequirement(id).prime, null);

  // 超长截断
  await put('/api/req/prime', { id, text: 'x'.repeat(9999), files: [] });
  assert.equal(getRequirement(id).prime.text.length, 5000);

  // 只有附件没正文也要留住：用户可能只拖一份复盘文档进来、一个字不写
  await put('/api/req/prime', { id, text: '', files: [{ name: 'a.md', path: '/t/a.md' }] });
  assert.equal(getRequirement(id).prime.files.length, 1);
});

test('PUT /api/req/prime：需求不存在回 404', async () => {
  const res = await put('/api/req/prime', { id: 'r_nope', text: 'x' });
  assert.equal(res.status, 404);
});

// ==== 开发人员指派 ====

const { addColleague } = await import('../../store/colleagues.js');

test('PUT /api/req/assignees：review 期写入成功并回读；重复 id 去重', async () => {
  const c1 = addColleague({ role: 'frontend', name: '张三', feishuOpenId: 'ou_zs' });
  const c2 = addColleague({ role: 'backend', name: '李四' });
  const r = await createReq('指派测试A');

  const put1 = await put('/api/req/assignees', { id: r.id, assignees: [c1.id, c2.id, c1.id] });
  assert.equal(put1.status, 200);
  assert.deepEqual(put1.json.assignees, [c1.id, c2.id], '重复 id 必须去重');

  const got = await get('/api/req/get?id=' + r.id);
  assert.deepEqual(got.json.assignees, [c1.id, c2.id]);
});

test('GET /api/req/get：assigneeList 服务端 join 姓名/职位，缺失的标 missing', async () => {
  const c = addColleague({ role: 'design', name: '王五' });
  const r = await createReq('指派测试B');
  await put('/api/req/assignees', { id: r.id, assignees: [c.id] });
  updateRequirement(r.id, { assignees: [c.id, 'cl_gone'] }); // 绕过路由，模拟同事被删后的悬空引用

  const got = await get('/api/req/get?id=' + r.id);
  assert.equal(got.json.assigneeList.length, 2);
  assert.deepEqual(got.json.assigneeList[0], {
    id: c.id, name: '王五', role: 'design', roleLabel: 'UI设计', feishuOpenId: '', missing: false,
    unreadCount: 0, // 三期新增：未读数随 assigneeList 一起回，复用右栏既有轮询
  });
  assert.equal(got.json.assigneeList[1].missing, true);
  assert.equal(got.json.assigneeList[1].name, '已移除的同事');
});

test('PUT /api/req/assignees：悬空 id 被拒 400', async () => {
  const r = await createReq('指派测试C');
  const res = await put('/api/req/assignees', { id: r.id, assignees: ['cl_nope'] });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /同事不存在/);
});

test('PUT /api/req/assignees：非数组 400；未知需求 404', async () => {
  const r = await createReq('指派测试D');
  assert.equal((await put('/api/req/assignees', { id: r.id, assignees: 'x' })).status, 400);
  assert.equal((await put('/api/req/assignees', { id: 'r_none', assignees: [] })).status, 404);
});

test('PUT /api/req/assignees：dev 期放行、test 期 409', async () => {
  const c = addColleague({ role: 'ops', name: '赵六' });
  const r = await createReq('指派测试E');

  updateRequirement(r.id, { phase: 'dev' });
  assert.equal((await put('/api/req/assignees', { id: r.id, assignees: [c.id] })).status, 200);

  updateRequirement(r.id, { phase: 'test' });
  const res = await put('/api/req/assignees', { id: r.id, assignees: [] });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /评审期与开发期/);
});

test('createRequirement：assignees 初始为空数组', async () => {
  const r = await createReq('指派测试F');
  assert.deepEqual(getRequirement(r.id).assignees, []);
});

// ==== 二期：归档快照 + 定稿通知 ====

test('归档：assignees 固化成快照（姓名/职位/open_id），名册后续改名不影响历史', async () => {
  const c = addColleague({ role: 'product', name: '产品甲', feishuOpenId: 'ou_pm1' });
  const r = await createReq('归档快照验证');
  await put('/api/req/assignees', { id: r.id, assignees: [c.id] });
  // 直接推到 archiving（archiveRequirement 只认相邻流转）；branches 留空以免真跑 git
  updateRequirement(r.id, { phase: 'archiving', branches: [], devDoc: { versions: [{ v: 1, path: '/tmp/x.md' }] } });

  const res = await post('/api/req/archive', { id: r.id, note: '上线正常' });
  assert.equal(res.status, 200);

  const after = getRequirement(r.id);
  assert.equal(after.phase, 'archived');
  assert.deepEqual(after.archive.assignees, [
    { name: '产品甲', role: 'product', roleLabel: '产品', feishuOpenId: 'ou_pm1' },
  ]);
  assert.ok(after.archive.summary.includes('## 开发人员'), '归档摘要要写明当时归谁');
  assert.ok(after.archive.summary.includes('产品甲（产品）'));

  // 名册改名后，已归档记录不得被反向改写
  const { updateColleague } = await import('../../store/colleagues.js');
  updateColleague(c.id, { role: 'backend', name: '产品甲改名了' });
  assert.equal(getRequirement(r.id).archive.assignees[0].name, '产品甲');
  assert.equal(getRequirement(r.id).archive.assignees[0].role, 'product');
});

test('归档：未指派开发人员时快照为空数组，摘要写「（未指派）」', async () => {
  const r = await createReq('归档无人验证');
  updateRequirement(r.id, { phase: 'archiving', branches: [], devDoc: { versions: [] } });
  assert.equal((await post('/api/req/archive', { id: r.id, note: '' })).status, 200);
  const after = getRequirement(r.id);
  assert.deepEqual(after.archive.assignees, []);
  assert.ok(after.archive.summary.includes('（未指派）'));
});

test('定稿通知：无启用飞书机器人时回 botMissing，且不阻塞定稿', async () => {
  const { buildAssigneeNotices } = await import('./req-logic.js');
  const { notifyAssigneesOnFinalize } = await import('./requirement-ops.js');
  const c = addColleague({ role: 'frontend', name: '前端乙', feishuOpenId: 'ou_fe1' });
  const r = await createReq('定稿通知验证');
  await put('/api/req/assignees', { id: r.id, assignees: [c.id] });

  // 测试环境的 settings 是隔离空目录，没有任何启用中的机器人
  const out = await notifyAssigneesOnFinalize(getRequirement(r.id), [{ dir: '/x', dev: true }]);
  assert.equal(out.botMissing, true);
  assert.equal(out.sent, 0);

  // 文案仍按前端那套生成（与机器人是否存在无关）
  const { notices } = buildAssigneeNotices({
    title: '定稿通知验证',
    assigneeList: [{ name: '前端乙', role: 'frontend', feishuOpenId: 'ou_fe1', missing: false }],
    backendOnly: false,
  });
  assert.match(notices[0].text, /后续有需要我配合可以直接和我说/);
});

test('定稿通知：纯后端工程（devProjects 只含 backend）切换后端文案', async () => {
  const { notifyAssigneesOnFinalize } = await import('./requirement-ops.js');
  const c = addColleague({ role: 'backend', name: '后端丙', feishuOpenId: 'ou_be1' });
  const r = await createReq('纯后端验证');
  await put('/api/req/assignees', { id: r.id, assignees: [c.id] });
  const backendSlot = { dir: '/srv/api', dev: true };
  updateRequirement(r.id, { projects: { frontend: null, backend: backendSlot } });

  // devProjects 只含 backend 槽位本体 → backendOnly=true
  const out = await notifyAssigneesOnFinalize(getRequirement(r.id), [getRequirement(r.id).projects.backend]);
  assert.equal(out.botMissing, true, '无机器人，但判定逻辑已走完');
  assert.deepEqual(out.skippedNoId, []);
  assert.deepEqual(out.skippedNoRole, []);
});

test('定稿通知：未填 open_id / 运营职位 分别进不同的跳过桶', async () => {
  const { notifyAssigneesOnFinalize } = await import('./requirement-ops.js');
  const noId = addColleague({ role: 'product', name: '没号产品' });
  const ops = addColleague({ role: 'ops', name: '运营丁', feishuOpenId: 'ou_ops1' });
  const r = await createReq('跳过桶验证');
  await put('/api/req/assignees', { id: r.id, assignees: [noId.id, ops.id] });

  const out = await notifyAssigneesOnFinalize(getRequirement(r.id), [{ dir: '/x', dev: true }]);
  assert.deepEqual(out.skippedNoId, ['没号产品']);
  assert.deepEqual(out.skippedNoRole, ['运营丁']);
  assert.equal(out.botMissing, false, '一个可发的都没有 → 提前返回，不该去查机器人');
});

// ==== 三期：同事消息中继 ====

const { appendTo: cmAppend } = await import('../../store/colleague-messages.js');

test('GET /api/req/get：assigneeList 回填 unreadCount', async () => {
  const c = addColleague({ role: 'backend', name: '后端丙', feishuOpenId: 'ou_be9' });
  const r = await createReq('未读回填验证');
  await put('/api/req/assignees', { id: r.id, assignees: [c.id] });

  let got = await get('/api/req/get?id=' + r.id);
  assert.equal(got.json.assigneeList[0].unreadCount, 0, '无消息时必须是 0 而不是 undefined');

  cmAppend(c.id, { dir: 'in', text: '接口文档发你了', role: 'backend', reqId: r.id });
  cmAppend(c.id, { dir: 'out', text: '收到', status: 'read', reqId: r.id });
  got = await get('/api/req/get?id=' + r.id);
  assert.equal(got.json.assigneeList[0].unreadCount, 1, 'out 方向不计未读');
});

test('GET /api/req/colleague-messages：回读会话；缺参 400', async () => {
  const c = addColleague({ role: 'product', name: '产品甲', feishuOpenId: 'ou_pm9' });
  const r = await createReq('会话回读验证');
  await put('/api/req/assignees', { id: r.id, assignees: [c.id] });
  cmAppend(c.id, { dir: 'in', text: '需求要改', role: 'product', reqId: r.id });

  const ok = await get(`/api/req/colleague-messages?reqId=${r.id}&colleagueId=${c.id}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.messages.length, 1);
  assert.equal(ok.json.messages[0].text, '需求要改');

  assert.equal((await get('/api/req/colleague-messages?reqId=' + r.id)).status, 400);
  assert.equal((await get('/api/req/colleague-messages')).status, 400);
});

test('GET /api/req/colleague-messages：需求不存在 → 404', async () => {
  const r = await get('/api/req/colleague-messages?reqId=r_not_exist&colleagueId=cl_x');
  assert.equal(r.status, 404);
});

// 存储从「按需求分组」换成「按人分组」后，reqId 降级为消息上的标签，
// handleColleagueMessages 现在是「取整条线 → inline 按 reqId 过滤 → 重算 lastInboundAt」。
// 这两条直调 mockRes（免走真实 HTTP），钉住「同一同事跨两个需求」这个此前没测过的场景。
test('GET colleague-messages：按 reqId 过滤 —— 主机在需求 A 的面板不该看到需求 B 的对话', async () => {
  const reqA = await createReq('跨需求过滤A');
  const reqB = await createReq('跨需求过滤B');
  cmAppend('cl_1', { dir: 'in', text: '属于A', reqId: reqA.id, at: '2026-09-01T00:00:00Z' });
  cmAppend('cl_1', { dir: 'in', text: '属于B', reqId: reqB.id, at: '2026-09-09T00:00:00Z' });
  const res = mockRes();
  await handleColleagueMessages(new URL(`http://x/api/req/colleague-messages?reqId=${reqA.id}&colleagueId=cl_1`), res);
  const body = JSON.parse(res.body);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].text, '属于A');
  // lastInboundAt 必须按**过滤后**的消息算。按整条线算的话，需求 A 的面板上
  // 「最近来信」会显示需求 B 那条的时间（09-09），而那条消息本身根本不在这个列表里——
  // 看起来就像「有新消息但我找不到」。这段逻辑从 store 挪进路由层 inline 计算，
  // 挪的时候最容易只搬过滤、漏掉这一步。
  assert.equal(body.lastInboundAt, '2026-09-01T00:00:00Z', 'lastInboundAt 不能带进别的需求的时间');
});

test('GET colleague-messages：无归属标签的消息不出现在任何需求面板里', async () => {
  const reqA = await createReq('无归属标签验证');
  cmAppend('cl_2', { dir: 'in', text: '没归属' });
  const res = mockRes();
  await handleColleagueMessages(new URL(`http://x/api/req/colleague-messages?reqId=${reqA.id}&colleagueId=cl_2`), res);
  assert.equal(JSON.parse(res.body).messages.length, 0);
});

test('POST /api/req/colleague-messages/read：清零未读', async () => {
  const c = addColleague({ role: 'frontend', name: '前端乙', feishuOpenId: 'ou_fe9' });
  const r = await createReq('已读验证');
  await put('/api/req/assignees', { id: r.id, assignees: [c.id] });
  cmAppend(c.id, { dir: 'in', text: 'a', role: 'frontend', reqId: r.id });

  assert.equal((await post('/api/req/colleague-messages/read', { reqId: r.id, colleagueId: c.id })).status, 200);
  const got = await get('/api/req/get?id=' + r.id);
  assert.equal(got.json.assigneeList[0].unreadCount, 0);
});

test('POST /api/req/colleague-messages/send：未指派该同事 → 400；无机器人 → 502 且不落消息', async () => {
  const c = addColleague({ role: 'ops', name: '运营丁', feishuOpenId: 'ou_ops9' });
  const r = await createReq('发送校验验证');
  const notAssigned = await post('/api/req/colleague-messages/send', {
    reqId: r.id, colleagueId: c.id, text: 'hi',
  });
  assert.equal(notAssigned.status, 400);

  await put('/api/req/assignees', { id: r.id, assignees: [c.id] });
  const noBot = await post('/api/req/colleague-messages/send', {
    reqId: r.id, colleagueId: c.id, text: 'hi',
  });
  assert.equal(noBot.status, 502);
  const thread = await get(`/api/req/colleague-messages?reqId=${r.id}&colleagueId=${c.id}`);
  assert.deepEqual(thread.json.messages, [], '发送失败不得落消息——否则界面显示一条其实没发出去的');
});

test('POST /api/req/colleague-messages/send：空文本 400；未知需求 404', async () => {
  const r = await createReq('发送参数验证');
  assert.equal((await post('/api/req/colleague-messages/send', { reqId: r.id, colleagueId: 'cl_x', text: '  ' })).status, 400);
  assert.equal((await post('/api/req/colleague-messages/send', { reqId: 'r_none', colleagueId: 'cl_x', text: 'hi' })).status, 404);
});

test('discard → delete：仅 discarded 可移除，且记录/磁盘目录/同事对话/convIds 一并交代清楚', async () => {
  assert.equal((await post('/api/req/delete', { id: 'r_not_exist' })).status, 404);
  assert.equal((await post('/api/req/delete', {})).status, 400);

  const req = await createReq('待移除需求');
  // review 期直接删 → 409：侧栏只对废弃行给「移除」，服务端把同一条契约再钉一遍
  assert.equal((await post('/api/req/delete', { id: req.id })).status, 409);

  // 铺开「一条需求的全部关联数据」：磁盘产物 + 会话 + 同事对话
  const docPath = reqDir(req.id, 'dev-doc-v1.md');
  fs.writeFileSync(docPath, '# 开发文档');
  updateRequirement(req.id, {
    sessions: [
      { convId: 'conv_del_1', sessionId: null, title: '主', kind: 'main', createdAt: '2026-09-20T00:00:00Z' },
      { convId: 'conv_del_2', sessionId: null, title: '子', kind: 'sub', createdAt: '2026-09-20T00:00:00Z' },
    ],
  });
  appendTo('cl_del', { dir: 'in', text: '同事留言', reqId: req.id });

  assert.equal((await post('/api/req/discard', { id: req.id })).status, 200);
  const del = await post('/api/req/delete', { id: req.id });
  assert.equal(del.status, 200);
  // convIds 必须回给前端：localStorage 的会话只有前端删得掉，后端不报就成了永久孤儿
  assert.deepEqual(del.json.convIds, ['conv_del_1', 'conv_del_2']);

  assert.equal(getRequirement(req.id), null);
  assert.equal(fs.existsSync(docPath), false, '磁盘产物必须跟着走');
  assert.deepEqual(getColleagueThread('cl_del').messages, [], '同事对话必须跟着走');
  assert.equal((await post('/api/req/delete', { id: req.id })).status, 404, '重复移除 → 404');
});

test('delete：已归档需求不可移除（409）——归档是终态存档，侧栏也不给右键菜单', async () => {
  const req = await createReq('归档后不可移除');
  updateRequirement(req.id, { phase: 'archived' });
  const r = await post('/api/req/delete', { id: req.id });
  assert.equal(r.status, 409);
  assert.ok(getRequirement(req.id), '被拒后记录必须还在');
});

test('delete：busy 中的废弃需求 → 409（不在任务跑着时抽掉它的盘）', async () => {
  const req = await createReq('busy 时移除');
  updateRequirement(req.id, { phase: 'discarded', busy: { kind: 'docgen', runId: 'x', startedAt: Date.now() } });
  assert.equal((await post('/api/req/delete', { id: req.id })).status, 409);
  assert.ok(getRequirement(req.id));
});

// ---- Task 10：删除需求前先回收 agent worktree（补 spec §5.3）----
// 走 mockReq/mockRes 直调 handleDelete 注入 runScript 桩：真实 HTTP 路径不带 deps，
// 走真实 runScript 会去动本机上真实的 git 仓库。

/** 造一个满足 handleDelete 两道前置闸的需求：phase=discarded 且无 busy/排队任务 */
function seedDiscarded(worktrees) {
  const r = createRequirement({ title: 'x' });
  updateRequirement(r.id, { phase: 'discarded', agentWorktrees: worktrees });
  return r;
}

test('删除需求：先回收 agent worktree 再删记录（顺序反了就读不到登记）', async () => {
  const r = seedDiscarded([{ dir: 'D:/p', worktreeDir: 'D:/p.req-a', branch: 'b' }]);
  const removed = [];
  const res = mockRes();
  await handleDelete(mockReq({ id: r.id }), res, {
    runScript: async (_cmd, args) => (removed.push(args.at(-1)), { ok: true }),
  });
  assert.equal(res.statusCode, 200, `应删除成功，实际响应：${res.body}`);
  assert.deepEqual(removed, ['D:/p.req-a']);
  assert.equal(getRequirement(r.id), null);
});

test('删除需求：worktree 回收失败不阻塞删除（删不掉临时目录不该卡住用户）', async () => {
  const r = seedDiscarded([{ dir: 'D:/p', worktreeDir: 'D:/p.req-a', branch: 'b' }]);
  const res = mockRes();
  await handleDelete(mockReq({ id: r.id }), res, {
    runScript: async () => ({ ok: false, err: 'locked' }),
  });
  assert.equal(getRequirement(r.id), null, '回收失败也要把需求删掉');
});

test('删除需求：没有 agentWorktrees 登记时不调 runScript（别对着空列表空跑 git）', async () => {
  const r = seedDiscarded([]);
  let called = 0;
  const res = mockRes();
  await handleDelete(mockReq({ id: r.id }), res, { runScript: async () => (called++, { ok: true }) });
  assert.equal(called, 0);
  assert.equal(getRequirement(r.id), null);
});

test('删除需求：存量需求盘上根本没有 agentWorktrees 字段，也要能删', async () => {
  // 不是假想场景：`agentWorktrees` 是 P3 Task 10 才加的字段，此前建的需求盘上一个都没有。
  // 上面那条传的是空数组（字段存在、值为空），这条是字段**整个不存在**（undefined）——
  // 回收侧靠 `r.agentWorktrees || []` 兜底，兜不住就是 `undefined is not iterable`，
  // 用户删一个老需求直接 500。
  const r = createRequirement({ title: 'x' });
  updateRequirement(r.id, { phase: 'discarded', agentWorktrees: undefined });
  let called = 0;
  const res = mockRes();
  await handleDelete(mockReq({ id: r.id }), res, { runScript: async () => (called++, { ok: true }) });
  assert.equal(res.statusCode, 200, `老需求应能正常删除，实际响应：${res.body}`);
  assert.equal(called, 0);
  assert.equal(getRequirement(r.id), null);
});

// ---- 阶段流转：会话运行守卫 ----

/**
 * 造一个挂在指定 convId 上的活跃 run，返回 run 供测试结束时收尾。
 * createRun() 不收参数，convId 由调用方事后挂到 run 上——这是 store/runs.js 的既有形状，
 * hasActiveRunForConv 就是按 `r.convId === convId && r.status === 'running'` 匹配的（runs.js:140-144）。
 */
function startRunOn(convId) {
  const run = createRun();
  run.convId = convId;
  return run;
}

test('dev-done：开发期子会话仍在跑 → 409 且响应列出该会话', async () => {
  const req = await createReq('子会话在跑的需求');
  const id = req.id;
  updateRequirement(id, {
    phase: 'dev',
    convId: 'c_main_1',
    sessions: [
      { convId: 'c_main_1', sessionId: 's1', title: '主会话', kind: 'main', phase: 'dev', createdAt: '' },
      { convId: 'c_sub_1', sessionId: null, title: '登录页修复', kind: 'sub', phase: 'dev', createdAt: '' },
    ],
  });
  const run = startRunOn('c_sub_1');
  try {
    const r = await post('/api/req/dev-done', { id });
    assert.equal(r.status, 409);
    assert.deepEqual(r.json.running, [{ convId: 'c_sub_1', title: '登录页修复' }]);
    assert.equal(getRequirement(id).phase, 'dev'); // 没被流转
  } finally {
    // 必须 finally：gc() 对 status==='running' 的 run 直接跳过（runs.js:578），
    // 断言一抛就永久漏一个活 run 在注册表里，污染后续任何复用该 convId 的用例。
    finishRun(run);
  }
});

test('dev-done：会话全部跑完 → 200 放行', async () => {
  const req = await createReq('会话已跑完的需求');
  const id = req.id;
  updateRequirement(id, {
    phase: 'dev',
    convId: 'c_main_2',
    sessions: [
      { convId: 'c_main_2', sessionId: 's1', title: '主会话', kind: 'main', phase: 'dev', createdAt: '' },
    ],
  });
  const r = await post('/api/req/dev-done', { id });
  assert.equal(r.status, 200);
  assert.equal(r.json.phase, 'test');
});

test('test-pass：测试期会话仍在跑 → 409 且带 running（守卫对两个流转口一视同仁）', async () => {
  const req = await createReq('测试期会话在跑的需求');
  const id = req.id;
  updateRequirement(id, {
    phase: 'test',
    convId: 'c_test_main_x',
    sessions: [
      { convId: 'c_test_main_x', sessionId: 's1', title: '测试期主会话', kind: 'main', phase: 'test', createdAt: '' },
      // 开发期的历史会话即便挂着 run 也不该拦住测试期的流转——不归这次流转管
      { convId: 'c_dev_old_x', sessionId: 's0', title: '开发期旧会话', kind: 'sub', phase: 'dev', createdAt: '' },
    ],
  });
  const run = startRunOn('c_test_main_x');
  try {
    const r = await post('/api/req/test-pass', { id });
    assert.equal(r.status, 409);
    assert.deepEqual(r.json.running, [{ convId: 'c_test_main_x', title: '测试期主会话' }]);
    assert.equal(getRequirement(id).phase, 'test');
  } finally {
    finishRun(run);
  }
});

test('test-pass：只有历史阶段会话在跑 → 放行（跨阶段不误拦）', async () => {
  const req = await createReq('只有旧会话在跑的需求');
  const id = req.id;
  updateRequirement(id, {
    phase: 'test',
    convId: 'c_test_main_y',
    sessions: [
      { convId: 'c_test_main_y', sessionId: 's1', title: '测试期主会话', kind: 'main', phase: 'test', createdAt: '' },
      { convId: 'c_dev_old_y', sessionId: 's0', title: '开发期旧会话', kind: 'sub', phase: 'dev', createdAt: '' },
    ],
  });
  const run = startRunOn('c_dev_old_y');
  try {
    assert.equal((await post('/api/req/test-pass', { id })).status, 200);
    assert.equal(getRequirement(id).phase, 'archiving');
  } finally {
    finishRun(run);
  }
});

// ---- dev-done：阶段切换清锚点 + 物化会话 ----

test('dev-done：流转后 convId/devSession 清空，sessions 保留且带 phase:dev', async () => {
  const req = await createReq('阶段切换需求');
  const id = req.id;
  updateRequirement(id, {
    phase: 'dev',
    convId: 'c_main_3',
    devSession: 'sess_dev_3',
    sessions: [
      { convId: 'c_main_3', sessionId: 'sess_dev_3', title: '主会话', kind: 'main', phase: 'dev', createdAt: '' },
      { convId: 'c_sub_3', sessionId: 's2', title: '子会话', kind: 'sub', phase: 'dev', createdAt: '' },
    ],
  });
  const r = await post('/api/req/dev-done', { id });
  assert.equal(r.status, 200);

  const after = getRequirement(id);
  assert.equal(after.phase, 'test');
  assert.equal(after.convId, null);
  assert.equal(after.devSession, null);
  assert.equal(after.sessions.length, 2);
  assert.ok(after.sessions.every((s) => s.phase === 'dev'));
});

test('dev-done：老需求（sessions 空、只有 convId）流转时把主会话物化落盘，历史不丢', async () => {
  const req = await createReq('老数据需求');
  const id = req.id;
  updateRequirement(id, {
    phase: 'dev',
    convId: 'c_legacy',
    devSession: 'sess_legacy',
    sessions: [],
  });
  const r = await post('/api/req/dev-done', { id });
  assert.equal(r.status, 200);

  const after = getRequirement(id);
  assert.equal(after.convId, null);
  assert.deepEqual(
    after.sessions.map((s) => ({ convId: s.convId, sessionId: s.sessionId, kind: s.kind, phase: s.phase })),
    [{ convId: 'c_legacy', sessionId: 'sess_legacy', kind: 'main', phase: 'dev' }],
  );
});

test('dev-done：会话缺 phase 时按流转前的阶段物化成 dev，不是流转后的 test', async () => {
  const req = await createReq('缺 phase 的存量需求');
  const id = req.id;
  updateRequirement(id, {
    phase: 'dev',
    convId: 'c_nophase',
    devSession: 'sess_nophase',
    // 刻意不带 phase：这是阶段隔离上线前的存量形状，normalizeSessions 会按 req.phase 回填。
    // sessions 非空 → 必走路径 1，fallbackPhase 一定参与；元素无 phase → 不会被显式值短路。
    // 前两条用例各自漏掉了这一半，这条才是排序不变式的唯一护栏。
    sessions: [
      { convId: 'c_nophase', sessionId: 'sess_nophase', title: '主会话', kind: 'main', createdAt: '' },
      { convId: 'c_nophase_sub', sessionId: null, title: '子会话', kind: 'sub', createdAt: '' },
    ],
  });
  assert.equal((await post('/api/req/dev-done', { id })).status, 200);

  // 若实现改成「先落 phase:'test' 再 normalizeSessions(getRequirement(id))」，这里会全是 'test'，
  // 开发期会话从此永不被隐藏——功能静默失效，不报错也不掉数据。
  assert.deepEqual(getRequirement(id).sessions.map((s) => s.phase), ['dev', 'dev']);
});

test('dev-done → conv 端到端：开发期会话全留、测试期恰好一条新 main', async () => {
  const req = await createReq('端到端阶段切换');
  const id = req.id;
  updateRequirement(id, {
    phase: 'dev',
    convId: 'c_dev_main',
    devSession: 'sess_dev',
    sessions: [
      { convId: 'c_dev_main', sessionId: 'sess_dev', title: '主会话', kind: 'main', phase: 'dev', createdAt: '' },
      { convId: 'c_dev_sub', sessionId: 's2', title: '登录页修复', kind: 'sub', phase: 'dev', createdAt: '' },
    ],
  });

  assert.equal((await post('/api/req/dev-done', { id })).status, 200);
  // 前端见 convId 为空 → 建新 conv 并回绑（openRequirementChat 的既有路径）
  assert.equal((await post('/api/req/conv', { id, convId: 'c_test_main' })).status, 200);

  const after = getRequirement(id);
  assert.equal(after.phase, 'test');
  assert.equal(after.convId, 'c_test_main');
  // 开发期两条原样保留（归档期「优化汇总」还要读它们的转录）
  assert.equal(after.sessions.filter((s) => s.phase === 'dev').length, 2);
  // 测试期恰好一条 main，且是干净的新会话
  const testMains = after.sessions.filter((s) => s.phase === 'test' && s.kind === 'main');
  assert.equal(testMains.length, 1);
  assert.equal(testMains[0].convId, 'c_test_main');
  assert.equal(testMains[0].sessionId, null);
  assert.equal(after.devSession, null); // dev-done 清掉后没被误回填
});

// ---- /api/req/conv：登记当前阶段的 main 会话 ----

test('conv：绑定新 convId 时同步登记一条当前阶段的 main 会话', async () => {
  const req = await createReq('测试期建主会话');
  const id = req.id;
  updateRequirement(id, {
    phase: 'test',
    convId: null,
    devSession: null,
    sessions: [
      { convId: 'c_old_main', sessionId: 's_old', title: '主会话', kind: 'main', phase: 'dev', createdAt: '' },
    ],
  });

  const r = await post('/api/req/conv', { id, convId: 'c_test_main' });
  assert.equal(r.status, 200);

  const after = getRequirement(id);
  assert.equal(after.convId, 'c_test_main');
  assert.equal(after.sessions.length, 2);
  const fresh = after.sessions.find((s) => s.convId === 'c_test_main');
  assert.equal(fresh.kind, 'main');
  assert.equal(fresh.phase, 'test');
  assert.equal(fresh.sessionId, null);
  // 开发期那条原样保留
  assert.equal(after.sessions.find((s) => s.convId === 'c_old_main').phase, 'dev');
});

test('conv：换浏览器铸了新 convId → 重指现有当前阶段 main，不堆出第二条', async () => {
  const req = await createReq('换浏览器需求');
  const id = req.id;
  updateRequirement(id, {
    phase: 'test',
    convId: 'c_A',
    devSession: 'sess_keep',
    sessions: [
      { convId: 'c_old_dev', sessionId: 's_dev', title: '开发主会话', kind: 'main', phase: 'dev', createdAt: '' },
      { convId: 'c_A', sessionId: 'sess_keep', title: '我改过的标题', kind: 'main', phase: 'test', createdAt: '' },
    ],
  });

  const r = await post('/api/req/conv', { id, convId: 'c_B' });
  assert.equal(r.status, 200);

  const after = getRequirement(id);
  assert.equal(after.convId, 'c_B');
  // 同阶段 main 仍然只有一条
  assert.equal(after.sessions.filter((s) => s.kind === 'main' && s.phase === 'test').length, 1);
  const main = after.sessions.find((s) => s.phase === 'test');
  assert.equal(main.convId, 'c_B');
  assert.equal(main.sessionId, 'sess_keep');   // 续得上原 Claude session
  assert.equal(main.title, '我改过的标题');      // 用户改的标题没被打回默认名
  // 开发期那条原样不动
  assert.equal(after.sessions.find((s) => s.phase === 'dev').convId, 'c_old_dev');
});

test('conv：同 convId 重复绑定幂等，不插重复行、不覆盖已回填的 sessionId/title', async () => {
  const req = await createReq('conv 幂等需求');
  const id = req.id;
  updateRequirement(id, { phase: 'test', convId: null, sessions: [] });

  await post('/api/req/conv', { id, convId: 'c_dup' });
  // 模拟 run 起来后回填了 sessionId，且用户顺手改了标题
  await post('/api/req/session', { id, convId: 'c_dup', sessionId: 'sess_new', title: '改过的名字' });
  await post('/api/req/conv', { id, convId: 'c_dup' });

  const after = getRequirement(id);
  assert.equal(after.sessions.filter((s) => s.convId === 'c_dup').length, 1);
  assert.equal(after.sessions[0].sessionId, 'sess_new');
  assert.equal(after.sessions[0].title, '改过的名字');
});

test('conv：反复换客户端也只有一条同阶段 main', async () => {
  const req = await createReq('反复换客户端需求');
  const id = req.id;
  updateRequirement(id, { phase: 'test', convId: null, sessions: [] });
  for (const c of ['c1', 'c2', 'c3']) await post('/api/req/conv', { id, convId: c });
  const after = getRequirement(id);
  assert.equal(after.sessions.filter((s) => s.kind === 'main').length, 1);
  assert.equal(after.sessions[0].convId, 'c3');
  assert.equal(after.convId, 'c3');
});

// ---- /api/req/session：phase 归属与阶段内 main 唯一 ----

test('session：新建子会话打上需求当前阶段', async () => {
  const req = await createReq('子会话打标需求');
  const id = req.id;
  updateRequirement(id, { phase: 'test', convId: 'c_tm', sessions: [
    { convId: 'c_tm', sessionId: null, title: '主会话', kind: 'main', phase: 'test', createdAt: '' },
  ] });

  const r = await post('/api/req/session', { id, convId: 'c_new_sub', title: '巡检复现', kind: 'sub' });
  assert.equal(r.status, 200);
  assert.equal(getRequirement(id).sessions.find((s) => s.convId === 'c_new_sub').phase, 'test');
});

test('session：跨阶段两条 main 共存合法', async () => {
  const req = await createReq('跨阶段 main 需求');
  const id = req.id;
  updateRequirement(id, { phase: 'test', sessions: [
    { convId: 'c_dm', sessionId: 's1', title: '开发主会话', kind: 'main', phase: 'dev', createdAt: '' },
  ] });

  const r = await post('/api/req/session', { id, convId: 'c_tm2', title: '测试主会话', kind: 'main' });
  assert.equal(r.status, 200);
  assert.equal(getRequirement(id).sessions.filter((s) => s.kind === 'main').length, 2);
});

test('session：同阶段第二条 main → 409', async () => {
  const req = await createReq('同阶段双 main 需求');
  const id = req.id;
  updateRequirement(id, { phase: 'test', sessions: [
    { convId: 'c_tm3', sessionId: null, title: '测试主会话', kind: 'main', phase: 'test', createdAt: '' },
  ] });

  const r = await post('/api/req/session', { id, convId: 'c_tm4', title: '又一个主会话', kind: 'main' });
  assert.equal(r.status, 409);
  assert.equal(getRequirement(id).sessions.length, 1);
});

test('session：历史阶段 main 的迟到 sessionId 回填不污染当前阶段 devSession', async () => {
  const req = await createReq('迟到回填需求');
  const id = req.id;
  updateRequirement(id, { phase: 'test', devSession: 'sess_test', sessions: [
    { convId: 'c_dev_m', sessionId: null, title: '开发主会话', kind: 'main', phase: 'dev', createdAt: '' },
    { convId: 'c_test_m', sessionId: 'sess_test', title: '测试主会话', kind: 'main', phase: 'test', createdAt: '' },
  ] });

  const r = await post('/api/req/session', { id, convId: 'c_dev_m', sessionId: 'sess_dev_late' });
  assert.equal(r.status, 200);

  const after = getRequirement(id);
  assert.equal(after.devSession, 'sess_test'); // 没被开发期的迟到回填改掉
  assert.equal(after.sessions.find((s) => s.convId === 'c_dev_m').sessionId, 'sess_dev_late'); // 但条目本身照常补齐
});

test('session：当前阶段 main 的 sessionId 回填仍写入 devSession', async () => {
  const req = await createReq('正常回填需求');
  const id = req.id;
  updateRequirement(id, { phase: 'test', devSession: null, sessions: [
    { convId: 'c_tm5', sessionId: null, title: '测试主会话', kind: 'main', phase: 'test', createdAt: '' },
  ] });

  await post('/api/req/session', { id, convId: 'c_tm5', sessionId: 'sess_fresh' });
  assert.equal(getRequirement(id).devSession, 'sess_fresh');
});

// ---- POST /api/req/colleague-agent/turn（P3：飞书进程跨进程触发 agent）----
//
// 本组用例不走上面的「真实 HTTP server + fetch」范式：那条路会真的起一轮 agent（十几秒 + 烧额度）。
// 必须注入 deps 直调 handleColleagueAgentTurn，故自建 mockReq/mockRes 两个最小替身。

/**
 * 最小 res 替身。四个成员缺一不可：
 * - writeHead / end：sendJson 用
 * - setHeader：withJsonBody 在 413 路径上会调
 * - headersSent：withJsonBody 的 catch 分支靠它判断能不能再写响应头
 */
function mockRes() {
  return {
    statusCode: 0,
    body: '',
    headersSent: false,
    writeHead(code) {
      this.statusCode = code;
      this.headersSent = true;
    },
    end(chunk) {
      this.body = chunk || '';
    },
    setHeader() {},
  };
}

/**
 * 最小 req 替身。**必须喂 Buffer 而不是字符串** —— readJsonBody 里
 * `size += c.length`（字符串算字符数，中文会少算）且 `Buffer.concat(chunks)`
 * 拿到字符串数组直接抛。这是本项目踩过的「中文 body 被静默截断」同款坑。
 */
function mockReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  req.method = 'POST';
  req.url = '/api/req/colleague-agent/turn';
  req.headers = {};
  return req;
}

test('colleague-agent/turn：合法入参 → 202，且异步起了一轮', async () => {
  let called = null;
  const res = mockRes();
  await handleColleagueAgentTurn(
    mockReq({ colleagueId: 'cl_1', text: '接口给你了', msgId: 'cm_1' }),
    res,
    { handleTurn: async (i) => (called = i), isEnabled: () => true },
  );
  assert.equal(res.statusCode, 202);
  await new Promise((r) => setImmediate(r)); // fire-and-forget，让微任务跑完
  assert.equal(called.colleagueId, 'cl_1');
  assert.equal(called.text, '接口给你了');
});

test('colleague-agent/turn：缺 colleagueId → 400，且绝不起 agent', async () => {
  let ran = false;
  const res = mockRes();
  await handleColleagueAgentTurn(mockReq({ text: 'x' }), res, {
    handleTurn: async () => (ran = true),
    isEnabled: () => true,
  });
  assert.equal(res.statusCode, 400);
  await new Promise((r) => setImmediate(r));
  assert.equal(ran, false);
});

test('colleague-agent/turn：text 与 files 同时为空 → 400（没内容可聊）', async () => {
  const res = mockRes();
  await handleColleagueAgentTurn(mockReq({ colleagueId: 'cl_1', text: '   ' }), res, {
    handleTurn: async () => {},
    isEnabled: () => true,
  });
  assert.equal(res.statusCode, 400);
});

test('colleague-agent/turn：只有 files 没有 text → 放行（同事直接甩个文档是常态）', async () => {
  let called = null;
  const res = mockRes();
  await handleColleagueAgentTurn(
    mockReq({ colleagueId: 'cl_1', text: '', files: [{ name: 'a.md', path: 'D:/a.md', kind: 'file' }] }),
    res,
    { handleTurn: async (i) => (called = i), isEnabled: () => true },
  );
  assert.equal(res.statusCode, 202);
  await new Promise((r) => setImmediate(r));
  assert.equal(called.files.length, 1);
});

test('colleague-agent/turn：插件停用 → 409，不起 agent', async () => {
  let ran = false;
  const res = mockRes();
  await handleColleagueAgentTurn(mockReq({ colleagueId: 'cl_1', text: 'x' }), res, {
    handleTurn: async () => (ran = true),
    isEnabled: () => false,
  });
  assert.equal(res.statusCode, 409);
  await new Promise((r) => setImmediate(r));
  assert.equal(ran, false);
});

test('colleague-agent/turn：业务层抛错不能让进程崩（fire-and-forget 必须有 catch）', async () => {
  const res = mockRes();
  await handleColleagueAgentTurn(mockReq({ colleagueId: 'cl_1', text: 'x' }), res, {
    handleTurn: async () => {
      throw new Error('boom');
    },
    isEnabled: () => true,
  });
  assert.equal(res.statusCode, 202);
  await new Promise((r) => setImmediate(r)); // 未捕获的 rejection 会让这里炸
});

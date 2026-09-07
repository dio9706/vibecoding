/**
 * 项目地图 HTTP 接口的边界测试。
 *
 * 关键约束：绝不触发真实 LLM 生成/搜索。
 * - generate 相关用例只测参数校验/404 边界，不真正跑 generateProjectMap（那要调只读 agent）。
 * - get / search-modules 命中用例靠 saveProjectMap 预存一份地图，绕开生成链路。
 * - search-modules 命中用例**预置一个全部耗尽的 token 池**（见 test.before），
 *   让 isPoolExhausted(getTokens()) 返回 true → runClassifierOnce fail-fast 返回 null →
 *   searchModules 回 []。这样代码真实走完 searchModules 全路径，却确定性地不发起任何网络调用。
 *   为什么不能靠「本机没登录」兜底：isPoolExhausted 对**空**列表返回 false（未配置轮换池
 *   ≠ 已耗尽），空池时 runClassifierOnce 会真起 claude 子进程走 OAuth，在有效订阅的机器上
 *   每次都会真实计费、耗时不可控。对齐 routes-optimize.test.js 的做法：构造前置条件让代码
 *   根本走不到 LLM 那一步，而不是依赖运行时的侥幸降级。
 *
 * 隔离：store/persist.js、store/settings.js 都在调用时读 APP_DATA_DIR，必须先设置再动态 import。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'projmap-routes-'));
const { handleProjectMapRoutes } = await import('./routes-project-map.js');
const { safeProjectId, startMapGen } = await import('./project-map-ops.js');
const { saveProjectMap } = await import('../../features/project-map/persist.js');
const { setTokens } = await import('../../store/settings.js');

let server, base;
test.before(async () => {
  // 预置全部耗尽的 token 池：list 非空且无 healthy/warning → isPoolExhausted 返回 true，
  // 使 search-modules 的 runClassifierOnce 走 fail-fast 分支，绝不发起真实 LLM 调用。
  setTokens([{ id: 't-exhausted', status: 'exhausted' }]);

  server = createServer((req, res) => handleProjectMapRoutes(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(pathname, method, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(base + pathname, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE 等非 JSON 响应 */ }
  return { status: res.status, json, text, ctype: res.headers.get('content-type') || '' };
}
const get = (p) => call(p, 'GET');
const post = (p, b) => call(p, 'POST', b ?? {});

let n = 0;
/** 造一个空项目目录 */
function project() {
  return fs.mkdtempSync(path.join(os.tmpdir(), `projmap-${++n}-`));
}

/**
 * 轮询 generate-stream 直到任务结束（对齐 optimize 的 waitFixDone）。
 * 空目录 + 耗尽 token 池下，生成链会走 collectProjectFacts → 只读 agent fail-fast 降级
 * → saveProjectMap → finishJob，全程不发一次真实 LLM 调用，秒级结束。
 */
const waitMapDone = async (jobId) => {
  for (let i = 0; i < 100; i += 1) {
    const r = await get(`/api/project-map/generate-stream?jobId=${jobId}`);
    if (/"status":"done"/.test(r.text)) return r;
    await new Promise((s) => setTimeout(s, 50));
  }
  throw new Error('生成任务迟迟不结束');
};

/** 造一份最小合法地图数据 */
function fakeMap(projectId) {
  return {
    projectId,
    modules: [
      { id: 'm1', name: '模块一', path: 'src/m1', description: '负责一号功能', exports: [], imports: [] },
      { id: 'm2', name: '模块二', path: 'src/m2', description: '负责二号功能', exports: [], imports: [] },
    ],
    edges: [],
    externalDeps: [],
    summary: { totalModules: 2, totalFiles: 2, totalLines: 10 },
  };
}

// ==================== POST /api/project-map/generate ====================

test('POST /generate 缺 dir → 400', async () => {
  const r = await post('/api/project-map/generate', {});
  assert.equal(r.status, 400);
  assert.match(r.json.error, /dir/);
});

test('POST /generate dir 不存在 → 400', async () => {
  const r = await post('/api/project-map/generate', { dir: path.join(os.tmpdir(), 'projmap-not-exist-xyz') });
  assert.equal(r.status, 400);
});

test('POST /generate 正常开跑 → 202 + jobId，SSE 回放至 done', async () => {
  // 合法空目录 + 耗尽 token 池：整条生成链走完但不发真实 LLM 调用（只读 agent fail-fast 降级）
  const dir = project();
  const r = await post('/api/project-map/generate', { dir });
  assert.equal(r.status, 202);
  assert.match(r.json.jobId, /^mapgen_/);
  assert.equal(r.json.status, 'queued');

  const done = await waitMapDone(r.json.jobId);
  assert.equal(done.status, 200);
  assert.match(done.ctype, /text\/event-stream/);
  assert.match(done.text, /event: replay/);
  assert.match(done.text, /"status":"done"/);
});

test('startMapGen 同一项目并发 → 第二次被串行闸挡下（ops 层确定性验证）', async () => {
  // HTTP 两次请求是异步往返、快任务下会 race；串行闸的正确性在 ops 层同步验证更可靠。
  // startMapGen 在「查 busyByProject → set」之间无 await，背靠背同步调用必然第二次撞闸。
  const dir = project();
  const p1 = startMapGen(dir);
  const p2 = startMapGen(dir);
  assert.match(p1.jobId, /^mapgen_/);
  assert.ok(p2.busy, '第二次应被串行闸挡下');
  assert.equal(p2.busy.jobId, p1.jobId, '挡下时应带上正在跑的 jobId');

  await waitMapDone(p1.jobId); // 收尾，避免后台 job 悬着
});

// ==================== GET /api/project-map/generate-stream ====================

test('GET /generate-stream 未知 jobId → 404', async () => {
  const r = await get('/api/project-map/generate-stream?jobId=mapgen_nope');
  assert.equal(r.status, 404);
});

// ==================== GET /api/project-map/get ====================

test('GET /get 缺 dir → 400', async () => {
  const r = await get('/api/project-map/get');
  assert.equal(r.status, 400);
});

test('GET /get 未生成过 → 404', async () => {
  const r = await get(`/api/project-map/get?dir=${encodeURIComponent(project())}`);
  assert.equal(r.status, 404);
  assert.match(r.json.error, /地图不存在/);
});

test('GET /get 命中已存的地图 → 200 且内容正确', async () => {
  const dir = project();
  const projectId = safeProjectId(dir);
  const map = fakeMap(projectId);
  await saveProjectMap(projectId, map);

  const r = await get(`/api/project-map/get?dir=${encodeURIComponent(dir)}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.projectId, projectId);
  assert.equal(r.json.modules.length, 2);
  assert.equal(r.json.modules[0].name, '模块一');
});

// ==================== GET /api/project-map/search-modules ====================

test('GET /search-modules 缺参 → 400', async () => {
  const dir = project();
  assert.equal((await get(`/api/project-map/search-modules?dir=${encodeURIComponent(dir)}`)).status, 400);
  assert.equal((await get('/api/project-map/search-modules?query=x')).status, 400);
});

test('GET /search-modules 地图不存在 → 404', async () => {
  const dir = project();
  const r = await get(`/api/project-map/search-modules?dir=${encodeURIComponent(dir)}&query=模块一`);
  assert.equal(r.status, 404);
});

test('GET /search-modules 命中地图 → 200 且 matches 是数组（无 token 环境下应为空数组）', async () => {
  const dir = project();
  const projectId = safeProjectId(dir);
  await saveProjectMap(projectId, fakeMap(projectId));

  const r = await get(`/api/project-map/search-modules?dir=${encodeURIComponent(dir)}&query=模块一`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.matches), 'matches 应为数组');
});

test('GET /search-modules 地图文件损坏 → 500（区别于「不存在」的 404）', async () => {
  // 直接往地图落盘位置写非法 JSON：loadProjectMap 抛 SyntaxError（非 ENOENT），
  // searchModules 不带 notFound 标记地上抛 → 路由回 500，而不是与「地图不存在」混成 404
  const dir = project();
  const projectId = safeProjectId(dir);
  const mapDir = path.join(process.env.APP_DATA_DIR, 'project-maps');
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(path.join(mapDir, `${projectId}.json`), '{ 这不是合法 JSON');

  const r = await get(`/api/project-map/search-modules?dir=${encodeURIComponent(dir)}&query=模块一`);
  assert.equal(r.status, 500);
});

// ==================== safeProjectId ====================

test('safeProjectId 对同一目录的不同书写形态得出同一个 id', () => {
  // 存的时候前端传反斜杠、取的时候某条路径传正斜杠 —— 若不归一化，
  // 两次算出不同文件名，地图就"生成完却读不到"，前端退回「未生成」。
  const base = path.resolve(os.tmpdir(), 'pm-norm-check');
  const withFwd = base.replace(/\\/g, '/');
  const withTrail = base + path.sep;

  assert.equal(safeProjectId(withFwd), safeProjectId(base), '正斜杠与反斜杠须同 id');
  assert.equal(safeProjectId(withTrail), safeProjectId(base), '尾部分隔符不该改变 id');
  assert.equal(safeProjectId(path.join(base, 'sub', '..')), safeProjectId(base), '含 .. 的等价路径须同 id');
});

test('safeProjectId 对不同目录仍然区分得开', () => {
  const a = path.resolve(os.tmpdir(), 'pm-norm-a');
  const b = path.resolve(os.tmpdir(), 'pm-norm-b');
  assert.notEqual(safeProjectId(a), safeProjectId(b));
});

// ==================== 兜底 ====================

test('未知路径 → 404', async () => {
  assert.equal((await get('/api/project-map/nope')).status, 404);
});

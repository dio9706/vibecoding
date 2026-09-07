/**
 * 项目优化四个 fix 接口的边界与状态码。
 *
 * 不发任何 LLM 调用：happy path 用「报告里标了可修、但磁盘上没有」的规则文件，
 * demoteOne 在第一步前置校验就返回 failed（非核心失败），整条管线照常跑完，
 * 但一次 describeSkill 都不会发生。真实降级的验证在 P3-8 的实测脚本里做过。
 *
 * 隔离：store/index.js 在模块求值时定死数据目录，必须先设 APP_DATA_DIR 再动态 import。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-routes-'));
const { handleOptimizeRoutes } = await import('./routes-optimize.js');
const { saveCheckup, acquireBusy, releaseBusy } = await import('../../store/optimize.js');
const { createBackup } = await import('../../features/project-optimize/backup.js');

let server, base;
test.before(async () => {
  server = createServer((req, res) => handleOptimizeRoutes(req, res, new URL(req.url, 'http://x')));
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
/** 造一个空项目目录，并按需喂一份体检报告 */
function project(issues, { git = false, dirty = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `optproj-${++n}-`));
  if (git) {
    const g = (...a) => execFileSync('git', a, { cwd: dir, windowsHide: true, stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'x');
    g('init', '-q');
    g('add', '-A');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    if (dirty) fs.writeFileSync(path.join(dir, 'DIRTY.md'), '未提交');
  }
  if (issues) {
    saveCheckup(dir, {
      dir,
      at: new Date().toISOString(),
      dims: { rules: { score: 60, status: 'done', issues } },
      score: 60,
      grade: 'C',
      issueCount: issues.length,
    });
  }
  return dir;
}

/** 报告里标可修、磁盘上不存在 → demoteOne 前置校验即返回，不触发 LLM */
const ghostIssue = { code: 'R1_SHOULD_DEMOTE', file: '.claude/rules/ghost.md', fixable: true, message: 'x' };

const waitFixDone = async (jobId) => {
  for (let i = 0; i < 100; i += 1) {
    const r = await get(`/api/optimize/fix-stream?jobId=${jobId}`);
    if (/"status":"done"/.test(r.text)) return r;
    await new Promise((s) => setTimeout(s, 50));
  }
  throw new Error('优化任务迟迟不结束');
};

// ==================== POST /api/optimize/fix ====================

test('POST /fix 缺 dir → 400', async () => {
  const r = await post('/api/optimize/fix', {});
  assert.equal(r.status, 400);
  assert.match(r.json.error, /dir/);
});

test('POST /fix 未体检过 → 400 且说明要先体检', async () => {
  const r = await post('/api/optimize/fix', { dir: project(null) });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /先跑一次体检/);
});

test('POST /fix 没有可自动修的项 → 200 且如实说明被挡下的原因', async () => {
  // R2_DEMOTE_UNCERTAIN 是故意标成不可自动修的，不能静默丢掉
  const dir = project([
    { code: 'R2_DEMOTE_UNCERTAIN', file: '.claude/rules/x.md', fixable: false, message: '请人工确认' },
  ]);
  // 显式传 elevated：这个用例验的是「确实没有可修项」，
  // 不传的话会因为默认只做低风险而同样得到 nothing——那就测不出原本的意图了
  const r = await post('/api/optimize/fix', { dir, risk: 'elevated' });
  assert.equal(r.status, 200);
  assert.equal(r.json.nothing, true);
  assert.equal(r.json.blocked.length, 1);
  assert.match(r.json.blocked[0].reason, /人工确认/);
});

test('POST /fix 脏工作区 → 200 + needsConfirm', async () => {
  const dir = project([ghostIssue], { git: true, dirty: true });
  const r = await post('/api/optimize/fix', { dir, risk: 'elevated' });
  assert.equal(r.status, 200);
  assert.equal(r.json.needsConfirm, true);
  assert.ok(r.json.dirtyCount >= 1);
  assert.equal(r.json.isRepo, true);
});

test('POST /fix 带 force 可跳过脏工作区确认', async () => {
  const dir = project([ghostIssue], { git: true, dirty: true });
  const r = await post('/api/optimize/fix', { dir, risk: 'elevated', force: true });
  assert.equal(r.status, 200);
  assert.ok(r.json.jobId, '应当直接开跑');
  await waitFixDone(r.json.jobId);
});

test('POST /fix 正常开跑 → 200 + jobId', async () => {
  const dir = project([ghostIssue]);
  const r = await post('/api/optimize/fix', { dir, dimensions: ['rules'], risk: 'elevated' });
  assert.equal(r.status, 200);
  assert.match(r.json.jobId, /^fix_/);
  await waitFixDone(r.json.jobId);
});

test('POST /fix 项目被占用 → 409，且带上正在跑的 jobId', async () => {
  // 409 而不是 200：前端要能区分「被挡下」和「跑完了但没结果」
  const dir = project([ghostIssue]);
  acquireBusy(dir, 'fix', 'fix_running_x');
  // 必须传 elevated：「无可修项」的早返回在抢闸**之前**（那是既有顺序），
  // 而 rules 维度是高风险的。默认低风险档位下这个项目无事可做，
  // 会先返回 200 + nothing 而根本走不到闸——那就测不出 409 了
  const r = await post('/api/optimize/fix', { dir, risk: 'elevated' });
  assert.equal(r.status, 409);
  assert.equal(r.json.busy.jobId, 'fix_running_x');
  releaseBusy(dir);
});

test('POST /fix 的 dimensions 传成非数组不会污染下游', async () => {
  // fail-closed：HTTP 边界收到什么形状都不该让编排层拿到脏数据
  const dir = project([ghostIssue]);
  const r = await post('/api/optimize/fix', { dir, dimensions: 'rules', risk: 'elevated' });
  assert.equal(r.status, 200);
  await waitFixDone(r.json.jobId);
});

// ==================== GET /api/optimize/fix-stream ====================

test('GET /fix-stream 未知 jobId → 404', async () => {
  // 不能开一条空 SSE：EventSource 对非 200 会置 CLOSED 不再重连，前端据此收手；
  // 开空流则会让它一直重连一条永远没有事件的通道
  const r = await get('/api/optimize/fix-stream?jobId=fix_nope');
  assert.equal(r.status, 404);
});

test('GET /fix-stream 拿体检的 jobId 也要 404', async () => {
  // 两类 job 存在同一张表里，串了会把体检的结构当优化结果渲染
  const r = await get('/api/optimize/fix-stream?jobId=ckup_whatever');
  assert.equal(r.status, 404);
});

test('GET /fix-stream 已完成的任务回放完整结果并收尾', async () => {
  const dir = project([ghostIssue]);
  const { json } = await post('/api/optimize/fix', { dir, risk: 'elevated' });
  const r = await waitFixDone(json.jobId);

  assert.equal(r.status, 200);
  assert.match(r.ctype, /text\/event-stream/);
  assert.match(r.text, /event: replay/);
  assert.match(r.text, /"phase":"plan"/);
  assert.match(r.text, /"phase":"backup"/);
});

// ==================== GET /api/optimize/backups ====================

test('GET /backups 缺 dir → 400', async () => {
  const r = await get('/api/optimize/backups');
  assert.equal(r.status, 400);
});

test('GET /backups 没有备份时返回空数组而不是报错', async () => {
  const r = await get(`/api/optimize/backups?dir=${encodeURIComponent(project(null))}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.backups, []);
});

test('GET /backups 列出已有快照', async () => {
  const dir = project(null);
  fs.writeFileSync(path.join(dir, 'a.md'), '原始内容');
  createBackup(dir, [{ path: 'a.md', action: 'modified' }], { dimensions: ['rules'] });

  const r = await get(`/api/optimize/backups?dir=${encodeURIComponent(dir)}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.backups.length, 1);
  assert.equal(r.json.backups[0].fileCount, 1);
  assert.ok(r.json.backups[0].dirName);
});

// ==================== POST /api/optimize/rollback ====================

test('POST /rollback 缺参数 → 400', async () => {
  assert.equal((await post('/api/optimize/rollback', { dirName: 'x' })).status, 400);
  assert.equal((await post('/api/optimize/rollback', { dir: 'C:/x' })).status, 400);
});

test('POST /rollback 备份不存在 → 400', async () => {
  const r = await post('/api/optimize/rollback', { dir: project(null), dirName: '不存在的快照' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /备份不存在/);
});

test('POST /rollback 拒绝路径穿越的 dirName', async () => {
  // dirName 来自客户端且要拼进 path.join(dir, '.claude/optimize-backup', dirName)，
  // '../../evil' 正好退回项目根再进 evil/ —— 那里放一份 manifest.json 就能让还原
  // 照着攻击者写的清单往任意位置写文件。
  //
  // 这里必须真埋一个可达的 manifest：只传 '../../etc' 是测不出东西的，
  // 那个位置本来就没有 manifest，不加白名单校验也照样报「备份不存在」。
  const dir = project(null);
  fs.writeFileSync(path.join(dir, 'a.md'), '真实内容');
  createBackup(dir, [{ path: 'a.md', action: 'modified' }], {});

  const evilDir = path.join(dir, 'evil');
  fs.mkdirSync(path.join(evilDir, 'files'), { recursive: true });
  fs.writeFileSync(path.join(evilDir, 'files', 'a.md'), '攻击者写入的内容');
  fs.writeFileSync(path.join(evilDir, 'manifest.json'), JSON.stringify({
    at: 'x', dir, entries: [{ path: 'a.md', action: 'modified', backed: true }], postRecordedAt: null,
  }));

  const r = await post('/api/optimize/rollback', { dir, dirName: '../../evil' });
  assert.equal(r.status, 400, '不在本项目快照列表里的 dirName 一律拒绝');
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), '真实内容', '文件不该被改写');
});

test('POST /rollback 还原文件并回报明细', async () => {
  const dir = project(null);
  const file = path.join(dir, 'a.md');
  fs.writeFileSync(file, '原始内容');
  const { dirName } = createBackup(dir, [{ path: 'a.md', action: 'modified' }], { dimensions: ['rules'] });
  fs.writeFileSync(file, '被优化改过的内容');

  const r = await post('/api/optimize/rollback', { dir, dirName });
  assert.equal(r.status, 200);
  assert.equal(r.json.restored, 1);
  assert.deepEqual(r.json.skipped, []);
  assert.equal(fs.readFileSync(file, 'utf8'), '原始内容');
});

test('POST /rollback 在项目被占用时 → 409', async () => {
  // 优化跑到一半时还原，两边会交错写同一批文件，比不还原糟得多
  const dir = project(null);
  fs.writeFileSync(path.join(dir, 'a.md'), 'x');
  const { dirName } = createBackup(dir, [{ path: 'a.md', action: 'modified' }], {});
  acquireBusy(dir, 'fix', 'fix_running_y');

  const r = await post('/api/optimize/rollback', { dir, dirName });
  assert.equal(r.status, 409);
  releaseBusy(dir);
});

test('POST /rollback 结束后释放闸，可以连着还原第二次', async () => {
  const dir = project(null);
  fs.writeFileSync(path.join(dir, 'a.md'), 'x');
  const { dirName } = createBackup(dir, [{ path: 'a.md', action: 'modified' }], {});
  assert.equal((await post('/api/optimize/rollback', { dir, dirName })).status, 200);
  assert.equal((await post('/api/optimize/rollback', { dir, dirName })).status, 200);
});

// ==================== 兜底 ====================

test('未知路径 → 404', async () => {
  assert.equal((await get('/api/optimize/nope')).status, 404);
});

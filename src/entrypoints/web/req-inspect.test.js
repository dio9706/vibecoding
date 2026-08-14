/**
 * req-inspect 单测 —— resolveInspectIdentity 纯函数 / confirmBug|ignoreBug|retryBug 状态流转 /
 * inspectBitable 守卫与「必然失败路径」（无真实凭证时 lark client 同步抛错，全程只经 microtask，
 * 不发起真实网络请求，见 routes-requirements.test.js 头注释同款说明）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 防 env 污染：inspectBitable 的「必然失败路径」依赖空凭证时 Lark SDK 在 Client 构造函数处同步抛错
// （见文件末尾几例的说明）。若 shell 环境恰好导出了真实 LARK_APP_ID/LARK_APP_SECRET，这些测试会
// 变成真的发起网络请求（变慢、依赖网络可达性、甚至可能误操作真实飞书应用），必须在任何 import 之前清空。
delete process.env.LARK_APP_ID;
delete process.env.LARK_APP_SECRET;

// 隔离数据目录：本模块间接 import store/requirements.js 与 store/settings.js（读盘）
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'req-inspect-'));

const { resolveInspectIdentity, reviewWithTimeout, reviewRecordAsBug, confirmBug, ignoreBug, retryBug, inspectBitable } =
  await import('./req-inspect.js');
const { createRequirement, updateRequirement, getRequirement } = await import('../../store/requirements.js');
const { hasQueuedTasks, queuedTasks } = await import('./requirement-ops.js');
const { setMyFeishuOpenId } = await import('../../store/settings.js');

// —— resolveInspectIdentity（纯函数，三分支）——

test('resolveInspectIdentity：myFeishuOpenId 非空时优先使用', () => {
  assert.equal(resolveInspectIdentity({ myFeishuOpenId: 'ou_me', trusted: ['ou_a', 'ou_b'] }), 'ou_me');
});

test('resolveInspectIdentity：myFeishuOpenId 为空（含纯空白）时回退 trusted[0]', () => {
  assert.equal(resolveInspectIdentity({ myFeishuOpenId: '', trusted: ['ou_a', 'ou_b'] }), 'ou_a');
  assert.equal(resolveInspectIdentity({ myFeishuOpenId: '   ', trusted: ['ou_a'] }), 'ou_a');
});

test('resolveInspectIdentity：都为空 → null', () => {
  assert.equal(resolveInspectIdentity({ myFeishuOpenId: '', trusted: [] }), null);
  assert.equal(resolveInspectIdentity({ myFeishuOpenId: '', trusted: undefined }), null);
});

// —— reviewWithTimeout（N1：单条评审门超时护栏，哨兵注入验证两条分支）——

test('reviewWithTimeout：超时 → 落哨兵 ask 原因，不等待底层真正结束', async () => {
  const res = await reviewWithTimeout(
    { id: 'x', type: 'bug', title: 'T', detail: 'D' },
    { review: () => new Promise(() => {}), timeoutMs: 5 }, // 永不 resolve，模拟评审卡死
  );
  assert.deepEqual(res, { verdict: 'ask', reason: '评审超时，请人工确认' });
});

test('reviewWithTimeout：未超时 → 原样透传评审结果，且清理计时器（不清会拖住本文件的进程退出到 5s 才结束）', async () => {
  const res = await reviewWithTimeout(
    { id: 'x', type: 'bug', title: 'T', detail: 'D' },
    { review: () => Promise.resolve({ verdict: 'fix', reason: '', scores: {} }), timeoutMs: 5000 },
  );
  assert.deepEqual(res, { verdict: 'fix', reason: '', scores: {} });
});

// —— reviewRecordAsBug（fix3：单条评审调用异常不得中断整场巡检）——

test('reviewRecordAsBug：review 调用 reject → 不向上抛出，按 ask 落 doubt 继续', async () => {
  const bug = await reviewRecordAsBug(
    { record_id: 'recX1' },
    { title: 'T', detail: 'D' },
    { review: () => Promise.reject(new Error('模拟评审调用异常')) },
  );
  assert.equal(bug.verdict, 'doubt');
  assert.match(bug.reason, /评审异常：模拟评审调用异常/);
  assert.equal(bug.recordId, 'recX1');
});

// —— confirmBug / ignoreBug / retryBug ——

function makeReqWithBugs(bugs) {
  const r = createRequirement({ title: 'bug 操作测试' });
  updateRequirement(r.id, { bugs });
  return r.id;
}

function bug(overrides) {
  return { id: 'b1', recordId: 'rec1', title: 'T', detail: 'D', verdict: 'sure', reason: '', status: 'pending', at: new Date().toISOString(), ...overrides };
}

test('confirmBug：doubt 态 → pending + verdict 转 sure + 入队 bug-fix（N3：前端按 verdict 渲染不再残留「确认」按钮）', async () => {
  const id = makeReqWithBugs([bug({ verdict: 'doubt', reason: '不确定' })]);
  const res = await confirmBug(id, 'b1');
  assert.equal(res.ok, true);
  const after = getRequirement(id).bugs[0];
  assert.equal(after.status, 'pending');
  assert.equal(after.verdict, 'sure');
  assert.equal(hasQueuedTasks(id), true);
  const tasks = queuedTasks(id);
  assert.equal(tasks[0].kind, 'bug-fix');
  assert.equal(tasks[0].payload.bug.id, 'b1');
  assert.equal(tasks[0].payload.bug.verdict, 'sure'); // 入队 payload 携带的也是确认后的最新 verdict
});

test('confirmBug：failed 态（重新确认）同样转 pending + 入队，verdict 保持/转为 sure', async () => {
  const id = makeReqWithBugs([bug({ verdict: 'sure', status: 'failed' })]);
  const res = await confirmBug(id, 'b1');
  assert.equal(res.ok, true);
  const after = getRequirement(id).bugs[0];
  assert.equal(after.status, 'pending');
  assert.equal(after.verdict, 'sure');
  assert.equal(hasQueuedTasks(id), true);
});

test('confirmBug：sure 且非 failed（已是常规 pending）不可重复确认 → 409', async () => {
  const id = makeReqWithBugs([bug({ verdict: 'sure', status: 'pending' })]);
  const res = await confirmBug(id, 'b1');
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
});

test('confirmBug：ignored 态不可确认 → 409（fix5：即便原 verdict 是 doubt，忽略后也不能绕过再确认）', async () => {
  const id = makeReqWithBugs([bug({ verdict: 'doubt', status: 'ignored' })]);
  const res = await confirmBug(id, 'b1');
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(getRequirement(id).bugs[0].status, 'ignored'); // 未被误改
});

test('confirmBug：fixing 态不可操作 → 409', async () => {
  const id = makeReqWithBugs([bug({ verdict: 'doubt', status: 'fixing' })]);
  const res = await confirmBug(id, 'b1');
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
});

test('confirmBug：需求不存在 / BUG 不存在 → 404', async () => {
  const missingReq = await confirmBug('r_not_exist', 'b1');
  assert.equal(missingReq.ok, false);
  assert.equal(missingReq.status, 404);
  const id = makeReqWithBugs([]);
  const missingBug = await confirmBug(id, 'no-such-bug');
  assert.equal(missingBug.ok, false);
  assert.equal(missingBug.status, 404);
});

test('ignoreBug：正常忽略 → ignored；fixing 态不可忽略 → 409', async () => {
  const id = makeReqWithBugs([bug({ id: 'b1', status: 'pending' }), bug({ id: 'b2', recordId: 'rec2', status: 'fixing' })]);
  const r1 = await ignoreBug(id, 'b1');
  assert.equal(r1.ok, true);
  assert.equal(getRequirement(id).bugs.find((b) => b.id === 'b1').status, 'ignored');

  const r2 = await ignoreBug(id, 'b2');
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 409);
  assert.equal(getRequirement(id).bugs.find((b) => b.id === 'b2').status, 'fixing'); // 未被误改
});

test('retryBug：failed → pending + 入队，verdict 不受影响（与 confirmBug 的区别）；非 failed → 409', async () => {
  const id = makeReqWithBugs([
    bug({ id: 'b1', verdict: 'doubt', status: 'failed' }), // 刻意用非常规 verdict，验证 retryBug 确实不动它
    bug({ id: 'b2', recordId: 'rec2', status: 'pending' }),
  ]);
  const r1 = await retryBug(id, 'b1');
  assert.equal(r1.ok, true);
  const after = getRequirement(id).bugs.find((b) => b.id === 'b1');
  assert.equal(after.status, 'pending');
  assert.equal(after.verdict, 'doubt'); // retryBug 不改 verdict
  assert.equal(hasQueuedTasks(id), true);

  const r2 = await retryBug(id, 'b2');
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 409);
});

// —— inspectBitable：守卫 + 必然失败路径 ——

test('inspectBitable：需求不存在 → 抛错', async () => {
  await assert.rejects(() => inspectBitable('r_not_exist', 'https://x.feishu.cn/base/bascnAAA'), /需求不存在/);
});

test('inspectBitable：非测试期 → 抛错，且 history 留痕「表格巡检被拒」（对齐 runDocgen 纪律）', async () => {
  const r = createRequirement({ title: '非测试期巡检测试' });
  await assert.rejects(() => inspectBitable(r.id, 'https://x.feishu.cn/base/bascnAAA'), /仅测试期/);
  assert.ok(getRequirement(r.id).history.some((h) => h.event === '表格巡检被拒：仅测试期可进行表格巡检'));
});

test('inspectBitable：busy 非空 → 抛错，history 留痕且不清除既有 busy', async () => {
  const r = createRequirement({ title: 'busy占用巡检测试' });
  updateRequirement(r.id, { phase: 'test', busy: { kind: 'develop', runId: 'r1' } });
  await assert.rejects(() => inspectBitable(r.id, 'https://x.feishu.cn/base/bascnAAA'), /有任务正在进行/);
  const after = getRequirement(r.id);
  assert.deepEqual(after.busy, { kind: 'develop', runId: 'r1' }); // 不该被这条守卫误清
  assert.ok(after.history.some((h) => h.event === '表格巡检被拒：有任务正在进行，请稍候'));
});

test('inspectBitable：身份无法解析（myFeishuOpenId 空且无可信名单）→ 抛错，留痕且不写 busy', async () => {
  const r = createRequirement({ title: '身份缺失巡检测试' });
  updateRequirement(r.id, { phase: 'test' });
  setMyFeishuOpenId(''); // 确保清空，不受其他测试残留影响
  await assert.rejects(() => inspectBitable(r.id, 'https://x.feishu.cn/base/bascnAAA'), /设置页填写我的飞书 open_id/);
  const after = getRequirement(r.id);
  assert.equal(after.busy, null);
  assert.ok(after.history.some((h) => h.event === '表格巡检被拒：请先在设置页填写我的飞书 open_id'));
});

test('inspectBitable：url 解析不出多维表格链接 → 抛错，留痕', async () => {
  const r = createRequirement({ title: '非法链接巡检测试' });
  updateRequirement(r.id, { phase: 'test' });
  setMyFeishuOpenId('ou_test_badurl');
  await assert.rejects(() => inspectBitable(r.id, '这不是一个链接'), /未识别出多维表格链接/);
  assert.ok(getRequirement(r.id).history.some((h) => h.event === '表格巡检被拒：未识别出多维表格链接'));
});

test('inspectBitable：守卫全部通过后，无真实凭证必然失败；busy 先写后清，history 记录完整链路', async () => {
  const r = createRequirement({ title: '完整链路巡检测试' });
  updateRequirement(r.id, { phase: 'test' });
  setMyFeishuOpenId('ou_test_full_flow');
  await assert.rejects(() => inspectBitable(r.id, 'https://x.feishu.cn/base/bascnFULLFLOW'));
  const after = getRequirement(r.id);
  assert.equal(after.busy, null); // finally 清 busy：失败也不例外
  assert.ok(after.history.some((h) => h.event === '开始表格巡检'));
  assert.ok(after.history.some((h) => h.event.startsWith('表格巡检失败')));
});

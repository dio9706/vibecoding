import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LIFETIME_MS,
  STANDBY_MS,
  QUOTA_HOLD_MS,
  isSettled,
  allSettled,
  pickRetryable,
  isExpired,
  hasAnything,
  isQuotaError,
  buildRoundReport,
  formatDuration,
} from './loop.logic.js';

test('常量是拍板值的回归锚点（20min 待命 / 12h 上限）', () => {
  assert.equal(STANDBY_MS, 20 * 60_000);
  assert.equal(MAX_LIFETIME_MS, 12 * 3600_000);
  assert.equal(QUOTA_HOLD_MS, 30 * 60_000);
});

test('isSettled：done 与 analyzed 都是终态（auto-dev 失败退回 analyzed，没有 failed 态）', () => {
  assert.equal(isSettled({ status: 'done' }), true);
  assert.equal(isSettled({ status: 'analyzed' }), true);
  assert.equal(isSettled({ status: 'queued' }), false);
  assert.equal(isSettled({ status: 'developing' }), false);
  assert.equal(isSettled(null), true); // 任务被删：当终态，否则泵永远等不到
});

test('allSettled：全终态才算本轮结束', () => {
  const get = (id) => ({ t1: { status: 'done' }, t2: { status: 'queued' } })[id] || null;
  assert.equal(allSettled(['t1'], get), true);
  assert.equal(allSettled(['t1', 't2'], get), false);
  assert.equal(allSettled([], get), true);
  assert.equal(allSettled(null, get), true);
});

test('pickRetryable：analyzed 且没重试过的才给重试，done 不重试', () => {
  const get = (id) =>
    ({
      t1: { id: 't1', status: 'analyzed' },
      t2: { id: 't2', status: 'analyzed' },
      t3: { id: 't3', status: 'done' },
      t4: { id: 't4', status: 'queued' },
    })[id] || null;
  assert.deepEqual(pickRetryable(['t1', 't2', 't3', 't4'], get, { t2: true }), ['t1']);
  assert.deepEqual(pickRetryable(['t1'], get, { t1: true }), []); // 已重试过不再给
  assert.deepEqual(pickRetryable([], get, {}), []);
});

test('isExpired：超过 12 小时判到期', () => {
  const now = 1_000_000_000;
  assert.equal(isExpired(now - MAX_LIFETIME_MS - 1, now), true);
  assert.equal(isExpired(now - 1000, now), false);
  assert.equal(isExpired(0, now), false); // startedAt=0 视为未启动，不判到期
});

test('isQuotaError：识别额度类错误（挂起而非 20 分钟后空转重试）', () => {
  assert.equal(isQuotaError('rate limit exceeded'), true);
  assert.equal(isQuotaError('额度已耗尽'), true);
  assert.equal(isQuotaError('usage limit reached'), true);
  assert.equal(isQuotaError('quota exceeded'), true);
  assert.equal(isQuotaError('ECONNRESET'), false);
  assert.equal(isQuotaError(''), false);
  assert.equal(isQuotaError(null), false);
});

test('hasAnything：四类全空才算无事发生（空报抑制的判据）', () => {
  const empty = { fixed: [], handoff: [], failed: [], unknown: [] };
  assert.equal(hasAnything(empty), false);
  assert.equal(hasAnything({ ...empty, fixed: [{ title: 'x' }] }), true);
  assert.equal(hasAnything({ ...empty, handoff: [{ title: 'x' }] }), true);
  assert.equal(hasAnything({ ...empty, failed: [{ title: 'x' }] }), true);
  assert.equal(hasAnything({ ...empty, unknown: [{ title: 'x' }] }), true);
  assert.equal(hasAnything(null), false);
});

test('formatDuration：毫秒 → 人读时长', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(90 * 60_000), '1h30m');
  assert.equal(formatDuration(20 * 60_000), '20m');
  assert.equal(formatDuration(-5), '0m'); // 时钟回拨不产生负数
});

test('buildRoundReport：轮次汇报带需求名与 @，四类分别成段', () => {
  const s = buildRoundReport({
    kind: 'round',
    atSelf: '<at user_id="ou_me"></at> ',
    reqTitle: '订单中心改版',
    elapsedMs: 3 * 3600_000 + 20 * 60_000,
    roundNo: 2,
    report: {
      fixed: [{ title: '导出无响应', branch: 'task/t_a' }],
      handoff: [{ title: '分页错乱', to: '<at user_id="ou_be"></at> ', advice: 'count 语句有问题' }],
      failed: [{ title: '崩溃', reason: '无代码改动' }],
      unknown: [{ title: '样式抖动', branch: 'task/t_b' }],
    },
  });
  assert.match(s, /<at user_id="ou_me"><\/at>/);
  assert.match(s, /【订单中心改版】/);
  assert.match(s, /3h20m/);
  assert.match(s, /已修复待你 review 并提交（1 条）/);
  assert.match(s, /task\/t_a/);
  assert.match(s, /已转后端/);
  assert.match(s, /count 语句有问题/);
  assert.match(s, /归属判不准，已按前端修（1 条）/);
  assert.match(s, /修复失败（1 条，已重试一次）/);
});

test('buildRoundReport：无需求名时不出现方括号标题', () => {
  const s = buildRoundReport({
    kind: 'round',
    atSelf: '',
    reqTitle: null,
    elapsedMs: 60_000,
    roundNo: 1,
    report: { fixed: [{ title: 'x', branch: 'b' }], handoff: [], failed: [], unknown: [] },
  });
  assert.doesNotMatch(s, /【/);
});

test('buildRoundReport：空段落不出现（只报真正有内容的类别）', () => {
  const s = buildRoundReport({
    kind: 'round',
    atSelf: '',
    reqTitle: null,
    elapsedMs: 60_000,
    roundNo: 1,
    report: { fixed: [{ title: 'x', branch: 'b' }], handoff: [], failed: [], unknown: [] },
  });
  assert.doesNotMatch(s, /已转后端/);
  assert.doesNotMatch(s, /修复失败/);
  assert.doesNotMatch(s, /归属判不准/);
});

test('buildRoundReport：handoff 降级时标注名册未配号', () => {
  const s = buildRoundReport({
    kind: 'round',
    atSelf: '',
    reqTitle: null,
    elapsedMs: 0,
    roundNo: 1,
    report: {
      fixed: [],
      handoff: [{ title: 'x', to: '', advice: 'a', demoted: true }],
      failed: [],
      unknown: [],
    },
  });
  assert.match(s, /名册未配 open_id/);
});

test('buildRoundReport：final 类型首行不同，且空 report 也给一句话', () => {
  const s = buildRoundReport({
    kind: 'final',
    atSelf: '',
    reqTitle: '需求A',
    elapsedMs: 60_000,
    roundNo: 5,
    reason: '手动停止',
    report: { fixed: [], handoff: [], failed: [], unknown: [] },
  });
  assert.match(s, /巡检已停止/);
  assert.match(s, /手动停止/);
  assert.match(s, /共跑 5 轮/);
  assert.match(s, /本轮无新增问题/);
});

test('buildRoundReport：report 整个缺失也不抛错（无人值守链路的兜底）', () => {
  const s = buildRoundReport({ kind: 'final', elapsedMs: 0, roundNo: 0 });
  assert.match(s, /巡检已停止/);
  assert.match(s, /本轮无新增问题/);
});

test('hasAnything：只有 needHuman 也算「处理过东西」（不该被空报抑制吞掉）', () => {
  assert.equal(hasAnything({ fixed: [], handoff: [], failed: [], unknown: [], needHuman: [{ title: 'x' }] }), true);
  assert.equal(hasAnything({ fixed: [], handoff: [], failed: [], unknown: [], needHuman: [] }), false);
});

test('buildRoundReport：渲染「待你人工处理」分组，含原因', () => {
  const s = buildRoundReport({
    kind: 'round',
    reqTitle: '登录改版',
    report: { fixed: [], handoff: [], failed: [], unknown: [], needHuman: [{ title: '空状态缺插画', reason: '附件里没有切图' }] },
  });
  assert.match(s, /待你人工处理（1 条）/);
  assert.match(s, /空状态缺插画/);
  assert.match(s, /附件里没有切图/);
});

test('buildRoundReport：needHuman 缺 reason 时用兜底词，不出现 undefined', () => {
  const s = buildRoundReport({
    kind: 'round',
    report: { fixed: [], handoff: [], failed: [], unknown: [], needHuman: [{ title: 'x' }] },
  });
  assert.doesNotMatch(s, /undefined/);
  assert.match(s, /缺少图片资源/);
});

test('buildRoundReport：needHuman 排在「已转后端」之后、「归属判不准」之前', () => {
  const s = buildRoundReport({
    kind: 'round',
    report: {
      fixed: [],
      handoff: [{ title: 'h', to: '', advice: 'a' }],
      failed: [],
      unknown: [{ title: 'u', branch: 'task/u' }],
      needHuman: [{ title: 'n', reason: 'r' }],
    },
  });
  assert.ok(s.indexOf('已转后端') < s.indexOf('待你人工处理'));
  assert.ok(s.indexOf('待你人工处理') < s.indexOf('归属判不准'));
});
